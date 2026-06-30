package main

import (
	"fmt"
	"math/rand"
	"time"
)

// retryableErr checks if an error/status warrants a retry.
func retryableErr(err error, statusCode int) bool {
	if err != nil {
		return true // network errors are always retryable
	}
	switch statusCode {
	case 400, 429, 500, 502, 503, 504:
		return true
	}
	return false
}

// RetryResult holds the outcome of a retried operation.
type RetryResult struct {
	Value interface{}
	Err   error
}

// retryWithBackoff runs fn up to maxRetries times with exponential backoff + jitter.
// fn should return (value, statusCode, error).
// It retries when retryableErr(err, statusCode) is true.
func retryWithBackoff(name string, maxRetries int, fn func() (interface{}, int, error)) (interface{}, error) {
	if maxRetries <= 0 {
		maxRetries = getConfigInt("max_retries", 10)
	}

	var lastErr error
	for attempt := 1; attempt <= maxRetries; attempt++ {
		logRetry(attempt, maxRetries, fmt.Sprintf("Attempting %s...", name))

		val, code, err := fn()
		if err == nil && !retryableErr(nil, code) {
			if attempt > 1 {
				logSuccess(fmt.Sprintf("%s succeeded on attempt %d", name, attempt))
			}
			return val, nil
		}
		lastErr = err
		if err == nil {
			lastErr = fmt.Errorf("HTTP %d", code)
		}

		if attempt < maxRetries {
			backoff := time.Duration(1<<uint(attempt-1)) * 500 * time.Millisecond
			jitter := time.Duration(rand.Intn(500)) * time.Millisecond
			wait := backoff + jitter
			if wait > 30*time.Second {
				wait = 30 * time.Second
			}
			logRetry(attempt, maxRetries, fmt.Sprintf("Waiting %v before retry... (%v)", wait, lastErr))
			time.Sleep(wait)
		} else {
			logMsg(levelERROR, "-", "-", "-", fmt.Sprintf("%s failed after %d attempts: %v", name, maxRetries, lastErr))
		}
	}
	return nil, fmt.Errorf("%s failed after %d retries: %w", name, maxRetries, lastErr)
}
