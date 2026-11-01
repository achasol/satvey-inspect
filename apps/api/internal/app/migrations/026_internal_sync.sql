CREATE TABLE internal_sync_profiles (
 destination_id uuid PRIMARY KEY REFERENCES handover_destinations(id),org_id uuid NOT NULL REFERENCES organisations(id),
 enabled boolean NOT NULL DEFAULT false,environment text NOT NULL DEFAULT 'production' CHECK(environment IN ('production','sandbox')),
 revision integer NOT NULL DEFAULT 1,config jsonb NOT NULL,tests jsonb NOT NULL DEFAULT '[]',tested_at timestamptz
);
CREATE TABLE internal_sync_jobs (
 id uuid PRIMARY KEY,org_id uuid NOT NULL REFERENCES organisations(id),inspection_id uuid NOT NULL,
 destination_id uuid NOT NULL REFERENCES internal_sync_profiles(destination_id),category text NOT NULL,
 source_revision integer NOT NULL,profile_revision integer NOT NULL,destination_revision integer NOT NULL,
 payload jsonb NOT NULL,status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','retrying','blocked','done','cancelled')),
 receipts jsonb NOT NULL DEFAULT '{}',attempts integer NOT NULL DEFAULT 0,error text NOT NULL DEFAULT '',
 next_attempt_at timestamptz NOT NULL DEFAULT now(),lease_until timestamptz,run_token uuid,
 created_at timestamptz NOT NULL DEFAULT now(),completed_at timestamptz,
 FOREIGN KEY(inspection_id,org_id) REFERENCES inspections(id,org_id) ON DELETE CASCADE,
 UNIQUE(destination_id,inspection_id,category,source_revision,profile_revision,destination_revision)
);
CREATE INDEX internal_sync_due ON internal_sync_jobs(status,next_attempt_at);
CREATE TABLE internal_sync_cursors(destination_id uuid NOT NULL REFERENCES internal_sync_profiles(destination_id),inspection_id uuid NOT NULL REFERENCES inspections(id) ON DELETE CASCADE,source_revision integer NOT NULL,profile_revision integer NOT NULL,destination_revision integer NOT NULL,PRIMARY KEY(destination_id,inspection_id));
-- Existing transfer destinations are not silently opted into a different workflow.
UPDATE handover_destinations SET enabled=false,revision=revision+1 WHERE enabled;
