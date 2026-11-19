package main

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base32"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	_ "github.com/mattn/go-sqlite3"
	"golang.org/x/crypto/argon2"
)

var (
	randomText = base64.RawURLEncoding.EncodeToString
	totpEncoding = base32.StdEncoding.WithPadding(base32.NoPadding)
	errDenied = errors.New("authentication denied")
)

func random(n int) []byte {
	b := make([]byte, n)
	rand.Read(b)
	return b
}
func hash(value string) []byte {
	h := sha256.Sum256([]byte(value))
	return h[:]
}
func equal(a, b string) bool {
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}
func passwordKey(password string, salt []byte) []byte {
	return argon2.IDKey([]byte(password), salt, 3, 64*1024, 1, 32)
}
func totp(seed []byte, step int64) string {
	var counter [8]byte
	binary.BigEndian.PutUint64(counter[:], uint64(step))
	mac := hmac.New(sha1.New, seed) // RFC 6238 interoperability.
	mac.Write(counter[:])
	sum := mac.Sum(nil)
	return fmt.Sprintf("%06d", (binary.BigEndian.Uint32(sum[sum[19]&15:])&0x7fffffff)%1000000)
}
func matchTOTP(seed []byte, code string, now time.Time) (int64, bool) {
	step := now.Unix() / 30
	for _, i := range []int64{step, step-1, step+1} {
		if equal(code, totp(seed, i)) {
			return i, true
		}
	}
	return 0, false
}
func otpURI(user, origin string, seed []byte) string {
	issuer := strings.TrimPrefix(origin, "https://")
	values := url.Values{"secret": {totpEncoding.EncodeToString(seed)}, "issuer": {issuer}}
	return (&url.URL{Scheme: "otpauth", Host: "totp", Path: "/" + issuer + ":" + user, RawQuery: values.Encode()}).String()
}
func loadKey(path string) (cipher.AEAD, error) {
	raw, err := os.ReadFile(path)
	if err != nil { return nil, err }
	key, err := hex.DecodeString(strings.TrimSpace(string(raw)))
	if err != nil || len(key) != 32 { return nil, errors.New("invalid auth master key") }
	block, err := aes.NewCipher(key)
	if err != nil { return nil, err }
	return cipher.NewGCM(block)
}

type store struct {
	db *sql.DB
	box cipher.AEAD
}
func (s store) seal(data []byte) []byte {
	nonce := random(s.box.NonceSize())
	return s.box.Seal(nonce, nonce, data, nil)
}
func (s store) open(data []byte) ([]byte, error) {
	n := s.box.NonceSize()
	if len(data) < n { return nil, errors.New("invalid encrypted data") }
	return s.box.Open(nil, data[:n], data[n:], nil)
}

func openStore(path string, box cipher.AEAD) (store, error) {
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil { return store{}, err }
	if err = file.Close(); err != nil { return store{}, err }
	db, err := sql.Open("sqlite3", path+"?_journal_mode=WAL&_busy_timeout=5000&_foreign_keys=on&_txlock=immediate")
	if err != nil { return store{}, err }
	db.SetMaxOpenConns(1)
	_, err = db.Exec("CREATE TABLE IF NOT EXISTS account (id INTEGER PRIMARY KEY CHECK(id=1), username TEXT NOT NULL, handle BLOB NOT NULL, salt BLOB NOT NULL, verifier BLOB NOT NULL, seed BLOB NOT NULL, last_step INTEGER NOT NULL, epoch INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1);" +
		"CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, token BLOB NOT NULL UNIQUE, created INTEGER NOT NULL, seen INTEGER NOT NULL, stepped INTEGER NOT NULL);" +
		"CREATE TABLE IF NOT EXISTS challenges (token BLOB PRIMARY KEY, kind TEXT NOT NULL, session TEXT NOT NULL, expires INTEGER NOT NULL, data BLOB NOT NULL);" +
		"CREATE TABLE IF NOT EXISTS recovery (digest BLOB PRIMARY KEY);" +
		"CREATE TABLE IF NOT EXISTS passkeys (id BLOB PRIMARY KEY, label TEXT NOT NULL, data BLOB NOT NULL);" +
		"CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, event TEXT NOT NULL);" +
		"PRAGMA user_version=1;")
	if err != nil { db.Close() }
	return store{db,box}, err
}

type account struct {
	user string
	handle, salt, verifier, seed []byte
	epoch int64
	enabled bool
}
func (s store) account(ctx context.Context) (a account, err error) {
	err = s.db.QueryRowContext(ctx, "SELECT username, handle, salt, verifier, seed, epoch, enabled FROM account WHERE id=1").Scan(&a.user,&a.handle,&a.salt,&a.verifier,&a.seed,&a.epoch,&a.enabled)
	return
}

func (s store) change(ctx context.Context, event string, f func(*sql.Tx) error) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil { return err }
	defer tx.Rollback()
	if err := f(tx); err != nil { return err }
	if err := audit(tx, ctx, event); err != nil { return err }
	return tx.Commit()
}
type sqlExecutor interface {
	ExecContext(context.Context, string, ...any) (sql.Result, error)
}
func audit(q sqlExecutor, ctx context.Context, event string) error {
	_, err := q.ExecContext(ctx, "INSERT INTO audit(at,event) VALUES(?,?)", time.Now().Unix(), event)
	return err
}
func write(q sqlExecutor, ctx context.Context, query string, args ...any) error {
	_, err := q.ExecContext(ctx, query, args...)
	return err
}
func one(q sqlExecutor, ctx context.Context, query string, args ...any) error {
	result, err := q.ExecContext(ctx, query, args...)
	if err != nil { return err }
	n, err := result.RowsAffected()
	if err != nil { return err }
	if n != 1 { return errDenied }
	return nil
}
func newRecovery(tx *sql.Tx, ctx context.Context) ([]string, error) {
	if err := write(tx,ctx,"DELETE FROM recovery"); err != nil { return nil,err }
	codes := make([]string, 10)
	for i := range codes {
		codes[i] = randomText(random(18))
		if err := write(tx,ctx,"INSERT INTO recovery(digest) VALUES(?)",hash(codes[i])); err != nil { return nil,err }
	}
	return codes,nil
}
func (s store) bootstrap(ctx context.Context, user, password string, seed []byte, code string) (codes []string, err error) {
	step, valid := matchTOTP(seed, code, time.Now())
	if !valid || len(seed) != 20 { return nil,errDenied }
	salt := random(16)
	key := passwordKey(password,salt)
	err = s.change(ctx,"account_created",func(tx *sql.Tx) error {
		if err := one(tx,ctx,"INSERT OR IGNORE INTO account(id,username,handle,salt,verifier,seed,last_step) VALUES(1,?,?,?,?,?,?)",
			user,random(32),salt,key,s.seal(seed),step); err != nil { return err }
		codes, err = newRecovery(tx,ctx)
		return err
	})
	return
}

func (s store) challenge(ctx context.Context, kind, session string, data []byte, seconds int64) (string,error) {
	token := randomText(random(32))
	now := time.Now().Unix()
	tx, err := s.db.BeginTx(ctx,nil)
	if err != nil { return "",err }
	defer tx.Rollback()
	if err = write(tx,ctx,"DELETE FROM challenges WHERE expires<=? OR (kind=? AND session=? AND session!='')",now,kind,session); err != nil { return "",err }
	if err = one(tx,ctx,"INSERT INTO challenges(token,kind,session,expires,data) SELECT ?,?,?,?,? WHERE (SELECT count(*) FROM challenges)<256",
		hash(token),kind,session,now+seconds,data); err != nil { return "",err }
	return token,tx.Commit()
}
func (s store) takeChallenge(ctx context.Context, kind, session, token string) ([]byte,error) {
	var data []byte
	err := s.db.QueryRowContext(ctx,"DELETE FROM challenges WHERE token=? AND kind=? AND session=? AND expires>? RETURNING data",
		hash(token),kind,session,time.Now().Unix()).Scan(&data)
	return data,err
}
func encodeEpoch(epoch int64) []byte { return []byte(strconv.FormatInt(epoch,10)) }
