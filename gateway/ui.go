package main

import (
	"bytes"
	_ "embed"
	"fmt"
	"html/template"
	"log/slog"
	"net/http"
	"time"
)

//go:embed pages.html
var pages string

//go:embed passkey.js
var passkeyJS []byte

//go:embed ui.js
var uiJS []byte

//go:embed style.css
var styleCSS []byte

type namedKey struct{ ID, Label string }
type auditEvent struct {
	At    int64
	Event string
}
type page struct {
	View, Title, CSRF, Next    string
	Error, ErrorDetail, Notice string
	Key, Challenge, BackupID   string
	Status                     int
	Recent, BrowserEnabled     bool
	Codes                      []string
	Keys                       []namedKey
	Sessions                   []session
	Events                     []auditEvent
	Control                    browserStatus
	ProviderOK                 bool
	Runtime                    runtimeState
	Upgrade                    *upgradeStatus
	Backups                    []backupEntry
	Components                 components
	Versions                   availableVersions
}

const displayTime = "2006-01-02 15:04 UTC"

var componentLabels = map[string]string{
	"node": "Node.js", "git": "Git", "python": "Python", "os": "系统", "arch": "架构", "runtime-image": "Runtime 镜像",
}

var auditLabels = map[string]string{
	"account_created": "初始化管理员", "account_enable": "启用账户", "account_disable": "停用账户",
	"login_totp": "动态验证码登录", "login_passkey": "Passkey 登录", "login_recovery": "恢复码登录",
	"password_failed": "登录验证失败", "login_totp_failed": "动态验证码验证失败", "login_recovery_failed": "恢复码验证失败",
	"passkey_failed": "Passkey 登录失败", "stepup": "重新验证身份", "stepup_failed": "重新验证身份失败",
	"password_changed": "修改密码", "passkey_added": "添加 Passkey", "passkey_removed": "移除 Passkey",
	"totp_changed": "更换动态验证器", "recovery_regenerated": "重新生成恢复码",
	"session_revoked": "撤销会话", "sessions_revoked": "撤销全部会话",
	"runtime_backup": "创建备份", "runtime_backup_failed": "创建备份失败", "runtime_backup_denied": "创建备份被拒绝",
	"runtime_verify": "校验备份", "runtime_verify_failed": "备份校验失败", "runtime_verify_denied": "备份校验被拒绝",
	"browser_takeover": "接管浏览器", "browser_grant": "移交浏览器控制权",
}

func displayLabel(labels map[string]string, key string) string {
	if text := labels[key]; text != "" {
		return text
	}
	return key
}

func fileSize(bytes int64) string {
	switch {
	case bytes >= 1<<30:
		return fmt.Sprintf("%.1f GiB", float64(bytes)/(1<<30))
	case bytes >= 1<<20:
		return fmt.Sprintf("%.1f MiB", float64(bytes)/(1<<20))
	case bytes >= 1<<10:
		return fmt.Sprintf("%.1f KiB", float64(bytes)/(1<<10))
	default:
		return fmt.Sprintf("%d B", bytes)
	}
}

var ui = template.Must(template.New("page").Funcs(template.FuncMap{
	"upgradeMessage": func(status *upgradeStatus) string { return status.message() },
	"stamp":          func(seconds int64) string { return time.Unix(seconds, 0).UTC().Format(displayTime) },
	"isoTime":        func(seconds int64) string { return time.Unix(seconds, 0).UTC().Format(time.RFC3339) },
	"fileSize":       fileSize,
	"componentLabel": func(key string) string { return displayLabel(componentLabels, key) },
	"auditLabel":     func(key string) string { return displayLabel(auditLabels, key) },
	"archiveTime": func(raw string) string {
		if stamp, err := time.Parse(time.RFC3339, raw); err == nil {
			return stamp.UTC().Format(displayTime)
		}
		return raw
	},
}).Parse(pages))

func (g *gateway) render(w http.ResponseWriter, r *http.Request, p page) {
	p.BrowserEnabled = g.browserEnabled
	p.CSRF = cookie(r, csrfCookie)
	if len(p.CSRF) != 43 {
		p.CSRF = randomText(random(32))
		setCookie(w, csrfCookie, p.CSRF, 0)
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	// Pages are rendered per request from live state; a cached copy would show a
	// version or backup list that has since changed.
	w.Header().Set("Cache-Control", "no-store")
	var body bytes.Buffer
	if err := ui.Execute(&body, p); err != nil {
		slog.Error("template render failed", "view", p.View, "reason", err.Error())
		unavailable(w)
		return
	}
	if p.Status != 0 {
		w.WriteHeader(p.Status)
	}
	_, _ = body.WriteTo(w)
}
func (g *gateway) accountPage(w http.ResponseWriter, r *http.Request, s session) {
	p := page{View: "account", Title: "账户", Recent: stepped(s)}
	ctx := r.Context()
	// Each query closes before the next; SQLite uses a single writer connection.
	load := func(query string, receive func(func(...any) error) error, args ...any) error {
		rows, err := g.db.QueryContext(ctx, query, args...)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			if err := receive(rows.Scan); err != nil {
				return err
			}
		}
		return rows.Err()
	}
	err := load("SELECT id,label FROM passkeys ORDER BY label", func(scan func(...any) error) error {
		var id []byte
		var label string
		if err := scan(&id, &label); err != nil {
			return err
		}
		p.Keys = append(p.Keys, namedKey{randomText(id), label})
		return nil
	})
	if err != nil {
		unavailable(w)
		return
	}
	now := time.Now().Unix()
	err = load("SELECT id,created,seen FROM sessions WHERE seen>? AND created>? ORDER BY seen DESC", func(scan func(...any) error) error {
		var other session
		if err := scan(&other.ID, &other.Created, &other.Seen); err != nil {
			return err
		}
		other.Current = other.ID == s.ID
		p.Sessions = append(p.Sessions, other)
		return nil
	}, now-g.idle, now-g.absolute)
	if err != nil {
		unavailable(w)
		return
	}
	err = load("SELECT at,event FROM audit ORDER BY id DESC LIMIT 40", func(scan func(...any) error) error {
		var e auditEvent
		if err := scan(&e.At, &e.Event); err != nil {
			return err
		}
		p.Events = append(p.Events, e)
		return nil
	})
	if err != nil {
		unavailable(w)
		return
	}
	g.render(w, r, p)
}
