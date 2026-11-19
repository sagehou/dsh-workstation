package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"time"

	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/webauthn"
)

var decodeText = base64.RawURLEncoding.DecodeString

type passkeyUser struct {
	account
	credentials []webauthn.Credential
}

func (u passkeyUser) WebAuthnID() []byte                         { return u.handle }
func (u passkeyUser) WebAuthnName() string                       { return u.user }
func (u passkeyUser) WebAuthnDisplayName() string                { return u.user }
func (u passkeyUser) WebAuthnCredentials() []webauthn.Credential { return u.credentials }

type ceremony struct {
	Epoch int64
	Data  webauthn.SessionData
}

func (g *gateway) credentialUser(ctx context.Context) (u passkeyUser, err error) {
	u.account, err = g.account(ctx)
	if err != nil || !u.enabled {
		return u, errDenied
	}
	rows, err := g.db.QueryContext(ctx, "SELECT data FROM passkeys")
	if err != nil {
		return u, err
	}
	defer rows.Close()
	for rows.Next() {
		var data []byte
		var credential webauthn.Credential
		if err := rows.Scan(&data); err != nil {
			return u, err
		}
		if err := json.Unmarshal(data, &credential); err != nil {
			return u, err
		}
		u.credentials = append(u.credentials, credential)
	}
	return u, rows.Err()
}

func (g *gateway) passkeyLogin(w http.ResponseWriter, r *http.Request, begin bool) {
	ctx := r.Context()
	fail := func() {
		g.failure(r, "passkey_failed")
		http.Error(w, "Passkey sign-in failed", http.StatusUnauthorized)
	}
	if begin {
		a, err := g.account(ctx)
		if err != nil {
			unavailable(w)
			return
		}
		options, session, err := g.wa.BeginDiscoverableLogin(webauthn.WithUserVerification(protocol.VerificationRequired))
		if err != nil {
			unavailable(w)
			return
		}
		data, err := json.Marshal(ceremony{a.epoch, *session})
		if err != nil {
			unavailable(w)
			return
		}
		token, err := g.challenge(ctx, "passkey_login", "", data, 120)
		if err != nil {
			unavailable(w)
			return
		}
		setCookie(w, loginChallenge, token, 120)
		writeJSON(w, options)
		return
	}
	challenge, err := g.takeChallenge(ctx, "passkey_login", "", cookie(r, loginChallenge))
	setCookie(w, loginChallenge, "", -1)
	var c ceremony
	if err != nil || json.Unmarshal(challenge, &c) != nil {
		fail()
		return
	}
	u, err := g.credentialUser(ctx)
	if err != nil || u.epoch != c.Epoch {
		fail()
		return
	}
	credential, err := g.wa.FinishDiscoverableLogin(func(_, handle []byte) (webauthn.User, error) {
		if !bytes.Equal(handle, u.handle) {
			return nil, errDenied
		}
		return u, nil
	}, c.Data, r)
	if err != nil || credential.Authenticator.CloneWarning {
		fail()
		return
	}
	old := []byte(nil)
	for _, previous := range u.credentials {
		if bytes.Equal(previous.ID, credential.ID) {
			old, err = json.Marshal(previous)
			break
		}
	}
	data, err := json.Marshal(credential)
	if err != nil || old == nil {
		fail()
		return
	}
	token := randomText(random(32))
	if err := g.change(ctx, "login_passkey", func(tx *sql.Tx) error {
		// Compare the previous record so a concurrent assertion cannot roll its counter back.
		if err := one(tx, ctx, "UPDATE passkeys SET data=? WHERE id=? AND data=? AND EXISTS(SELECT 1 FROM account WHERE id=1 AND enabled=1 AND epoch=?)", data, credential.ID, old, c.Epoch); err != nil {
			return err
		}
		return g.newSession(ctx, tx, token, cookie(r, sessionCookie), true)
	}); err != nil {
		fail()
		return
	}
	g.loginDone(w, r, token, r.URL.Query().Get("next"), true)
}
func (g *gateway) liveStep(ctx context.Context, tx *sql.Tx, s session) error {
	now := time.Now().Unix()
	var id string
	return tx.QueryRowContext(ctx, "SELECT id FROM sessions WHERE id=? AND stepped>? AND seen>? AND created>? AND EXISTS(SELECT 1 FROM account WHERE id=1 AND enabled=1)",
		s.ID, now-300, now-g.idle, now-g.absolute).Scan(&id)
}
func (g *gateway) passkeyRegister(w http.ResponseWriter, r *http.Request, s session, begin bool) {
	ctx := r.Context()
	u, err := g.credentialUser(ctx)
	if err != nil || len(u.credentials) >= 16 {
		invalid(w)
		return
	}
	if begin {
		exclude := make([]protocol.CredentialDescriptor, 0, len(u.credentials))
		for _, credential := range u.credentials {
			exclude = append(exclude, credential.Descriptor())
		}
		options, session, err := g.wa.BeginRegistration(u, webauthn.WithExclusions(exclude))
		if err != nil {
			unavailable(w)
			return
		}
		data, err := json.Marshal(ceremony{u.epoch, *session})
		if err != nil {
			unavailable(w)
			return
		}
		token, err := g.challenge(ctx, "passkey_register", s.ID, data, 120)
		if err != nil {
			unavailable(w)
			return
		}
		writeJSON(w, map[string]any{"options": options, "challenge": token})
		return
	}
	received, err := g.takeChallenge(ctx, "passkey_register", s.ID, r.Header.Get("X-WebAuthn-Challenge"))
	var c ceremony
	if err != nil || json.Unmarshal(received, &c) != nil || c.Epoch != u.epoch {
		invalid(w)
		return
	}
	credential, err := g.wa.FinishRegistration(u, c.Data, r)
	if err != nil {
		g.failure(r, "passkey_registration_failed")
		invalid(w)
		return
	}
	data, err := json.Marshal(credential)
	if err != nil {
		unavailable(w)
		return
	}
	label := time.Now().UTC().Format("2006-01-02 15:04 UTC")
	if err := g.change(ctx, "passkey_added", func(tx *sql.Tx) error {
		if err := g.liveStep(ctx, tx, s); err != nil {
			return err
		}
		return one(tx, ctx, "INSERT INTO passkeys(id,label,data) SELECT ?,?,? WHERE (SELECT count(*) FROM passkeys)<16 AND EXISTS(SELECT 1 FROM account WHERE id=1 AND epoch=?)", credential.ID, label, data, c.Epoch)
	}); err != nil {
		invalid(w)
		return
	}
	writeJSON(w, map[string]string{"next": "/_auth/account"})
}
