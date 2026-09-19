// 告警通知：SMTP 邮件 + Webhook（飞书/钉钉/Slack/企业微信/自定义）
// ---------------------------------------------------------------------------
// 为什么自己写 SMTP 而不是引 nodemailer：本项目禁止新增依赖。
// Node 内置 net/tls 足够完成「EHLO → STARTTLS → AUTH LOGIN → MAIL FROM → RCPT → DATA」，
// 这一套协议三十年没变过，实现成本远低于引入一个依赖树庞大的库。
//
// 相比 sub2api（只有邮件），这里多做了 Webhook —— 飞书/钉钉/企微的群机器人
// 是运维实际在用的通道，邮件经常没人看。
import net from "node:net";
import tls from "node:tls";
import { getOption, getBoolOption, getNumberOption } from "../config.js";

// ---------------------------------------------------------------------------
// SMTP
// ---------------------------------------------------------------------------

/** 极简 SMTP 会话：按行收发，读多行响应（SMTP 用 `250-` 续行、`250 ` 结尾） */
class SmtpSession {
  constructor(socket) {
    this.socket = socket;
    this.buf = "";
    this.waiters = [];
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      this.buf += chunk;
      this.drain();
    });
    socket.on("error", (e) => this.failAll(e));
    socket.on("close", () => this.failAll(new Error("连接已被服务器关闭")));
  }

  drain() {
    // 一行完整响应 = 以 `\d{3} ` 开头的那一行结束
    for (;;) {
      const lines = this.buf.split("\r\n");
      if (lines.length < 2) return;
      const done = lines.findIndex((l) => /^\d{3} /.test(l));
      if (done === -1) return;
      const resp = lines.slice(0, done + 1).join("\n");
      this.buf = lines.slice(done + 1).join("\r\n");
      const w = this.waiters.shift();
      if (w) w.resolve(resp);
    }
  }

  failAll(err) {
    while (this.waiters.length) this.waiters.shift().reject(err);
  }

  /** 读一次响应 */
  read(timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.waiters.findIndex((w) => w.resolve === resolve);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error("SMTP 响应超时"));
      }, timeoutMs);
      this.waiters.push({
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.drain();
    });
  }

  write(line) {
    this.socket.write(line + "\r\n");
  }

  /** 发一条命令并校验返回码前缀 */
  async cmd(line, expect, timeoutMs) {
    if (line !== null) this.write(line);
    const resp = await this.read(timeoutMs);
    const code = resp.slice(0, 3);
    if (expect && !expect.includes(code)) {
      // 认证失败的响应里可能带服务器信息，但对排障不够，补上期望码
      throw new Error(`SMTP 期望 ${expect} 收到 ${code}：${resp.split("\n").pop()}`);
    }
    return resp;
  }

  end() {
    try {
      this.write("QUIT");
      this.socket.end();
    } catch {
      /* 已经断了 */
    }
  }
}

function connect({ host, port, secure, timeoutMs = 15000 }) {
  return new Promise((resolve, reject) => {
    const socket = secure
      ? tls.connect({ host, port, servername: host, rejectUnauthorized: false })
      : net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`连接 SMTP 服务器超时（${host}:${port}）`));
    }, timeoutMs);
    const ok = () => {
      clearTimeout(timer);
      resolve(socket);
    };
    socket.once(secure ? "secureConnect" : "connect", ok);
    socket.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

function upgradeTls(socket, host) {
  return new Promise((resolve, reject) => {
    const t = tls.connect({ socket, servername: host, rejectUnauthorized: false }, () => resolve(t));
    t.once("error", reject);
  });
}

const b64 = (s) => Buffer.from(String(s), "utf8").toString("base64");

/** 读取 SMTP 配置（全部来自系统设置） */
export function smtpConfig() {
  return {
    host: String(getOption("smtp_host") || "").trim(),
    port: getNumberOption("smtp_port") || 465,
    user: String(getOption("smtp_user") || "").trim(),
    pass: String(getOption("smtp_pass") || ""),
    from: String(getOption("smtp_from") || "").trim() || String(getOption("smtp_user") || "").trim(),
    fromName: String(getOption("smtp_from_name") || "").trim() || String(getOption("site_name") || "OOAPI"),
    secure: getBoolOption("smtp_ssl"),
    enabled: getBoolOption("smtp_enabled"),
  };
}

/**
 * 发一封邮件。返回 { ok, ms } 或抛错。
 * 说明：`secure=false` 时走 STARTTLS（若服务器支持），这一点对 587 端口的
 * QQ/163/企业邮是必须的 —— 明文投递账号密码会被拒。
 */
export async function sendMail({ to, subject, text, html = "" }) {
  const cfg = smtpConfig();
  if (!cfg.host) throw new Error("未配置 SMTP 服务器地址");
  if (!cfg.from) throw new Error("未配置发件人地址");
  const recipients = (Array.isArray(to) ? to : String(to || "").split(/[,;\s]+/))
    .map((s) => s.trim())
    .filter(Boolean);
  if (!recipients.length) throw new Error("收件人为空");

  const started = Date.now();
  const socket = await connect({ host: cfg.host, port: cfg.port, secure: cfg.secure });
  let session = new SmtpSession(socket);
  try {
    await session.cmd(null, ["220"]);
    let ehlo = await session.cmd(`EHLO ${getOption("site_domain") || "ooapi.local"}`, ["250"]);
    // 非 SSL 端口：若服务器声明 STARTTLS 就升级，否则退回明文（内网自建 MTA 常见）
    if (!cfg.secure && /STARTTLS/i.test(ehlo)) {
      await session.cmd("STARTTLS", ["220"]);
      const t = await upgradeTls(socket, cfg.host);
      session = new SmtpSession(t);
      ehlo = await session.cmd(`EHLO ${getOption("site_domain") || "ooapi.local"}`, ["250"]);
    }
    if (cfg.user) {
      // 优先 AUTH LOGIN（兼容性最好），服务器不支持时再试 PLAIN
      if (/AUTH[\s\S]*LOGIN/i.test(ehlo)) {
        await session.cmd("AUTH LOGIN", ["334"]);
        await session.cmd(b64(cfg.user), ["334"]);
        await session.cmd(b64(cfg.pass), ["235"]);
      } else {
        await session.cmd(`AUTH PLAIN ${b64(`\0${cfg.user}\0${cfg.pass}`)}`, ["235"]);
      }
    }
    await session.cmd(`MAIL FROM:<${cfg.from}>`, ["250"]);
    for (const r of recipients) await session.cmd(`RCPT TO:<${r}>`, ["250", "251"]);
    await session.cmd("DATA", ["354"]);

    const boundary = `ooapi-${Date.now().toString(36)}`;
    const headers = [
      `From: =?UTF-8?B?${b64(cfg.fromName)}?= <${cfg.from}>`,
      `To: ${recipients.join(", ")}`,
      `Subject: =?UTF-8?B?${b64(subject)}?=`,
      `Date: ${new Date().toUTCString()}`,
      "MIME-Version: 1.0",
    ];
    let body;
    if (html) {
      body = [
        ...headers,
        `Content-Type: multipart/alternative; boundary="${boundary}"`,
        "",
        `--${boundary}`,
        'Content-Type: text/plain; charset="utf-8"',
        "Content-Transfer-Encoding: base64",
        "",
        b64(text || html.replace(/<[^>]+>/g, "")),
        `--${boundary}`,
        'Content-Type: text/html; charset="utf-8"',
        "Content-Transfer-Encoding: base64",
        "",
        b64(html),
        `--${boundary}--`,
      ].join("\r\n");
    } else {
      body = [
        ...headers,
        'Content-Type: text/plain; charset="utf-8"',
        "Content-Transfer-Encoding: base64",
        "",
        b64(text || ""),
      ].join("\r\n");
    }
    // 单点号必须转义成 `..`，否则服务器会提前结束 DATA
    const escaped = body.replace(/\r\n\./g, "\r\n..");
    session.write(escaped);
    await session.cmd(".", ["250"]);
    session.end();
    return { ok: true, ms: Date.now() - started, recipients: recipients.length };
  } catch (e) {
    session.end();
    throw e;
  }
}

/** 发测试邮件（管理端「测试 SMTP」按钮） */
export async function sendTestMail(to) {
  const site = getOption("site_name") || "OOAPI";
  return sendMail({
    to,
    subject: `【${site}】SMTP 配置测试`,
    text: `这是一封测试邮件。\n\n如果你收到了它，说明 ${site} 的邮件通道配置正确。\n发送时间：${new Date().toLocaleString("zh-CN")}`,
  });
}

// ---------------------------------------------------------------------------
// Webhook（sub2api 没有这一项）
// ---------------------------------------------------------------------------

/**
 * 按平台适配消息体。国内三家群机器人的结构完全不同，必须分别构造：
 *   · 飞书：{msg_type:"text", content:{text}}；签名模式下还要 timestamp+sign
 *   · 钉钉：{msgtype:"text", text:{content}}；加签要算 HMAC-SHA256 并拼到 URL
 *   · 企业微信：{msgtype:"markdown", markdown:{content}}
 *   · Slack：{text}
 *   · 自定义：原样 POST JSON（同时带 text 字段，兼容大多数自建接收端）
 */
export function buildWebhookPayload(url, title, lines) {
  const text = `${title}\n${lines.join("\n")}`;
  if (/open\.feishu\.cn|feishu\.cn/i.test(url)) {
    return { msg_type: "text", content: { text } };
  }
  if (/oapi\.dingtalk\.com/i.test(url)) {
    return { msgtype: "text", text: { content: text } };
  }
  if (/qyapi\.weixin\.qq\.com/i.test(url)) {
    return { msgtype: "markdown", markdown: { content: `**${title}**\n${lines.map((l) => `> ${l}`).join("\n")}` } };
  }
  if (/hooks\.slack\.com/i.test(url)) {
    return { text: `*${title}*\n${lines.join("\n")}` };
  }
  return { title, text, lines, content: text };
}

/** 钉钉加签：把 timestamp + "\n" + secret 用 HMAC-SHA256 算 base64 再 URL 编码 */
export async function signDingtalk(url, secret) {
  if (!secret) return url;
  const crypto = await import("node:crypto");
  const ts = Date.now();
  const sign = encodeURIComponent(
    crypto.createHmac("sha256", secret).update(`${ts}\n${secret}`).digest("base64")
  );
  return `${url}${url.includes("?") ? "&" : "?"}timestamp=${ts}&sign=${sign}`;
}

/** 飞书加签：把 timestamp + "\n" + secret 作为**密钥**，空串作为消息做 HMAC-SHA256 */
export async function signFeishu(url, secret) {
  if (!secret) return url;
  const crypto = await import("node:crypto");
  const ts = Math.floor(Date.now() / 1000);
  const sign = crypto.createHmac("sha256", `${ts}\n${secret}`).update("").digest("base64");
  return `${url}${url.includes("?") ? "&" : "?"}timestamp=${ts}&sign=${encodeURIComponent(sign)}`;
}

/** 按 URL 自动判定平台名（前端展示用） */
export function webhookPlatform(url) {
  if (/open\.feishu\.cn|feishu\.cn/i.test(url)) return "飞书";
  if (/oapi\.dingtalk\.com/i.test(url)) return "钉钉";
  if (/qyapi\.weixin\.qq\.com/i.test(url)) return "企业微信";
  if (/hooks\.slack\.com/i.test(url)) return "Slack";
  if (/discord(app)?\.com/i.test(url)) return "Discord";
  return "自定义";
}

/**
 * 发一条 Webhook。永不抛错（告警通道自身故障不应该影响告警流程），
 * 结果以返回值表达，由调用方决定是否记录。
 */
export async function sendWebhook(url, title, lines, { secret = "", timeoutMs = 10000 } = {}) {
  const started = Date.now();
  try {
    if (!/^https?:\/\//i.test(url)) return { ok: false, error: "Webhook 地址必须是 http(s) 开头" };
    let target = url;
    if (/open\.feishu\.cn|feishu\.cn/i.test(url)) target = await signFeishu(url, secret);
    else if (/oapi\.dingtalk\.com/i.test(url)) target = await signDingtalk(url, secret);

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let resp;
    try {
      resp = await fetch(target, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildWebhookPayload(url, title, lines)),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    const body = await resp.text().catch(() => "");
    // 飞书/钉钉即使 HTTP 200 也可能在 body 里报错（如 sign 校验失败）
    const failed = /"code"\s*:\s*(?!0\b)\d+|"errcode"\s*:\s*(?!0\b)\d+|"ok"\s*:\s*false|"StatusCode"\s*:\s*(?!2\d\d)/.test(body);
    if (!resp.ok || failed) {
      return { ok: false, ms: Date.now() - started, error: `HTTP ${resp.status} ${body.slice(0, 200)}` };
    }
    return { ok: true, ms: Date.now() - started };
  } catch (e) {
    return { ok: false, ms: Date.now() - started, error: e.name === "AbortError" ? "请求超时" : e.message };
  }
}
