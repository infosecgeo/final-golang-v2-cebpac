package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// botAPIRouter handles all /api/bot/* routes, authenticated via X-Bot-Key header.
func botAPIRouter(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	// Validate X-Bot-Key
	key := r.Header.Get("X-Bot-Key")
	expected := getConfig("api_key")
	if expected == "" || key != expected {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	path := strings.TrimPrefix(r.URL.Path, "/api/bot")

	switch {

	// ── Credit Packages ───────────────────────────────────────────────────────
	case path == "/packages" && r.Method == http.MethodGet:
		list, err := dbListPackages(true)
		if err != nil {
			writeJSON(w, 500, map[string]string{"error": err.Error()})
			return
		}
		if list == nil {
			list = []CreditPackage{}
		}
		writeJSON(w, 200, list)

	// ── Subscribers ───────────────────────────────────────────────────────────
	case path == "/subscribers" && r.Method == http.MethodGet:
		list, err := dbListSubscribers()
		if err != nil {
			writeJSON(w, 500, map[string]string{"error": err.Error()})
			return
		}
		if list == nil {
			list = []TelegramSubscriber{}
		}
		writeJSON(w, 200, list)

	case path == "/subscribers" && r.Method == http.MethodPost:
		var req struct {
			TelegramUserID string `json:"telegramUserId"`
			Username       string `json:"username"`
			ChatID         string `json:"chatId"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.TelegramUserID == "" || req.ChatID == "" {
			writeJSON(w, 400, map[string]string{"error": "telegramUserId and chatId required"})
			return
		}
		if err := dbUpsertSubscriber(req.TelegramUserID, req.Username, req.ChatID); err != nil {
			writeJSON(w, 500, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, 200, map[string]bool{"ok": true})

	// ── Purchase Requests ─────────────────────────────────────────────────────
	case path == "/purchase-requests" && r.Method == http.MethodGet:
		status := r.URL.Query().Get("status")
		list, err := dbListPurchaseRequests(status)
		if err != nil {
			writeJSON(w, 500, map[string]string{"error": err.Error()})
			return
		}
		if list == nil {
			list = []PurchaseRequest{}
		}
		writeJSON(w, 200, list)

	case path == "/purchase-requests" && r.Method == http.MethodPost:
		var req struct {
			TelegramUserID string  `json:"telegramUserId"`
			Username       string  `json:"username"`
			ChatID         string  `json:"chatId"`
			PackageID      int64   `json:"packageId"`
			PackageName    string  `json:"packageName"`
			Credits        int     `json:"credits"`
			AmountPHP      float64 `json:"amountPHP"`
			LicenseKey     string  `json:"licenseKey"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, 400, map[string]string{"error": "invalid body"})
			return
		}
		if req.TelegramUserID == "" || req.ChatID == "" || req.Credits <= 0 || req.AmountPHP <= 0 {
			writeJSON(w, 400, map[string]string{"error": "telegramUserId, chatId, credits and amountPHP required"})
			return
		}
		id, err := dbCreatePurchaseRequest(req.TelegramUserID, req.Username, req.ChatID,
			req.PackageID, req.PackageName, req.Credits, req.AmountPHP, req.LicenseKey)
		if err != nil {
			writeJSON(w, 500, map[string]string{"error": err.Error()})
			return
		}
		logSuccess(fmt.Sprintf("Purchase request created: id=%d user=%s credits=%d", id, req.TelegramUserID, req.Credits))
		writeJSON(w, 201, map[string]interface{}{"id": id})

	case strings.HasPrefix(path, "/purchase-requests/") && strings.HasSuffix(path, "/status") && r.Method == http.MethodPut:
		idStr := strings.TrimSuffix(strings.TrimPrefix(path, "/purchase-requests/"), "/status")
		id, err := strconv.ParseInt(idStr, 10, 64)
		if err != nil || id == 0 {
			writeJSON(w, 400, map[string]string{"error": "invalid id"})
			return
		}
		var req struct {
			Status    string `json:"status"`
			AdminNote string `json:"adminNote"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, 400, map[string]string{"error": "invalid body"})
			return
		}
		if req.Status != "approved" && req.Status != "denied" {
			writeJSON(w, 400, map[string]string{"error": "status must be 'approved' or 'denied'"})
			return
		}
		pr, err := dbGetPurchaseRequest(id)
		if err != nil || pr == nil {
			writeJSON(w, 404, map[string]string{"error": "not found"})
			return
		}
		if err := dbUpdatePurchaseRequestStatus(id, req.Status, req.AdminNote); err != nil {
			writeJSON(w, 500, map[string]string{"error": err.Error()})
			return
		}
		logSuccess(fmt.Sprintf("Purchase request %d marked %s", id, req.Status))
		writeJSON(w, 200, map[string]interface{}{"ok": true, "request": pr})

	default:
		http.NotFound(w, r)
	}
}

// ── Admin package management ──────────────────────────────────────────────────

func adminListPackages(w http.ResponseWriter, r *http.Request) {
	list, err := dbListPackages(false)
	if err != nil {
		writeJSON(w, 500, map[string]string{"error": err.Error()})
		return
	}
	if list == nil {
		list = []CreditPackage{}
	}
	writeJSON(w, 200, list)
}

func adminCreatePackage(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name     string  `json:"name"`
		Credits  int     `json:"credits"`
		PricePHP float64 `json:"pricePHP"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, 400, map[string]string{"error": "invalid body"})
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" || req.Credits <= 0 || req.PricePHP <= 0 {
		writeJSON(w, 400, map[string]string{"error": "name, credits and pricePHP required"})
		return
	}
	id, err := dbCreatePackage(req.Name, req.Credits, req.PricePHP)
	if err != nil {
		writeJSON(w, 500, map[string]string{"error": err.Error()})
		return
	}
	logSuccess(fmt.Sprintf("Credit package created: %s (%d credits @ ₱%.2f)", req.Name, req.Credits, req.PricePHP))
	writeJSON(w, 201, map[string]interface{}{"id": id})
	triggerPriceUpdateBroadcast()
}

func adminUpdatePackage(w http.ResponseWriter, r *http.Request, id int64) {
	if id == 0 {
		writeJSON(w, 400, map[string]string{"error": "invalid id"})
		return
	}
	var req struct {
		Name     string  `json:"name"`
		Credits  int     `json:"credits"`
		PricePHP float64 `json:"pricePHP"`
		Active   *bool   `json:"active"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, 400, map[string]string{"error": "invalid body"})
		return
	}
	pkg, err := dbGetPackage(id)
	if err != nil || pkg == nil {
		writeJSON(w, 404, map[string]string{"error": "not found"})
		return
	}
	if req.Name != "" {
		pkg.Name = strings.TrimSpace(req.Name)
	}
	if req.Credits > 0 {
		pkg.Credits = req.Credits
	}
	if req.PricePHP > 0 {
		pkg.PricePHP = req.PricePHP
	}
	if req.Active != nil {
		pkg.Active = *req.Active
	}
	if err := dbUpdatePackage(id, pkg.Name, pkg.Credits, pkg.PricePHP, pkg.Active); err != nil {
		writeJSON(w, 500, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
	triggerPriceUpdateBroadcast()
}

func adminDeletePackage(w http.ResponseWriter, r *http.Request, id int64) {
	if id == 0 {
		writeJSON(w, 400, map[string]string{"error": "invalid id"})
		return
	}
	if err := dbDeletePackage(id); err != nil {
		writeJSON(w, 500, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
	triggerPriceUpdateBroadcast()
}

func adminBroadcastOnline(w http.ResponseWriter, r *http.Request) {
	go triggerBotWebhook("broadcast_online", nil)
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func adminListPurchaseRequests(w http.ResponseWriter, r *http.Request) {
	status := r.URL.Query().Get("status")
	list, err := dbListPurchaseRequests(status)
	if err != nil {
		writeJSON(w, 500, map[string]string{"error": err.Error()})
		return
	}
	if list == nil {
		list = []PurchaseRequest{}
	}
	writeJSON(w, 200, list)
}

// ── Webhook trigger helpers ───────────────────────────────────────────────────

func triggerBotWebhook(eventType string, payload interface{}) {
	webhookURL := getConfig("bot_webhook_url")
	if webhookURL == "" {
		return
	}
	body, err := json.Marshal(map[string]interface{}{
		"type":    eventType,
		"payload": payload,
	})
	if err != nil {
		logWarn("triggerBotWebhook marshal: " + err.Error())
		return
	}
	req, err := http.NewRequest("POST", strings.TrimRight(webhookURL, "/")+"/webhook/event", bytes.NewReader(body))
	if err != nil {
		logWarn("triggerBotWebhook build req: " + err.Error())
		return
	}
	req.Header.Set("Content-Type", "application/json")
	secret := getConfig("webhook_secret")
	if secret != "" {
		req.Header.Set("X-Webhook-Secret", secret)
	}
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		logWarn("triggerBotWebhook send: " + err.Error())
		return
	}
	defer resp.Body.Close()
}

func triggerPriceUpdateBroadcast() {
	packages, err := dbListPackages(true)
	if err != nil {
		logWarn("triggerPriceUpdateBroadcast: " + err.Error())
		return
	}
	go triggerBotWebhook("price_update", packages)
}

func packageIDFromPath(path string) int64 {
	parts := strings.Split(strings.TrimPrefix(path, "/packages/"), "/")
	if len(parts) > 0 {
		if id, err := strconv.ParseInt(parts[0], 10, 64); err == nil {
			return id
		}
	}
	return 0
}
