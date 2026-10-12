package router

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"

	"ooapi/internal/config"
)

func TestCORSAllowlistRejectsUnlistedOriginWithCredentials(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(corsMiddleware(&config.Config{
		CORSOrigins:        []string{"https://app.example.com"},
		CORSAllowLocalhost: false,
	}))
	r.GET("/api/health", func(c *gin.Context) { c.Status(http.StatusOK) })

	evil := httptest.NewRequest(http.MethodGet, "/api/health", nil)
	evil.Header.Set("Origin", "https://evil.example")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, evil)
	if rec.Header().Get("Access-Control-Allow-Origin") != "" || rec.Header().Get("Access-Control-Allow-Credentials") != "" {
		t.Fatalf("unlisted origin reflected: %v", rec.Header())
	}

	ok := httptest.NewRequest(http.MethodOptions, "/api/health", nil)
	ok.Header.Set("Origin", "https://app.example.com")
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, ok)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("preflight status %d", rec.Code)
	}
	if rec.Header().Get("Access-Control-Allow-Origin") != "https://app.example.com" ||
		rec.Header().Get("Access-Control-Allow-Credentials") != "true" {
		t.Fatalf("allowlisted origin missing credentials headers: %v", rec.Header())
	}
}

func TestCORSLocalhostAllowedOnlyForDevDefault(t *testing.T) {
	gin.SetMode(gin.TestMode)

	dev := gin.New()
	dev.Use(corsMiddleware(&config.Config{CORSAllowLocalhost: true}))
	dev.GET("/api/health", func(c *gin.Context) { c.Status(http.StatusOK) })

	req := httptest.NewRequest(http.MethodGet, "/api/health", nil)
	req.Header.Set("Origin", "http://localhost:5173")
	rec := httptest.NewRecorder()
	dev.ServeHTTP(rec, req)
	if rec.Header().Get("Access-Control-Allow-Origin") != "http://localhost:5173" ||
		rec.Header().Get("Access-Control-Allow-Credentials") != "true" {
		t.Fatalf("localhost dev origin rejected: %v", rec.Header())
	}

	prod := gin.New()
	prod.Use(corsMiddleware(&config.Config{
		CORSOrigins:        []string{"https://app.example.com"},
		CORSAllowLocalhost: false,
	}))
	prod.GET("/api/health", func(c *gin.Context) { c.Status(http.StatusOK) })
	req = httptest.NewRequest(http.MethodGet, "/api/health", nil)
	req.Header.Set("Origin", "http://127.0.0.1:3000")
	rec = httptest.NewRecorder()
	prod.ServeHTTP(rec, req)
	if rec.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Fatalf("localhost allowed in strict production mode: %v", rec.Header())
	}
}
