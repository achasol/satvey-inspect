ALTER TABLE organisations ADD COLUMN report_name text NOT NULL DEFAULT '';
ALTER TABLE organisations ADD COLUMN logo_asset_id uuid;
ALTER TABLE organisations ADD CONSTRAINT organisation_report_logo FOREIGN KEY(logo_asset_id,id) REFERENCES norm_assets(id,org_id);
