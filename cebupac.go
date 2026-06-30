package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math/rand"
	"net/url"
	"regexp"
	"strings"
	"time"

	hyper "github.com/Hyper-Solutions/hyper-sdk-go/v2"
	http "github.com/bogdanfinn/fhttp"
	"github.com/bogdanfinn/fhttp/cookiejar"
	tls_client "github.com/bogdanfinn/tls-client"
	"github.com/bogdanfinn/tls-client/profiles"
)

const (
	baseURL    = "https://www.cebupacificair.com"
	userAgent  = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36"
	secChUa    = `"Google Chrome";v="137", "Chromium";v="137", "Not/A)Brand";v="24"`
	acceptLang = "en-US,en;q=0.9"
	soarURL = "https://soar.cebupacificair.com"

	// Fallback Hyper SDK API key (overridden by config)
	defaultAPIKey = "b260f3c7-23ea-422c-bcd4-a0b57a11f8a9"
)

// getAPIKey returns the Hyper SDK API key from config (with fallback).
func getAPIKey() string {
	if k := getConfig("api_key"); k != "" {
		return k
	}
	return defaultAPIKey
}

// getProxyURL returns the proxy URL from config.
func getProxyURL() string {
	return getConfig("proxy_url")
}

func getCookie(jar *cookiejar.Jar, name string) string {
	u, _ := url.Parse(baseURL)
	for _, c := range jar.Cookies(u) {
		if c.Name == name {
			return c.Value
		}
	}
	return ""
}

// runAkamaiChallenge runs steps 1–6 (SBSD + V3) and returns the ready client and jar.
func runAkamaiChallenge() (tls_client.HttpClient, *cookiejar.Jar, error) {
	jar, _ := cookiejar.New(nil)
	options := []tls_client.HttpClientOption{
		tls_client.WithTimeoutSeconds(30),
		tls_client.WithClientProfile(profiles.Chrome_133),
		tls_client.WithNotFollowRedirects(),
		tls_client.WithCookieJar(jar),
		tls_client.WithRandomTLSExtensionOrder(),
	}
	if p := getProxyURL(); p != "" {
		options = append(options, tls_client.WithProxyUrl(p))
	}

	client, err := tls_client.NewHttpClient(tls_client.NewNoopLogger(), options...)
	if err != nil {
		return nil, nil, err
	}

	// ── Step 1: GET homepage ────────────────────────────────────────────────
	req, err := http.NewRequest(http.MethodGet, baseURL+"/", nil)
	if err != nil {
		return nil, nil, err
	}
	req.Header = http.Header{
		"sec-ch-ua":                 {secChUa},
		"sec-ch-ua-mobile":          {"?0"},
		"sec-ch-ua-platform":        {`"Windows"`},
		"upgrade-insecure-requests": {"1"},
		"user-agent":                {userAgent},
		"accept":                    {"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7"},
		"sec-fetch-site":            {"none"},
		"sec-fetch-mode":            {"navigate"},
		"sec-fetch-user":            {"?1"},
		"sec-fetch-dest":            {"document"},
		"accept-encoding":           {"gzip, deflate, br, zstd"},
		"accept-language":           {acceptLang},
		"priority":                  {"u=0, i"},
		http.HeaderOrderKey: {
			"sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform",
			"upgrade-insecure-requests", "user-agent", "accept",
			"sec-fetch-site", "sec-fetch-mode", "sec-fetch-user",
			"sec-fetch-dest", "accept-encoding", "accept-language", "priority",
		},
		http.PHeaderOrderKey: {":method", ":authority", ":scheme", ":path"},
	}

	var resp *http.Response
	for attempt := range 4 {
		if attempt > 0 {
			log.Printf("GET / retry %d (proxy timeout)", attempt)
			time.Sleep(time.Duration(attempt) * time.Second)
		}
		resp, err = client.Do(req)
		if err == nil {
			break
		}
		log.Printf("GET / attempt %d error: %v", attempt, err)
	}
	if err != nil {
		return nil, nil, fmt.Errorf("GET homepage: %w", err)
	}
	defer resp.Body.Close()

	htmlBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, nil, err
	}
	html := string(htmlBytes)

	// ── Step 2: Extract SBSD and V3 URLs from initial response ─────────────
	// Match both single and double quoted src attributes
	allSrcRe := regexp.MustCompile(`src=["']([^"']+)["']`)
	var sbsdURL, v3URL string
	for _, m := range allSrcRe.FindAllStringSubmatch(html, -1) {
		if strings.Contains(m[1], "?v=") {
			if strings.HasPrefix(m[1], "/") {
				sbsdURL = baseURL + m[1]
			} else {
				sbsdURL = m[1]
			}
		} else {
			if v3URL == "" {
				if strings.HasPrefix(m[1], "/") {
					v3URL = baseURL + m[1]
				} else if strings.HasPrefix(m[1], "http") {
					v3URL = m[1]
				}
			}
		}
	}
	if sbsdURL == "" {
		return nil, nil, fmt.Errorf("SBSD script not found")
	}

	parsedSBSD, _ := url.Parse(sbsdURL)
	vValue := parsedSBSD.Query().Get("v")

	// ── Step 3: Fetch SBSD script ───────────────────────────────────────────
	scriptReq, err := http.NewRequest(http.MethodGet, sbsdURL, nil)
	if err != nil {
		return nil, nil, err
	}
	scriptReq.Header = http.Header{
		"sec-ch-ua-platform": {`"Windows"`},
		"user-agent":         {userAgent},
		"sec-ch-ua":          {secChUa},
		"sec-ch-ua-mobile":   {"?0"},
		"accept":             {"*/*"},
		"sec-fetch-site":     {"same-origin"},
		"sec-fetch-mode":     {"no-cors"},
		"sec-fetch-dest":     {"script"},
		"referer":            {baseURL + "/"},
		"accept-encoding":    {"gzip, deflate, br, zstd"},
		"accept-language":    {acceptLang},
		http.HeaderOrderKey: {
			"sec-ch-ua-platform", "user-agent", "sec-ch-ua", "sec-ch-ua-mobile",
			"accept", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest",
			"referer", "accept-encoding", "accept-language", "cookie",
		},
		http.PHeaderOrderKey: {":method", ":authority", ":scheme", ":path"},
	}
	scriptResp, err := client.Do(scriptReq)
	if err != nil {
		return nil, nil, err
	}
	sbsdScriptBytes, _ := io.ReadAll(scriptResp.Body)
	scriptResp.Body.Close()
	sbsdScript := string(sbsdScriptBytes)

	// Get bm_so / sbsd_o cookie (o field for SBSD)
	oCookie := getCookie(jar, "bm_so")
	if oCookie == "" {
		oCookie = getCookie(jar, "sbsd_o")
	}

	// Get outbound IP
	ipReq, _ := http.NewRequest(http.MethodGet, "https://api.ipify.org", nil)
	ipResp, err := client.Do(ipReq)
	if err != nil {
		return nil, nil, err
	}
	ipBytes, _ := io.ReadAll(ipResp.Body)
	ipResp.Body.Close()
	outboundIP := strings.TrimSpace(string(ipBytes))

	// ── Step 4: Generate and POST SBSD sensor ──────────────────────────────
	hyperSession := hyper.NewSession(getAPIKey())

	sbsdPayload, err := hyperSession.GenerateSbsdData(context.Background(), &hyper.SbsdInput{
		Index:          0,
		UserAgent:      userAgent,
		Uuid:           vValue,
		PageUrl:        baseURL + "/",
		OCookie:        oCookie,
		Script:         sbsdScript,
		AcceptLanguage: acceptLang,
		IP:             outboundIP,
	})
	if err != nil {
		return nil, nil, fmt.Errorf("GenerateSbsdData: %w", err)
	}
	sbsdBodyBytes, _ := json.Marshal(map[string]string{"body": sbsdPayload})
	sbsdBody := string(sbsdBodyBytes)

	sbsdPostURL, _, _ := strings.Cut(sbsdURL, "?")

	sbsdPostReq, err := http.NewRequest(http.MethodPost, sbsdPostURL, strings.NewReader(sbsdBody))
	if err != nil {
		return nil, nil, err
	}
	sbsdPostReq.Header = http.Header{
		"x-dtreferer":        {baseURL + "/"},
		"sec-ch-ua-platform": {`"Windows"`},
		"user-agent":         {userAgent},
		"x-dtpc":             {genXDtpc()},
		"sec-ch-ua":          {secChUa},
		"content-type":       {"application/json"},
		"sec-ch-ua-mobile":   {"?0"},
		"accept":             {"*/*"},
		"origin":             {baseURL},
		"sec-fetch-site":     {"same-origin"},
		"sec-fetch-mode":     {"cors"},
		"sec-fetch-dest":     {"empty"},
		"referer":            {baseURL + "/"},
		"accept-encoding":    {"gzip, deflate, br, zstd"},
		"accept-language":    {acceptLang},
		"priority":           {"u=1, i"},
		http.HeaderOrderKey: {
			"content-length", "x-dtreferer", "sec-ch-ua-platform",
			"user-agent", "x-dtpc", "sec-ch-ua", "content-type",
			"sec-ch-ua-mobile", "accept", "origin", "sec-fetch-site",
			"sec-fetch-mode", "sec-fetch-dest", "referer",
			"accept-encoding", "accept-language", "cookie", "priority",
		},
		http.PHeaderOrderKey: {":method", ":authority", ":scheme", ":path"},
	}
	sbsdPostResp, err := client.Do(sbsdPostReq)
	if err != nil {
		return nil, nil, fmt.Errorf("POST SBSD: %w", err)
	}
	io.ReadAll(sbsdPostResp.Body)
	sbsdPostResp.Body.Close()
	if sbsdPostResp.StatusCode != 200 && sbsdPostResp.StatusCode != 202 {
		return nil, nil, fmt.Errorf("SBSD POST failed: status %d", sbsdPostResp.StatusCode)
	}

	// ── Step 4b: If V3 URL not in initial response (410), GET again ─────────
	if v3URL == "" {
		homeReq, err := http.NewRequest(http.MethodGet, baseURL+"/", nil)
		if err != nil {
			return nil, nil, err
		}
		homeReq.Header = http.Header{
			"sec-ch-ua":                 {secChUa},
			"sec-ch-ua-mobile":          {"?0"},
			"sec-ch-ua-platform":        {`"Windows"`},
			"upgrade-insecure-requests": {"1"},
			"user-agent":                {userAgent},
			"accept":                    {"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7"},
			"sec-fetch-site":            {"none"},
			"sec-fetch-mode":            {"navigate"},
			"sec-fetch-user":            {"?1"},
			"sec-fetch-dest":            {"document"},
			"accept-encoding":           {"gzip, deflate, br, zstd"},
			"accept-language":           {acceptLang},
			"priority":                  {"u=0, i"},
			http.HeaderOrderKey: {
				"sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform",
				"upgrade-insecure-requests", "user-agent", "accept",
				"sec-fetch-site", "sec-fetch-mode", "sec-fetch-user",
				"sec-fetch-dest", "accept-encoding", "accept-language", "priority",
			},
			http.PHeaderOrderKey: {":method", ":authority", ":scheme", ":path"},
		}
		homeResp, err := client.Do(homeReq)
		if err != nil {
			return nil, nil, err
		}
		homeBytes, _ := io.ReadAll(homeResp.Body)
		homeResp.Body.Close()
		// Use just the first Akamai path segment as filter (e.g. "1qzrHDWI2")
		sbsdPath, _, _ := strings.Cut(strings.TrimPrefix(sbsdURL, baseURL), "?")
		firstSeg, _, _ := strings.Cut(strings.TrimPrefix(sbsdPath, "/"), "/")
		for _, m := range allSrcRe.FindAllStringSubmatch(string(homeBytes), -1) {
			src := m[1]
			if strings.HasPrefix(src, "/"+firstSeg+"/") && !strings.Contains(src, "?v=") {
				v3URL = baseURL + src
				break
			}
		}
		if v3URL == "" {
			return nil, nil, fmt.Errorf("V3 script not found after second GET")
		}
	}

	// ── Step 5: Fetch V3 script ─────────────────────────────────────────────
	v3ScriptReq, err := http.NewRequest(http.MethodGet, v3URL, nil)
	if err != nil {
		return nil, nil, err
	}
	v3ScriptReq.Header = http.Header{
		"sec-ch-ua-platform": {`"Windows"`},
		"user-agent":         {userAgent},
		"sec-ch-ua":          {secChUa},
		"sec-ch-ua-mobile":   {"?0"},
		"accept":             {"*/*"},
		"sec-fetch-site":     {"same-origin"},
		"sec-fetch-mode":     {"no-cors"},
		"sec-fetch-dest":     {"script"},
		"referer":            {baseURL + "/"},
		"accept-encoding":    {"gzip, deflate, br, zstd"},
		"accept-language":    {acceptLang},
		"priority":           {"u=1"},
		http.HeaderOrderKey: {
			"sec-ch-ua-platform", "user-agent", "sec-ch-ua", "sec-ch-ua-mobile",
			"accept", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest",
			"referer", "accept-encoding", "accept-language", "cookie", "priority",
		},
		http.PHeaderOrderKey: {":method", ":authority", ":scheme", ":path"},
	}
	v3ScriptResp, err := client.Do(v3ScriptReq)
	if err != nil {
		return nil, nil, err
	}
	v3ScriptBytes, _ := io.ReadAll(v3ScriptResp.Body)
	v3ScriptResp.Body.Close()
	v3Script := string(v3ScriptBytes)

	bmSz := getCookie(jar, "bm_sz")
	abck := getCookie(jar, "_abck")

	// ── Step 6: V3 sensor loop (up to 7 attempts) ───────────────────────────
	var sensorContext string
	isValidCookie := false

	for i := range 7 {
		input := &hyper.SensorInput{
			Abck:           abck,
			Bmsz:           bmSz,
			Version:        "3",
			PageUrl:        baseURL + "/",
			UserAgent:      userAgent,
			ScriptUrl:      v3URL,
			AcceptLanguage: acceptLang,
			IP:             outboundIP,
			Context:        sensorContext,
		}
		if i == 0 {
			input.Script = v3Script
		}

		var payload, newContext string
		for sdAttempt := range 3 {
			payload, newContext, err = hyperSession.GenerateSensorData(context.Background(), input)
			if err == nil {
				break
			}
			if sdAttempt == 2 {
				return nil, nil, fmt.Errorf("GenerateSensorData i=%d: %w", i, err)
			}
			time.Sleep(time.Duration(sdAttempt+1) * time.Second)
		}
		sensorContext = newContext

		v3BodyBytes, _ := json.Marshal(map[string]string{"sensor_data": payload})
		v3Body := string(v3BodyBytes)

		v3PostReq, err := http.NewRequest(http.MethodPost, v3URL, strings.NewReader(v3Body))
		if err != nil {
			return nil, nil, err
		}
		v3PostReq.Header = http.Header{
			"sec-ch-ua-platform": {`"Windows"`},
			"user-agent":         {userAgent},
			"x-dtpc":             {genXDtpc()},
			"sec-ch-ua":          {secChUa},
			"content-type":       {"text/plain;charset=UTF-8"},
			"sec-ch-ua-mobile":   {"?0"},
			"accept":             {"*/*"},
			"origin":             {baseURL},
			"sec-fetch-site":     {"same-origin"},
			"sec-fetch-mode":     {"cors"},
			"sec-fetch-dest":     {"empty"},
			"referer":            {baseURL + "/"},
			"accept-encoding":    {"gzip, deflate, br, zstd"},
			"accept-language":    {acceptLang},
			"priority":           {"u=1, i"},
			http.HeaderOrderKey: {
				"content-length", "sec-ch-ua-platform", "user-agent", "x-dtpc",
				"sec-ch-ua", "content-type", "sec-ch-ua-mobile", "accept",
				"origin", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest",
				"referer", "accept-encoding", "accept-language", "cookie", "priority",
			},
			http.PHeaderOrderKey: {":method", ":authority", ":scheme", ":path"},
		}

		v3PostResp, err := client.Do(v3PostReq)
		if err != nil {
			return nil, nil, fmt.Errorf("POST V3 i=%d: %w", i, err)
		}
		io.ReadAll(v3PostResp.Body)
		v3PostResp.Body.Close()
		log.Printf("⚡ Anti-Bot [%d/7]", i+1)

		abck = getCookie(jar, "_abck")
		if strings.Contains(abck, "~0~") {
			isValidCookie = true
			break
		}
	}

	if !isValidCookie {
		return nil, nil, fmt.Errorf("failed to get valid _abck after 7 attempts")
	}

	log.Println("✅ Anti-Bot bypass complete")
	return client, jar, nil
}

// makeHPPPost sends the HPP POST to soar using an already-authenticated client.
func makeHPPPost(client tls_client.HttpClient, xAuthToken, bearerToken, hppContent string) (int, string, error) {
	hppBody := hppContent

	hppReq, err := http.NewRequest(http.MethodPost, soarURL+"/ceb-omnix-proxy-v3/v2/cpd/hpp", strings.NewReader(hppBody))
	if err != nil {
		return 0, "", err
	}
	hppReq.Header = http.Header{
		"pragma":             {"no-cache"},
		"cache-control":      {"no-cache"},
		"sec-ch-ua-platform": {`"Windows"`},
		"x-auth-token":       {xAuthToken},
		"authorization":      {"Bearer " + bearerToken},
		"sec-ch-ua":          {`"Google Chrome";v="149", "Chromium";v="149", "Not)A;Brand";v="24"`},
		"sec-ch-ua-mobile":   {"?0"},
		"user-agent":         {getHPPUserAgent()},
		"accept":             {"application/json, text/plain, */*"},
		"content-type":       {"application/json"},
		"origin":             {baseURL},
		"sec-fetch-site":     {"same-site"},
		"sec-fetch-mode":     {"cors"},
		"sec-fetch-dest":     {"empty"},
		"referer":            {baseURL + "/"},
		"accept-encoding":    {"gzip, deflate, br, zstd"},
		"accept-language":    {acceptLang},
		"priority":           {"u=1, i"},
		http.HeaderOrderKey: {
			"content-length", "pragma", "cache-control",
			"sec-ch-ua-platform", "x-auth-token", "authorization",
			"sec-ch-ua", "sec-ch-ua-mobile", "user-agent", "accept",
			"content-type", "origin", "sec-fetch-site", "sec-fetch-mode",
			"sec-fetch-dest", "referer", "accept-encoding", "accept-language",
			"cookie", "priority",
		},
		http.PHeaderOrderKey: {":method", ":authority", ":scheme", ":path"},
	}

	hppResp, err := client.Do(hppReq)
	if err != nil {
		return 0, "", err
	}
	hppRespBytes, _ := io.ReadAll(hppResp.Body)
	hppResp.Body.Close()
	log.Printf("HPP POST status: %d", hppResp.StatusCode)
	log.Printf("HPP POST body: %s", string(hppRespBytes))
	return hppResp.StatusCode, string(hppRespBytes), nil
}

func genXDtpc() string {
	r := rand.New(rand.NewSource(time.Now().UnixNano()))

	var n int
	for n == 0 {
		n = r.Intn(199999) - 99999
	}
	second := r.Intn(900000000) + 100000000

	const alpha = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
	third := make([]byte, 35)
	for i := range third {
		third[i] = alpha[r.Intn(len(alpha))]
	}

	const hex = "0123456789abcdef"
	fourth := make([]byte, 3)
	for i := range fourth {
		fourth[i] = hex[r.Intn(len(hex))]
	}

	return fmt.Sprintf("%d$%d_%s-%s", n, second, string(third), string(fourth))
}
