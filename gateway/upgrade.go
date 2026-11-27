package main

import (
	"context"
	"net/http"
	"strings"
	"time"
)

const upgradePath = "/mgmt/upgrade"

func (g *gateway) upgrade(w http.ResponseWriter, r *http.Request, s session) {
	if !stepped(s) {
		http.Redirect(w, r, nextURL("/_auth/stepup", upgradePath), http.StatusSeeOther)
		return
	}
	p := page{View: "upgrade", Title: "升级 DSH"}
	if r.Method == http.MethodPost {
		p.TargetVersion = strings.TrimSpace(r.PostForm.Get("version"))
		if len(p.TargetVersion) > 96 || !runtimeVersion.MatchString(p.TargetVersion) {
			p.TargetVersion = ""
			p.Status = http.StatusBadRequest
			p.Error = "请输入确切的 DSH 版本号。"
		} else {
			ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
			result, err := g.runtimeAction(r.WithContext(ctx), "upgrade", map[string]any{"version": p.TargetVersion})
			cancel()
			if ok, _ := result["ok"].(bool); err == nil && ok {
				g.failure(r, "runtime_upgrade")
				http.Redirect(w, r, "/mgmt", http.StatusSeeOther)
				return
			}
			g.failure(r, "runtime_upgrade_denied")
			p.Status = http.StatusServiceUnavailable
			p.Error = "暂时无法发起升级，请查看概览状态。"
			if err != nil {
				switch err.Error() {
				case "UPGRADE_BUSY":
					p.Status = http.StatusConflict
					p.Error = "Runtime 正在维护，请等待当前操作结束。"
				case "VERSION_ACTIVE":
					p.Status = http.StatusConflict
					p.Error = "该版本已在使用。"
				}
			}
		}
	}
	g.render(w, r, g.runtimePage(r, s, p))
}
