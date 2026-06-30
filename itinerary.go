package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// ItineraryData holds the parsed booking details after payment authorization.
type ItineraryData struct {
	RecordLocator string `json:"recordLocator"`
	PassengerName string `json:"passengerName"`
	FlightRoute   string `json:"flightRoute"`
	FlightNumber  string `json:"flightNumber"`
	BookingStatus string `json:"bookingStatus"`
}

// fetchItinerary retrieves the booking itinerary from Cebu Pacific SOAR API.
// It mirrors the JavaScript logic provided in the requirements.
func fetchItinerary(xAuthToken, bearerToken string) (*ItineraryData, error) {
	url := "https://soar.cebupacificair.com/ceb-omnix-proxy-v3/itinerary"

	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return nil, fmt.Errorf("build itinerary request: %w", err)
	}
	req.Header.Set("X-Auth-Token", xAuthToken)
	req.Header.Set("Authorization", "Bearer "+bearerToken)
	req.Header.Set("Referer", "https://www.cebupacificair.com")
	req.Header.Set("Origin", "https://www.cebupacificair.com")
	req.Header.Set("Accept", "application/json, text/plain, */*")
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set("Accept-Language", "en-US,en;q=0.9")

	stdCl := newStdClient()
	resp, err := stdCl.Do(req)
	if err != nil {
		return nil, fmt.Errorf("itinerary request: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read itinerary body: %w", err)
	}

	logInfo(fmt.Sprintf("[*] Itinerary fetched successfully. Status: %d", resp.StatusCode))

	var raw map[string]interface{}
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil, fmt.Errorf("parse itinerary JSON: %w", err)
	}

	data := &ItineraryData{}

	// Extract record locator
	if rl, ok := raw["recordLocator"].(string); ok {
		data.RecordLocator = rl
		logInfo(fmt.Sprintf("[*] Record Locator: %s", rl))
	}

	// Try to extract passenger name from passengers array
	if passengers, ok := raw["passengers"].([]interface{}); ok && len(passengers) > 0 {
		if p, ok := passengers[0].(map[string]interface{}); ok {
			firstName := fmt.Sprint(p["firstName"])
			lastName := fmt.Sprint(p["lastName"])
			if firstName != "<nil>" && lastName != "<nil>" {
				data.PassengerName = strings.TrimSpace(firstName + " " + lastName)
			}
		}
	}

	// Try to extract flight information from segments
	if segments, ok := raw["segments"].([]interface{}); ok && len(segments) > 0 {
		if seg, ok := segments[0].(map[string]interface{}); ok {
			origin := fmt.Sprint(seg["origin"])
			destination := fmt.Sprint(seg["destination"])
			flightNum := fmt.Sprint(seg["flightNumber"])
			if origin != "<nil>" && destination != "<nil>" {
				data.FlightRoute = origin + " → " + destination
			}
			if flightNum != "<nil>" {
				data.FlightNumber = flightNum
			}
		}
	}

	// Try journey-level data as fallback
	if data.FlightRoute == "" {
		if journeys, ok := raw["journeys"].([]interface{}); ok && len(journeys) > 0 {
			if j, ok := journeys[0].(map[string]interface{}); ok {
				origin := fmt.Sprint(j["origin"])
				destination := fmt.Sprint(j["destination"])
				if origin != "<nil>" && destination != "<nil>" {
					data.FlightRoute = origin + " → " + destination
				}
			}
		}
	}

	// Booking status
	if status, ok := raw["status"].(string); ok {
		data.BookingStatus = status
	} else if status, ok := raw["bookingStatus"].(string); ok {
		data.BookingStatus = status
	}
	if data.BookingStatus == "" {
		data.BookingStatus = "Confirmed"
	}

	return data, nil
}
