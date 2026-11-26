package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"path"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/go-webauthn/webauthn/webauthn"
)

const (
	sessionCookie  = "__Host-dsh_session"
	preCookie      = "__Host-dsh_pre"
	csrfCookie     = "__Host-dsh_csrf"
	loginChallenge = "__Host-dsh_webauthn"
)

type session struct {
	ID                     string
	Created, Seen, Stepped int64
	Current                bool
}
type limit struct {
	minute int64
	total  int
	ips    map[string]int
}
type gateway struct {
	store
	origin, host, edge          string
	idle, absolute              int64
	maxSessions                 int
	wa                          *webauthn.WebAuthn
	browserToken, providerAdmin string
	providerControlAddr         string
	browserUpstream             string
	browserDirect               string
	dshClient                   *http.Client
	dshWS, browserWS            *httputil.ReverseProxy
	browserDirectWS             *httputil.ReverseProxy
	hashSlots                   chan struct{}
	mu                          sync.Mutex
	limits                      map[string]*limit
	// browserEnabled is false in a core deployment (compose.core.yml), where no
	// Chromium, gate or provider exists. Without it, /browser/ would proxy to an
	// address nothing listens on and surface as a stalled WebSocket instead of a
	// clear refusal.
	browserEnabled bool
	// debugPeer, when set, is accepted in place of the edge address so the
	// rendered pages can be exercised from inside the container (AUTH_DEBUG_PEER).
	debugPeer string
}

func cookie(r *http.Request, name string) string {
	c, err := r.Cookie(name)
	if err != nil || len(c.Value) > 128 {
		return ""
	}
	return c.Value
}
func setCookie(w http.ResponseWriter, name, value string, seconds int) {
	http.SetCookie(w, &http.Cookie{Name: name, Value: value, MaxAge: seconds, Path: "/", Secure: true, HttpOnly: true, SameSite: http.SameSiteLaxMode})
}
func security(w http.ResponseWriter) {
	h := w.Header()
	h.Set("Cache-Control", "no-store")
	h.Set("Referrer-Policy", "same-origin")
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("X-Frame-Options", "DENY")
	h.Set("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'")
}
func invalid(w http.ResponseWriter) { http.Error(w, "Request denied", http.StatusForbidden) }
func unavailable(w http.ResponseWriter) {
	http.Error(w, "Service unavailable", http.StatusServiceUnavailable)
}
func ip(r *http.Request) string {
	host, _, _ := net.SplitHostPort(r.RemoteAddr)
	return host
}
func safePath(raw string) string {
	if len(raw) > 1024 || !strings.HasPrefix(raw, "/") || strings.HasPrefix(raw, "//") || strings.Contains(raw, "\\") {
		return "/"
	}
	u, err := url.ParseRequestURI(raw)
	if err != nil || u.IsAbs() || u.Host != "" || strings.HasPrefix(u.Path, "//") || strings.ContainsAny(u.Path, "\\\r\n\t") {
		return "/"
	}
	clean := path.Clean(u.Path)
	if clean != "/_auth/account" && clean != "/_auth/control" && (clean == "/_auth" || strings.HasPrefix(clean, "/_auth/")) {
		return "/"
	}
	q := u.Query()
	q.Del("token")
	u.RawQuery = q.Encode()
	return u.RequestURI()
}
func nextURL(route, next string) string {
	return route + "?next=" + url.QueryEscape(safePath(next))
}
func document(r *http.Request, method, uri string) bool {
	p, err := url.ParseRequestURI(uri)
	if err != nil || method != "GET" || strings.EqualFold(r.Header.Get("Upgrade"), "websocket") || !strings.Contains(r.Header.Get("Accept"), "text/html") {
		return false
	}
	mode, dest := r.Header.Get("Sec-Fetch-Mode"), r.Header.Get("Sec-Fetch-Dest")
	if mode != "" && mode != "navigate" {
		return false
	}
	if dest != "" && dest != "document" && dest != "iframe" {
		return false
	}
	clean := path.Clean(p.Path)
	return clean != "/api" && !strings.HasPrefix(clean, "/api/") &&
		clean != "/browser/api" && !strings.HasPrefix(clean, "/browser/api/")
}

// fromEdge reports whether the request came from the trusted reverse proxy, or
// from the diagnostic peer when one is configured.
func (g *gateway) fromEdge(r *http.Request) bool {
	addr := ip(r)
	return addr == g.edge || (g.debugPeer != "" && addr == g.debugPeer)
}

func (g *gateway) session(r *http.Request) (s session, err error) {
	token := cookie(r, sessionCookie)
	if len(token) != 43 {
		return s, sql.ErrNoRows
	}
	now := time.Now().Unix()
	err = g.db.QueryRowContext(r.Context(), "UPDATE sessions SET seen=? WHERE token=? AND seen>? AND created>? AND EXISTS(SELECT 1 FROM account WHERE id=1 AND enabled=1) RETURNING id,created,seen,stepped",
		now, hash(token), now-g.idle, now-g.absolute).Scan(&s.ID, &s.Created, &s.Seen, &s.Stepped)
	return
}
func (g *gateway) newSession(ctx context.Context, tx *sql.Tx, token, old string, stepped bool) error {
	now := time.Now().Unix()
	step := int64(0)
	if stepped {
		step = now
	}
	if err := write(tx, ctx, "DELETE FROM sessions WHERE token=? OR seen<=? OR created<=?", hash(old), now-g.idle, now-g.absolute); err != nil {
		return err
	}
	if err := write(tx, ctx, "DELETE FROM sessions WHERE id IN (SELECT id FROM sessions ORDER BY seen DESC,created DESC,rowid DESC LIMIT -1 OFFSET ?)", g.maxSessions-1); err != nil {
		return err
	}
	return write(tx, ctx, "INSERT INTO sessions(id,token,created,seen,stepped) VALUES(?,?,?,?,?)", randomText(random(12)), hash(token), now, now, step)
}
func (g *gateway) loginDone(w http.ResponseWriter, r *http.Request, token, next string, asJSON bool) {
	setCookie(w, sessionCookie, token, int(g.absolute))
	setCookie(w, preCookie, "", -1)
	setCookie(w, csrfCookie, "", -1)
	next = safePath(next)
	to := next
	switch {
	case next == "/browser" || strings.HasPrefix(next, "/browser/"):
		to = "/_auth/browser"
	case !strings.HasPrefix(next, "/_auth/"):
		to = nextURL("/_auth/dsh", next)
	}
	if asJSON {
		writeJSON(w, map[string]string{"next": to})
		return
	}
	http.Redirect(w, r, to, http.StatusSeeOther)
}

func (g *gateway) verify(w http.ResponseWriter, r *http.Request) {
	security(w)
	if r.URL.Path == "/health" {
		if _, err := g.account(r.Context()); err != nil {
			unavailable(w)
			return
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != "GET" || r.URL.Path != "/verify" || !g.fromEdge(r) ||
		r.Header.Get("X-Forwarded-Proto") != "https" || r.Header.Get("X-Forwarded-Host") != g.host {
		http.NotFound(w, r)
		return
	}
	uri, method := r.Header.Get("X-Forwarded-Uri"), r.Header.Get("X-Forwarded-Method")
	if _, err := g.session(r); err == nil {
		w.WriteHeader(http.StatusNoContent)
		return
	} else if !errors.Is(err, sql.ErrNoRows) {
		unavailable(w)
		return
	}
	if document(r, method, uri) {
		http.Redirect(w, r, nextURL("/_auth/login", uri), http.StatusSeeOther)
		return
	}
	http.Error(w, "Authentication required", http.StatusUnauthorized)
}
func (g *gateway) csrf(r *http.Request) bool {
	if r.Header.Get("Origin") != g.origin {
		return false
	}
	provided := r.Header.Get("X-CSRF-Token")
	if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		if err := r.ParseForm(); err != nil {
			return false
		}
		provided = r.PostForm.Get("csrf")
	}
	want := cookie(r, csrfCookie)
	return len(want) == 43 && equal(want, provided)
}
func (g *gateway) allow(w http.ResponseWriter, r *http.Request, kind string) bool {
	// A global budget bounds hash/audit work even if a client rotates IPs.
	now := time.Now().Unix() / 60
	address := ip(r)
	if address == g.edge {
		components := strings.Split(r.Header.Get("X-Forwarded-For"), ",")
		if candidate := strings.TrimSpace(components[len(components)-1]); net.ParseIP(candidate) != nil {
			address = candidate
		}
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.limits == nil {
		g.limits = make(map[string]*limit)
	}
	l := g.limits[kind]
	if l == nil || l.minute != now {
		l = &limit{minute: now, ips: make(map[string]int)}
		g.limits[kind] = l
	}
	if l.total >= 120 || l.ips[address] >= 10 {
		w.Header().Set("Retry-After", "60")
		http.Error(w, "Too many attempts", http.StatusTooManyRequests)
		return false
	}
	l.total++
	l.ips[address]++
	return true
}
func (g *gateway) failure(r *http.Request, event string) {
	if err := audit(g.db, r.Context(), event); err != nil {
		slog.Error("could not record auth event", "event", event)
	}
}
func writeJSON(w http.ResponseWriter, value any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(value)
}
func (g *gateway) public(w http.ResponseWriter, r *http.Request) {
	security(w)
	if !g.fromEdge(r) || r.Host != g.host {
		http.NotFound(w, r)
		return
	}
	if strings.EqualFold(r.Header.Get("Upgrade"),"websocket") {
		g.websocket(w,r)
		return
	}
	if r.Method == "POST" {
		r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
		if !g.csrf(r) {
			invalid(w)
			return
		}
	} else if r.Method != "GET" {
		w.Header().Set("Allow", "GET, POST")
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	route := r.Method + " " + r.URL.Path
	switch route {
	case "GET /_auth/", "GET /_auth/login":
		g.render(w, r, page{View: "login", Title: "登录", Next: safePath(r.URL.Query().Get("next"))})
		return
	case "POST /_auth/password":
		if g.allow(w, r, "password") {
			g.password(w, r)
		}
		return
	case "GET /_auth/totp", "GET /_auth/recovery":
		if len(cookie(r, preCookie)) != 43 {
			http.Redirect(w, r, "/_auth/login", 303)
			return
		}
		view := strings.TrimPrefix(r.URL.Path, "/_auth/")
		title := "输入动态验证码"
		if view == "recovery" {
			title = "使用恢复码"
		}
		g.render(w, r, page{View: view, Title: title, Next: safePath(r.URL.Query().Get("next"))})
		return
	case "POST /_auth/totp", "POST /_auth/recovery":
		if g.allow(w, r, "factor") {
			g.factor(w, r, r.URL.Path == "/_auth/recovery")
		}
		return
	case "POST /_auth/passkey/login/begin", "POST /_auth/passkey/login/finish":
		if g.allow(w, r, route) {
			g.passkeyLogin(w, r, strings.HasSuffix(route, "/begin"))
		}
		return
	case "GET /_auth/style.css":
		w.Header().Set("Content-Type", "text/css; charset=utf-8")
		_, _ = w.Write(styleCSS)
		return
	case "GET /_auth/passkey.js":
		w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
		_, _ = w.Write(passkeyJS)
		return
	}

	s, err := g.session(r)
	if errors.Is(err, sql.ErrNoRows) {
		if document(r, r.Method, r.URL.RequestURI()) {
			http.Redirect(w, r, nextURL("/_auth/login", r.URL.RequestURI()), 303)
		} else {
			http.Error(w, "Authentication required", 401)
		}
		return
	}
	if err != nil {
		unavailable(w)
		return
	}
	switch route {
	case "GET /_auth/dsh":
		g.dsh(w, r)
	case "GET /_auth/browser":
		g.openBrowser(w, r)
	case "POST /_auth/control/record":
		// Start/stop the browser recording (#31). The action is a fixed enum so a
		// caller cannot reach an arbitrary Provider route through this endpoint.
		action := r.PostForm.Get("action")
		if action != "start" && action != "stop" {
			http.Error(w, "invalid recording action", http.StatusBadRequest)
			return
		}
		if err := g.provider(r, "POST", "/record/"+action, strings.NewReader("{}"), nil); err != nil {
			g.failure(r, "browser_record_denied")
			http.Error(w, "recording refused", http.StatusConflict)
			return
		}
		g.failure(r, "browser_record_"+action)
		writeJSON(w, map[string]string{"recording": action})
	case "POST /_auth/control/takeover":
		// JSON counterpart of the control page's takeover button, for the sidebar
		// plugin (#29). CSRF is already enforced by `csrf(r)` above for every POST,
		// so this cannot be driven from another origin.
		if err := g.provider(r, "POST", "/takeover", strings.NewReader("{}"), nil); err != nil {
			g.failure(r, "browser_takeover_denied")
			http.Error(w, "takeover refused", http.StatusConflict)
			return
		}
		g.failure(r, "browser_takeover")
		writeJSON(w, map[string]string{"state": "HUMAN"})
	case "GET /_auth/control/state":
		// Read-only JSON for the Sidebar plugin (#29): it polls this to open the
		// browser tab when the Agent takes the lease. Session-authenticated like
		// every other /_auth/ route; the Provider credential never leaves this
		// process.
		var status browserStatus
		if err := g.provider(r, "GET", "/status", nil, &status); err != nil {
			unavailable(w)
			return
		}
		writeJSON(w, status)
	case "POST /_auth/control":
		g.controlAction(w, r)
	case "GET /mgmt", "GET /_auth/operations":
		g.operationsPage(w, r, s)
	case "GET /mgmt/backup":
		g.backupPage(w, r, s)
	case "POST /mgmt/runtime":
		g.runtimeControl(w, r, s)
	case "GET /_auth/stepup":
		g.stepUpPage(w, r, s)
	case "POST /_auth/stepup":
		g.stepUp(w, r, s)
	case "GET /mgmt/browser", "GET /_auth/control":
		g.controlPage(w, r)
	case "GET /mgmt/account", "GET /_auth/account":
		g.accountPage(w, r, s)
	case "POST /_auth/logout", "POST /_auth/sessions/revoke", "POST /_auth/sessions/revoke-all":
		g.revoke(w, r, s)
	case "POST /_auth/passkey/register/begin", "POST /_auth/passkey/register/finish", "POST /_auth/passkey/remove",
		"POST /_auth/recovery/regenerate", "POST /_auth/password/change", "POST /_auth/totp/rotate", "POST /_auth/totp/confirm":
		// The session was created by a TOTP-verified login, and it dies with the
		// idle/absolute timeout. Asking for the code again inside that window adds
		// no protection: whoever holds the cookie already passed the factor, and a
		// fresh prompt only trains the operator to keep the secret at hand.
		if !g.stepped(s) {
			invalid(w)
			return
		}
		if g.allow(w, r, "account_change") {
			g.securityChange(w, r, s)
		}
	default:
		http.NotFound(w, r)
	}
}

func (g *gateway) verifyPassword(r *http.Request, a account, submitted string) bool {
	salt, want := a.salt, a.verifier
	if len(salt) != 16 {
		salt, want = make([]byte, 16), make([]byte, 32)
	}
	if len(submitted) > 256 {
		submitted = ""
	}
	select {
	case g.hashSlots <- struct{}{}:
		defer func() { <-g.hashSlots }()
		return equal(string(passwordKey(submitted, salt)), string(want))
	case <-r.Context().Done():
		return false
	default:
		return false
	}
}

func (g *gateway) password(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	a, err := g.account(ctx)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		unavailable(w)
		return
	}
	next := safePath(r.PostForm.Get("next"))
	ok := g.verifyPassword(r, a, r.PostForm.Get("password"))
	if !ok || !a.enabled || !equal(a.user, r.PostForm.Get("username")) {
		g.failure(r, "password_failed")
		g.render(w, r, page{Status: 401, View: "login", Title: "登录", Next: next, Error: "登录失败。"})
		return
	}
	challenge, err := g.challenge(ctx, "password", "", encodeEpoch(a.epoch), 300)
	if err != nil {
		unavailable(w)
		return
	}
	setCookie(w, preCookie, challenge, 300)
	http.Redirect(w, r, nextURL("/_auth/totp", next), http.StatusSeeOther)
}
func (g *gateway) factor(w http.ResponseWriter, r *http.Request, recovery bool) {
	ctx := r.Context()
	ch := cookie(r, preCookie)
	next := safePath(r.PostForm.Get("next"))
	title, view, event := "输入动态验证码", "totp", "login_totp"
	if recovery {
		title, view, event = "使用恢复码", "recovery", "login_recovery"
	}
	fail := func() {
		g.failure(r, event+"_failed")
		g.render(w, r, page{Status: 401, View: view, Title: title, Next: next, Error: "验证码无效、已使用或会话已过期。"})
	}
	if len(ch) != 43 {
		fail()
		return
	}
	a, err := g.account(ctx)
	if err != nil {
		unavailable(w)
		return
	}
	var step int64
	code := strings.TrimSpace(r.PostForm.Get("code"))
	if !recovery {
		seed, err := g.open(a.seed)
		if err != nil {
			unavailable(w)
			return
		}
		var valid bool
		step, valid = matchTOTP(seed, code, time.Now())
		if !valid {
			fail()
			return
		}
	}
	token := randomText(random(32))
	err = g.change(ctx, event, func(tx *sql.Tx) error {
		if err := one(tx, ctx, "DELETE FROM challenges WHERE token=? AND kind='password' AND expires>? AND data=(SELECT CAST(epoch AS BLOB) FROM account WHERE id=1 AND enabled=1)",
			hash(ch), time.Now().Unix()); err != nil {
			return err
		}
		if recovery {
			if err := one(tx, ctx, "DELETE FROM recovery WHERE digest=?", hash(code)); err != nil {
				return err
			}
		} else if err := one(tx, ctx, "UPDATE account SET last_step=? WHERE id=1 AND enabled=1 AND epoch=? AND last_step<?", step, a.epoch, step); err != nil {
			return err
		}
		return g.newSession(ctx, tx, token, cookie(r, sessionCookie), true)
	})
	if errors.Is(err, errDenied) {
		fail()
		return
	}
	if err != nil {
		unavailable(w)
		return
	}
	g.loginDone(w, r, token, next, false)
}
func (g *gateway) revoke(w http.ResponseWriter, r *http.Request, s session) {
	ctx := r.Context()
	target := r.PostForm.Get("id")
	if r.URL.Path == "/_auth/logout" {
		target = s.ID
	}
	all := r.URL.Path == "/_auth/sessions/revoke-all"
	event := "session_revoked"
	if all {
		event = "sessions_revoked"
	}
	if err := g.change(ctx, event, func(tx *sql.Tx) error {
		if all {
			return write(tx, ctx, "DELETE FROM sessions; DELETE FROM challenges;")
		}
		if err := write(tx, ctx, "DELETE FROM challenges WHERE session=?", target); err != nil {
			return err
		}
		return write(tx, ctx, "DELETE FROM sessions WHERE id=?", target)
	}); err != nil {
		unavailable(w)
		return
	}
	if all || target == s.ID {
		setCookie(w, sessionCookie, "", -1)
		setCookie(w, csrfCookie, "", -1)
		http.Redirect(w, r, "/_auth/login", 303)
		return
	}
	http.Redirect(w, r, "/_auth/account", 303)
}
func (g *gateway) securityChange(w http.ResponseWriter, r *http.Request, s session) {
	ctx := r.Context()
	switch r.URL.Path {
	case "/_auth/passkey/register/begin", "/_auth/passkey/register/finish":
		g.passkeyRegister(w, r, s, strings.HasSuffix(r.URL.Path, "/begin"))
		return
	case "/_auth/passkey/remove":
		if err := g.change(ctx, "passkey_removed", func(tx *sql.Tx) error {
			if err := g.liveStep(ctx, tx, s); err != nil {
				return err
			}
			id, err := decodeText(r.PostForm.Get("id"))
			if err != nil {
				return errDenied
			}
			return one(tx, ctx, "DELETE FROM passkeys WHERE id=?", id)
		}); err != nil {
			invalid(w)
			return
		}
	case "/_auth/recovery/regenerate":
		var codes []string
		err := g.change(ctx, "recovery_regenerated", func(tx *sql.Tx) error {
			if err := g.liveStep(ctx, tx, s); err != nil {
				return err
			}
			var err error
			codes, err = newRecovery(tx, ctx)
			return err
		})
		if err != nil {
			unavailable(w)
			return
		}
		g.render(w, r, page{View: "codes", Title: "恢复码", Codes: codes})
		return
	case "/_auth/password/change":
		password := r.PostForm.Get("password")
		if len(password) < 12 || len(password) > 256 {
			http.Error(w, "Password must be 12–256 bytes", 400)
			return
		}
		select {
		case g.hashSlots <- struct{}{}:
			defer func() { <-g.hashSlots }()
		default:
			unavailable(w)
			return
		}
		salt := random(16)
		key := passwordKey(password, salt)
		if err := g.change(ctx, "password_changed", func(tx *sql.Tx) error {
			if err := g.liveStep(ctx, tx, s); err != nil {
				return err
			}
			if err := one(tx, ctx, "UPDATE account SET salt=?,verifier=?,epoch=epoch+1 WHERE id=1 AND enabled=1", salt, key); err != nil {
				return err
			}
			return write(tx, ctx, "DELETE FROM sessions; DELETE FROM challenges;")
		}); err != nil {
			unavailable(w)
			return
		}
		setCookie(w, sessionCookie, "", -1)
		http.Redirect(w, r, "/_auth/login", 303)
		return
	case "/_auth/totp/rotate":
		seed := random(20)
		token, err := g.challenge(ctx, "totp_rotate", s.ID, g.seal(seed), 300)
		if err != nil {
			unavailable(w)
			return
		}
		g.render(w, r, page{View: "rotate", Title: "更换动态验证器", Key: totpEncoding.EncodeToString(seed), Challenge: token})
		return
	case "/_auth/totp/confirm":
		data, err := g.takeChallenge(ctx, "totp_rotate", s.ID, r.PostForm.Get("challenge"))
		if err != nil {
			invalid(w)
			return
		}
		seed, err := g.open(data)
		if err != nil {
			unavailable(w)
			return
		}
		step, ok := matchTOTP(seed, r.PostForm.Get("code"), time.Now())
		if !ok {
			invalid(w)
			return
		}
		if err := g.change(ctx, "totp_changed", func(tx *sql.Tx) error {
			if err := g.liveStep(ctx, tx, s); err != nil {
				return err
			}
			if err := one(tx, ctx, "UPDATE account SET seed=?,last_step=?,epoch=epoch+1 WHERE id=1 AND enabled=1", data, step); err != nil {
				return err
			}
			if err := write(tx, ctx, "DELETE FROM sessions WHERE id!=?", s.ID); err != nil {
				return err
			}
			return write(tx, ctx, "DELETE FROM challenges")
		}); err != nil {
			unavailable(w)
			return
		}
	}
	http.Redirect(w, r, "/_auth/account", 303)
}

func leaseTTL(raw string) int {
	seconds, err := strconv.Atoi(raw)
	if err != nil || seconds < 10 || seconds > 120 {
		return 0
	}
	return seconds * 1000
}
