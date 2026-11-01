-- Issued artifacts remain immutable; subsequent edits belong to the same dossier.
ALTER TABLE reports DROP CONSTRAINT reports_inspection_id_key;
ALTER TABLE reports ADD COLUMN number integer NOT NULL DEFAULT 1 CHECK(number > 0);
CREATE UNIQUE INDEX report_number ON reports(org_id,inspection_id,number);
ALTER TABLE inspections ADD COLUMN latest_report_id uuid REFERENCES reports(id) ON DELETE SET NULL;
UPDATE inspections i SET latest_report_id=r.id FROM reports r WHERE r.inspection_id=i.id AND r.org_id=i.org_id;

CREATE OR REPLACE FUNCTION inspection_content_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE doc jsonb; previous jsonb; changes jsonb; actor uuid;
BEGIN
 doc:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
 previous:=CASE WHEN TG_OP='INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END;
 SELECT COALESCE(jsonb_object_agg(key,jsonb_build_object('before',previous->key,'after',CASE WHEN TG_OP='DELETE' THEN NULL ELSE value END)),'{}'::jsonb)
 INTO changes FROM jsonb_each(doc)
 WHERE key NOT IN ('id','org_id','inspection_id','created_at','updated_at','object_key','sha256','version','generation','approved_generation')
 AND (TG_OP<>'UPDATE' OR previous->key IS DISTINCT FROM value);
 actor:=NULLIF(current_setting('satvey.actor_id',true),'')::uuid;
 UPDATE inspections SET revision=revision+1 WHERE id=(doc->>'inspection_id')::uuid AND org_id=(doc->>'org_id')::uuid;
 INSERT INTO inspection_events(org_id,inspection_id,actor_id,action,detail)
 VALUES((doc->>'org_id')::uuid,(doc->>'inspection_id')::uuid,actor,TG_TABLE_NAME||'_'||lower(TG_OP),
 jsonb_build_object('recordId',doc->>'id','changes',changes));
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;

-- Independent oversight must never reinstate an inspector request or signing gate.
CREATE OR REPLACE FUNCTION invalidate_quality_approval() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RETURN NEW; END $$;
