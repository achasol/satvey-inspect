package app

import (
	"context"
	"errors"
	"fmt"
	"github.com/jackc/pgx/v5"
	"log/slog"
	"net/http"
	"strings"
	"time"
)

type retentionPolicy struct {
	ReportDays     *int `json:"reportDays"`
	AudioDays      *int `json:"audioDays"`
	TranscriptDays *int `json:"transcriptDays"`
	Enabled        bool `json:"enabled"`
	Version        int  `json:"version"`
}

func (a *app) retentionSettings(w http.ResponseWriter, r *http.Request) error {
	u, err := a.admin(r)
	if err != nil {
		return err
	}
	org := r.PathValue("org")
	if r.Method == "PUT" {
		var in retentionPolicy
		if err = readJSON(w, r, &in); err != nil {
			return err
		}
		any := false
		for _, days := range []*int{in.ReportDays, in.AudioDays, in.TranscriptDays} {
			if days != nil {
				if *days < 1 || *days > 36500 {
					return fail(422, "Gebruik bewaartermijnen tussen 1 en 36500 dagen")
				}
				any = true
			}
		}
		if in.Version < 0 || in.Enabled && !any {
			return fail(422, "Vul eerst goedgekeurde bewaartermijnen in")
		}
		tag, err := a.db.Exec(r.Context(), `INSERT INTO retention_policies(org_id,report_days,audio_days,transcript_days,enabled,activated_by,activated_at) SELECT $1,$2,$3,$4,$5,$6,now() WHERE $7=0 ON CONFLICT(org_id) DO UPDATE SET report_days=EXCLUDED.report_days,audio_days=EXCLUDED.audio_days,transcript_days=EXCLUDED.transcript_days,enabled=EXCLUDED.enabled,activated_by=EXCLUDED.activated_by,activated_at=now(),version=retention_policies.version+1 WHERE retention_policies.version=$7`, org, in.ReportDays, in.AudioDays, in.TranscriptDays, in.Enabled, u.ID, in.Version)
		if in.Version > 0 {
			tag, err = a.db.Exec(r.Context(), `UPDATE retention_policies SET report_days=$2,audio_days=$3,transcript_days=$4,enabled=$5,activated_by=$6,activated_at=now(),version=version+1 WHERE org_id=$1 AND version=$7`, org, in.ReportDays, in.AudioDays, in.TranscriptDays, in.Enabled, u.ID, in.Version)
		}
		if err != nil {
			return err
		}
		if tag.RowsAffected() != 1 {
			return fail(409, "Bewaarbeleid gewijzigd; herlaad")
		}
		send(w, 200, map[string]int{"version": in.Version + 1})
		return nil
	}
	policy := retentionPolicy{}
	_ = a.db.QueryRow(r.Context(), `SELECT report_days,audio_days,transcript_days,enabled,version FROM retention_policies WHERE org_id=$1`, org).Scan(&policy.ReportDays, &policy.AudioDays, &policy.TranscriptDays, &policy.Enabled, &policy.Version)
	var reports, audio, transcripts, held int
	if err = a.db.QueryRow(r.Context(), `SELECT count(*) FILTER(WHERE archived_at<now()-make_interval(days=>$2) AND NOT retention_hold AND corrects_inspection_id IS NULL AND superseded_by IS NULL),count(*) FILTER(WHERE retention_hold) FROM inspections WHERE org_id=$1`, org, policy.ReportDays).Scan(&reports, &held); err != nil {
		return err
	}
	if err = a.db.QueryRow(r.Context(), `SELECT count(*) FILTER(WHERE m.content_deleted_at IS NULL AND m.created_at<now()-make_interval(days=>$2)),count(*) FILTER(WHERE m.transcript<>'' AND m.created_at<now()-make_interval(days=>$3)) FROM media m JOIN inspections i ON i.id=m.inspection_id AND i.org_id=m.org_id WHERE m.org_id=$1 AND m.kind='audio' AND i.status='final' AND NOT i.retention_hold`, org, policy.AudioDays, policy.TranscriptDays).Scan(&audio, &transcripts); err != nil {
		return err
	}
	send(w, 200, map[string]any{"policy": policy, "preview": map[string]int{"archivedCandidates": reports, "audioFiles": audio, "transcripts": transcripts, "heldDossiers": held}, "note": "Rapporttermijn begint bij archivering. Correctiereeksen, blokkades en actieve verzending worden bij uitvoering opnieuw gecontroleerd. Back-ups volgen de afzonderlijk afgesproken back-uptermijn."})
	return nil
}
func (a *app) retentionHold(w http.ResponseWriter, r *http.Request) error {
	u, err := a.admin(r)
	if err != nil {
		return err
	}
	var in struct {
		Hold    bool   `json:"hold"`
		Reason  string `json:"reason"`
		Version int    `json:"version"`
	}
	if err = readJSON(w, r, &in); err != nil {
		return err
	}
	if strings.TrimSpace(in.Reason) == "" || len(in.Reason) > 2000 {
		return fail(422, "Geef een reden voor de bewaarblokkade")
	}
	tx, err := a.db.Begin(r.Context())
	if err != nil {
		return err
	}
	defer tx.Rollback(r.Context())
	tag, err := tx.Exec(r.Context(), `UPDATE inspections SET retention_hold=$3,retention_hold_reason=$4,revision=revision+1 WHERE id=$1 AND org_id=$2 AND revision=$5`, r.PathValue("inspection"), r.PathValue("org"), in.Hold, in.Reason, in.Version)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return fail(409, "Het dossier is gewijzigd")
	}
	if err = recordEvent(r.Context(), tx, r.PathValue("org"), r.PathValue("inspection"), u.ID, "retention_hold", map[string]any{"hold": in.Hold, "reason": in.Reason}); err != nil {
		return err
	}
	if err = tx.Commit(r.Context()); err != nil {
		return err
	}
	send(w, 200, map[string]int{"version": in.Version + 1})
	return nil
}

func (a *app) runRetention(ctx context.Context, org string) error {
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var p retentionPolicy
	var actor string
	if err = tx.QueryRow(ctx, `SELECT report_days,audio_days,transcript_days,activated_by FROM retention_policies WHERE org_id=$1 AND enabled FOR SHARE`, org).Scan(&p.ReportDays, &p.AudioDays, &p.TranscriptDays, &actor); err != nil {
		return err
	}
	// Serialize content cleanup with correction copying, uploads and finalization.
	var iid string
	var version int
	err = tx.QueryRow(ctx, `SELECT i.id,i.revision FROM inspections i WHERE i.org_id=$1 AND NOT i.retention_hold AND
 ((i.archived_at<now()-make_interval(days=>$2) AND i.corrects_inspection_id IS NULL AND i.superseded_by IS NULL AND NOT EXISTS(SELECT 1 FROM inspections c WHERE c.corrects_inspection_id=i.id OR c.superseded_by=i.id))
 OR (i.status='final' AND EXISTS(SELECT 1 FROM media m WHERE m.inspection_id=i.id AND m.org_id=i.org_id AND m.kind='audio' AND ((m.content_deleted_at IS NULL AND m.created_at<now()-make_interval(days=>$3)) OR (m.transcript<>'' AND m.created_at<now()-make_interval(days=>$4))))))
 AND NOT EXISTS(SELECT 1 FROM internal_sync_jobs s WHERE s.org_id=i.org_id AND s.inspection_id=i.id AND s.status NOT IN ('done','cancelled'))
 AND NOT EXISTS(SELECT 1 FROM handover_deliveries d WHERE d.org_id=i.org_id AND d.inspection_id=i.id AND d.status NOT IN ('accepted','manual'))
 AND NOT EXISTS(SELECT 1 FROM report_deliveries d JOIN mail_jobs m ON m.id=d.mail_job_id WHERE d.org_id=i.org_id AND d.inspection_id=i.id AND m.status IN ('pending','processing'))
 ORDER BY i.created_at LIMIT 1 FOR UPDATE SKIP LOCKED`, org, p.ReportDays, p.AudioDays, p.TranscriptDays).Scan(&iid, &version)
	if err != nil {
		return err
	}
	if p.ReportDays != nil {
		var due bool
		if err = tx.QueryRow(ctx, `SELECT archived_at<now()-make_interval(days=>$3) AND corrects_inspection_id IS NULL AND superseded_by IS NULL FROM inspections WHERE id=$1 AND org_id=$2`, iid, org, *p.ReportDays).Scan(&due); err == nil && due {
			if err = a.purgeInspection(ctx, tx, org, iid, actor, dossierAction{Version: version, Reason: "Geactiveerd bewaarbeleid"}); err != nil {
				return err
			}
			return tx.Commit(ctx)
		}
	}
	if p.AudioDays != nil {
		if _, err = tx.Exec(ctx, `INSERT INTO inspection_file_deletions(object_key,org_id) SELECT object_key,org_id FROM media WHERE inspection_id=$1 AND org_id=$2 AND kind='audio' AND content_deleted_at IS NULL AND created_at<now()-make_interval(days=>$3) ON CONFLICT DO NOTHING`, iid, org, *p.AudioDays); err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, `UPDATE media SET content_deleted_at=now() WHERE inspection_id=$1 AND org_id=$2 AND kind='audio' AND content_deleted_at IS NULL AND created_at<now()-make_interval(days=>$3)`, iid, org, *p.AudioDays); err != nil {
			return err
		}
	}
	if p.TranscriptDays != nil {
		if _, err = tx.Exec(ctx, `UPDATE transcription_jobs SET machine_transcript='' WHERE org_id=$1 AND inspection_id=$2 AND media_id IN (SELECT id FROM media WHERE org_id=$1 AND inspection_id=$2 AND created_at<now()-make_interval(days=>$3))`, org, iid, *p.TranscriptDays); err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, `UPDATE media SET transcript='',transcript_version=transcript_version+1 WHERE org_id=$1 AND inspection_id=$2 AND kind='audio' AND transcript<>'' AND created_at<now()-make_interval(days=>$3)`, org, iid, *p.TranscriptDays); err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, `DELETE FROM transcription_cache WHERE org_id=$1`, org); err != nil {
			return err
		}
	}
	if err = recordEvent(ctx, tx, org, iid, actor, "retention_applied", map[string]any{"audioDays": p.AudioDays, "transcriptDays": p.TranscriptDays}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
func (a *app) retentionWorker(ctx context.Context) {
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			rows, err := a.db.Query(ctx, `SELECT org_id FROM retention_policies WHERE enabled AND ($1::uuid IS NULL OR org_id=$1)`, nullableID(a.workerOrg))
			if err != nil {
				continue
			}
			orgs := []string{}
			for rows.Next() {
				var org string
				if rows.Scan(&org) == nil {
					orgs = append(orgs, org)
				}
			}
			rows.Close()
			for _, org := range orgs {
				if err = a.runRetention(ctx, org); err != nil && !errors.Is(err, pgx.ErrNoRows) && ctx.Err() == nil {
					slog.Error("retention worker failed; policy retained", "org_id", org, "error_type", fmt.Sprintf("%T", err))
				}
			}
		}
	}
}
