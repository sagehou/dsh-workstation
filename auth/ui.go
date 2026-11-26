package main

import (
	_ "embed"
	"html/template"
	"log/slog"
	"net/http"
	"time"
)

//go:embed pages.html
var pages string

//go:embed passkey.js
var passkeyJS []byte

//go:embed style.css
var styleCSS []byte

type namedKey struct{ ID, Label string }
type auditEvent struct {
	At    int64
	Event string
}
type page struct {
	View, Title, CSRF, Next, Error, Key, Challenge string
	Status                                         int
	Recent                                         bool
	Codes                                          []string
	Keys                                           []namedKey
	Sessions                                       []session
	Events                                         []auditEvent
	Control                                        browserStatus
	ProviderOK                                     bool
	Runtime                                        runtimeState
	Backups                                        []backupEntry
	Components                                     components
	Versions                                       availableVersions
}

var ui = template.Must(template.New("page").Funcs(template.FuncMap{
	"stamp": func(seconds int64) string { return time.Unix(seconds, 0).UTC().Format("2006-01-02 15:04 UTC") },
	"mib":   func(bytes int64) float64 { return float64(bytes) / (1024 * 1024) },
}).Parse(pages))

func (g *gateway) render(w http.ResponseWriter, r *http.Request, p page) {
	p.CSRF = cookie(r, csrfCookie)
	if len(p.CSRF) != 43 {
		p.CSRF = randomText(random(32))
		setCookie(w, csrfCookie, p.CSRF, 0)
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	// Pages are rendered per request from live state; a cached copy would show a
	// version or backup list that has since changed.
	w.Header().Set("Cache-Control", "no-store")
	if p.Status != 0 {
		w.WriteHeader(p.Status)
	}
	// A template error truncates the response mid-page, so the operator sees a
	// half-rendered view with no explanation. Log it and say so in the page tail:
	// a silent `return` here hid a broken operations page for several rounds.
	if err := ui.Execute(w, p); err != nil {
		slog.Error("template render failed", "view", p.View, "reason", err.Error())
		return
	}
}
func (g *gateway) accountPage(w http.ResponseWriter, r *http.Request, s session) {
	p := page{View: "account", Title: "账户", Recent: s.Stepped > time.Now().Unix()-300}
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
