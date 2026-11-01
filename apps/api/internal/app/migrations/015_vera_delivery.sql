CREATE TABLE handover_destinations (
 id uuid PRIMARY KEY, org_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
 name text NOT NULL, config jsonb NOT NULL, secret text NOT NULL,
 enabled boolean NOT NULL DEFAULT false, revision integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(id,org_id)
);
CREATE TABLE handover_property_mappings (
 destination_id uuid NOT NULL, org_id uuid NOT NULL, property_id uuid NOT NULL,
 unit_uri text NOT NULL,
 PRIMARY KEY(destination_id,property_id),
 FOREIGN KEY(destination_id,org_id) REFERENCES handover_destinations(id,org_id),
 FOREIGN KEY(property_id,org_id) REFERENCES properties(id,org_id) ON DELETE CASCADE
);
CREATE TABLE handover_deliveries (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, inspection_id uuid NOT NULL,
 destination_id uuid NOT NULL, destination_revision integer NOT NULL,
 draft_version integer NOT NULL, snapshot jsonb NOT NULL, report_snapshot jsonb NOT NULL,
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','processing','retrying','blocked','accepted')),
 attempts integer NOT NULL DEFAULT 0, next_attempt_at timestamptz NOT NULL DEFAULT now(),
 run_token uuid, lease_until timestamptz, last_error text NOT NULL DEFAULT '',
 approved_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), accepted_at timestamptz,
 UNIQUE(id,org_id), UNIQUE(org_id,inspection_id,destination_id,draft_version),
 FOREIGN KEY(destination_id,org_id) REFERENCES handover_destinations(id,org_id),
 FOREIGN KEY(inspection_id,org_id) REFERENCES inspections(id,org_id) ON DELETE CASCADE
);
CREATE INDEX handover_deliveries_due ON handover_deliveries(next_attempt_at) WHERE status IN ('queued','processing','retrying');
CREATE TABLE handover_delivery_items (
 delivery_id uuid NOT NULL, org_id uuid NOT NULL, item_key text NOT NULL,
 receiver_id text NOT NULL, resource_uri text NOT NULL, accepted_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(delivery_id,item_key),
 FOREIGN KEY(delivery_id,org_id) REFERENCES handover_deliveries(id,org_id) ON DELETE CASCADE
);
CREATE TABLE handover_artifacts (
 org_id uuid NOT NULL, inspection_id uuid NOT NULL, path text NOT NULL,
 object_key text NOT NULL UNIQUE, sha256 text NOT NULL, bytes integer NOT NULL,
 ready boolean NOT NULL DEFAULT false,
 PRIMARY KEY(inspection_id,path),
 FOREIGN KEY(inspection_id,org_id) REFERENCES inspections(id,org_id) ON DELETE CASCADE
);
