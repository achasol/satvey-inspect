import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import pymupdf as pdf
from PIL import Image

from adapt_app import adapt
from common import ROOT, digest, read_json, read_jsonl, write_json
from dataset import source_groups, validate
from extract import extract_pdf, process_source, run_extract
from score import maximum_matching, score_cases


TAXONOMY = read_json(ROOT/'taxonomy.json')


def finding(kind='cracking', component='masonry', photos=None):
    return {'title': 'Zichtbaar gebrek', 'description': 'Concrete zichtbare waarneming.',
            'faultType': kind, 'component': component, 'photoIds': photos or ['p1']}


def case(findings=None, cid='c1', track='single_photo'):
    return {'caseId': cid, 'sourceId': 's1', 'provider': 'provider', 'groupId': 's1',
            'track': track, 'modality': 'handheld_rgb', 'quality': 'standard_resolution',
            'photos': [{'photoId': 'p1'}, {'photoId': 'p2'}],
            'findings': [finding()] if findings is None else findings}


class ScoringTests(unittest.TestCase):
    def run_score(self, findings, refs=None, **kwargs):
        return score_cases([case(refs)], [{'caseId': 'c1', 'findings': findings}], TAXONOMY, **kwargs)

    def test_perfect(self):
        report, queue = self.run_score([finding()])
        self.assertEqual(report['metrics']['f1'], 1)
        self.assertEqual(report['metrics']['photo_attribution_recall'], 1)
        self.assertEqual(queue, [])
        self.assertIsNone(report['description_accuracy'])

    def test_empty_predictions_lose_recall(self):
        report, _ = self.run_score([])
        self.assertEqual(report['metrics']['false_negative'], 1)
        self.assertEqual(report['metrics']['recall'], 0)

    def test_missing_output_is_in_denominator(self):
        report, _ = score_cases([case()], [], TAXONOMY)
        self.assertEqual(report['metrics']['missing_outputs'], 1)
        self.assertEqual(report['metrics']['recall'], 0)

    def test_duplicates_cannot_inflate_recall(self):
        report, _ = self.run_score([finding(), finding()])
        self.assertEqual(report['metrics']['matched'], 1)
        self.assertEqual(report['metrics']['photo_attribution_precision'], 1)
        self.assertEqual(report['metrics']['duplicate_findings'], 1)
        self.assertEqual(report['metrics']['precision'], 0.5)

    def test_maximum_matching_handles_ambiguous_photo_sets(self):
        predictions = [finding(photos=['p1','p2']), finding(photos=['p1'])]
        references = [finding(photos=['p1']), finding(photos=['p2'])]
        self.assertEqual(len(maximum_matching(predictions, references)), 2)

    def test_wrong_photo_is_not_a_detection_match(self):
        report, queue = self.run_score([finding(photos=['p2'])])
        self.assertEqual(report['metrics']['matched'], 0)
        self.assertEqual(report['metrics']['false_negative'], 1)
        self.assertEqual(len(queue), 1)

    def test_extra_photo_links_are_penalized(self):
        report, _ = self.run_score([finding(photos=['p1','p2'])])
        self.assertEqual(report['metrics']['recall'], 1)
        self.assertEqual(report['metrics']['photo_attribution_precision'], 0.5)
        self.assertEqual(report['metrics']['exact_photo_attribution_rate'], 0)

    def test_missing_multi_photo_links_reduce_attribution_recall(self):
        report, _ = self.run_score([finding()], refs=[finding(photos=['p1','p2'])])
        self.assertEqual(report['metrics']['photo_attribution_recall'], 0.5)

    def test_unknown_photo_invalidates_case(self):
        report, _ = self.run_score([finding(photos=['invented'])])
        self.assertEqual(report['metrics']['invalid_outputs'], 1)
        self.assertEqual(report['metrics']['recall'], 0)

    def test_unknown_taxonomy_invalidates_case(self):
        report, _ = self.run_score([finding(kind='asbestos_confirmed')])
        self.assertEqual(report['metrics']['invalid_outputs'], 1)

    def test_extra_fields_invalid(self):
        f = finding() | {'secretGold': 'bad'}
        report, _ = self.run_score([f])
        self.assertEqual(report['metrics']['invalid_outputs'], 1)

    def test_blank_description_invalid(self):
        report, _ = self.run_score([finding() | {'description': ' '}])
        self.assertEqual(report['metrics']['invalid_outputs'], 1)

    def test_repeated_case_ids_reject_both_outputs(self):
        prediction = {'caseId': 'c1', 'findings': [finding()]}
        report, _ = score_cases([case()], [prediction, prediction], TAXONOMY)
        self.assertEqual(report['metrics']['invalid_outputs'], 1)
        self.assertEqual(report['metrics']['matched'], 0)

    def test_malformed_and_unknown_outputs_visible(self):
        report, _ = score_cases([case()], [{'caseId': 'unknown', 'findings': []}, [], None, {'caseId': []}], TAXONOMY, malformed_lines=2)
        self.assertEqual(report['unknown_case_outputs'], 4)
        self.assertEqual(report['malformed_json_lines'], 2)

    def test_unmatched_claim_requires_adjudication(self):
        report, queue = self.run_score([finding(), finding('corrosion','metalwork')])
        self.assertIsNone(report['metrics']['precision'])
        self.assertIsNone(report['metrics']['f1'])
        self.assertEqual(report['metrics']['provisional_reference_precision'], 0.5)
        self.assertEqual(len(queue), 1)
        adjudication = queue[0] | {'decision': 'unsupported', 'reviewer': 'human', 'reason': 'No rust visible.'}
        report, queue = self.run_score([finding(), finding('corrosion','metalwork')], adjudications=[adjudication])
        self.assertEqual(report['metrics']['precision'], 0.5)
        self.assertEqual(queue, [])

    def test_supported_addition_is_not_a_false_positive(self):
        outputs = [finding(), finding('corrosion','metalwork')]
        _, queue = self.run_score(outputs)
        decision = queue[0] | {'decision': 'supported_additional', 'reviewer': 'human', 'reason': 'Visible rust.'}
        report, _ = self.run_score(outputs, adjudications=[decision])
        self.assertEqual(report['metrics']['precision'], 1)
        self.assertEqual(report['metrics']['recall'], 1)
        self.assertEqual(report['metrics']['matched'], 1)
        self.assertEqual(report['metrics']['photo_attribution_precision'], 1)

    def test_stale_adjudication_cannot_apply_to_changed_prediction(self):
        outputs = [finding(), finding('corrosion','metalwork')]
        _, queue = self.run_score(outputs)
        decision = queue[0] | {'decision': 'unsupported', 'reviewer': 'human', 'reason': 'Checked.'}
        outputs[1]['description'] = 'Changed output'
        report, queue = self.run_score(outputs, adjudications=[decision])
        self.assertIsNone(report['metrics']['precision'])
        self.assertEqual(len(queue), 1)

    def test_negative_case_requires_valid_empty_response(self):
        report, _ = self.run_score([], refs=[])
        self.assertEqual(report['metrics']['correct_negative_cases'], 1)
        self.assertIsNone(report['metrics']['recall'])
        report, queue = self.run_score([finding()], refs=[])
        self.assertEqual(report['metrics']['correct_negative_cases'], 0)
        self.assertEqual(len(queue), 1)

    def test_fault_slices_do_not_count_other_faults(self):
        report, _ = self.run_score([finding()], refs=[finding(), finding('corrosion','metalwork')])
        self.assertEqual(report['slices']['faultType']['cracking']['recall'], 1)
        self.assertEqual(report['slices']['faultType']['corrosion']['recall'], 0)


class EvidenceTests(unittest.TestCase):
    def test_native_extraction_preserves_pixels_and_separates_text(self):
        with tempfile.TemporaryDirectory() as temp:
            image = Image.new('RGB', (160,120), (80,120,160))
            image_data = io.BytesIO()
            image.save(image_data, format='PNG')
            document = pdf.open()
            page = document.new_page()
            page.insert_text((70,110), 'REPORT DIAGNOSIS: NEVER MODEL INPUT')
            page.insert_image(pdf.Rect(70,140,390,380), stream=image_data.getvalue())
            data = document.tobytes()
            with patch('extract.LOCAL', Path(temp)):
                assets, placements, _ = extract_pdf({'id':'fixture'}, data)
                self.assertEqual((assets[0]['width'],assets[0]['height']), (160,120))
                self.assertEqual(placements[0]['method'], 'native_image')
                self.assertIn('REPORT DIAGNOSIS', read_json(Path(temp)/'pages/fixture.json')[0]['text_blocks'][0]['text'])
                with Image.open(Path(temp)/assets[0]['path']) as extracted:
                    self.assertEqual(extracted.getpixel((80,60)), (80,120,160))
            document.close()

    def test_transparent_embedded_image_is_composited_on_white(self):
        with tempfile.TemporaryDirectory() as temp:
            image = Image.new('RGBA', (160,120), (255,0,0,128))
            stream=io.BytesIO()
            image.save(stream,format='PNG')
            doc=pdf.open()
            page=doc.new_page()
            page.insert_image(pdf.Rect(70,140,390,380),stream=stream.getvalue())
            with patch('extract.LOCAL',Path(temp)):
                assets,placements,_=extract_pdf({'id':'alpha'},doc.tobytes())
                self.assertEqual(placements[0]['status'],'pending_visual_review')
                with Image.open(Path(temp)/assets[0]['path']) as extracted:
                    r,g,b=extracted.getpixel((80,60))
                    self.assertEqual(r,255)
                    self.assertTrue(125 <= g <= 129)
                    self.assertEqual(g,b)
            doc.close()

    def test_changed_pdf_is_held_before_extraction(self):
        source={'id':'changed','source_url':'https://example.test/a.pdf','category':'candidate_report',
                'reuse_status':'not_established','access_check':{'sha256':digest(b'original')}}
        with tempfile.TemporaryDirectory() as temp, patch('extract.LOCAL',Path(temp)), patch('extract.retrieve',return_value=b'changed'):
            result,assets,placements=process_source(source)
            self.assertEqual(result['status'],'source_changed_requires_review')
            self.assertEqual((assets,placements),([],[]))

    def test_newly_accessible_pdf_uses_release_pin_on_later_runs(self):
        source={'id':'new','source_url':'https://example.test/a.pdf','category':'candidate_report_web_access_only',
                'reuse_status':'not_established','access_check':{}}
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            write_json(root/'sources-lock.json',{'new':{'sha256':digest(b'reviewed')}})
            with patch('extract.ROOT',root), patch('extract.LOCAL',root/'.local'), patch('extract.retrieve',return_value=b'changed'):
                result,_,_=process_source(source)
                self.assertEqual(result['status'],'source_changed_requires_review')

    def test_failed_extraction_cannot_advance_reviewed_source_pin(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            previous={'source_id':'s','status':'extracted','sha256':digest(b'reviewed')}
            write_json(root/'sources-lock.json',{'s':previous})
            changed={'source_id':'s','status':'source_changed_requires_review','sha256':digest(b'changed')}
            with patch('extract.ROOT',root),patch('extract.LOCAL',root/'.local'),patch('extract.catalogue',return_value=[{'id':'s','category':'candidate_report'}]),patch('extract.process_source',return_value=(changed,[],[])):
                run_extract()
            self.assertEqual(read_json(root/'sources-lock.json')['s']['sha256'],previous['sha256'])

    def test_shared_provider_and_pixels_cannot_cross_groups(self):
        annotations=[{'source_id':s,'placements':[s]} for s in ['a','b','c']]
        placements={'a':{'asset_id':'x'},'b':{'asset_id':'y'},'c':{'asset_id':'x'}}
        assets={'x':{'width':100,'height':100,'dhash':'0000000000000000'},'y':{'width':100,'height':100,'dhash':'ffffffffffffffff'}}
        sources={'a':{'inspection_author':'same'},'b':{'inspection_author':'same'},'c':{'inspection_author':'different'}}
        grouping,_=source_groups(annotations,placements,assets,sources)
        self.assertEqual(len(set(grouping.values())),1)

    def test_near_duplicate_grouping_is_conservative(self):
        annotations=[{'source_id':s,'placements':[s]} for s in ['a','b']]
        placements={'a':{'asset_id':'x'},'b':{'asset_id':'y'}}
        assets={s:{'width':160,'height':120,'dhash':h} for s,h in [('x','0000000000000000'),('y','0000000000000001')]}
        grouping,links=source_groups(annotations,placements,assets,{'a':{'inspection_author':'A'},'b':{'inspection_author':'B'}})
        self.assertEqual(grouping['a'],grouping['b'])
        self.assertEqual(links[0]['reason'],'near_duplicate_conservative_group')

    def test_release_metadata(self):
        validate(check_assets=False)


class AdapterTests(unittest.TestCase):
    def test_mapping_required_without_reading_gold(self):
        output={'caseId':'c','findings':[{'title':'Scheur','description':'Zichtbare scheur','label':'Te beoordelen','photoIds':['p']}]}
        tags=[{'caseId':'c','findingIndex':0,'faultType':'cracking','component':'masonry'}]
        self.assertEqual(adapt([output],tags)[0]['findings'][0]['faultType'],'cracking')
        with self.assertRaises(ValueError): adapt([output],[])

    def test_audio_evidence_rejected(self):
        output={'caseId':'c','findings':[{'audioIds':['audio']}]}
        with self.assertRaises(ValueError): adapt([output],[])


if __name__ == '__main__':
    unittest.main()
