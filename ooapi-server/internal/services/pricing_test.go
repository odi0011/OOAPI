package services

import "testing"

func TestCalcQuotaBillsCacheTokensOnce(t *testing.T) {
	price := ModelPrice{InputPrice: 3, OutputPrice: 15, CachedPrice: 0.3}

	// prompt 已包含 8000 个缓存命中。只按缓存价计这 8000，剩下 2000 按输入价。
	got := CalcQuota(10000, 0, 8000, price, DefaultUnitsPerOD)
	if got != 84 {
		t.Fatalf("CalcQuota = %d, want 84", got)
	}
	// 旧公式把缓存再加进输入价：10000×3 + 8000×0.3 = 324 额度单位。
	if got == 324 {
		t.Fatal("cache tokens were billed at both input and cache prices")
	}

	// Claude 口径：prompt = input + cache_read + cache_creation，cached = cache_read。
	// 100 + 20 写入按输入价，30 命中按缓存价，7 输出按输出价 → 4.74 → 5。
	claude := CalcQuota(150, 7, 30, price, DefaultUnitsPerOD)
	if claude != 5 {
		t.Fatalf("claude-shaped usage = %d, want 5", claude)
	}

	// 缓存数大于 prompt（上报把缓存放在总输入之外）时不得出现负数，缓存仍只计一次。
	outside := CalcQuota(10, 0, 40, price, 1_000_000)
	if outside != 12 {
		t.Fatalf("cache reported outside prompt = %d, want 12", outside)
	}
}

func TestPromptCostTokensSplitsInclusivePrompt(t *testing.T) {
	input, cached := PromptCostTokens(1000, 400)
	if input != 600 || cached != 400 {
		t.Fatalf("split = %d + %d", input, cached)
	}
	input, cached = PromptCostTokens(10, 40)
	if input != 0 || cached != 40 {
		t.Fatalf("overflow split = %d + %d", input, cached)
	}
	input, cached = PromptCostTokens(-5, -1)
	if input != 0 || cached != 0 {
		t.Fatalf("negative split = %d + %d", input, cached)
	}
}
