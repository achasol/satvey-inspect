-- Final report content is immutable. Archiving, holds and evidence retention
-- change operational metadata without requesting an impossible new draft review.
CREATE OR REPLACE FUNCTION invalidate_quality_approval() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.status='draft' AND NEW.revision<>OLD.revision AND OLD.review_status='approved' AND NEW.review_status='approved' THEN
  NEW.review_status:='requested'; NEW.review_note:='Dossier gewijzigd; nieuwe controle nodig.';
 END IF;
 RETURN NEW;
END $$;
