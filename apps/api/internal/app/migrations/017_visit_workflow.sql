ALTER TABLE inspections ADD COLUMN assigned_to uuid REFERENCES users(id);
ALTER TABLE inspections ADD COLUMN reviewer_id uuid REFERENCES users(id);
ALTER TABLE inspections ADD COLUMN review_status text NOT NULL DEFAULT 'none' CHECK(review_status IN ('none','requested','changes_requested','approved'));
ALTER TABLE inspections ADD COLUMN review_note text NOT NULL DEFAULT '';
ALTER TABLE inspections ADD COLUMN priority text NOT NULL DEFAULT 'normal' CHECK(priority IN ('normal','high','urgent'));
ALTER TABLE inspections ADD COLUMN visit_outcome text NOT NULL DEFAULT 'scheduled' CHECK(visit_outcome IN ('scheduled','visited','no_access','cancelled'));
ALTER TABLE inspections ADD COLUMN visited_at timestamptz;
ALTER TABLE inspections ADD COLUMN external_reference text NOT NULL DEFAULT '';
ALTER TABLE inspections ADD COLUMN mutation_case_id uuid;
ALTER TABLE inspections ADD COLUMN predecessor_id uuid;
ALTER TABLE inspections ADD CONSTRAINT predecessor_tenant FOREIGN KEY(predecessor_id,org_id) REFERENCES inspections(id,org_id);
CREATE TABLE mutation_cases (
 id uuid PRIMARY KEY, org_id uuid NOT NULL REFERENCES organisations(id), property_id uuid NOT NULL,
 reference text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,org_id), FOREIGN KEY(property_id,org_id) REFERENCES properties(id,org_id)
);
ALTER TABLE inspections ADD CONSTRAINT mutation_case_tenant FOREIGN KEY(mutation_case_id,org_id) REFERENCES mutation_cases(id,org_id);
CREATE TABLE inspection_agreements (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, inspection_id uuid NOT NULL,
 source_agreement_id uuid, description text NOT NULL, responsibility text NOT NULL CHECK(responsibility IN ('resident','corporation')),
 due_date date, status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','completed','disputed','withdrawn')),
 note text NOT NULL DEFAULT '', photo_ids uuid[] NOT NULL DEFAULT '{}', version integer NOT NULL DEFAULT 1,
 UNIQUE(id,org_id), FOREIGN KEY(inspection_id,org_id) REFERENCES inspections(id,org_id) ON DELETE CASCADE
);
CREATE TRIGGER agreement_history AFTER INSERT OR UPDATE ON inspection_agreements FOR EACH ROW EXECUTE FUNCTION inspection_content_event();
CREATE FUNCTION invalidate_quality_approval() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.revision<>OLD.revision AND OLD.review_status='approved' AND NEW.review_status='approved' THEN
  NEW.review_status:='requested'; NEW.review_note:='Dossier gewijzigd; nieuwe controle nodig.';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER quality_approval_invalidation BEFORE UPDATE ON inspections FOR EACH ROW EXECUTE FUNCTION invalidate_quality_approval();

ALTER TABLE format_versions ADD COLUMN signing_policy text NOT NULL DEFAULT 'legacy' CHECK(signing_policy IN ('legacy','resident_or_exception'));
ALTER TABLE format_versions ADD COLUMN acknowledgement text NOT NULL DEFAULT '';
ALTER TABLE format_versions ALTER COLUMN signing_policy SET DEFAULT 'resident_or_exception';
ALTER TABLE organisations ADD COLUMN offline_hours integer NOT NULL DEFAULT 24 CHECK(offline_hours BETWEEN 1 AND 168);
CREATE INDEX inspection_assignment ON inspections(org_id,assigned_to,scheduled_at) WHERE archived_at IS NULL;
CREATE INDEX inspection_case ON inspections(org_id,mutation_case_id);
