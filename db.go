package main

import (
	"database/sql"
	"fmt"
	"time"

	_ "modernc.org/sqlite"
)

var db *sql.DB

func initDB(path string) error {
	var err error
	db, err = sql.Open("sqlite", path+"?_journal_mode=WAL&_foreign_keys=on")
	if err != nil {
		return fmt.Errorf("open db: %w", err)
	}
	// SQLite supports only one writer at a time; a single connection avoids SQLITE_BUSY.
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	if err = db.Ping(); err != nil {
		return fmt.Errorf("ping db: %w", err)
	}
	return createSchema()
}

func createSchema() error {
	stmts := []string{
		`CREATE TABLE IF NOT EXISTS admins (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			username TEXT UNIQUE NOT NULL,
			password_hash TEXT NOT NULL,
			role TEXT NOT NULL DEFAULT 'admin',
			created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
			failed_attempts INTEGER DEFAULT 0,
			locked_until TIMESTAMP
		)`,
		`CREATE TABLE IF NOT EXISTS licenses (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			key TEXT UNIQUE NOT NULL,
			credits INTEGER DEFAULT 0,
			expires_at TIMESTAMP,
			active INTEGER DEFAULT 1,
			suspended INTEGER DEFAULT 0,
			notes TEXT DEFAULT '',
			created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
		)`,
		`CREATE TABLE IF NOT EXISTS sessions (
			id TEXT PRIMARY KEY,
			license_id INTEGER,
			admin_id INTEGER,
			role TEXT NOT NULL,
			created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
			expires_at TIMESTAMP NOT NULL,
			revoked INTEGER DEFAULT 0
		)`,
		`CREATE TABLE IF NOT EXISTS credit_history (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			license_id INTEGER NOT NULL,
			delta INTEGER NOT NULL,
			reason TEXT,
			balance_after INTEGER NOT NULL,
			created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
		)`,
		`CREATE TABLE IF NOT EXISTS system_config (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL,
			updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
		)`,
		`CREATE TABLE IF NOT EXISTS transactions (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			license_id INTEGER,
			card_masked TEXT,
			result TEXT,
			record_locator TEXT,
			passenger_name TEXT,
			message TEXT,
			created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
		)`,
		`CREATE TABLE IF NOT EXISTS credit_packages (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			name TEXT NOT NULL,
			credits INTEGER NOT NULL,
			price_php REAL NOT NULL,
			active INTEGER DEFAULT 1,
			created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
			updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
		)`,
		`CREATE TABLE IF NOT EXISTS telegram_subscribers (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			telegram_user_id TEXT UNIQUE NOT NULL,
			telegram_username TEXT DEFAULT '',
			telegram_chat_id TEXT NOT NULL,
			subscribed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
		)`,
		`CREATE TABLE IF NOT EXISTS purchase_requests (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			telegram_user_id TEXT NOT NULL,
			telegram_username TEXT DEFAULT '',
			telegram_chat_id TEXT NOT NULL,
			package_id INTEGER,
			package_name TEXT DEFAULT '',
			credits INTEGER NOT NULL,
			amount_php REAL NOT NULL,
			license_key TEXT DEFAULT '',
			status TEXT DEFAULT 'pending',
			admin_note TEXT DEFAULT '',
			created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
			updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
		)`,
	}
	for _, s := range stmts {
		if _, err := db.Exec(s); err != nil {
			return fmt.Errorf("schema: %w", err)
		}
	}
	// Migration: add role column to existing admins tables that predate this change.
	// SQLite returns an error if the column already exists; ignore it.
	db.Exec(`ALTER TABLE admins ADD COLUMN role TEXT NOT NULL DEFAULT 'admin'`)
	// Migration: add telegram_user_id to licenses for 1:1 TG account ↔ license linking.
	db.Exec(`ALTER TABLE licenses ADD COLUMN telegram_user_id TEXT NOT NULL DEFAULT ''`)
	return nil
}

// ── Admin ─────────────────────────────────────────────────────────────────────

type Admin struct {
	ID           int64
	Username     string
	PasswordHash string
	Role         string
	CreatedAt    time.Time
	FailedAttempts int
	LockedUntil  *time.Time
}

func dbGetAdmin(username string) (*Admin, error) {
	a := &Admin{}
	var lockedUntil sql.NullString
	err := db.QueryRow(
		`SELECT id, username, password_hash, role, created_at, failed_attempts, locked_until
		 FROM admins WHERE username = ?`, username,
	).Scan(&a.ID, &a.Username, &a.PasswordHash, &a.Role, &a.CreatedAt, &a.FailedAttempts, &lockedUntil)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if lockedUntil.Valid {
		t, _ := time.Parse(time.RFC3339, lockedUntil.String)
		a.LockedUntil = &t
	}
	return a, nil
}

func dbCreateAdmin(username, passwordHash, role string) error {
	_, err := db.Exec(`INSERT INTO admins (username, password_hash, role) VALUES (?, ?, ?)`, username, passwordHash, role)
	return err
}

func dbAdminIncrFailed(adminID int64) error {
	_, err := db.Exec(`UPDATE admins SET failed_attempts = failed_attempts + 1 WHERE id = ?`, adminID)
	return err
}

func dbAdminLockUntil(adminID int64, until time.Time) error {
	_, err := db.Exec(`UPDATE admins SET locked_until = ?, failed_attempts = 0 WHERE id = ?`,
		until.UTC().Format(time.RFC3339), adminID)
	return err
}

func dbAdminClearFailed(adminID int64) error {
	_, err := db.Exec(`UPDATE admins SET failed_attempts = 0, locked_until = NULL WHERE id = ?`, adminID)
	return err
}

// ── License ──────────────────────────────────────────────────────────────────

type License struct {
	ID             int64
	Key            string
	Credits        int
	ExpiresAt      *time.Time
	Active         bool
	Suspended      bool
	Notes          string
	CreatedAt      time.Time
	TelegramUserID string
}

func dbGetLicenseByKey(key string) (*License, error) {
	l := &License{}
	var exp sql.NullString
	var active, suspended int
	err := db.QueryRow(
		`SELECT id, key, credits, expires_at, active, suspended, notes, created_at, COALESCE(telegram_user_id, '')
		 FROM licenses WHERE key = ?`, key,
	).Scan(&l.ID, &l.Key, &l.Credits, &exp, &active, &suspended, &l.Notes, &l.CreatedAt, &l.TelegramUserID)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	l.Active = active == 1
	l.Suspended = suspended == 1
	if exp.Valid {
		t, _ := time.Parse(time.RFC3339, exp.String)
		l.ExpiresAt = &t
	}
	return l, nil
}

func dbGetLicenseByID(id int64) (*License, error) {
	l := &License{}
	var exp sql.NullString
	var active, suspended int
	err := db.QueryRow(
		`SELECT id, key, credits, expires_at, active, suspended, notes, created_at, COALESCE(telegram_user_id, '')
		 FROM licenses WHERE id = ?`, id,
	).Scan(&l.ID, &l.Key, &l.Credits, &exp, &active, &suspended, &l.Notes, &l.CreatedAt, &l.TelegramUserID)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	l.Active = active == 1
	l.Suspended = suspended == 1
	if exp.Valid {
		t, _ := time.Parse(time.RFC3339, exp.String)
		l.ExpiresAt = &t
	}
	return l, nil
}

func dbListLicenses() ([]License, error) {
	rows, err := db.Query(
		`SELECT id, key, credits, expires_at, active, suspended, notes, created_at, COALESCE(telegram_user_id, '')
		 FROM licenses ORDER BY id DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var list []License
	for rows.Next() {
		l := License{}
		var exp sql.NullString
		var active, suspended int
		if e := rows.Scan(&l.ID, &l.Key, &l.Credits, &exp, &active, &suspended, &l.Notes, &l.CreatedAt, &l.TelegramUserID); e != nil {
			return nil, e
		}
		l.Active = active == 1
		l.Suspended = suspended == 1
		if exp.Valid {
			t, _ := time.Parse(time.RFC3339, exp.String)
			l.ExpiresAt = &t
		}
		list = append(list, l)
	}
	return list, rows.Err()
}

func dbCreateLicense(key string, credits int, expiresAt *time.Time, notes string) (int64, error) {
	var expStr interface{}
	if expiresAt != nil {
		expStr = expiresAt.UTC().Format(time.RFC3339)
	}
	r, err := db.Exec(`INSERT INTO licenses (key, credits, expires_at, notes) VALUES (?, ?, ?, ?)`,
		key, credits, expStr, notes)
	if err != nil {
		return 0, err
	}
	return r.LastInsertId()
}

func dbUpdateLicense(id int64, credits int, expiresAt *time.Time, active, suspended bool, notes string) error {
	var expStr interface{}
	if expiresAt != nil {
		expStr = expiresAt.UTC().Format(time.RFC3339)
	}
	activeInt, suspendedInt := 0, 0
	if active {
		activeInt = 1
	}
	if suspended {
		suspendedInt = 1
	}
	_, err := db.Exec(
		`UPDATE licenses SET credits=?, expires_at=?, active=?, suspended=?, notes=? WHERE id=?`,
		credits, expStr, activeInt, suspendedInt, notes, id)
	return err
}

func dbDeleteLicense(id int64) error {
	_, err := db.Exec(`DELETE FROM licenses WHERE id = ?`, id)
	return err
}

func dbDeductCredit(licenseID int64, reason string) (int, error) {
	tx, err := db.Begin()
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()

	var credits int
	if e := tx.QueryRow(`SELECT credits FROM licenses WHERE id = ?`, licenseID).Scan(&credits); e != nil {
		return 0, e
	}
	if credits <= 0 {
		return 0, fmt.Errorf("insufficient credits")
	}
	newBal := credits - 1
	if _, e := tx.Exec(`UPDATE licenses SET credits = ? WHERE id = ?`, newBal, licenseID); e != nil {
		return 0, e
	}
	if _, e := tx.Exec(
		`INSERT INTO credit_history (license_id, delta, reason, balance_after) VALUES (?, ?, ?, ?)`,
		licenseID, -1, reason, newBal); e != nil {
		return 0, e
	}
	return newBal, tx.Commit()
}

func dbAdjustCredits(licenseID int64, delta int, reason string) (int, error) {
	tx, err := db.Begin()
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()

	var credits int
	if e := tx.QueryRow(`SELECT credits FROM licenses WHERE id = ?`, licenseID).Scan(&credits); e != nil {
		return 0, e
	}
	newBal := credits + delta
	if newBal < 0 {
		newBal = 0
	}
	if _, e := tx.Exec(`UPDATE licenses SET credits = ? WHERE id = ?`, newBal, licenseID); e != nil {
		return 0, e
	}
	if _, e := tx.Exec(
		`INSERT INTO credit_history (license_id, delta, reason, balance_after) VALUES (?, ?, ?, ?)`,
		licenseID, delta, reason, newBal); e != nil {
		return 0, e
	}
	return newBal, tx.Commit()
}

func dbCreditHistory(licenseID int64) ([]map[string]interface{}, error) {
	rows, err := db.Query(
		`SELECT delta, reason, balance_after, created_at FROM credit_history
		 WHERE license_id = ? ORDER BY id DESC LIMIT 100`, licenseID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var list []map[string]interface{}
	for rows.Next() {
		var delta, bal int
		var reason sql.NullString
		var createdAt time.Time
		if e := rows.Scan(&delta, &reason, &bal, &createdAt); e != nil {
			return nil, e
		}
		list = append(list, map[string]interface{}{
			"delta":       delta,
			"reason":      reason.String,
			"balanceAfter": bal,
			"createdAt":   createdAt,
		})
	}
	return list, rows.Err()
}

// ── Session ───────────────────────────────────────────────────────────────────

type Session struct {
	ID        string
	LicenseID *int64
	AdminID   *int64
	Role      string
	CreatedAt time.Time
	ExpiresAt time.Time
	Revoked   bool
}

func dbCreateSession(id string, licenseID *int64, adminID *int64, role string, expiresAt time.Time) error {
	// Revoke any existing active session for the same license/admin
	if licenseID != nil {
		db.Exec(`UPDATE sessions SET revoked=1 WHERE license_id=? AND revoked=0`, *licenseID)
	}
	if adminID != nil {
		db.Exec(`UPDATE sessions SET revoked=1 WHERE admin_id=? AND revoked=0`, *adminID)
	}
	var lID, aID interface{}
	if licenseID != nil {
		lID = *licenseID
	}
	if adminID != nil {
		aID = *adminID
	}
	_, err := db.Exec(
		`INSERT INTO sessions (id, license_id, admin_id, role, expires_at) VALUES (?, ?, ?, ?, ?)`,
		id, lID, aID, role, expiresAt.UTC().Format(time.RFC3339))
	return err
}

func dbGetSession(id string) (*Session, error) {
	s := &Session{ID: id}
	var licID, admID sql.NullInt64
	var revoked int
	err := db.QueryRow(
		`SELECT license_id, admin_id, role, created_at, expires_at, revoked FROM sessions WHERE id=?`, id,
	).Scan(&licID, &admID, &s.Role, &s.CreatedAt, &s.ExpiresAt, &revoked)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if licID.Valid {
		v := licID.Int64
		s.LicenseID = &v
	}
	if admID.Valid {
		v := admID.Int64
		s.AdminID = &v
	}
	s.Revoked = revoked == 1
	return s, nil
}

func dbRevokeSession(id string) error {
	_, err := db.Exec(`UPDATE sessions SET revoked=1 WHERE id=?`, id)
	return err
}

func dbListActiveSessions() ([]map[string]interface{}, error) {
	rows, err := db.Query(`
		SELECT s.id, s.role, s.created_at, s.expires_at, l.key, a.username
		FROM sessions s
		LEFT JOIN licenses l ON s.license_id = l.id
		LEFT JOIN admins a ON s.admin_id = a.id
		WHERE s.revoked = 0 AND s.expires_at > CURRENT_TIMESTAMP
		ORDER BY s.created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var list []map[string]interface{}
	for rows.Next() {
		var id, role string
		var created, expires time.Time
		var licKey, adminUser sql.NullString
		if e := rows.Scan(&id, &role, &created, &expires, &licKey, &adminUser); e != nil {
			return nil, e
		}
		list = append(list, map[string]interface{}{
			"id":        id,
			"role":      role,
			"createdAt": created,
			"expiresAt": expires,
			"licenseKey": licKey.String,
			"adminUser": adminUser.String,
		})
	}
	return list, rows.Err()
}

// ── Config ────────────────────────────────────────────────────────────────────

func dbGetConfig(key string) (string, error) {
	var val string
	err := db.QueryRow(`SELECT value FROM system_config WHERE key=?`, key).Scan(&val)
	if err == sql.ErrNoRows {
		return "", nil
	}
	return val, err
}

func dbSetConfig(key, value string) error {
	_, err := db.Exec(
		`INSERT INTO system_config (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
		 ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
		key, value)
	return err
}

func dbAllConfig() (map[string]string, error) {
	rows, err := db.Query(`SELECT key, value FROM system_config`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	m := make(map[string]string)
	for rows.Next() {
		var k, v string
		if e := rows.Scan(&k, &v); e != nil {
			return nil, e
		}
		m[k] = v
	}
	return m, rows.Err()
}

// ── Transaction log ───────────────────────────────────────────────────────────

func dbLogTransaction(licenseID *int64, cardMasked, result, recordLocator, passengerName, message string) {
	var lID interface{}
	if licenseID != nil {
		lID = *licenseID
	}
	if _, err := db.Exec(
		`INSERT INTO transactions (license_id, card_masked, result, record_locator, passenger_name, message)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		lID, cardMasked, result, recordLocator, passengerName, message,
	); err != nil {
		logError("dbLogTransaction: " + err.Error())
	}
}

// ── Credit Packages ───────────────────────────────────────────────────────────

type CreditPackage struct {
	ID        int64     `json:"id"`
	Name      string    `json:"name"`
	Credits   int       `json:"credits"`
	PricePHP  float64   `json:"pricePHP"`
	Active    bool      `json:"active"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

func dbListPackages(activeOnly bool) ([]CreditPackage, error) {
	q := `SELECT id, name, credits, price_php, active, created_at, updated_at FROM credit_packages`
	if activeOnly {
		q += ` WHERE active=1`
	}
	q += ` ORDER BY price_php ASC`
	rows, err := db.Query(q)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var list []CreditPackage
	for rows.Next() {
		var p CreditPackage
		var active int
		if e := rows.Scan(&p.ID, &p.Name, &p.Credits, &p.PricePHP, &active, &p.CreatedAt, &p.UpdatedAt); e != nil {
			return nil, e
		}
		p.Active = active == 1
		list = append(list, p)
	}
	return list, rows.Err()
}

func dbGetPackage(id int64) (*CreditPackage, error) {
	p := &CreditPackage{}
	var active int
	err := db.QueryRow(
		`SELECT id, name, credits, price_php, active, created_at, updated_at FROM credit_packages WHERE id=?`, id,
	).Scan(&p.ID, &p.Name, &p.Credits, &p.PricePHP, &active, &p.CreatedAt, &p.UpdatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	p.Active = active == 1
	return p, nil
}

func dbCreatePackage(name string, credits int, pricePHP float64) (int64, error) {
	r, err := db.Exec(
		`INSERT INTO credit_packages (name, credits, price_php) VALUES (?, ?, ?)`,
		name, credits, pricePHP)
	if err != nil {
		return 0, err
	}
	return r.LastInsertId()
}

func dbUpdatePackage(id int64, name string, credits int, pricePHP float64, active bool) error {
	activeInt := 0
	if active {
		activeInt = 1
	}
	_, err := db.Exec(
		`UPDATE credit_packages SET name=?, credits=?, price_php=?, active=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`,
		name, credits, pricePHP, activeInt, id)
	return err
}

func dbDeletePackage(id int64) error {
	_, err := db.Exec(`DELETE FROM credit_packages WHERE id=?`, id)
	return err
}

// ── Telegram Subscribers ──────────────────────────────────────────────────────

type TelegramSubscriber struct {
	ID             int64     `json:"id"`
	TelegramUserID string    `json:"telegramUserId"`
	Username       string    `json:"username"`
	ChatID         string    `json:"chatId"`
	SubscribedAt   time.Time `json:"subscribedAt"`
}

func dbUpsertSubscriber(telegramUserID, username, chatID string) error {
	_, err := db.Exec(
		`INSERT INTO telegram_subscribers (telegram_user_id, telegram_username, telegram_chat_id)
		 VALUES (?, ?, ?)
		 ON CONFLICT(telegram_user_id) DO UPDATE SET
		   telegram_username=excluded.telegram_username,
		   telegram_chat_id=excluded.telegram_chat_id`,
		telegramUserID, username, chatID)
	return err
}

func dbListSubscribers() ([]TelegramSubscriber, error) {
	rows, err := db.Query(
		`SELECT id, telegram_user_id, telegram_username, telegram_chat_id, subscribed_at
		 FROM telegram_subscribers ORDER BY subscribed_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var list []TelegramSubscriber
	for rows.Next() {
		var s TelegramSubscriber
		if e := rows.Scan(&s.ID, &s.TelegramUserID, &s.Username, &s.ChatID, &s.SubscribedAt); e != nil {
			return nil, e
		}
		list = append(list, s)
	}
	return list, rows.Err()
}

// ── Purchase Requests ─────────────────────────────────────────────────────────

type PurchaseRequest struct {
	ID             int64     `json:"id"`
	TelegramUserID string    `json:"telegramUserId"`
	Username       string    `json:"username"`
	ChatID         string    `json:"chatId"`
	PackageID      int64     `json:"packageId"`
	PackageName    string    `json:"packageName"`
	Credits        int       `json:"credits"`
	AmountPHP      float64   `json:"amountPHP"`
	LicenseKey     string    `json:"licenseKey"`
	Status         string    `json:"status"`
	AdminNote      string    `json:"adminNote"`
	CreatedAt      time.Time `json:"createdAt"`
	UpdatedAt      time.Time `json:"updatedAt"`
}

func dbCreatePurchaseRequest(telegramUserID, username, chatID string, packageID int64, packageName string, credits int, amountPHP float64, licenseKey string) (int64, error) {
	r, err := db.Exec(
		`INSERT INTO purchase_requests (telegram_user_id, telegram_username, telegram_chat_id, package_id, package_name, credits, amount_php, license_key)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		telegramUserID, username, chatID, packageID, packageName, credits, amountPHP, licenseKey)
	if err != nil {
		return 0, err
	}
	return r.LastInsertId()
}

func dbGetPurchaseRequest(id int64) (*PurchaseRequest, error) {
	p := &PurchaseRequest{}
	err := db.QueryRow(
		`SELECT id, telegram_user_id, telegram_username, telegram_chat_id, package_id, package_name,
		        credits, amount_php, license_key, status, admin_note, created_at, updated_at
		 FROM purchase_requests WHERE id=?`, id,
	).Scan(&p.ID, &p.TelegramUserID, &p.Username, &p.ChatID, &p.PackageID, &p.PackageName,
		&p.Credits, &p.AmountPHP, &p.LicenseKey, &p.Status, &p.AdminNote, &p.CreatedAt, &p.UpdatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return p, nil
}

func dbUpdatePurchaseRequestStatus(id int64, status, adminNote string) error {
	_, err := db.Exec(
		`UPDATE purchase_requests SET status=?, admin_note=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`,
		status, adminNote, id)
	return err
}

func dbListPurchaseRequests(status string) ([]PurchaseRequest, error) {
	var rows *sql.Rows
	var err error
	if status != "" {
		rows, err = db.Query(
			`SELECT id, telegram_user_id, telegram_username, telegram_chat_id, package_id, package_name,
			        credits, amount_php, license_key, status, admin_note, created_at, updated_at
			 FROM purchase_requests WHERE status=? ORDER BY created_at DESC`, status)
	} else {
		rows, err = db.Query(
			`SELECT id, telegram_user_id, telegram_username, telegram_chat_id, package_id, package_name,
			        credits, amount_php, license_key, status, admin_note, created_at, updated_at
			 FROM purchase_requests ORDER BY created_at DESC LIMIT 100`) // cap at 100 for the unfiltered admin overview
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var list []PurchaseRequest
	for rows.Next() {
		var p PurchaseRequest
		if e := rows.Scan(&p.ID, &p.TelegramUserID, &p.Username, &p.ChatID, &p.PackageID, &p.PackageName,
			&p.Credits, &p.AmountPHP, &p.LicenseKey, &p.Status, &p.AdminNote, &p.CreatedAt, &p.UpdatedAt); e != nil {
			return nil, e
		}
		list = append(list, p)
	}
	return list, rows.Err()
}

// ── Telegram ↔ License Linking ────────────────────────────────────────────────

// dbLinkTelegramToLicense atomically links a Telegram user ID to a license key.
// Rules: one TG account per license, one license per TG account.
func dbLinkTelegramToLicense(licenseKey, telegramUserID string) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	var currentTgID string
	if e := tx.QueryRow(`SELECT COALESCE(telegram_user_id, '') FROM licenses WHERE key=?`, licenseKey).Scan(&currentTgID); e == sql.ErrNoRows {
		return fmt.Errorf("license not found")
	} else if e != nil {
		return e
	}

	// Idempotent: already linked to same TG user.
	if currentTgID == telegramUserID {
		return nil
	}

	// License already claimed by a different TG user.
	if currentTgID != "" {
		return fmt.Errorf("this license is already linked to another Telegram account")
	}

	// Ensure this TG user does not already own another license.
	var count int
	if e := tx.QueryRow(`SELECT COUNT(*) FROM licenses WHERE telegram_user_id=?`, telegramUserID).Scan(&count); e != nil {
		return e
	}
	if count > 0 {
		return fmt.Errorf("your Telegram account is already linked to a license")
	}

	if _, e := tx.Exec(`UPDATE licenses SET telegram_user_id=? WHERE key=?`, telegramUserID, licenseKey); e != nil {
		return e
	}
	return tx.Commit()
}

// dbGetChatIDForLicense returns the Telegram chat ID of the user linked to the
// given license, or an empty string if no user is linked / not a subscriber.
func dbGetChatIDForLicense(licenseID int64) string {
	var chatID string
	db.QueryRow(`
		SELECT ts.telegram_chat_id
		FROM licenses l
		JOIN telegram_subscribers ts ON ts.telegram_user_id = l.telegram_user_id
		WHERE l.id = ? AND l.telegram_user_id != ''
	`, licenseID).Scan(&chatID)
	return chatID
}
