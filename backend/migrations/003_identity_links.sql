CREATE TABLE identity_links (
 token_hash text PRIMARY KEY,
 user_id uuid NOT NULL REFERENCES users(id),
 issuer text NOT NULL,
 subject text NOT NULL,
 expires_at timestamptz NOT NULL
);
