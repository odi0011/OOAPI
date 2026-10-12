package netguard

import (
	"context"
	"errors"
	"net"
	"net/http"
	"testing"
)

func TestDialPublicPinsValidatedAddress(t *testing.T) {
	ClearCache()
	t.Cleanup(ClearCache)

	prevLookup := lookupIP
	prevDial := dialFn
	t.Cleanup(func() {
		lookupIP = prevLookup
		dialFn = prevDial
	})

	lookupIP = func(host string) ([]net.IP, error) {
		if host != "pin.example" {
			return nil, errors.New("unexpected host")
		}
		return []net.IP{net.ParseIP("8.8.8.8"), net.ParseIP("1.1.1.1")}, nil
	}

	var dialed []string
	dialFn = func(ctx context.Context, network, addr string) (net.Conn, error) {
		dialed = append(dialed, addr)
		return nil, errors.New("stop")
	}

	_, err := DialPublic(context.Background(), "tcp", "pin.example:443")
	if err == nil {
		t.Fatal("expected dial error")
	}
	if len(dialed) != 2 || dialed[0] != "8.8.8.8:443" || dialed[1] != "1.1.1.1:443" {
		t.Fatalf("dialed %v, want pinned public IPs", dialed)
	}
}

func TestDialPublicRejectsPrivateResolution(t *testing.T) {
	ClearCache()
	t.Cleanup(ClearCache)

	prevLookup := lookupIP
	prevDial := dialFn
	t.Cleanup(func() {
		lookupIP = prevLookup
		dialFn = prevDial
	})

	lookupIP = func(string) ([]net.IP, error) {
		return []net.IP{net.ParseIP("8.8.8.8"), net.ParseIP("169.254.169.254")}, nil
	}
	dialed := false
	dialFn = func(ctx context.Context, network, addr string) (net.Conn, error) {
		dialed = true
		return nil, errors.New("should not dial")
	}

	_, err := DialPublic(context.Background(), "tcp", "rebind.example:80")
	if err == nil || !errors.Is(err, ErrPrivateIP) {
		t.Fatalf("err = %v, want private IP", err)
	}
	if dialed {
		t.Fatal("dialed a host that also resolved to a metadata address")
	}
}

func TestCheckRedirectBlocksMetadataAndPrivateTargets(t *testing.T) {
	cases := []string{
		"http://169.254.169.254/latest/meta-data",
		"http://127.0.0.1/",
		"http://10.1.2.3/admin",
		"http://[::1]/",
	}
	for _, raw := range cases {
		req, err := http.NewRequest(http.MethodGet, raw, nil)
		if err != nil {
			t.Fatal(err)
		}
		if err := CheckRedirect(req, []*http.Request{{}}); err == nil {
			t.Fatalf("redirect to %s was allowed", raw)
		}
	}

	ok, err := http.NewRequest(http.MethodGet, "https://8.8.8.8/v1", nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := CheckRedirect(ok, nil); err != nil {
		t.Fatalf("public redirect rejected: %v", err)
	}

	tooMany := make([]*http.Request, 5)
	if err := CheckRedirect(ok, tooMany); err == nil {
		t.Fatal("redirect loop was allowed")
	}
}
