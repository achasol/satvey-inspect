package app

import (
	"context"
	"errors"
	"net/http"
	"net/http/cookiejar"
	"strings"
	"testing"

	"satvey/inspect/internal/maildelivery"
	"satvey/inspect/internal/secrets"
)

func TestPasswordRecoveryIsSingleUseAndRevokesSessions(t *testing.T) {
	f := setup(t)
	var sent maildelivery.Message
	f.a.deliver = func(_ context.Context, m maildelivery.Message) error { sent = m; return nil }
	f.request("POST", "/auth/password/forgot", map[string]string{"email": f.email}, 202)
	var stored string
	if e := f.a.db.QueryRow(context.Background(), `SELECT payload FROM mail_jobs WHERE user_id=$1 AND purpose='password_reset'`, f.uid).Scan(&stored); e != nil {
		t.Fatal(e)
	}
	if strings.Contains(stored, f.email) || strings.Contains(stored, "token=") {
		t.Fatal("reset mail stored as plaintext")
	}
	if e := f.a.processMail(context.Background()); e != nil {
		t.Fatal(e)
	}
	parts := strings.Split(sent.Text, "#token=")
	if len(parts) != 2 {
		t.Fatal("no recovery link delivered")
	}
	raw := strings.Fields(parts[1])[0]
	f.request("POST", "/auth/password/reset", map[string]string{"token": raw, "password": "new-integration-password-2026"}, 200)
	f.request("GET", "/me", nil, 401)
	f.request("POST", "/auth/password/reset", map[string]string{"token": raw, "password": "another-integration-password-2026"}, 400)
	f.request("POST", "/auth/login", map[string]string{"email": f.email, "password": "new-integration-password-2026"}, 200)
	f.request("GET", "/me", nil, 200)
	var remaining int
	if e := f.a.db.QueryRow(context.Background(), `SELECT count(*) FROM password_resets WHERE user_id=$1`, f.uid).Scan(&remaining); e != nil || remaining != 0 {
		t.Fatal(remaining, e)
	}
}
func TestRecoveryDoesNotDiscloseUnknownAccountsAndExpires(t *testing.T) {
	f := setup(t)
	unknown := f.request("POST", "/auth/password/forgot", map[string]string{"email": "unknown@example.invalid"}, 202)
	known := f.request("POST", "/auth/password/forgot", map[string]string{"email": f.email}, 202)
	if unknown["ok"] != known["ok"] {
		t.Fatal("account existence disclosed")
	}
	raw := token()
	if _, e := f.a.db.Exec(context.Background(), `INSERT INTO password_resets(token_hash,user_id,expires_at) VALUES($1,$2,now()-interval '1 second')`, hash(raw), f.uid); e != nil {
		t.Fatal(e)
	}
	f.request("POST", "/auth/password/reset", map[string]string{"token": raw, "password": "new-integration-password-2026"}, 400)
}
func TestInvitationDeliveryAndResendRevokeOldLinks(t *testing.T) {
	f := setup(t)
	base := "/orgs/" + f.org
	email := id() + "@invite.invalid"
	var sent maildelivery.Message
	f.a.deliver = func(_ context.Context, m maildelivery.Message) error { sent = m; return nil }
	invite := f.request("POST", base+"/invitations", map[string]string{"email": email, "role": "inspector"}, 201)
	oldToken := strings.Split(invite["url"].(string), "token=")[1]
	resend := f.request("POST", base+"/invitations/"+invite["id"].(string)+"/resend", map[string]any{}, 200)
	f.request("GET", "/invitations/"+oldToken, nil, 404)
	newToken := strings.Split(resend["url"].(string), "token=")[1]
	f.request("GET", "/invitations/"+newToken, nil, 200)
	if e := f.a.processMail(context.Background()); e != nil {
		t.Fatal(e)
	}
	if sent.To != email || !strings.Contains(sent.Text, newToken) {
		t.Fatal("incorrect invitation mail")
	}
	jar, _ := cookiejar.New(nil)
	other := &http.Client{Jar: jar}
	request, _ := http.NewRequest("GET", f.server.URL+"/api/v1"+base+"/invitations", nil)
	res, e := other.Do(request)
	if e != nil {
		t.Fatal(e)
	}
	res.Body.Close()
	if res.StatusCode != 401 {
		t.Fatal("unauthenticated invitation listing")
	}
}
func TestMailFailuresAreBoundedAndRecoverAfterLeaseExpiry(t *testing.T) {
	f := setup(t)
	f.a.deliver = func(context.Context, maildelivery.Message) error { return errors.New("private SMTP diagnostic") }
	f.request("POST", "/orgs/"+f.org+"/invitations", map[string]string{"email": id() + "@invite.invalid", "role": "inspector"}, 201)
	for range 5 {
		if _, e := f.a.db.Exec(context.Background(), `UPDATE mail_jobs SET next_attempt_at=now() WHERE org_id=$1`, f.org); e != nil {
			t.Fatal(e)
		}
		if e := f.a.processMail(context.Background()); e != nil {
			t.Fatal(e)
		}
	}
	var status, message string
	var attempts int
	if e := f.a.db.QueryRow(context.Background(), `SELECT status,last_error,attempts FROM mail_jobs WHERE org_id=$1`, f.org).Scan(&status, &message, &attempts); e != nil {
		t.Fatal(e)
	}
	if status != "failed" || attempts != 5 || strings.Contains(message, "private") {
		t.Fatal(status, attempts, message)
	}
	if _, e := f.a.db.Exec(context.Background(), `UPDATE mail_jobs SET status='processing',attempts=0,lease_until=now()-interval '1 second' WHERE org_id=$1`, f.org); e != nil {
		t.Fatal(e)
	}
	f.a.deliver = func(context.Context, maildelivery.Message) error { return nil }
	if e := f.a.processMail(context.Background()); e != nil {
		t.Fatal(e)
	}
	if e := f.a.db.QueryRow(context.Background(), `SELECT status FROM mail_jobs WHERE org_id=$1`, f.org).Scan(&status); e != nil || status != "done" {
		t.Fatal(status, e)
	}
}
func TestSSOSecretConversionIsIdempotentAndRotationIsAtomic(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	if _, e := f.a.db.Exec(ctx, `UPDATE organisations SET oidc_client_secret='legacy-secret' WHERE id=$1`, f.org); e != nil {
		t.Fatal(e)
	}
	for range 2 {
		if e := f.a.convertSSOSecrets(ctx); e != nil {
			t.Fatal(e)
		}
	}
	var plain, encrypted string
	if e := f.a.db.QueryRow(ctx, `SELECT oidc_client_secret,oidc_client_secret_encrypted FROM organisations WHERE id=$1`, f.org).Scan(&plain, &encrypted); e != nil {
		t.Fatal(e)
	}
	if plain != "" {
		t.Fatal("plaintext retained")
	}
	decoded, e := secrets.Decrypt("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", "oidc:"+f.org, encrypted)
	if e != nil || decoded != "legacy-secret" {
		t.Fatal(e)
	}
	t.Setenv("APP_ENCRYPTION_KEY_NEW", "MTIzNDU2Nzg5MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTI=")
	if e = f.a.rotateSecrets(ctx); e != nil {
		t.Fatal(e)
	}
	if e = f.a.db.QueryRow(ctx, `SELECT oidc_client_secret_encrypted FROM organisations WHERE id=$1`, f.org).Scan(&encrypted); e != nil {
		t.Fatal(e)
	}
	if _, e = secrets.Decrypt("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", "oidc:"+f.org, encrypted); e == nil {
		t.Fatal("old key still decrypts rotated secret")
	}
}
func TestInspectionPaginationIsBoundedAndTenantScoped(t *testing.T) {
	f := setup(t)
	base := "/orgs/" + f.org
	f.inspection()
	f.request("GET", base+"/inspections?limit=101", nil, 400)
	f.request("GET", base+"/inspections?offset=-1", nil, 400)
	f.request("GET", base+"/inspections?limit=1&offset=0", nil, 200)
	f.request("GET", "/orgs/"+id()+"/inspections?limit=1", nil, 404)
}

func TestRequestsCannotBeReplayedUnderAnotherBrowserAccount(t *testing.T) {
	f := setup(t)
	request, _ := http.NewRequest("GET", f.server.URL+"/api/v1/orgs/"+f.org+"/inspections", nil)
	request.Header.Set("X-Satvey-User", id())
	response, e := f.client.Do(request)
	if e != nil {
		t.Fatal(e)
	}
	response.Body.Close()
	if response.StatusCode != 401 {
		t.Fatal("queued request accepted under a different account", response.StatusCode)
	}
	request.Header.Set("X-Satvey-User", f.uid)
	response, e = f.client.Do(request)
	if e != nil {
		t.Fatal(e)
	}
	response.Body.Close()
	if response.StatusCode != 200 {
		t.Fatal("matching account rejected", response.StatusCode)
	}
}
