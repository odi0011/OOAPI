// 重连必须恢复超过环形缓冲上限的完整回答，再从末尾继续，不能重复追加。
import assert from "node:assert/strict";
import { startRun, publish, subscribe, finishRun } from "../src/services/harness/runs.js";

const run = startRun(`long-reconnect-${Date.now()}`);
publish(run, { type: "part", part: { id: "long", type: "text", text: "" } });
const expected = Array.from({ length: 4070 }, (_, i) => `${i}|`).join("");
for (let i = 0; i < 4070; i += 1) publish(run, { type: "delta", id: "long", field: "text", delta: `${i}|` });
publish(run, { type: "part_update", id: "long", patch: { complete: true } });
let text = "";
let ended = false;
subscribe(run, (event) => {
  if (event === null) { ended = true; return; }
  if (event.type === "snapshot") {
    assert.equal(event.parts[0].complete, true);
    text = event.parts[0].text;
  }
  if (event.type === "delta") text += event.delta;
});
assert.equal(text, expected);
publish(run, { type: "delta", id: "long", field: "text", delta: "尾部" });
assert.equal(text, `${expected}尾部`);
finishRun(run, { type: "done" });
assert.equal(ended, true);
const replay = [];
subscribe(run, (event) => replay.push(event));
assert.equal(replay[0].parts[0].text, `${expected}尾部`);
assert.equal(replay.at(-1), null);
console.log("  长回答断线快照、继续增量、结束后恢复 3 项通过");
