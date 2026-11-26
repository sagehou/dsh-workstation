package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

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
	ID          string `json:"id"`
	Version     string `json:"version,omitempty"`
	Bytes       int64  `json:"bytes"`
	Modified    string `json:"modified"`
	HasManifest bool   `json:"hasManifest"`
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

// readBackups lists archives newest first and shows whether each has a manifest.
func readBackups(dir string) []backupEntry {
	if dir == "" {
		dir = "/backup"
	}
	out := []backupEntry{}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return out
	}
	for i := len(entries) - 1; i >= 0; i-- {
		file := entries[i]
		base, archive := strings.CutSuffix(file.Name(), ".tgz")
		id, matches := strings.CutPrefix(base, "dsh-home.")
		if !archive || !matches || file.IsDir() {
			continue
		}
		entry := backupEntry{ID: id}
		if info, err := file.Info(); err == nil {
			entry.Bytes = info.Size()
			entry.Modified = info.ModTime().UTC().Format(time.RFC3339)
		}
		// The recorded DSH version lives in the manifest; a missing or unreadable
		// one leaves the field empty rather than failing the whole list.
		if raw, err := os.ReadFile(filepath.Join(dir, base+".json")); err == nil {
			entry.HasManifest = true
			var manifest struct {
				DSH struct {
					Active string `json:"active"`
				} `json:"dsh"`
				DSHVersion string `json:"dshVersion"`
				Version    string `json:"version"`
			}
			if json.Unmarshal(raw, &manifest) == nil {
				entry.Version = manifest.DSH.Active
				if entry.Version == "" {
					entry.Version = manifest.DSHVersion
				}
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
func (g *gateway) operationsPage(w http.ResponseWriter, r *http.Request) {
	page := page{
		View:  "operations",
		Title: "控制台",
	}
	page.Runtime = readRuntimeState(os.Getenv("WORKSTATION_DSH_HOME"))
	inventoryCtx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	g.fetchInventory(r.WithContext(inventoryCtx), &page)
	if g.browserEnabled {
		page.ProviderOK = g.provider(r, "GET", "/status", nil, &page.Control) == nil
	}
	g.render(w, r, page)
}

func backupView(s session) page {
	return page{
		View:    "backup",
		Title:   "备份",
		Recent:  stepped(s),
		Backups: readBackups(os.Getenv("WORKSTATION_BACKUP_DIR")),
	}
}

func (g *gateway) backupPage(w http.ResponseWriter, r *http.Request, s session) {
	g.render(w, r, backupView(s))
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

func (g *gateway) runtimeControl(w http.ResponseWriter, r *http.Request, s session) {
	action := r.PostForm.Get("action")
	args := map[string]any{}
	switch action {
	case "backup":
	case "verify":
		args["id"] = r.PostForm.Get("id")
	default:
		http.Error(w, "unknown action", http.StatusBadRequest)
		return
	}
	if !stepped(s) {
		http.Redirect(w, r, nextURL("/_auth/stepup", "/mgmt/backup"), http.StatusSeeOther)
		return
	}
	// Large archives can outlast the default page write deadline.
	_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(15 * time.Minute))
	result, err := g.runtimeAction(r, action, args)
	if ok, _ := result["ok"].(bool); err != nil || !ok {
		view := backupView(s)
		view.Status = http.StatusConflict
		view.Error = "无法创建备份。"
		if action == "verify" {
			view.Error = "无法校验备份。"
			view.BackupID = r.PostForm.Get("id")
		}
		if err != nil {
			g.failure(r, "runtime_"+action+"_denied")
			view.ErrorDetail = err.Error()
		} else {
			g.failure(r, "runtime_"+action+"_failed")
			view.ErrorDetail, _ = result["stderr"].(string)
			if view.ErrorDetail == "" {
				view.ErrorDetail, _ = result["stdout"].(string)
			}
		}
		g.render(w, r, view)
		return
	}
	g.failure(r, "runtime_"+action)
	if action == "verify" {
		view := backupView(s)
		view.Notice = "备份校验通过。"
		view.BackupID = r.PostForm.Get("id")
		g.render(w, r, view)
		return
	}
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

func (g *gateway) stepUpPage(w http.ResponseWriter, r *http.Request) {
	g.render(w, r, page{
		View:  "stepup",
		Title: "确认操作",
		Next:  safePath(r.URL.Query().Get("next")),
	})
}

func (g *gateway) stepUp(w http.ResponseWriter, r *http.Request, s session) {
	target := r.PostForm.Get("next")
	if target == "" {
		target = "/mgmt"
	}
	next := safePath(target)
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
	now := time.Now()
	step, ok := matchTOTP(seed, strings.TrimSpace(r.PostForm.Get("code")), now)
	denied := func() {
		g.failure(r, "stepup_failed")
		g.render(w, r, page{Status: 401, View: "stepup", Title: "确认操作", Next: next,
			Error: "验证码无效或已使用。"})
	}
	if !ok {
		denied()
		return
	}
	ctx := r.Context()
	err = g.change(ctx, "stepup", func(tx *sql.Tx) error {
		if err := one(tx, ctx, "UPDATE account SET last_step=? WHERE id=1 AND enabled=1 AND epoch=? AND last_step<?", step, account.epoch, step); err != nil {
			return err
		}
		return one(tx, ctx, "UPDATE sessions SET stepped=? WHERE id=? AND seen>? AND created>?",
			now.Unix(), s.ID, now.Unix()-g.idle, now.Unix()-g.absolute)
	})
	if errors.Is(err, errDenied) {
		denied()
		return
	}
	if err != nil {
		unavailable(w)
		return
	}
	http.Redirect(w, r, next, http.StatusSeeOther)
}

func stepped(s session) bool {
	now := time.Now().Unix()
	return s.Stepped <= now && s.Stepped > now-300
}
