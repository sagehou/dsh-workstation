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
