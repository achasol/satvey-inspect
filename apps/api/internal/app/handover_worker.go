package app

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"time"

	"satvey/inspect/internal/handover"
	"satvey/inspect/internal/veradelivery"

	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/smithy-go"
	"github.com/jackc/pgx/v5"
)

func (a *app) handoverWorker(ctx context.Context) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if e := a.processHandoverDelivery(ctx); e != nil && ctx.Err() == nil {
				slog.Error("VERA delivery worker retained job")
			}
		}
	}
}

func (a *app) processHandoverDelivery(parent context.Context) error {
	ctx, cancel := context.WithTimeout(parent, 4*time.Minute)
	defer cancel()
	run := id()
	var delivery, org, inspection, destination string
	var revision, attempts int
	var raw, snapshot []byte
	e := a.db.QueryRow(ctx, `UPDATE handover_deliveries SET status='processing',run_token=$1,lease_until=now()+interval '5 minutes',attempts=attempts+1
 WHERE id=(SELECT id FROM handover_deliveries WHERE ($2::uuid IS NULL OR org_id=$2)
 AND ((status IN ('queued','retrying') AND next_attempt_at<=now()) OR (status='processing' AND lease_until<now()))
 ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
 RETURNING id,org_id,inspection_id,destination_id,destination_revision,attempts,snapshot,report_snapshot`, run, nullableID(a.workerOrg)).Scan(&delivery, &org, &inspection, &destination, &revision, &attempts, &raw, &snapshot)
	if errors.Is(e, pgx.ErrNoRows) {
		return nil
	}
	if e != nil {
		return e
	}
	// A session advisory lock also excludes deletion and artifact generation for
	// this inspection. No database transaction stays open during external I/O.
	conn, e := a.db.Acquire(ctx)
	if e != nil {
		return e
	}
	defer conn.Release()
	var locked bool
	if e = conn.QueryRow(ctx, `SELECT pg_try_advisory_lock(hashtextextended($1,0))`, "vera-inspection:"+inspection).Scan(&locked); e != nil {
		return e
	}
	if !locked {
		_, e = a.db.Exec(ctx, `UPDATE handover_deliveries SET status='retrying',next_attempt_at=now()+interval '5 seconds',run_token=NULL,lease_until=NULL,attempts=attempts-1 WHERE id=$1 AND run_token=$2`, delivery, run)
		return e
	}
	defer func() {
		unlockCtx, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		if _, e := conn.Exec(unlockCtx, `SELECT pg_advisory_unlock(hashtextextended($1,0))`, "vera-inspection:"+inspection); e != nil {
			_ = conn.Conn().Close(unlockCtx)
		}
	}()
	var bundle handover.Bundle
	workError := json.Unmarshal(raw, &bundle)
	d, e := readHandoverDestination(ctx, a.db, org, destination)
	if workError == nil {
		workError = e
	}
	var client *veradelivery.Client
	if workError == nil {
		client, workError = a.newHandoverClient(ctx, org, d)
	}
	check := func() error {
		var current bool
		e := a.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM handover_deliveries j JOIN handover_destinations d ON d.id=j.destination_id AND d.org_id=j.org_id WHERE j.id=$1 AND j.run_token=$2 AND j.status='processing' AND j.lease_until>now() AND d.enabled AND d.revision=j.destination_revision)`, delivery, run).Scan(&current)
		if e != nil {
			return e
		}
		if !current {
			return &veradelivery.Error{Message: "De bestemming is gewijzigd of uitgeschakeld. Controleer de instellingen en probeer opnieuw."}
		}
		return nil
	}
	if workError == nil {
		if d.Revision != revision {
			workError = &veradelivery.Error{Message: "De VERA-instellingen zijn gewijzigd; controleer de koppeling en probeer opnieuw"}
		} else {
			workError = check()
		}
	}
	if workError == nil {
		client.Reference = delivery
		client.BeforeRequest = check
		var blobs []veradelivery.Blob
		blobs, workError = a.handoverDeliveryArtifacts(ctx, org, inspection, snapshot, bundle, check)
		if workError == nil {
			workError = client.Transfer(ctx, bundle, blobs, func(receipt veradelivery.Receipt) error {
				if e := check(); e != nil {
					return e
				}
				tag, e := a.db.Exec(ctx, `INSERT INTO handover_delivery_items(delivery_id,org_id,item_key,receiver_id,resource_uri) SELECT id,org_id,$3,$4,$5 FROM handover_deliveries WHERE id=$1 AND run_token=$2 AND lease_until>now()
    ON CONFLICT(delivery_id,item_key) DO UPDATE SET receiver_id=EXCLUDED.receiver_id,resource_uri=EXCLUDED.resource_uri`, delivery, run, receipt.Key, receipt.ReceiverID, receipt.URI)
				if e == nil && tag.RowsAffected() != 1 {
					return fmt.Errorf("delivery lease revoked")
				}
				return e
			})
		}
	}
	finishCtx, stop := context.WithTimeout(context.Background(), 10*time.Second)
	defer stop()
	if workError == nil {
		_, e = a.db.Exec(finishCtx, `UPDATE handover_deliveries SET status='accepted',accepted_at=now(),last_error='',run_token=NULL,lease_until=NULL WHERE id=$1 AND run_token=$2 AND lease_until>now()`, delivery, run)
		return e
	}
	message := "De overdracht kon niet worden verwerkt; controleer de koppeling en probeer opnieuw"
	status := "blocked"
	delay := time.Minute
	var remote *veradelivery.Error
	var api *apiError
	if errors.As(workError, &remote) {
		message = remote.Message
		if remote.Temporary && attempts <= 5 {
			status = "retrying"
			delay = []time.Duration{time.Minute, 5 * time.Minute, 15 * time.Minute, time.Hour, 4 * time.Hour}[attempts-1]
			if remote.RetryAfter > delay {
				delay = remote.RetryAfter
			}
		}
	} else if errors.As(workError, &api) {
		message = api.Message
		if api.Status >= 500 && attempts <= 5 {
			status = "retrying"
			delay = []time.Duration{time.Minute, 5 * time.Minute, 15 * time.Minute, time.Hour, 4 * time.Hour}[attempts-1]
		}
	} else if (ctx.Err() != nil || parent.Err() != nil) && attempts <= 5 {
		status = "retrying"
		message = "Verwerking onderbroken; reeds ontvangen onderdelen blijven bewaard"
	}
	_, e = a.db.Exec(finishCtx, `UPDATE handover_deliveries SET status=$3,last_error=$4,next_attempt_at=now()+make_interval(secs=>$5),run_token=NULL,lease_until=NULL WHERE id=$1 AND run_token=$2`, delivery, run, status, message, int(delay.Seconds()))
	if e == nil {
		slog.Info("VERA handover awaiting action", "delivery_id", delivery, "org_id", org, "status", status, "attempt", attempts)
	}
	return e
}

func (a *app) handoverDeliveryArtifacts(ctx context.Context, org, inspection string, snapshot []byte, bundle handover.Bundle, check func() error) ([]veradelivery.Blob, error) {
	// The first materialised archive is the immutable private byte cache. Later
	// revisions use its evidence bytes and project their own current proposals.
	key := org + "/handover/" + inspection + "/evidence.zip"
	file, e := os.CreateTemp("", "satvey-vera-evidence-*.zip")
	if e != nil {
		return nil, e
	}
	defer func() { file.Close(); os.Remove(file.Name()) }()
	object, e := a.storage.GetObject(ctx, &s3.GetObjectInput{Bucket: &a.bucket, Key: &key})
	if e == nil {
		count, copyError := io.Copy(file, io.LimitReader(object.Body, (160<<20)+1))
		object.Body.Close()
		if copyError != nil || count > 160<<20 {
			return nil, fail(503, "De opgeslagen rapportbijlagen konden niet volledig worden gelezen")
		}
	} else {
		var storageError smithy.APIError
		if !errors.As(e, &storageError) || (storageError.ErrorCode() != "NoSuchKey" && storageError.ErrorCode() != "NotFound") {
			return nil, fail(503, "Rapportbijlagen zijn tijdelijk niet beschikbaar")
		}
		var materialised bool
		if e = a.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM handover_artifacts WHERE org_id=$1 AND inspection_id=$2 AND ready)`, org, inspection).Scan(&materialised); e != nil {
			return nil, e
		}
		if materialised {
			return nil, fail(422, "De vastgelegde rapportbijlagen ontbreken in de opslag; herstel de oorspronkelijke bestanden voordat je opnieuw verzendt")
		}
		var received bool
		if e = a.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM handover_delivery_items i JOIN handover_deliveries d ON d.id=i.delivery_id AND d.org_id=i.org_id WHERE d.org_id=$1 AND d.inspection_id=$2)`, org, inspection).Scan(&received); e != nil {
			return nil, e
		}
		if received {
			return nil, fail(422, "De eerder verzonden rapportbijlagen ontbreken in de opslag; herstel deze voordat je opnieuw verzendt")
		}
		generated, e := a.handoverArchive(ctx, org, snapshot, bundle)
		if e != nil {
			return nil, e
		}
		defer func() { generated.Close(); os.Remove(generated.Name()) }()
		if _, e = io.Copy(file, generated); e != nil {
			return nil, e
		}
		if e = check(); e != nil {
			return nil, e
		}
		// Register before uploading: deletion can always clean up an interrupted put.
		stat, e := file.Stat()
		if e != nil {
			return nil, e
		}
		if _, e = file.Seek(0, 0); e != nil {
			return nil, e
		}
		digest := sha256.New()
		if _, e = io.Copy(digest, file); e != nil {
			return nil, e
		}
		_, e = a.db.Exec(ctx, `INSERT INTO handover_artifacts(org_id,inspection_id,path,object_key,sha256,bytes) VALUES($1,$2,'evidence.zip',$3,$4,$5) ON CONFLICT(inspection_id,path) DO UPDATE SET sha256=EXCLUDED.sha256,bytes=EXCLUDED.bytes`, org, inspection, key, hex.EncodeToString(digest.Sum(nil)), stat.Size())
		if e != nil {
			return nil, e
		}
		if _, e = file.Seek(0, 0); e != nil {
			return nil, e
		}
		contentType := "application/zip"
		if _, e = a.storage.PutObject(ctx, &s3.PutObjectInput{Bucket: &a.bucket, Key: &key, Body: file, ContentType: &contentType}); e != nil {
			return nil, fail(503, "Rapportbijlagen konden niet duurzaam worden opgeslagen")
		}
	}
	stat, e := file.Stat()
	if e != nil {
		return nil, e
	}
	var expectedHash string
	var expectedSize int64
	if e = a.db.QueryRow(ctx, `SELECT sha256,bytes FROM handover_artifacts WHERE org_id=$1 AND inspection_id=$2 AND path='evidence.zip'`, org, inspection).Scan(&expectedHash, &expectedSize); e != nil {
		return nil, fail(422, "De vastgelegde bestandscontrole van de rapportbijlagen ontbreekt")
	}
	if _, e = file.Seek(0, 0); e != nil {
		return nil, e
	}
	digest := sha256.New()
	if _, e = io.Copy(digest, file); e != nil {
		return nil, e
	}
	if expectedSize != stat.Size() || expectedHash != hex.EncodeToString(digest.Sum(nil)) {
		return nil, fail(422, "De opgeslagen rapportbijlagen wijken af van hun vastgelegde bestandscontrole")
	}
	if e = check(); e != nil {
		return nil, e
	}
	if _, e = a.db.Exec(ctx, `UPDATE handover_artifacts SET ready=true WHERE org_id=$1 AND inspection_id=$2 AND path='evidence.zip'`, org, inspection); e != nil {
		return nil, e
	}
	z, e := zip.NewReader(file, stat.Size())
	if e != nil {
		return nil, fail(422, "De opgeslagen rapportbijlagen zijn beschadigd")
	}
	wanted := map[string]bool{}
	for _, attachment := range bundle.Attachments {
		wanted[attachment.Path] = true
	}
	result := []veradelivery.Blob{}
	for _, entry := range z.File {
		if !wanted[entry.Name] {
			continue
		}
		if entry.UncompressedSize64 > veradelivery.MaxRecordBytes*3/4 {
			return nil, fail(422, "Een rapportbijlage is te groot voor het VERA-overdrachtsprofiel")
		}
		reader, e := entry.Open()
		if e != nil {
			return nil, e
		}
		data, e := io.ReadAll(io.LimitReader(reader, veradelivery.MaxRecordBytes))
		reader.Close()
		if e != nil {
			return nil, e
		}
		result = append(result, veradelivery.Blob{Path: entry.Name, Data: data})
		delete(wanted, entry.Name)
	}
	if len(wanted) > 0 {
		return nil, fail(422, "Er ontbreken vastgelegde rapportbijlagen")
	}
	return result, nil
}
