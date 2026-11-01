ALTER TABLE sessions ADD COLUMN kind text NOT NULL DEFAULT 'web' CHECK(kind IN ('web','native'));
CREATE TABLE mobile_login_requests (
 token_hash text PRIMARY KEY, challenge text NOT NULL,state text NOT NULL,
 expires_at timestamptz NOT NULL,code_hash text UNIQUE,user_id uuid REFERENCES users(id) ON DELETE CASCADE,
 authorised_at timestamptz, consumed_at timestamptz
);
ALTER TABLE organisations ADD COLUMN settings_version integer NOT NULL DEFAULT 1;
