package router

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"ooapi/internal/config"
	"ooapi/internal/services"
)

func TestDeviceEndpointsRequireAuthentication(t *testing.T) {
	services.SetUploadRoot(t.TempDir())
	t.Cleanup(func() { services.SetUploadRoot("") })
	r := Setup(&config.Config{JWTSecret: "router-test", WebDir: t.TempDir()})
	for _, endpoint := range []struct{ method, path string }{
		{http.MethodGet, "/api/admin/channels/devices/vendors"},
		{http.MethodPost, "/api/admin/channels/devices/start"},
		{http.MethodPost, "/api/admin/channels/devices/poll"},
		{http.MethodPost, "/api/admin/channels/devices/cancel"},
		{http.MethodPost, "/api/admin/channels/devices/claim"},
	} {
		t.Run(endpoint.path, func(t *testing.T) {
			req := httptest.NewRequest(endpoint.method, endpoint.path, strings.NewReader(`{}`))
			req.Header.Set("Content-Type", "application/json")
			recorder := httptest.NewRecorder()
			r.ServeHTTP(recorder, req)
			if recorder.Code != http.StatusUnauthorized {
				t.Fatalf("device endpoint unauthenticated response=%d %s", recorder.Code, recorder.Body.String())
			}
		})
	}
}
