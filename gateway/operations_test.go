package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestManagementMaintenance(t *testing.T) {
	g, _, seed := newTestGateway(t)
	const id = "20261126T101500Z.abcdef123456"
	var calls atomic.Int32
	runtime := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var command struct {
			Action string
			Args   map[string]string
		}
		if r.Method != http.MethodPost || r.Header.Get("Authorization") != "Bearer fixture" || json.NewDecoder(r.Body).Decode(&command) != nil {
			t.Error("invalid request to the Runtime listener")
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		calls.Add(1)
		if command.Action == "verify" && command.Args["id"] != id {
			t.Error("Gateway forwarded the wrong archive id")
		}
		switch command.Action {
		case "backup", "verify":
			writeJSON(w, map[string]any{"ok": true})
		default:
			t.Errorf("unexpected Runtime action: %s", command.Action)
			w.WriteHeader(http.StatusBadRequest)
		}
	}))
	t.Cleanup(runtime.Close)
	dir := t.TempDir()
	for name, content := range map[string]string{
		"maintenance": "fixture", "dsh-home." + id + ".tgz": "archive",
		"dsh-home." + id + ".json": `{"dsh":{"active":"0.2.2-rc.1"}}`,
	} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("WORKSTATION_MAINTENANCE_ADDR", strings.TrimPrefix(runtime.URL, "http://"))
	t.Setenv("WORKSTATION_MAINTENANCE_SECRET", filepath.Join(dir, "maintenance"))
	t.Setenv("WORKSTATION_BACKUP_DIR", dir)
	csrf := &http.Cookie{Name: csrfCookie, Value: randomText(random(32))}
	sess := &http.Cookie{Name: sessionCookie, Value: randomText(random(32))}
	ctx := context.Background()
	if err := g.change(ctx, "test_session", func(tx *sql.Tx) error {
		return g.newSession(ctx, tx, sess.Value, "", false)
	}); err != nil {
		t.Fatal(err)
	}
	post := func(action string) *httptest.ResponseRecorder {
		return request(g, req(g, "POST", "/mgmt/runtime", url.Values{
			"csrf": {csrf.Value}, "action": {action}, "id": {id},
		}, csrf, sess))
	}
	for _, action := range []string{"upgrade", "rollback", "restore"} {
		response(t, post(action), http.StatusBadRequest)
	}
	stale := post("backup")
	response(t, stale, http.StatusSeeOther)
	if stale.Header().Get("Location") != "/_auth/stepup?next=%2Fmgmt%2Fbackup" || calls.Load() != 0 {
		t.Fatal("maintenance reached Runtime before re-verification")
	}
	step := url.Values{"csrf": {csrf.Value}, "next": {"/mgmt/backup"}, "code": {totp(seed, time.Now().Unix()/30)}}
	response(t, request(g, req(g, "POST", "/_auth/stepup", step, csrf, sess)), http.StatusSeeOther)
	response(t, request(g, req(g, "POST", "/_auth/stepup", step, csrf, sess)), http.StatusUnauthorized)
	response(t, post("backup"), http.StatusSeeOther)
	verified := post("verify")
	response(t, verified, http.StatusOK)
	if calls.Load() != 2 || !strings.Contains(verified.Body.String(), "备份校验通过。") || !strings.Contains(verified.Body.String(), "0.2.2-rc.1") {
		t.Fatal("Gateway did not show the verified backup and its DSH version")
	}
	if _, err := g.db.Exec("UPDATE sessions SET stepped=?", time.Now().Add(-5*time.Minute).Unix()); err != nil {
		t.Fatal(err)
	}
	response(t, post("backup"), http.StatusSeeOther)
	if calls.Load() != 2 {
		t.Fatal("an expired step-up authorized a backup")
	}
}
