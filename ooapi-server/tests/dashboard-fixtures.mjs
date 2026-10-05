// 看板浏览器样本按同一组调用记录归集，避免各卡片数值看似合理却互相对不上。
// 只有公开字段；不读数据库、凭据或真实客户数据，也不联系上游。
export const generatedAt = Date.parse("2026-10-05T06:30:00Z") / 1000;
const midnight = Date.parse("2026-10-04T16:00:00Z") / 1000;
export const visibility = { version: 1, balance: true, usage_summary: true, usage_records: true, request_content: true, pricing: true };
export const people = [
  { id: 11, user_id: 11, username: "atlas", display_name: "林同学", avatar_url: "/icons/openai.svg?v=older-record" },
  { id: 12, user_id: 12, username: "beacon", display_name: "自动化服务", avatar_url: "/icons/gemini.svg" },
  { id: 13, user_id: 13, username: "coral", display_name: "研发团队", avatar_url: "/icons/claude.svg" },
  { id: 14, user_id: 14, username: "delta", display_name: "运营账号的较长显示名称", avatar_url: "" },
];
export const tokens = people.flatMap((user, i) => [
  { id: 21 + i * 2, name: i % 2 ? "日报任务" : "开发环境", owner: user.display_name, user_id: user.id },
  { id: 22 + i * 2, name: "生产服务", owner: user.display_name, user_id: user.id },
]);
const channels = [
  { channel_id: 31, name: "官方 OpenAI", type: "openai" },
  { channel_id: 32, name: "Gemini 聚合渠道", type: "antigravity" },
  { channel_id: 33, name: "开发者免费渠道", type: "opencode" },
  { channel_id: 34, name: "Kiro 团队渠道", type: "kiro" },
];
const modelNames = ["gpt-6.1-sol", "gpt-6-astra", "gemini-3.8-flash", "claude-opus-5.5", "deepseek-flash", "mimo-v2.6-flash", "qwen3.8-27b", "grok-4.7", "glm-5.3-flash", "apodex-1.1-mini", "laguna-s-2.1", "nemotron-3-super", "gemini-3.5-flash", "34-auto"];
export const records = Array.from({ length: 90 }, (_, dayIndex) => Array.from({ length: 14 }, (_, modelIndex) => {
  const person = people[(dayIndex + modelIndex) % people.length];
  const token = tokens[people.indexOf(person) * 2 + dayIndex % 2];
  const channel = channels[modelIndex % channels.length];
  const status = modelIndex === (dayIndex === 89 ? 6 : dayIndex % 14) ? "error" : modelIndex === (dayIndex + 4) % 14 ? "stopped" : (dayIndex === 89 && modelIndex === 13 || modelIndex === (dayIndex + 8) % 14 && dayIndex % 3 === 0) ? "partial" : "success";
  const prompt = status === "error" ? 0 : (modelIndex + 1) * (dayIndex % 7 + 1) * 170;
  const cache = modelIndex % 3 === 0 ? Math.floor(prompt * 0.75) : modelIndex % 3 === 1 ? 0 : Math.floor(prompt * 0.25);
  const output = status === "error" ? 0 : (modelIndex + 2) * 23;
  return {
    id: dayIndex * 14 + modelIndex + 1, created_at: midnight - (89 - dayIndex) * 86400 + 3600 + modelIndex * 2600,
    ...person, id: dayIndex * 14 + modelIndex + 1, user_id: person.id, token_id: token.id, token_name: token.name, channel_id: channel.channel_id,
    channel_name: channel.name, channel_type: channel.type, model: modelNames[modelIndex], model_vendor: "", source_vendors: [channel.type],
    requested_model: modelNames[modelIndex], upstream_model: modelNames[modelIndex] === "deepseek-flash" ? "deepseek-v4.1-flash-free" : modelNames[modelIndex] === "claude-opus-5.5" ? "claude-opus-5.5-thinking" : modelIndex === 13 ? "auto" : modelNames[modelIndex],
    billing_model: modelNames[modelIndex], pricing_model: modelNames[modelIndex], type: status === "success" ? 2 : 4, status,
    units: status === "error" ? 0 : dayIndex === 89 && modelIndex === 12 ? 1 : (modelIndex + 1) * (dayIndex % 5 + 1) * 7,
    prompt_tokens: prompt, completion_tokens: output, cache_tokens: cache, total_tokens: prompt + output,
    elapsed_ms: 800 + modelIndex * 510, first_token_ms: status === "error" ? null : modelIndex === 13 ? 5300 : modelIndex === 10 ? 3500 : 220 + modelIndex * 70,
    error_code: status === "error" ? "CHANNEL_BAD_REQUEST" : "", input_text: "隔离浏览器样本", output_text: status === "error" ? "" : "仅展示合成数据，无真实上游调用",
  };
})).flat().filter((row) => {
  const dayIndex = Math.floor((row.id - 1) / 14), modelIndex = (row.id - 1) % 14;
  return dayIndex === 89 || (dayIndex % 11 !== 0 && modelIndex < 14 - dayIndex % 7);
});

const sum = (rows, name) => rows.reduce((total, row) => total + Number(row[name] || 0), 0);
function summarize(rows) {
  const calls = rows.length, successes = rows.filter((row) => row.status === "success").length;
  const errors = rows.filter((row) => ["error", "partial"].includes(row.status)).length;
  const stopped = rows.filter((row) => row.status === "stopped").length;
  const partial = rows.filter((row) => row.status === "partial").length;
  const prompt = sum(rows, "prompt_tokens"), cache = sum(rows, "cache_tokens"), output = sum(rows, "completion_tokens");
  return { calls, successes, errors, failed: errors - partial, stopped, partial, partials: partial, remaining: calls - successes - errors - stopped,
    units: sum(rows, "units"), prompt_tokens: prompt, completion_tokens: output, cache_tokens: cache, uncached_tokens: prompt - cache,
    total_tokens: prompt + output, tokens: prompt + output, cache_rate: prompt ? +(cache / prompt * 100).toFixed(2) : null,
    success_rate: calls ? +(successes / calls * 100).toFixed(2) : null, active_users: new Set(rows.map((row) => row.user_id)).size,
    models: new Set(rows.map((row) => row.model)).size, avg_elapsed: calls ? sum(rows, "elapsed_ms") / calls : null,
    avg_first_token: rows.some((row) => row.first_token_ms != null) ? sum(rows, "first_token_ms") / rows.filter((row) => row.first_token_ms != null).length : null,
  };
}
function groupRows(rows, name) {
  const groups = new Map();
  for (const row of rows) { const key = row[name]; groups.set(key, [...(groups.get(key) || []), row]); }
  return [...groups].map(([key, values]) => ({ [name]: key, ...summarize(values), username: values[0].username, display_name: values[0].display_name, avatar_url: values[0].avatar_url, model_vendor: values[0].model_vendor, source_vendors: [...new Set(values.map((row) => row.channel_type))] }));
}

export function dashboardData(query, { personal = false, empty = false, denied = false, missingRealtime = false, debt = false, truncatedAudience = false, unknownStatus = false, manyChannels = false } = {}) {
  const range = query.get("range") || "30d", days = { "7d": 7, "30d": 30, "90d": 90 }[range] || 30;
  const userId = Number(query.get("user_id") || (personal ? 11 : 0)), tokenId = Number(query.get("token_id") || 0);
  const from = midnight - (days - 1) * 86400;
  const match = (row) => (!userId || row.user_id === userId) && (!tokenId || row.token_id === tokenId);
  let selected = empty ? [] : records.filter((row) => row.created_at >= from && row.created_at <= generatedAt && match(row));
  const availableChannels = manyChannels ? Array.from({ length: 16 }, (_, index) => ({ channel_id: 31 + index, name: `隔离渠道 ${31 + index}`, type: channels[index % channels.length].type })) : channels;
  if (manyChannels) selected = selected.map((row) => {
    const channel = availableChannels[(row.id - 1) % availableChannels.length];
    return { ...row, channel_id: channel.channel_id, channel_name: channel.name, channel_type: channel.type, source_vendors: [channel.type] };
  });
  if (unknownStatus && selected.length) {
    const latestId = Math.max(...selected.map((row) => row.id));
    selected = selected.map((row) => row.id === latestId ? { ...row, status: "legacy_unrecognized", type: 2 } : row);
  }
  const previousRows = empty ? [] : records.filter((row) => row.created_at >= from - days * 86400 && row.created_at < from && match(row));
  const totals = { ...summarize(selected), users_total: people.length, users_new: 2 };
  const trend = Array.from({ length: days }, (_, index) => {
    const dayTs = from + index * 86400;
    return { day: new Date((dayTs + 8 * 3600) * 1000).toISOString().slice(0, 10), day_ts: dayTs, ...summarize(selected.filter((row) => row.created_at >= dayTs && row.created_at < dayTs + 86400)) };
  });
  const models = groupRows(selected, "model").sort((a, b) => b.units - a.units);
  const topUsers = groupRows(selected, "user_id").sort((a, b) => b.units - a.units);
  const topTokens = groupRows(selected, "token_id").sort((a, b) => b.units - a.units).map((row) => ({ ...row, ...tokens.find((token) => token.id === row.token_id) }));
  const byChannel = groupRows(selected, "channel_id").sort((a, b) => b.units - a.units).map((row) => ({ ...row, ...availableChannels.find((channel) => channel.channel_id === row.channel_id) }));
  const recent = [...selected].sort((a, b) => b.created_at - a.created_at).slice(0, 8);
  const response = { range: { key: range, days, from, to: generatedAt, timezone: "Asia/Shanghai", generated_at: generatedAt, includes_today: true }, generatedAt, timezone: "Asia/Shanghai",
    scope: { kind: userId || tokenId ? "filtered" : "site", user_id: userId || null, token_id: tokenId || null },
    totals, previous: summarize(previousRows), trend, top_models: models, by_model: models, top_users: truncatedAudience ? topUsers.slice(0, 2) : topUsers, top_tokens: truncatedAudience ? topTokens.slice(0, 2) : topTokens,
    by_channel: byChannel, errors_by_model: models.filter((row) => row.errors > 0), recent_logs: recent,
    by_hour: groupRows(selected.map((row) => ({ ...row, hour: Math.floor(((row.created_at + 8 * 3600) % 86400) / 3600) })), "hour"),
    realtime: missingRealtime ? {} : { inFlight: 2, sla: 99.8, errorRate: 0.2, p95Ms: 7300 },
    account: { quota: debt ? -1500 : 250000, used_quota: sum(records.filter((row) => row.user_id === 11), "units"), active_tokens: 2, total_tokens: 3, group_name: "开发组", group_rate: 1 },
    filters: { user_id: userId || null, token_id: tokenId || null },
  };
  if (denied) return { range: response.range, generatedAt, account: { active_tokens: 2, total_tokens: 3, group_name: "开发组" } };
  return response;
}

export function dashboardFilters(query) {
  const userId = Number(query.get("user_id"));
  return { users: people, tokens: userId ? tokens.filter((token) => token.user_id === userId) : tokens };
}
