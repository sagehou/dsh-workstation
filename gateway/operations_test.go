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
	"syscall"
	"testing"
	"time"
)

func TestUpgradeStatusWhileRuntimeIsStopped(t *testing.T) {
	g, sessionCookie := loginForBrowserTest(t)
	home := t.TempDir()
	t.Setenv("WORKSTATION_DSH_HOME", home)
	t.Setenv("WORKSTATION_MAINTENANCE_SECRET", "")
	dir := filepath.Join(home, "runtime")
	if err := os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	write := func(name, content string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
	}
	const path = "/mgmt/upgrade-status"
	response(t, request(g, req(g, "GET", path, nil, sessionCookie)), 404)
	write("selection", "0.2.2-rc.1\n")
	write(".lock", "")
	write("upgrade-status.json", `{"from":"0.2.2-rc.1","to":"0.2.2-rc.5","phase":"compatibility","result":"running"}`)
	response(t, request(g, req(g, "GET", path, nil)), 401)
	lock, err := os.OpenFile(filepath.Join(dir, ".lock"), os.O_RDWR, 0600)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX); err != nil {
		t.Fatal(err)
	}
	if _, err := g.db.Exec("UPDATE sessions SET seen=?", time.Now().Unix()-60); err != nil {
		t.Fatal(err)
	}
	var seen int64
	if err := g.db.QueryRow("SELECT seen FROM sessions").Scan(&seen); err != nil {
		t.Fatal(err)
	}
	running := request(g, req(g, "GET", path, nil, sessionCookie))
	response(t, running, 200)
	if !strings.Contains(running.Body.String(), `"result":"running"`) {
		t.Fatalf("no running phase in %s", running.Body.String())
	}
	var after int64
	if err := g.db.QueryRow("SELECT seen FROM sessions").Scan(&after); err != nil || after != seen {
		t.Fatalf("a polling request renewed the session: %d -> %d, %v", seen, after, err)
	}
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_UN); err != nil {
		t.Fatal(err)
	}
	interrupted := request(g, req(g, "GET", path, nil, sessionCookie))
	response(t, interrupted, 200)
	if !strings.Contains(interrupted.Body.String(), `"result":"interrupted"`) {
		t.Fatalf("stale phase remains running: %s", interrupted.Body.String())
	}
	write("upgrade-status.json", `{"from":"0.2.2-rc.1","to":"0.2.2-rc.5","phase":"compatibility","result":"failed","blockers":["test-bundle requires DSH 0.2.2-rc.1"]}`)
	overview := request(g, req(g, "GET", "/mgmt", nil, sessionCookie))
	response(t, overview, 200)
	if !strings.Contains(overview.Body.String(), "失败 · 检查插件与依赖兼容性") || !strings.Contains(overview.Body.String(), "test-bundle requires DSH") {
		t.Fatal("the overview did not render the persisted compatibility refusal")
	}
	write("startup-status.json", `{"to":"0.2.2-rc.1","phase":"readiness","result":"failed"}`)
	w := httptest.NewRecorder()
	g.dshUnavailable(w, req(g, "GET", "/_auth/dsh", nil, sessionCookie))
	response(t, w, http.StatusServiceUnavailable)
	if !strings.Contains(w.Body.String(), "首次初始化失败 · 验证候选版本启动") || !strings.Contains(w.Body.String(), `href="/mgmt"`) {
		t.Fatal("the unavailable page did not give a startup phase and a recovery link")
	}
}

func TestManagementMaintenance(t *testing.T) {
	g, _, seed := newTestGateway(t)
	const id = "20261126T101500Z.abcdef123456"
	var calls atomic.Int32
	var refuseVerify atomic.Bool
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
		if command.Action == "verify" && refuseVerify.Load() {
			writeJSON(w, map[string]any{"ok": false, "stderr": "archive checksum mismatch"})
			return
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
	refuseVerify.Store(true)
	failed := post("verify")
	response(t, failed, http.StatusConflict)
	for _, required := range []string{"无法校验备份。", "archive checksum mismatch", `<option value="` + id + `" selected>`} {
		if !strings.Contains(failed.Body.String(), required) {
			t.Fatalf("backup error lost %q", required)
		}
	}
	if _, err := g.db.Exec("UPDATE sessions SET stepped=?", time.Now().Add(-5*time.Minute).Unix()); err != nil {
		t.Fatal(err)
	}
	response(t, post("backup"), http.StatusSeeOther)
	if calls.Load() != 3 {
		t.Fatal("an expired step-up authorized a backup")
	}
}

func TestStartDSHUpgrade(t *testing.T) {
	g, _, seed := newTestGateway(t)
	const target = "0.2.2-rc.5"
	var queued atomic.Int32
	runtime := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Action string
			Args   map[string]string
		}
		if r.Method != "POST" || r.Header.Get("Authorization") != "Bearer fixture" || json.NewDecoder(r.Body).Decode(&body) != nil {
			t.Error("invalid request to Runtime")
			w.WriteHeader(400)
			return
		}
		switch body.Action {
		case "components":
			writeJSON(w, map[string]any{"ok": true, "managedUpgrade": true})
		case "versions":
			writeJSON(w, map[string]any{"ok": true, "stdout": `["0.2.2-rc.5"]`})
		case "upgrade":
			if body.Args["version"] != target {
				t.Error("Runtime received the wrong candidate version")
			}
			if queued.Add(1) == 1 {
				w.WriteHeader(http.StatusAccepted)
				writeJSON(w, map[string]any{"ok": true})
			} else {
				w.WriteHeader(http.StatusConflict)
				writeJSON(w, map[string]string{"error": "UPGRADE_BUSY"})
			}
		default:
			t.Errorf("unexpected action: %s", body.Action)
			w.WriteHeader(400)
		}
	}))
	t.Cleanup(runtime.Close)
	secret := filepath.Join(t.TempDir(), "maintenance")
	if err := os.WriteFile(secret, []byte("fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("WORKSTATION_MAINTENANCE_ADDR", strings.TrimPrefix(runtime.URL, "http://"))
	t.Setenv("WORKSTATION_MAINTENANCE_SECRET", secret)
	csrf := &http.Cookie{Name: csrfCookie, Value: randomText(random(32))}
	sess := &http.Cookie{Name: sessionCookie, Value: randomText(random(32))}
	ctx := context.Background()
	if err := g.change(ctx, "test_session", func(tx *sql.Tx) error {
		return g.newSession(ctx, tx, sess.Value, "", false)
	}); err != nil {
		t.Fatal(err)
	}
	post := func(version string, cookies ...*http.Cookie) *httptest.ResponseRecorder {
		return request(g, req(g, "POST", upgradePath, url.Values{"csrf": {csrf.Value}, "version": {version}}, cookies...))
	}
	response(t, post(target, csrf), http.StatusUnauthorized)
	stale := post(target, csrf, sess)
	response(t, stale, http.StatusSeeOther)
	if stale.Header().Get("Location") != "/_auth/stepup?next=%2Fmgmt%2Fupgrade" {
		t.Fatal("upgrade did not request recent verification")
	}
	step := url.Values{"csrf": {csrf.Value}, "next": {upgradePath}, "code": {totp(seed, time.Now().Unix()/30)}}
	response(t, request(g, req(g, "POST", "/_auth/stepup", step, csrf, sess)), http.StatusSeeOther)
	response(t, post(target, sess), http.StatusForbidden)
	response(t, post("latest", csrf, sess), http.StatusBadRequest)
	if queued.Load() != 0 {
		t.Fatal("an unauthenticated or invalid action reached Runtime")
	}
	form := request(g, req(g, "GET", upgradePath, nil, csrf, sess))
	response(t, form, http.StatusOK)
	if !strings.Contains(form.Body.String(), "开始升级") || !strings.Contains(form.Body.String(), target) {
		t.Fatal("upgrade form is missing the confirmation or published version")
	}
	accepted := post(target, csrf, sess)
	response(t, accepted, http.StatusSeeOther)
	if accepted.Header().Get("Location") != "/mgmt" {
		t.Fatal("accepted upgrade did not return to its progress display")
	}
	busy := post(target, csrf, sess)
	response(t, busy, http.StatusConflict)
	if !strings.Contains(busy.Body.String(), "Runtime 正在维护") {
		t.Fatal("missing maintenance conflict feedback")
	}
}
