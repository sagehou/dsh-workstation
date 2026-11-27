package main

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

// A core deployment (deploy/public/compose.core.yml) runs no Chromium, gate or
// provider. Without browserEnabled the socket proxy would forward /browser/ to an
// address nothing listens on, which a browser reports as a socket that never
// opens -- the same symptom as a hung gate. These tests pin the refusal.

func loginForBrowserTest(t *testing.T) (*gateway, *http.Cookie) {
	t.Helper()
	g, codes, _ := newTestGateway(t)
	csrf := named(request(g, req(g, "GET", "/_auth/login", nil)), csrfCookie)
	password := url.Values{"csrf": {csrf.Value}, "username": {"operator"}, "password": {"ci-only password"}}
	pre := named(request(g, req(g, "POST", "/_auth/password", password, csrf)), preCookie)
	form := url.Values{"csrf": {csrf.Value}, "code": {codes[0]}}
	finish := request(g, req(g, "POST", "/_auth/recovery", form, csrf, pre))
	response(t, finish, 303)
	sess := named(finish, sessionCookie)
	if sess == nil {
		t.Fatal("login produced no session cookie")
	}
	return g, sess
}

func TestCoreDeploymentRefusesBrowserSocket(t *testing.T) {
	g, sess := loginForBrowserTest(t)
	g.browserEnabled = false

	for _, path := range []string{"/browser/api/websockets", "/browser/api/websockets/", "/browser/"} {
		r := req(g, "GET", path, nil, sess)
		r.Header.Set("Origin", g.origin)
		r.Header.Set("Upgrade", "websocket")
		r.Header.Set("Connection", "Upgrade")
		w := httptest.NewRecorder()
		g.websocket(w, r)

		if w.Code != http.StatusServiceUnavailable {
			t.Fatalf("%s: got %d, want 503 (the core refusal)", path, w.Code)
		}
		if !strings.Contains(w.Body.String(), "not part of this deployment") {
			t.Fatalf("%s: refusal did not name the reason: %q", path, w.Body.String())
		}
	}
}

// The refusal must be about the deployment shape, not about being unable to
// reach an upstream: an enabled gateway with an unreachable upstream is a
// different (and louder) failure, so this asserts the two are distinguishable.
func TestCoreRefusalIsNotAProxyFailure(t *testing.T) {
	g, sess := loginForBrowserTest(t)
	g.browserEnabled = false

	r := req(g, "GET", "/browser/api/websockets", nil, sess)
	r.Header.Set("Origin", g.origin)
	w := httptest.NewRecorder()
	g.websocket(w, r)

	if w.Code == http.StatusBadGateway {
		t.Fatal("core refusal surfaced as a proxy failure; it must name the shape")
	}
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("got %d, want 503", w.Code)
	}
}

// The DSH client is not browser state. A core deployment skips initBrowser, and
// when dshClient lived there it was nil, so the first authenticated /_auth/dsh
// request panicked the handler. This asserts the split: initRuntime must be what
// supplies the DSH client, whatever the deployment shape.
func TestDSHClientIsNotBrowserState(t *testing.T) {
	g, _ := loginForBrowserTest(t)
	// No initBrowser call, mirroring a core deployment.
	if g.dshClient != nil {
		t.Fatal("dshClient was already set; the test no longer mirrors a core start")
	}
	if err := g.initRuntime(); err != nil {
		// The CI fixture has no /run/secrets/runtime_ca; reaching this error means
		// the function ran and failed on its input rather than on a missing field.
		t.Skipf("initRuntime needs the Runtime CA, which this fixture does not provide: %v", err)
	}
	if g.dshClient == nil {
		t.Fatal("initRuntime left dshClient nil")
	}
	if g.dshWS == nil {
		t.Fatal("initRuntime left dshWS nil")
	}
	if g.browserWS != nil || g.browserDirectWS != nil {
		t.Fatal("initRuntime set browser proxies; those belong to initBrowser")
	}
}

// /_auth/browser hands the operator a link to /browser/. In a core deployment
// there is nothing behind that link, so the redirect must not be issued.
func TestCoreDeploymentRefusesOpenBrowser(t *testing.T) {
	g, sess := loginForBrowserTest(t)
	g.browserEnabled = false

	r := req(g, "GET", "/_auth/browser", nil, sess)
	w := httptest.NewRecorder()
	g.openBrowser(w, r)

	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("got %d, want 503", w.Code)
	}
	if loc := w.Header().Get("Location"); strings.Contains(loc, "/browser/") {
		t.Fatalf("core deployment issued a redirect to %q", loc)
	}
}

func TestBrowserAvailability(t *testing.T) {
	g, sess := loginForBrowserTest(t)
	const path = "/_auth/browser-available"
	response(t, request(g, req(g, "GET", path, nil)), http.StatusUnauthorized)
	response(t, request(g, req(g, "GET", path, nil, sess)), http.StatusNotFound)
	g.browserEnabled = true
	response(t, request(g, req(g, "GET", path, nil, sess)), http.StatusNoContent)
}
