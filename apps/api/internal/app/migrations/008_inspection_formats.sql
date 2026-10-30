CREATE TABLE inspection_formats (
 id uuid PRIMARY KEY, org_id uuid NOT NULL REFERENCES organisations(id), UNIQUE(id,org_id)
);
CREATE TABLE format_versions (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, format_id uuid NOT NULL, number integer NOT NULL,
 name text NOT NULL, description text NOT NULL DEFAULT '', kind text NOT NULL CHECK(kind IN ('pre','final')),
 norm_version_id uuid, status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published')),
 revision integer NOT NULL DEFAULT 1, scopes jsonb NOT NULL DEFAULT '[]',
 created_by uuid NOT NULL REFERENCES users(id), published_at timestamptz,
 UNIQUE(id,org_id), UNIQUE(format_id,number),
 FOREIGN KEY(format_id,org_id) REFERENCES inspection_formats(id,org_id),
 FOREIGN KEY(norm_version_id,org_id) REFERENCES norm_versions(id,org_id)
);
CREATE UNIQUE INDEX format_one_draft ON format_versions(format_id) WHERE status='draft';
CREATE TRIGGER format_version_immutable BEFORE UPDATE ON format_versions FOR EACH ROW EXECUTE FUNCTION freeze_published_norms();
ALTER TABLE inspections ADD COLUMN format_version_id uuid;
ALTER TABLE inspections ADD CONSTRAINT inspection_format_version FOREIGN KEY(format_version_id,org_id) REFERENCES format_versions(id,org_id);
ALTER TABLE rooms ADD COLUMN category_id uuid;
ALTER TABLE rooms ADD COLUMN generation integer NOT NULL DEFAULT 1;
ALTER TABLE rooms ADD COLUMN approved_generation integer;
ALTER TABLE rooms ADD COLUMN reviewed_by uuid REFERENCES users(id);
ALTER TABLE rooms ADD COLUMN reviewed_at timestamptz;
CREATE TABLE format_answers (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, inspection_id uuid NOT NULL, room_id uuid NOT NULL, question_id uuid NOT NULL,
 value jsonb NOT NULL DEFAULT 'null', outcome text NOT NULL DEFAULT '', reason text NOT NULL DEFAULT '',
 status text NOT NULL DEFAULT 'missing' CHECK(status IN ('missing','suggested','confirmed','unanswerable')),
 photo_ids uuid[] NOT NULL DEFAULT '{}', audio_ids uuid[] NOT NULL DEFAULT '{}', transcript_versions jsonb NOT NULL DEFAULT '{}',
 human boolean NOT NULL DEFAULT false, version integer NOT NULL DEFAULT 1,
 reviewed_by uuid REFERENCES users(id), reviewed_at timestamptz,
 UNIQUE(room_id,question_id),
 FOREIGN KEY(room_id,org_id,inspection_id) REFERENCES rooms(id,org_id,inspection_id) ON DELETE CASCADE
);
CREATE TABLE scope_jobs (
 room_id uuid PRIMARY KEY, org_id uuid NOT NULL, inspection_id uuid NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','done','failed')),
 provider text NOT NULL, attempts integer NOT NULL DEFAULT 0, run_token uuid, lease_until timestamptz,
 next_attempt_at timestamptz NOT NULL DEFAULT now(), last_error text NOT NULL DEFAULT '',
 FOREIGN KEY(room_id,org_id,inspection_id) REFERENCES rooms(id,org_id,inspection_id) ON DELETE CASCADE
);
CREATE TABLE transcription_jobs (
 media_id uuid PRIMARY KEY, org_id uuid NOT NULL, inspection_id uuid NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','done','failed','skipped')),
 model text NOT NULL DEFAULT 'meta-models/muse-spark-open', attempts integer NOT NULL DEFAULT 0,
 run_token uuid, lease_until timestamptz, next_attempt_at timestamptz NOT NULL DEFAULT now(), last_error text NOT NULL DEFAULT '',
 machine_transcript text NOT NULL DEFAULT '', input_tokens bigint NOT NULL DEFAULT 0, output_tokens bigint NOT NULL DEFAULT 0,
 FOREIGN KEY(media_id,org_id) REFERENCES media(id,org_id) ON DELETE CASCADE,
 FOREIGN KEY(inspection_id,org_id) REFERENCES inspections(id,org_id)
);
CREATE TABLE transcription_cache (
 org_id uuid NOT NULL REFERENCES organisations(id), cache_key text NOT NULL, transcript text NOT NULL,
 PRIMARY KEY(org_id,cache_key)
);
CREATE TABLE format_review_events (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, inspection_id uuid NOT NULL,
 room_id uuid NOT NULL, user_id uuid NOT NULL REFERENCES users(id), action text NOT NULL,
 detail jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(room_id,org_id,inspection_id) REFERENCES rooms(id,org_id,inspection_id) ON DELETE CASCADE
);
CREATE INDEX format_answers_inspection ON format_answers(org_id,inspection_id);
CREATE INDEX transcription_jobs_pending ON transcription_jobs(next_attempt_at) WHERE status IN ('pending','processing');
CREATE INDEX scope_jobs_pending ON scope_jobs(next_attempt_at) WHERE status IN ('pending','processing');

UPDATE organisation_roles SET privileges=array_append(privileges,'formats.read') WHERE 'inspections.read'=ANY(privileges);
UPDATE organisation_roles SET privileges=array_append(privileges,'formats.manage') WHERE system_key IN ('admin','quality_manager');
CREATE FUNCTION seed_format_privileges() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE organisation_roles SET privileges=array_append(privileges,'formats.read') WHERE org_id=NEW.id AND 'inspections.read'=ANY(privileges);
 UPDATE organisation_roles SET privileges=array_append(privileges,'formats.manage') WHERE org_id=NEW.id AND system_key IN ('admin','quality_manager');
 RETURN NEW;
END $$;
CREATE TRIGGER organisation_format_privileges AFTER INSERT ON organisations FOR EACH ROW EXECUTE FUNCTION seed_format_privileges();
