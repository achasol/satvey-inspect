-- Object deletion is queued in the same transaction as dossier deletion so a
-- temporary storage outage cannot leave a half-deleted inspection.
CREATE TABLE inspection_file_deletions (
 object_key text PRIMARY KEY, org_id uuid NOT NULL REFERENCES organisations(id),
 attempts integer NOT NULL DEFAULT 0,
 next_attempt_at timestamptz NOT NULL DEFAULT now()
);
