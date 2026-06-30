package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"golang.org/x/crypto/bcrypt"
)

const (
	roleAdmin     = "admin"
	roleUser      = "user"
	roleBroadcast = "broadcast" // admin sub-role: maintenance and config access only
)

// jwtSecrets are loaded at startup. Use separate secrets for admin/user JWTs.
var (
	adminJWTSecret []byte
	userJWTSecret  []byte
)

func initJWTSecrets() {
	admin := getConfig("admin_jwt_secret")
	user := getConfig("user_jwt_secret")
	if admin == "" {
		admin = randomHex(32)
		setConfig("admin_jwt_secret", admin)
	}
	if user == "" {
		user = randomHex(32)
		setConfig("user_jwt_secret", user)
	}
	adminJWTSecret = []byte(admin)
	userJWTSecret = []byte(user)
}

func randomHex(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return hex.EncodeToString(b)
}

type claims struct {
	SessionID string `json:"sid"`
	Role      string `json:"role"`      // "admin" or "user"
	AdminRole string `json:"arole,omitempty"` // admin sub-role: "admin" or "broadcast"
	Subject   string `json:"sub"` // username or license key
	LicenseID int64  `json:"lid,omitempty"`
	AdminID   int64  `json:"aid,omitempty"`
	jwt.RegisteredClaims
}

func issueToken(role, subject string, licenseID, adminID int64, adminRole string) (string, string, error) {
	expHours := getConfigInt("jwt_expiry_hours", 24)
	if role == roleAdmin {
		expHours = getConfigInt("admin_jwt_expiry_hours", 8)
	}
	expiresAt := time.Now().Add(time.Duration(expHours) * time.Hour)
	sessionID := randomHex(16)

	var licPtr *int64
	var admPtr *int64
	if licenseID > 0 {
		licPtr = &licenseID
	}
	if adminID > 0 {
		admPtr = &adminID
	}
	if err := dbCreateSession(sessionID, licPtr, admPtr, role, expiresAt); err != nil {
		return "", "", fmt.Errorf("create session: %w", err)
	}

	c := claims{
		SessionID: sessionID,
		Role:      role,
		AdminRole: adminRole,
		Subject:   subject,
		LicenseID: licenseID,
		AdminID:   adminID,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(expiresAt),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
		},
	}
	secret := userJWTSecret
	if role == roleAdmin {
		secret = adminJWTSecret
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, c)
	signed, err := tok.SignedString(secret)
	return signed, sessionID, err
}

func parseToken(tokenStr, role string) (*claims, error) {
	secret := userJWTSecret
	if role == roleAdmin {
		secret = adminJWTSecret
	}
	tok, err := jwt.ParseWithClaims(tokenStr, &claims{}, func(t *jwt.Token) (interface{}, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, errors.New("unexpected signing method")
		}
		return secret, nil
	})
	if err != nil {
		return nil, err
	}
	c, ok := tok.Claims.(*claims)
	if !ok || !tok.Valid {
		return nil, errors.New("invalid token")
	}
	return c, nil
}

func extractBearerToken(r *http.Request) string {
	auth := r.Header.Get("Authorization")
	if strings.HasPrefix(auth, "Bearer ") {
		return strings.TrimPrefix(auth, "Bearer ")
	}
	// Also check cookie
	if cookie, err := r.Cookie("token"); err == nil {
		return cookie.Value
	}
	return ""
}

// ── HTTP Handlers ─────────────────────────────────────────────────────────────

// POST /api/admin/login — username + password → JWT
func adminLoginHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	enc := json.NewEncoder(w)

	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		enc.Encode(map[string]string{"error": "invalid request body"})
		return
	}
	req.Username = strings.TrimSpace(req.Username)
	req.Password = strings.TrimSpace(req.Password)

	if req.Username == "" || req.Password == "" {
		w.WriteHeader(http.StatusBadRequest)
		enc.Encode(map[string]string{"error": "username and password required"})
		return
	}

	admin, err := dbGetAdmin(req.Username)
	if err != nil {
		logError("adminLogin dbGetAdmin: " + err.Error())
		w.WriteHeader(http.StatusInternalServerError)
		enc.Encode(map[string]string{"error": "internal error"})
		return
	}
	if admin == nil {
		w.WriteHeader(http.StatusUnauthorized)
		enc.Encode(map[string]string{"error": "invalid credentials"})
		return
	}

	// Check lockout
	if admin.LockedUntil != nil && time.Now().Before(*admin.LockedUntil) {
		w.WriteHeader(http.StatusTooManyRequests)
		enc.Encode(map[string]string{"error": fmt.Sprintf("account locked until %s", admin.LockedUntil.Format(time.RFC3339))})
		return
	}

	if err := bcrypt.CompareHashAndPassword([]byte(admin.PasswordHash), []byte(req.Password)); err != nil {
		dbAdminIncrFailed(admin.ID)
		if admin.FailedAttempts+1 >= 5 {
			lockUntil := time.Now().Add(15 * time.Minute)
			dbAdminLockUntil(admin.ID, lockUntil)
			logWarn(fmt.Sprintf("Admin %s locked for 15 minutes after %d failed attempts", req.Username, admin.FailedAttempts+1))
		}
		w.WriteHeader(http.StatusUnauthorized)
		enc.Encode(map[string]string{"error": "invalid credentials"})
		return
	}

	dbAdminClearFailed(admin.ID)
	token, _, err := issueToken(roleAdmin, admin.Username, 0, admin.ID, admin.Role)
	if err != nil {
		logError("adminLogin issueToken: " + err.Error())
		w.WriteHeader(http.StatusInternalServerError)
		enc.Encode(map[string]string{"error": "could not create session"})
		return
	}
	logSuccess(fmt.Sprintf("Admin %s logged in", admin.Username))
	enc.Encode(map[string]interface{}{
		"token": token,
		"role":  roleAdmin,
		"username": admin.Username,
	})
}

// POST /api/user/login — license key → JWT
func userLoginHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	enc := json.NewEncoder(w)

	var req struct {
		LicenseKey string `json:"licenseKey"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		enc.Encode(map[string]string{"error": "invalid request body"})
		return
	}
	req.LicenseKey = strings.TrimSpace(req.LicenseKey)
	if req.LicenseKey == "" {
		w.WriteHeader(http.StatusBadRequest)
		enc.Encode(map[string]string{"error": "licenseKey required"})
		return
	}

	lic, err := dbGetLicenseByKey(req.LicenseKey)
	if err != nil {
		logError("userLogin dbGetLicense: " + err.Error())
		w.WriteHeader(http.StatusInternalServerError)
		enc.Encode(map[string]string{"error": "internal error"})
		return
	}
	if lic == nil {
		w.WriteHeader(http.StatusUnauthorized)
		enc.Encode(map[string]string{"error": "invalid license key"})
		return
	}
	if !lic.Active {
		w.WriteHeader(http.StatusForbidden)
		enc.Encode(map[string]string{"error": "license is inactive"})
		return
	}
	if lic.Suspended {
		w.WriteHeader(http.StatusForbidden)
		enc.Encode(map[string]string{"error": "license is suspended"})
		return
	}
	if lic.ExpiresAt != nil && time.Now().After(*lic.ExpiresAt) {
		w.WriteHeader(http.StatusForbidden)
		enc.Encode(map[string]string{"error": "license has expired"})
		return
	}

	token, _, err := issueToken(roleUser, lic.Key, lic.ID, 0, "")
	if err != nil {
		logError("userLogin issueToken: " + err.Error())
		w.WriteHeader(http.StatusInternalServerError)
		enc.Encode(map[string]string{"error": "could not create session"})
		return
	}
	logSuccess(fmt.Sprintf("License %s logged in (credits: %d)", lic.Key[:min(8, len(lic.Key))]+"...", lic.Credits))
	enc.Encode(map[string]interface{}{
		"token":   token,
		"role":    roleUser,
		"credits": lic.Credits,
	})
}

// POST /api/logout
func logoutHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "application/json")

	tokenStr := extractBearerToken(r)
	if tokenStr == "" {
		json.NewEncoder(w).Encode(map[string]bool{"ok": true})
		return
	}

	// Try both secrets
	var c *claims
	var err error
	c, err = parseToken(tokenStr, roleAdmin)
	if err != nil {
		c, err = parseToken(tokenStr, roleUser)
	}
	if err == nil && c != nil {
		dbRevokeSession(c.SessionID)
	}
	json.NewEncoder(w).Encode(map[string]bool{"ok": true})
}

// hashPassword creates a bcrypt hash of the password.
func hashPassword(password string) (string, error) {
	b, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	return string(b), err
}

// hashPasswordCheck verifies a password against a bcrypt hash.
func hashPasswordCheck(hash, password string) error {
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(password))
}

// ensureDefaultAdmin creates the default admin and broadcaster accounts if none exist.
func ensureDefaultAdmin() {
	var count int
	if err := db.QueryRow(`SELECT COUNT(*) FROM admins`).Scan(&count); err != nil {
		logError("ensureDefaultAdmin count: " + err.Error())
		return
	}
	if count > 0 {
		return
	}

	// ── Superadmin ────────────────────────────────────────────────────────────
	rawPw := make([]byte, 16)
	if _, err := rand.Read(rawPw); err != nil {
		logError("ensureDefaultAdmin rand: " + err.Error())
		return
	}
	plainPw := hex.EncodeToString(rawPw)
	hash, err := hashPassword(plainPw)
	if err != nil {
		logError("ensureDefaultAdmin hash: " + err.Error())
		return
	}
	if err := dbCreateAdmin("admin", hash, roleAdmin); err != nil {
		logError("ensureDefaultAdmin create admin: " + err.Error())
		return
	}

	// ── Broadcaster admin (maintenance + config access only) ──────────────────
	rawPw2 := make([]byte, 16)
	if _, err := rand.Read(rawPw2); err != nil {
		logError("ensureDefaultAdmin rand broadcaster: " + err.Error())
		return
	}
	plainPw2 := hex.EncodeToString(rawPw2)
	hash2, err := hashPassword(plainPw2)
	if err != nil {
		logError("ensureDefaultAdmin hash broadcaster: " + err.Error())
		return
	}
	if err := dbCreateAdmin("broadcaster", hash2, roleBroadcast); err != nil {
		logError("ensureDefaultAdmin create broadcaster: " + err.Error())
		return
	}

	// Print one-time passwords to stdout so the operator can log in.
	// Change them immediately via the Admin Dashboard after first login.
	logWarn("┌─────────────────────────────────────────────────────┐")
	logWarn("│  DEFAULT ADMIN ACCOUNTS CREATED                     │")
	logWarn("│  Username: admin  (full access)                     │")
	logWarn("│  Password: " + plainPw + "  │")
	logWarn("│                                                     │")
	logWarn("│  Username: broadcaster  (maintenance + config only) │")
	logWarn("│  Password: " + plainPw2 + "  │")
	logWarn("│  CHANGE THESE IMMEDIATELY via the Admin Dashboard.  │")
	logWarn("└─────────────────────────────────────────────────────┘")
}
