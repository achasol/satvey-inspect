CREATE TABLE report_artifacts (
 report_id uuid PRIMARY KEY REFERENCES reports(id) ON DELETE CASCADE,
 org_id uuid NOT NULL REFERENCES organisations(id), inspection_id uuid NOT NULL,
 object_key text NOT NULL UNIQUE, sha256 text NOT NULL DEFAULT '', size bigint NOT NULL DEFAULT 0,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','ready','failed')),
 attempts integer NOT NULL DEFAULT 0, last_error text NOT NULL DEFAULT '', next_attempt_at timestamptz NOT NULL DEFAULT now(),
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(inspection_id,org_id) REFERENCES inspections(id,org_id) ON DELETE CASCADE
);
ALTER TABLE mail_jobs DROP CONSTRAINT IF EXISTS mail_jobs_purpose_check;
ALTER TABLE mail_jobs ADD CONSTRAINT mail_jobs_purpose_check CHECK(purpose IN ('invitation','password_reset','inspection_report'));
CREATE TABLE report_deliveries (
 id uuid PRIMARY KEY, org_id uuid NOT NULL REFERENCES organisations(id),inspection_id uuid NOT NULL,
 report_id uuid NOT NULL REFERENCES reports(id) ON DELETE CASCADE, recipient text NOT NULL,
 mail_job_id uuid REFERENCES mail_jobs(id),created_by uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(inspection_id,org_id) REFERENCES inspections(id,org_id) ON DELETE CASCADE
);
