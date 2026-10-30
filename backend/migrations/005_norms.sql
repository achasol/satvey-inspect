ALTER TABLE memberships DROP CONSTRAINT memberships_role_check;
ALTER TABLE memberships ADD CONSTRAINT memberships_role_check CHECK(role IN ('admin','inspector','viewer','quality_manager'));
ALTER TABLE invitations DROP CONSTRAINT invitations_role_check;
ALTER TABLE invitations ADD CONSTRAINT invitations_role_check CHECK(role IN ('admin','inspector','viewer','quality_manager'));

CREATE TABLE norm_frameworks (
 id uuid PRIMARY KEY, org_id uuid NOT NULL REFERENCES organisations(id), UNIQUE(id,org_id)
);
CREATE TABLE norm_versions (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, framework_id uuid NOT NULL,
 number integer NOT NULL, name text NOT NULL, description text NOT NULL DEFAULT '',
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published')),
 revision integer NOT NULL DEFAULT 1, rules jsonb NOT NULL DEFAULT '[]', sources jsonb NOT NULL DEFAULT '[]',
 created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 published_by uuid REFERENCES users(id), published_at timestamptz,
 UNIQUE(id,org_id), UNIQUE(framework_id,number),
 FOREIGN KEY(framework_id,org_id) REFERENCES norm_frameworks(id,org_id)
);
CREATE UNIQUE INDEX norm_one_draft ON norm_versions(framework_id) WHERE status='draft';
CREATE TABLE norm_assets (
 id uuid PRIMARY KEY, org_id uuid NOT NULL REFERENCES organisations(id),
 name text NOT NULL, mime text NOT NULL, kind text NOT NULL CHECK(kind IN ('photo','audio')),
 object_key text NOT NULL UNIQUE, sha256 text NOT NULL, size bigint NOT NULL,
 created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(id,org_id)
);
CREATE FUNCTION freeze_published_norms() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.status='published' THEN RAISE EXCEPTION 'Published norms are immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER norm_version_immutable BEFORE UPDATE ON norm_versions FOR EACH ROW EXECUTE FUNCTION freeze_published_norms();

ALTER TABLE inspections ADD COLUMN norm_version_id uuid;
ALTER TABLE inspections ADD CONSTRAINT inspection_norm_version FOREIGN KEY(norm_version_id,org_id) REFERENCES norm_versions(id,org_id);
ALTER TABLE media ADD COLUMN transcript text NOT NULL DEFAULT '';
ALTER TABLE media ADD COLUMN transcript_version integer NOT NULL DEFAULT 1;
ALTER TABLE observations ADD COLUMN audio_ids uuid[] NOT NULL DEFAULT '{}';
CREATE TABLE norm_assessments (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, inspection_id uuid NOT NULL, batch_id uuid NOT NULL,
 norm_version_id uuid NOT NULL, rule_id uuid NOT NULL,
 outcome text NOT NULL CHECK(outcome IN ('acceptable','unacceptable','not_assessable','not_applicable')),
 reason text NOT NULL, photo_ids uuid[] NOT NULL DEFAULT '{}', audio_ids uuid[] NOT NULL DEFAULT '{}',
 source text NOT NULL CHECK(source IN ('ai','mock','system')), transcript_versions jsonb NOT NULL DEFAULT '{}',
 reviewed_outcome text CHECK(reviewed_outcome IN ('acceptable','unacceptable','not_assessable','not_applicable')),
 review_note text NOT NULL DEFAULT '', reviewed_by uuid REFERENCES users(id), reviewed_at timestamptz,
 stale boolean NOT NULL DEFAULT false, version integer NOT NULL DEFAULT 1,
 UNIQUE(batch_id,rule_id),
 FOREIGN KEY(batch_id,org_id,inspection_id) REFERENCES batches(id,org_id,inspection_id),
 FOREIGN KEY(norm_version_id,org_id) REFERENCES norm_versions(id,org_id)
);
CREATE INDEX norm_assessments_benchmark ON norm_assessments(org_id,norm_version_id,reviewed_outcome);
