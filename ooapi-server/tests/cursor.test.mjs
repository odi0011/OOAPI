// Cursor 适配器的行为锁
// ===========================================================================
// Cursor 是本项目里协议最特殊的上游，几个约束**错了不会报错、只会静默失效**：
//
//   ① **枚举必须用数字**：ConversationMessage.type 写 "HUMAN" 这类字符串时，
//      服务端 DiscardUnknown 会**静默丢弃**该字段 —— 表现是"请求发出去了、
//      模型没收到消息、返回空内容"，从现象完全反推不到是枚举写法的问题。
//      同理未知字段名也被静默丢弃（这也是当初「探字段」探不出 schema 的原因：
//      只有类型不匹配才报错）。
//   ② **一元方法与流式方法的 framing 相反**：流式（StreamChat）必须 Connect 帧，
//      一元（AvailableModels 等）必须**普通 JSON**（发帧反而 415）。
//      写反了就是 415，而 415 看不出是哪一侧的问题。
//   ③ **认证失败时 HTTP 仍是 200**，错误在帧里（ERROR_NOT_LOGGED_IN）。
//      不识别就会把认证问题当成"空响应"（Qoder / Trae 都踩过同一类坑）。
//   ④ **apiKey 形态不能错走 openai-compat**：Cursor 完全不是 OpenAI 协议。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const read = (p) => readFileSync(path.join(root, p), "utf8");

let pass = 0;
let fail = 0;
const t = (name, fn) => {
  try {
    fn();
    pass += 1;
    console.log(`  ok  ${name}`);
  } catch (e) {
    fail += 1;
    console.log(`  FAIL ${name} → ${e.message}`);
  }
};
const ck = (c, m) => {
  if (!c) throw new Error(m || "断言失败");
};

const cursor = await import("../src/services/upstream/cursor.js");
const { publicProviders, getMethod } = await import("../src/services/channel-types.js");
const { adapterKeyFor, isSupportedType } = await import("../src/services/router.js");
const src = read("src/services/upstream/cursor.js");

console.log("=== ① conversation 的枚举必须是数字 ===");
t("user → 1，assistant → 2，都是 number 类型", () => {
  const c = cursor.buildConversation({
    messages: [
      { role: "user", content: "你好" },
      { role: "assistant", content: "你好呀" },
      { role: "user", content: "再说一次" },
    ],
  });
  ck(c.length === 3, `应 3 条，实际 ${c.length}`);
  ck(c[0].type === 1 && typeof c[0].type === "number", "user 应为数字 1（字符串会被静默丢弃）");
  ck(c[1].type === 2 && typeof c[1].type === "number", "assistant 应为数字 2");
  ck(c.every((x) => typeof x.type === "number"), "存在非数字的 type");
});
t("每条都带 bubbleId（上游按它做气泡关联）", () => {
  const c = cursor.buildConversation({ messages: [{ role: "user", content: "x" }] });
  ck(c[0].bubbleId && typeof c[0].bubbleId === "string", "缺 bubbleId");
});
t("system 被跳过（Cursor 没有对应角色，不能塞成人类消息）", () => {
  const c = cursor.buildConversation({
    messages: [{ role: "system", content: "你是助手" }, { role: "user", content: "hi" }],
  });
  ck(c.length === 1, `system 应被跳过，实际 ${c.length} 条`);
  ck(c[0].text === "hi", "留下的应是人类消息");
});
t("content 是分片数组时只取文本片（不能变成 [object Object]）", () => {
  const c = cursor.buildConversation({
    messages: [{ role: "user", content: [{ type: "text", text: "看图" }, { type: "image_url", image_url: { url: "data:x" } }] }],
  });
  ck(c[0].text === "看图", `文本片解析错：${JSON.stringify(c[0].text)}`);
});
t("空 messages 时用 prompt 兜底（不能发出空 conversation）", () => {
  const c = cursor.buildConversation({ messages: [], prompt: "兜底" });
  ck(c.length === 1 && c[0].text === "兜底" && c[0].type === 1, "prompt 兜底失败");
  const c2 = cursor.buildConversation({ messages: [{ role: "system", content: "只有系统" }], prompt: "还是要回" });
  ck(c2.length === 1 && c2[0].text === "还是要回", "全被跳过时没有兜底");
});

console.log("\n=== ② 响应帧的增量提取 ===");
t("text → 正文；intermediateText → 推理（分开不混）", () => {
  ck(cursor.pickDeltas({ text: "正文" }).text === "正文", "正文没取到");
  ck(cursor.pickDeltas({ intermediateText: "思考" }).reasoning === "思考", "推理没取到");
  const both = cursor.pickDeltas({ text: "a", intermediateText: "b" });
  ck(both.text === "a" && both.reasoning === "b", "两个字段被混了");
});
t("空/异常输入不炸", () => {
  for (const j of [null, undefined, {}, "字符串", 42, []]) {
    const d = cursor.pickDeltas(j);
    ck(d.text === "" && d.reasoning === "", `输入 ${JSON.stringify(j)} 时返回了 ${JSON.stringify(d)}`);
  }
});

console.log("\n=== ③ 认证：两条路 + 错误分类 ===");
t("官方 API Key 换令牌：body 必须是 JSON 对象（空 body 会 400）", () => {
  ck(/body: JSON\.stringify\(\{\}\)/.test(src), "没有发 {} —— 空 body 会被上游 400 拒");
  ck(/\/auth\/exchange_user_api_key/.test(src), "没有用官方的换取端点");
});
t("换来的令牌会缓存并按需重换（不每次请求都换）", () => {
  ck(/expires_at/.test(src), "没有记过期时间（会每次请求都去换）");
  ck(/withRefreshLock/.test(src), "并发换令牌没有加锁（会同时换多次）");
  ck(/persistOtherPatch/.test(src), "换来的令牌没有落库");
});
t("401/403 → CHANNEL_AUTH_EXPIRED（凭据问题要人工处理）", () => {
  const fn = src.match(/export async function exchangeApiKey[\s\S]*?\n\}/);
  ck(fn, "未找到 exchangeApiKey");
  ck(/r\.status === 401 \|\| r\.status === 403/.test(fn[0]), "没有单独判 401/403");
  ck(/CHANNEL_AUTH_EXPIRED/.test(fn[0]), "401 没有用 AUTH_EXPIRED（会被当成可自愈反复重试）");
  ck(/CHANNEL_UPSTREAM_BUSY/.test(fn[0]), "5xx 没有归为上游过载");
});
t("缺凭据时报可操作的错误（说清填什么）", () => {
  ck(/未填写 Cursor 凭据/.test(src), "缺凭据时报错不明确");
  ck(/crsr_/.test(src), "错误里没提示 API Key 的形态");
});

console.log("\n=== ④ framing：流式与一元不能写反 ===");
t("流式用 Connect 帧（connectPost）打 StreamChat", () => {
  const fn = src.match(/export async function chat[\s\S]*?\n\}/);
  ck(fn, "未找到 chat");
  ck(/connectPost\(/.test(fn[0]), "流式没有用 Connect 传输");
  // 端点常量定义在模块顶部（STREAM_CHAT），函数里引用它 —— 两处都要对
  ck(/url: STREAM_CHAT/.test(fn[0]), "chat 没有打 STREAM_CHAT 端点");
  ck(/aiserver\.v1\.AiService\/StreamChat/.test(src), "STREAM_CHAT 常量的路径不对");
  ck(/api2\.cursor\.sh/.test(src), "主机不是 api2.cursor.sh");
});
t("一元（健康检查）用普通 JSON fetch，不是帧", () => {
  const fn = src.match(/export async function verify[\s\S]*?\n\}/);
  ck(fn, "未找到 verify");
  ck(/await fetch\(/.test(fn[0]), "一元方法没有用普通 fetch");
  ck(/"content-type": "application\/json"/.test(fn[0]), "一元方法的 content-type 不是 application/json");
  ck(!/connectPost/.test(fn[0]), "一元方法误用了 Connect 帧（会 415）");
});
t("认证失败的错误在帧里也要识别", () => {
  ck(/detectFrameError/.test(src), "没有识别帧内错误（未认证时 HTTP 是 200）");
});

console.log("\n=== ⑤ 登记与路由 ===");
t("厂商已登记且不会错走 openai-compat", () => {
  const p = publicProviders().find((x) => x.key === "cursor");
  ck(p, "cursor 厂商没登记");
  const m = p.methods.find((x) => x.key === "cursor");
  ck(m, "cursor 接入方式没登记");
  ck(m.apiKey === false, "被误判成 API Key 型（会走 openai-compat 而 400）");
  ck(m.entryUrl, "没有登录入口");
  ck(m.localLogin?.steps?.length >= 3, "没有分步指引");
});
t("适配器已注册且能解析到", () => {
  ck(isSupportedType("cursor"), "cursor 没注册进 ADAPTERS");
  ck(adapterKeyFor({ type: "cursor", other: { method: "cursor" } }) === "cursor", "adapterKeyFor 没解析到 cursor");
});
t("适配器实现完整契约", () => {
  for (const k of ["chat", "verify", "fetchUpstreamModels", "importAuth"]) {
    ck(typeof cursor[k] === "function", `缺 ${k}`);
  }
});
t("登记的是 Cursor 真实档位名", () => {
  const m = getMethod("cursor", "cursor");
  const ids = (m.defaultModels || []).map((x) => String(x.id));
  ck(ids.includes("composer-2.5"), `缺 composer-2.5：${ids.join(",")}`);
  // 不应登记厂商原名（Cursor 用的是产品内档位名，直接填 anthropic/claude-... 会被拒）
  ck(!ids.some((x) => /^anthropic\/|^openai\//.test(x)), "登记了带厂商前缀的模型名");
});

console.log("\n=== ⑥ 凭据导入的两种形态 ===");
t("crsr_ 裸串被识别为 API Key 形态", () => {
  // 不真正打网络：只看解析分支（API Key 形态会去换取，这里用 try 兜住网络错误）
  ck(/\/\^crsr_\/i\.test\(raw\)/.test(src), "没有识别 crsr_ 前缀");
});
t("JSON 形态接受 alias（api_key / apiKey / accessToken / machineId）", () => {
  ck(/obj\.api_key \|\| obj\.apiKey/.test(src), "没有接受 apiKey 别名");
  ck(/obj\.accessToken \|\| obj\.access_token/.test(src), "没有接受 accessToken 别名");
  ck(/obj\.machineId \|\| obj\.machine_id/.test(src), "没有接受 machineId 别名");
});
t("空输入与无凭据的 JSON 都报错（不产出空渠道）", () => {
  ck(/粘贴内容为空/.test(src), "空输入没报错");
  ck(/没找到 Cursor 凭据/.test(src), "无凭据的 JSON 没报错");
});

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
