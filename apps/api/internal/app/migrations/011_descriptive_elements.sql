-- Retain old element instructions for history only. Application queries and new
-- inspection snapshots deliberately exclude this column.
COMMENT ON COLUMN room_elements.ai_guidance IS
 'Historical element instructions. Not part of the active catalog or analysis context.';

-- Only draft measures may receive instructions. Prefer an existing draft even
-- when its links differ from the published version; never resurrect removed rules.
DO $$
DECLARE
 framework record;
 chosen norm_versions%ROWTYPE;
 rule jsonb;
 updated_rules jsonb;
 guidance text;
 current_guidance text;
 next_number integer;
BEGIN
 FOR framework IN SELECT id,org_id FROM norm_frameworks ORDER BY id FOR UPDATE LOOP
  SELECT * INTO chosen FROM norm_versions
   WHERE framework_id=framework.id AND org_id=framework.org_id
   ORDER BY (status='draft') DESC,number DESC LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN CONTINUE; END IF;

  updated_rules := '[]'::jsonb;
  FOR rule IN SELECT value FROM jsonb_array_elements(chosen.rules) LOOP
   SELECT btrim(ai_guidance) INTO guidance FROM room_elements
    WHERE org_id=framework.org_id AND id::text=rule->>'elementId';
   current_guidance := coalesce(rule->>'aiGuidance','');
   IF guidance IS NOT NULL AND guidance<>'' AND position(guidance IN current_guidance)=0 THEN
    rule := jsonb_set(rule,'{aiGuidance}',to_jsonb(
     CASE WHEN btrim(current_guidance)='' THEN '' ELSE current_guidance || E'\n\n' END
     || E'Overgenomen elementaandachtspunten:\n' || guidance));
   END IF;
   updated_rules := updated_rules || jsonb_build_array(rule);
  END LOOP;

  IF updated_rules=chosen.rules THEN CONTINUE; END IF;
  IF chosen.status='draft' THEN
   UPDATE norm_versions SET rules=updated_rules,revision=revision+1 WHERE id=chosen.id;
  ELSE
   SELECT max(number)+1 INTO next_number FROM norm_versions WHERE framework_id=framework.id;
   INSERT INTO norm_versions(id,org_id,framework_id,number,name,description,rules,sources,created_by)
    VALUES(gen_random_uuid(),chosen.org_id,chosen.framework_id,next_number,chosen.name,
     chosen.description,updated_rules,chosen.sources,chosen.created_by);
  END IF;
 END LOOP;
END $$;

-- Existing organisations keep their definitions. New organisations start with
-- descriptive definitions only; evaluation guidance belongs to norm measures.
CREATE OR REPLACE FUNCTION seed_room_elements() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO room_elements(id,org_id,name,description,rooms,aliases)
 SELECT gen_random_uuid(),NEW.id,v.name,v.description,v.rooms,v.aliases FROM (VALUES
 ('Kraan','Waterkraan of mengkraan bij wastafel, douche of aanrecht.',ARRAY['Keuken','Badkamer','Toilet'],ARRAY['faucet','mengkraan']),
 ('Wand','Binnenwand en zichtbare wandafwerking.',ARRAY['*'],ARRAY['muur','wall']),
 ('Vloer','Loopvlak, vloerafwerking en aansluitingen.',ARRAY['*'],ARRAY['floor']),
 ('Plafond','Zichtbaar plafond en plafondafwerking.',ARRAY['*'],ARRAY['ceiling']),
 ('Raam en kozijn','Raam, kozijn en zichtbaar hang- en sluitwerk.',ARRAY['*'],ARRAY['window','kozijn']),
 ('Deur','Deurblad, kozijn en hang- en sluitwerk.',ARRAY['*'],ARRAY['door']),
 ('Wastafel','Wasbak met zichtbare afvoer en sifon.',ARRAY['Badkamer','Toilet'],ARRAY['wasbak','sink']),
 ('Ventilatievoorziening','Rooster of zichtbaar afzuigpunt.',ARRAY['Keuken','Badkamer','Toilet'],ARRAY['rooster','afzuiging'])
 ) AS v(name,description,rooms,aliases);
 RETURN NEW;
END $$;
