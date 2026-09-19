// UA 解析单元测试（deviceFromUa 用于「使用记录」的设备列）
import { deviceFromUa } from "../src/utils.js";

const cases = [
  ["node", "Node.js"],
  ["node-fetch/1.0", "Node.js"],
  ["curl/8.5.0", "curl"],
  ["python-requests/2.31.0", "Python"],
  ["Go-http-client/2.0", "Go"],
  ["PostmanRuntime/7.36.0", "Postman"],
  [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Chrome 131 · Windows",
  ],
  [
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
    "Safari 17 · macOS",
  ],
  [
    "Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
    "Edge 131 · Windows",
  ],
  [
    "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
    "Chrome 120 · Android",
  ],
  [
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    "Safari 17 · iOS",
  ],
  ["", ""],
];

let bad = 0;
for (const [ua, want] of cases) {
  const got = deviceFromUa(ua);
  const ok = got === want;
  if (!ok) bad += 1;
  console.log(`${ok ? "OK  " : "FAIL"} ${JSON.stringify(got)}${ok ? "" : ` (want ${JSON.stringify(want)})`}`);
}
console.log(bad === 0 ? "UA_PARSE_ALL_PASS" : `UA_PARSE_FAILURES=${bad}`);
process.exit(bad === 0 ? 0 : 1);
