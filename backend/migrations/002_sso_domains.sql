CREATE TABLE organisation_domains (
 domain text PRIMARY KEY,
 org_id uuid NOT NULL REFERENCES organisations(id),
 CHECK(domain=lower(domain) AND domain NOT LIKE '%@%' AND domain LIKE '%.%')
);
CREATE INDEX organisation_domains_org ON organisation_domains(org_id);
