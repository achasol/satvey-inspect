ALTER TABLE media ADD COLUMN annotations jsonb NOT NULL DEFAULT '[]';
ALTER TABLE media ADD COLUMN annotation_version integer NOT NULL DEFAULT 0;
ALTER TABLE media ADD COLUMN annotated_by uuid REFERENCES users(id);
ALTER TABLE media ADD COLUMN annotated_at timestamptz;
