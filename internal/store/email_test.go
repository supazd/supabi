package store

import (
	"context"
	"errors"
	"testing"
)

// Saving keeps the password unless told otherwise; an organization that
// never saved has email off, encrypted with STARTTLS.
func TestEmailSettings(t *testing.T) {
	pool := migrated(t)
	ctx := context.Background()
	sc := Scope{OrgID: DefaultOrgID}
	if got, err := GetEmailSettings(ctx, pool, DefaultOrgID); err != nil || got.Security != "starttls" || got.Host != "" || got.Password != nil {
		t.Fatalf("without a row: %+v, %v", got, err)
	}
	key := box(t)
	full := EmailSettings{Host: "smtp.example.com", Port: 2525, Security: "tls", Username: "bi", Password: key.Seal("pw"),
		FromAddress: "bi@example.com", FromName: "Reports"}
	if err := SetEmailSettings(ctx, pool, sc, full, false); err != nil {
		t.Fatal(err)
	}
	got, err := GetEmailSettings(ctx, pool, DefaultOrgID)
	if err != nil || got.Host != full.Host || got.Port != 2525 || got.Security != "tls" || got.Username != "bi" || got.FromAddress != full.FromAddress || got.FromName != "Reports" {
		t.Fatalf("saved: %+v, %v", got, err)
	}
	if pw, err := key.Open(got.Password); err != nil || pw != "pw" {
		t.Errorf("password: %q, %v", pw, err)
	}

	// Empty values are stored as unset, and the password stays.
	changed := EmailSettings{Host: "mail.example.com", Security: "starttls", Username: "bi", FromAddress: "bi@example.com"}
	if err := SetEmailSettings(ctx, pool, sc, changed, true); err != nil {
		t.Fatal(err)
	}
	got, err = GetEmailSettings(ctx, pool, DefaultOrgID)
	if err != nil || got.Host != "mail.example.com" || got.Port != 0 || got.FromName != "" || got.Password == nil {
		t.Errorf("kept the password: %+v, %v", got, err)
	}
	if err := SetEmailSettings(ctx, pool, sc, changed, false); err != nil {
		t.Fatal(err)
	}
	if got, err = GetEmailSettings(ctx, pool, DefaultOrgID); err != nil || got.Password != nil {
		t.Errorf("removed the password: %+v, %v", got, err)
	}

	for name, wrong := range map[string]EmailSettings{
		"port":                     {Host: "h", Port: 70000, Security: "none"},
		"security":                 {Host: "h", Security: "ssl"},
		"password without a login": {Host: "h", Security: "tls", Password: key.Seal("pw")},
	} {
		if err := SetEmailSettings(ctx, pool, sc, wrong, false); err == nil {
			t.Errorf("%s: stored %+v", name, wrong)
		}
	}
}

// The email password is a secret like the others: the check reads it, and
// clearing the secrets removes it.
func TestEmailPasswordIsASecret(t *testing.T) {
	pool := migrated(t)
	ctx := context.Background()
	first, other := box(t), box(t)
	if err := SetEmailSettings(ctx, pool, Scope{OrgID: DefaultOrgID}, EmailSettings{Host: "h", Security: "tls", Username: "u", Password: first.Seal("pw"), FromAddress: "a@example.com"}, false); err != nil {
		t.Fatal(err)
	}
	if err := CheckSecretKey(ctx, pool, other); !errors.Is(err, ErrWrongSecretKey) {
		t.Errorf("another key than the email password's: %v", err)
	}
	if n, err := CountSecrets(ctx, pool); err != nil || n != (StoredSecrets{EmailServers: 1}) {
		t.Errorf("count: %+v, %v", n, err)
	}
	if n, err := ClearSecrets(ctx, pool); err != nil || n != (StoredSecrets{EmailServers: 1}) {
		t.Fatalf("clear: %+v, %v", n, err)
	}
	got, err := GetEmailSettings(ctx, pool, DefaultOrgID)
	if err != nil || got.Password != nil || got.Username != "u" || got.Host != "h" {
		t.Errorf("after clearing, the settings stay without the password: %+v, %v", got, err)
	}
	if err := CheckSecretKey(ctx, pool, other); err != nil {
		t.Errorf("a new key after clearing: %v", err)
	}
}
