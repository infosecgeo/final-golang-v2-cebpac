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

func main() {
	http.HandleFunc("/", indexHandler)
	http.HandleFunc("/pay", payHandler)
	log.Println("Server listening on :5000")
	log.Fatal(http.ListenAndServe(":5000", nil))
}

func indexHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	fmt.Fprint(w, indexHTML)
}

type payResp struct {
	Success bool   `json:"success"`
	Message string `json:"message"`
}

func payHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	enc := json.NewEncoder(w)

	if err := r.ParseMultipartForm(10 << 20); err != nil {
		r.ParseForm()
	}

	card := strings.ReplaceAll(r.FormValue("card"), " ", "")
	xAuthToken := r.FormValue("xAuthToken")
	bearerToken := r.FormValue("bearerToken")
	hppContent := r.FormValue("hpp")

	// ── Card validation ─────────────────────────────────────────────────────
	parts := strings.Split(card, "|")
	if len(parts) < 3 || len(parts) > 4 {
		enc.Encode(payResp{false, "Invalid card format. Use: number|month|year or number|month|year|cvv"})
		return
	}
	cardNumber, month, year := parts[0], parts[1], parts[2]

	if !isDigits(cardNumber) {
		enc.Encode(payResp{false, "Card number must be numeric"})
		return
	}
	isAmex := strings.HasPrefix(cardNumber, "34") || strings.HasPrefix(cardNumber, "37")
	expectedLen := 16
	if isAmex {
		expectedLen = 15
	}
	if len(cardNumber) != expectedLen {
		enc.Encode(payResp{false, fmt.Sprintf("Card number must be %d digits", expectedLen)})
		return
	}

	if !isDigits(month) {
		enc.Encode(payResp{false, "Month must be numeric"})
		return
	}
	monthInt, _ := strconv.Atoi(month)
	if monthInt < 1 || monthInt > 12 {
		enc.Encode(payResp{false, "Month must be between 1 and 12"})
		return
	}

	if !isDigits(year) {
		enc.Encode(payResp{false, "Year must be numeric"})
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
		enc.Encode(payResp{false, "Year must be 2 or 4 digits"})
		return
	}

	now := time.Now()
	if yearInt < now.Year() || (yearInt == now.Year() && monthInt < int(now.Month())) {
		enc.Encode(payResp{false, fmt.Sprintf("Card expired (%s/%d)", month, yearInt)})
		return
	}

	// ── Run Akamai bot challenge (retry once on failure) ────────────────────
	client, jar, err := runAkamaiChallenge()
	if err != nil {
		log.Printf("Bot challenge attempt 1 failed: %v — retrying...", err)
		client, jar, err = runAkamaiChallenge()
	}
	if err != nil {
		enc.Encode(payResp{false, "Bot challenge failed: " + err.Error()})
		return
	}

	// ── Full payment flow ────────────────────────────────────────────────────
	ok, msg, err := processManualPayment(client, jar, xAuthToken, bearerToken, hppContent, cardNumber, month, year)
	if err != nil {
		enc.Encode(payResp{false, "Payment error: " + err.Error()})
		return
	}
	log.Printf("payment result | card=%s | ok=%v | msg=%s", cardNumber, ok, msg)
	enc.Encode(payResp{ok, msg})
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
