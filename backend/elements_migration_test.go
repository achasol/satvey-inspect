package main

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func TestDescriptiveElementsMigration(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	tx, err := f.a.db.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := tx.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	// Reconstruct the pre-migration database in a transaction-local schema. This
	// exercises the real schema, defaults and immutable-publication trigger while
	// keeping the running application and other tests isolated.
	schema := "element_migration_" + strings.ReplaceAll(id(), "-", "")
	exec("CREATE SCHEMA " + schema)
	exec("SET LOCAL search_path TO " + schema)
	files, err := migrations.ReadDir("migrations")
	if err != nil {
		t.Fatal(err)
	}
	for _, file := range files {
		if file.Name() >= "011_descriptive_elements.sql" {
			break
		}
		sql, err := migrations.ReadFile("migrations/" + file.Name())
		if err != nil {
			t.Fatal(err)
		}
		exec(string(sql))
	}
	u, org, otherOrg := id(), id(), id()
	exec("INSERT INTO users(id,email,name) VALUES($1,'migration@test.invalid','Migration author')", u)
	exec("INSERT INTO organisations(id,slug,name) VALUES($1,$3,'Migration organisation'),($2,$4,'Other organisation')", org, otherOrg, org, otherOrg)
	var elementID, foreignID string
	if err := tx.QueryRow(ctx, "SELECT id FROM room_elements WHERE org_id=$1 AND name='Kraan'", org).Scan(&elementID); err != nil {
		t.Fatal(err)
	}
	if err := tx.QueryRow(ctx, "SELECT id FROM room_elements WHERE org_id=$1 AND name='Kraan'", otherOrg).Scan(&foreignID); err != nil {
		t.Fatal(err)
	}
	legacy := strings.Repeat("E", 3000)
	exec("UPDATE room_elements SET ai_guidance=$1,archived=true WHERE id=$2", legacy, elementID)
	exec("UPDATE room_elements SET ai_guidance='FOREIGN_INSTRUCTIONS' WHERE id=$1", foreignID)
	unlinkedID := id()
	exec("INSERT INTO room_elements(id,org_id,name,rooms,ai_guidance) VALUES($1,$2,'Unlinked element',ARRAY['*'],'UNLINKED_HISTORY')", unlinkedID, org)

	newFramework := func() string {
		t.Helper()
		fid := id()
		exec("INSERT INTO norm_frameworks(id,org_id) VALUES($1,$2)", fid, org)
		return fid
	}
	addVersion := func(fid string, number int, status string, rules []normRule) normDocument {
		t.Helper()
		versionID := id()
		raw, err := json.Marshal(rules)
		if err != nil {
			t.Fatal(err)
		}
		exec(`INSERT INTO norm_versions(id,org_id,framework_id,number,name,description,status,revision,rules,sources,created_by)
		 VALUES($1,$2,$3,$4,'Preserved name','Preserved description',$5,7,$6,'[{"title":"Preserved source","url":"https://example.org","checkedAt":"2026-10-30"}]',$7)`, versionID, org, fid, number, status, raw, u)
		doc, err := readNorm(ctx, tx, org, versionID)
		if err != nil {
			t.Fatal(err)
		}
		return doc
	}
	read := func(versionID string) normDocument {
		t.Helper()
		doc, err := readNorm(ctx, tx, org, versionID)
		if err != nil {
			t.Fatal(err)
		}
		return doc
	}
	equal := func(want, got normDocument) {
		t.Helper()
		w, _ := json.Marshal(want)
		g, _ := json.Marshal(got)
		if !bytes.Equal(w, g) {
			t.Fatalf("version changed unexpectedly: want %s, got %s", w, g)
		}
	}

	rules, _ := baselineNorms()
	rules = rules[:4]
	rules[0].ElementID, rules[0].AIGuidance = elementID, strings.Repeat("N", 3000)
	rules[1].ElementID, rules[1].AIGuidance = elementID, legacy
	rules[2].ElementID = foreignID                        // An invalid cross-organisation link must not transfer text.
	rules[3].ElementID, rules[3].ObjectType = "", "Kraan" // No matching by name.
	fid := newFramework()
	published := addVersion(fid, 1, "published", rules[:1])
	draft := addVersion(fid, 2, "draft", rules)

	cloneFID := newFramework()
	older := addVersion(cloneFID, 1, "published", rules[1:2])
	latest := addVersion(cloneFID, 2, "published", rules[:1])
	// Do not create a draft based on links removed in the latest publication.
	removedFID := newFramework()
	removedOld := addVersion(removedFID, 1, "published", rules[:1])
	removedLatest := addVersion(removedFID, 2, "published", rules[3:])
	// Nor resurrect a rule removed from an already existing draft.
	editedFID := newFramework()
	editedPublished := addVersion(editedFID, 1, "published", rules[:1])
	editedDraft := addVersion(editedFID, 2, "draft", rules[3:])

	sql, err := migrations.ReadFile("migrations/011_descriptive_elements.sql")
	if err != nil {
		t.Fatal(err)
	}
	exec(string(sql))
	draft.Rules[0].AIGuidance += "\n\nOvergenomen elementaandachtspunten:\n" + legacy
	draft.Revision++
	equal(draft, read(draft.ID))
	if err := validateNorms(read(draft.ID), true); err != nil {
		t.Fatalf("merged instructions cannot be published: %v", err)
	}
	for _, doc := range []normDocument{published, older, latest, removedOld, removedLatest, editedPublished, editedDraft} {
		equal(doc, read(doc.ID))
	}
	var cloneID string
	if err := tx.QueryRow(ctx, "SELECT id FROM norm_versions WHERE framework_id=$1 AND status='draft'", cloneFID).Scan(&cloneID); err != nil {
		t.Fatal(err)
	}
	wantClone := latest
	wantClone.Rules = append([]normRule{}, latest.Rules...)
	wantClone.ID, wantClone.Number, wantClone.Status, wantClone.Revision = cloneID, 3, "draft", 1
	wantClone.Rules[0].AIGuidance += "\n\nOvergenomen elementaandachtspunten:\n" + legacy
	equal(wantClone, read(cloneID))
	var count int
	if err := tx.QueryRow(ctx, "SELECT count(*) FROM norm_versions WHERE framework_id=$1 AND status='draft'", removedFID).Scan(&count); err != nil || count != 0 {
		t.Fatalf("removed links created a draft: %d, %v", count, err)
	}
	var creator string
	if err := tx.QueryRow(ctx, "SELECT created_by FROM norm_versions WHERE id=$1", cloneID).Scan(&creator); err != nil || creator != u {
		t.Fatalf("clone lost its original author: %s, %v", creator, err)
	}
	// Re-running must not increment revisions, duplicate instructions, or add versions.
	exec(string(sql))
	equal(draft, read(draft.ID))
	equal(wantClone, read(cloneID))
	if err := tx.QueryRow(ctx, "SELECT count(*) FROM norm_versions").Scan(&count); err != nil || count != 9 {
		t.Fatalf("unexpected version count after rerun: %d, %v", count, err)
	}
	var preserved string
	if err := tx.QueryRow(ctx, "SELECT ai_guidance FROM room_elements WHERE id=$1", unlinkedID).Scan(&preserved); err != nil || preserved != "UNLINKED_HISTORY" {
		t.Fatalf("unlinked history was lost: %q, %v", preserved, err)
	}
	if err := tx.QueryRow(ctx, "SELECT ai_guidance FROM room_elements WHERE id=$1", elementID).Scan(&preserved); err != nil || preserved != legacy {
		t.Fatalf("original linked history was lost: %q, %v", preserved, err)
	}
	newOrg := id()
	exec("INSERT INTO organisations(id,slug,name) VALUES($1,$2,'New organisation')", newOrg, newOrg)
	if err := tx.QueryRow(ctx, "SELECT count(*) FROM room_elements WHERE org_id=$1 AND ai_guidance=''", newOrg).Scan(&count); err != nil || count != 8 {
		t.Fatalf("starter elements contain instructions or are missing: %d, %v", count, err)
	}
	contextJSON, err := elementContext(ctx, tx, newOrg)
	if err != nil || bytes.Contains(contextJSON, []byte("aiGuidance")) {
		t.Fatalf("element context contains evaluation instructions: %s, %v", contextJSON, err)
	}
}

func TestNormGuidanceLength(t *testing.T) {
	rules, _ := baselineNorms()
	doc := normDocument{Name: "Guidance limits", Rules: rules[:1]}
	doc.Rules[0].AIGuidance = strings.Repeat("A", 6500)
	if err := validateNorms(doc, true); err != nil {
		t.Fatal(err)
	}
	doc.Rules[0].AIGuidance += "A"
	if err := validateNorms(doc, false); err == nil {
		t.Fatal("oversized AI instructions accepted")
	}
	doc.Rules[0].AIGuidance = "Valid instructions"
	doc.Rules[0].Acceptable = strings.Repeat("A", 3001)
	if err := validateNorms(doc, false); err == nil {
		t.Fatal("acceptance criteria limit was expanded")
	}
}
