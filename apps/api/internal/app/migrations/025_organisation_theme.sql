ALTER TABLE organisations ADD COLUMN brand_tint text NOT NULL DEFAULT '' CHECK(brand_tint='' OR brand_tint ~ '^#[0-9a-fA-F]{6}$');
