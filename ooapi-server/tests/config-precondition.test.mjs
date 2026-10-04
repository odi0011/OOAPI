import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { priceSnapshot, settingSnapshot, withConfigPrecondition } from "../src/services/config-precondition.js";

// 用串行行锁模拟 InnoDB；每个写入都必须等相同行的未提交事务结束。
function lockedStore(initial) {
  let row = structuredClone(initial), tail = Promise.resolve(), writes = 0;
  return {
    get row() { return row; }, get writes() { return writes; },
    async getConnection() {
      let unlock, previous;
      return {
        async beginTransaction() { previous = tail; tail = new Promise(resolve => { unlock = resolve; }); await previous; },
        async query(sql) { assert.match(sql, /FOR UPDATE/); return [row == null ? [] : [row]]; },
        async commit() { unlock(); }, async rollback() { unlock(); }, release() {},
        async write(next) { writes++; row = structuredClone(next); },
      };
    },
    async query() { throw new Error("准备写入必须使用取得锁的 connection"); },
  };
}
const price = { model: "fixture-model", input_price: 1, output_price: 2, cache_price: .1, channel_type: "fixture", remark: "保留", offpeak_input_price: null, offpeak_output_price: null, offpeak_cache_price: null, offpeak_rule: null };

test("并发请求通过执行前GET后，一次价格CAS成功，过时请求不能覆盖", async () => {
  const db = lockedStore(price), expected = priceSnapshot(price);
  const results = await Promise.allSettled([
    withConfigPrecondition(db, "pricing", price.model, expected, connection => connection.write({ ...price, input_price: 3 })),
    withConfigPrecondition(db, "pricing", price.model, expected, connection => connection.write({ ...price, input_price: 8 })),
  ]);
  assert.equal(results[0].status, "fulfilled"); assert.equal(results[1].status, "rejected");
  assert.equal(results[1].reason.code, "CONFIG_CHANGED"); assert.equal(results[1].reason.status, 409);
  assert.equal(db.row.input_price, 3); assert.equal(db.writes, 1);
});
test("无价格行的同时新增也不能覆盖较先提交的价格", async () => {
  const db = lockedStore(null);
  const results = await Promise.allSettled([
    withConfigPrecondition(db, "pricing", price.model, null, connection => connection.write(price)),
    withConfigPrecondition(db, "pricing", price.model, null, connection => connection.write({ ...price, output_price: 9 })),
  ]);
  assert.equal(results[0].status, "fulfilled"); assert.equal(results[1].reason.code, "CONFIG_CHANGED");
  assert.equal(db.row.output_price, 2); assert.equal(db.writes, 1);
});
test("偏好JSON结构比较；并发更新保留较先提交的其他配置", async () => {
  const original = { theme: "light", list: { pinned: true } }, db = lockedStore({ setting: JSON.stringify(original) });
  const results = await Promise.allSettled([
    withConfigPrecondition(db, "settings", 7, original, connection => connection.write({ setting: JSON.stringify({ ...original, list: { pinned: false } }) })),
    withConfigPrecondition(db, "settings", 7, original, connection => connection.write({ setting: JSON.stringify({ ...original, theme: "dark" }) })),
  ]);
  assert.equal(results[0].status, "fulfilled"); assert.equal(results[1].reason.code, "CONFIG_CHANGED");
  assert.deepEqual(settingSnapshot(db.row.setting), { theme: "light", list: { pinned: false } });
});
test("普通界面无快照时维持原写法；业务路由实际接入CAS事务", async () => {
  const db = { query: async () => "legacy" };
  assert.equal(await withConfigPrecondition(db, "settings", 7, undefined, connection => connection.query()), "legacy");
  const pricingRoute = await readFile(new URL("../src/routes/pricing.js", import.meta.url), "utf8");
  const userRoute = await readFile(new URL("../src/routes/user.js", import.meta.url), "utf8");
  assert.match(pricingRoute, /withConfigPrecondition\(pool, "pricing"[\s\S]*connection => connection\.query\(/);
  assert.match(userRoute, /withConfigPrecondition\(pool, "settings"[\s\S]*connection => connection\.query\(/);
});
