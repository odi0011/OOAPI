package handlers

/*
等待室：账号全挂时**占住连接**，而不是把 502 甩给用户的 agent。

要解决的问题（用户实测截图）：

	正在重新连接 5/5
	unexpected status 502 Bad Gateway: 所有可用账号均调用失败

Codex / Claude Code 这类本地 agent 自带重试，但次数是写死的（3~5 次）——
几秒内重试完就断了会话。而「所有账号都在冷却」通常几分钟内就会自愈：
冷却到期、风控解除、管理员启用新账号。把这段时间交给 agent 去重试，
用户看到的是「会话断了」，而明明再等一会儿就好。

所以策略改成：

	1. 可自愈的失败（没有可用账号 / 账号冷却中 / 限流 / 上游 5xx / 风控标记）
	   不立即报错，而是**保持连接打开**，在协议里发一条正文是提示语的消息；
	2. 每分钟重发一次（同时兼作心跳，刷新各层空闲计时器）；
	3. 期间后台不停重试调度，一旦有账号可用就**无缝接上真实回答**；
	4. 直到 holdMaxWait（默认 50 分钟）才彻底失败；
	5. 用户随时可以关掉会话 —— 客户端断开就立刻停止，不留后台 goroutine。

为什么发「正文」而不是协议级错误事件：三个客户端（Codex / Claude Code /
其他 OpenAI SDK）对未知事件的容忍度不一样，而一条最普通的 assistant 消息
每个客户端都会如实渲染。用户看到的就是那句话本身，而且它出现在同一个
文本块里 —— 真实回答会紧跟在后面接上，不需要客户端做任何特殊处理。

代价（已知并接受）：等待期间那次请求已经发出去了（会留下计费日志），
真实回答到达时按真实用量计费。agent 那边则是「同一句话从头再问一遍」——
后者对用户更糟：会话直接断掉，上下文也丢了。
*/

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"ooapi/internal/services"
)

/*
等待室的计时参数。

不是 const 是为了让测试能压缩时间：50 分钟的等待不可能真等，
单测把 holdInterval 改成毫秒、holdMaxWait 改成几百毫秒，
跑的仍是同一份代码路径（而不是另写一个「测试专用」的分支）。
*/
var (
	// holdInterval 两次状态通知之间的间隔。
	//
	// 同时兼作心跳：必须明显小于各层空闲超时（nginx proxy_read_timeout 600s、
	// 客户端读超时通常 60~300s）。60 秒在「不刷屏」与「不被掐断」之间。
	holdInterval = time.Minute

	// holdPollStep 是等待期间检查「能不能开跑了」的间隔。
	// 比通知间隔小得多：账号一恢复就要立刻接上，不该让用户多等一分钟。
	holdPollStep = 2 * time.Second

	// holdMaxWait 是等待室的最长占用时间（用户要求「五十分钟左右」）。
	//
	// 上限与 nginx 的 proxy_read_timeout 600s 相容：那个计时器在连接上
	// 有数据流动时会重置，而我们每分钟都在发，所以 50 分钟远在安全区内。
	holdMaxWait = 50 * time.Minute

	/*
		jsonHoldMaxWait 是非流式请求的静默重试上限。

		非流式没有「发进度」的通道 —— 连接上只能最终回一个响应，
		所以不给 50 分钟：客户端自己的读超时（主流 SDK 默认 600s，
		但不少客户端设得更短）会先炸，等待就白费了。

		5 分钟覆盖了绝大多数「账号冷却几十秒到几分钟后恢复」的情况，
		又明显短于主流客户端的读超时。等待期间客户端若断开，
		context 会被取消，循环立刻退出（不会留下空转的 goroutine）。
	*/
	jsonHoldMaxWait = 5 * time.Minute
)

/*
等待期间发给用户的提示语。

**样式**：Markdown 引用块（`>`）+ 加粗 + 稳定的文字标记 `[OOAPI]`。

为什么不是纯文本：纯文本混在模型输出里，用户分不清「这是模型说的话」
还是「网关在调度」。Codex 与 Claude Code 都会渲染 Markdown，
引用块带缩进与左侧竖线，一眼可辨；即使遇到不渲染 Markdown 的裸客户端，
`>` 与 `[OOAPI]` 也足以让它看起来像系统标记而不是正文。

**不用 emoji**（用户明确要求）：⏳/✅/❌ 在不同终端里的字形与宽度不一，
而 `[OOAPI]` 是纯文字，任何环境都显示一致 —— 并且它能被稳定识别，
用于把提示语从对话历史里剥掉（见 stripHoldNotices）。

**每条都必须以空行结尾**（`\n\n`）：Markdown 的引用块靠空行结束，
少了它，紧随其后的真实回答会被吸进引用块里（lazy continuation），
变成一大段灰色引用 —— 那正是最不想看到的。
*/
const (
	// holdMarker 是提示语的稳定标识。两个用途：
	//   1. 让用户一眼看出这是网关的系统消息；
	//   2. 回传时识别并剥掉（提示语不能进入模型上下文）。
	holdMarker = "[OOAPI]"

	// holdStatusMessage 是首次发出的提示（用户指定的原文措辞）。
	holdStatusMessage = "> **" + holdMarker + " 正在紧急调度「%s」可用账号**\n>\n" +
		"> 请稍候，不要关闭会话 —— 账号恢复后会自动继续输出，无需重新发送。\n\n"

	// holdRetryMessage 是后续每分钟的重发（带已等待时长，比重复同一句更好读）。
	holdRetryMessage = "> **" + holdMarker + " 仍在紧急调度「%s」可用账号**（已等待 %s）\n>\n" +
		"> 请勿关闭会话，账号恢复后会自动继续输出。\n\n"

	// holdRecoveredMessage 是账号恢复、开始接上真实回答时的过渡说明。
	// 没有它的话，真实回答会「凭空」出现在那句「仍在调度」后面，
	// 看起来像模型在调度期间就答了。
	holdRecoveredMessage = "> **" + holdMarker + " 已调度到可用账号，继续输出**\n\n"
)

/*
彻底放弃时写进**错误事件**的说明（不再是一句正文）。

用户的要求：最终结束必须报错，而不是给一个「正常结束」的状态码 ——
否则 agent 会把提示语当成模型的最终答复、以为这一轮顺利结束，
而实际上请求从未被处理。详见 finishStreamError。
*/
const (
	holdTimeoutError = "OOAPI 调度超时：已等待 %s，仍无可用账号（模型 %s），请稍后重试。"
	holdFatalError   = "OOAPI 调度失败：%s"
)

/*
holdElapsed 把等待时长说成人话。

`time.Duration.Round(time.Second)` 给的是 `1m0s` 这种机器写法，
而提示语是给用户看的 —— 至少要说成「1 分钟」。
*/
func holdElapsed(d time.Duration) string {
	d = d.Round(time.Second)
	if d < time.Minute {
		return fmt.Sprintf("%d 秒", int(d.Seconds()))
	}
	return fmt.Sprintf("%d 分钟", int(d.Minutes()))
}

// ---------- 可恢复失败的判定 ----------

// channelFailureKind 是账号失败的性质，决定等待室要不要介入。
type channelFailureKind int

const (
	// channelFailureFatal 表示重试没有意义，直接报错：
	// 请求本身写错了（模型名不存在、参数不合法、余额不足）。
	channelFailureFatal channelFailureKind = iota
	// channelFailureRetryable 表示「此刻不行、过会儿可能行」：
	// 没有可用账号、账号全在冷却、限流、上游 5xx、网络抖动、风控标记。
	channelFailureRetryable
)

// classifyFailureForHold 判断一次失败该不该进等待室。
//
// 分界线是「等等会不会好」：
//   - 请求本身错（4xx 参数问题）→ 等一小时也一样，直接报错；
//   - 账号/上游的问题（冷却、限流、5xx、网络）→ 等就是解法。
//
// 风控（11128/11140）算可恢复：原项目实测它是**账号级、有时效的**标记，
// 冷却到期或换账号即可恢复（见 isNotApprovedResponse 的说明）。
func classifyFailureForHold(err error) channelFailureKind {
	if err == nil {
		return channelFailureFatal
	}
	// 限流包装错误不是 *upstreamError，先单独认出来。
	if errors.Is(err, errChannelRateLimited) {
		return channelFailureRetryable
	}
	// 「没有可用账号」这一条在 relayUpstream 里被换成了普通 error（携带
	// 可读文案），没有类型信息可用，只能按文案判定 —— 它只在这一处产生。
	if strings.Contains(err.Error(), "没有可用账号") {
		return channelFailureRetryable
	}

	var ue *upstreamError
	if errors.As(err, &ue) {
		// 风控标记优先于状态码（它用 400/403 返回，但含义是「换账号」）。
		if isNotApprovedResponse(ue.Message) {
			return channelFailureRetryable
		}
		// 上游 5xx / 连不上（Status 0）：等上游恢复。
		if ue.Status == 0 || ue.Status >= 500 {
			return channelFailureRetryable
		}
		// 429 限流：等窗口过去。
		if ue.Status == http.StatusTooManyRequests {
			return channelFailureRetryable
		}
		// 其余 4xx：请求本身的问题，等待无意义。
		return channelFailureFatal
	}
	// 客户端自己取消/超时不是账号问题，别占着连接。
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return channelFailureFatal
	}
	// 未分类错误（网络层等）：按可恢复处理 ——
	// 多等一会儿的代价远小于把用户的会话弄断。
	return channelFailureRetryable
}

/*
shouldHoldFor 判断这次失败该不该等。

两个条件，缺一不可：

 1. **失败性质是「等一等可能就好」**（账号在冷却 / 被禁用 / 被并发占满 /
    上游 5xx / 限流 / 风控标记）—— 见 classifyFailureForHold；
 2. **这个模型确实有账号声明支持**（不看启用状态）—— 见
    services.ModelIsDeclared。

第 2 条是必须的：模型名写错时 SelectChannels 也回「没有可用账号」，
不区分就会让用户白等 50 分钟，最后收到一句「没有可用账号」——
而真正的原因是模型名打错了，本该立刻告诉他。

第 2 条**不看启用状态**是用户要求的：账号被禁用（管理员误操作、
还没配好）是临时状态，随时能恢复，而 agent 那边一断会话就得人工补
「继续」、上下文还会错乱。用户明确说过宁可一直等也不要断。
*/
func shouldHoldFor(err error, model, groupName, callerClient string) bool {
	if classifyFailureForHold(err) != channelFailureRetryable {
		return false
	}
	return services.ModelIsDeclared(model, groupName, callerClient)
}

/*
holdSituation 给日志一句「当前是哪种没账号」的说明。

排除故障时最想知道的就是这个：账号都在冷却/被禁用（等或去后台点启用），
还是压根没有声明该模型的账号（要去配渠道）。
*/
func holdSituation(model, groupName, callerClient string) string {
	if services.ModelIsDeclared(model, groupName, callerClient) {
		return "账号不可用（冷却/禁用/占满），等待恢复"
	}
	return "没有账号声明支持该模型，等待配置"
}

// ---------- SSE 写入器 ----------

/*
sseWriter 是所有「同一条已打开的 SSE 连接上多次写入」的路径共用的写入器。

为什么必须集中：转发循环与心跳是两个 goroutine 在写同一个
gin.ResponseWriter，而它不是并发安全的 —— 同时写会让 HTTP 帧交错、
响应损坏。所有写入（含等待室的状态消息）都走这里串行化。
*/
type sseWriter struct {
	c       *gin.Context
	flusher http.Flusher
	tokens  chan struct{} // 容量 1 的互斥（用 channel 免得再引入一个依赖）
	broken  bool
}

func newSSEWriter(c *gin.Context) *sseWriter {
	w := &sseWriter{c: c, tokens: make(chan struct{}, 1)}
	w.tokens <- struct{}{}
	if flusher, okFlusher := c.Writer.(http.Flusher); okFlusher {
		w.flusher = flusher
	}
	return w
}

// Write 发一段字节给客户端。返回 false 表示客户端已断开。
func (w *sseWriter) Write(chunk []byte) bool {
	if len(chunk) == 0 {
		return true
	}
	<-w.tokens
	defer func() { w.tokens <- struct{}{} }()
	if w.broken {
		return false
	}
	if _, err := w.c.Writer.Write(chunk); err != nil {
		log.Printf("[gateway] 客户端断开连接: %v", err)
		w.broken = true
		return false
	}
	if w.flusher != nil {
		w.flusher.Flush()
	}
	return true
}

// Broken 表示连接是否已经不可写。
func (w *sseWriter) Broken() bool { return w.broken }

// WriteAll 依次写若干段。
func (w *sseWriter) WriteAll(chunks [][]byte) bool {
	for _, chunk := range chunks {
		if !w.Write(chunk) {
			return false
		}
	}
	return true
}

/*
beginStreamSession 打开一条 SSE 响应、发出协议起始事件、启动心跳。

必须在**第一次真正写入之前**调用：一旦 body 开始流动，状态码与响应头
就定死了（HTTP 没有「先发 200 再改成 502」这回事）。所以它只在
「已经有账号建连成功」或「决定进等待室」这两个时刻被调用 —— 其余情况
（请求本身写错）仍然走普通 HTTP 错误，客户端立刻能看到原因。

返回的 stop 必须被 defer 掉：心跳协程要随请求一起结束，不留后台 goroutine。
*/
func beginStreamSession(c *gin.Context, translator streamTranslator, model string) (*sseWriter, func()) {
	c.Header("Content-Type", "text/event-stream")
	c.Header("Cache-Control", "no-cache")
	c.Header("Connection", "keep-alive")
	c.Header("X-Accel-Buffering", "no") // 提示 nginx 不要缓冲
	c.Status(http.StatusOK)

	w := newSSEWriter(c)
	if translator != nil {
		w.WriteAll(translator.Start(model))
	}

	/*
		心跳：每 15 秒一个 SSE 注释行（`: xxx`）。

		思考型模型可能几十秒不出一个字，这期间连接上没有任何数据流动，
		nginx、云厂商的 LB、客户端自己的读超时都可能把这根「安静」的连接
		掐掉 —— 用户看到的就是随机重连。注释行按规范必须被客户端忽略，
		对解析零影响，但每个字节都在刷新各层的空闲计时器。
	*/
	stop := make(chan struct{})
	go func() {
		ticker := time.NewTicker(15 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-stop:
				return
			case <-ticker.C:
				if !w.Write([]byte(": keep-alive\n\n")) {
					return
				}
			}
		}
	}()
	return w, func() { close(stop) }
}

// ---------- 等待室本体 ----------

/*
holdUntilAvailable 进入等待室：占住连接、每分钟催一次、后台不停重试调度。

返回 true 表示请求已经在这条连接上被完整服务（含计费与日志）；
返回 false 表示等待失败，错误已写进流里并由这里记了失败日志 ——
调用方**不要**再调 writeErr：流已经打开，再写 HTTP 错误只会把
JSON 混进 SSE 里，客户端反而解析失败。
*/
func holdUntilAvailable(
	c *gin.Context,
	token *apiToken,
	group *services.Group,
	model string,
	body []byte,
	start time.Time,
	translator streamTranslator,
	firstErr error,
) bool {
	w, stop := beginStreamSession(c, translator, model)
	defer stop()

	callerClient := ""
	if token != nil {
		callerClient = token.CallerClient
	}

	waitLimit := holdMaxWaitForTest()
	deadline := time.Now().Add(waitLimit)
	nextNotice := time.Now()
	noticeCount := 0
	lastErr := firstErr

	for {
		if w.Broken() || c.Request.Context().Err() != nil {
			log.Printf("[hold] 客户端在等待期间断开（模型 %s，已等待 %s）",
				model, time.Since(start).Round(time.Second))
			// 客户端走了：不再写任何东西，但要如实记一笔失败日志。
			logAllChannelsFailed(c, token, model, start,
				"客户端在等待可用账号期间断开："+errText(lastErr))
			return false
		}

		now := time.Now()
		if now.After(deadline) {
			/*
				超时：用**协议的错误事件**收尾，而不是正常结束。

				用户的要求：最终必须报错，否则 agent 会把这句提示语
				当成模型的最终答复、以为这一轮顺利完成。
				各协议的具体错误事件见 streamTranslator.FinishError。
			*/
			msg := fmt.Sprintf(holdTimeoutError, holdElapsed(waitLimit), model)
			w.WriteAll(translator.FinishError(msg))
			logAllChannelsFailed(c, token, model, start,
				fmt.Sprintf("等待可用账号超时（%s）：%s", holdElapsed(waitLimit), errText(lastErr)))
			log.Printf("[hold] 等待超时，放弃（模型 %s）", model)
			return false
		}

		// 到点发通知：第一次立即发，之后每分钟一次。
		if !now.Before(nextNotice) {
			text := ""
			if noticeCount == 0 {
				text = fmt.Sprintf(holdStatusMessage, model)
			} else {
				text = fmt.Sprintf(holdRetryMessage, model, holdElapsed(time.Since(start)))
			}
			if !w.WriteAll(translator.Translate(chatTextChunk(model, text))) {
				continue
			}
			noticeCount++
			nextNotice = now.Add(holdInterval)
		}

		// 试着开跑：冷却到期的账号会在这一轮被选中。
		channels, selErr := services.SelectChannels(model, group.Name, callerClient, nil)
		if selErr != nil || len(channels) == 0 {
			lastErr = firstNonNil(selErr, lastErr)
			sleepOrCancel(c, holdPollStep)
			continue
		}

		ch := channels[0]
		if !services.RateLimitAcquire(ch) {
			// 该账号此刻被并发占满，下一轮再看（不改状态、不记失败）。
			sleepOrCancel(c, holdPollStep)
			continue
		}

		snapshot := billingSnapshotFor(c, model, body)
		opened, openErr := func() (*openedStream, error) {
			defer services.RateLimitRelease(ch)
			return openUpstreamStream(c, ch, body, model)
		}()

		if openErr == nil && opened != nil {
			log.Printf("[hold] 账号「%s」已恢复，接上模型 %s（已等待 %s）",
				ch.Name, model, holdElapsed(time.Since(start)))
			// 过渡说明：让用户看到「调度成功、正在继续」，
			// 而不是真实回答凭空出现在那句「仍在调度」后面。
			w.WriteAll(translator.Translate(chatTextChunk(model, holdRecoveredMessage)))
			return forwardOpenedStream(c, w, opened, ch, model, token, group,
				start, translator, snapshot)
		}

		if openErr != nil {
			lastErr = openErr
			services.MarkChannelFailureWithCooldown(ch.ID, openErr.Error(), upstreamErrorCooldown(openErr))
			logChannelAttemptFailure(token, ch, model, time.Since(start), openErr.Error())
			log.Printf("[hold] 账号「%s」恢复尝试失败: %v", ch.Name, openErr)

			// 请求本身写错了：再等也不会好，别继续占着连接。
			// 同样用错误事件收尾（理由见超时分支）。
			if classifyFailureForHold(openErr) == channelFailureFatal {
				w.WriteAll(translator.FinishError(fmt.Sprintf(holdFatalError, errText(openErr))))
				logAllChannelsFailed(c, token, model, start, errText(openErr))
				return false
			}
		}
		sleepOrCancel(c, holdPollStep)
	}
}

// sleepOrCancel 睡一小会儿，客户端断开时立刻醒。
func sleepOrCancel(c *gin.Context, d time.Duration) {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-c.Request.Context().Done():
	case <-timer.C:
	}
}

// ---------- 把提示语从上下文里剥掉 ----------

/*
stripHoldNotices 去掉聊天请求体里等待期间的提示语。

**为什么必须剥掉**（用户要求）：

等待期间发的那几句提示语，会被 agent 当成**助手回复**记进对话历史，
下一次请求时原样带回来。不剥掉的后果有两层：

 1. **污染上下文**：模型每次都能看到「OOAPI 正在紧急调度…」这种系统消息，
    轻则浪费 token，重则让模型以为自己在扮演某个调度系统、顺着这个话头往下写；
 2. **看着像模型自己说的话**：历史里明明没有这条回复，却出现在助手的
    发言记录里，排查问题时非常费解。

剥法是按行匹配 holdMarker（`[OOAPI]`），连同它所在的引用块一起删掉：
引用块的续行以 `>` 开头，遇到非 `>` 行或空行即结束 —— 只删我们自己的块，
不碰用户或模型的其他内容。

**保守原则**：只有确实改动了才返回新字节；没命中提示语时原样返回原切片，
这样常规请求（绝大多数）与改动前的行为**逐字节一致**，
不会因为多一层解析/重排而引入任何风险。
*/
func stripHoldNotices(body []byte) []byte {
	if len(body) == 0 || !bytes.Contains(body, []byte(holdMarker)) {
		// 快路径：绝大多数请求根本不含提示语，连解析都不做。
		return body
	}

	var payload map[string]any
	if json.Unmarshal(body, &payload) != nil {
		return body
	}
	rawMessages, okMessages := payload["messages"].([]any)
	if !okMessages || len(rawMessages) == 0 {
		return body
	}

	cleaned := make([]any, 0, len(rawMessages))
	changed := false

	for _, rawMessage := range rawMessages {
		message, okMessage := rawMessage.(map[string]any)
		if !okMessage {
			cleaned = append(cleaned, rawMessage)
			continue
		}

		content, hadContent := message["content"]
		if !hadContent {
			cleaned = append(cleaned, message)
			continue
		}

		newContent, touched := stripHoldFromContent(content)
		if !touched {
			cleaned = append(cleaned, message)
			continue
		}
		changed = true

		// 内容被删空、又没有工具调用/图片时，整条消息丢掉 ——
		// 留一条空的助手消息只会让上游困惑（有些上游直接 400）。
		if isEmptyContent(newContent) && !hasStructuredContent(message) {
			continue
		}
		message["content"] = newContent
		cleaned = append(cleaned, message)
	}

	if !changed {
		return body
	}
	/*
		丢消息后可能出现相邻的同角色消息（user, user）。

		OpenAI 兼容上游多数能容忍，但 Anthropic 协议要求严格交替
		（/messages 会直接 400）。合并相邻同角色是两边都安全的做法。
	*/
	merged := mergeAdjacentSameRole(cleaned)
	payload["messages"] = merged

	converted, err := json.Marshal(payload)
	if err != nil {
		// 编码失败时退回原文：宁可让提示语留在上下文里，
		// 也不能因为一次清理把用户的请求弄坏。
		return body
	}
	return converted
}

// stripHoldFromContent 按 content 的形状（字符串 / 分段数组）剥提示语。
// 返回是否发生了改动。
func stripHoldFromContent(content any) (any, bool) {
	switch value := content.(type) {
	case string:
		if !strings.Contains(value, holdMarker) {
			return content, false
		}
		return stripHoldLines(value), true

	case []any:
		changed := false
		parts := make([]any, 0, len(value))
		for _, rawPart := range value {
			part, okPart := rawPart.(map[string]any)
			if !okPart {
				parts = append(parts, rawPart)
				continue
			}
			text, okText := part["text"].(string)
			if !okText || !strings.Contains(text, holdMarker) {
				parts = append(parts, part)
				continue
			}
			stripped := stripHoldLines(text)
			changed = true
			if strings.TrimSpace(stripped) == "" {
				// 该分段只是提示语，整个去掉。
				continue
			}
			part["text"] = stripped
			parts = append(parts, part)
		}
		if !changed {
			return content, false
		}
		return parts, true

	default:
		return content, false
	}
}

/*
stripHoldLines 删掉文本里含标记的引用块。

我们的提示语形如：

	> **[OOAPI] 正在紧急调度「x」可用账号**
	>
	> 请稍候，不要关闭会话 —— …

所以删法是：命中标记的那一行起，连同后续所有以 `>` 开头的行
（以及紧随其后的一个空行）一并去掉。
*/
func stripHoldLines(text string) string {
	lines := strings.Split(text, "\n")
	kept := make([]string, 0, len(lines))
	dropping := false

	for _, line := range lines {
		trimmed := strings.TrimSpace(line)

		if dropping {
			// 引用块还没结束：继续吃 `>` 行与块内的空行。
			if trimmed == "" || strings.HasPrefix(trimmed, ">") {
				continue
			}
			dropping = false
		}

		if strings.Contains(line, holdMarker) {
			dropping = true
			continue
		}
		kept = append(kept, line)
	}

	return strings.TrimSpace(strings.Join(kept, "\n"))
}

// isEmptyContent 判断 content 是否已经没有实际内容。
func isEmptyContent(content any) bool {
	switch value := content.(type) {
	case nil:
		return true
	case string:
		return strings.TrimSpace(value) == ""
	case []any:
		return len(value) == 0
	default:
		return false
	}
}

// hasStructuredContent 判断消息是否携带工具调用或图片等非文本内容 ——
// 那些消息即便文本被删空也必须保留。
func hasStructuredContent(message map[string]any) bool {
	if calls, okCalls := message["tool_calls"].([]any); okCalls && len(calls) > 0 {
		return true
	}
	if id, okID := message["tool_call_id"].(string); okID && strings.TrimSpace(id) != "" {
		return true
	}
	if content, okContent := message["content"].([]any); okContent {
		for _, rawPart := range content {
			part, okPart := rawPart.(map[string]any)
			if !okPart {
				continue
			}
			kind, _ := part["type"].(string)
			if kind != "text" && kind != "" {
				return true
			}
		}
	}
	return false
}

// mergeAdjacentSameRole 合并相邻的同角色消息（内容用空行连接）。
//
// 只在删掉消息之后调用 —— 删除会让原本交替的 user/assistant 变成 user/user，
// 而 Anthropic 协议要求严格交替。文本合并是各协议都能接受的表达。
func mergeAdjacentSameRole(messages []any) []any {
	out := make([]any, 0, len(messages))
	for _, rawMessage := range messages {
		message, okMessage := rawMessage.(map[string]any)
		if !okMessage || len(out) == 0 {
			out = append(out, rawMessage)
			continue
		}
		previous, okPrevious := out[len(out)-1].(map[string]any)
		if !okPrevious {
			out = append(out, rawMessage)
			continue
		}
		prevRole, _ := previous["role"].(string)
		thisRole, _ := message["role"].(string)
		if prevRole != thisRole || prevRole == "" || prevRole == "tool" {
			out = append(out, rawMessage)
			continue
		}
		// 只在双方都是纯文本时合并；带工具调用/图片的消息保持独立。
		prevText, prevIsText := previous["content"].(string)
		thisText, thisIsText := message["content"].(string)
		if !prevIsText || !thisIsText || hasStructuredContent(previous) || hasStructuredContent(message) {
			out = append(out, rawMessage)
			continue
		}
		previous["content"] = strings.TrimSpace(prevText + "\n\n" + thisText)
	}
	return out
}

// errText 把可能为 nil 的错误转成可读文本。
func errText(err error) string {
	if err == nil {
		return "未知错误"
	}
	return err.Error()
}

// firstNonNil 返回第一个非 nil 的错误。
func firstNonNil(errs ...error) error {
	for _, err := range errs {
		if err != nil {
			return err
		}
	}
	return nil
}

/*
chatTextChunk 造一个「正文是 text」的 chat-completions SSE 帧。

为什么走 chat 帧而不是直接写协议事件：下游翻译器（chat / anthropic /
responses）本来就只吃这一种输入，让它们各自翻成自己的协议形状，
三个客户端拿到的都是自己协议里最普通的一条消息 —— 不需要谁认识新事件。
*/
func chatTextChunk(model, text string) []byte {
	if strings.TrimSpace(model) == "" {
		model = "unknown"
	}
	payload := map[string]any{
		"id":      "chatcmpl-hold-" + randomHex(8),
		"object":  "chat.completion.chunk",
		"created": time.Now().Unix(),
		"model":   model,
		"choices": []any{map[string]any{
			"index":         0,
			"delta":         map[string]any{"role": "assistant", "content": text},
			"finish_reason": nil,
		}},
	}
	/*
		用 SetEscapeHTML(false) 编码。

		默认的 json.Marshal 会把 `>` 转义成 `\u003e`（HTML 安全考虑）。
		标准 JSON 解析器会正确还原，但提示语的样式全靠 Markdown 的 `>`，
		一旦某层做的是字符串级别的处理（日志排查、简单转发、人工看流），
		`\u003e` 可读性很差、也不便于确认样式对不对。关掉它，
		流里就是干净的原字符。
	*/
	var buf bytes.Buffer
	encoder := json.NewEncoder(&buf)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(payload); err != nil {
		return nil
	}
	encoded := bytes.TrimRight(buf.Bytes(), "\n")
	// 走与其他帧同一条归一化路径（顺带保证以空行结束）。
	return ensureSSEFrame(append([]byte("data: "), encoded...))
}

/*
holdMaxWaitOverrideForTest 允许通过环境变量缩短等待上限，**仅用于测试**。

为什么需要它：超时收尾路径（错误帧、日志、状态码）只有真等到上限才会触发，
而默认是 50 分钟 —— 不可能在验收测试里等。
用一个显式的环境变量开关，而不是在代码里留「测试专用分支」：
部署时没有这个变量，行为与常量完全一致。
*/
func holdMaxWaitForTest() time.Duration {
	if raw := strings.TrimSpace(os.Getenv("OOAPI_HOLD_MAX_WAIT")); raw != "" {
		if d, err := time.ParseDuration(raw); err == nil && d > 0 {
			log.Printf("[hold] 等待上限被环境变量覆盖为 %s（仅应用于测试）", d)
			return d
		}
	}
	return holdMaxWait
}
