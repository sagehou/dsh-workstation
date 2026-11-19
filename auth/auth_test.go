package main

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"database/sql"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func newTestGateway(t *testing.T) (*gateway,[]string,[]byte) {
	t.Helper()
	key,_ := aes.NewCipher(make([]byte,32))
	box,_ := cipher.NewGCM(key)
	db,err := openStore(filepath.Join(t.TempDir(),"auth.sqlite"),box)
	if err!=nil { t.Fatal(err) }
	t.Cleanup(func(){db.db.Close()})
	seed := []byte("12345678901234567890")
	codes,err := db.bootstrap(context.Background(),"operator","ci-only password",seed,totp(seed,time.Now().Unix()/30-1))
	if err!=nil { t.Fatal(err) }
	return &gateway{store:db,origin:"https://workstation.test",host:"workstation.test",edge:"192.0.2.1",idle:600,absolute:3600,maxSessions:2,hashSlots:make(chan struct{},2)},codes,seed
}
func req(g *gateway,method,path string,values url.Values,cookies ...*http.Cookie) *http.Request {
	var body io.Reader
	if values!=nil { body=strings.NewReader(values.Encode()) }
	r := httptest.NewRequest(method,g.origin+path,body)
	r.RemoteAddr=g.edge+":9900"
	if values!=nil {
		r.Header.Set("Origin",g.origin)
		r.Header.Set("Content-Type","application/x-www-form-urlencoded")
	}
	for _,c := range cookies { r.AddCookie(c) }
	return r
}
func request(g *gateway,r *http.Request) *httptest.ResponseRecorder {
	w:=httptest.NewRecorder()
	g.public(w,r)
	return w
}
func named(w *httptest.ResponseRecorder,name string) *http.Cookie {
	for _,c := range w.Result().Cookies() { if c.Name==name { return c } }
	return nil
}
func response(t *testing.T,r *httptest.ResponseRecorder,status int) {
	t.Helper()
	if r.Code!=status { t.Fatalf("got %d, want %d",r.Code,status) }
}
func TestTwoStepLoginAndReplay(t *testing.T) {
	g,_,seed := newTestGateway(t)
	csrf := named(request(g,req(g,"GET","/_auth/login",nil)),csrfCookie)
	if csrf==nil { t.Fatal("no login CSRF cookie") }
	values := url.Values{"csrf":{csrf.Value},"username":{"operator"},"password":{"ci-only password"}}
	r := req(g,"POST","/_auth/password",values,csrf)
	r.Header.Set("Origin","https://foreign.test")
	response(t,request(g,r),403)
	p := request(g,req(g,"POST","/_auth/password",values,csrf))
	response(t,p,303)
	if named(p,sessionCookie)!=nil { t.Fatal("password alone issued a session") }
	pre := named(p,preCookie)
	if pre==nil { t.Fatal("no pre-auth cookie") }
	screen := request(g,req(g,"GET","/_auth/totp",nil,csrf,pre))
	if strings.Contains(screen.Body.String(),"name=\"password\"") { t.Fatal("TOTP screen has a password field") }
	code := totp(seed,time.Now().Unix()/30)
	totpForm := url.Values{"csrf":{csrf.Value},"code":{code},"next":{"//foreign.test"}}
	var outcomes [2]int
	var results [2]*httptest.ResponseRecorder
	var wg sync.WaitGroup
	for i:= range outcomes {
		wg.Go(func(){
			results[i]=request(g,req(g,"POST","/_auth/totp",totpForm,csrf,pre))
			outcomes[i]=results[i].Code
		})
	}
	wg.Wait()
	if !((outcomes[0]==303 && outcomes[1]==401)||(outcomes[0]==401 && outcomes[1]==303)) { t.Fatalf("one-time TOTP outcomes: %v",outcomes) }
	for _,result := range results {
		if result.Code!=303 { continue }
		session:=named(result,sessionCookie)
		if session==nil || !session.Secure || !session.HttpOnly || session.Path!="/" || session.Domain!="" || session.SameSite!=http.SameSiteLaxMode { t.Fatal("invalid session cookie") }
		if strings.Contains(result.Header().Get("Location"),"foreign.test") { t.Fatal("external redirect") }
	}
}

func TestForwardAuthAndRevocation(t *testing.T) {
	g,codes,_ := newTestGateway(t)
	csrf:=named(request(g,req(g,"GET","/_auth/login",nil)),csrfCookie)
	password:=url.Values{"csrf":{csrf.Value},"username":{"operator"},"password":{"ci-only password"}}
	pre:=named(request(g,req(g,"POST","/_auth/password",password,csrf)),preCookie)
	form:=url.Values{"csrf":{csrf.Value},"code":{codes[0]}}
	finish:=request(g,req(g,"POST","/_auth/recovery",form,csrf,pre))
	response(t,finish,303)
	sess:=named(finish,sessionCookie)
	pre=named(request(g,req(g,"POST","/_auth/password",password,csrf)),preCookie)
	response(t,request(g,req(g,"POST","/_auth/recovery",form,csrf,pre)),401)

	verify:=func(path string,session *http.Cookie,trusted bool) *httptest.ResponseRecorder {
		r:=req(g,"GET","/verify",nil)
		if session!=nil { r.AddCookie(session) }
		if !trusted { r.RemoteAddr="192.0.2.9:9930" }
		r.Header.Set("X-Forwarded-Host",g.host)
		r.Header.Set("X-Forwarded-Proto","https")
		r.Header.Set("X-Forwarded-Method","GET")
		r.Header.Set("X-Forwarded-Uri",path)
		r.Header.Set("Accept","text/html")
		w:=httptest.NewRecorder()
		g.verify(w,r)
		return w
	}
	response(t,verify("/",nil,true),303)
	response(t,verify("/api/remote.mux",nil,true),401)
	response(t,verify("/browser/api/websockets",nil,true),401)
	response(t,verify("/",sess,false),404)
	response(t,verify("/",sess,true),204)

	if _,err:=g.db.Exec("UPDATE sessions SET seen=?",time.Now().Unix()-g.idle-1);err!=nil { t.Fatal(err) }
	response(t,verify("/api/remote.mux",sess,true),401)
	if _,err:=g.db.Exec("UPDATE sessions SET seen=?,created=?",time.Now().Unix(),time.Now().Unix()-g.absolute-1);err!=nil { t.Fatal(err) }
	response(t,verify("/api/remote.mux",sess,true),401)
	if _,err:=g.db.Exec("UPDATE sessions SET seen=?,created=?",time.Now().Unix(),time.Now().Unix());err!=nil { t.Fatal(err) }
	response(t,request(g,req(g,"POST","/_auth/sessions/revoke-all",url.Values{"csrf":{csrf.Value}},csrf,sess)),303)
	response(t,verify("/api/remote.mux",sess,true),401)
	if _,err:=g.takeChallenge(context.Background(),"password","",pre.Value);!errors.Is(err,sql.ErrNoRows) { t.Fatal("revocation did not discard pending login") }
}
