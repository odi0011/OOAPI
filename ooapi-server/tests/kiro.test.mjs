// Kiro 适配器桩测试：AWS EventStream 帧解析 + 凭据解析（无需真实凭据）
// 运行：node --test tests/
import test from "node:test";
import assert from "node:assert/strict";
import { createAwsEventStreamParser } from "../src/services/upstream/kiro-eventstream.js";
import { parseAuthJson } from "../src/services/upstream/kiro-auth.js";

function strHeader(name, value) {
  const n = Buffer.from(name, "utf8");
  const v = Buffer.from(value, "utf8");
  return Buffer.concat([Buffer.from([n.length]), n, Buffer.from([7]), Buffer.from([v.length >> 8, v.length & 0xff]), v]);
}

function frame(headers, payload) {
  const hb = Buffer.concat(headers);
  const pb = Buffer.from(JSON.stringify(payload), "utf8");
  const total = 12 + hb.length + pb.length + 4;
  const pre = Buffer.alloc(12);
  pre.writeUInt32BE(total, 0);
  pre.writeUInt32BE(hb.length, 4);
  const crc = Buffer.alloc(4);
  return Buffer.concat([pre, hb, pb, crc]);
}

test("事件流：连续两帧（含跨 chunk 拆分）", () => {
  const p = createAwsEventStreamParser();
  const f1 = frame([strHeader(":event-type", "assistantResponseEvent"), strHeader(":message-type", "event")], {
    content: "你好",
  });
  const f2 = frame([strHeader(":event-type", "assistantResponseEvent")], { content: "世界" });
  const all = Buffer.concat([f1, f2]);

  // 第一段只推一半（制造跨 chunk）
  let events = p.push(all.subarray(0, Math.floor(all.length / 2)));
  assert.equal(events.length, 0);
  events = p.push(all.subarray(Math.floor(all.length / 2)));
  assert.equal(events.length, 2);
  assert.equal(events[0].type, "assistantResponseEvent");
  assert.equal(events[0].payload.content, "你好");
  assert.equal(events[1].payload.content, "世界");
});

test("事件流：异常帧 message-type=exception", () => {
  const p = createAwsEventStreamParser();
  const f = frame([strHeader(":event-type", "invalidStateEvent"), strHeader(":message-type", "exception")], {
    reason: "bad state",
  });
  const events = p.push(f);
  assert.equal(events.length, 1);
  assert.equal(events[0].messageType, "exception");
  assert.equal(events[0].payload.reason, "bad state");
});

test("事件流：长度异常抛错并丢弃缓冲", () => {
  const p = createAwsEventStreamParser();
  const bad = Buffer.alloc(20);
  bad.writeUInt32BE(0xffffffff >>> 0, 0);
  bad.writeUInt32BE(0, 4);
  assert.throws(() => p.push(bad), /帧长度异常/);
});

test("凭据解析：桌面版 kiro-auth-token.json", () => {
  const c = parseAuthJson(JSON.stringify({ accessToken: "a", refreshToken: "r", region: "us-west-2", profileArn: "arn:x" }));
  assert.equal(c.access_token, "a");
  assert.equal(c.refresh_token, "r");
  assert.equal(c.region, "us-west-2");
  assert.equal(c.profile_arn, "arn:x");
});

test("凭据解析：嵌套 auth 包装 + SSO 形态", () => {
  const c = parseAuthJson(JSON.stringify({ auth: { access_token: "a2", refresh_token: "r2", client_id: "cid", client_secret: "sec" } }));
  assert.equal(c.access_token, "a2");
  assert.equal(c.client_id, "cid");
  assert.equal(c.client_secret, "sec");
  assert.equal(c.region, "us-east-1");
});

test("凭据解析：裸 refresh token 字符串", () => {
  const c = parseAuthJson("r".repeat(40));
  assert.equal(c.refresh_token, "r".repeat(40));
  assert.equal(c.access_token, "");
});

test("凭据解析：非法输入报错", () => {
  assert.throws(() => parseAuthJson("short"), /refresh token/);
  assert.throws(() => parseAuthJson(JSON.stringify({ region: "us-east-1" })), /缺少 accessToken/);
});
