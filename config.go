package main

import (
	"strconv"
	"sync"
)

// Defaults applied when no DB value exists.
var configDefaults = map[string]string{
	"proxy_url":           "******us.proxy001.com:7878",
	"api_key":             "b260f3c7-23ea-422c-bcd4-a0b57a11f8a9",
	"maintenance_mode":    "false",
	"auto_hit_enabled":    "false",
	"manual_hit_enabled":  "true",
	"max_retries":         "10",
	"retry_timeout_ms":    "30000",
	"jwt_expiry_hours":    "24",
	"admin_jwt_expiry_hours": "8",
	"rate_limit_per_ip":  "30",
	"credit_cost":        "1",
	"telegram_bot_token": "",
	"telegram_chat_id":   "",
	"maintenance_message": "The service is temporarily unavailable. Please try again later.",
}

var (
	cfgMu    sync.RWMutex
	cfgCache map[string]string
)

// getConfig returns a config value, using DB then defaults.
func getConfig(key string) string {
	cfgMu.RLock()
	if cfgCache != nil {
		if v, ok := cfgCache[key]; ok {
			cfgMu.RUnlock()
			return v
		}
	}
	cfgMu.RUnlock()

	if db != nil {
		if v, err := dbGetConfig(key); err == nil && v != "" {
			return v
		}
	}
	return configDefaults[key]
}

// setConfig persists a config value and updates the cache.
func setConfig(key, value string) error {
	if err := dbSetConfig(key, value); err != nil {
		return err
	}
	cfgMu.Lock()
	if cfgCache == nil {
		cfgCache = make(map[string]string)
	}
	cfgCache[key] = value
	cfgMu.Unlock()
	return nil
}

// reloadConfig refreshes the in-memory cache from DB.
func reloadConfig() {
	if db == nil {
		return
	}
	m, err := dbAllConfig()
	if err != nil {
		logError("reloadConfig: " + err.Error())
		return
	}
	// Merge with defaults (DB values override defaults)
	merged := make(map[string]string)
	for k, v := range configDefaults {
		merged[k] = v
	}
	for k, v := range m {
		merged[k] = v
	}
	cfgMu.Lock()
	cfgCache = merged
	cfgMu.Unlock()
}

// getConfigBool returns a boolean config value.
func getConfigBool(key string) bool {
	v := getConfig(key)
	return v == "true" || v == "1"
}

// getConfigInt returns an integer config value.
func getConfigInt(key string, fallback int) int {
	v := getConfig(key)
	if n, err := strconv.Atoi(v); err == nil {
		return n
	}
	return fallback
}

// getAllConfig returns all config as a merged map (DB + defaults).
func getAllConfig() map[string]string {
	cfgMu.RLock()
	defer cfgMu.RUnlock()
	if cfgCache != nil {
		out := make(map[string]string, len(cfgCache))
		for k, v := range cfgCache {
			out[k] = v
		}
		return out
	}
	// No cache yet — return defaults
	out := make(map[string]string, len(configDefaults))
	for k, v := range configDefaults {
		out[k] = v
	}
	return out
}
