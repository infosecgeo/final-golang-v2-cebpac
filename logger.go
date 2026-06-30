package main

import (
	"fmt"
	"log"
	"time"
)

// Log levels
const (
	levelINFO    = "INFO"
	levelWARN    = "WARN"
	levelERROR   = "ERROR"
	levelSUCCESS = "SUCCESS"
	levelRETRY   = "RETRY"
	levelDEBUG   = "DEBUG"
)

func logMsg(level, reqID, sessionID, licenseID, msg string) {
	ts := time.Now().UTC().Format("2006-01-02T15:04:05Z")
	log.Printf("[%s] [%s] req=%s session=%s license=%s | %s",
		level, ts, reqID, sessionID, licenseID, msg)
}

func logInfo(msg string)    { logMsg(levelINFO, "-", "-", "-", msg) }
func logWarn(msg string)    { logMsg(levelWARN, "-", "-", "-", msg) }
func logError(msg string)   { logMsg(levelERROR, "-", "-", "-", msg) }
func logSuccess(msg string) { logMsg(levelSUCCESS, "-", "-", "-", msg) }
func logRetry(attempt, max int, msg string) {
	logMsg(levelRETRY, "-", "-", "-", fmt.Sprintf("[Retry %d/%d] %s", attempt, max, msg))
}

func logCtx(level, reqID, sessionID, licenseID, format string, args ...interface{}) {
	logMsg(level, reqID, sessionID, licenseID, fmt.Sprintf(format, args...))
}
