import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, Trash2 } from "lucide-react";

import Badge from "@/components/arc/badge/badge";
import { Button } from "@/components/arc/button/button";
import MorphSelect from "@/components/arc/morph-select/morph-select";
import { NumberField } from "@/components/arc/number-field/number-field";
import { Input } from "@/components/arc/input/input";
import { SearchField } from "@/components/arc/search-field/search-field";
import { Select } from "@/components/arc/select/select";
import { apiRequest } from "@/lib/api";
import { useAsyncGuard, useNotify } from "@/lib/useNotify";

import styles from "./AdminModelConfig.module.css";

/*
  模型配置：能力参数 + 上游名映射。

  为什么和定价放同一个页面：两者服务同一件事 ——「这个模型该怎么用、按什么价算」。
  定价页已经解决了「多少钱」，这里补上「多少上下文、能不能调思考档、
  上游叫它什么名字」。

  两块的取舍不同：
    · 能力参数是「告诉网关给多少预算」—— 未核实就留空（0），运行时走保守默认，
      不编造数字；导入内置预设可以一键带出已知值；
    · 名字映射是「把上游叫法归一到本站模型」—— 不配的后果是按 0 计费（免费），
      所以界面顶部会列出「有账号但没定价」的名字提醒补。
*/

/** 与后端 services.ModelCapabilities 对应。 */
interface Capabilities {
  model: string;
  context_window: number;
  max_output_tokens: number;
  input_types: string[];
  output_types: string[];
  category: string;
  structured_output: boolean | null;
  native_search: boolean | null;
  system_messages: boolean | null;
  tool_calling: boolean | null;
  reasoning: {
    levels: string[];
    default_level: string;
    parameter: string;
    values: Record<string, string | number | boolean>;
  };
  verification: string;
  notes: string;
  customized?: boolean;
}

interface Preset {
  model: string;
  capabilities: Capabilities;
}

/** 与后端 services.ReasoningParameters 保持一致。 */
const REASONING_PARAMETERS = [
  { value: "", label: "不映射（用上游默认）" },
  { value: "reasoning_effort", label: "reasoning_effort（OpenAI 系）" },
  { value: "reasoning.effort", label: "reasoning.effort（对象内）" },
  { value: "thinking.type", label: "thinking.type（DeepSeek / Claude）" },
  { value: "thinking.budget_tokens", label: "thinking.budget_tokens（Anthropic）" },
  { value: "thinking_budget", label: "thinking_budget（GLM / 通义）" },
  { value: "enable_thinking", label: "enable_thinking（Qwen）" },
  { value: "thinkingConfig.thinkingBudget", label: "thinkingConfig.thinkingBudget（Gemini）" },
  { value: "thinkingConfig.thinkingLevel", label: "thinkingConfig.thinkingLevel（Gemini）" },
  { value: "output_config.effort", label: "output_config.effort（Claude 订阅）" },
];

const CATEGORIES = [
  { value: "chat", label: "对话" },
  { value: "image", label: "图像" },
  { value: "video", label: "视频" },
  { value: "audio", label: "音频" },
  { value: "embedding", label: "向量" },
  { value: "rerank", label: "重排" },
  { value: "decision", label: "决策" },
];

const TYPE_OPTIONS = [
  { value: "text", label: "文本" },
  { value: "image", label: "图片" },
  { value: "video", label: "视频" },
  { value: "audio", label: "音频" },
  { value: "pdf", label: "PDF" },
  { value: "embedding", label: "向量" },
];

/** 三态能力项：是 / 否 / 未核实。 */
const TRI_STATE = [
  { value: "unknown", label: "未核实" },
  { value: "yes", label: "是" },
  { value: "no", label: "否" },
];

const triToValue = (v: boolean | null): string => (v === null || v === undefined ? "unknown" : v ? "yes" : "no");
const valueToTri = (v: string): boolean | null => (v === "unknown" ? null : v === "yes");

const emptyDraft = (model = ""): Capabilities => ({
  model,
  context_window: 0,
  max_output_tokens: 0,
  input_types: ["text"],
  output_types: ["text"],
  category: "chat",
  structured_output: null,
  native_search: null,
  system_messages: null,
  tool_calling: null,
  reasoning: { levels: [], default_level: "", parameter: "", values: {} },
  verification: "unverified",
  notes: "",
});

export interface AdminModelConfigHandle {
  /** 从模型总览跳进来时，直接载入该模型的配置。 */
  focusModel: (model: string) => void;
}

export default function AdminModelConfig({ focusModel: focusRequest }: { focusModel?: string } = {}) {
  const notify = useNotify();
  const action = useAsyncGuard();

  const [items, setItems] = useState<Capabilities[]>([]);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState<Capabilities>(emptyDraft());
  /** 正在编辑的模型名（空串 = 新增）。 */
  const [editingModel, setEditingModel] = useState("");

  const [candidates, setCandidates] = useState<string[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [configs, cand] = await Promise.all([
        apiRequest<{ items: Capabilities[]; presets: Preset[] }>("/api/admin/models/configs"),
        apiRequest<{ items: string[]; priced: string[] }>("/api/admin/models/map/candidates"),
      ]);
      setItems(configs.items ?? []);
      setPresets(configs.presets ?? []);
      setCandidates(cand.items ?? []);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "加载模型配置失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  /*
    外部请求载入某个模型（从「全部模型」跳过来）。

    不能直接把 focusRequest 写进 draft：配置可能还没加载完，
    写进去会被随后的 load() 覆盖。所以等 items 到位后再匹配，
    并只在请求变化时执行一次。
  */
  useEffect(() => {
    if (!focusRequest || items.length === 0) return;
    const target = items.find((item) => item.model === focusRequest.toLowerCase());
    if (target) {
      startEdit(target);
      return;
    }
    // 没配置过：用预设或默认开一份草稿，模型名预填。
    if (preset) {
      setDraft({ ...preset.capabilities, model: focusRequest.toLowerCase() });
    } else {
      setDraft(emptyDraft(focusRequest.toLowerCase()));
    }
    setEditingModel("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequest, items.length]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((item) => item.model.toLowerCase().includes(q));
  }, [items, query]);

  const presetOptions = useMemo(
    () => presets.map((p) => ({ value: p.model, label: p.model })),
    [presets],
  );

  /** 当前草稿模型名对应的预设（用于「未配置过时先带出已知参数」）。 */
  const preset = useMemo(() => {
    const key = (focusRequest ?? "").trim().toLowerCase();
    if (!key) return undefined;
    return presets.find((p) => p.model === key)
      ?? presets.find((p) => key.startsWith(p.model) && p.model.length > 2);
  }, [presets, focusRequest]);

  /** 载入一个预设到草稿（不改模型名，除非草稿还是空的）。 */
  function applyPreset(model: string) {
    const preset = presets.find((p) => p.model === model);
    if (!preset) return;
    setDraft({ ...preset.capabilities, model: draft.model || preset.model });
    notify.success(`已载入「${model}」的参数`, "核对后保存");
  }

  /** 输入模型名时自动匹配预设（下游模型名带后缀也能命中本体）。 */
  function autoFillFromPreset(model: string) {
    const key = model.trim().toLowerCase();
    if (!key) return;
    const exact = presets.find((p) => p.model === key);
    const prefixed = presets.find((p) => key.startsWith(p.model) && p.model.length > 2);
    const hit = exact ?? prefixed;
    if (!hit) return;
    if (draft.context_window || draft.max_output_tokens || draft.reasoning.levels.length) return;
    setDraft({ ...hit.capabilities, model });
  }

  function startEdit(item: Capabilities) {
    setEditingModel(item.model);
    setDraft({
      ...item,
      reasoning: { ...item.reasoning, values: { ...item.reasoning.values } },
    });
  }

  function startCreate() {
    setEditingModel("");
    setDraft(emptyDraft());
  }

  async function save() {
    if (!draft.model.trim()) {
      notify.warning("请填写模型名");
      return;
    }
    if (!action.acquire()) return;
    try {
      await apiRequest("/api/admin/models/configs", {
        method: "PUT",
        body: {
          model: draft.model.trim(),
          context_window: draft.context_window,
          max_output_tokens: draft.max_output_tokens,
          input_types: draft.input_types,
          output_types: draft.output_types,
          category: draft.category,
          structured_output: draft.structured_output,
          native_search: draft.native_search,
          system_messages: draft.system_messages,
          tool_calling: draft.tool_calling,
          reasoning: draft.reasoning,
          verification: draft.verification,
          notes: draft.notes,
        },
      });
      notify.success(`已保存「${draft.model.trim()}」的配置`);
      setEditingModel(draft.model.trim().toLowerCase());
      await load();
    } catch (err) {
      notify.error("保存模型配置失败", err instanceof Error ? err.message : undefined);
    } finally {
      action.release();
    }
  }

  async function remove(model: string) {
    if (!action.acquire()) return;
    try {
      await apiRequest(`/api/admin/models/configs/${encodeURIComponent(model)}`, { method: "DELETE" });
      notify.success(`已删除「${model}」的配置`, "该模型回到未核实默认");
      if (editingModel === model) startCreate();
      await load();
    } catch (err) {
      notify.error("删除模型配置失败", err instanceof Error ? err.message : undefined);
    } finally {
      action.release();
    }
  }

  return (
    <div className={styles.wrap}>
      {/*
        待处理的模型名提醒。

        这些名字在本站查不到定价，调用会按 0 计费（等于免费）。
        处理它们的地方是**账号管理里的模型绑定** —— 因为「这个别名到底是
        什么模型」只有账号知道（同一个 default-model 在不同上游是完全不同的
        模型）。这里只提醒 + 指路，不提供就地编辑：就地编辑必然要问
        「哪个账号的」，而那正是绑定页已经问过的问题。
      */}
      {candidates.length > 0 && (
        <section className={styles.alert} role="status">
          <strong>有 {candidates.length} 个上游模型名在本站没有定价</strong>
          <p>
            这些名字查不到价，调用会按 0 计费（等于免费）。它们的身份只能在
            <strong>账号管理</strong>里确定，请到「账号管理 → 编辑账号 → 需要绑定真实模型」
            里逐个选择；官方拼写差异（如 <code>deepseek-v4.1-flash-sg</code>）
            已由内置注册表自动归一，不必手动配。
          </p>
          <div className={styles.alertList}>
            {candidates.slice(0, 20).map((name) => (
              <span key={name} className={styles.alertChip}>{name}</span>
            ))}
            {candidates.length > 20 && <span className={styles.muted}>等 {candidates.length} 个</span>}
          </div>
        </section>
      )}

      <div className={styles.columns}>
        {/* ---------- 左：已配置列表 ---------- */}
        <section className={styles.list}>
          <header className={styles.listHead}>
            <h2 className={styles.listTitle}>模型配置</h2>
            <Button size="sm" variant="secondary" onClick={startCreate}>
              <Plus size={13} />新增
            </Button>
          </header>
          <SearchField label="搜索模型" value={query} onValueChange={setQuery} placeholder="搜索模型名" />
          {loadError && <p className={styles.err} role="alert">{loadError}</p>}
          <div className={styles.listBody}>
            {loading ? (
              <p className={styles.muted}>加载中…</p>
            ) : filtered.length === 0 ? (
              <p className={styles.muted}>
                {items.length === 0 ? "还没有配置任何模型。左侧选预设或点「新增」开始。" : "没有匹配的模型"}
              </p>
            ) : filtered.map((item) => (
              <div key={item.model} className={styles.listRow} data-active={editingModel === item.model || undefined}>
                <button type="button" className={styles.listName} onClick={() => startEdit(item)}>
                  {item.model}
                </button>
                <div className={styles.listMeta}>
                  <span>{item.context_window ? `${(item.context_window / 1000).toFixed(0)}k 窗口` : "窗口未核实"}</span>
                  {item.reasoning.levels.length > 0 && <Badge size="sm" tone="neutral">{item.reasoning.levels.length} 档思考</Badge>}
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* ---------- 中：编辑区 ---------- */}
        <section className={styles.editor}>
          <header className={styles.editorHead}>
            <h2 className={styles.editorTitle}>{editingModel ? `编辑：${editingModel}` : "新增配置"}</h2>
            {editingModel && (
              <Button size="sm" variant="ghost" disabled={action.busy} onClick={() => void remove(editingModel)}>
                <Trash2 size={13} />删除
              </Button>
            )}
          </header>

          <div className={styles.editorBody}>
            <div className={styles.row}>
              <Input
                label="模型名（本站叫法）"
                value={draft.model}
                disabled={Boolean(editingModel)}
                placeholder="deepseek-v4.1-flash"
                description={editingModel ? "模型名是配置的主键，改名请新增一条" : undefined}
                onChange={(e) => {
                  const next = e.target.value;
                  setDraft((d) => ({ ...d, model: next }));
                  autoFillFromPreset(next);
                }}
              />
              <div className={styles.presetRow}>
                <MorphSelect
                  hideLabel
                  label="载入内置预设"
                  items={presetOptions}
                  value=""
                  onValueChange={applyPreset}
                  searchable="auto"
                  searchPlaceholder="搜索模型"
                  panelWidth={280}
                  align="end"
                  placeholder="载入内置预设…"
                />
                <span className={styles.muted}>共 {presets.length} 个预设</span>
              </div>
            </div>

            <div className={styles.grid2}>
              <NumberField
                label="上下文窗口"
                value={draft.context_window}
                min={0}
                max={10000000}
                limitHint={false}
                description="0 = 未核实，运行时走保守预算"
                onValueChange={(context_window) => setDraft((d) => ({ ...d, context_window }))}
              />
              <NumberField
                label="最大输出"
                value={draft.max_output_tokens}
                min={0}
                max={10000000}
                limitHint={false}
                description="0 = 未核实；不能超过上下文窗口"
                onValueChange={(max_output_tokens) => setDraft((d) => ({ ...d, max_output_tokens }))}
              />
            </div>

            <div className={styles.grid2}>
              <Select
                label="模型类别"
                value={draft.category}
                options={CATEGORIES}
                onValueChange={(category) => setDraft((d) => ({ ...d, category }))}
              />
              <Select
                label="核实状态"
                value={draft.verification}
                options={[{ value: "unverified", label: "未核实" }, { value: "verified", label: "已核实" }]}
                onValueChange={(verification) => setDraft((d) => ({ ...d, verification }))}
              />
            </div>

            {/* 输入/输出类型：多选，用 chip 切换（与 TagInput 的视觉语言一致） */}
            <div className={styles.typesRow}>
              <span className={styles.fieldLabel}>输入类型</span>
              <div className={styles.chips}>
                {TYPE_OPTIONS.map((opt) => {
                  const on = draft.input_types.includes(opt.value);
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      className={styles.chip}
                      data-on={on || undefined}
                      aria-pressed={on}
                      onClick={() => setDraft((d) => ({
                        ...d,
                        input_types: on ? d.input_types.filter((t) => t !== opt.value) : [...d.input_types, opt.value],
                      }))}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className={styles.typesRow}>
              <span className={styles.fieldLabel}>输出类型</span>
              <div className={styles.chips}>
                {TYPE_OPTIONS.map((opt) => {
                  const on = draft.output_types.includes(opt.value);
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      className={styles.chip}
                      data-on={on || undefined}
                      aria-pressed={on}
                      onClick={() => setDraft((d) => ({
                        ...d,
                        output_types: on ? d.output_types.filter((t) => t !== opt.value) : [...d.output_types, opt.value],
                      }))}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* 三态能力项 */}
            <div className={styles.triRow}>
              {([
                ["tool_calling", "工具调用"],
                ["structured_output", "结构化输出"],
                ["native_search", "原生搜索"],
                ["system_messages", "系统提示"],
              ] as const).map(([key, label]) => (
                <label key={key} className={styles.triCell}>
                  <span className={styles.fieldLabel}>{label}</span>
                  <Select
                    label={label}
                    hideLabel
                    value={triToValue(draft[key])}
                    options={TRI_STATE}
                    onValueChange={(v) => setDraft((d) => ({ ...d, [key]: valueToTri(v) }))}
                  />
                </label>
              ))}
            </div>

            {/* ---------- 推理档位映射 ---------- */}
            <div className={styles.reasoningBlock}>
              <div className={styles.reasoningHead}>
                <h3 className={styles.blockTitle}>推理强度映射</h3>
                <p className={styles.blockHint}>
                  把统一档位（low / medium / high）翻译成上游真正认的参数。
                  参数名写错等于没配 —— 所以只能从白名单里选。
                </p>
              </div>
              <Select
                label="下发参数"
                value={draft.reasoning.parameter}
                options={REASONING_PARAMETERS}
                onValueChange={(parameter) => setDraft((d) => ({ ...d, reasoning: { ...d.reasoning, parameter } }))}
              />
              <div className={styles.typesRow}>
                <span className={styles.fieldLabel}>档位（逗号分隔）</span>
                <Input
                  label="档位"
                  hideLabel
                  value={draft.reasoning.levels.join(", ")}
                  placeholder="none, low, medium, high"
                  description="留空表示该模型不支持调档"
                  onChange={(e) => {
                    const levels = e.target.value.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean);
                    setDraft((d) => {
                      const values: Record<string, string | number | boolean> = {};
                      for (const level of levels) values[level] = d.reasoning.values[level] ?? level;
                      return { ...d, reasoning: { ...d.reasoning, levels, values } };
                    });
                  }}
                />
              </div>
              {draft.reasoning.levels.length > 0 && (
                <div className={styles.levelValues}>
                  {draft.reasoning.levels.map((level) => (
                    <label key={level} className={styles.levelRow}>
                      <span className={styles.levelName}>{level}</span>
                      <span className={styles.muted}>→</span>
                      <Input
                        label={level}
                        hideLabel
                        value={String(draft.reasoning.values[level] ?? level)}
                        onChange={(e) => setDraft((d) => ({
                          ...d,
                          reasoning: {
                            ...d.reasoning,
                            values: { ...d.reasoning.values, [level]: e.target.value },
                          },
                        }))}
                      />
                    </label>
                  ))}
                </div>
              )}
              <Select
                label="默认档位"
                value={draft.reasoning.default_level}
                options={[{ value: "", label: "（不指定）" }, ...draft.reasoning.levels.map((l) => ({ value: l, label: l }))]}
                onValueChange={(default_level) => setDraft((d) => ({ ...d, reasoning: { ...d.reasoning, default_level } }))}
              />
            </div>

            <Input
              label="备注"
              value={draft.notes}
              placeholder="参数出处、已知限制等"
              onChange={(e) => setDraft((d) => ({ ...d, notes: e.target.value }))}
            />

            <div className={styles.editorActions}>
              <Button size="sm" variant="secondary" onClick={startCreate} disabled={action.busy}>清空</Button>
              <Button size="sm" loading={action.busy} onClick={() => void save()}>
                {editingModel ? "保存修改" : "新增配置"}
              </Button>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
