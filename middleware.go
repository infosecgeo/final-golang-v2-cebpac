package main

import (
	"context"
	"encoding/json"
	"html"
	"net/http"
	"strings"
	"sync"
	"time"
)

func setCtxValue(ctx context.Context, key ctxKey, val interface{}) context.Context {
	return context.WithValue(ctx, key, val)
}

func getCtxClaims(r *http.Request) *claims {
	if v := r.Context().Value(ctxClaims); v != nil {
		if c, ok := v.(*claims); ok {
			return c
		}
	}
	return nil
}

// ── Security / CORS headers ───────────────────────────────────────────────────

func secureHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("X-XSS-Protection", "1; mode=block")
		w.Header().Set("Referrer-Policy", "strict-origin-when-cross-origin")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:;")
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// ── Maintenance mode ──────────────────────────────────────────────────────────

func maintenanceMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Admin paths bypass maintenance mode
		if strings.HasPrefix(r.URL.Path, "/api/admin") ||
			r.URL.Path == "/admin" ||
			r.URL.Path == "/admin.html" ||
			r.URL.Path == "/api/logout" {
			next.ServeHTTP(w, r)
			return
		}
		// Login bypass
		if r.URL.Path == "/api/admin/login" || r.URL.Path == "/api/user/login" {
			next.ServeHTTP(w, r)
			return
		}
		if getConfigBool("maintenance_mode") {
			msg := getConfig("maintenance_message")
			if msg == "" {
				msg = "The service is temporarily unavailable. Please try again later."
			}
			// Check if request wants JSON
			if strings.Contains(r.Header.Get("Accept"), "application/json") ||
				strings.HasPrefix(r.URL.Path, "/api/") {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusServiceUnavailable)
				json.NewEncoder(w).Encode(map[string]string{
					"error":       "maintenance",
					"message":     msg,
					"maintenance": "true",
				})
				return
			}
			// HTML maintenance page — msg is HTML-escaped before embedding
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.WriteHeader(http.StatusServiceUnavailable)
			safeMsgBytes := []byte(html.EscapeString(msg))
			page := []byte(`<!DOCTYPE html><html><head><title>Maintenance</title>` +
				`<style>body{background:#0f1117;color:#e2e4f0;font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}` +
				`.box{text-align:center;padding:40px;background:#1a1d27;border:1px solid #2e3247;border-radius:12px;max-width:400px}` +
				`h1{color:#ef4444;margin-bottom:16px}p{color:#6b7394}</style></head>` +
				`<body><div class="box"><h1>&#x1F527; System Maintenance</h1><p>`)
			page = append(page, safeMsgBytes...)
			page = append(page, []byte(`</p></div></body></html>`)...)
			w.Write(page)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// ── Rate limiting ──────────────────────────────────────────────────────────────

type rateBucket struct {
	count    int
	resetAt  time.Time
	blockedUntil time.Time
}

var (
	rateMu      sync.Mutex
	rateBuckets = make(map[string]*rateBucket)
)

func getRealIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		return strings.Split(xff, ",")[0]
	}
	ip := r.RemoteAddr
	if i := strings.LastIndex(ip, ":"); i != -1 {
		ip = ip[:i]
	}
	return ip
}

func rateLimit(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Only rate-limit the pay endpoint and auth endpoints
		if r.URL.Path != "/pay" && !strings.HasPrefix(r.URL.Path, "/api/") {
			next.ServeHTTP(w, r)
			return
		}
		ip := getRealIP(r)
		limit := getConfigInt("rate_limit_per_ip", 30)

		rateMu.Lock()
		bucket, ok := rateBuckets[ip]
		if !ok {
			bucket = &rateBucket{}
			rateBuckets[ip] = bucket
		}
		now := time.Now()
		// Clear temporary block
		if !bucket.blockedUntil.IsZero() && now.After(bucket.blockedUntil) {
			bucket.blockedUntil = time.Time{}
			bucket.count = 0
		}
		// Check block
		if !bucket.blockedUntil.IsZero() && now.Before(bucket.blockedUntil) {
			rateMu.Unlock()
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusTooManyRequests)
			json.NewEncoder(w).Encode(map[string]string{"error": "rate limit exceeded"})
			return
		}
		// Reset window
		if now.After(bucket.resetAt) {
			bucket.count = 0
			bucket.resetAt = now.Add(time.Minute)
		}
		bucket.count++
		if bucket.count > limit {
			bucket.blockedUntil = now.Add(5 * time.Minute)
			logWarn("Rate limit hit for IP: " + ip)
			rateMu.Unlock()
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusTooManyRequests)
			json.NewEncoder(w).Encode(map[string]string{"error": "rate limit exceeded"})
			return
		}
		rateMu.Unlock()
		next.ServeHTTP(w, r)
	})
}

// ── Auth context ──────────────────────────────────────────────────────────────

type ctxKey string

const (
	ctxClaims  ctxKey = "claims"
	ctxLicense ctxKey = "license"
)

// requireAuth extracts and validates JWT for the given role.
// If role is empty, both admin and user tokens are accepted.
func requireAuth(role string, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tokenStr := extractBearerToken(r)
		if tokenStr == "" {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusUnauthorized)
			json.NewEncoder(w).Encode(map[string]string{"error": "authentication required"})
			return
		}

		var c *claims
		var err error

		// Try the expected role first
		tryRoles := []string{roleAdmin, roleUser}
		if role != "" {
			tryRoles = []string{role}
		}
		for _, r2 := range tryRoles {
			c, err = parseToken(tokenStr, r2)
			if err == nil {
				break
			}
		}
		if err != nil || c == nil {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusUnauthorized)
			json.NewEncoder(w).Encode(map[string]string{"error": "invalid or expired token"})
			return
		}
		if role != "" && c.Role != role {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusForbidden)
			json.NewEncoder(w).Encode(map[string]string{"error": "insufficient permissions"})
			return
		}

		// Verify session not revoked
		sess, err := dbGetSession(c.SessionID)
		if err != nil || sess == nil || sess.Revoked {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusUnauthorized)
			json.NewEncoder(w).Encode(map[string]string{"error": "session expired or revoked"})
			return
		}

		// Attach claims to request context
		ctx := r.Context()
		ctx = setCtxValue(ctx, ctxClaims, c)
		next.ServeHTTP(w, r.WithContext(ctx))
	}
}

// ── Request logging ────────────────────────────────────────────────────────────

func requestLogger(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		lrw := &loggingResponseWriter{ResponseWriter: w, status: 200}
		next.ServeHTTP(lrw, r)
		logCtx(levelINFO, "-", "-", "-", "%s %s → %d (%v)",
			r.Method, r.URL.Path, lrw.status, time.Since(start))
	})
}

type loggingResponseWriter struct {
	http.ResponseWriter
	status int
}

func (lrw *loggingResponseWriter) WriteHeader(status int) {
	lrw.status = status
	lrw.ResponseWriter.WriteHeader(status)
}
