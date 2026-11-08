package api

import (
	"encoding/json"
	"io"
	"mime"
	"mime/quotedprintable"
	netmail "net/mail"
	"strconv"
	"strings"
	"testing"

	"github.com/supazd/supabi/internal/mail/mailtest"
)

// System administrators set the server email goes through. The password
// never comes back, and the audit says only whether it changed.
func TestEmailSettings(t *testing.T) {
	admin := newClient(t)
	got := admin.expect("GET", "/system/email", nil, 200, "")
	defaults := got["defaults"].(map[string]any)
	ports := defaults["ports"].(map[string]any)
	if got["security"] != "starttls" || got["host"] != nil || got["hasPassword"] != false || defaults["fromName"] != "SupaBI" ||
		ports["starttls"] != float64(587) || ports["tls"] != float64(465) || ports["none"] != float64(25) {
		t.Errorf("a new installation: %v", got)
	}

	server := map[string]any{"security": "tls", "host": "smtp.example.com", "fromAddress": "bi@example.com"}
	with := func(changes map[string]any) map[string]any {
		out := map[string]any{}
		for k, v := range server {
			out[k] = v
		}
		for k, v := range changes {
			out[k] = v
		}
		return out
	}
	for _, c := range []struct {
		body map[string]any
		code string
	}{
		{with(map[string]any{"security": "ssl"}), "invalid_email_security"},
		{with(map[string]any{"host": "smtp://smtp.example.com"}), "invalid_email_host"},
		{with(map[string]any{"host": "smtp.example.com:587"}), "invalid_email_host"},
		{with(map[string]any{"port": 0}), "invalid_setting"},
		{with(map[string]any{"port": 65536}), "invalid_setting"},
		{with(map[string]any{"fromAddress": ""}), "email_from_required"},
		{with(map[string]any{"fromAddress": "SupaBI <bi@example.com>"}), "invalid_email_address"},
		{with(map[string]any{"fromName": "Reports\nBcc: x@example.com"}), "invalid_email_from_name"},
		{with(map[string]any{"fromName": strings.Repeat("长", 101)}), "invalid_email_from_name"},
		{with(map[string]any{"security": "none", "username": "bi", "password": "pw"}), "email_auth_unencrypted"},
		{with(map[string]any{"username": "bi"}), "email_password_required"},
	} {
		admin.expect("PUT", "/system/email", c.body, 400, c.code)
	}
	// Off, the other values may wait for a server.
	if off := admin.expect("PUT", "/system/email", map[string]any{"security": "starttls", "fromName": "Reports"}, 200, ""); off["host"] != nil || off["fromName"] != "Reports" {
		t.Errorf("off: %v", off)
	}

	saved := admin.expect("PUT", "/system/email", with(map[string]any{"port": 2525, "username": "bi", "password": "s3cret-pw", "fromName": "Reports", "host": " 10.0.0.5 "}), 200, "")
	if saved["host"] != "10.0.0.5" || saved["port"] != float64(2525) || saved["username"] != "bi" || saved["hasPassword"] != true || saved["password"] != nil {
		t.Errorf("saved: %v", saved)
	}
	// Left out, the password stays; a username alone is then enough.
	kept := admin.expect("PUT", "/system/email", with(map[string]any{"username": "bi2"}), 200, "")
	if kept["hasPassword"] != true || kept["port"] != nil || kept["fromName"] != nil {
		t.Errorf("kept: %v", kept)
	}
	// An empty password removes it, which a username cannot do without.
	admin.expect("PUT", "/system/email", with(map[string]any{"username": "bi2", "password": ""}), 400, "email_password_required")
	// Without a username, there is no password to keep.
	if cleared := admin.expect("PUT", "/system/email", server, 200, ""); cleared["hasPassword"] != false || cleared["username"] != nil {
		t.Errorf("cleared: %v", cleared)
	}

	events := auditEvents(t, admin, "?category=system")
	raw, _ := json.Marshal(events)
	if strings.Contains(string(raw), "s3cret-pw") {
		t.Error("the audit holds the password")
	}
	changed := func(e map[string]any) any { return detailOf(e)["passwordChanged"] }
	var updates []map[string]any
	for _, e := range events {
		if e["action"] == "email_settings.update" {
			updates = append(updates, e)
		}
	}
	// Newest first: cleared, kept, saved, off.
	if len(updates) != 4 || changed(updates[0]) != true || changed(updates[1]) != false || changed(updates[2]) != true || changed(updates[3]) != false {
		t.Fatalf("updates: %v", updates)
	}
	if before, after := detailOf(updates[1])["before"].(map[string]any), detailOf(updates[1])["after"].(map[string]any); before["username"] != "bi" || after["username"] != "bi2" || after["hasPassword"] != true {
		t.Errorf("detail: %v", detailOf(updates[1]))
	}

	admin.expect("POST", "/users", map[string]any{"email": "bo@example.com", "displayName": "Bo", "password": "member-password"}, 201, "")
	bo := admin.signedIn("bo@example.com", "member-password")
	bo.expect("GET", "/system/email", nil, 403, "")
	bo.expect("PUT", "/system/email", server, 403, "")
	bo.expect("POST", "/system/email/test", map[string]any{"settings": server, "to": "bo@example.com", "locale": "en-US"}, 403, "")
}

// A test sends with the settings in the form, without saving them, in the
// language of whoever sends it; a failure says where, in the server's words.
func TestTestEmail(t *testing.T) {
	admin := newClient(t)
	f := &mailtest.Server{}
	f.Start(t)
	settings := map[string]any{"host": "127.0.0.1", "port": f.Port, "security": "none", "fromAddress": "bi@example.com"}
	got := admin.expect("POST", "/system/email/test", map[string]any{"settings": settings, "to": "ann@example.com", "locale": "zh-CN"}, 200, "")
	if got["ok"] != true || got["stage"] != nil {
		t.Fatalf("test: %v", got)
	}
	m := f.Next(t)
	message, err := netmail.ReadMessage(strings.NewReader(m.Data))
	if err != nil {
		t.Fatal(err)
	}
	subject, _ := new(mime.WordDecoder).DecodeHeader(message.Header.Get("Subject"))
	body, _ := io.ReadAll(quotedprintable.NewReader(message.Body))
	sender, _ := message.Header.AddressList("From")
	server := "127.0.0.1:" + strconv.Itoa(f.Port)
	if m.From != "bi@example.com" || len(m.To) != 1 || m.To[0] != "ann@example.com" || subject != "SupaBI 测试邮件" ||
		!strings.Contains(string(body), "Admin（"+adminEmail+"）") || !strings.Contains(string(body), server+"，不加密") || len(sender) != 1 || sender[0].Name != "SupaBI" {
		t.Errorf("sent %q from %v: %s", subject, sender, body)
	}
	if saved := admin.expect("GET", "/system/email", nil, 200, ""); saved["host"] != nil {
		t.Errorf("the test saved the settings: %v", saved)
	}

	refusing := &mailtest.Server{RejectRecipient: true}
	refusing.Start(t)
	settings["port"] = refusing.Port
	got = admin.expect("POST", "/system/email/test", map[string]any{"settings": settings, "to": "nobody@example.com", "locale": "en-US"}, 200, "")
	if got["ok"] != false || got["stage"] != "recipient" || got["message"] != "550 5.1.1 No such user here" {
		t.Errorf("refused: %v", got)
	}

	// The saved password counts for a test that leaves it out: this one
	// gets as far as the certificate, which no system trusts.
	encrypted := &mailtest.Server{ImplicitTLS: true}
	encrypted.Start(t)
	admin.expect("PUT", "/system/email", map[string]any{"host": "127.0.0.1", "security": "tls", "username": "bi", "password": "pw", "fromAddress": "bi@example.com"}, 200, "")
	got = admin.expect("POST", "/system/email/test", map[string]any{"settings": map[string]any{"host": "127.0.0.1", "port": encrypted.Port, "security": "tls", "username": "bi", "fromAddress": "bi@example.com"},
		"to": "ann@example.com", "locale": "en-US"}, 200, "")
	if got["ok"] != false || got["stage"] != "tls" {
		t.Errorf("with the saved password: %v", got)
	}
	encrypted.None(t)

	for _, c := range []struct {
		body map[string]any
		code string
	}{
		{map[string]any{"settings": map[string]any{"security": "none"}, "to": "ann@example.com", "locale": "en-US"}, "email_host_required"},
		{map[string]any{"settings": settings, "to": "Ann <ann@example.com>", "locale": "en-US"}, "invalid_email_address"},
		{map[string]any{"settings": settings, "to": "ann@example.com", "locale": "fr-FR"}, "invalid_locale"},
		{map[string]any{"settings": map[string]any{"host": "127.0.0.1", "security": "none", "fromAddress": "bi@example.com", "username": "bi"}, "to": "ann@example.com", "locale": "en-US"}, "email_auth_unencrypted"},
	} {
		admin.expect("POST", "/system/email/test", c.body, 400, c.code)
	}

	events := auditEvents(t, admin, "?category=system")
	failed := eventOf(t, events, "email.test", func(e map[string]any) bool { return e["outcome"] == "failure" && detailOf(e)["stage"] == "recipient" })
	if d := detailOf(failed); d["to"] != "nobody@example.com" || d["error"] != "550 5.1.1 No such user here" || d["server"] != "127.0.0.1:"+strconv.Itoa(refusing.Port) {
		t.Errorf("failed test: %v", d)
	}
	if d := detailOf(eventOf(t, events, "email.test", func(e map[string]any) bool { return e["outcome"] == "success" })); d["to"] != "ann@example.com" || d["security"] != "none" {
		t.Errorf("test: %v", d)
	}
}
