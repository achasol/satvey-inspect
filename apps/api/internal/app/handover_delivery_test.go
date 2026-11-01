package app

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"reflect"
	"strings"
	"testing"

	"github.com/aws/aws-sdk-go-v2/service/s3"
	"satvey/inspect/internal/handover"
)

func destinationFixture(f *fixture, c *veraTestClient) string {
	f.t.Helper()
	destination := id()
	body := map[string]any{"id": destination, "name": "VERA test receiver", "enabled": true, "revision": 0, "onderhoudUrl": c.base + "/onderhoud/v4", "dossierUrl": c.base + "/dossier/v4", "vastgoedUrl": c.base + "/vastgoed/v4", "tokenUrl": c.base + "/oauth/token", "clientId": "satvey-test", "secret": "dummy-client-secret-only-for-tests", "scopes": "", "organisation": f.org, "administration": "SATVEY", "reportTypeCode": "", "maintenanceTypeCode": ""}
	result := f.request("PUT", "/orgs/"+f.org+"/handover-destinations", body, 200)
	if result["revision"] != float64(1) || result["secretConfigured"] != true || strings.Contains(string(mustVERATestJSON(result)), "dummy-client-secret") {
		f.t.Fatal("destination exposed credentials or lost its version")
	}
	f.request("POST", "/orgs/"+f.org+"/handover-destinations/"+destination+"/test", map[string]any{}, 200)
	return destination
}

func deliveryDraftFixture(f *fixture, c *veraTestClient) (string, string, handover.Draft) {
	f.t.Helper()
	path, _ := handoverFixture(f)
	detail := f.request("GET", path+"/handover", nil, 200)
	destination := destinationFixture(f, c)
	property := detail["report"].(map[string]any)["property"].(map[string]any)
	unit := "unit-" + f.org
	c.call("POST", "/_test/seed", map[string]any{"resource": "/vastgoed/v4/eenheden", "record": map[string]any{"id": unit, "code": "42"}}, 201)
	f.request("PUT", "/orgs/"+f.org+"/handover-destinations/"+destination+"/properties", map[string]any{"propertyId": property["id"], "unitUri": c.base + "/vastgoed/v4/eenheden/" + unit}, 200)
	source := detail["report"].(map[string]any)["sources"].([]any)[0].(map[string]any)["key"].(string)
	draft := handover.Draft{DestinationID: destination, Destination: "VERA test receiver", Proposals: []handover.Proposal{{ID: id(), SourceKeys: []string{source}, Description: "Herstel de kraan", Location: "Badkamer", Urgency: "soon"}}}
	f.request("PUT", path+"/handover", draft, 200)
	draft.Version = 1
	return path, destination, draft
}

func deliveryStatus(f *fixture, path string) map[string]any {
	f.t.Helper()
	data := f.request("GET", path+"/handover", nil, 200)
	return data["deliveries"].([]any)[0].(map[string]any)
}
func runDelivery(f *fixture) {
	f.t.Helper()
	if e := f.a.processHandoverDelivery(context.Background()); e != nil {
		f.t.Fatal(e)
	}
}
func dueDelivery(f *fixture, delivery string) {
	f.t.Helper()
	if _, e := f.a.db.Exec(context.Background(), "UPDATE handover_deliveries SET next_attempt_at=now() WHERE id=$1 AND org_id=$2", delivery, f.org); e != nil {
		f.t.Fatal(e)
	}
}

func TestHandoverProductionWorkerRecoveryAndAcceptance(t *testing.T) {
	c := receiverFixture(t)
	c.call("DELETE", "/_test/state", nil, 204)
	t.Cleanup(func() { c.call("DELETE", "/_test/state", nil, 204) })
	f := setup(t)
	path, destination, draft := deliveryDraftFixture(f, c)
	original := f.request("GET", path+"/report", nil, 200)
	delivery := id()
	approve := map[string]any{"id": delivery, "version": 1, "destinationId": destination}
	f.request("POST", path+"/handover/approve", approve, 202)
	if result := f.request("POST", path+"/handover/approve", approve, 202); result["id"] != delivery {
		t.Fatal("approval duplicated")
	}
	if result := f.request("POST", path+"/handover/approve", map[string]any{"id": id(), "version": 1, "destinationId": destination}, 202); result["id"] != delivery {
		t.Fatal("concurrent approval duplicated a revision")
	}
	c.call("POST", "/_test/faults", map[string]any{"method": "POST", "path": "/dossier/v4/informatieobjecten", "mode": "after_commit", "status": 503, "count": 1}, 201)
	runDelivery(f)
	if state := deliveryStatus(f, path); state["status"] != "retrying" || state["acceptedAt"] != nil {
		t.Fatalf("false acceptance after acknowledgement loss: %v", state)
	}
	var artifactKey, artifactHash string
	if e := f.a.db.QueryRow(context.Background(), `SELECT object_key,sha256 FROM handover_artifacts WHERE org_id=$1 AND ready`, f.org).Scan(&artifactKey, &artifactHash); e != nil {
		t.Fatal(e)
	}
	stored, e := f.a.storage.GetObject(context.Background(), &s3.GetObjectInput{Bucket: &f.a.bucket, Key: &artifactKey})
	if e != nil {
		t.Fatal(e)
	}
	evidence, e := io.ReadAll(stored.Body)
	stored.Body.Close()
	if e != nil {
		t.Fatal(e)
	}
	if _, e = f.a.storage.DeleteObject(context.Background(), &s3.DeleteObjectInput{Bucket: &f.a.bucket, Key: &artifactKey}); e != nil {
		t.Fatal(e)
	}
	dueDelivery(f, delivery)
	runDelivery(f)
	if deliveryStatus(f, path)["status"] != "blocked" {
		t.Fatal("regenerated materialised evidence after an uncertain acknowledgement")
	}
	var unchangedHash string
	if e = f.a.db.QueryRow(context.Background(), `SELECT sha256 FROM handover_artifacts WHERE org_id=$1`, f.org).Scan(&unchangedHash); e != nil || unchangedHash != artifactHash {
		t.Fatal("lost the original evidence checksum")
	}
	if _, e = f.a.storage.PutObject(context.Background(), &s3.PutObjectInput{Bucket: &f.a.bucket, Key: &artifactKey, Body: bytes.NewReader(evidence)}); e != nil {
		t.Fatal(e)
	}
	f.request("POST", path+"/handovers/"+delivery+"/retry", map[string]any{}, 202)
	c.call("POST", "/_test/faults", map[string]any{"method": "POST", "path": "/onderhoud/v4/onderhoudstaken", "mode": "after_commit", "status": 503, "count": 1}, 201)
	if _, e := f.a.db.Exec(context.Background(), `UPDATE handover_deliveries SET status='processing',run_token=$2,lease_until=now()-interval '1 second' WHERE id=$1`, delivery, id()); e != nil {
		t.Fatal(e)
	}
	dueDelivery(f, delivery)
	runDelivery(f)
	state := deliveryStatus(f, path)
	if state["status"] != "retrying" || state["acceptedCount"].(float64) < 4 {
		t.Fatalf("partial progress lost: %v", state)
	}
	dueDelivery(f, delivery)
	runDelivery(f)
	state = deliveryStatus(f, path)
	if state["status"] != "accepted" || state["acceptedAt"] == nil || state["acceptedCount"] != float64(7) {
		t.Fatalf("handover not fully accepted: %v", state)
	}
	raw, _, _ := c.call("GET", "/_test/state", nil, 200)
	var receiver map[string]any
	_ = json.Unmarshal(raw, &receiver)
	counts := receiver["counts"].(map[string]any)
	archive, e := zip.NewReader(bytes.NewReader(evidence), int64(len(evidence)))
	if e != nil {
		t.Fatal(e)
	}
	hashes := map[string]string{}
	for _, entry := range archive.File {
		if entry.Name == "report.pdf" || strings.HasPrefix(entry.Name, "photos/") {
			reader, e := entry.Open()
			if e != nil {
				t.Fatal(e)
			}
			raw, e := io.ReadAll(reader)
			reader.Close()
			if e != nil {
				t.Fatal(e)
			}
			sum := sha256.Sum256(raw)
			hashes[entry.Name] = hex.EncodeToString(sum[:])
		}
	}
	for _, item := range receiver["records"].(map[string]any)["/dossier/v4/informatieobjecten"].([]any) {
		row := item.(map[string]any)
		if row["_testFile"].(map[string]any)["sha256"] != hashes[row["bestandsnaam"].(string)] {
			t.Fatal("receiver evidence differs from the materialised report")
		}
	}
	for resource, count := range map[string]float64{"/dossier/v4/informatieobjecten": 3, "/onderhoud/v4/inspectierapporten": 1, "/onderhoud/v4/defecten": 1, "/onderhoud/v4/onderhoudstaken": 1, "/onderhoud/v4/onderhoudsverzoeken": 1} {
		if counts[resource] != count {
			t.Fatalf("%s duplicate/missing records: %v", resource, counts[resource])
		}
	}
	if bytes := receiver["records"].(map[string]any)["/dossier/v4/informatieobjecten"].([]any); len(bytes) != 3 {
		t.Fatal("evidence missing")
	}
	// Retrying an already accepted delivery cannot enqueue or repeat its writes.
	f.request("POST", path+"/handovers/"+delivery+"/retry", map[string]any{}, 202)
	runDelivery(f)
	after, _, _ := c.call("GET", "/_test/state", nil, 200)
	var again map[string]any
	_ = json.Unmarshal(after, &again)
	if !reflect.DeepEqual(receiver["receipts"], again["receipts"]) {
		t.Fatal("accepted delivery was sent again")
	}
	if !reflect.DeepEqual(original, f.request("GET", path+"/report", nil, 200)) {
		t.Fatal("delivery mutated signed report")
	}
	changed := draft
	changed.Proposals = append([]handover.Proposal{}, draft.Proposals...)
	changed.Proposals[0].Description = "Wijzig ontvangen werk"
	f.request("PUT", path+"/handover", changed, 409)
	draft.Proposals = append(draft.Proposals, handover.Proposal{ID: id(), SourceKeys: draft.Proposals[0].SourceKeys, Description: "Controleer de aansluiting na herstel", Location: "Badkamer", Urgency: "routine"})
	f.request("PUT", path+"/handover", draft, 200)
	followup := id()
	f.request("POST", path+"/handover/approve", map[string]any{"id": followup, "version": 2, "destinationId": destination}, 202)
	runDelivery(f)
	if deliveryStatus(f, path)["status"] != "accepted" {
		t.Fatal("additional proposal did not deliver")
	}
	raw, _, _ = c.call("GET", "/_test/state", nil, 200)
	_ = json.Unmarshal(raw, &again)
	counts = again["counts"].(map[string]any)
	if counts["/onderhoud/v4/onderhoudsverzoeken"] != float64(1) || counts["/onderhoud/v4/onderhoudstaken"] != float64(2) || counts["/dossier/v4/informatieobjecten"] != float64(3) {
		t.Fatal("follow-up duplicated existing work, requests or documents")
	}
	var artifacts int
	if e := f.a.db.QueryRow(context.Background(), `SELECT count(*) FROM handover_artifacts WHERE org_id=$1 AND inspection_id=$2`, f.org, strings.TrimPrefix(path, "/orgs/"+f.org+"/inspections/")).Scan(&artifacts); e != nil || artifacts != 1 {
		t.Fatalf("artifact cache not retained: %d %v", artifacts, e)
	}
	dossier := f.request("GET", path, nil, 200)
	version := int(dossier["inspection"].(map[string]any)["revision"].(float64))
	f.request("POST", path+"/archive", map[string]any{"reason": "Test", "version": version}, 200)
	// A worker's advisory lock prevents deleting an inspection mid-delivery.
	conn, e := f.a.db.Acquire(context.Background())
	if e != nil {
		t.Fatal(e)
	}
	inspection := strings.Split(path, "/")[4]
	if _, e = conn.Exec(context.Background(), `SELECT pg_advisory_lock(hashtextextended($1,0))`, "vera-inspection:"+inspection); e != nil {
		t.Fatal(e)
	}
	f.request("DELETE", path+"/purge", map[string]any{"reason": "Test", "version": version + 1}, 409)
	_, _ = conn.Exec(context.Background(), `SELECT pg_advisory_unlock(hashtextextended($1,0))`, "vera-inspection:"+inspection)
	conn.Release()
	f.request("DELETE", path+"/purge", map[string]any{"reason": "Test", "version": version + 1}, 204)
	f.request("GET", path+"/handover", nil, 404)
	var remaining int
	if e = f.a.db.QueryRow(context.Background(), `SELECT count(*) FROM handover_deliveries WHERE org_id=$1`, f.org).Scan(&remaining); e != nil || remaining != 0 {
		t.Fatal("delivery data survived deletion")
	}
	t.Log("Production worker delivered 3 evidence documents and the maintenance graph; two lost acknowledgements reconciled, follow-up reused receiver identities")
}

func TestHandoverDestinationPermissionsAndConfigurationChanges(t *testing.T) {
	c := receiverFixture(t)
	c.call("DELETE", "/_test/state", nil, 204)
	t.Cleanup(func() { c.call("DELETE", "/_test/state", nil, 204) })
	f := setup(t)
	outsider := setup(t)
	path, destination, draft := deliveryDraftFixture(f, c)
	root := "/orgs/" + f.org + "/handover-destinations"
	outsider.request("GET", root, nil, 404)
	detail := f.request("GET", path+"/handover", nil, 200)
	property := detail["report"].(map[string]any)["property"].(map[string]any)
	f.request("PUT", root+"/"+destination+"/properties", map[string]any{"propertyId": property["id"], "unitUri": "https://other.example/vastgoed/v4/eenheden/42"}, 422)
	f.request("POST", path+"/handover/approve", map[string]any{"id": id(), "version": 0, "destinationId": destination}, 422)
	delivery := id()
	f.request("POST", path+"/handover/approve", map[string]any{"id": delivery, "version": draft.Version, "destinationId": destination}, 202)
	d, e := readHandoverDestination(context.Background(), f.a.db, f.org, destination)
	if e != nil {
		t.Fatal(e)
	}
	d.Enabled = false
	f.request("PUT", root, d, 200)
	runDelivery(f)
	if deliveryStatus(f, path)["status"] != "blocked" {
		t.Fatal("disabled destination was sent")
	}
	f.request("POST", path+"/handovers/"+delivery+"/retry", map[string]any{}, 422)
	d.Revision++
	d.Enabled = true
	d.OnderhoudURL = c.base + "/another-domain"
	f.request("PUT", root, d, 422)
	d.OnderhoudURL = c.base + "/onderhoud/v4"
	f.request("PUT", root, d, 200)
	f.request("POST", path+"/handovers/"+delivery+"/retry", map[string]any{}, 202)
	runDelivery(f)
	if deliveryStatus(f, path)["status"] != "accepted" {
		t.Fatal("re-enabled destination could not resume")
	}
	if _, e = f.a.db.Exec(context.Background(), `UPDATE memberships SET role='viewer' WHERE org_id=$1 AND user_id=$2`, f.org, f.uid); e != nil {
		t.Fatal(e)
	}
	f.request("POST", path+"/handover/approve", map[string]any{"id": id(), "version": 1, "destinationId": destination}, 403)
	f.request("PUT", root, d, 403)
	f.request("GET", path+"/handover", nil, 200)
	t.Log(fmt.Sprintf("Destination %s remained tenant-scoped and credential-safe", destination))
}
