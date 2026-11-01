ALTER TABLE inspections ADD COLUMN retention_hold boolean NOT NULL DEFAULT false;
ALTER TABLE inspections ADD COLUMN retention_hold_reason text NOT NULL DEFAULT '';
ALTER TABLE media ADD COLUMN content_deleted_at timestamptz;
CREATE TABLE retention_policies (
 org_id uuid PRIMARY KEY REFERENCES organisations(id), report_days integer CHECK(report_days BETWEEN 1 AND 36500),
 audio_days integer CHECK(audio_days BETWEEN 1 AND 36500),transcript_days integer CHECK(transcript_days BETWEEN 1 AND 36500),
 enabled boolean NOT NULL DEFAULT false,version integer NOT NULL DEFAULT 1,activated_by uuid REFERENCES users(id),activated_at timestamptz,
 CHECK(NOT enabled OR report_days IS NOT NULL OR audio_days IS NOT NULL OR transcript_days IS NOT NULL)
);
CREATE TABLE manual_handovers (
 id uuid PRIMARY KEY,org_id uuid NOT NULL REFERENCES organisations(id),inspection_id uuid NOT NULL,
 report_id uuid NOT NULL REFERENCES reports(id) ON DELETE CASCADE,recipient text NOT NULL,channel text NOT NULL,
 reference text NOT NULL,note text NOT NULL,acknowledged boolean NOT NULL DEFAULT false,
 created_by uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(inspection_id,org_id) REFERENCES inspections(id,org_id) ON DELETE CASCADE
);
ALTER TABLE handover_deliveries DROP CONSTRAINT handover_deliveries_status_check;
ALTER TABLE handover_deliveries ADD CONSTRAINT handover_deliveries_status_check CHECK(status IN ('queued','processing','retrying','blocked','accepted','manual'));
CREATE TABLE inspection_measurements (
 org_id uuid NOT NULL,inspection_id uuid NOT NULL,capture_minutes numeric NOT NULL,review_minutes numeric NOT NULL,
 report_minutes numeric NOT NULL,reentry_minutes numeric NOT NULL,support_minutes numeric NOT NULL,
 note text NOT NULL DEFAULT '',version integer NOT NULL DEFAULT 1,measured_by uuid NOT NULL REFERENCES users(id),measured_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(org_id,inspection_id),FOREIGN KEY(inspection_id,org_id) REFERENCES inspections(id,org_id) ON DELETE CASCADE
);
CREATE TABLE account_deletion_requests (
 id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 status text NOT NULL DEFAULT 'requested' CHECK(status IN ('requested','completed')),
 created_at timestamptz NOT NULL DEFAULT now(),completed_at timestamptz
);
CREATE UNIQUE INDEX account_one_deletion_request ON account_deletion_requests(user_id) WHERE status='requested';
