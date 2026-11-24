package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strings"
	"time"
)

const dshUpstream = "https://dsh-workstation-runtime:3080"

func readSecret(name string) (string, error) {
	data, err := os.ReadFile("/run/secrets/" + name)
	if err != nil {
		return "", err
	}
	value := strings.TrimSpace(string(data))
	if len(value) != 64 {
		return "", errors.New("invalid secret length")
	}
	return value, nil
}
// initRuntime wires the DSH client. It has nothing to do with the browser: DSH is
// served by the Runtime in every deployment shape, so these fields must be set
// even when no Chromium exists. They used to live in initBrowser, which left
// dshClient and dshWS nil in a core deployment and panicked the first time an
// authenticated request reached /_auth/dsh.
func (g *gateway) initRuntime() error {
	full, err := os.ReadFile("/run/secrets/runtime_ca")
	if err != nil {
		return errors.New("could not load Runtime CA")
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(full) {
		return errors.New("invalid Runtime CA")
	}
	g.dshClient = &http.Client{Timeout: 5 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		Transport:     &http.Transport{TLSClientConfig: &tls.Config{RootCAs: pool, ServerName: "runtime", MinVersion: tls.VersionTLS12}},
	}
	g.dshWS = g.socketProxy(dshUpstream, g.dshClient.Transport)
	return nil
}

// initBrowser wires only what the browser stack provides. A core deployment
// skips it entirely.
func (g *gateway) initBrowser() error {
	var err error
	if g.browserToken, err = readSecret("m0_controller"); err != nil {
		return errors.New("could not load browser controller credential")
	}
	if g.providerAdmin, err = readSecret("m0_admin"); err != nil {
		return errors.New("could not load provider admin credential")
	}
	// Input authority is enforced at the gate, not here: the operator's data
	// socket goes through it so held input can be released before a handover
	// (ADR-0005). Static assets and the video pane still talk to Chromium
	// directly, because only the input boundary needs the gate in its path.
	g.browserWS = g.socketProxy(g.browserUpstream, &http.Transport{ResponseHeaderTimeout: 6 * time.Second})
	// Everything else under /browser/ that upgrades goes straight to Selkies.
	g.browserDirectWS = g.socketProxy(g.browserDirect, &http.Transport{ResponseHeaderTimeout: 6 * time.Second})
	return nil
}

func (g *gateway) socketProxy(address string, transport http.RoundTripper) *httputil.ReverseProxy {
	upstream, _ := url.Parse(address)
	return &httputil.ReverseProxy{
		Transport: transport,
		Rewrite: func(req *httputil.ProxyRequest) {
			req.SetURL(upstream)
			req.Out.Host = g.host
			req.Out.Header.Set("X-Forwarded-Host", g.host)
			req.Out.Header.Set("X-Forwarded-Proto", "https")
			req.Out.Header.Del("Selkies-Authorization")
		},
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, _ error) { unavailable(w) },
	}
}

func (g *gateway) websocket(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" || r.Header.Get("Origin") != g.origin {
		invalid(w)
		return
	}
	s, err := g.session(r)
	if err != nil {
		http.Error(w, "Authentication required", http.StatusUnauthorized)
		return
	}
	proxy := g.dshWS
	if strings.HasPrefix(r.URL.Path, "/browser/") {
		if strings.HasPrefix(r.URL.Path, "/browser/api/tokens") {
			http.NotFound(w, r)
			return
		}
		// A core deployment runs no Chromium, so there is nothing to upgrade
		// to. Say so, rather than proxying to an address that never answers.
		if !g.browserEnabled {
			http.Error(w, "The browser is not part of this deployment", http.StatusServiceUnavailable)
			return
		}
		// Only the data socket carries input, so only it goes through the gate.
		// Any other browser WebSocket keeps talking to Selkies directly, which
		// keeps the gate's surface to the one connection it must own.
		if r.URL.Path == "/browser/api/websockets" {
			proxy = g.browserWS
		} else {
			proxy = g.browserDirectWS
		}
	} else if strings.HasPrefix(r.URL.Path, "/_auth/") {
		http.NotFound(w,r)
		return
	}
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	go func() {
		tick := time.NewTicker(2 * time.Second)
		defer tick.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case now := <-tick.C:
				check, done := context.WithTimeout(ctx, time.Second)
				var live bool
				err := g.db.QueryRowContext(check, "SELECT EXISTS(SELECT 1 FROM sessions WHERE id=? AND seen>? AND created>? AND EXISTS(SELECT 1 FROM account WHERE id=1 AND enabled=1))",
					s.ID, now.Unix()-g.idle, now.Unix()-g.absolute).Scan(&live)
				done()
				if err != nil || !live {
					cancel()
					return
				}
			}
		}
	}()
	// ReverseProxy closes the upstream upgraded connection when this context ends.
	proxy.ServeHTTP(w, r.WithContext(ctx))
}

func (g *gateway) dsh(w http.ResponseWriter, r *http.Request) {
	data, err := os.ReadFile("/run/dsh-runtime/launch-url")
	if err != nil {
		unavailable(w)
		return
	}
	launch, err := url.Parse(strings.TrimSpace(string(data)))
	if err != nil || launch.Scheme != "https" || launch.Host != g.host || launch.Path != "/" || launch.User != nil || launch.Fragment != "" ||
		len(launch.Query()) != 1 || len(launch.Query()["token"]) != 1 || launch.Query().Get("token") == "" {
		unavailable(w)
		return
	}
	request, err := http.NewRequestWithContext(r.Context(), "GET", dshUpstream+"/?"+launch.RawQuery, nil)
	if err != nil {
		unavailable(w)
		return
	}
	request.Host = g.host
	response, err := g.dshClient.Do(request)
	if err != nil {
		unavailable(w)
		return
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusSeeOther {
		unavailable(w)
		return
	}
	for _, c := range response.Cookies() {
		if strings.HasPrefix(c.Name, "dsh-auth-") && c.Secure && c.HttpOnly && c.Domain == "" && c.Path == "/" && c.SameSite == http.SameSiteStrictMode {
			http.SetCookie(w, c)
			http.Redirect(w, r, safePath(r.URL.Query().Get("next")), http.StatusSeeOther)
			return
		}
	}
	unavailable(w)
}
func (g *gateway) openBrowser(w http.ResponseWriter, r *http.Request) {
	if !g.browserEnabled {
		http.Error(w, "The browser is not part of this deployment", http.StatusServiceUnavailable)
		return
	}
	http.Redirect(w, r, "/browser/#token="+url.QueryEscape(g.browserToken), http.StatusSeeOther)
}

type peer struct {
	ID, Label string
	Tab       bool
}
type browserStatus struct {
	State, Reason string
	Peers         []peer
}

var providerHTTP = &http.Client{
	Timeout:       8 * time.Second,
	CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
}

func (g *gateway) provider(r *http.Request, method, route string, body io.Reader, result any) error {
	// The provider's control listener address comes from configuration, so this
	// code carries no copy of the default subnet.
	controlAddr := g.providerControlAddr
	if controlAddr == "" {
		controlAddr = "172.30.233.2:8081"
	}
	request, err := http.NewRequestWithContext(r.Context(), method,
		"http://"+controlAddr+route, body)
	if err != nil {
		return err
	}
	request.Header.Set("Authorization", "Bearer "+g.providerAdmin)
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := providerHTTP.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return errors.New("provider rejected request")
	}
	if result != nil {
		return json.NewDecoder(io.LimitReader(response.Body, 16<<10)).Decode(result)
	}
	return nil
}
func (g *gateway) controlPage(w http.ResponseWriter, r *http.Request) {
	var status browserStatus
	p := page{View: "control", Title: "浏览器控制", Control: status}
	if err := g.provider(r, "GET", "/status", nil, &p.Control); err != nil {
		p.Error = "浏览器控制服务不可用。"
	}
	if r.URL.Query().Get("failed") == "1" {
		p.Error = "浏览器未接受此操作。"
	}
	g.render(w, r, p)
}
func (g *gateway) controlAction(w http.ResponseWriter, r *http.Request) {
	action := r.PostForm.Get("action")
	var args any = struct{}{}
	switch action {
	case "grant":
		ttl := leaseTTL(r.PostForm.Get("seconds"))
		id := r.PostForm.Get("peer")
		if ttl == 0 || len(id) != 36 {
			http.Error(w, "Invalid lease", 400)
			return
		}
		args = map[string]any{"peer": id, "ttl": ttl}
	case "recover", "takeover":
	default:
		http.NotFound(w, r)
		return
	}
	body, _ := json.Marshal(args)
	location := "/_auth/control"
	if err := g.provider(r, "POST", "/"+action, strings.NewReader(string(body)), nil); err != nil {
		location += "?failed=1"
		g.failure(r, "browser_"+action+"_denied")
	} else {
		g.failure(r, "browser_"+action)
	}
	http.Redirect(w, r, location, http.StatusSeeOther)
}
