# Backup, restoration and secret recovery

Target a daily paired database/object backup, at most 24 hours of data loss, and restoration within four hours. Test representative data and network bandwidth before launch.

## Daily off-host backup

Install restic on the Linux host and initialize a separate off-host repository. Set `RESTIC_REPOSITORY`, `RESTIC_PASSWORD_FILE`, and a verified `BACKUP_HELPER_IMAGE` Alpine digest in `/etc/satvey/backup.env` (mode 600). Use separate repository credentials and keep a recovery copy of the password and encryption keys outside the host.

Run `bash scripts/backup.sh`. It pauses the API/workers, dumps PostgreSQL, stops RustFS and archives its volume, then resumes services before uploading. The encrypted snapshot includes deployment configuration and a timestamp/revision manifest. The script attempts to resume services on failure, retains 30 daily snapshots independently of temporary paths, and checks repository integrity.

Install `infra/satvey-backup.service` and `.timer` under systemd, adjusting `/opt/satvey-inspect` if needed. The timer runs at 02:00 UTC and catches missed runs after reboot. Alert on failure or a newest snapshot older than 24 hours. Reserve staging capacity above the current dump plus object volume size.

## Restore drill

Supply restic credentials and `BACKUP_HELPER_IMAGE` on the replacement/drill host. Set a new `RESTORE_PROJECT` beginning `satvey-restore-`, then run `bash scripts/restore.sh SNAPSHOT_ID` (or `latest`).

The script refuses existing volumes. It restores the pair into a separate project/subnet, saves protected recovered configuration under `/etc/satvey/restores`, starts only PostgreSQL/RustFS/PDF, restores PostgreSQL with errors fatal, applies migrations, and runs `verify-restore`. Verification downloads up to 100 recent evidence objects, checks lengths and SHA-256 hashes, and renders a frozen report. No public listeners, application workers, SMTP deliveries or AI calls start. The four-hour time gate is enforced.

An empty installation can explicitly use `VERIFY_ALLOW_EMPTY=true`; this does not satisfy report/media checks for a populated installation. Inspect older photo/audio samples and annotation/signature rendering as well. Record snapshot ID, data age, checks and elapsed time in release evidence.

After a drill, remove only its explicitly named project/volumes with its recovered environment file. For actual recovery, verify privately, update public origin/network settings, then start API/web/edge after isolating the old host. Preserve original volumes until validation is complete.

## Encryption keys

`APP_ENCRYPTION_KEY` protects SSO secrets and queued mail; `PROPERTY_ENCRYPTION_KEY` retains VERA's existing purpose-bound format. A database backup alone cannot recover secrets. Keep every key needed by retained snapshots.

For application-key rotation, pause the API, back up data/configuration, generate a new 32-byte base64 key, and run `rotate-secrets` with old `APP_ENCRYPTION_KEY` and new `APP_ENCRYPTION_KEY_NEW`. Conversion is atomic. Update the protected environment before restarting. On failure keep the old key; the transaction rolls back. Retain keys with corresponding backups. Property-key rotation is separate: re-enter/re-encrypt source credentials during maintenance and keep the prior key for backups.

Password recovery emails a one-hour, single-use link and revokes all sessions after reset. SSO-only accounts recover through their identity provider. Repair SMTP and resend failed invitations; never copy token hashes or encrypted payloads into logs.
