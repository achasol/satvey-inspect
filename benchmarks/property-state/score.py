"""Offline structured scoring. Never uses report prose or an LLM as a judge."""
import argparse
from collections import Counter, defaultdict
import json
from pathlib import Path

import jsonschema

from common import LOCAL, ROOT, VERSION, digest, read_json, read_jsonl, write_json, write_jsonl


def validate_prediction(prediction, case, taxonomy):
    jsonschema.validate(prediction, read_json(ROOT / 'schemas/prediction.schema.json'))
    known = {p['photoId'] for p in case['photos']}
    for finding in prediction['findings']:
        if finding['faultType'] not in taxonomy['faultTypes'] or finding['component'] not in taxonomy['components']:
            raise ValueError('Unknown faultType or component')
        if not set(finding['photoIds']) <= known:
            raise ValueError('Unknown photoId')
        if not finding['title'].strip() or not finding['description'].strip():
            raise ValueError('Blank title or description')


def maximum_matching(predictions, references):
    """Maximum cardinality matching; stricter attribution is preferred on ties.

    A prediction must name a supporting photo to match. Predicting every photo
    can still match detection, but its extra attributions lose precision.
    """
    edges = {}
    for pi, prediction in enumerate(predictions):
        eligible = [ri for ri, reference in enumerate(references)
                    if prediction['faultType'] == reference['faultType']
                    and prediction['component'] == reference['component']
                    and set(prediction['photoIds']) & set(reference['photoIds'])]
        edges[pi] = sorted(eligible, key=lambda ri: (
            -len(set(prediction['photoIds']) & set(references[ri]['photoIds'])) / len(set(prediction['photoIds']) | set(references[ri]['photoIds'])), ri))
    owners = {}

    def augment(pi, visited):
        for ri in edges[pi]:
            if ri in visited:
                continue
            visited.add(ri)
            if ri not in owners or augment(owners[ri], visited):
                owners[ri] = pi
                return True
        return False

    for pi in sorted(edges, key=lambda i: (len(edges[i]), i)):
        augment(pi, set())
    return {pi: ri for ri, pi in owners.items()}


def ratios(counts):
    c = Counter(counts)
    denominator = c['matched'] + c['supported_additional'] + c['false_positive'] + c['unmatched_pending']
    known_precision = (c['matched'] + c['supported_additional']) / denominator if denominator else None
    recall = c['matched'] / c['reference_findings'] if c['reference_findings'] else None
    precision = known_precision if not c['unmatched_pending'] else None
    f1 = 2*precision*recall/(precision+recall) if precision is not None and recall is not None and precision+recall else (0.0 if precision == 0 and recall == 0 else None)
    return dict(c) | {'precision': precision, 'recall': recall, 'f1': f1,
                     'output_validity_rate': c['valid_outputs']/c['cases'] if c['cases'] else None,
                     'output_coverage': (c['cases']-c['missing_outputs'])/c['cases'] if c['cases'] else None,
                     'negative_case_accuracy': c['correct_negative_cases']/c['negative_cases'] if c['negative_cases'] else None,
                     'provisional_reference_precision': known_precision,
                     'photo_attribution_precision': c['correct_photo_links']/c['predicted_photo_links'] if c['predicted_photo_links'] else None,
                     'photo_attribution_recall': c['correct_photo_links']/c['reference_photo_links'] if c['reference_photo_links'] else None,
                     'exact_photo_attribution_rate': c['exact_attribution_matches']/c['matched'] if c['matched'] else None}


def score_cases(cases, predictions, taxonomy, adjudications=None, malformed_lines=0):
    """Pure entry point used by tests. Adjudications bind to a prediction hash."""
    adjudications = adjudications or []
    decisions = {}
    for row in adjudications:
        key = (row['caseId'], row['predictionHash'], row['findingIndex'])
        if key in decisions:
            raise ValueError('Duplicate adjudication')
        if row.get('decision') not in ['supported_additional', 'unsupported'] or not row.get('reviewer') or not row.get('reason'):
            raise ValueError('Adjudication requires decision, reviewer and reason')
        decisions[key] = row['decision']
    by_id = defaultdict(list)
    for prediction in predictions:
        key = prediction.get('caseId') if isinstance(prediction, dict) else None
        by_id[key if isinstance(key, str) else None].append(prediction)
    rows, queue = [], []
    for case in cases:
        cid = case['caseId']
        references = case['findings']
        counts = Counter({'cases': 1, 'reference_findings': len(references), 'matched': 0,
                          'false_negative': len(references), 'false_positive': 0, 'supported_additional': 0,
                          'unmatched_pending': 0, 'duplicate_findings': 0, 'missing_outputs': 0,
                          'invalid_outputs': 0, 'valid_outputs': 0, 'negative_cases': int(not references),
                          'correct_negative_cases': 0, 'correct_photo_links': 0,
                          'predicted_photo_links': 0, 'unmatched_predicted_photo_links': 0,
                          'reference_photo_links': sum(len(r['photoIds']) for r in references),
                          'exact_attribution_matches': 0})
        outputs = by_id.get(cid, [])
        error = None
        matches = {}
        phash = None
        if not outputs:
            counts['missing_outputs'] = 1
        elif len(outputs) != 1:
            counts['invalid_outputs'] = 1
            error = 'Repeated caseId; all outputs for this case rejected'
        else:
            prediction = outputs[0]
            try:
                validate_prediction(prediction, case, taxonomy)
            except (jsonschema.ValidationError, ValueError, TypeError) as exc:
                counts['invalid_outputs'] = 1
                error = str(exc).split('\n')[0]
            else:
                counts['valid_outputs'] = 1
                findings = prediction['findings']
                phash = digest(json.dumps(prediction, sort_keys=True, ensure_ascii=False).encode())
                matches = maximum_matching(findings, references)
                counts['matched'] = len(matches)
                counts['false_negative'] -= len(matches)
                # Attribution precision is conditional on matched detections.
                # Pending/additional detections have no frozen gold photo set;
                # record their links separately rather than declaring them wrong.
                counts['predicted_photo_links'] = sum(len(findings[i]['photoIds']) for i in matches)
                counts['unmatched_predicted_photo_links'] = sum(len(f['photoIds']) for i, f in enumerate(findings) if i not in matches)
                counts['correct_negative_cases'] = int(not references and not findings)
                for pi, ri in matches.items():
                    predicted, expected = set(findings[pi]['photoIds']), set(references[ri]['photoIds'])
                    counts['correct_photo_links'] += len(predicted & expected)
                    counts['exact_attribution_matches'] += int(predicted == expected)
                for i, finding in enumerate(findings):
                    if i in matches:
                        continue
                    # An extra prediction of the same tagged instance/photo as an
                    # already matched prediction is a duplicate, not another TP.
                    duplicate = any(finding['faultType'] == findings[j]['faultType']
                                    and finding['component'] == findings[j]['component']
                                    and set(finding['photoIds']) == set(findings[j]['photoIds']) for j in matches)
                    if duplicate:
                        counts['duplicate_findings'] += 1
                        counts['false_positive'] += 1
                        continue
                    decision = decisions.get((cid, phash, i))
                    if decision == 'supported_additional':
                        counts['supported_additional'] += 1
                    elif decision == 'unsupported':
                        counts['false_positive'] += 1
                    else:
                        counts['unmatched_pending'] += 1
                        queue.append({'caseId': cid, 'predictionHash': phash, 'findingIndex': i,
                                      'finding': finding, 'decision': None, 'reviewer': '', 'reason': ''})
        rows.append({'caseId': cid, 'sourceId': case['sourceId'], 'provider': case['provider'],
                     'groupId': case['groupId'], 'track': case['track'], 'modality': case['modality'],
                     'quality': case['quality'], 'faultTypes': sorted({f['faultType'] for f in references}) or ['no_visible_fault'],
                     'counts': dict(counts), 'matches': matches, 'predictionHash': phash, 'error': error})
    def aggregate(subset):
        counts = Counter()
        for row in subset:
            counts.update(row['counts'])
        return ratios(counts)
    slices = {}
    for dimension in ['sourceId', 'provider', 'track', 'modality', 'quality']:
        slices[dimension] = {value: aggregate([r for r in rows if r[dimension] == value]) for value in sorted({r[dimension] for r in rows})}
    # Exact fault slices are evaluated on each type's findings, not on all
    # findings in cases that merely contain that type.
    fault_slices = {}
    cases_by_id = {case['caseId']: case for case in cases}
    for fault in taxonomy['faultTypes']:
        # Slice accounting is collected directly from full matches below so
        # malformed outputs and adjudication indices retain their meaning.
        c = Counter()
        for row in rows:
            case = cases_by_id[row['caseId']]
            refs = case['findings']
            nref = sum(f['faultType'] == fault for f in refs)
            c['reference_findings'] += nref
            c['matched'] += sum(refs[ri]['faultType'] == fault for ri in row['matches'].values())
            c['false_negative'] += nref - sum(refs[ri]['faultType'] == fault for ri in row['matches'].values())
            outputs = by_id.get(case['caseId'], [])
            if len(outputs) == 1 and row['counts']['valid_outputs']:
                fs = outputs[0]['findings']
                for i, f in enumerate(fs):
                    if f['faultType'] != fault or i in row['matches']:
                        continue
                    duplicate = any(f['faultType'] == fs[j]['faultType'] and f['component'] == fs[j]['component'] and set(f['photoIds']) == set(fs[j]['photoIds']) for j in row['matches'])
                    decision = decisions.get((case['caseId'], row['predictionHash'], i))
                    c['false_positive' if duplicate or decision == 'unsupported' else 'supported_additional' if decision == 'supported_additional' else 'unmatched_pending'] += 1
        if c['reference_findings'] or c['false_positive'] or c['unmatched_pending'] or c['supported_additional']:
            fault_slices[fault] = ratios(c)
    slices['faultType'] = fault_slices
    known = {case['caseId'] for case in cases}
    report = {'metrics': aggregate(rows), 'slices': slices, 'cases': rows,
              'unknown_case_outputs': sum(len(values) for key, values in by_id.items() if key not in known),
              'malformed_json_lines': malformed_lines, 'pending_adjudications': len(queue),
              'description_accuracy': None,
              'description_accuracy_note': 'Not automatically scored. Use REVIEW.md; structured matches do not validate prose.',
              'interpretation': 'Tracks overlap in evidence. Compare tracks separately; overall counts are descriptive, not independent samples. Precision/F1 remain null while unmatched predictions await review.'}
    return report, queue


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('predictions', type=Path)
    parser.add_argument('--split', choices=['development', 'evaluation', 'all'], default='evaluation')
    parser.add_argument('--references', type=Path, default=ROOT / 'references.jsonl')
    parser.add_argument('--adjudications', type=Path)
    parser.add_argument('--run-metadata', type=Path, help='JSON with model, harness and configuration; no credentials')
    parser.add_argument('--output', type=Path, default=LOCAL / 'results/score.json')
    args = parser.parse_args()
    if args.references.resolve() == (ROOT / 'references.jsonl').resolve():
        # Fail closed when gold/taxonomy/curation changed without a new release.
        from dataset import validate
        validate(check_assets=False)
    cases = read_jsonl(args.references)
    if args.split != 'all':
        cases = [c for c in cases if c['split'] == args.split]
    if not cases:
        parser.error('No reference cases in requested split')
    predictions, malformed = [], 0
    for line in args.predictions.read_text(encoding='utf-8-sig').splitlines():
        if line.strip():
            try:
                predictions.append(json.loads(line))
            except json.JSONDecodeError:
                malformed += 1
    report, queue = score_cases(cases, predictions, read_json(ROOT / 'taxonomy.json'), read_jsonl(args.adjudications) if args.adjudications else [], malformed)
    report.update({'dataset_version': VERSION, 'reference_sha256': digest(args.references.read_bytes()),
                   'taxonomy_sha256': digest((ROOT/'taxonomy.json').read_bytes()),
                   'scorer_sha256': digest(Path(__file__).read_bytes()),
                   'prediction_sha256': digest(args.predictions.read_bytes()), 'split': args.split,
                   'run': read_json(args.run_metadata) if args.run_metadata else {'model': 'unspecified', 'harness': 'unspecified', 'configuration': {}}})
    write_json(args.output, report)
    write_jsonl(args.output.with_suffix('.adjudications.jsonl'), queue)
    print(json.dumps(report['metrics'], indent=2))
    print(f"Saved {args.output}; {len(queue)} unmatched findings need adjudication.")


if __name__ == '__main__':
    main()
