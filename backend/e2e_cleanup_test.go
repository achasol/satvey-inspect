package main

import (
	"context"
	"os"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Explicit development maintenance command. Normal test runs never remove browser fixtures.
func TestCleanupBrowserFixtures(t *testing.T) {
	if os.Getenv("CLEANUP_E2E_FIXTURES") != "1" {
		t.Skip("set CLEANUP_E2E_FIXTURES=1 to remove generated browser-test inspections")
	}
	ctx := context.Background()
	db, e := pgxpool.New(ctx, os.Getenv("DATABASE_URL"))
	if e != nil {
		t.Fatal(e)
	}
	defer db.Close()
	rows, e := db.Query(ctx, `SELECT i.id,p.id FROM inspections i JOIN properties p ON p.id=i.property_id AND p.org_id=i.org_id JOIN users u ON u.id=i.created_by WHERE u.email=$1 AND (p.address ~ '^Teststraat [0-9]{13}-[0-9]{1,3}$' OR (p.address ~ '^Teststraat [0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' AND EXISTS(SELECT 1 FROM format_versions v WHERE v.id=i.format_version_id AND v.org_id=i.org_id AND v.name ~ '^E2E Format ')))`, env("E2E_EMAIL", "admin@satvey.local"))
	if e != nil {
		t.Fatal(e)
	}
	ids, properties := []string{}, []string{}
	for rows.Next() {
		var iid, pid string
		if e = rows.Scan(&iid, &pid); e != nil {
			t.Fatal(e)
		}
		ids = append(ids, iid)
		properties = append(properties, pid)
	}
	rows.Close()
	if len(ids) == 0 {
		return
	}
	rows, e = db.Query(ctx, "SELECT object_key FROM media WHERE inspection_id=ANY($1::uuid[])", ids)
	if e != nil {
		t.Fatal(e)
	}
	keys := []string{}
	for rows.Next() {
		var key string
		if e = rows.Scan(&key); e != nil {
			t.Fatal(e)
		}
		keys = append(keys, key)
	}
	rows.Close()
	tx, e := db.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	defer tx.Rollback(ctx)
	for _, table := range []string{"property_events", "format_review_events", "scope_jobs", "format_answers", "transcription_jobs", "norm_assessments", "reports", "observations", "processing_jobs", "media", "batches", "rooms"} {
		if _, e = tx.Exec(ctx, "DELETE FROM "+table+" WHERE inspection_id=ANY($1::uuid[])", ids); e != nil {
			t.Fatal(e)
		}
	}
	if _, e = tx.Exec(ctx, "DELETE FROM inspections WHERE id=ANY($1::uuid[])", ids); e != nil {
		t.Fatal(e)
	}
	if _, e = tx.Exec(ctx, "DELETE FROM properties WHERE id=ANY($1::uuid[]) AND NOT EXISTS(SELECT 1 FROM inspections WHERE property_id=properties.id) AND NOT EXISTS(SELECT 1 FROM property_events WHERE property_id=properties.id) AND NOT EXISTS(SELECT 1 FROM property_sync_jobs WHERE property_id=properties.id) AND NOT EXISTS(SELECT 1 FROM properties m WHERE m.merged_into=properties.id)", properties); e != nil {
		t.Fatal(e)
	}
	if e = tx.Commit(ctx); e != nil {
		t.Fatal(e)
	}
	client := s3.New(s3.Options{Region: "us-east-1", BaseEndpoint: aws.String(os.Getenv("S3_ENDPOINT")), UsePathStyle: true, Credentials: credentials.NewStaticCredentialsProvider(os.Getenv("S3_ACCESS_KEY"), os.Getenv("S3_SECRET_KEY"), "")})
	bucket := env("S3_BUCKET", "satvey-evidence")
	for _, key := range keys {
		if _, e = client.DeleteObject(ctx, &s3.DeleteObjectInput{Bucket: &bucket, Key: &key}); e != nil {
			t.Fatal(e)
		}
	}
	t.Logf("Removed %d generated inspections and %d objects", len(ids), len(keys))
}

// Run after capture cleanup. Only generated names owned by the browser-test account qualify.
func TestCleanupNormBrowserFixtures(t *testing.T) {
	if os.Getenv("CLEANUP_E2E_FIXTURES") != "1" {
		t.Skip("explicit browser fixture maintenance only")
	}
	ctx := context.Background()
	db, e := pgxpool.New(ctx, os.Getenv("DATABASE_URL"))
	if e != nil {
		t.Fatal(e)
	}
	defer db.Close()
	tx, e := db.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	defer tx.Rollback(ctx)
	email := env("E2E_EMAIL", "admin@satvey.local")
	// Remove only disposable, unreferenced format families created by this test account.
	formatRows, err := tx.Query(ctx, `SELECT DISTINCT f.format_id FROM format_versions f JOIN users u ON u.id=f.created_by WHERE u.email=$1 AND f.name ~ '^E2E Format (builder )?[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' AND NOT EXISTS(SELECT 1 FROM inspections i JOIN format_versions v ON v.id=i.format_version_id WHERE v.format_id=f.format_id) AND NOT EXISTS(SELECT 1 FROM format_versions v WHERE v.format_id=f.format_id AND v.name !~ '^E2E Format (builder )?[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$')`, email)
	if err != nil {
		t.Fatal(err)
	}
	formatIDs := []string{}
	for formatRows.Next() {
		var fid string
		if err = formatRows.Scan(&fid); err != nil {
			t.Fatal(err)
		}
		formatIDs = append(formatIDs, fid)
	}
	formatRows.Close()
	if _, e = tx.Exec(ctx, `DELETE FROM format_versions WHERE format_id=ANY($1::uuid[])`, formatIDs); e != nil {
		t.Fatal(e)
	}
	if _, e = tx.Exec(ctx, `DELETE FROM inspection_formats WHERE id=ANY($1::uuid[])`, formatIDs); e != nil {
		t.Fatal(e)
	}
	rows, e := tx.Query(ctx, `SELECT DISTINCT n.framework_id FROM norm_versions n JOIN users u ON u.id=n.created_by WHERE u.email=$1 AND n.name ~ '^E2E Norms ([0-9]{13}-[a-z-]+|[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12})$' AND NOT EXISTS(SELECT 1 FROM inspections i JOIN norm_versions v ON v.id=i.norm_version_id WHERE v.framework_id=n.framework_id) AND NOT EXISTS(SELECT 1 FROM format_versions f JOIN norm_versions v ON v.id=f.norm_version_id WHERE v.framework_id=n.framework_id) AND NOT EXISTS(SELECT 1 FROM norm_versions v WHERE v.framework_id=n.framework_id AND v.name !~ '^E2E Norms ([0-9]{13}-[a-z-]+|[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12})$')`, email)
	if e != nil {
		t.Fatal(e)
	}
	frameworks := []string{}
	for rows.Next() {
		var id string
		if e = rows.Scan(&id); e != nil {
			t.Fatal(e)
		}
		frameworks = append(frameworks, id)
	}
	rows.Close()
	if _, e = tx.Exec(ctx, "DELETE FROM norm_versions WHERE framework_id=ANY($1::uuid[])", frameworks); e != nil {
		t.Fatal(e)
	}
	if _, e = tx.Exec(ctx, "DELETE FROM norm_frameworks WHERE id=ANY($1::uuid[])", frameworks); e != nil {
		t.Fatal(e)
	}
	if _, e = tx.Exec(ctx, `DELETE FROM room_elements el WHERE el.name ~ '^E2E Element [0-9]{13}-[a-z-]+$' AND EXISTS(SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.org_id=el.org_id AND u.email=$1) AND NOT EXISTS(SELECT 1 FROM norm_versions v CROSS JOIN LATERAL jsonb_array_elements(v.rules) r WHERE v.org_id=el.org_id AND r->>'elementId'=el.id::text)`, email); e != nil {
		t.Fatal(e)
	}
	if _, e = tx.Exec(ctx, `DELETE FROM organisation_roles ro WHERE ro.name ~ '^E2E Role [0-9]{13}-[a-z-]+$' AND EXISTS(SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.org_id=ro.org_id AND u.email=$1) AND NOT EXISTS(SELECT 1 FROM memberships m WHERE m.role_id=ro.id) AND NOT EXISTS(SELECT 1 FROM invitations i WHERE i.role_id=ro.id)`, email); e != nil {
		t.Fatal(e)
	}
	if e = tx.Commit(ctx); e != nil {
		t.Fatal(e)
	}
	t.Logf("Removed %d generated norm frameworks", len(frameworks))
}
