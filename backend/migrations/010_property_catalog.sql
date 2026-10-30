CREATE TABLE property_sources (
 id uuid PRIMARY KEY, org_id uuid NOT NULL REFERENCES organisations(id),
 name text NOT NULL, administration text NOT NULL, kind text NOT NULL CHECK(kind IN ('csv','vera')),
 base_url text NOT NULL DEFAULT '', token_url text NOT NULL DEFAULT '',
 auth_kind text NOT NULL DEFAULT 'api_key' CHECK(auth_kind IN ('api_key','oauth2')),
 client_id text NOT NULL DEFAULT '', scopes text NOT NULL DEFAULT '', secret text NOT NULL DEFAULT '',
 enabled boolean NOT NULL DEFAULT true, revision integer NOT NULL DEFAULT 1,
 last_synced_at timestamptz, last_error text NOT NULL DEFAULT '', next_sync_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,org_id), UNIQUE(org_id,administration)
);
ALTER TABLE properties ADD COLUMN source_id uuid;
ALTER TABLE properties ADD COLUMN source_object_id text;
ALTER TABLE properties ADD COLUMN object_number text NOT NULL DEFAULT '';
ALTER TABLE properties ADD COLUMN link_state text NOT NULL DEFAULT 'provisional' CHECK(link_state IN ('provisional','linked','merged'));
ALTER TABLE properties ADD COLUMN merged_into uuid;
ALTER TABLE properties ADD COLUMN details jsonb NOT NULL DEFAULT '{}';
ALTER TABLE properties ADD COLUMN fetched_at timestamptz;
ALTER TABLE properties ADD COLUMN revision integer NOT NULL DEFAULT 1;
ALTER TABLE properties ADD CONSTRAINT property_source FOREIGN KEY(source_id,org_id) REFERENCES property_sources(id,org_id);
ALTER TABLE properties ADD CONSTRAINT property_merge FOREIGN KEY(merged_into,org_id) REFERENCES properties(id,org_id);
ALTER TABLE properties ADD CONSTRAINT property_identity CHECK((link_state='linked' AND source_id IS NOT NULL AND source_object_id IS NOT NULL AND source_object_id<>'') OR (link_state<>'linked' AND source_id IS NULL AND source_object_id IS NULL));
CREATE UNIQUE INDEX property_source_identity ON properties(org_id,source_id,source_object_id) WHERE source_id IS NOT NULL;
CREATE INDEX property_catalog_search ON properties(org_id,link_state,object_number,address);

CREATE FUNCTION property_document(property_uuid uuid, organisation_uuid uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT p.details || jsonb_build_object('id',p.id,'address',p.address,'postcode',p.postcode,'city',p.city,
 'sourceId',p.source_id,'sourceObjectId',p.source_object_id,'sourceName',s.name,'sourceKind',s.kind,'administration',s.administration,
 'objectNumber',p.object_number,'linkState',p.link_state,'mergedInto',p.merged_into,
 'fetchedAt',p.fetched_at,'revision',p.revision)
 FROM properties p LEFT JOIN property_sources s ON s.id=p.source_id AND s.org_id=p.org_id
 WHERE p.id=property_uuid AND p.org_id=organisation_uuid
$$;
ALTER TABLE inspections ADD COLUMN property_snapshot jsonb NOT NULL DEFAULT '{}';
ALTER TABLE inspections ADD COLUMN property_context_version integer NOT NULL DEFAULT 1;
UPDATE inspections SET property_snapshot=property_document(property_id,org_id);
CREATE FUNCTION pin_inspection_property() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 NEW.property_snapshot := property_document(NEW.property_id,NEW.org_id);
 RETURN NEW;
END $$;
CREATE TRIGGER inspection_property_snapshot BEFORE INSERT ON inspections FOR EACH ROW EXECUTE FUNCTION pin_inspection_property();
ALTER TABLE norm_assessments ADD COLUMN previous_reviewed_outcome text;
ALTER TABLE norm_assessments ADD COLUMN previous_review_note text NOT NULL DEFAULT '';

CREATE TABLE property_events (
 id uuid PRIMARY KEY, org_id uuid NOT NULL REFERENCES organisations(id), property_id uuid NOT NULL,
 inspection_id uuid, actor_id uuid NOT NULL REFERENCES users(id), action text NOT NULL,
 detail jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(property_id,org_id) REFERENCES properties(id,org_id),
 FOREIGN KEY(inspection_id,org_id) REFERENCES inspections(id,org_id)
);
CREATE TABLE property_imports (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, source_id uuid NOT NULL, actor_id uuid NOT NULL REFERENCES users(id),
 source_revision integer NOT NULL, catalog_fingerprint text NOT NULL, rows jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL DEFAULT now()+interval '1 hour',
 confirmed_at timestamptz, FOREIGN KEY(source_id,org_id) REFERENCES property_sources(id,org_id)
);
CREATE TABLE property_sync_jobs (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, source_id uuid NOT NULL, property_id uuid,
 source_revision integer NOT NULL, status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','done','failed')),
 attempts integer NOT NULL DEFAULT 0, run_token uuid, lease_until timestamptz,
 next_attempt_at timestamptz NOT NULL DEFAULT now(), cursor text NOT NULL DEFAULT '',
 seen_cursors text[] NOT NULL DEFAULT '{}', processed integer NOT NULL DEFAULT 0,
 last_error text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
 FOREIGN KEY(source_id,org_id) REFERENCES property_sources(id,org_id),
 FOREIGN KEY(property_id,org_id) REFERENCES properties(id,org_id)
);
CREATE UNIQUE INDEX property_one_active_sync ON property_sync_jobs(source_id) WHERE status IN ('pending','processing');
CREATE INDEX property_sync_pending ON property_sync_jobs(next_attempt_at) WHERE status IN ('pending','processing');
CREATE TABLE property_sync_seen (
 job_id uuid NOT NULL REFERENCES property_sync_jobs(id) ON DELETE CASCADE,
 source_object_id text NOT NULL, PRIMARY KEY(job_id,source_object_id)
);
