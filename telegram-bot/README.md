# Pusa Pacific – Telegram Bot

## Setup

1. Install dependencies:
   ```bash
   cd telegram-bot
   npm install
   ```

2. Copy and configure the environment file:
   ```bash
   cp .env.example .env
   # Edit .env with your values
   ```

3. Start the bot:
   ```bash
   npm start
   ```

## Configuration

| Variable          | Description                                              | Required |
|-------------------|----------------------------------------------------------|----------|
| `BOT_TOKEN`       | Telegram bot token from [@BotFather](https://t.me/BotFather) | ✓ |
| `ADMIN_CHAT_ID`   | Telegram chat/group ID for admin alerts                  | ✓ |
| `PUSA_API_URL`    | Go backend base URL (e.g. `http://localhost:5000`)       | ✓ |
| `PUSA_API_KEY`    | Shared secret for `X-Bot-Key` header                    | ✓ |
| `WEBHOOK_PORT`    | Port for inbound Go→Bot events (default: `5100`)         | - |
| `WEBHOOK_SECRET`  | Secret for `X-Webhook-Secret` header validation          | - |

## Push Notifications from Go

The Go backend sends events to `POST http://localhost:5100/webhook/event`.

### Event Types

| Type               | Description                                  |
|--------------------|----------------------------------------------|
| `payment_success`  | Payment authorized successfully              |
| `payment_failure`  | Payment declined                             |
| `credit_low`       | License credits below threshold              |
| `maintenance_on`   | Maintenance mode enabled                     |
| `maintenance_off`  | Maintenance mode disabled                    |
| `admin_alert`      | Arbitrary admin broadcast                    |
| `new_session`      | New user session started                     |

### Example payload

```json
{
  "type": "payment_success",
  "payload": {
    "recordLocator": "ABC123",
    "passengerName": "John Doe",
    "flightRoute": "MNL-CEB",
    "flightNumber": "5J123",
    "maskedCard": "411111******1111",
    "bookingStatus": "Confirmed",
    "paymentStatus": "Authorized",
    "authTime": "2024-01-01T12:00:00Z",
    "licenseKey": "LIC-XXXXXXXXXXXXXXXX",
    "creditsRemaining": 9
  }
}
```

## Bot Commands

| Command                      | Description                                  |
|------------------------------|----------------------------------------------|
| `/start`                     | Welcome message                              |
| `/help`                      | Show all commands                            |
| `/status`                    | System health (sessions, licenses, txns)     |
| `/credits <key>`             | Check credit balance for a license           |
| `/stats`                     | Transaction statistics                       |
| `/maintenance on\|off`       | Toggle maintenance mode                      |
| `/broadcast <message>`       | Broadcast message to admin channel           |
