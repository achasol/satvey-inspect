CREATE TABLE room_elements (
 id uuid PRIMARY KEY, org_id uuid NOT NULL REFERENCES organisations(id), name text NOT NULL,
 description text NOT NULL DEFAULT '', rooms text[] NOT NULL, aliases text[] NOT NULL DEFAULT '{}',
 ai_guidance text NOT NULL DEFAULT '', archived boolean NOT NULL DEFAULT false,
 version integer NOT NULL DEFAULT 1, UNIQUE(id,org_id), UNIQUE(org_id,name)
);
ALTER TABLE inspections ADD COLUMN element_context jsonb NOT NULL DEFAULT '[]';
CREATE FUNCTION seed_room_elements() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO room_elements(id,org_id,name,description,rooms,aliases,ai_guidance)
 SELECT gen_random_uuid(),NEW.id,v.name,v.description,v.rooms,v.aliases,v.guidance FROM (VALUES
 ('Kraan','Waterkraan of mengkraan bij wastafel, douche of aanrecht.',ARRAY['Keuken','Badkamer','Toilet'],ARRAY['faucet','mengkraan'],'Let op zichtbare beschadiging, aansluiting en gemelde lekkage. Werking vereist een beschreven proef.'),
 ('Wand','Binnenwand en zichtbare wandafwerking.',ARRAY['*'],ARRAY['muur','wall'],'Let op zichtbare scheuren, loslatende afwerking en vochtsporen. Leid geen constructieve oorzaak af uit alleen beeld.'),
 ('Vloer','Loopvlak, vloerafwerking en aansluitingen.',ARRAY['*'],ARRAY['floor'],'Let op losse delen, gaten en opstaande randen. Een foto bewijst geen draagkracht of stroefheid.'),
 ('Plafond','Zichtbaar plafond en plafondafwerking.',ARRAY['*'],ARRAY['ceiling'],'Let op vochtsporen en loslatende delen. Veronderstel geen verborgen lekkage.'),
 ('Raam en kozijn','Raam, kozijn en zichtbaar hang- en sluitwerk.',ARRAY['*'],ARRAY['window','kozijn'],'Let op beschadiging en losse delen. Openen en sluiten vereist een beschreven bedieningstest.'),
 ('Deur','Deurblad, kozijn en hang- en sluitwerk.',ARRAY['*'],ARRAY['door'],'Let op beschadiging en losse onderdelen. Een foto bewijst geen sluitwerking.'),
 ('Wastafel','Wasbak met zichtbare afvoer en sifon.',ARRAY['Badkamer','Toilet'],ARRAY['wasbak','sink'],'Let op breuken, aansluiting en zichtbare lekkage. Afvoerwerking vereist een beschreven proef.'),
 ('Ventilatievoorziening','Rooster of zichtbaar afzuigpunt.',ARRAY['Keuken','Badkamer','Toilet'],ARRAY['rooster','afzuiging'],'Let op beschadiging en zichtbare blokkades. Bepaal geen luchtdebiet uit een foto.')
 ) AS v(name,description,rooms,aliases,guidance);
 RETURN NEW;
END $$;
CREATE TRIGGER organisation_room_elements AFTER INSERT ON organisations FOR EACH ROW EXECUTE FUNCTION seed_room_elements();
DO $$ DECLARE o record; BEGIN
 FOR o IN SELECT * FROM organisations LOOP
  INSERT INTO room_elements(id,org_id,name,description,rooms,aliases,ai_guidance)
  SELECT gen_random_uuid(),o.id,v.name,v.description,v.rooms,v.aliases,v.guidance FROM (VALUES
  ('Kraan','Waterkraan of mengkraan bij wastafel, douche of aanrecht.',ARRAY['Keuken','Badkamer','Toilet'],ARRAY['faucet','mengkraan'],'Let op zichtbare beschadiging, aansluiting en gemelde lekkage. Werking vereist een beschreven proef.'),
  ('Wand','Binnenwand en zichtbare wandafwerking.',ARRAY['*'],ARRAY['muur','wall'],'Let op zichtbare scheuren, loslatende afwerking en vochtsporen. Leid geen constructieve oorzaak af uit alleen beeld.'),
  ('Vloer','Loopvlak, vloerafwerking en aansluitingen.',ARRAY['*'],ARRAY['floor'],'Let op losse delen, gaten en opstaande randen. Een foto bewijst geen draagkracht of stroefheid.'),
  ('Plafond','Zichtbaar plafond en plafondafwerking.',ARRAY['*'],ARRAY['ceiling'],'Let op vochtsporen en loslatende delen. Veronderstel geen verborgen lekkage.'),
  ('Raam en kozijn','Raam, kozijn en zichtbaar hang- en sluitwerk.',ARRAY['*'],ARRAY['window','kozijn'],'Let op beschadiging en losse delen. Openen en sluiten vereist een beschreven bedieningstest.'),
  ('Deur','Deurblad, kozijn en hang- en sluitwerk.',ARRAY['*'],ARRAY['door'],'Let op beschadiging en losse onderdelen. Een foto bewijst geen sluitwerking.'),
  ('Wastafel','Wasbak met zichtbare afvoer en sifon.',ARRAY['Badkamer','Toilet'],ARRAY['wasbak','sink'],'Let op breuken, aansluiting en zichtbare lekkage. Afvoerwerking vereist een beschreven proef.'),
  ('Ventilatievoorziening','Rooster of zichtbaar afzuigpunt.',ARRAY['Keuken','Badkamer','Toilet'],ARRAY['rooster','afzuiging'],'Let op beschadiging en zichtbare blokkades. Bepaal geen luchtdebiet uit een foto.')
  ) AS v(name,description,rooms,aliases,guidance);
 END LOOP;
END $$;
