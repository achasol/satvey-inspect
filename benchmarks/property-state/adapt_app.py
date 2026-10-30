"""Convert app-shaped findings with explicit, externally assigned taxonomy tags.

The app's free-text label cannot determine faultType or component reliably.
This adapter never looks at benchmark gold and never guesses tags from prose.
"""
import argparse

from common import read_jsonl, write_jsonl


def adapt(outputs, tags):
    mapping = {}
    for tag in tags:
        key = (tag['caseId'], tag['findingIndex'])
        if key in mapping:
            raise ValueError('Duplicate tag mapping')
        mapping[key] = tag
    used = set()
    result = []
    for output in outputs:
        findings = []
        for i, finding in enumerate(output['findings']):
            if finding.get('audioIds'):
                raise ValueError('This benchmark is RGB-only; audio evidence is unsupported')
            key = (output['caseId'], i)
            if key not in mapping:
                raise ValueError(f'Missing taxonomy mapping for {key}')
            tag = mapping[key]
            used.add(key)
            findings.append({k: finding[k] for k in ['title', 'description', 'photoIds']} |
                            {k: tag[k] for k in ['faultType', 'component']})
        result.append({'caseId': output['caseId'], 'findings': findings})
    if set(mapping) != used:
        raise ValueError('Unused taxonomy mappings; input may not match tagging file')
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('app_outputs')
    parser.add_argument('tags')
    parser.add_argument('output')
    args = parser.parse_args()
    write_jsonl(args.output, adapt(read_jsonl(args.app_outputs), read_jsonl(args.tags)))


if __name__ == '__main__':
    main()
