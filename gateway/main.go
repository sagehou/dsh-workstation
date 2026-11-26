package main

import (
	"bufio"
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/webauthn"
	"golang.org/x/term"
)

var userPattern = regexp.MustCompile("^[a-zA-Z0-9][a-zA-Z0-9_.@-]{0,63}$")

func env(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}
func gatewayEnv(name, fallback string) string {
	return env("GATEWAY_"+name, env("AUTH_"+name, fallback))
}
func duration(name, fallback string) int64 {
	d, err := time.ParseDuration(gatewayEnv(name, fallback))
	if err != nil || d < time.Minute || d > 30*24*time.Hour {
		panic("invalid session duration")
	}
	return int64(d / time.Second)
}

func run() error {
	ctx := context.Background()
	command := "serve"
	if len(os.Args) > 1 {
		command = os.Args[1]
	}
	verifyAddr := gatewayEnv("VERIFY_ADDR", "172.30.242.3:8081")
	if command == "health" {
		client := &http.Client{Timeout: 2 * time.Second}
		response, err := client.Get("http://" + verifyAddr + "/health")
		if err != nil {
			return err
		}
		response.Body.Close()
		if response.StatusCode != 204 {
			return errors.New("gateway not ready")
		}
		return nil
	}
	origin := os.Getenv("PUBLIC_ORIGIN")
	u, err := url.Parse(origin)
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || origin != "https://"+u.Host {
		return errors.New("PUBLIC_ORIGIN must be a bare HTTPS origin")
	}
	box, err := loadKey(gatewayEnv("KEY_FILE", "/run/secrets/auth_key"))
	if err != nil {
		return errors.New("could not load auth master key")
	}
	s, err := openStore(gatewayEnv("DB", "/data/auth.sqlite"), box)
	if err != nil {
		return errors.New("could not open auth store")
	}
	defer s.db.Close()

	switch command {
	case "bootstrap":
		_, err := s.account(ctx)
		if !errors.Is(err, sql.ErrNoRows) {
			return errors.New("bootstrap is unavailable")
		}
		if len(os.Args) != 3 || !userPattern.MatchString(os.Args[2]) {
			return errors.New("usage: workstation-gateway bootstrap USER")
		}
		user := os.Args[2]
		input := bufio.NewScanner(io.LimitReader(os.Stdin, 4096))
		line := func() string {
			if !input.Scan() {
				return ""
			}
			return strings.TrimSpace(input.Text())
		}
		var password, code string
		var seed []byte
		if term.IsTerminal(int(os.Stdin.Fd())) {
			fmt.Fprint(os.Stderr, "New password (at least 12 characters): ")
			passwordBytes, err := term.ReadPassword(int(os.Stdin.Fd()))
			fmt.Fprintln(os.Stderr)
			if err != nil {
				return errors.New("could not read password")
			}
			password = string(passwordBytes)
			seed = random(20)
			fmt.Printf("TOTP key: %s\n%s\n", totpEncoding.EncodeToString(seed), otpURI(user, origin, seed))
			fmt.Fprint(os.Stderr, "Current TOTP code: ")
			code = line()
		} else {
			// CI or an offline operator can pipe password, TOTP key and code.
			if input.Scan() {
				password = input.Text()
			}
			seed, err = totpEncoding.DecodeString(strings.ToUpper(line()))
			if err != nil {
				return errors.New("invalid enrollment key")
			}
			code = line()
		}
		if len(password) < 12 || len(password) > 256 {
			return errors.New("invalid password length")
		}
		codes, err := s.bootstrap(ctx, user, password, seed, code)
		if err != nil {
			return errors.New("bootstrap failed; account unchanged")
		}
		fmt.Println("Save these recovery codes now:")
		for _, code := range codes {
			fmt.Println(code)
		}
		return nil
	case "enable", "disable":
		return s.change(ctx, "account_"+command, func(tx *sql.Tx) error {
			if err := one(tx, ctx, "UPDATE account SET enabled=?, epoch=epoch+1 WHERE id=1", command == "enable"); err != nil {
				return err
			}
			return write(tx, ctx, "DELETE FROM sessions; DELETE FROM challenges;")
		})
	case "serve":
	default:
		return errors.New("unknown gateway command")
	}
	a, err := s.account(ctx)
	if err != nil {
		return errors.New("create the admin with bootstrap before starting Gateway")
	}
	if _, err = s.open(a.seed); err != nil {
		return errors.New("auth master key does not decrypt the existing TOTP seed")
	}
	passkeys, err := webauthn.New(&webauthn.Config{
		RPDisplayName: "DSH Workstation", RPID: u.Hostname(), RPOrigins: []string{origin},
		AuthenticatorSelection: protocol.AuthenticatorSelection{
			ResidentKey: protocol.ResidentKeyRequirementRequired, UserVerification: protocol.VerificationRequired,
		},
	})
	if err != nil {
		return errors.New("invalid WebAuthn configuration")
	}
	max, err := strconv.Atoi(gatewayEnv("MAX_SESSIONS", "8"))
	idle, absolute := duration("IDLE", "30m"), duration("ABSOLUTE", "12h")
	if err != nil || max < 1 || max > 100 || idle > absolute {
		return errors.New("invalid session limits")
	}
	g := &gateway{store: s, origin: origin, host: u.Host, edge: gatewayEnv("EDGE_IP", "172.30.242.2"), wa: passkeys,
		// The provider's control listener. Supplied by Compose from the same
		// derivation as everything else, so a custom subnet moves it too.
		providerControlAddr: gatewayEnv("PROVIDER_CONTROL_ADDR", "172.30.233.2:8081"),
		// The Selkies data socket is reached through the input gate so held
		// input can be released before authority changes hands (ADR-0005).
		browserUpstream: gatewayEnv("BROWSER_UPSTREAM", "http://dsh-workstation-browser-gate:8082"),
		browserDirect:   gatewayEnv("BROWSER_DIRECT", "http://dsh-workstation-chromium:3000"),
		// A core deployment sets this to 0: no Chromium, gate or provider is
		// running, so /browser/ answers with a clear refusal rather than
		// proxying to an address nothing listens on.
		browserEnabled: gatewayEnv("BROWSER_ENABLED", "1") != "0",
		idle:           idle, absolute: absolute, maxSessions: max, hashSlots: make(chan struct{}, 2)}
	if net.ParseIP(g.edge) == nil {
		return errors.New("invalid GATEWAY_EDGE_IP")
	}
	// A second trusted peer, empty in production. It exists so an operator can
	// exercise the rendered pages from inside the container with curl, which the
	// edge-IP check otherwise forbids. Setting it to a real address widens the
	// trust boundary, so it is documented as a diagnostic-only knob.
	if extra := gatewayEnv("DEBUG_PEER", ""); extra != "" {
		if net.ParseIP(extra) == nil {
			return errors.New("invalid GATEWAY_DEBUG_PEER")
		}
		g.debugPeer = extra
	}
	if err := g.initRuntime(); err != nil {
		return err
	}
	if g.browserEnabled {
		if err := g.initBrowser(); err != nil {
			return err
		}
	}

	server := func(addr string, h http.HandlerFunc) *http.Server {
		return &http.Server{Addr: addr, Handler: h, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 12 * time.Second, WriteTimeout: 30 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 32 << 10}
	}
	verify := server(verifyAddr, g.verify)
	addr := gatewayEnv("ADDR", "172.30.242.3:8080")
	listener, err := net.Listen("tcp", verifyAddr)
	if err != nil {
		return err
	}
	go func() {
		if err := verify.Serve(listener); err != nil {
			slog.Error("verification listener stopped")
			os.Exit(1)
		}
	}()
	slog.Info("Gateway ready")
	return server(addr, g.public).ListenAndServe()
}

func main() {
	if err := run(); err != nil {
		slog.Error("gateway stopped", "reason", err.Error())
		os.Exit(1)
	}
}
