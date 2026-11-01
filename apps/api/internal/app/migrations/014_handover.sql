-- Draft work proposals evolve independently of the immutable inspection report.
CREATE TABLE handover_drafts (
 inspection_id uuid PRIMARY KEY, org_id uuid NOT NULL,
 version integer NOT NULL CHECK(version > 0), content jsonb NOT NULL,
 updated_by uuid NOT NULL REFERENCES users(id), updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(inspection_id,org_id) REFERENCES inspections(id,org_id) ON DELETE CASCADE
);
CREATE TABLE handover_exports (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, inspection_id uuid NOT NULL,
 report_id uuid NOT NULL, draft_version integer NOT NULL CHECK(draft_version > 0),
 snapshot jsonb NOT NULL, report_snapshot jsonb NOT NULL, created_by uuid NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL, last_download_at timestamptz,
 UNIQUE(org_id,report_id,draft_version),
 FOREIGN KEY(inspection_id,org_id) REFERENCES inspections(id,org_id) ON DELETE CASCADE
);
CREATE INDEX handover_exports_inspection ON handover_exports(org_id,inspection_id,created_at DESC);
