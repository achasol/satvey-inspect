package app

import (
	"net/http"
	"strings"
	"time"
)

func (a *app) recordVisit(w http.ResponseWriter, r *http.Request) error {
	var in struct {
		Version   int        `json:"version"`
		VisitedAt *time.Time `json:"visitedAt"`
		Outcome   string     `json:"visitOutcome"`
	}
	if err := readJSON(w, r, &in); err != nil {
		return err
	}
	if in.Version < 1 || !contains([]string{"visited", "no_access", "cancelled", "scheduled"}, in.Outcome) || (in.Outcome == "visited" && in.VisitedAt == nil) {
		return fail(422, "Controleer de bezoekdatum en status")
	}
	tx, u, err := a.edit(r)
	if err != nil {
		return err
	}
	defer tx.Rollback(r.Context())
	tag, err := tx.Exec(r.Context(), `UPDATE inspections SET visited_at=$3,visit_outcome=$4,revision=revision+1 WHERE id=$1 AND org_id=$2 AND revision=$5`, r.PathValue("inspection"), r.PathValue("org"), in.VisitedAt, in.Outcome, in.Version)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return fail(409, "Het dossier is gewijzigd")
	}
	if err = recordEvent(r.Context(), tx, r.PathValue("org"), r.PathValue("inspection"), u.ID, "visit_recorded", map[string]any{"outcome": in.Outcome, "visitedAt": in.VisitedAt}); err != nil {
		return err
	}
	if err = tx.Commit(r.Context()); err != nil {
		return err
	}
	send(w, 200, map[string]int{"version": in.Version + 1})
	return nil
}

func (a *app) renameRoom(w http.ResponseWriter, r *http.Request) error {
	var in struct {
		Name       string `json:"name"`
		Generation int    `json:"generation"`
	}
	if err := readJSON(w, r, &in); err != nil {
		return err
	}
	in.Name = strings.TrimSpace(in.Name)
	if in.Name == "" || len(in.Name) > 100 || in.Generation < 1 || !validID(r.PathValue("room")) {
		return fail(422, "Controleer de ruimtenaam")
	}
	tx, _, err := a.edit(r)
	if err != nil {
		return err
	}
	defer tx.Rollback(r.Context())
	tag, err := tx.Exec(r.Context(), `UPDATE rooms SET name=$4,generation=generation+1,approved_generation=NULL WHERE id=$1 AND org_id=$2 AND inspection_id=$3 AND generation=$5`, r.PathValue("room"), r.PathValue("org"), r.PathValue("inspection"), in.Name, in.Generation)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return fail(409, "De ruimte is gewijzigd")
	}
	if err = tx.Commit(r.Context()); err != nil {
		return err
	}
	send(w, 200, map[string]int{"generation": in.Generation + 1})
	return nil
}

func (a *app) moveEvidence(w http.ResponseWriter, r *http.Request) error {
	var in struct {
		RoomID   string   `json:"roomId"`
		MediaIDs []string `json:"mediaIds"`
		Version  int      `json:"version"`
	}
	if err := readJSON(w, r, &in); err != nil {
		return err
	}
	if !validID(in.RoomID) || len(in.MediaIDs) == 0 || len(in.MediaIDs) > 30 || in.Version < 1 {
		return fail(422, "Kies bronbestanden en een doelruimte")
	}
	seen := map[string]bool{}
	for _, mid := range in.MediaIDs {
		if !validID(mid) || seen[mid] {
			return fail(422, "Ongeldige bestandsselectie")
		}
		seen[mid] = true
	}
	tx, u, err := a.edit(r)
	if err != nil {
		return err
	}
	defer tx.Rollback(r.Context())
	org, iid, bid := r.PathValue("org"), r.PathValue("inspection"), r.PathValue("batch")
	if !validID(bid) {
		return fail(404, "Opname niet gevonden")
	}
	var room, provider string
	var version, expected, count int
	if err = tx.QueryRow(r.Context(), `SELECT room_id,analysis_provider,version,cardinality(expected_media),(SELECT count(*) FROM media m WHERE m.batch_id=b.id AND m.org_id=b.org_id) FROM batches b WHERE id=$1 AND org_id=$2 AND inspection_id=$3`, bid, org, iid).Scan(&room, &provider, &version, &expected, &count); err != nil {
		return err
	}
	if room == in.RoomID || version != in.Version || count != expected {
		return fail(409, "Wacht tot de opname is opgeslagen en kies een andere ruimte")
	}
	var ok bool
	if err = tx.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM rooms WHERE id=$1 AND org_id=$2 AND inspection_id=$3) AND (SELECT count(*) FROM media WHERE id=ANY($4::uuid[]) AND batch_id=$5 AND org_id=$2)=cardinality($4::uuid[]) AND NOT EXISTS(SELECT 1 FROM processing_jobs WHERE batch_id=$5 AND org_id=$2 AND status IN ('pending','processing')) AND NOT EXISTS(SELECT 1 FROM scope_jobs WHERE org_id=$2 AND inspection_id=$3 AND room_id IN ($1,$6) AND status='processing') AND NOT EXISTS(SELECT 1 FROM transcription_jobs WHERE org_id=$2 AND media_id=ANY($4::uuid[]) AND status='processing')`, in.RoomID, org, iid, in.MediaIDs, bid, room).Scan(&ok); err != nil {
		return err
	}
	if !ok {
		return fail(409, "Bronbewijs of doelruimte is gewijzigd; herlaad de opname")
	}
	if len(in.MediaIDs) == count {
		if _, err = tx.Exec(r.Context(), `UPDATE batches SET room_id=$3,status='pending',version=version+1 WHERE id=$1 AND org_id=$2`, bid, org, in.RoomID); err != nil {
			return err
		}
	} else {
		next := id()
		if _, err = tx.Exec(r.Context(), `INSERT INTO batches(id,org_id,inspection_id,room_id,expected_media,analysis_provider) VALUES($1,$2,$3,$4,$5,$6)`, next, org, iid, in.RoomID, in.MediaIDs, provider); err != nil {
			return err
		}
		if _, err = tx.Exec(r.Context(), `UPDATE media SET batch_id=$3 WHERE batch_id=$1 AND org_id=$2 AND id=ANY($4::uuid[])`, bid, org, next, in.MediaIDs); err != nil {
			return err
		}
		if _, err = tx.Exec(r.Context(), `UPDATE batches SET expected_media=ARRAY(SELECT unnest(expected_media) EXCEPT SELECT unnest($3::uuid[])),status='pending',version=version+1 WHERE id=$1 AND org_id=$2`, bid, org, in.MediaIDs); err != nil {
			return err
		}
		if _, err = tx.Exec(r.Context(), `INSERT INTO processing_jobs(id,org_id,inspection_id,batch_id,provider) SELECT $1,$2,$3,$4,$5 WHERE EXISTS(SELECT 1 FROM inspections WHERE id=$3 AND org_id=$2 AND format_version_id IS NULL)`, id(), org, iid, next, provider); err != nil {
			return err
		}
		if _, err = tx.Exec(r.Context(), `UPDATE observations SET photo_ids=ARRAY(SELECT unnest(photo_ids) EXCEPT SELECT unnest($3::uuid[])),audio_ids=ARRAY(SELECT unnest(audio_ids) EXCEPT SELECT unnest($3::uuid[])),status=CASE WHEN status='approved' THEN 'draft' ELSE status END,version=version+1 WHERE batch_id=$1 AND org_id=$2`, bid, org, in.MediaIDs); err != nil {
			return err
		}

	}
	if _, err = tx.Exec(r.Context(), `UPDATE observations SET status='draft',version=version+1 WHERE batch_id=$1 AND org_id=$2 AND status='approved'`, bid, org); err != nil {
		return err
	}
	format, err := inspectionFormat(r.Context(), tx, org, iid)
	if err != nil {
		return err
	}
	if format != nil {
		for _, rid := range []string{room, in.RoomID} {
			if err = invalidateFormatScope(r.Context(), tx, org, iid, rid, provider); err != nil {
				return err
			}
		}
	}
	if err = recordEvent(r.Context(), tx, org, iid, u.ID, "evidence_moved", map[string]any{"fromRoomId": room, "toRoomId": in.RoomID, "mediaIds": in.MediaIDs}); err != nil {
		return err
	}
	if err = tx.Commit(r.Context()); err != nil {
		return err
	}
	send(w, 200, map[string]bool{"ok": true})
	return nil
}
