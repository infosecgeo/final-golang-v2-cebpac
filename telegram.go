package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

const telegramAPIBase = "https://api.telegram.org/bot"

// sendTelegramMsg sends a MarkdownV2 message directly to a Telegram chat
// using the bot token stored in system config (telegram_bot_token).
func sendTelegramMsg(chatID, text string) error {
	token := getConfig("telegram_bot_token")
	if token == "" {
		return fmt.Errorf("telegram_bot_token not configured")
	}
	url := telegramAPIBase + token + "/sendMessage"
	body, err := json.Marshal(map[string]interface{}{
		"chat_id":    chatID,
		"text":       text,
		"parse_mode": "MarkdownV2",
	})
	if err != nil {
		return err
	}
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Post(url, "application/json", bytes.NewReader(body))
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("telegram API returned %d", resp.StatusCode)
	}
	return nil
}

// sendTelegramMsgPlain sends a plain-text message (no parse_mode) to a Telegram chat.
func sendTelegramMsgPlain(chatID, text string) error {
	token := getConfig("telegram_bot_token")
	if token == "" {
		return fmt.Errorf("telegram_bot_token not configured")
	}
	url := telegramAPIBase + token + "/sendMessage"
	body, err := json.Marshal(map[string]interface{}{
		"chat_id": chatID,
		"text":    text,
	})
	if err != nil {
		return err
	}
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Post(url, "application/json", bytes.NewReader(body))
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("telegram API returned %d", resp.StatusCode)
	}
	return nil
}

// broadcastToTelegramSubscribers sends a MarkdownV2 message to all registered
// Telegram subscribers directly via the Telegram Bot API.
// This avoids the Go→bot.js→Telegram webhook chain and the 401 issues it causes.
func broadcastToTelegramSubscribers(text string) {
	token := getConfig("telegram_bot_token")
	if token == "" {
		logWarn("broadcastToTelegramSubscribers: telegram_bot_token not configured; skipping")
		return
	}
	subscribers, err := dbListSubscribers()
	if err != nil {
		logWarn("broadcastToTelegramSubscribers fetch subscribers: " + err.Error())
		return
	}
	if len(subscribers) == 0 {
		return
	}

	url := telegramAPIBase + token + "/sendMessage"
	client := &http.Client{Timeout: 10 * time.Second}
	sent, failed := 0, 0
	for _, sub := range subscribers {
		body, err := json.Marshal(map[string]interface{}{
			"chat_id":    sub.ChatID,
			"text":       text,
			"parse_mode": "MarkdownV2",
		})
		if err != nil {
			failed++
			continue
		}
		resp, err := client.Post(url, "application/json", bytes.NewReader(body))
		if err != nil {
			failed++
			logWarn(fmt.Sprintf("broadcastToTelegramSubscribers send to %s: %v", sub.ChatID, err))
		} else {
			resp.Body.Close()
			if resp.StatusCode == 200 {
				sent++
			} else {
				failed++
			}
		}
		// Small delay to respect Telegram rate limits (~30 msg/sec global)
		time.Sleep(50 * time.Millisecond)
	}
	logInfo(fmt.Sprintf("Telegram broadcast complete: %d sent, %d failed", sent, failed))
}

// escMdV2 escapes a plain string for use in a Telegram MarkdownV2 message.
func escMdV2(s string) string {
	replacer := strings.NewReplacer(
		`_`, `\_`,
		`*`, `\*`,
		`[`, `\[`,
		`]`, `\]`,
		`(`, `\(`,
		`)`, `\)`,
		`~`, `\~`,
		"`", "\\`",
		`>`, `\>`,
		`#`, `\#`,
		`+`, `\+`,
		`-`, `\-`,
		`=`, `\=`,
		`|`, `\|`,
		`{`, `\{`,
		`}`, `\}`,
		`.`, `\.`,
		`!`, `\!`,
		`\`, `\\`,
	)
	return replacer.Replace(s)
}

// sendPaymentReceipt sends a payment success receipt directly to the Telegram
// user linked to the given license.
func sendPaymentReceipt(lic *License, recordLocator, passengerName, flightRoute, flightNumber, bookingStatus, cardMasked string, creditsRemaining int, authTime string) {
	if lic == nil || lic.TelegramChatID == "" {
		return
	}
	msg := strings.Join([]string{
		`✅ *Payment Authorized \— Receipt*`,
		``,
		`🎫 *Record Locator:* ` + "`" + escMdV2(recordLocator) + "`",
		`👤 *Passenger:* ` + escMdV2(passengerName),
		`✈️ *Flight:* ` + escMdV2(flightRoute) + ` ` + escMdV2(flightNumber),
		`📋 *Booking:* ` + escMdV2(bookingStatus),
		`💳 *Card:* ` + "`" + escMdV2(cardMasked) + "`",
		`💰 *Payment:* Authorized`,
		`🕐 *Time:* ` + escMdV2(authTime),
		``,
		`🔑 *License:* ` + "`" + escMdV2(lic.Key) + "`" + `  Credits remaining: *` + escMdV2(fmt.Sprintf("%d", creditsRemaining)) + `*`,
	}, "\n")

	if err := sendTelegramMsg(lic.TelegramChatID, msg); err != nil {
		logWarn(fmt.Sprintf("sendPaymentReceipt to chatID %s: %v", lic.TelegramChatID, err))
	}
}
