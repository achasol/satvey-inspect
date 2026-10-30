package app

import (
	"context"
	"encoding/json"
)

// One filter for final reports and PDF drafts: only reviewed, approved content is exportable.
func reportSnapshot(ctx context.Context, q querier, org, inspection string) (map[string]json.RawMessage, error) {
	data, e := detail(ctx, q, org, inspection)
	if e != nil {
		return nil, e
	}
	raw, _ := json.Marshal(data)
	var snapshot map[string]json.RawMessage
	_ = json.Unmarshal(raw, &snapshot)
	// Filter in SQL so internal audio and rejected/unreviewed material never enter a report snapshot.
	snapshot["observations"], e = list(ctx, q, `SELECT o.id,o.batch_id AS "batchId",o.title,o.description,o.label,o.photo_ids AS "photoIds" FROM observations o JOIN batches b ON b.id=o.batch_id AND b.org_id=o.org_id WHERE o.inspection_id=$1 AND o.org_id=$2 AND o.status='approved' AND b.status='reviewed'`, inspection, org)
	if e != nil {
		return nil, e
	}
	snapshot["media"], e = list(ctx, q, `SELECT m.id,m.batch_id AS "batchId",m.kind,m.name,m.mime,m.annotations,m.annotation_version AS "annotationVersion" FROM media m JOIN batches b ON b.id=m.batch_id AND b.org_id=m.org_id WHERE m.inspection_id=$1 AND m.org_id=$2 AND m.kind='photo' AND b.status='reviewed' AND (EXISTS(SELECT 1 FROM observations o WHERE o.batch_id=b.id AND o.org_id=b.org_id AND o.status='approved' AND (cardinality(o.photo_ids)=0 OR m.id=ANY(o.photo_ids))) OR EXISTS(SELECT 1 FROM norm_assessments a WHERE a.batch_id=b.id AND a.org_id=b.org_id AND a.reviewed_outcome IS NOT NULL AND NOT a.stale AND m.id=ANY(a.photo_ids)))`, inspection, org)
	if e != nil {
		return nil, e
	}
	snapshot["assessments"], e = list(ctx, q, `SELECT a.rule_id AS "ruleId",a.batch_id AS "batchId",a.reviewed_outcome AS outcome,a.photo_ids AS "photoIds",CASE WHEN a.review_note<>'' THEN a.review_note ELSE a.reason END AS reason FROM norm_assessments a JOIN batches b ON b.id=a.batch_id AND b.org_id=a.org_id WHERE a.inspection_id=$1 AND a.org_id=$2 AND b.status='reviewed' AND a.reviewed_outcome IS NOT NULL AND NOT a.stale`, inspection, org)
	if e != nil {
		return nil, e
	}
	if format, ok := data["format"].(*formatDocument); ok && format != nil {
		// Keep only explicit, current room reviews. Draft suggestions and raw audio stay internal.
		snapshot["answers"], e = list(ctx, q, answerSelect+` WHERE inspection_id=$1 AND org_id=$2 AND status IN ('confirmed','unanswerable') AND EXISTS(SELECT 1 FROM rooms r WHERE r.id=format_answers.room_id AND r.org_id=format_answers.org_id AND r.approved_generation=r.generation)`, inspection, org)
		if e != nil {
			return nil, e
		}
		snapshot["media"], e = list(ctx, q, `SELECT m.id,m.batch_id AS "batchId",m.kind,m.name,m.mime,m.annotations,m.annotation_version AS "annotationVersion" FROM media m JOIN batches b ON b.id=m.batch_id AND b.org_id=m.org_id WHERE m.inspection_id=$1 AND m.org_id=$2 AND m.kind='photo' AND b.status='reviewed' AND (EXISTS(SELECT 1 FROM format_answers a JOIN rooms r ON r.id=a.room_id AND r.org_id=a.org_id WHERE a.org_id=m.org_id AND a.inspection_id=m.inspection_id AND a.status='confirmed' AND r.approved_generation=r.generation AND m.id=ANY(a.photo_ids)) OR EXISTS(SELECT 1 FROM observations o WHERE o.batch_id=b.id AND o.org_id=b.org_id AND o.status='approved' AND (cardinality(o.photo_ids)=0 OR m.id=ANY(o.photo_ids))))`, inspection, org)
		if e != nil {
			return nil, e
		}
	}
	delete(snapshot, "scopeJobs")
	delete(snapshot, "transcriptionJobs")
	delete(snapshot, "jobs")
	if e = fillReportMetadata(ctx, q, org, inspection, snapshot); e != nil {
		return nil, e
	}
	return snapshot, nil
}

func fillReportMetadata(ctx context.Context, q querier, org, inspection string, snapshot map[string]json.RawMessage) error {
	var organisation, creator string
	if e := q.QueryRow(ctx, "SELECT o.name,u.name FROM inspections i JOIN organisations o ON o.id=i.org_id JOIN users u ON u.id=i.created_by WHERE i.id=$1 AND i.org_id=$2", inspection, org).Scan(&organisation, &creator); e != nil {
		return e
	}
	if len(snapshot["organisation"]) == 0 {
		snapshot["organisation"], _ = json.Marshal(map[string]string{"name": organisation})
	}
	if len(snapshot["createdBy"]) == 0 {
		snapshot["createdBy"], _ = json.Marshal(map[string]string{"name": creator})
	}
	return nil
}
