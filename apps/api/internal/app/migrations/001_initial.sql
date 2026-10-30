CREATE TABLE users (
 id uuid PRIMARY KEY, email text NOT NULL UNIQUE, name text NOT NULL,
 password_hash text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE organisations (
 id uuid PRIMARY KEY, slug text NOT NULL UNIQUE, name text NOT NULL,
 oidc_issuer text NOT NULL DEFAULT '', oidc_client_id text NOT NULL DEFAULT '',
 oidc_client_secret text NOT NULL DEFAULT ''
);
CREATE TABLE memberships (
 org_id uuid REFERENCES organisations(id), user_id uuid REFERENCES users(id),
 role text NOT NULL CHECK(role IN ('admin','inspector','viewer')), PRIMARY KEY(org_id,user_id)
);
CREATE TABLE sessions (token_hash text PRIMARY KEY, user_id uuid REFERENCES users(id) ON DELETE CASCADE, expires_at timestamptz NOT NULL);
CREATE TABLE identities (issuer text, subject text, user_id uuid NOT NULL REFERENCES users(id), PRIMARY KEY(issuer,subject));
CREATE TABLE oidc_states (token_hash text PRIMARY KEY, org_id uuid REFERENCES organisations(id), user_id uuid REFERENCES users(id), verifier text NOT NULL, nonce text NOT NULL, expires_at timestamptz NOT NULL);
CREATE TABLE invitations (token_hash text PRIMARY KEY, org_id uuid NOT NULL REFERENCES organisations(id), email text NOT NULL, role text NOT NULL CHECK(role IN ('admin','inspector','viewer')), expires_at timestamptz NOT NULL, accepted_at timestamptz);
CREATE TABLE properties (
 id uuid PRIMARY KEY, org_id uuid NOT NULL REFERENCES organisations(id), address text NOT NULL,
 postcode text NOT NULL DEFAULT '', city text NOT NULL DEFAULT '', UNIQUE(id,org_id)
);
CREATE TABLE inspections (
 id uuid PRIMARY KEY, org_id uuid NOT NULL REFERENCES organisations(id), property_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('pre','final')), scheduled_at timestamptz, status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','final')),
 created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(id,org_id),
 FOREIGN KEY(property_id,org_id) REFERENCES properties(id,org_id)
);
CREATE TABLE rooms (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, inspection_id uuid NOT NULL, name text NOT NULL,
 UNIQUE(id,org_id,inspection_id), FOREIGN KEY(inspection_id,org_id) REFERENCES inspections(id,org_id)
);
CREATE TABLE batches (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, inspection_id uuid NOT NULL, room_id uuid NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','reviewed','excluded')), version integer NOT NULL DEFAULT 1, expected_media uuid[] NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(id,org_id,inspection_id),
 FOREIGN KEY(room_id,org_id,inspection_id) REFERENCES rooms(id,org_id,inspection_id)
);
CREATE TABLE media (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, inspection_id uuid NOT NULL, batch_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('photo','audio')), name text NOT NULL, mime text NOT NULL, size bigint NOT NULL,
 object_key text NOT NULL UNIQUE, sha256 text NOT NULL, duration real NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(id,org_id),
 FOREIGN KEY(batch_id,org_id,inspection_id) REFERENCES batches(id,org_id,inspection_id)
);
CREATE TABLE observations (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, inspection_id uuid NOT NULL, batch_id uuid NOT NULL,
 title text NOT NULL DEFAULT '', description text NOT NULL DEFAULT '', label text NOT NULL DEFAULT '',
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','approved','rejected')), source text NOT NULL CHECK(source IN ('manual','mock')),
 version integer NOT NULL DEFAULT 1,
 FOREIGN KEY(batch_id,org_id,inspection_id) REFERENCES batches(id,org_id,inspection_id)
);
CREATE TABLE processing_jobs (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, inspection_id uuid NOT NULL, batch_id uuid NOT NULL UNIQUE,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','done')), attempts integer NOT NULL DEFAULT 0,
 FOREIGN KEY(batch_id,org_id,inspection_id) REFERENCES batches(id,org_id,inspection_id)
);
CREATE TABLE reports (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, inspection_id uuid NOT NULL UNIQUE,
 snapshot jsonb NOT NULL, created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(inspection_id,org_id) REFERENCES inspections(id,org_id)
);
CREATE INDEX inspections_org ON inspections(org_id,created_at DESC);
CREATE INDEX batches_inspection ON batches(org_id,inspection_id);
CREATE INDEX media_batch ON media(org_id,batch_id);
CREATE INDEX observations_inspection ON observations(org_id,inspection_id);
CREATE INDEX sessions_expiry ON sessions(expires_at);
