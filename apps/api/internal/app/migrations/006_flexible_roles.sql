CREATE TABLE organisation_roles (
 id uuid PRIMARY KEY, org_id uuid NOT NULL REFERENCES organisations(id), name text NOT NULL,
 description text NOT NULL DEFAULT '', privileges text[] NOT NULL, system_key text,
 version integer NOT NULL DEFAULT 1, UNIQUE(id,org_id), UNIQUE(org_id,name), UNIQUE(org_id,system_key)
);
CREATE FUNCTION seed_organisation_roles() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO organisation_roles(id,org_id,name,description,privileges,system_key) VALUES
 (gen_random_uuid(),NEW.id,'Beheerder','Organisatie, rollen en alle modules beheren',ARRAY['inspections.read','inspections.write','norms.read','norms.manage','benchmarks.read','settings.manage'],'admin'),
 (gen_random_uuid(),NEW.id,'Inspecteur','Inspecties opnemen en beoordelen',ARRAY['inspections.read','inspections.write','norms.read'],'inspector'),
 (gen_random_uuid(),NEW.id,'Leestoegang','Dossiers, normen en benchmarks bekijken',ARRAY['inspections.read','norms.read','benchmarks.read'],'viewer'),
 (gen_random_uuid(),NEW.id,'Kwaliteitsbeheerder','Normen en voorbeelden beheren en benchmarken',ARRAY['inspections.read','norms.read','norms.manage','benchmarks.read'],'quality_manager');
 RETURN NEW;
END $$;
CREATE TRIGGER organisation_default_roles AFTER INSERT ON organisations FOR EACH ROW EXECUTE FUNCTION seed_organisation_roles();
DO $$ DECLARE o record; BEGIN
 FOR o IN SELECT * FROM organisations LOOP
  INSERT INTO organisation_roles(id,org_id,name,description,privileges,system_key) VALUES
  (gen_random_uuid(),o.id,'Beheerder','Organisatie, rollen en alle modules beheren',ARRAY['inspections.read','inspections.write','norms.read','norms.manage','benchmarks.read','settings.manage'],'admin'),
  (gen_random_uuid(),o.id,'Inspecteur','Inspecties opnemen en beoordelen',ARRAY['inspections.read','inspections.write','norms.read'],'inspector'),
  (gen_random_uuid(),o.id,'Leestoegang','Dossiers, normen en benchmarks bekijken',ARRAY['inspections.read','norms.read','benchmarks.read'],'viewer'),
  (gen_random_uuid(),o.id,'Kwaliteitsbeheerder','Normen en voorbeelden beheren en benchmarken',ARRAY['inspections.read','norms.read','norms.manage','benchmarks.read'],'quality_manager');
 END LOOP;
END $$;
ALTER TABLE memberships ADD COLUMN role_id uuid;
ALTER TABLE invitations ADD COLUMN role_id uuid;
UPDATE memberships m SET role_id=r.id FROM organisation_roles r WHERE m.org_id=r.org_id AND m.role=r.system_key;
UPDATE invitations i SET role_id=r.id FROM organisation_roles r WHERE i.org_id=r.org_id AND i.role=r.system_key;
ALTER TABLE memberships ALTER COLUMN role_id SET NOT NULL;
ALTER TABLE invitations ALTER COLUMN role_id SET NOT NULL;
ALTER TABLE memberships ADD CONSTRAINT membership_organisation_role FOREIGN KEY(role_id,org_id) REFERENCES organisation_roles(id,org_id);
ALTER TABLE invitations ADD CONSTRAINT invitation_organisation_role FOREIGN KEY(role_id,org_id) REFERENCES organisation_roles(id,org_id);
CREATE FUNCTION membership_role_compatibility() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND NEW.role IS DISTINCT FROM OLD.role AND NEW.role_id IS NOT DISTINCT FROM OLD.role_id THEN NEW.role_id=NULL; END IF;
 IF NEW.role_id IS NULL THEN SELECT id INTO NEW.role_id FROM organisation_roles WHERE org_id=NEW.org_id AND system_key=NEW.role; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER membership_default_role BEFORE INSERT OR UPDATE ON memberships FOR EACH ROW EXECUTE FUNCTION membership_role_compatibility();
CREATE TRIGGER invitation_default_role BEFORE INSERT OR UPDATE ON invitations FOR EACH ROW EXECUTE FUNCTION membership_role_compatibility();
