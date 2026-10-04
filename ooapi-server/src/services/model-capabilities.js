// 模型能力与价格分开维护；null 表示未核实，不把聚合服务的上限冒充原厂承诺。
import fs from "node:fs";
import { getOption, setOption } from "../config.js";
import { canonicalModelName, modelIdentityInfo } from "./models.js";

const presets = JSON.parse(fs.readFileSync(new URL("./model-capabilities.json", import.meta.url), "utf8"));
export const REASONING_PARAMETERS = ["", "reasoning_effort", "reasoning.effort", "thinking.type", "thinking.budget_tokens", "enable_thinking", "thinking_budget", "thinkingConfig.thinkingBudget", "thinkingConfig.thinkingLevel", "output_config.effort"];
const blank = { contextWindow: null, maxOutputTokens: null, inputTypes: ["text"], outputTypes: ["text"], category: "chat", structuredOutput: null, nativeSearch: null, systemMessages: null, toolCalling: null, reasoning: { levels: [], defaultLevel: "", parameter: "", values: {} }, verification: "unverified", sources: [], notes: "尚无可核实的参数；运行时使用保守上下文预算。" };
const QUICK_PRESETS = [
  ["gpt-6.1-sol", "GPT 6.1 Sol"], ["gpt-6-astra", "GPT 6 Astra"],
  ["deepseek-flash", "DeepSeek Flash"], ["claude-opus-5-5", "Claude Opus 5.5"],
  ["gemini-3.8-flash", "Gemini 3.8 Flash"],
];
const VENDOR_DOCUMENTATION = {
  openai: "https://developers.openai.com/api/docs/models",
  anthropic: "https://platform.claude.com/docs/en/about-claude/models/overview",
  deepseek: "https://api-docs.deepseek.com/",
  gemini: "https://ai.google.dev/gemini-api/docs/models",
  kiro: "https://kiro.dev/docs/models/",
  openrouter: "https://openrouter.ai/docs/guides/overview/models",
  opencode: "https://opencode.ai/docs/zen/", cline: "https://docs.cline.bot/",
  cursor: "https://docs.cursor.com/", qoder: "https://docs.qoder.com/",
  workbuddy: "https://www.codebuddy.ai/docs/", trae: "https://docs.trae.ai/",
  glm: "https://docs.bigmodel.cn/", qwen: "https://help.aliyun.com/zh/model-studio/",
  kimi: "https://platform.moonshot.ai/docs/", grok: "https://docs.x.ai/docs/models",
  mimo: "https://mimo.mi.com/docs/", minimax: "https://platform.minimax.io/docs/",
  stepfun: "https://platform.stepfun.com/docs/", doubao: "https://www.volcengine.com/docs/82379/",
  ark: "https://www.volcengine.com/docs/82379/", siliconflow: "https://docs.siliconflow.cn/",
  zcode: "https://docs.z.ai/", autoclaw: "https://docs.bigmodel.cn/",
  typesafe: "https://docs.typesafe.ai/api", chutes: "https://docs.chutes.ai/",
  nvidia: "https://docs.api.nvidia.com/", cerebras: "https://inference-docs.cerebras.ai/",
  hunyuan: "https://cloud.tencent.com/document/product/1729", meta: "https://dev.meta.ai/",
};

/** 快速回填只读取内置目录，不能把某位管理员的自定义值传播到其他模型。 */
export function modelCapabilityPresets() {
  return QUICK_PRESETS.filter(([model]) => presets[model]).map(([model, label]) => ({
    model, label, capabilities: structuredClone({ ...blank, ...presets[model] }),
  }));
}

/** 文档属于正在配置的模型；套用其他厂商预设不会改变此链接。 */
export function modelCapabilityDocumentation(model, vendor) {
  const identity = modelIdentityInfo(model);
  const sources = [...(presets[identity.model]?.sources || []), ...(presets[identity.matchedModel]?.sources || [])];
  const source = sources.find(s => /原厂|官方/.test(s.scope || "") && /^https:\/\//.test(s.url || ""));
  return source?.url || VENDOR_DOCUMENTATION[identity.developerVendor || vendor] || "";
}

export function modelCapabilities(model) {
  const identity = modelIdentityInfo(model), id = identity.model;
  // SKU 可以有自己的上限/价格；只在没有独立规格时复用已确认本体的内置参数。
  const preset = presets[id] || presets[identity.matchedModel] || blank;
  let saved;
  try { saved = JSON.parse(getOption(`model_caps:${id}`) || "null"); } catch { /* 无效旧配置回退预设 */ }
  return structuredClone({ ...blank, ...preset, ...(saved || {}), model: id, customized: Boolean(saved) });
}

export function validateCapabilities(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("模型能力必须是对象");
  const out = {};
  for (const key of ["contextWindow", "maxOutputTokens"]) {
    const n = raw[key];
    if (n != null && (!Number.isInteger(n) || n < 1 || n > 10000000)) throw new Error(`${key} 应为 1–10000000 的整数或空值`);
    out[key] = n ?? null;
  }
  if (out.contextWindow && out.maxOutputTokens > out.contextWindow) throw new Error("最大输出不能超过上下文窗口");
  for (const key of ["inputTypes", "outputTypes"]) {
    if (!Array.isArray(raw[key]) || raw[key].length > 6 || raw[key].some(v => !["text", "image", "video", "audio", "pdf", "embedding"].includes(v))) throw new Error("输入/输出类型无效");
    out[key] = [...new Set(raw[key])];
  }
  if (!["chat", "image", "video", "audio", "embedding", "rerank", "decision"].includes(raw.category)) throw new Error("模型类型无效");
  out.category = raw.category;
  for (const key of ["structuredOutput", "nativeSearch", "systemMessages", "toolCalling"]) {
    if (raw[key] != null && typeof raw[key] !== "boolean") throw new Error("能力项必须为是、否或未核实");
    out[key] = raw[key] ?? null;
  }
  const r = raw.reasoning || {};
  if (!Array.isArray(r.levels) || r.levels.length > 16 || r.levels.some(v => typeof v !== "string" || !/^[a-z0-9_-]{1,24}$/.test(v)) || new Set(r.levels).size !== r.levels.length) throw new Error("推理等级只能使用不重复的英文标识");
  if (!REASONING_PARAMETERS.includes(r.parameter || "")) throw new Error("不支持的推理参数映射");
  if (r.defaultLevel && !r.levels.includes(r.defaultLevel)) throw new Error("默认推理等级不在可选项中");
  const values = {};
  for (const level of r.levels) {
    const v = r.values?.[level] ?? level;
    if (!["string", "number", "boolean"].includes(typeof v) || (typeof v === "string" && v.length > 32) || (typeof v === "number" && (!Number.isInteger(v) || v < -1 || v > 1000000))) throw new Error("映射值无效");
    if (["thinking.budget_tokens", "thinking_budget", "thinkingConfig.thinkingBudget"].includes(r.parameter) && (typeof v !== "number" || (out.maxOutputTokens && v >= out.maxOutputTokens))) throw new Error("思考预算必须为小于最大输出的整数");
    if (r.parameter === "enable_thinking" && typeof v !== "boolean") throw new Error("enable_thinking 只能映射到布尔值");
    if (r.parameter === "thinking.type" && !["enabled", "disabled", "adaptive"].includes(v)) throw new Error("thinking.type 映射值无效");
    values[level] = v;
  }
  out.reasoning = { levels: r.levels, parameter: r.parameter || "", defaultLevel: r.defaultLevel || "", values };
  out.notes = String(raw.notes || "").slice(0, 1200);
  return out;
}
export async function saveModelCapabilities(model, raw, writeRelated) {
  const value = validateCapabilities(raw);
  await setOption(`model_caps:${canonicalModelName(model)}`, JSON.stringify(value), writeRelated);
  return modelCapabilities(model);
}
export function reasoningSelection(model, requested) {
  const caps = modelCapabilities(model), r = caps.reasoning;
  const input = String(requested ?? "").trim().toLowerCase();
  if (!input || ["none", "disabled", "off"].includes(input)) {
    const off = r.levels.find(l => ["none", "disabled", "off"].includes(l));
    if (off) return { level: "none", parameter: r.parameter, value: r.values[off] ?? off, disabled: true };
    // DeepSeek 的 effort 只接受开启后的档位；关闭必须使用 thinking.type，不能传 effort=none。
    const parameter = /^deepseek-/.test(caps.model) ? "thinking.type" : r.parameter;
    const values = { "thinking.type": "disabled", "enable_thinking": false, "thinking.budget_tokens": 0, "thinking_budget": 0, "thinkingConfig.thinkingBudget": 0, "output_config.effort": "disabled" };
    return { level: "none", parameter: Object.hasOwn(values, parameter) ? parameter : "", value: values[parameter], disabled: true };
  }
  const rank = { minimal: 1, low: 2, medium: 3, high: 4, xhigh: 5, max: 6 };
  const enabled = r.levels.filter(l => !["none", "disabled", "off"].includes(l));
  const strongest = [...enabled].sort((a, b) => {
    if (rank[a] && rank[b]) return rank[a] - rank[b];
    if (typeof r.values[a] === "number" && typeof r.values[b] === "number") return r.values[a] - r.values[b];
    return enabled.indexOf(a) - enabled.indexOf(b);
  }).at(-1);
  const level = r.levels.includes(input) ? input : strongest;
  return level ? { level, parameter: r.parameter, value: r.values[level] ?? level } : { level: "none", parameter: "", disabled: true };
}
export function reasoningBody(selection, protocol = "chat") {
  const { level, parameter, value, disabled } = selection || {};
  if (!level || !parameter) return {};
  if (protocol === "responses" && ["reasoning_effort", "reasoning.effort"].includes(parameter)) return { reasoning: { effort: value, summary: "auto" } };
  if (protocol === "gemini" && parameter.startsWith("thinkingConfig.")) return { thinkingConfig: { [parameter.split(".")[1]]: value, includeThoughts: true } };
  if (protocol === "anthropic" && parameter === "output_config.effort") return disabled ? { thinking: { type: "disabled" } } : { thinking: { type: "adaptive" }, output_config: { effort: value } };
  if (parameter === "thinking.budget_tokens") return disabled ? { thinking: { type: "disabled" } } : { thinking: { type: "enabled", budget_tokens: value } };
  if (parameter === "thinking.type") return { thinking: { type: value } };
  if (protocol === "chat" && ["reasoning_effort", "enable_thinking", "thinking_budget"].includes(parameter)) return { [parameter]: value };
  // API 网关与订阅协议的字段不同，不把不相容的映射透传给上游。
  return {};
}
