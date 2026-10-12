package handlers

import (
	"bytes"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"

	"ooapi/internal/services"
)

/*
把 Cline 装饰器挂到共享客户端上。

这里必须包住「当前」transport，不能写死 http.DefaultTransport：
初始化按文件名的字典序执行（antigravity < claude < cline < codex < grok <
kiro < workbuddy），排在 Cline 之前的装饰器已经挂上去了。写死 DefaultTransport
会把它们整条覆盖掉 —— 表现为「某些厂商的渠道配了代理/指纹后请求直连官方主机
并 401」，而代码看起来完全正常。
*/
func init() {
	upstreamClient.Transport = &clineTransport{base: orDefaultTransport(upstreamClient.Transport)}
	probeClient.Transport = &clineTransport{base: orDefaultTransport(probeClient.Transport)}
}

// orDefaultTransport 兜底：链底为空时用标准库传输。
func orDefaultTransport(rt http.RoundTripper) http.RoundTripper {
	if rt == nil {
		return http.DefaultTransport
	}
	return rt
}

type clineTransport struct{ base http.RoundTripper }

func (t *clineTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	marker := strings.TrimPrefix(req.Header.Get("Authorization"), "Bearer ")
	internal := strings.HasPrefix(marker, "ooapi-cline-channel-")
	isCline := req.URL.Scheme == "https" && req.URL.Host == "api.cline.bot" && strings.HasPrefix(req.URL.Path, "/api/v1/")
	if !isCline {
		if internal {
			return nil, errors.New("Cline 凭据不可转发到其它上游")
		}
		return t.base.RoundTrip(req)
	}
	clone := req.Clone(req.Context())
	if internal {
		id, err := strconv.ParseInt(strings.TrimPrefix(marker, "ooapi-cline-channel-"), 10, 64)
		if err != nil {
			return nil, errors.New("Cline 内部凭据标识无效")
		}
		token, err := services.ResolveClineToken(req.Context(), id)
		if err != nil {
			return nil, err
		}
		clone.Header.Set("Authorization", "Bearer "+token)
	}
	services.SetClineRequestHeaders(clone)
	resp, err := t.base.RoundTrip(clone)
	if err != nil {
		return nil, err
	}
	// SSE remains an ordinary OpenAI stream; only success-data JSON needs unwrapping.
	if resp.StatusCode >= 200 && resp.StatusCode < 300 && strings.Contains(strings.ToLower(resp.Header.Get("Content-Type")), "application/json") && strings.HasSuffix(req.URL.Path, "/chat/completions") {
		raw, readErr := io.ReadAll(io.LimitReader(resp.Body, (32<<20)+1))
		resp.Body.Close()
		if readErr != nil || len(raw) > 32<<20 {
			return nil, errors.New("Cline 响应过大或读取失败")
		}
		raw = services.UnwrapClineEnvelope(raw)
		resp.Body = io.NopCloser(bytes.NewReader(raw))
		resp.ContentLength = int64(len(raw))
		resp.Header.Del("Content-Length")
	}
	return resp, nil
}
