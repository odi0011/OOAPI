package services

import "testing"

/*
账号级模型绑定的核心语义。

绑定说的是「这个账号里的 default-model 其实是 glm-5.3」——
是**账号自己的属性**，不是全局映射。这一组测试盯死三件事：

 1. 绑定的双向解析（官方名 → 上游别名、别名 → 真实模型）；
 2. 同样的别名在另一个账号里可以是完全不同的模型（不会互相干扰）；
 3. 坏绑定（指向别名、指向不存在的模型）一律不生效。
*/
func TestModelBindingsResolveBothDirections(t *testing.T) {
	// 账号里只有上游自造的别名 —— 这正是绑定的用武之地。
	ch := &UpstreamChannel{
		Models: []string{"default-model", "fast-model"},
		ModelBindings: map[string]string{
			"default-model": "glm-5.3",
			"fast-model":    "deepseek-flash",
		},
	}

	// 别名 → 真实模型（绑定的正向：计费与身份判定用它）。
	if realID, ok := ch.BoundRealModel("default-model"); !ok || realID != "glm-5.3" {
		t.Fatalf("BoundRealModel(default-model) = %q, %v；期望 glm-5.3, true", realID, ok)
	}
	// 真实模型 → 别名（绑定的反向：把请求发对地方用它）。
	if alias, ok := ch.UpstreamAliasFor("glm-5.3"); !ok || alias != "default-model" {
		t.Fatalf("UpstreamAliasFor(glm-5.3) = %q, %v；期望 default-model, true", alias, ok)
	}

	// 客户端按官方名调用时，实际下发给上游的应当是别名。
	if got := UpstreamModelFor(ch, "glm-5.3"); got != "default-model" {
		t.Fatalf("UpstreamModelFor(glm-5.3) = %q；期望 default-model", got)
	}
	if got := UpstreamModelFor(ch, "deepseek-flash"); got != "fast-model" {
		t.Fatalf("UpstreamModelFor(deepseek-flash) = %q；期望 fast-model", got)
	}

	// 直接命中最优先：账号自己声明的名字不该被绑定改写。
	direct := &UpstreamChannel{
		Models:        []string{"glm-5.3", "default-model"},
		ModelBindings: map[string]string{"default-model": "glm-5.3"},
	}
	if got := UpstreamModelFor(direct, "glm-5.3"); got != "glm-5.3" {
		t.Fatalf("直接声明应优先于绑定，得到 %q", got)
	}
	// 绑定不会凭空扩大能力范围：账号不支持的模型仍然不支持。
	if got := UpstreamModelFor(ch, "gpt-5"); got != "" {
		t.Fatalf("无关模型不该被服务，得到 %q", got)
	}
}

func TestModelBindingsArePerChannel(t *testing.T) {
	// 同一个别名，两个账号绑到不同模型 —— 这正是全局映射做不到的事。
	channelA := &UpstreamChannel{
		Models:        []string{"default-model"},
		ModelBindings: map[string]string{"default-model": "glm-5.3"},
	}
	channelB := &UpstreamChannel{
		Models:        []string{"default-model"},
		ModelBindings: map[string]string{"default-model": "deepseek-flash"},
	}

	realA, _ := channelA.BoundRealModel("default-model")
	realB, _ := channelB.BoundRealModel("default-model")
	if realA == realB {
		t.Fatalf("两个账号的 default-model 解析成了同一个模型（%q）—— 绑定没有按账号隔离", realA)
	}
	if realA != "glm-5.3" || realB != "deepseek-flash" {
		t.Fatalf("绑定解析错误：A=%q B=%q", realA, realB)
	}

	// 各自的反向解析也必须指向自己的别名，不能串台。
	if alias, ok := channelA.UpstreamAliasFor("glm-5.3"); !ok || alias != "default-model" {
		t.Fatalf("账号 A 反向解析失败：%q %v", alias, ok)
	}
	// 账号 B 不该认领 glm-5.3（它绑的是 deepseek-flash）。
	if alias, ok := channelB.UpstreamAliasFor("glm-5.3"); ok {
		t.Fatalf("账号 B 错误地认领了 glm-5.3 → %q", alias)
	}
}

func TestModelBindingsRejectBadTargets(t *testing.T) {
	// 指向「另一个别名」的绑定等于没绑（那个目标自己也没身份）。
	broken := &UpstreamChannel{
		Models:        []string{"default-model"},
		ModelBindings: map[string]string{"default-model": "another-alias"},
	}
	if _, ok := broken.BoundRealModel("default-model"); ok {
		t.Fatal("指向非真实模型的绑定不该生效（会把 0 计费问题原样带过去）")
	}

	// 绑定了但没在 Models 里声明该别名 → 不往下发（配置不一致）。
	undeclared := &UpstreamChannel{
		Models:        []string{"glm-5.3"},
		ModelBindings: map[string]string{"default-model": "glm-5.3"},
	}
	if _, ok := undeclared.UpstreamAliasFor("glm-5.3"); ok {
		t.Fatal("别名没在 models 里声明时不该被下发（账号自己没说支持它）")
	}
}

func TestParseSerializeModelBindings(t *testing.T) {
	raw := `{"default-model":"glm-5.3","fast-model":"DeepSeek-Flash"}`
	parsed := ParseModelBindings(raw)
	if parsed["default-model"] != "glm-5.3" {
		t.Fatalf("解析错误：%#v", parsed)
	}
	// 值归一为小写（真实模型 id 都是小写，大小写不同不该当成两个模型）。
	if parsed["fast-model"] != "deepseek-flash" {
		t.Fatalf("值未归一为小写：%#v", parsed)
	}

	// 序列化要稳定（同一份配置每次输出一致，便于比对与 diff）。
	a := SerializeModelBindings(map[string]string{"b-key": "m2", "a-key": "m1"})
	b := SerializeModelBindings(map[string]string{"a-key": "m1", "b-key": "m2"})
	if a != b {
		t.Fatalf("序列化结果不稳定：\n%s\n%s", a, b)
	}
	// 空表存空串（库里 NULL/空串 = 没有绑定）。
	if got := SerializeModelBindings(nil); got != "" {
		t.Fatalf("空绑定应序列化为空串，得到 %q", got)
	}
	// 自指的绑定没有意义，解析时丢掉。
	if got := ParseModelBindings(`{"same":"same"}`); len(got) != 0 {
		t.Fatalf("自指绑定应被丢弃：%#v", got)
	}
	// 坏 JSON 不 panic，返回空表（配置坏了不该让账号不可用）。
	if got := ParseModelBindings(`{not json`); len(got) != 0 {
		t.Fatalf("坏 JSON 应返回空表：%#v", got)
	}
}

// 绑定生效后，「未绑定」判定必须放行 —— 否则用户明明绑了还会被拦。
func TestUnresolvedAliasModelsForHonoursBindings(t *testing.T) {
	models := []string{"default-model", "glm-5.3", "totally-unknown"}

	// 没有任何绑定时：前两个里的 default-model 与 unknown 都要处理。
	unbound := UnresolvedAliasModelsFor(nil, models)
	if len(unbound) != 2 {
		t.Fatalf("无绑定时应报 2 个未处理，得到 %#v", unbound)
	}

	// 把 default-model 绑到 glm-5.3（已定价）之后，它就不再是未处理项。
	withBinding := UnresolvedAliasModelsFor(map[string]string{"default-model": "glm-5.3"}, models)
	for _, name := range withBinding {
		if name == "default-model" {
			t.Fatalf("已绑定的别名仍被判为未处理：%#v", withBinding)
		}
	}
	// 而真正没身份的那个必须继续被拦下。
	found := false
	for _, name := range withBinding {
		if name == "totally-unknown" {
			found = true
		}
	}
	if !found {
		t.Fatalf("没身份的模型应当仍被拦下：%#v", withBinding)
	}
}
