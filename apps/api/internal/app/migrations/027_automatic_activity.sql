CREATE TABLE inspection_activity (
 id uuid PRIMARY KEY,org_id uuid NOT NULL REFERENCES organisations(id),inspection_id uuid NOT NULL,
 user_id uuid REFERENCES users(id) ON DELETE SET NULL,session_id uuid NOT NULL,room_id uuid,
 phase text NOT NULL CHECK(phase IN ('capture','review','report')),
 started_at timestamptz NOT NULL,ended_at timestamptz NOT NULL,received_at timestamptz NOT NULL DEFAULT now(),
 CHECK(ended_at>started_at AND ended_at<=started_at+interval '30 seconds'),
 FOREIGN KEY(inspection_id,org_id) REFERENCES inspections(id,org_id) ON DELETE CASCADE
);
CREATE INDEX inspection_activity_query ON inspection_activity(org_id,user_id,started_at,ended_at);
