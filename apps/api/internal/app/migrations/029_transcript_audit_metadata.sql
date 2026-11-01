-- Raw transcripts follow their separate retention policy. Audit their version
-- changes without keeping a second, unbounded copy of the raw text.
CREATE OR REPLACE FUNCTION inspection_content_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE doc jsonb; previous jsonb; changes jsonb; actor uuid;
BEGIN
 doc:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
 previous:=CASE WHEN TG_OP='INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END;
 SELECT COALESCE(jsonb_object_agg(key,jsonb_build_object('before',previous->key,'after',CASE WHEN TG_OP='DELETE' THEN NULL ELSE value END)),'{}'::jsonb)
 INTO changes FROM jsonb_each(doc)
 WHERE key NOT IN ('id','org_id','inspection_id','created_at','updated_at','object_key','sha256','transcript','version','generation','approved_generation')
 AND (TG_OP<>'UPDATE' OR previous->key IS DISTINCT FROM value);
 actor:=NULLIF(current_setting('satvey.actor_id',true),'')::uuid;
 UPDATE inspections SET revision=revision+1 WHERE id=(doc->>'inspection_id')::uuid AND org_id=(doc->>'org_id')::uuid;
 INSERT INTO inspection_events(org_id,inspection_id,actor_id,action,detail)
 VALUES((doc->>'org_id')::uuid,(doc->>'inspection_id')::uuid,actor,TG_TABLE_NAME||'_'||lower(TG_OP),
 jsonb_build_object('recordId',doc->>'id','changes',changes));
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;

UPDATE inspection_events SET detail=jsonb_set(detail,'{changes}',(detail->'changes')-'transcript') WHERE detail->'changes' ? 'transcript';
