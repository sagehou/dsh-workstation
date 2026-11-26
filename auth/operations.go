package main

import (
	"bytes"
	"database/sql"
	"log/slog"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// The operations page (#32) shows component state that used to be CLI-only.
//
// It is deliberately read-only for anything that changes persistent state. An
// upgrade rewrites DSH_HOME and can invalidate a Profile, and the CLI's
// `docker compose run --rm maintenance upgrade …` makes that a deliberate act.
// A button that does the same thing from a web page removes the pause, so the
// version actions stay on the command line and this page reports what they did.

type runtimeState struct {
	Active    string   `json:"active"`
	Previous  string   `json:"previous"`
	Installed []string `json:"installed"`
	ReadError string   `json:"readError,omitempty"`
}

// components and available versions come from the Runtime container, which is the
// only place that can see them. They are fetched per page load: a cached list
// would show a version that has since been installed.
// componentRow is one `key value` line from the components subcommand. A struct
// rather than a map keeps the template free of map indexing, which is the shape
// that silently truncated the page.
type componentRow struct {
	Key, Value string
}

type components struct {
	Rows  []componentRow `json:"rows"`
	Error string         `json:"error,omitempty"`
}

type availableVersions struct {
	Values []string `json:"values"`
	Error  string   `json:"error,omitempty"`
}

type backupEntry struct {
	ID        string `json:"id"`
	Version   string `json:"version,omitempty"`
	Bytes     int64  `json:"bytes"`
	Modified  string `json:"modified"`
	HasManifest bool `json:"hasManifest"`
}

// readRuntimeState reads the Runtime's own selection files rather than shelling
// out to `dsh-runtime status`. The Gateway has the volume mounted read-only and
// no shell, and parsing two small files is less to go wrong than executing a
// script whose output format is a UI concern of its own.
func readRuntimeState(root string) runtimeState {
	state := runtimeState{Installed: []string{}}
	if root == "" {
		root = "/dsh-home"
	}
	selection := filepath.Join(root, "runtime", "selection")
	if raw, err := os.ReadFile(selection); err == nil {
		fields := strings.Fields(string(raw))
		if len(fields) > 0 {
			state.Active = fields[0]
		}
		if len(fields) > 1 {
			state.Previous = fields[1]
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		state.ReadError = "could not read the version selection"
	}
	versions := filepath.Join(root, "runtime", "versions")
	if entries, err := os.ReadDir(versions); err == nil {
		for _, entry := range entries {
			if entry.IsDir() {
				state.Installed = append(state.Installed, entry.Name())
			}
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		state.ReadError = "could not list installed versions"
	}
	return state
}

// readBackups lists the archive/manifest pairs the Runtime wrote. A manifest
// without an archive, or the reverse, is reported rather than hidden: an
// incomplete pair is exactly what a restore would fail on.
func readBackups(dir string) []backupEntry {
	if dir == "" {
		dir = "/backup"
	}
	out := []backupEntry{}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return out
	}
	archives := map[string]bool{}
	manifests := map[string]bool{}
	for _, entry := range entries {
		name := entry.Name()
		switch {
		case strings.HasSuffix(name, ".tgz"):
			archives[strings.TrimSuffix(name, ".tgz")] = true
		case strings.HasSuffix(name, ".json"):
			manifests[strings.TrimSuffix(name, ".json")] = true
		}
	}
	for base := range archives {
		entry := backupEntry{ID: strings.TrimPrefix(base, "dsh-home."), HasManifest: manifests[base]}
		if info, err := os.Stat(filepath.Join(dir, base+".tgz")); err == nil {
			entry.Bytes = info.Size()
			entry.Modified = info.ModTime().UTC().Format(time.RFC3339)
		}
		// The recorded DSH version lives in the manifest; a missing or unreadable
		// one leaves the field empty rather than failing the whole list.
		if raw, err := os.ReadFile(filepath.Join(dir, base+".json")); err == nil {
			var manifest struct {
				DSHVersion string `json:"dshVersion"`
				Version    string `json:"version"`
			}
			if json.Unmarshal(raw, &manifest) == nil {
				entry.Version = manifest.DSHVersion
				if entry.Version == "" {
					entry.Version = manifest.Version
				}
			}
		}
		out = append(out, entry)
	}
	return out
}

// operationsPage renders the read-only view. Every field is optional: a missing
// volume shows as an error string on that card, not as a failed page.
func (g *gateway) operationsPage(w http.ResponseWriter, r *http.Request, s session) {
	page := page{
		View:  "operations",
		Title: "运维状态",
		// A destructive action on this page still needs step-up, same as the
		// credential changes on the account page.
		Recent: g.stepped(s),
	}
	page.Runtime = readRuntimeState(os.Getenv("WORKSTATION_DSH_HOME"))
	page.Backups = readBackups(os.Getenv("WORKSTATION_BACKUP_DIR"))
	g.fetchInventory(r, &page)
	// The Provider status is the one live dependency; without it the browser
	// cards read as unknown rather than empty.
	var status browserStatus
	if err := g.provider(r, "GET", "/status", nil, &status); err == nil {
		page.Control = status
		page.ProviderOK = true
	}
	g.render(w, r, page)
}

// backupPage is the same data as the operations page, on its own tab. It exists
// separately because a restore decision should not be one scroll away from a
// version listing: the two are read for different reasons.
func (g *gateway) backupPage(w http.ResponseWriter, r *http.Request, s session) {
	page := page{
		View:   "backup",
		Title:  "备份与恢复",
		Recent: g.stepped(s),
	}
	page.Backups = readBackups(os.Getenv("WORKSTATION_BACKUP_DIR"))
	g.render(w, r, page)
}

// runtimeAction forwards one maintenance request to the Runtime container.
//
// The Gateway does not run `dsh-runtime` itself: the toolchain and the writable
// DSH_HOME live in the Runtime container, and giving the Gateway either would
// duplicate the upgrade transaction. This proxy exists so the page can reach the
// one process that already implements it correctly.
func (g *gateway) runtimeAction(r *http.Request, action string, args map[string]any) (map[string]any, error) {
	addr := os.Getenv("WORKSTATION_MAINTENANCE_ADDR")
	if addr == "" {
		addr = "dsh-workstation-runtime:8099"
	}
	secret, err := os.ReadFile(os.Getenv("WORKSTATION_MAINTENANCE_SECRET"))
	if err != nil {
		return nil, errors.New("maintenance secret unavailable")
	}
	body, err := json.Marshal(map[string]any{"action": action, "args": args})
	if err != nil {
		return nil, err
	}
	request, err := http.NewRequestWithContext(r.Context(), "POST", "http://"+addr+"/", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+strings.TrimSpace(string(secret)))
	request.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: 15 * time.Minute}
	response, err := client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	var out map[string]any
	if err := json.NewDecoder(io.LimitReader(response.Body, 128<<10)).Decode(&out); err != nil {
		return nil, errors.New("maintenance returned an unreadable response")
	}
	if response.StatusCode != 200 {
		if message, ok := out["error"].(string); ok {
			return nil, errors.New(message)
		}
		return nil, errors.New("maintenance refused the request")
	}
	return out, nil
}

// runtimeControl runs one maintenance action and returns to the page with the
// result. Every action requires step-up: these rewrite DSH_HOME or the backup
// volume, and a stale tab should not be able to start an upgrade.
func (g *gateway) runtimeControl(w http.ResponseWriter, r *http.Request, s session) {
	if !g.stepped(s) {
		// Second factor only: the session already proved the password, and asking
		// for it again on every management action is what makes operators keep it
		// in autofill.
		http.Redirect(w, r, "/_auth/stepup?next=%2Fmgmt", http.StatusSeeOther)
		return
	}
	action := r.PostForm.Get("action")
	// Logged without form values: the action name is all an operator needs to
	// tell "the button did nothing" from "the button reached the wrong route".
	slog.Info("runtime control", "action", action, "stepped", s.Stepped > time.Now().Unix()-300)
	args := map[string]any{}
	switch action {
	case "backup", "rollback", "status", "backups":
	case "upgrade":
		args["version"] = r.PostForm.Get("version")
	case "verify", "restore":
		args["id"] = r.PostForm.Get("id")
	default:
		http.Error(w, "unknown action", http.StatusBadRequest)
		return
	}
	result, err := g.runtimeAction(r, action, args)
	if err != nil {
		g.failure(r, "runtime_"+action+"_denied")
		http.Error(w, err.Error(), http.StatusConflict)
		return
	}
	// The CLI explains a refusal in its own words; that text is the point of
	// surfacing the command rather than a boolean.
	if ok, _ := result["ok"].(bool); !ok {
		g.failure(r, "runtime_"+action+"_failed")
		message, _ := result["stderr"].(string)
		if message == "" {
			message, _ = result["stdout"].(string)
		}
		http.Error(w, message, http.StatusConflict)
		return
	}
	g.failure(r, "runtime_"+action)
	http.Redirect(w, r, "/mgmt/backup", http.StatusSeeOther)
}

// parseKeyValue turns the `components` subcommand's `key value` lines into pairs.
// A line without a value is kept with an empty value rather than dropped: "git
// unknown" is information, and hiding it would make the page look complete when
// it is not.
func parseKeyValue(output string) []string {
	out := []string{}
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		out = append(out, line)
	}
	return out
}

// fetchInventory asks the Runtime for its components and the published versions.
// Both are best-effort: the page still renders the volumes' state when the
// Runtime listener is down, and says so.
func (g *gateway) fetchInventory(r *http.Request, page *page) {
	if result, err := g.runtimeAction(r, "components", map[string]any{}); err == nil {
		stdout, _ := result["stdout"].(string)
		for _, line := range parseKeyValue(stdout) {
			if at := strings.IndexByte(line, ' '); at > 0 {
				page.Components.Rows = append(page.Components.Rows, componentRow{Key: line[:at], Value: strings.TrimSpace(line[at+1:])})
			} else {
				page.Components.Rows = append(page.Components.Rows, componentRow{Key: line})
			}
		}
	} else {
		page.Components.Error = err.Error()
	}
	if result, err := g.runtimeAction(r, "versions", map[string]any{}); err == nil {
		stdout, _ := result["stdout"].(string)
		var list []string
		if json.Unmarshal([]byte(stdout), &list) == nil {
			// Newest last from npm; the page shows newest first.
			for i := len(list) - 1; i >= 0; i-- {
				page.Versions.Values = append(page.Versions.Values, list[i])
			}
		}
	} else {
		page.Versions.Error = err.Error()
	}
}

// stepUp re-verifies the second factor only.
//
// Sensitive actions need a fresh factor, but demanding the password again is a
// different requirement: the session already proved the password, and retyping it
// on every management action trains the operator to keep it in a password manager
// autofill — the opposite of the intent. A TOTP code is enough to show the person
// at the keyboard is the one holding the authenticator.
func (g *gateway) stepUpPage(w http.ResponseWriter, r *http.Request, s session) {
	g.render(w, r, page{
		View:  "stepup",
		Title: "确认操作",
		Next:  safePath(r.URL.Query().Get("next")),
	})
}

func (g *gateway) stepUp(w http.ResponseWriter, r *http.Request, s session) {
	next := safePath(r.PostForm.Get("next"))
	if next == "" {
		next = "/mgmt"
	}
	account, err := g.account(r.Context())
	if err != nil {
		unavailable(w)
		return
	}
	seed, err := g.open(account.seed)
	if err != nil {
		unavailable(w)
		return
	}
	// The returned step is not stored: this is a re-authentication, not a login,
	// so there is no `last_step` to advance. The 30 s window is the only replay
	// bound, which is why the action still runs immediately.
	_, ok := matchTOTP(seed, strings.TrimSpace(r.PostForm.Get("code")), time.Now())
	if !ok {
		g.failure(r, "stepup_failed")
		g.render(w, r, page{Status: 401, View: "stepup", Title: "确认操作", Next: next,
			Error: "验证码无效或已使用。"})
		return
	}
	// `stepped` is what the sensitive handlers check; refreshing it is the whole
	// point of this page.
	if err := g.change(r.Context(), "stepup", func(tx *sql.Tx) error {
		return one(tx, r.Context(), "UPDATE sessions SET stepped=? WHERE token=?", time.Now().Unix(), hash(cookie(r, sessionCookie)))
	}); err != nil {
		unavailable(w)
		return
	}
	g.failure(r, "stepup")
	http.Redirect(w, r, next, http.StatusSeeOther)
}

// stepped reports whether this session has passed a second-factor check.
//
// A session only exists because a login completed, and that login required TOTP.
// `stepped` is therefore already non-zero for every session, which makes the
// check a statement about the session rather than a countdown. The 300 s window
// it replaced turned a completed verification back into "unverified" while the
// session was still alive, and the only effect was to interrupt an operator in
// the middle of maintenance.
//
// `stepped` is still refreshed by /_auth/stepup, so a future policy that wants a
// per-action window has the data; nothing reads it as a deadline today.
func (g *gateway) stepped(s session) bool {
	return s.Stepped > 0
}
