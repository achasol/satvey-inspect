ALTER TABLE organisations ADD COLUMN oidc_client_secret_encrypted text NOT NULL DEFAULT '';
ALTER TABLE invitations ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE invitations ADD CONSTRAINT invitations_id_unique UNIQUE (id);
CREATE TABLE password_resets (
 token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX password_resets_user ON password_resets(user_id);
CREATE TABLE mail_jobs (
 id uuid PRIMARY KEY, org_id uuid REFERENCES organisations(id), invitation_id uuid REFERENCES invitations(id),
 user_id uuid REFERENCES users(id) ON DELETE CASCADE, purpose text NOT NULL,
 payload text NOT NULL, status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','done','failed','cancelled')),
 attempts integer NOT NULL DEFAULT 0, next_attempt_at timestamptz NOT NULL DEFAULT now(),
 run_token uuid, lease_until timestamptz, last_error text NOT NULL DEFAULT '',
 created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz
);
CREATE INDEX mail_jobs_queue ON mail_jobs(next_attempt_at) WHERE status IN ('pending','processing');
CREATE INDEX mail_jobs_invitation ON mail_jobs(invitation_id,created_at DESC);
CREATE TABLE security_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, org_id uuid, user_id uuid,
 action text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
