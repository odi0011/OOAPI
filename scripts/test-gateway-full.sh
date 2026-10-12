#!/bin/bash
# 网关全链路真实测试
#
# 上游是服务器上自建的 mock 服务（:9999），返回标准 OpenAI 格式响应并带 usage。
# 这样能验证完整链路：鉴权 → 分组 → 调度 → 转发 → 解析用量 → 计费 → 写日志。

set -u
B="https://ooapi.space"; R="--resolve ooapi.space:443:127.0.0.1"
UP="http://210.126.235.109:9999"

TOK=$(curl -s --max-time 10 -X POST "$B/api/auth/login" $R -H "Content-Type: application/json" \
  -d '{"username":"odi","password":"123456"}' | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['token'])" 2>/dev/null)
A="Authorization: Bearer $TOK"
echo "$TOK" > /tmp/tok.txt

echo "========== 清理上一轮测试数据 =========="
for cid in $(curl -s "$B/api/admin/channels" $R -H "$A" | python3 -c "import sys,json;[print(c['id']) for c in json.load(sys.stdin)['data']['items']]" 2>/dev/null); do
  curl -s -X DELETE "$B/api/admin/channels/$cid" $R -H "$A" > /dev/null
done
for tid in $(curl -s "$B/api/token/" $R -H "$A" | python3 -c "import sys,json;[print(t['id']) for t in json.load(sys.stdin)['data']['items']]" 2>/dev/null); do
  curl -s -X DELETE "$B/api/token/$tid" $R -H "$A" > /dev/null
done
for gid in $(curl -s "$B/api/admin/groups" $R -H "$A" | python3 -c "import sys,json;[print(g['id']) for g in json.load(sys.stdin)['data']['items']]" 2>/dev/null); do
  curl -s -X DELETE "$B/api/admin/groups/$gid" $R -H "$A" > /dev/null
done
echo "  已清空"

echo ""
echo "========== 准备数据 =========="
curl -s --max-time 10 -X PUT "$B/api/admin/users/7/quota" $R -H "$A" -H "Content-Type: application/json" \
  -d '{"delta":5000000}' > /dev/null

# 分组 A：不限模型，倍率 1
GA=$(curl -s --max-time 10 -X POST "$B/api/admin/groups" $R -H "$A" -H "Content-Type: application/json" \
  -d '{"name":"e2e-a","remark":"不限模型","rate":1,"models":[]}' \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['id'])" 2>/dev/null)
# 分组 B：只允许 test-model，倍率 2（用于验证倍率与白名单）
GB=$(curl -s --max-time 10 -X POST "$B/api/admin/groups" $R -H "$A" -H "Content-Type: application/json" \
  -d '{"name":"e2e-b","remark":"双倍率且限模型","rate":2,"models":["test-model"]}' \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['id'])" 2>/dev/null)
echo "  分组: e2e-a(id=$GA) 不限 / e2e-b(id=$GB) 倍率2+限test-model"

# 定价
curl -s --max-time 10 -X POST "$B/api/admin/prices" $R -H "$A" -H "Content-Type: application/json" \
  -d '{"model":"test-model","input_price":1000,"output_price":2000,"cached_price":500}' > /dev/null
echo "  定价: test-model 输入=1000 输出=2000（OD/百万token）"

# 渠道：指向 mock 上游
CID=$(curl -s --max-time 15 -X POST "$B/api/admin/channels" $R -H "$A" -H "Content-Type: application/json" \
  -d "{\"name\":\"Mock 上游\",\"vendor\":\"custom\",\"base_url\":\"$UP\",\"api_key\":\"mock-key\",\"models\":[\"test-model\"],\"priority\":1,\"weight\":1}" \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['id'])" 2>/dev/null)
echo "  渠道: Mock 上游(id=$CID) -> $UP"

# 两把密钥，分别绑两个分组
KA=$(curl -s --max-time 10 -X POST "$B/api/token/" $R -H "$A" -H "Content-Type: application/json" \
  -d '{"name":"密钥A","group_name":"e2e-a","unlimited_quota":false,"quota":1000000}' \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['api_key'])" 2>/dev/null)
KB=$(curl -s --max-time 10 -X POST "$B/api/token/" $R -H "$A" -H "Content-Type: application/json" \
  -d '{"name":"密钥B","group_name":"e2e-b","unlimited_quota":false,"quota":1000000}' \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['api_key'])" 2>/dev/null)
echo "  密钥A(分组a)=${KA:0:14}...  密钥B(分组b)=${KB:0:14}..."

echo ""
echo "========== 1. 鉴权 =========="
printf "  无 Key        -> "
curl -s --max-time 15 -X POST "$B/v1/chat/completions" $R -H "Content-Type: application/json" \
  -d '{"model":"test-model","messages":[]}' | python3 -c "import sys,json;print(json.load(sys.stdin)['error']['code'])" 2>/dev/null
printf "  假 Key        -> "
curl -s --max-time 15 -X POST "$B/v1/chat/completions" $R -H "Authorization: Bearer sk-000000000000000000000000000000000000000000000000" \
  -H "Content-Type: application/json" -d '{"model":"test-model"}' | python3 -c "import sys,json;print(json.load(sys.stdin)['error']['code'])" 2>/dev/null

echo ""
echo "========== 2. 分组模型白名单（密钥B 只允许 test-model）=========="
printf "  密钥B 调 test-model    -> "
curl -s --max-time 30 -X POST "$B/v1/chat/completions" $R -H "Authorization: Bearer $KB" \
  -H "Content-Type: application/json" -d '{"model":"test-model","messages":[{"role":"user","content":"hi"}]}' \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print('OK 上游回复:', d['choices'][0]['message']['content']) if 'choices' in d else print('错误:', d['error']['code'])" 2>/dev/null
printf "  密钥B 调 other-model   -> "
curl -s --max-time 15 -X POST "$B/v1/chat/completions" $R -H "Authorization: Bearer $KB" \
  -H "Content-Type: application/json" -d '{"model":"other-model","messages":[]}' \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['error']['code'])" 2>/dev/null

echo ""
echo "========== 3. 非流式转发 + 计费 =========="
BEFORE=$(curl -s --max-time 10 "$B/api/token/" $R -H "$A" | python3 -c "
import sys,json
for t in json.load(sys.stdin)['data']['items']:
    if t['name']=='密钥A': print(t['used_quota'])
" 2>/dev/null)
echo "  调用前密钥A已用额度 = $BEFORE"

curl -s --max-time 30 -X POST "$B/v1/chat/completions" $R -H "Authorization: Bearer $KA" \
  -H "Content-Type: application/json" \
  -d '{"model":"test-model","messages":[{"role":"user","content":"hello"}]}' \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print('  上游回复:', d['choices'][0]['message']['content'], '| usage:', d['usage'])" 2>/dev/null

sleep 1
AFTER=$(curl -s --max-time 10 "$B/api/token/" $R -H "$A" | python3 -c "
import sys,json
for t in json.load(sys.stdin)['data']['items']:
    if t['name']=='密钥A': print(t['used_quota'])
" 2>/dev/null)
echo "  调用后密钥A已用额度 = $AFTER"

# 手工核算：prompt=150, completion=60, 输入价1000/百万, 输出价2000/百万
python3 -c "
p, c = 150, 60
expected = int(1000 * p / 1e6 * 10000 + 2000 * c / 1e6 * 10000 + 0.5)
print('  手工核算应为 %d 单位（150 prompt + 60 completion，倍率1）' % expected)
before, after = $BEFORE, $AFTER
actual = after - before
print('  实际扣费 %d 单位' % actual)
print('  ' + ('✓ 计费正确' if abs(actual - expected) <= 1 else '✗ 计费异常'))
"

echo ""
echo "========== 4. 分组倍率（密钥B 倍率 2）=========="
B_BEFORE=$(curl -s --max-time 10 "$B/api/token/" $R -H "$A" | python3 -c "
import sys,json
for t in json.load(sys.stdin)['data']['items']:
    if t['name']=='密钥B': print(t['used_quota'])
" 2>/dev/null)
curl -s --max-time 30 -X POST "$B/v1/chat/completions" $R -H "Authorization: Bearer $KB" \
  -H "Content-Type: application/json" \
  -d '{"model":"test-model","messages":[{"role":"user","content":"hi"}]}' > /dev/null
sleep 1
B_AFTER=$(curl -s --max-time 10 "$B/api/token/" $R -H "$A" | python3 -c "
import sys,json
for t in json.load(sys.stdin)['data']['items']:
    if t['name']=='密钥B': print(t['used_quota'])
" 2>/dev/null)
python3 -c "
b, a = $B_BEFORE, $B_AFTER
print('  密钥B 扣费 %d 单位（应为密钥A的两倍）' % (a - b))
ratio = (a - b) / max(1, $AFTER - $BEFORE)
print('  实际倍率 ≈ %.2f' % ratio)
print('  ' + ('✓ 倍率生效' if 1.8 <= ratio <= 2.2 else '✗ 倍率异常'))
"

echo ""
echo "========== 5. 流式转发 =========="
echo "  收到的 SSE 数据:"
curl -s --max-time 30 -N -X POST "$B/v1/chat/completions" $R -H "Authorization: Bearer $KA" \
  -H "Content-Type: application/json" \
  -d '{"model":"test-model","stream":true,"messages":[{"role":"user","content":"hi"}]}' \
  | head -6 | sed 's/^/    /'

echo ""
echo "========== 6. 日志 =========="
curl -s --max-time 10 "$B/api/logs?page_size=5" $R -H "$A" > /tmp/lg.json
python3 -c "
import json
d = json.load(open('/tmp/lg.json'))['data']
print('  日志总数:', d['total'])
for lg in d['items']:
    print('    %-12s tokens=%s/%s 费用=%s 耗时=%sms' % (
        lg['model'], lg['prompt_tokens'], lg['completion_tokens'], lg['quota'], lg['latency_ms']))
"

echo ""
echo "========== 7. 运行状态 =========="
curl -s --max-time 10 "$B/api/admin/status" $R -H "$A" | python3 -c "
import sys,json
d = json.load(sys.stdin)['data']
print('  数据库:', '正常' if d['database']['ok'] else '异常')
print('  渠道: 共 %s 个，启用 %s，冷却 %s' % (d['channels']['total'], d['channels']['active'], d['channels']['cooling']))
print('  近24h: 调用 %s 次，错误 %s 次，平均延迟 %.0fms' % (
    d['calls_24h']['calls'], d['calls_24h']['errors'], d['calls_24h']['avg_latency'] or 0))
print('  分组 %s 个，启用密钥 %s 把' % (d['groups'], d['active_tokens']))
"

echo ""
echo "========== 8. 上游失败时的重试与降级 =========="
# 把一个渠道指向不存在的端口，验证网关会尝试下一个渠道
BAD=$(curl -s --max-time 15 -X POST "$B/api/admin/channels" $R -H "$A" -H "Content-Type: application/json" \
  -d '{"name":"坏渠道","vendor":"custom","base_url":"http://210.126.235.109:9998","api_key":"k","models":["test-model"],"priority":99,"weight":1}' \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['id'])" 2>/dev/null)
echo "  已建一个指向死端口的高优先级渠道（id=$BAD，优先级 99）"
printf "  调用（应自动降级到可用渠道）-> "
curl -s --max-time 40 -X POST "$B/v1/chat/completions" $R -H "Authorization: Bearer $KA" \
  -H "Content-Type: application/json" \
  -d '{"model":"test-model","messages":[{"role":"user","content":"retry test"}]}' \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print('✓ 成功降级，回复:', d['choices'][0]['message']['content']) if 'choices' in d else print('✗ 失败:', d['error']['message'][:80])" 2>/dev/null
curl -s -X DELETE "$B/api/admin/channels/$BAD" $R -H "$A" > /dev/null
