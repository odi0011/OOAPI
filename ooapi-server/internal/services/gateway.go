package services

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"ooapi/internal/db"
)

// 账号调度与上游转发。
//
// 这是网关的核心：给定一个模型名与分组，挑出一个可用的账号。
// 调度规则是「优先级降序 + 同级权重轮询 + 跳过冷却中的账号」。

// UpstreamChannel 是调度用到的账号视图。
type UpstreamChannel struct {
	ID            int64
	Name          string
	Vendor        string
	Method        string
	BaseURL       string
	APIKeys       []string
	Models        []string
	GroupName     string
	Priority      int
	Weight        int
	Status        int
	CooldownUntil *time.Time
	// Headers 是上游要求的额外请求头。
	// 值里的 {{session}} 会在每次请求时替换成一个随机会话 ID ——
	// OpenCode Go 就要求每个请求带 x-opencode-session，缺了直接拒。
	Headers []HeaderPair
	// ModelPaths 把模型映射到上游路径（如 claude-* → /messages）。
	// 同一上游按模型分走不同协议时必须有它，否则一半模型会返回
	// ModelProtocolUnsupported。
	ModelPaths []ModelPathRule
	// 账号级限流配置（0 = 不限；语义与默认值见 ratelimit.go 顶部说明）。
	Concurrency int
	MinGapMs    int
	MaxPerMin   int
	// ContextBilling 是账号级计费口径（auto / full / input_only）。
	// input_only 表示该账号按上下文长度计费、生成量不额外收费 ——
	// 结算时 completion tokens 不计费（见 handlers.settle）。
	ContextBilling string
	// Namespace 是账号的命名空间标签。只做管理侧的归类与展示，
	// 不参与调度、计费与上游请求 —— 没有可验证的上游字段可发。
	Namespace string
	// RequireCaller 是调用方白名单（已解析为规范化小写集合，空 = 不限制）。
	// 非空时只有 CallerClient 命中白名单的请求才能调度到该账号；
	// 这是纯粹的限制型访问控制，永远不会「放行」任何本来会被拒绝的请求。
	RequireCaller []string
	// ProxyURL 是该账号专用的出口代理（http/https/socks5）。空 = 直连。
	ProxyURL string
	// TLSFingerprint 是出站 TLS 握手的指纹名。空 = 标准库默认。
	// 只影响握手形状，不改 HTTP 语义，也不跳过证书校验。
	TLSFingerprint string
	// ModelBindings 是账号内的「上游模型名 → 真实模型 id」绑定。
	//
	// 键是上游自己造的名字（default-model / fast-model …），值是注册表里的
	// 真实模型 id（glm-5.3 / deepseek-flash …）。语义是「声明身份」：
	// 这个账号的 default-model 其实就是 glm-5.3。
	//
	// 键与值都已归一为小写。空 map 表示没有绑定。
	ModelBindings map[string]string
}

// ModelPathRule 是一条「模型 → 路径」规则。
type ModelPathRule struct {
	Pattern string
	Path    string
}

// ParseModelPaths 解析 model_paths 配置。
//
// 格式（每行一条，路径可省略协议前缀）：
//
//	messages: claude-*, qwen*, minimax*
//	responses: grok-*
//	chat: glm-*, kimi-*
//
// 「chat」是显式写出的默认值，便于让排在前面的规则更清晰。
func ParseModelPaths(raw string) []ModelPathRule {
	out := []ModelPathRule{}
	for _, line := range strings.Split(raw, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		kind, patterns, found := strings.Cut(line, ":")
		if !found {
			continue
		}

		path := ""
		switch strings.ToLower(strings.TrimSpace(kind)) {
		case "messages", "anthropic":
			path = "/messages"
		case "responses":
			path = "/responses"
		case "chat", "chat_completions", "openai":
			path = "/chat/completions"
		default:
			// 也允许直接写完整路径
			candidate := strings.TrimSpace(kind)
			if strings.HasPrefix(candidate, "/") {
				path = candidate
			} else {
				continue
			}
		}

		for _, pattern := range strings.Split(patterns, ",") {
			pattern = strings.TrimSpace(pattern)
			if pattern == "" {
				continue
			}
			out = append(out, ModelPathRule{Pattern: pattern, Path: path})
		}
	}
	return out
}

// HeaderPair 是一条自定义请求头。
type HeaderPair struct {
	Key   string
	Value string
}

/*
ParseModelBindings 解析账号内的「上游模型名 → 真实模型」绑定。

存储格式是 JSON 对象（键与值都已归一为小写）：

	{"default-model":"glm-5.3","fast-model":"deepseek-flash"}

用 JSON 而不是「每行一条」的文本：绑定是**成对**的数据（别名 + 真实 id），
键值对用 JSON 表达最自然，而且值里不会出现需要转义的冒号（都是模型 id）。
解析失败返回空 map —— 配置坏了不该让整个账号不可用，
调用方（保存时的校验）会另行提示。
*/
func ParseModelBindings(raw string) map[string]string {
	out := map[string]string{}
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return out
	}
	var pairs map[string]string
	if err := json.Unmarshal([]byte(trimmed), &pairs); err != nil {
		return out
	}
	for key, value := range pairs {
		name := normalizeModelKey(key)
		realID := normalizeModelKey(value)
		if name == "" || realID == "" || name == realID {
			continue
		}
		out[name] = realID
	}
	return out
}

// SerializeModelBindings 把绑定表序列化成存库用的 JSON。
//
// 空表返回空串（而不是 "{}"）：NULL / 空串在库里表示「没有绑定」，
// 与「绑定表是空对象」语义一致，但少一份无意义的存储。
// 键排序输出，保证同一份配置每次序列化结果一致（便于比对与 diff）。
func SerializeModelBindings(bindings map[string]string) string {
	if len(bindings) == 0 {
		return ""
	}
	keys := make([]string, 0, len(bindings))
	for key := range bindings {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	ordered := make(map[string]string, len(bindings))
	for _, key := range keys {
		ordered[key] = bindings[key]
	}
	encoded, err := json.Marshal(ordered)
	if err != nil {
		return ""
	}
	return string(encoded)
}

/*
BoundRealModel 返回该账号里「别名 → 真实模型」的绑定目标。

model 是上游名（别名）；命中绑定且值确实是注册表里的真实模型时返回它。
没绑定时 ok=false —— 调用方据此走原来的「按名字直接查价」逻辑。
*/
func (ch *UpstreamChannel) BoundRealModel(model string) (string, bool) {
	if ch == nil || len(ch.ModelBindings) == 0 {
		return "", false
	}
	realID, found := ch.ModelBindings[normalizeModelKey(model)]
	if !found {
		return "", false
	}
	// 只有指向真实模型的绑定才算数：指向一个同样没定价的别名等于没绑，
	// 而那种配置是坏配置（保存时会被拦），这里再兜一层。
	if _, ok := LookupRealModel(realID); !ok {
		return "", false
	}
	return realID, true
}

// UpstreamAliasFor 返回该账号里「真实模型 → 上游别名」的反向绑定。
//
// 客户端用官方名调用（glm-5.3），而账号只声明了 default-model 并把它
// 绑到了 glm-5.3 —— 这时该发出去的上游名就是 default-model。
// 同一真实模型绑了多个别名时取**字典序最小**的那个：选择必须确定，
// 否则同一请求在不同进程/不同时刻会打到不同的上游模型上。
func (ch *UpstreamChannel) UpstreamAliasFor(model string) (string, bool) {
	if ch == nil || len(ch.ModelBindings) == 0 {
		return "", false
	}
	target := CanonicalModelName(model)
	best := ""
	for alias, realID := range ch.ModelBindings {
		if CanonicalModelName(realID) != target {
			continue
		}
		if best == "" || alias < best {
			best = alias
		}
	}
	if best == "" {
		return "", false
	}
	// 别名必须真的在这个账号声明的模型清单里 —— 绑定了却没声明，
	// 说明配置不一致，不该凭绑定就往上打。
	for _, declared := range ch.Models {
		if strings.EqualFold(strings.TrimSpace(declared), best) {
			return best, true
		}
	}
	return "", false
}

// ParseChannelHeaders 把「每行一条 Key: Value」的文本解析成请求头列表。
//
// 用这种朴素格式而不是 JSON：管理员是在表单里手写它的，
// 多一层 JSON 转义只会让人写错引号。空行与 # 开头的行忽略。
func ParseChannelHeaders(raw string) []HeaderPair {
	out := []HeaderPair{}
	for _, line := range strings.Split(raw, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, found := strings.Cut(line, ":")
		key = strings.TrimSpace(key)
		value = strings.TrimSpace(value)
		if !found || key == "" {
			continue
		}
		out = append(out, HeaderPair{Key: key, Value: value})
	}
	return out
}

var (
	ErrNoChannel = errors.New("没有可用的账号")

	channelCacheMu  sync.RWMutex
	channelCache    []*UpstreamChannel
	channelCacheAt  time.Time
	channelCacheGen atomic.Uint64
)

// 账号列表缓存。
//
// 每次调用都查库会成为网关的固定开销（高并发下尤其明显），
// 而账号配置变化很少。缓存 5 秒是「省掉大部分查询」与
// 「改完配置很快生效」之间的折中。
const channelCacheTTL = 5 * time.Second

// MarkChannelsDirty 让缓存立即失效。
// 账号增删改后必须调用，否则管理员改完配置要等最多 5 秒才生效。
func MarkChannelsDirty() {
	channelCacheMu.Lock()
	channelCacheAt = time.Time{}
	channelCacheMu.Unlock()
	channelCacheGen.Add(1)
}

// selectCounter 用于同级账号之间的轮询。
// 用原子计数器而不是 DB 计数：轮询不需要精确，也不需要落库。
var selectCounter atomic.Uint64

// SelectChannels 返回按调度顺序排列的候选账号。
//
// 返回的是**列表**而不是单个账号：调用方在第一个账号失败时
// 会依次尝试下一个，因此顺序本身就是「重试链」。
//
// callerClient 是请求方标识（apiToken.CallerClient，未知时为空）。
// 它只用于「限制」：require_caller 非空的账号只有命中白名单才可调度。
func SelectChannels(model, groupName, callerClient string, exclude map[int64]struct{}) ([]*UpstreamChannel, error) {
	channels, err := loadChannels()
	if err != nil {
		return nil, err
	}

	now := time.Now()
	usable := make([]*UpstreamChannel, 0, len(channels))

	for _, ch := range channels {
		if ch.Status != 1 {
			continue
		}
		// 冷却中的账号跳过。到点后自然恢复，不需要额外的清理任务。
		if ch.CooldownUntil != nil && ch.CooldownUntil.After(now) {
			continue
		}
		if _, skip := exclude[ch.ID]; skip {
			continue
		}
		if !channelSupportsModel(ch, model) {
			continue
		}
		if !channelInGroup(ch, groupName) {
			continue
		}
		// 调用方白名单：非空且未命中时跳过该账号。
		// 白名单只会排除账号，不会让任何请求获得额外权限。
		if !channelAllowsCaller(ch, callerClient) {
			continue
		}
		usable = append(usable, ch)
	}

	if len(usable) == 0 {
		return nil, ErrNoChannel
	}

	/*
		账号级限流过滤。

		Allow 只做检查、不改状态；真正发车时由调用方 TryAcquire 原子占位。

		可用性规则（重要）：若某个账号只是「此刻」被限流，绝不能返回
		「没有可用账号」—— 账号明明存在，调用方（自己也会做限流/重试）
		应该拿到完整列表自行决定等待或跳过。因此过滤后为空但过滤前非空时，
		回退为不过滤的列表，并且只记一次日志。
	*/
	limited := make([]*UpstreamChannel, 0, len(usable))
	for _, ch := range usable {
		if Allow(ch.ID, ch.Concurrency, ch.MinGapMs, ch.MaxPerMin) {
			limited = append(limited, ch)
		}
	}
	candidates := limited
	if len(limited) == 0 {
		// 每个请求最多记一次：这段日志在「全局限流」时会每请求触发，
		// 不设防会把日志刷爆。
		log.Printf("[gateway] %d 个候选账号全部处于限流状态，回退为不过滤（由调用方自行等待或跳过）", len(usable))
		candidates = usable
	}

	// 按优先级分组，优先级高的排在前面。
	byPriority := map[int][]*UpstreamChannel{}
	for _, ch := range candidates {
		byPriority[ch.Priority] = append(byPriority[ch.Priority], ch)
	}

	priorities := make([]int, 0, len(byPriority))
	for p := range byPriority {
		priorities = append(priorities, p)
	}
	sort.Sort(sort.Reverse(sort.IntSlice(priorities)))

	out := make([]*UpstreamChannel, 0, len(candidates))
	round := selectCounter.Add(1)

	for _, p := range priorities {
		group := byPriority[p]
		out = append(out, weighRoundRobin(group, round)...)
	}

	return out, nil
}

/*
ModelIsDeclared 判断分组里是否存在**声明支持该模型**的账号。

与 SelectChannels 的两点关键区别：
  - **忽略冷却与限流**（那些等一会儿就没了，不是「没有账号」）；
  - **忽略启用状态**（disabled 是临时状态，管理员随时能恢复启用）。

用途是区分两种「没有可用账号」——它们对用户的意义完全不同：

  - 「这个模型是配置过的，只是账号此刻不可用」（全被禁用 / 全在冷却 /
    全部被并发占满）→ **等一等可能就好**：管理员点一下启用、冷却到期、
    并发腾出来，都能让请求继续。用户的 agent 重试次数写死（3~5 次），
    把这种情况甩回去只会把会话弄断（人不在电脑旁时得手工补「继续」，
    上下文还会错乱），所以应当占住连接等。
  - 「这个模型压根没有账号声明支持」（模型名写错 / 还没配置 / 分组没放行）
    → **等多久都不会好**，应当立刻如实报错，否则用户白等几十分钟
    才发现是模型名打错了。

两者在 SelectChannels 眼里完全一样（都是 ErrNoChannel），
所以必须在调度之外单独问一次。
*/
func ModelIsDeclared(model, groupName, callerClient string) bool {
	if db.DB == nil {
		return false
	}
	channels, err := loadChannels()
	if err != nil {
		return false
	}
	for _, ch := range channels {
		if !channelSupportsModel(ch, model) {
			continue
		}
		if !channelInGroup(ch, groupName) {
			continue
		}
		if !channelAllowsCaller(ch, callerClient) {
			continue
		}
		return true
	}
	return false
}

// weighRoundRobin 在同优先级内部按权重轮询。
//
// 做法：把每个账号按其权重重复放进一个虚拟环（权重 3 的账号占 3 个位置），
// 用轮次对环长度取模选起点，然后依次取出并去重。
// 权重 3:1 的两个账号就近似 3:1 的分流比例。
func weighRoundRobin(group []*UpstreamChannel, round uint64) []*UpstreamChannel {
	if len(group) == 1 {
		return group
	}

	type slot struct {
		ch *UpstreamChannel
	}
	ring := make([]slot, 0, len(group)*4)
	for _, ch := range group {
		w := ch.Weight
		if w <= 0 {
			w = 1
		}
		// 单个账号的权重上限，防止某个权重写成 10000 时把环撑爆。
		if w > 100 {
			w = 100
		}
		for i := 0; i < w; i++ {
			ring = append(ring, slot{ch: ch})
		}
	}
	if len(ring) == 0 {
		return group
	}

	start := int(round % uint64(len(ring)))
	out := make([]*UpstreamChannel, 0, len(group))
	seen := map[int64]struct{}{}

	for i := 0; i < len(ring); i++ {
		ch := ring[(start+i)%len(ring)].ch
		if _, dup := seen[ch.ID]; dup {
			continue
		}
		seen[ch.ID] = struct{}{}
		out = append(out, ch)
	}

	// 防御：环里若有账号未被取到（理论上不会），补齐以免漏掉候选。
	for _, ch := range group {
		if _, ok := seen[ch.ID]; !ok {
			out = append(out, ch)
		}
	}
	return out
}

// channelSupportsModel 判断账号是否声明支持该模型。
func channelSupportsModel(ch *UpstreamChannel, model string) bool {
	return UpstreamModelFor(ch, model) != ""
}

/*
UpstreamModelFor 决定这个账号该用哪个模型名向上游发起请求。

为什么需要它：客户端按**官方模型名**调用（deepseek-flash，DeepSeek 文档里的 id），
而上游只认它自己的叫法（WorkBuddy / OpenCode 都只认 deepseek-v4.1-flash）。
名称的对应关系有两个来源：

	· 真实模型注册表里的等价写法（同一个官方模型的不同拼法，全局通用）；
	· 该账号自己的绑定（default-model 之类上游自造的名字，**仅本账号**成立）。

返回空串表示该账号无法服务这个模型。规则：

	· 账号直接声明支持请求名 → 原样下发（绝大多数情况走这条）；
	· 账号里有「绑定到请求名」的别名 → 用那个别名下发（账号级绑定）；
	· 否则在账号声明的名字里找「与请求名归一到同一个官方模型」的那个 → 用它下发；
	· 都不行 → 不支持。

账号的 models 列表里应当写**上游认的名字**（deepseek-v4.1-flash），
不要写官方名 —— 下发给上游的必须是上游认识的那个字符串；
官方名由客户端使用，两边的对应关系靠注册表与账号绑定对上。

账号未填模型列表时视为支持全部（原样下发）—— 否则新建账号若忘记填模型
就永远选不中，而报错信息只会是「没有可用账号」，很难排查。
*/
func UpstreamModelFor(ch *UpstreamChannel, model string) string {
	if ch == nil {
		return ""
	}
	requested := strings.ToLower(strings.TrimSpace(model))
	if requested == "" {
		return ""
	}
	if len(ch.Models) == 0 {
		return model
	}
	// 直接命中（含通配）优先：账号自己声明的写法最可信。
	for _, m := range ch.Models {
		pattern := strings.ToLower(strings.TrimSpace(m))
		if pattern == "" {
			continue
		}
		if strings.HasSuffix(pattern, "*") {
			if strings.HasPrefix(requested, strings.TrimSuffix(pattern, "*")) {
				return model
			}
			continue
		}
		if requested == pattern {
			return model
		}
	}
	/*
		账号级绑定：账号里有个别名被绑到了请求的这个模型。

		这条要排在「注册表等价写法」之前 —— 绑定是管理员对该账号的
		明确声明，比全局的拼写等价关系更贴近事实。
		（例如某账号的 default-model 被绑到 glm-5.3 时，客户端请求
		glm-5.3 就该走 default-model，而不是去猜别的拼法。）
	*/
	if alias, okAlias := ch.UpstreamAliasFor(requested); okAlias {
		return alias
	}
	/*
		反向别名：账号支持的写法里，有没有归一到同一个官方模型的。

		同一官方模型可能对应多个上游写法（deepseek-v4.1-flash 与
		它的 -sg 变体都会归一到 deepseek-flash）。选择规则按优先级：
		  ① 账号声明的名字与**官方名完全一致** → 直接用它（最无歧义）；
		  ② 两个候选里，一个是另一个的前缀 → 用短的那个
		     （变体名总是在本体后追加后缀，如 -sg / -preview / -highspeed）；
		  ③ 否则按账号声明的顺序取第一个（确定性的，且尊重管理员的声明顺序）。

		不用「无条件取最短」：那会在 deepseek-v4.1-flash 与 legacy 的
		deepseek-v4-flash 之间选中后者（下架的老 id）。
	*/
	canonical := CanonicalModelName(requested)
	candidates := []string{}
	for _, m := range ch.Models {
		name := strings.TrimSpace(m)
		if name == "" || strings.HasSuffix(name, "*") {
			continue
		}
		if CanonicalModelName(name) != canonical {
			continue
		}
		// ① 完全等于官方名，最优先。
		if strings.EqualFold(name, canonical) {
			return name
		}
		candidates = append(candidates, name)
	}
	if len(candidates) == 0 {
		return ""
	}
	// ② 前缀关系：短的优先（本体 vs 带区域/版本后缀的变体）。
	shortest := candidates[0]
	for _, name := range candidates[1:] {
		if len(name) < len(shortest) {
			shortest = name
		}
	}
	for _, name := range candidates {
		if name != shortest && strings.HasPrefix(strings.ToLower(name), strings.ToLower(shortest)) {
			return shortest
		}
	}
	// ③ 无前缀关系：按声明顺序取第一个。
	return candidates[0]
}

/*
CanonicalModelName 把模型名归一到官方 id。

「同一个模型的不同拼写」这件事由**真实模型注册表**回答：
deepseek-flash 的 Aliases 里列了 deepseek-v4.1-flash / deepseek-v4-flash，
所以这三个写法都归一到 deepseek-flash。

早先这里查的是全局 model_map（上游名 → 官方名）。那条路已经废弃：
同一句 default-model 在不同上游是完全不同的模型，全局映射会把它们
混成一回事 —— 现在改成**账号级绑定**（见 UpstreamChannel.ModelBindings），
账号内的对应关系在 UpstreamModelFor / BoundRealModel 里处理。

注册表里没有的名字原样小写返回：不猜、不做模糊匹配 ——
猜错的后果是把一个上游自造的别名当成真实模型放行。
*/
func CanonicalModelName(name string) string {
	key := normalizeModelKey(name)
	if model, found := LookupRealModel(key); found {
		return normalizeModelKey(model.ID)
	}
	return key
}

// channelInGroup 判断账号是否属于该分组。
//
// 账号的 group_name 为空表示「所有分组都可用」。
func channelInGroup(ch *UpstreamChannel, groupName string) bool {
	if strings.TrimSpace(ch.GroupName) == "" {
		return true
	}
	return strings.EqualFold(strings.TrimSpace(ch.GroupName), strings.TrimSpace(groupName))
}

// channelAllowsCaller 判断请求方是否被允许使用该账号。
//
// 规则：require_caller 为空 = 不限制（默认，行为与从前一致）；
// 非空时请求方的 CallerClient 必须命中列表中的某一项。
// CallerClient 由 User-Agent 推导、可被伪造，因此这里只做「限制」——
// 未识别的调用方（空）永远不满足非空白名单，不会因伪造而额外获得账号。
func channelAllowsCaller(ch *UpstreamChannel, callerClient string) bool {
	if len(ch.RequireCaller) == 0 {
		return true
	}
	caller := strings.ToLower(strings.TrimSpace(callerClient))
	if caller == "" {
		return false
	}
	for _, allow := range ch.RequireCaller {
		if allow == caller {
			return true
		}
	}
	return false
}

// 调用方白名单的解析上限。存在上限是为了让「管理员一次性粘贴一大段」
// 不会把调度热路径变成一次长遍历。
const (
	maxRequireCallerEntries = 20
	maxRequireCallerChars   = 32
)

// ParseRequireCaller 把逗号分隔的调用方白名单解析为规范化的小写列表。
//
// 大小写不敏感、去掉空白；超过 20 项或单项超过 32 字符的条目直接丢弃
// （校验入口已经拒绝，这里是防止历史脏数据把异常值带进调度）。
// 长度按字符（rune）计，与管理端校验口径一致 —— 按字节计会让
// 11 个以上汉字的条目「入库通过、调度被丢」，两边规则必须相同。
//
// 返回 nil 表示「不限制」，且仅在原始值为空时出现；
// 原始值非空却解析不出任何合法条目时返回一个永不命中的哨兵，
// 即按「限制、无人命中」处理。访问控制只允许朝「限制」方向生效：
// 一个写错的白名单静默放开账号，比账号不可用危险得多。
func ParseRequireCaller(raw string) []string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	out := []string{}
	for _, part := range strings.Split(raw, ",") {
		item := strings.ToLower(strings.TrimSpace(part))
		if item == "" {
			continue
		}
		if len([]rune(item)) > maxRequireCallerChars {
			continue
		}
		out = append(out, item)
		if len(out) >= maxRequireCallerEntries {
			break
		}
	}
	if len(out) == 0 {
		// "\x00" 不可能是任何真实 caller id（取值来自固定的 ASCII 识别表），
		// 因此该账号对一切调用方都不可调度 —— 安全方向的失败。
		return []string{"\x00"}
	}
	return out
}

func loadChannels() ([]*UpstreamChannel, error) {
	channelCacheMu.RLock()
	if channelCache != nil && time.Since(channelCacheAt) < channelCacheTTL {
		cached := channelCache
		channelCacheMu.RUnlock()
		return cached, nil
	}
	channelCacheMu.RUnlock()

	/*
		列清单与 Scan 的目标顺序必须严格一一对应。

		这里踩过坑：调度用的 SELECT 漏加新列不会报编译错误，
		只会让某个字段静默保持零值（比如限流配置永远是 0 = 不限），
		排查时「配置明明写了却不生效」极难定位。
	*/
	rows, err := db.DB.Query(
		`SELECT id, name, vendor, base_url, api_key, models, group_name,
		        priority, weight, status, cooldown_until, COALESCE(headers, ''),
		        COALESCE(model_paths, ''), method,
		        concurrency, min_gap_ms, max_per_min, context_billing,
		        COALESCE(namespace, ''), COALESCE(require_caller, ''),
		        COALESCE(proxy_url, ''), COALESCE(tls_fingerprint, ''),
		        COALESCE(model_bindings, '')
		 FROM channels`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []*UpstreamChannel{}
	for rows.Next() {
		var (
			ch            UpstreamChannel
			apiKey        sql.NullString
			modelsRaw     sql.NullString
			cooldown      sql.NullTime
			headersRaw    string
			pathsRaw      string
			requireCaller string
			bindingsRaw   string
		)
		if err := rows.Scan(&ch.ID, &ch.Name, &ch.Vendor, &ch.BaseURL, &apiKey,
			&modelsRaw, &ch.GroupName, &ch.Priority, &ch.Weight, &ch.Status, &cooldown,
			&headersRaw, &pathsRaw, &ch.Method,
			&ch.Concurrency, &ch.MinGapMs, &ch.MaxPerMin, &ch.ContextBilling,
			&ch.Namespace, &requireCaller, &ch.ProxyURL, &ch.TLSFingerprint,
			&bindingsRaw); err != nil {
			log.Printf("[gateway] 扫描账号失败: %v", err)
			continue
		}
		ch.Headers = ParseChannelHeaders(headersRaw)
		ch.ModelPaths = ParseModelPaths(pathsRaw)
		ch.RequireCaller = ParseRequireCaller(requireCaller)
		ch.ModelBindings = ParseModelBindings(bindingsRaw)

		// 上游密钥支持多把（换行分隔），调度时取第一把。
		// 多把轮询留待网关需要抗单 key 限流时再实现。
		if apiKey.Valid {
			for _, k := range strings.Split(apiKey.String, "\n") {
				if v := strings.TrimSpace(k); v != "" {
					ch.APIKeys = append(ch.APIKeys, v)
				}
			}
		}
		switch ch.Method {
		case "cli":
			if ch.Vendor != "cline" || ch.BaseURL != ClineAPIBase {
				continue
			}
			// Internal marker is resolved by the Cline transport before any network request.
			ch.APIKeys = []string{fmt.Sprintf("ooapi-cline-channel-%d", ch.ID)}
			ch.ModelPaths = nil
		case "kiro", "workbuddy", "grok":
			// 一键绑定的设备授权渠道：api_key 存内部标识，真实凭据加密存在
			// auth_credential，由对应传输层在发请求前换出；固定上游协议，
			// 不接受自定义协议路径。
			if ch.Vendor != ch.Method {
				continue
			}
			ch.APIKeys = []string{fmt.Sprintf("ooapi-%s-channel-%d", ch.Method, ch.ID)}
			ch.ModelPaths = nil
		case LoginVendorCodex, LoginVendorClaudeOAuth, LoginVendorAntigravity:
			/*
				订阅账号（交互式 OAuth 登录）：与设备授权同一套存储 ——
				api_key 存内部标识，真实凭据加密在 auth_credential。

				协议路径在这里固定下来，不允许管理员自定义：
				这三家的上游都不是「base_url + /chat/completions」的形状，
				路径写错会打到不存在的端点上。
			*/
			if ch.Vendor != UpstreamVendorForLoginMethod(ch.Method) || ch.BaseURL != loginChannelBase(ch.Method) {
				continue
			}
			ch.APIKeys = []string{fmt.Sprintf("ooapi-%s-channel-%d", ch.Method, ch.ID)}
			switch ch.Method {
			case LoginVendorCodex:
				ch.ModelPaths = []ModelPathRule{{Pattern: "*", Path: "/responses"}}
			case LoginVendorClaudeOAuth:
				ch.ModelPaths = []ModelPathRule{{Pattern: "*", Path: "/messages"}}
			case LoginVendorAntigravity:
				// Antigravity 只有一个私有端点，走 chat 的主路径。
				ch.ModelPaths = []ModelPathRule{{Pattern: "*", Path: "/chat/completions"}}
			}
		case "api":
			// 普通 API Key 渠道：api_key 即真实密钥。
		default:
			continue
		}
		ch.Models = splitModels(modelsRaw.String)
		if cooldown.Valid {
			t := cooldown.Time
			ch.CooldownUntil = &t
		}
		out = append(out, &ch)
	}

	channelCacheMu.Lock()
	channelCache = out
	channelCacheAt = time.Now()
	channelCacheMu.Unlock()

	return out, nil
}

// loginChannelBase 返回订阅登录渠道固定的上游地址。
//
// 地址与登录时使用的官方客户端一致，写死在服务端：
// 管理员改不了（改了也只会把凭据送到错误的主机上，必然失败）。
// 传输层还会再校验一次主机名，这里是第一道闸。
func loginChannelBase(method string) string {
	switch method {
	case LoginVendorCodex:
		return "https://chatgpt.com/backend-api/codex"
	case LoginVendorClaudeOAuth:
		return "https://api.anthropic.com/v1"
	case LoginVendorAntigravity:
		return "https://daily-cloudcode-pa.googleapis.com/v1internal"
	}
	return ""
}

// LoginChannelBase 供管理端在创建/校验订阅渠道时复用同一份地址表。
func LoginChannelBase(method string) string { return loginChannelBase(method) }

func splitModels(raw string) []string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	out := []string{}
	for _, p := range strings.Split(raw, ",") {
		if v := strings.TrimSpace(p); v != "" {
			out = append(out, v)
		}
	}
	return out
}

// MarkChannelFailure 记录一次调用失败。
//
// 处理策略与连通性测试一致：
//   - 网络层错误（连不上/超时）只累加失败计数，**不**禁用账号 —— 抖动不该停掉好账号
//   - 上游明确返回错误状态码时进入冷却，错误反复出现才由管理员处理
//
// 这里刻意不直接改 status：自动禁用应当是「多次失败后的判断」，
// 单次调用失败就禁用会让网关在偶发抖动时迅速失去所有账号。
func MarkChannelFailure(channelID int64, errMsg string) {
	MarkChannelFailureWithCooldown(channelID, errMsg, true)
}

// MarkChannelFailureWithCooldown 记录一次账号失败。
//
// cooldown 为 false 时只留错误信息、不进冷却。
// 用于「上游拒绝了这次请求」这类与账号健康无关的失败 ——
// 典型是 400（模型不支持、参数不对）。把这类错误也算作账号故障，
// 会让一个正常账号因为一次错误的请求就被踢出调度 60 秒，
// 用户看到的是「没有可用账号」，而账号其实好好的。
func MarkChannelFailureWithCooldown(channelID int64, errMsg string, cooldown bool) {
	if cooldown {
		/*
			付费问题要冷却更久。

			60 秒后钱不会自己到账，而按 60 秒冷却会让网关每分钟都去
			撞一次必然失败的请求 —— 每个用户请求都要白等一轮上游往返。
			给 10 分钟，管理员看到告警去处理的时间通常是够的；
			真的处理完了，重启或改一次账号配置即可立即恢复。
		*/
		wait := 60 * time.Second
		if strings.Contains(errMsg, "余额不足") || strings.Contains(errMsg, "Insufficient") {
			wait = 10 * time.Minute
		}
		/*
			风控标记要冷却得久。

			账号被上游标记为「未批准渠道」时，60 秒后再撞一次毫无意义 ——
			原项目实测这种标记持续数小时（其策略是 6 小时冷却）。
			本站取 30 分钟：既不会一直空转，也不至于像 6 小时那样
			在风控已经解除后还让账号闲着。
		*/
		lower := strings.ToLower(errMsg)
		for _, hint := range []string{"11128", "11140", "unapproved channel", "illegal api invocation", "request illegal"} {
			if strings.Contains(lower, hint) {
				wait = 30 * time.Minute
				break
			}
		}
		until := time.Now().Add(wait)
		if _, err := db.DB.Exec(
			`UPDATE channels SET last_error = ?, cooldown_until = ? WHERE id = ?`,
			truncateStr(errMsg, 480), until, channelID,
		); err != nil {
			log.Printf("[gateway] 记录账号失败失败: %v", err)
		}
	} else {
		if _, err := db.DB.Exec(
			`UPDATE channels SET last_error = ? WHERE id = ?`,
			truncateStr(errMsg, 480), channelID,
		); err != nil {
			log.Printf("[gateway] 记录账号失败失败: %v", err)
		}
	}
	MarkChannelsDirty()
}

// MarkChannelSuccess 记录一次成功调用。
// 清掉冷却与错误信息，并把累计调用数加一。
func MarkChannelSuccess(channelID int64) {
	if _, err := db.DB.Exec(
		`UPDATE channels
		 SET used_count = used_count + 1, last_error = '', cooldown_until = NULL
		 WHERE id = ?`, channelID,
	); err != nil {
		log.Printf("[gateway] 记录账号成功失败: %v", err)
	}
}

func truncateStr(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

/*
AvailableModelsForGroup 返回某个分组「真正能调用」的模型集合。

口径与调度侧完全一致（这是关键）：
**分组下属渠道声明的模型 ∩ 分组白名单**。

为什么必须和调度一致：`/v1/models` 是客户端（以及用户）判断「我能在你这儿用什么」
的唯一依据。如果它比实际可调的多，用户按列表选模型 → 必然 403/503
（原项目文档里记着这个病：「列表说能调、调用说不能」）；反过来少了则让人以为
某个模型不能用。两边共用这一份计算，就不会各说各话。

分组下没有任何启用渠道时返回**空集**（而不是「不限」）——
一个什么都调不了的分组，模型列表也该是空的。
*/
func AvailableModelsForGroup(groupName string) ([]string, error) {
	// 数据库未初始化（单元测试、启动早期）时给空集而不是 panic：
	// 这是查询接口，崩溃会把一次可恢复的「查不到」变成进程级故障。
	if db.DB == nil {
		return []string{}, nil
	}
	channels, err := loadChannels()
	if err != nil {
		return nil, err
	}
	group, err := GroupByName(groupName)
	if err != nil {
		// 分组不存在：按「没有可用模型」处理，而不是回退成不限 ——
		// 后者会把整份目录泄漏给一个失效的密钥。
		return []string{}, nil
	}

	seen := map[string]struct{}{}
	out := []string{}
	for _, ch := range channels {
		if ch.Status != 1 {
			continue
		}
		if !channelInGroup(ch, groupName) {
			continue
		}
		// 账号未声明模型 = 该账号支持全部（与 channelSupportsModel 同口径）。
		declared := ch.Models
		if len(declared) == 0 {
			declared = []string{"*"}
		}
		for _, model := range declared {
			pattern := strings.TrimSpace(model)
			if pattern == "" {
				continue
			}
			// 通配声明（"*" 或 "gpt-*"）不能直接作为模型名返回，
			// 用定价表里的名字去展开 —— 定价表是「对外可售模型」的清单。
			if strings.HasSuffix(pattern, "*") {
				prefix := strings.ToLower(strings.TrimSuffix(pattern, "*"))
				priced, priceErr := ListPricedModels()
				if priceErr != nil {
					continue
				}
				for _, name := range priced {
					if strings.HasPrefix(strings.ToLower(name), prefix) && group.ModelAllowed(name) {
						if _, dup := seen[name]; !dup {
							seen[name] = struct{}{}
							out = append(out, name)
						}
					}
				}
				continue
			}
			// 非通配：要用**官方名**对外暴露（客户端按官方名调用），
			// 账号里存的可能是上游叫法（deepseek-v4.1-flash），
			// 也可能是绑定了真实模型的别名（default-model → glm-5.3）。
			public := CanonicalModelName(pattern)
			if bound, okBind := ch.BoundRealModel(pattern); okBind {
				public = CanonicalModelName(bound)
			}
			if !group.ModelAllowed(public) {
				continue
			}
			// 没定价的模型不列：调用时也查不到价（按 0 计费），
			// 列出来只会让人以为可用。
			if !HasPrice(public) {
				continue
			}
			if _, dup := seen[public]; dup {
				continue
			}
			seen[public] = struct{}{}
			out = append(out, public)
		}
	}
	sort.Strings(out)
	return out, nil
}

/*
IsFixedProtocolChannel 判断渠道的上游协议是否由系统固定。

设备授权（cli / kiro / workbuddy / grok）与订阅登录（codex / claude-oauth /
antigravity）的传输层是**专门为那一家写的**，只认一条路径：
WorkBuddy 只处理 `/chat/completions`，Claude 订阅只处理 `/messages`。
对这类渠道做「端点自动协商」没有意义 —— 换路径必然被传输层以
「不支持的请求路径」拒掉，而且那条拒绝会**掩盖真正的上游错误**
（实测：WorkBuddy 的真实失败原因被 /responses 的路径拒绝顶掉了，
管理员看到的是「请求路径不支持」，与实际情况完全无关）。

它们与聚合型上游的区别：聚合型上游（OpenCode 这类）在同一 base_url 下
按模型分走三种协议，管理员配错或漏配很常见，那才是端点协商的适用场景。
*/
func IsFixedProtocolChannel(ch *UpstreamChannel) bool {
	if ch == nil {
		return false
	}
	switch ch.Method {
	case "cli", "kiro", "workbuddy", "grok",
		LoginVendorCodex, LoginVendorClaudeOAuth, LoginVendorAntigravity:
		return true
	}
	return false
}
