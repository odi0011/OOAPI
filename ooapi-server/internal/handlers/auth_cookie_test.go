package handlers

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestAuthCookieIsHttpOnlyLaxAndSecureBehindProxy(t *testing.T) {
	gin.SetMode(gin.TestMode)
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = httptest.NewRequest(http.MethodPost, "/api/auth/login", nil)
	c.Request.Header.Set("X-Forwarded-Proto", "https,http")

	setAuthCookie(c, "session-token")

	cookie := w.Header().Get("Set-Cookie")
	if !strings.Contains(cookie, "ooapi_token=session-token") {
		t.Fatalf("cookie missing token: %s", cookie)
	}
	if !strings.Contains(cookie, "HttpOnly") || !strings.Contains(cookie, "Secure") {
		t.Fatalf("cookie not HttpOnly+Secure: %s", cookie)
	}
	if !strings.Contains(strings.ToLower(cookie), "samesite=lax") {
		t.Fatalf("cookie SameSite: %s", cookie)
	}

	w = httptest.NewRecorder()
	c, _ = gin.CreateTestContext(w)
	c.Request = httptest.NewRequest(http.MethodPost, "/api/auth/login", nil)
	setAuthCookie(c, "dev-token")
	cookie = w.Header().Get("Set-Cookie")
	if strings.Contains(cookie, "Secure") {
		t.Fatalf("plain HTTP cookie was marked Secure: %s", cookie)
	}
	if !strings.Contains(strings.ToLower(cookie), "samesite=lax") || !strings.Contains(cookie, "HttpOnly") {
		t.Fatalf("dev cookie flags: %s", cookie)
	}
}
