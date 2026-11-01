ALTER TABLE inspections ADD COLUMN archived_at timestamptz;
ALTER TABLE inspections ADD COLUMN archived_by uuid REFERENCES users(id);
ALTER TABLE inspections ADD COLUMN archive_reason text NOT NULL DEFAULT '';
ALTER TABLE inspections ADD COLUMN revision integer NOT NULL DEFAULT 1;
ALTER TABLE inspections ADD COLUMN corrects_inspection_id uuid;
ALTER TABLE inspections ADD COLUMN correction_reason text NOT NULL DEFAULT '';
ALTER TABLE inspections ADD COLUMN superseded_by uuid;
ALTER TABLE inspections ADD CONSTRAINT inspection_correction_tenant FOREIGN KEY(corrects_inspection_id,org_id) REFERENCES inspections(id,org_id);
ALTER TABLE inspections ADD CONSTRAINT inspection_successor_tenant FOREIGN KEY(superseded_by,org_id) REFERENCES inspections(id,org_id);
CREATE UNIQUE INDEX inspection_one_correction ON inspections(corrects_inspection_id) WHERE corrects_inspection_id IS NOT NULL;

-- Deliberately independent of the inspection: a minimal purge receipt survives.
CREATE TABLE inspection_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 org_id uuid NOT NULL REFERENCES organisations(id), inspection_id uuid NOT NULL,
 actor_id uuid, action text NOT NULL, detail jsonb NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX inspection_events_dossier ON inspection_events(org_id,inspection_id,id);

CREATE FUNCTION inspection_content_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE doc jsonb; actor uuid;
BEGIN
 doc:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
 actor:=NULLIF(current_setting('satvey.actor_id',true),'')::uuid;
 UPDATE inspections SET revision=revision+1 WHERE id=(doc->>'inspection_id')::uuid AND org_id=(doc->>'org_id')::uuid;
 INSERT INTO inspection_events(org_id,inspection_id,actor_id,action,detail)
 VALUES((doc->>'org_id')::uuid,(doc->>'inspection_id')::uuid,actor,TG_TABLE_NAME||'_'||lower(TG_OP),
 jsonb_build_object('recordId',doc->>'id','status',doc->>'status','version',doc->>'version'));
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER observation_history AFTER INSERT OR UPDATE ON observations FOR EACH ROW EXECUTE FUNCTION inspection_content_event();
CREATE TRIGGER batch_history AFTER INSERT OR UPDATE ON batches FOR EACH ROW EXECUTE FUNCTION inspection_content_event();
CREATE TRIGGER media_history AFTER INSERT OR UPDATE ON media FOR EACH ROW EXECUTE FUNCTION inspection_content_event();
CREATE TRIGGER answer_history AFTER INSERT OR UPDATE ON format_answers FOR EACH ROW EXECUTE FUNCTION inspection_content_event();
CREATE TRIGGER room_history AFTER INSERT OR UPDATE ON rooms FOR EACH ROW EXECUTE FUNCTION inspection_content_event();

-- Only the built-in administrator gains these capabilities automatically.
UPDATE organisation_roles SET privileges=privileges||ARRAY['inspections.archive','inspections.purge','inspections.plan','inspections.review'] WHERE system_key='admin';
CREATE FUNCTION seed_dossier_privileges() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.system_key='admin' THEN
  NEW.privileges:=NEW.privileges||ARRAY['inspections.archive','inspections.purge','inspections.plan','inspections.review'];
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER dossier_admin_privileges BEFORE INSERT ON organisation_roles FOR EACH ROW EXECUTE FUNCTION seed_dossier_privileges();
