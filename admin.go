package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// adminRouter dispatches all /api/admin/* routes.
func adminRouter(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	path := strings.TrimPrefix(r.URL.Path, "/api/admin")

	// Enforce broadcast-role restrictions: only maintenance and config endpoints allowed.
	if c := getCtxClaims(r); c != nil && c.AdminRole == roleBroadcast {
		allowed := (path == "/config" && (r.Method == http.MethodGet || r.Method == http.MethodPut)) ||
			(path == "/maintenance" && r.Method == http.MethodPost) ||
			(path == "/packages" && r.Method == http.MethodGet) ||
			(path == "/broadcast-online" && r.Method == http.MethodPost) ||
			(path == "/broadcast-prices" && r.Method == http.MethodPost)
		if !allowed {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "insufficient permissions"})
			return
		}
	}

	// License routes
	switch {
	case path == "/licenses" && r.Method == http.MethodGet:
		adminListLicenses(w, r)
	case path == "/licenses" && r.Method == http.MethodPost:
		adminCreateLicense(w, r)
	case strings.HasPrefix(path, "/licenses/") && r.Method == http.MethodGet:
		id := licenseIDFromPath(path)
		adminGetLicense(w, r, id)
	case strings.HasPrefix(path, "/licenses/") && r.Method == http.MethodPut:
		id := licenseIDFromPath(path)
		adminUpdateLicense(w, r, id)
	case strings.HasPrefix(path, "/licenses/") && r.Method == http.MethodDelete:
		id := licenseIDFromPath(path)
		adminDeleteLicense(w, r, id)
	case strings.HasPrefix(path, "/licenses/") && strings.HasSuffix(path, "/credits") && r.Method == http.MethodPost:
		id := licenseIDFromPath(strings.TrimSuffix(path, "/credits"))
		adminAdjustCredits(w, r, id)
	case strings.HasPrefix(path, "/licenses/") && strings.HasSuffix(path, "/history") && r.Method == http.MethodGet:
		id := licenseIDFromPath(strings.TrimSuffix(path, "/history"))
		adminCreditHistory(w, r, id)

	// Session routes
	case path == "/sessions" && r.Method == http.MethodGet:
		adminListSessions(w, r)
	case strings.HasPrefix(path, "/sessions/") && r.Method == http.MethodDelete:
		sid := strings.TrimPrefix(path, "/sessions/")
		adminRevokeSession(w, r, sid)

	// Config routes
	case path == "/config" && r.Method == http.MethodGet:
		adminGetConfig(w, r)
	case path == "/config" && r.Method == http.MethodPut:
		adminSetConfig(w, r)

	// Maintenance
	case path == "/maintenance" && r.Method == http.MethodPost:
		adminToggleMaintenance(w, r)

	// Stats
	case path == "/stats" && r.Method == http.MethodGet:
		adminStats(w, r)

	// Credit packages
	case path == "/packages" && r.Method == http.MethodGet:
		adminListPackages(w, r)
	case path == "/packages" && r.Method == http.MethodPost:
		adminCreatePackage(w, r)
	case strings.HasPrefix(path, "/packages/") && r.Method == http.MethodPut:
		id := packageIDFromPath(path)
		adminUpdatePackage(w, r, id)
	case strings.HasPrefix(path, "/packages/") && r.Method == http.MethodDelete:
		id := packageIDFromPath(path)
		adminDeletePackage(w, r, id)

	// Purchase requests (read-only from admin panel)
	case path == "/purchase-requests" && r.Method == http.MethodGet:
		adminListPurchaseRequests(w, r)

	// Broadcast
	case path == "/broadcast-online" && r.Method == http.MethodPost:
		adminBroadcastOnline(w, r)
	case path == "/broadcast-prices" && r.Method == http.MethodPost:
		go triggerPriceUpdateBroadcast()
		writeJSON(w, 200, map[string]bool{"ok": true})

	// Admin user management
	case path == "/users" && r.Method == http.MethodPost:
		adminCreateAdminUser(w, r)
	case path == "/changepassword" && r.Method == http.MethodPost:
		adminChangePassword(w, r)

	default:
		http.NotFound(w, r)
	}
}

func licenseIDFromPath(path string) int64 {
	parts := strings.Split(strings.TrimPrefix(path, "/licenses/"), "/")
	if len(parts) > 0 {
		if id, err := strconv.ParseInt(parts[0], 10, 64); err == nil {
			return id
		}
	}
	return 0
}

func writeJSON(w http.ResponseWriter, status int, v interface{}) {
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

// ── Licenses ──────────────────────────────────────────────────────────────────

func adminListLicenses(w http.ResponseWriter, r *http.Request) {
	list, err := dbListLicenses()
	if err != nil {
		writeJSON(w, 500, map[string]string{"error": err.Error()})
		return
	}
	type licenseOut struct {
		ID        int64      `json:"id"`
		Key       string     `json:"key"`
		Credits   int        `json:"credits"`
		ExpiresAt *time.Time `json:"expiresAt"`
		Active    bool       `json:"active"`
		Suspended bool       `json:"suspended"`
		Notes     string     `json:"notes"`
		CreatedAt time.Time  `json:"createdAt"`
	}
	out := make([]licenseOut, 0, len(list))
	for _, l := range list {
		out = append(out, licenseOut{l.ID, l.Key, l.Credits, l.ExpiresAt, l.Active, l.Suspended, l.Notes, l.CreatedAt})
	}
	writeJSON(w, 200, out)
}

func adminGetLicense(w http.ResponseWriter, r *http.Request, id int64) {
	if id == 0 {
		writeJSON(w, 400, map[string]string{"error": "invalid id"})
		return
	}
	l, err := dbGetLicenseByID(id)
	if err != nil {
		writeJSON(w, 500, map[string]string{"error": err.Error()})
		return
	}
	if l == nil {
		writeJSON(w, 404, map[string]string{"error": "not found"})
		return
	}
	writeJSON(w, 200, l)
}

func adminCreateLicense(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Key       string  `json:"key"`
		Credits   int     `json:"credits"`
		ExpiresAt *string `json:"expiresAt"`
		Notes     string  `json:"notes"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, 400, map[string]string{"error": "invalid body"})
		return
	}
	req.Key = strings.TrimSpace(req.Key)
	if req.Key == "" {
		// Generate a random key
		req.Key = "LIC-" + strings.ToUpper(randomHex(8))
	}
	var expiresAt *time.Time
	if req.ExpiresAt != nil && *req.ExpiresAt != "" {
		t, err := time.Parse(time.RFC3339, *req.ExpiresAt)
		if err != nil {
			// try date only
			t, err = time.Parse("2006-01-02", *req.ExpiresAt)
			if err != nil {
				writeJSON(w, 400, map[string]string{"error": "invalid expiresAt format"})
				return
			}
		}
		expiresAt = &t
	}
	id, err := dbCreateLicense(req.Key, req.Credits, expiresAt, req.Notes)
	if err != nil {
		if strings.Contains(err.Error(), "UNIQUE") {
			writeJSON(w, 409, map[string]string{"error": "license key already exists"})
			return
		}
		writeJSON(w, 500, map[string]string{"error": err.Error()})
		return
	}
	logSuccess(fmt.Sprintf("License created: %s (credits=%d)", req.Key, req.Credits))
	writeJSON(w, 201, map[string]interface{}{"id": id, "key": req.Key})
}

func adminUpdateLicense(w http.ResponseWriter, r *http.Request, id int64) {
	if id == 0 {
		writeJSON(w, 400, map[string]string{"error": "invalid id"})
		return
	}
	var req struct {
		Credits   *int    `json:"credits"`
		ExpiresAt *string `json:"expiresAt"`
		Active    *bool   `json:"active"`
		Suspended *bool   `json:"suspended"`
		Notes     *string `json:"notes"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, 400, map[string]string{"error": "invalid body"})
		return
	}
	l, err := dbGetLicenseByID(id)
	if err != nil || l == nil {
		writeJSON(w, 404, map[string]string{"error": "not found"})
		return
	}
	// Apply partial updates
	if req.Credits != nil {
		l.Credits = *req.Credits
	}
	if req.Active != nil {
		l.Active = *req.Active
	}
	if req.Suspended != nil {
		l.Suspended = *req.Suspended
	}
	if req.Notes != nil {
		l.Notes = *req.Notes
	}
	if req.ExpiresAt != nil {
		if *req.ExpiresAt == "" {
			l.ExpiresAt = nil
		} else {
			t, err := time.Parse(time.RFC3339, *req.ExpiresAt)
			if err != nil {
				t, err = time.Parse("2006-01-02", *req.ExpiresAt)
				if err != nil {
					writeJSON(w, 400, map[string]string{"error": "invalid expiresAt"})
					return
				}
			}
			l.ExpiresAt = &t
		}
	}
	if err := dbUpdateLicense(id, l.Credits, l.ExpiresAt, l.Active, l.Suspended, l.Notes); err != nil {
		writeJSON(w, 500, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func adminDeleteLicense(w http.ResponseWriter, r *http.Request, id int64) {
	if id == 0 {
		writeJSON(w, 400, map[string]string{"error": "invalid id"})
		return
	}
	if err := dbDeleteLicense(id); err != nil {
		writeJSON(w, 500, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

// ── Credits ───────────────────────────────────────────────────────────────────

func adminAdjustCredits(w http.ResponseWriter, r *http.Request, id int64) {
	if id == 0 {
		writeJSON(w, 400, map[string]string{"error": "invalid id"})
		return
	}
	var req struct {
		Delta  int    `json:"delta"`
		Reason string `json:"reason"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, 400, map[string]string{"error": "invalid body"})
		return
	}
	newBal, err := dbAdjustCredits(id, req.Delta, req.Reason)
	if err != nil {
		writeJSON(w, 500, map[string]string{"error": err.Error()})
		return
	}
	logSuccess(fmt.Sprintf("Credits adjusted for license %d: delta=%d, new balance=%d", id, req.Delta, newBal))
	writeJSON(w, 200, map[string]int{"balance": newBal})
}

func adminCreditHistory(w http.ResponseWriter, r *http.Request, id int64) {
	if id == 0 {
		writeJSON(w, 400, map[string]string{"error": "invalid id"})
		return
	}
	history, err := dbCreditHistory(id)
	if err != nil {
		writeJSON(w, 500, map[string]string{"error": err.Error()})
		return
	}
	if history == nil {
		history = []map[string]interface{}{}
	}
	writeJSON(w, 200, history)
}

// ── Sessions ──────────────────────────────────────────────────────────────────

func adminListSessions(w http.ResponseWriter, r *http.Request) {
	list, err := dbListActiveSessions()
	if err != nil {
		writeJSON(w, 500, map[string]string{"error": err.Error()})
		return
	}
	if list == nil {
		list = []map[string]interface{}{}
	}
	writeJSON(w, 200, list)
}

func adminRevokeSession(w http.ResponseWriter, r *http.Request, sessionID string) {
	if sessionID == "" {
		writeJSON(w, 400, map[string]string{"error": "invalid session id"})
		return
	}
	if err := dbRevokeSession(sessionID); err != nil {
		writeJSON(w, 500, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

// ── Config ────────────────────────────────────────────────────────────────────

func adminGetConfig(w http.ResponseWriter, r *http.Request) {
	cfg := getAllConfig()
	// Redact sensitive values
	if _, ok := cfg["admin_jwt_secret"]; ok {
		cfg["admin_jwt_secret"] = "****"
	}
	if _, ok := cfg["user_jwt_secret"]; ok {
		cfg["user_jwt_secret"] = "****"
	}
	writeJSON(w, 200, cfg)
}

func adminSetConfig(w http.ResponseWriter, r *http.Request) {
	var updates map[string]string
	if err := json.NewDecoder(r.Body).Decode(&updates); err != nil {
		writeJSON(w, 400, map[string]string{"error": "invalid body"})
		return
	}
	// Protect secrets from being overwritten via the API
	delete(updates, "admin_jwt_secret")
	delete(updates, "user_jwt_secret")

	for k, v := range updates {
		if err := setConfig(k, v); err != nil {
			writeJSON(w, 500, map[string]string{"error": fmt.Sprintf("set %s: %s", k, err.Error())})
			return
		}
	}
	// Hot-reload in-memory cache
	reloadConfig()
	logSuccess(fmt.Sprintf("Config updated: %d key(s) changed", len(updates)))
	writeJSON(w, 200, map[string]bool{"ok": true})
}

// ── Maintenance ───────────────────────────────────────────────────────────────

func adminToggleMaintenance(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Enabled bool   `json:"enabled"`
		Message string `json:"message"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, 400, map[string]string{"error": "invalid body"})
		return
	}
	val := "false"
	if req.Enabled {
		val = "true"
	}
	setConfig("maintenance_mode", val)
	if req.Message != "" {
		setConfig("maintenance_message", req.Message)
	}
	reloadConfig()
	logWarn(fmt.Sprintf("Maintenance mode set to: %v", req.Enabled))
	writeJSON(w, 200, map[string]bool{"ok": true})
}

// ── Stats ─────────────────────────────────────────────────────────────────────

func adminStats(w http.ResponseWriter, r *http.Request) {
	var totalLicenses, activeLicenses, totalSessions int
	db.QueryRow(`SELECT COUNT(*) FROM licenses`).Scan(&totalLicenses)
	db.QueryRow(`SELECT COUNT(*) FROM licenses WHERE active=1 AND suspended=0`).Scan(&activeLicenses)
	db.QueryRow(`SELECT COUNT(*) FROM sessions WHERE revoked=0 AND expires_at > CURRENT_TIMESTAMP`).Scan(&totalSessions)

	var totalTxns, successTxns int
	db.QueryRow(`SELECT COUNT(*) FROM transactions`).Scan(&totalTxns)
	db.QueryRow(`SELECT COUNT(*) FROM transactions WHERE result='success'`).Scan(&successTxns)

	writeJSON(w, 200, map[string]interface{}{
		"totalLicenses":  totalLicenses,
		"activeLicenses": activeLicenses,
		"activeSessions": totalSessions,
		"totalTxns":      totalTxns,
		"successTxns":    successTxns,
		"maintenance":    getConfigBool("maintenance_mode"),
	})
}

// ── Admin user management ──────────────────────────────────────────────────────

func adminCreateAdminUser(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
		Role     string `json:"role"` // "admin" (default) or "broadcast"
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, 400, map[string]string{"error": "invalid body"})
		return
	}
	req.Username = strings.TrimSpace(req.Username)
	req.Password = strings.TrimSpace(req.Password)
	if req.Username == "" || req.Password == "" {
		writeJSON(w, 400, map[string]string{"error": "username and password required"})
		return
	}
	// Default to full admin; only "admin" and "broadcast" are valid roles.
	if req.Role == "" {
		req.Role = roleAdmin
	}
	if req.Role != roleAdmin && req.Role != roleBroadcast {
		writeJSON(w, 400, map[string]string{"error": "role must be 'admin' or 'broadcast'"})
		return
	}
	// Only a full admin can create another full admin.
	if req.Role == roleAdmin {
		if c := getCtxClaims(r); c == nil || c.AdminRole != roleAdmin {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "only admin role can create admin accounts"})
			return
		}
	}
	hash, err := hashPassword(req.Password)
	if err != nil {
		writeJSON(w, 500, map[string]string{"error": "hash error"})
		return
	}
	if err := dbCreateAdmin(req.Username, hash, req.Role); err != nil {
		if strings.Contains(err.Error(), "UNIQUE") {
			writeJSON(w, 409, map[string]string{"error": "username already exists"})
			return
		}
		writeJSON(w, 500, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, 201, map[string]string{"username": req.Username, "role": req.Role})
}

func adminChangePassword(w http.ResponseWriter, r *http.Request) {
	c := getCtxClaims(r)
	if c == nil {
		writeJSON(w, 401, map[string]string{"error": "unauthorized"})
		return
	}
	var req struct {
		CurrentPassword string `json:"currentPassword"`
		NewPassword     string `json:"newPassword"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, 400, map[string]string{"error": "invalid body"})
		return
	}
	admin, err := dbGetAdmin(c.Subject)
	if err != nil || admin == nil {
		writeJSON(w, 404, map[string]string{"error": "admin not found"})
		return
	}
	if req.CurrentPassword == "" || req.NewPassword == "" {
		writeJSON(w, 400, map[string]string{"error": "currentPassword and newPassword required"})
		return
	}
	// Verify current password
	if err := verifyPassword(admin.PasswordHash, req.CurrentPassword); err != nil {
		writeJSON(w, 401, map[string]string{"error": "current password incorrect"})
		return
	}
	if len(req.NewPassword) < 8 {
		writeJSON(w, 400, map[string]string{"error": "new password must be at least 8 characters"})
		return
	}
	newHash, err := hashPassword(req.NewPassword)
	if err != nil {
		writeJSON(w, 500, map[string]string{"error": "hash error"})
		return
	}
	if _, err := db.Exec(`UPDATE admins SET password_hash=? WHERE id=?`, newHash, admin.ID); err != nil {
		writeJSON(w, 500, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func verifyPassword(hash, password string) error {
	return hashPasswordCheck(hash, password)
}
