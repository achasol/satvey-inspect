ALTER TABLE norm_assets DROP CONSTRAINT norm_assets_kind_check;
ALTER TABLE norm_assets ADD CONSTRAINT norm_assets_kind_check CHECK(kind IN ('photo','audio','document'));
ALTER TABLE norm_assessments ADD COLUMN score_detail jsonb;
ALTER TABLE format_answers ADD COLUMN score_detail jsonb;
ALTER TABLE media ADD COLUMN capture_session_id uuid;
ALTER TABLE media ADD COLUMN audio_segment_id uuid;
ALTER TABLE media ADD COLUMN recorded_at timestamptz;
CREATE TRIGGER assessment_history AFTER INSERT OR UPDATE ON norm_assessments FOR EACH ROW EXECUTE FUNCTION inspection_content_event();
