import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import { Network, RefreshCw } from "lucide-react";

import Accordion from "@/components/arc/accordion/accordion";
import Badge from "@/components/arc/badge/badge";
import { BottomSheet } from "@/components/arc/bottom-sheet/bottom-sheet";
import { Button } from "@/components/arc/button/button";
import { Dialog, DialogContent } from "@/components/arc/dialog/dialog";
import { EmptyState } from "@/components/arc/empty-state/empty-state";
import HoldToConfirm from "@/components/arc/hold-to-confirm/hold-to-confirm";
import InlineEdit from "@/components/arc/inline-edit/inline-edit";
import { Input } from "@/components/arc/input/input";
import MorphSelect from "@/components/arc/morph-select/morph-select";
import { NumberField } from "@/components/arc/number-field/number-field";
import { Pagination } from "@/components/arc/pagination/pagination";
import { SearchField } from "@/components/arc/search-field/search-field";
import { Select } from "@/components/arc/select/select";
import { SortableDataTable, type DataColumn, type SortState } from "@/components/arc/sortable-data-table/sortable-data-table";
import { TagInput } from "@/components/arc/tag-input/tag-input";
import { Tabs, TabsList, TabsTrigger } from "@/components/arc/tabs/tabs";
import { Textarea } from "@/components/arc/textarea/textarea";
import AdminLayout from "@/components/admin/AdminLayout";
import DeviceLoginPanel from "@/components/admin/DeviceLoginPanel";
import SubscriptionLoginPanel from "@/components/admin/SubscriptionLoginPanel";
import ScrollArea from "@/components/arc/scroll-area/scroll-area";
import { ModelMark, VendorMark } from "@/components/BrandMark";
import { useAuth } from "@/contexts/AuthContext";
import { ApiRequestError, apiRequest } from "@/lib/api";
import { Perm } from "@/lib/permissions";
import { useAsyncGuard, useNotify } from "@/lib/useNotify";
import { canonicalVendor, vendorLabel } from "@/lib/vendorIcons";
import { connectionFor, providerFor, UPSTREAM_PROVIDERS, type ConnectionPreset, type DeviceVendor, type SubscriptionVendor } from "@/lib/upstreamProviders";
import styles from "./AdminChannels.module.css";

interface Channel extends Record<string, unknown> {
  id: number;
  name: string;
  vendor: string;
  base_url: string;
  method: "api" | "cli" | "kiro" | "workbuddy" | "grok";
  has_credential: boolean;
  auth_expires_at: number;
  has_key: boolean;
  key_hint: string;
  models: string[];
  group_name: string;
  headers: string;
  model_paths: string;
  priority: number;
  weight: number;
  status: number;
  disabled_by: string;
  status_reason: string;
  cooldown_until: string;
  response_time_ms: number;
  ttft_ms: number;
  used_count: number;
  last_error: string;
  last_test_at: string;
  // 账号级高级配置（可选：老记录缺字段时按默认值处理）。
  concurrency?: number;
  min_gap_ms?: number;
  max_per_min?: number;
  context_billing?: string;
  require_caller?: string;
  proxy_url?: string;
  tls_fingerprint?: string;
  namespace?: string;
  remark?: string;
  /*
    账号内的「上游模型名 → 真实模型 id」绑定。

    上游自造的别名（default-model / fast-model …）没有定价、也看不出
    是什么模型；绑定给它们身份。是账号级的 —— 同一个 default-model
    在 WorkBuddy 与别的上游是不同的模型。
  */
  model_bindings?: Record<string, string>;
}
interface Draft {
  name: string;
  vendor: string;
  connection: string;
  baseURL: string;
  apiKey: string;
  headers: string;
  modelPaths: string;
  models: string;
  groupName: string;
  priority: number;
  weight: number;
  concurrency: number;
  minGapMs: number;
  maxPerMin: number;
  contextBilling: string;
  requireCaller: string;
  proxyUrl: string;
  tlsFingerprint: string;
  namespace: string;
  remark: string;
}
const EMPTY: Draft = { name: "", vendor: "openai", connection: "api", baseURL: "https://api.openai.com/v1", apiKey: "", headers: "", modelPaths: "", models: "", groupName: "", priority: 0, weight: 1, concurrency: 0, minGapMs: 0, maxPerMin: 0, contextBilling: "auto", requireCaller: "", proxyUrl: "", tlsFingerprint: "", namespace: "", remark: "" };
const PAGE_SIZE = 20;
function formatTime(raw: string): string { return raw ? raw.replace("T", " ").slice(0, 19) : "—"; }
function statusOf(ch: Channel): { label: string; tone: "success" | "warning" | "danger" } {
  if (ch.status !== 1) return { label: ch.disabled_by === "manual" ? "手动禁用" : "已禁用", tone: "warning" };
  if (ch.cooldown_until && Date.parse(ch.cooldown_until) > Date.now()) return { label: "冷却中", tone: "warning" };
  return { label: "启用", tone: "success" };
}
function presetPatch(preset: ConnectionPreset) {
  return { connection: preset.id, baseURL: preset.baseURL, headers: preset.headers ?? "", modelPaths: preset.modelPaths ?? "" };
}
const DEVICE_METHODS = ["cli", "kiro", "workbuddy", "grok"] as const;
type DeviceMethod = (typeof DEVICE_METHODS)[number];
const DEVICE_VENDOR_BY_METHOD: Record<DeviceMethod, DeviceVendor> = { cli: "cline", kiro: "kiro", workbuddy: "workbuddy", grok: "grok" };
function isDeviceMethod(method: string | undefined): method is DeviceMethod {
  return (DEVICE_METHODS as readonly string[]).includes(method ?? "");
}
/**
 * 订阅登录方式（交互式 OAuth）。与设备授权一样属于「凭据由授权链路产出」的渠道，
 * 因此共享同一套表单行为（不给填密钥、地址由服务端推导、必须带票据创建）。
 */
const SUBSCRIPTION_METHODS = ["codex", "claude-oauth", "antigravity"] as const;
type SubscriptionMethod = (typeof SUBSCRIPTION_METHODS)[number];
function isSubscriptionMethod(method: string | undefined): method is SubscriptionMethod {
  return (SUBSCRIPTION_METHODS as readonly string[]).includes(method ?? "");
}
function deviceConnectionFor(vendor: string, method: DeviceMethod): ConnectionPreset | undefined {
  return providerFor(vendor)?.connections.find((c) => c.auth === "device" && c.id === method);
}
/** 设备登录面板自身的厂商 / 方式联合类型（由该面板维护；grok 随面板的对应改动落地）。 */
type DeviceLoginVendor = ComponentProps<typeof DeviceLoginPanel>["vendor"];
type DeviceLoginMethod = ComponentProps<typeof DeviceLoginPanel>["method"];

/** 计费口径选项：值与后端 contextBillingModes 一一对应。 */
const CONTEXT_BILLING_OPTIONS = [
  { value: "auto", label: "自动（按上游用量）" },
  { value: "full", label: "全额（输入+输出）" },
  { value: "input_only", label: "只计输入（输出不计费）" },
];
/** TLS 指纹选项：值与后端 services.ParseTLSProfile 的取值一一对应。 */
const TLS_FINGERPRINT_OPTIONS = [
  { value: "", label: "关闭（标准库默认）" },
  { value: "chrome", label: "Chrome" },
  { value: "firefox", label: "Firefox" },
  { value: "safari", label: "Safari" },
  { value: "edge", label: "Edge" },
  { value: "random", label: "随机轮转" },
  { value: "ios", label: "iOS Safari" },
  { value: "android", label: "Android Chrome" },
];

export default function AdminChannels() {
  const { can } = useAuth();
  const notify = useNotify();
  const saveGuard = useAsyncGuard();
  const fetchGuard = useAsyncGuard();
  const rowLocks = useRef(new Set<number>());
  const [busy, setBusy] = useState<Record<number, boolean>>({});
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [vendor, setVendor] = useState("");
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<SortState>({ key: "priority", direction: "desc" });
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Channel | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [providerQuery, setProviderQuery] = useState("");
  const [deviceTicket, setDeviceTicket] = useState("");
  const [deviceAuthorized, setDeviceAuthorized] = useState(false);
  const [groups, setGroups] = useState<{ name: string }[]>([]);
  const [modelsAccount, setModelsAccount] = useState<Channel | null>(null);
  const [confirmAccount, setConfirmAccount] = useState<{ account: Channel; type: "delete" | "disable" } | null>(null);
  const mayEdit = can(Perm.ChannelEdit);
  const mayDelete = can(Perm.ChannelDelete);

  /*
    另拉一份「真实模型目录 + 已配价/已映射的名字」用于绑定向导。

    与账号列表并行拉取：绑定向导要用它判断「这个模型名是不是上游自造的别名」，
    没有这份数据就只能等保存被后端拒绝，管理员还要自己猜是哪几个名字。
  */
  const loadCatalogHints = useCallback(async () => {
    try {
      const [real, catalog] = await Promise.all([
        apiRequest<{ items: { id: string; developer: string; label: string; input_price: number; output_price: number; verified: boolean }[] }>("/api/admin/models/real"),
        apiRequest<{ items: { model: string; priced: boolean }[] }>("/api/admin/models/catalog"),
      ]);
      setRealModels(real.items ?? []);
      const known = new Set<string>();
      for (const item of catalog.items ?? []) {
        if (item.priced) known.add(item.model.toLowerCase());
      }
      setKnownModels(known);
    } catch {
      /* 拉不到就退化为「不提示」：保存时后端仍会拦，不会静默放过 */
    }
  }, []);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const data = await apiRequest<{ items: Channel[] }>("/api/admin/channels");
      setChannels(data.items ?? []);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "加载账号失败");
    } finally { setLoading(false); }
  }, []);
  useEffect(() => {
    void load();
    void loadCatalogHints();
    void apiRequest<{ items: { name: string }[] }>("/api/groups").then((r) => setGroups(r.items));
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void load(true); }, 30_000);
    return () => window.clearInterval(timer);
  }, [load, loadCatalogHints]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return channels.filter((ch) => (!vendor || canonicalVendor(ch.vendor) === vendor) &&
      (!q || [ch.name, ch.base_url, ch.models.join(" "), vendorLabel(ch.vendor)].some((s) => s.toLowerCase().includes(q))));
  }, [channels, query, vendor]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const shownPage = Math.min(page, pageCount);
  const rows = useMemo(() => {
    const collator = new Intl.Collator("zh-CN", { numeric: true });
    const sorted = [...filtered].sort((a, b) => {
      const left = a[sort.key], right = b[sort.key];
      const result = typeof left === "number" && typeof right === "number" ? left - right : collator.compare(String(left ?? ""), String(right ?? ""));
      return (sort.direction === "asc" ? result : -result) || a.id - b.id;
    });
    return sorted.slice((shownPage - 1) * PAGE_SIZE, shownPage * PAGE_SIZE);
  }, [filtered, shownPage, sort]);
  const selectedProvider = providerFor(draft.vendor);
  const connections = selectedProvider?.connections ?? providerFor("custom")!.connections;
  const editingDeviceMethod = isDeviceMethod(editing?.method) ? editing.method : undefined;
  // 编辑设备账号时接入方式已锁定，因此只留当前那一项：单项就不必再让用户选。
  const connectionChoices = editingDeviceMethod
    ? connections.filter((c) => c.id === editingDeviceMethod)
    : connections;
  const selectedConnection = connections.find((c) => c.id === draft.connection);
  /** 模型标签：由逗号/换行分隔的草稿文本派生（保存格式不变）。 */
  const modelTags = useMemo(
    () => draft.models.split(/[\n,，]/).map((m) => m.trim()).filter(Boolean),
    [draft.models],
  );
  /**
   * 模糊搜索候选：只包含本次会话从上游拉取过的模型。
   * 平台侧没有全量模型目录，凭空造一份候选等于给用户假承诺；
   * 没拉取过时输入框仍可自由填写，回车原样添加。
   */
  const [modelSuggestions, setModelSuggestions] = useState<string[]>([]);
  /*
    真实模型目录（用于「绑定真实模型」向导）。

    账号拉到的模型清单里混着上游自造的别名（default-model / fast-model …），
    这些名字没有定价、会被按 0 计费，且后端在保存时会拒绝。
    所以在保存前就把它们找出来，逐条让管理员绑定 —— 而不是等保存失败再回头查。
  */
  const [realModels, setRealModels] = useState<{ id: string; developer: string; label: string; input_price: number; output_price: number; verified: boolean }[]>([]);
  // 已被系统认作真实模型（含上游等价写法）的名字，来自后端目录。
  const realModelIDs = useMemo(() => new Set(realModels.map((m) => m.id.toLowerCase())), [realModels]);
  /** 已在定价表或映射表里存在的名字：不需要绑定。 */
  const [knownModels, setKnownModels] = useState<Set<string>>(new Set());
  /** 别名 → 选中的真实模型 id（绑定向导的状态）。 */
  const [bindDraft, setBindDraft] = useState<Record<string, string>>({});
  /** 用户是否手动改过账号名：改过之后换厂商不再覆盖默认名。 */
  const nameTouched = useRef(false);
  /** 模型标签的多选模式与选中集合（批量删除用）。 */
  const [modelSelectMode, setModelSelectMode] = useState(false);
  const [selectedModels, setSelectedModels] = useState<string[]>([]);
  // 选中态随标签变化收敛：清空或删除后不留幽灵选中项
  const liveSelected = selectedModels.filter((m) => modelTags.includes(m));
  const allSelected = modelTags.length > 0 && liveSelected.length === modelTags.length;
  const isDeviceLogin = selectedConnection?.auth === "device" || Boolean(editingDeviceMethod);
  /*
    订阅账号：可选的是「预设里带 subscription 的那条」，或编辑一个已有的订阅渠道。
    与设备账号合并成 isLoginChannel —— 两者的表单行为完全一致
    （不给填密钥、地址服务端推导、创建时必须带授权票据），
    只有左栏挂的面板不同。
  */
  const editingSubscriptionMethod = isSubscriptionMethod(editing?.method) ? editing.method : undefined;
  const isSubscriptionLogin = selectedConnection?.auth === "subscription" || Boolean(editingSubscriptionMethod);
  const isLoginChannel = isDeviceLogin || isSubscriptionLogin;
  const activeSubscriptionConnection = (selectedConnection?.auth === "subscription" ? selectedConnection : undefined)
    ?? (editingSubscriptionMethod ? connections.find((c) => c.auth === "subscription" && c.id === editingSubscriptionMethod) : undefined);
  const subscriptionVendor = activeSubscriptionConnection?.subscriptionVendor;
  const subscriptionMethod: SubscriptionMethod | undefined = editingSubscriptionMethod
    ?? (isSubscriptionMethod(activeSubscriptionConnection?.id) ? activeSubscriptionConnection.id : undefined);
  const subscriptionPanelKey = `${subscriptionVendor ?? "sub"}:${subscriptionMethod ?? "unknown"}:${editing?.id ?? "new"}`;
  const activeDeviceConnection = (selectedConnection?.auth === "device" ? selectedConnection : undefined) ?? (editingDeviceMethod ? connections.find((c) => c.auth === "device" && c.id === editingDeviceMethod) : undefined);
  const deviceVendor = activeDeviceConnection?.deviceVendor ?? (editingDeviceMethod ? DEVICE_VENDOR_BY_METHOD[editingDeviceMethod] : undefined);
  const deviceMethod = (activeDeviceConnection && isDeviceMethod(activeDeviceConnection.id) ? activeDeviceConnection.id : undefined) ?? editingDeviceMethod;
  const devicePanelKey = `${deviceVendor ?? "device"}:${deviceMethod ?? "unknown"}:${editing?.id ?? "new"}`;
  /**
   * 支持的模型：设备账号在本次会话里尚未授权、且记录里也没有已存凭据时隐藏 ——
   * 没有凭据就没有可拉取/可填写的模型清单；授权完成或编辑已绑定账号后照常显示。
   */
  const showModels = !isLoginChannel || deviceAuthorized || Boolean(editing?.has_credential);
  /*
    当前草稿里「还没绑定真实模型」的别名。

    判定与后端一致：不在真实模型目录（含等价写法）里、也不在已配价名单里、
    并且**没有在这个账号里被绑定过**。

    账号级绑定的两处来源都要算已绑定：
      · bindDraft（本次会话刚选的）；
      · editing.model_bindings（该账号已存的绑定，编辑时回填）。
    少算任一处都会出现「明明绑了还提示未绑定」。

    真实模型目录空着（接口失败）时不做判定 —— 宁可漏提示，
    也不要因为拉不到目录就把正常模型误标成别名。
  */
  const unboundAliases = useMemo(() => {
    if (realModels.length === 0) return [] as string[];
    return modelTags.filter((tag) => {
      const key = tag.toLowerCase();
      if (realModelIDs.has(key) || knownModels.has(key)) return false;
      // 本账号已经绑过（本次选的或记录里存的）→ 不算未绑定。
      if (bindDraft[tag] || bindDraft[key]) return false;
      if (editing?.model_bindings?.[key]) return false;
      return true;
    });
  }, [modelTags, realModelIDs, knownModels, realModels.length, bindDraft, editing]);
  const providerChoices = UPSTREAM_PROVIDERS.filter((p) => vendorLabel(p.key).toLowerCase().includes(providerQuery.toLowerCase()));
  const vendorOptions = [{ value: "", label: "全部厂商 / 平台" }, ...UPSTREAM_PROVIDERS.map((p) => ({ value: p.key, label: vendorLabel(p.key), icon: <VendorMark vendor={p.key} /> }))];

  /**
   * 默认账号名：`厂商 + 接入方式`，同厂商多账号时追加序号（OpenCode Go 账号 2）。
   *
   * 新建时先填一个能用的名字，用户想改就地改；不起名也能直接保存，
   * 省掉「每次都要手打一个名字」这一步。用户自己改过之后不再覆盖。
   */
  function defaultAccountName(vendorKey: string, connectionId: string): string {
    /*
      接入方式的人话后缀。

      直接把 connection id 大写拼上去会得到「Anthropic / Claude CLAUDE-OAUTH 账号」
      这类名字 —— 变量名当展示名，既不美观也不一定看得懂（cli / responses 同理）。
      表里没写的才退回大写 id。
    */
    const suffix: Record<string, string> = {
      cli: "CLI",
      responses: "Responses",
      codex: "Codex 订阅",
      "claude-oauth": "Claude 订阅",
      antigravity: "Google 订阅",
      kiro: "Kiro",
      workbuddy: "WorkBuddy",
      grok: "Grok",
    };
    let tag = connectionId && connectionId !== "api" ? suffix[connectionId] ?? connectionId.toUpperCase() : "";
    // 厂商名里已经含有的词不再重复（否则会出现「Anthropic / Claude Claude 订阅 账号」）。
    const vendorName = vendorLabel(vendorKey);
    if (tag && vendorName.toLowerCase().includes(tag.split(" ")[0].toLowerCase())) {
      tag = tag.split(" ").slice(1).join(" ");
    }
    const base = `${vendorName}${tag ? " " + tag : ""} 账号`;
    const taken = new Set(channels.map((ch) => ch.name));
    if (!taken.has(base)) return base;
    for (let i = 2; i < 100; i++) {
      const candidate = `${base} ${i}`;
      if (!taken.has(candidate)) return candidate;
    }
    return base;
  }

  function openCreate() {
    setDeviceTicket(""); setDeviceAuthorized(false); setEditing(null);
    nameTouched.current = false;
    const preset = providerFor(EMPTY.vendor)?.connections[0];
    setDraft({ ...EMPTY, name: defaultAccountName(EMPTY.vendor, preset?.id ?? "api") });
    setProviderQuery(""); setOpen(true);
  }
  function openEdit(ch: Channel) {
    const preset = isDeviceMethod(ch.method) ? deviceConnectionFor(ch.vendor, ch.method) : connectionFor(ch.vendor, ch.base_url);
    setDeviceTicket(""); setDeviceAuthorized(false); setEditing(ch);
    // 编辑已有账号：名字来自记录本身，不该被默认名覆盖
    nameTouched.current = true;
    setProviderQuery("");
    setDraft({
      name: ch.name, vendor: canonicalVendor(ch.vendor), connection: preset?.id ?? "existing", baseURL: ch.base_url, apiKey: "", headers: ch.headers ?? "", modelPaths: ch.model_paths ?? "", models: ch.models.join(", "), groupName: ch.group_name, priority: ch.priority, weight: ch.weight,
      concurrency: ch.concurrency ?? 0,
      minGapMs: ch.min_gap_ms ?? 0,
      maxPerMin: ch.max_per_min ?? 0,
      contextBilling: ch.context_billing || "auto",
      requireCaller: ch.require_caller ?? "",
      proxyUrl: ch.proxy_url ?? "",
      tlsFingerprint: ch.tls_fingerprint ?? "",
      namespace: ch.namespace ?? "",
      remark: ch.remark ?? "",
    });
    /*
      回填已存绑定：编辑账号时要能看到「这个别名已经绑到哪个模型了」，
      否则用户会以为没绑过而重复选择。

      已绑定的别名本来就不在 unboundAliases 里（判定为「已处理」），
      回填它是为了下面「重新选择」时不丢已有配置。
    */
    setBindDraft(ch.model_bindings ?? {});
    setOpen(true);
  }
  function selectProvider(key: string) {
    if (saveGuard.busy) return;
    setDeviceTicket(""); setDeviceAuthorized(false);
    const options = providerFor(key)!.connections;
    const preset = options.find((c) => !c.disabled) ?? options[0];
    setDraft((d) => ({
      ...d,
      vendor: key,
      ...presetPatch(preset),
      // 换厂商时同步更新默认名（用户手动改过就尊重用户的输入）
      name: !editing && !nameTouched.current ? defaultAccountName(key, preset.id) : d.name,
    }));
  }
  /*
    真实模型下拉的选项：**按厂商分组**。

    目录里有 46 个模型、16 个厂商，平铺成一长串很难找；按厂商分组之后
    「先想厂商、再挑型号」的直觉能直接用上，配合搜索（MorphSelect 的
    searchable）两条路都能快速定位。

    组内按 id 排序（稳定顺序）；组之间按模型数量降序，常用的厂商排前面。
  */
  const realModelGroups = useMemo(() => {
    const byDeveloper = new Map<string, typeof realModels>();
    for (const model of realModels) {
      const list = byDeveloper.get(model.developer) ?? [];
      list.push(model);
      byDeveloper.set(model.developer, list);
    }
    return [...byDeveloper.entries()]
      .map(([developer, models]) => ({
        label: developer,
        options: models
          .slice()
          .sort((a, b) => a.id.localeCompare(b.id))
          .map((model) => ({
            value: model.id,
            label:
              model.label +
              " · " +
              (model.input_price || 0) +
              "/" +
              (model.output_price || 0),
          })),
      }))
      .sort((a, b) => b.options.length - a.options.length || a.label.localeCompare(b.label));
  }, [realModels]);

  /*
    把选好的绑定合并进草稿（保存时一并提交）。

    只收集当前**还显示在绑定区**的别名：已绑定的不在 unboundAliases 里，
    它们已经存在于编辑态回填的 bindDraft 中。这里要以回填值为基础合并，
    不能只取 unboundAliases —— 否则「编辑一个已有绑定的账号时不碰绑定区」
    会把原有绑定清空。
  */
  function collectBindings(): Record<string, string> {
    const out: Record<string, string> = { ...bindDraft };
    // 清掉选了随后又把模型标签删掉的残留项（别名已不在账号的模型清单里）。
    for (const alias of Object.keys(out)) {
      if (!modelTags.some((tag) => tag.toLowerCase() === alias.toLowerCase())) {
        delete out[alias];
      }
    }
    return out;
  }

  async function save() {
    if (!mayEdit || selectedConnection?.disabled || !saveGuard.acquire()) return;
    if (!draft.name.trim() || !draft.baseURL.trim() || (!editing && (isLoginChannel ? !deviceTicket : !draft.apiKey.trim()))) {
      notify.warning(isLoginChannel ? "请填写名称并完成官方账号授权" : "请填写名称、接口地址和上游密钥"); saveGuard.release(); return;
    }
    if (!modelTags.length) {
      notify.warning("请至少添加一个支持的模型", "可点「从上游获取模型列表」一键拉取"); saveGuard.release(); return;
    }
    /*
      未绑定真实模型的别名不许保存。

      上游自造的别名（default-model / fast-model …）没有对应定价，
      会被按 0 计费（免费）；用户也看不懂它到底是什么模型。
      后端同样会拒绝，这里先拦一道是为了给出「怎么办」而不只是「不行」。

      判定用 draftBindings：已经在上面的绑定区选好的别名不算未绑定，
      否则用户明明选完了还会被拦（选了却没保存的状态必须算「已处理」）。
    */
    const draftBindings = collectBindings();
    const stillUnbound = unboundAliases.filter((alias) => !draftBindings[alias]);
    if (stillUnbound.length > 0) {
      notify.warning(
        "还有 " + stillUnbound.length + " 个模型未绑定真实模型",
        "请在下方「需要绑定真实模型」里逐个选择（未绑定的模型会被按 0 计费）",
      );
      saveGuard.release();
      return;
    }
    if (isDeviceLogin && !deviceMethod) {
      notify.warning("无法识别该账号的授权方式，请重新选择接入方式"); saveGuard.release(); return;
    }
    if (isSubscriptionLogin && !subscriptionMethod) {
      notify.warning("无法识别该账号的授权方式，请重新选择接入方式"); saveGuard.release(); return;
    }
    try {
      await apiRequest<{ id: number }>(editing ? `/api/admin/channels/${editing.id}` : "/api/admin/channels", {
        method: editing ? "PUT" : "POST",
        body: {
          method: isDeviceLogin ? deviceMethod : isSubscriptionLogin ? subscriptionMethod : "api",
          // 授权票据：新建时是创建凭据的必需品；编辑订阅账号时它是「重新授权」的凭据载体。
          ...(((!editing && isLoginChannel) || (editing && isSubscriptionLogin)) && deviceTicket ? { ticket: deviceTicket } : {}),
          name: draft.name.trim(),
          // 设备账号的厂商取授权链路名（Grok 的渠道厂商是 grok，与预设 key「xai」不同）；
          // 订阅账号由服务端按接入方式推导厂商（codex→openai / claude-oauth→anthropic /
          // antigravity→gemini），前端传预设厂商即可。
          vendor: isDeviceLogin ? (deviceVendor ?? draft.vendor) : draft.vendor,
          base_url: draft.baseURL.trim(),
          api_key: isLoginChannel ? "" : draft.apiKey.trim(),
          headers: draft.headers,
          model_paths: isLoginChannel ? "" : draft.modelPaths,
          // 账号级绑定：把上面选好的「别名 → 真实模型」一并提交（空对象 = 清空绑定）。
          // 定价与能力参数由服务端按真实模型 id 写入（全局共用一份）。
          model_bindings: draftBindings,
          models: draft.models.split(/[\n,，]/).map((s) => s.trim()).filter(Boolean),
          group_name: draft.groupName,
          priority: draft.priority,
          weight: draft.weight,
          // 高级配置：0 / 空串都是真实取值（0 = 不限，空串 = 清空），不因「看起来没填」而省略。
          concurrency: draft.concurrency,
          min_gap_ms: draft.minGapMs,
          max_per_min: draft.maxPerMin,
          context_billing: draft.contextBilling,
          require_caller: draft.requireCaller,
          proxy_url: draft.proxyUrl,
          tls_fingerprint: draft.tlsFingerprint,
          namespace: draft.namespace,
          remark: draft.remark,
        },
      });
      notify.success(editing ? "账号已更新" : "账号已创建");
      setOpen(false); await load(true);
    } catch (err) { notify.error("保存账号失败", err instanceof Error ? err.message : undefined); }
    finally { saveGuard.release(); }
  }

  /**
   * 授权成功后自动补全模型清单（票据还没被消费，可以直接用）。
   *
   * 与「从上游获取模型列表」的区别只在凭据来源：这里用一次性票据里的加密凭据
   * （账号可能还没落库），失败静默 —— 用户刚在官方页面点完授权，
   * 一个红字报错会让人以为授权没成功；想手动重试的话拉取链接仍在。
   */
  async function autoFetchModels(ticket: string) {
    try {
      const r = await apiRequest<{ models: string[]; count: number }>(
        isSubscriptionLogin ? "/api/admin/channels/devices/login/models" : "/api/admin/channels/devices/models",
        { method: "POST", body: isSubscriptionLogin ? { ticket } : { ticket, vendor: deviceVendor ?? draft.vendor } },
      );
      if (!r.models?.length) return;
      setDraft((d) => ({ ...d, models: r.models.join("\n") }));
      setModelSuggestions(r.models);
      notify.success(`已自动填入 ${r.count} 个模型`, "可在下方核对");
    } catch {
      /* 静默：失败时用户仍可手动点「从上游获取模型列表」 */
    }
  }
  function lockRow(id: number) {
    if (rowLocks.current.has(id)) return false;
    rowLocks.current.add(id); setBusy((prev) => ({ ...prev, [id]: true })); return true;
  }
  function unlockRow(id: number) {
    rowLocks.current.delete(id); setBusy((prev) => ({ ...prev, [id]: false }));
  }
  async function test(ch: Channel) {
    if (!mayEdit || !lockRow(ch.id)) return;
    try {
      const r = await apiRequest<{ ttft_ms: number; total_ms: number; success: boolean; reply: string }>(`/api/admin/channels/${ch.id}/test`, { method: "POST" });
      if (!r.success) throw new Error("上游测试未通过");
      notify.success(`「${ch.name}」连通正常`, `首 Token ${r.ttft_ms}ms · 总耗时 ${r.total_ms}ms`);
    } catch (err) { notify.error(`「${ch.name}」测试失败`, err instanceof Error ? err.message : undefined); }
    finally { unlockRow(ch.id); await load(true); }
  }
  /**
   * 从上游拉取模型列表。
   *
   * 三条凭据来源：票据（设备账号刚授权、还没落库）→ 渠道 id（已落库的设备账号）
   * → base_url + api_key（API 账号，含未落库的新建）。
   * quiet 用于「授权完成后自动拉取」：失败不弹错误提示 ——
   * 用户刚在官方页面点完授权，一个红字报错会让人以为授权没成功。
   * 手动点击时仍然如实报错。
   */
  async function fetchModels(quiet = false) {
    if (!mayEdit || !fetchGuard.acquire()) return;
    try {
      /*
        凭据来源三选一（顺序即优先级）：
          1. 本次刚授权的票据（新建，或编辑时的重新授权）—— 凭据最新且账号可能还没落库；
          2. 库里已存的渠道 id —— 设备授权与订阅账号都走这条路；
          3. base_url + api_key —— 普通 API 账号（含未落库的新建）。
      */
      const ticketKind = isSubscriptionLogin ? "login" : isDeviceLogin ? "device" : "";
      const useTicket = Boolean(ticketKind) && Boolean(deviceTicket) && (!editing || isSubscriptionLogin);
      let r: { models: string[]; count: number };
      if (useTicket) {
        r = await apiRequest<{ models: string[]; count: number }>(
          isSubscriptionLogin ? "/api/admin/channels/devices/login/models" : "/api/admin/channels/devices/models",
          { method: "POST", body: isSubscriptionLogin ? { ticket: deviceTicket } : { ticket: deviceTicket, vendor: deviceVendor ?? draft.vendor } },
        );
      } else {
        r = await apiRequest<{ models: string[]; count: number }>("/api/admin/channels/fetch-models", {
          method: "POST",
          body: isLoginChannel
            ? { id: editing?.id ?? 0, base_url: "", api_key: "", headers: draft.headers }
            : { id: editing?.id ?? 0, base_url: draft.baseURL.trim(), api_key: draft.apiKey.trim(), headers: draft.headers },
        });
      }
      setDraft((d) => ({ ...d, models: r.models.join("\n") }));
      // 拉到的清单同时作为模糊搜索候选：之后增删模型不用再敲全名。
      setModelSuggestions(r.models ?? []);
      if (!quiet) notify.success(`已获取 ${r.count} 个模型`, "请核对模型范围后保存");
    } catch (err) {
      if (!quiet) notify.error("获取模型失败", err instanceof ApiRequestError ? err.message : undefined);
    } finally { fetchGuard.release(); }
  }
  async function toggle(ch: Channel) {
    if (!mayEdit || !lockRow(ch.id)) return;
    try {
      await apiRequest(`/api/admin/channels/${ch.id}`, { method: "PUT", body: { status: ch.status === 1 ? 0 : 1 } });
      notify.success(ch.status === 1 ? `已禁用「${ch.name}」` : `已启用「${ch.name}」`); setConfirmAccount(null); await load(true);
    } catch (err) { notify.error("修改账号状态失败", err instanceof Error ? err.message : undefined); }
    finally { unlockRow(ch.id); }
  }
  async function remove(ch: Channel) {
    if (!mayDelete || !lockRow(ch.id)) return;
    try {
      await apiRequest(`/api/admin/channels/${ch.id}`, { method: "DELETE" });
      setChannels((prev) => prev.filter((row) => row.id !== ch.id)); setConfirmAccount(null); notify.success(`已删除账号「${ch.name}」`);
    } catch (err) { notify.error("删除账号失败", err instanceof Error ? err.message : undefined); }
    finally { unlockRow(ch.id); }
  }

  const columns: DataColumn<Channel>[] = [
    { key: "id", label: "ID", sortable: true, width: 55 },
    { key: "name", label: "账号", sortable: true, width: 190, render: (_, ch) => <div className={styles.identity}><VendorMark vendor={ch.vendor} /><div><strong>{ch.name}</strong><span>{vendorLabel(ch.vendor)}</span><span className={styles.endpoint} title={ch.base_url}>{ch.base_url}</span></div></div> },
    { key: "models", label: "模型", sortable: false, width: 205, render: (_, ch) => <button className={styles.modelList} type="button" aria-label={`查看「${ch.name}」全部模型`} onClick={() => setModelsAccount(ch)}>{ch.models.length ? <>{ch.models.slice(0, 2).map((m) => <ModelMark key={m} model={m} fallback={ch.vendor} />)}{ch.models.length > 2 && <Badge size="sm" tone="neutral">+{ch.models.length - 2}</Badge>}</> : <span className={styles.muted}>未限定模型</span>}</button> },
    { key: "status", label: "状态", width: 90, render: (_, ch) => { const state = statusOf(ch); return <div className={styles.stack}><Badge size="sm" tone={state.tone}>{state.label}</Badge>{ch.cooldown_until && Date.parse(ch.cooldown_until) > Date.now() && <small title={formatTime(ch.cooldown_until)}>{formatTime(ch.cooldown_until).slice(11, 16)} 恢复</small>}</div>; } },
    { key: "group_name", label: "分组", sortable: true, width: 90, render: (_, ch) => ch.group_name || "所有分组" },
    { key: "priority", label: "调度", sortable: true, width: 88, render: (_, ch) => <div className={styles.stack}><span>优先级 {ch.priority}</span><small>权重 {ch.weight}</small></div> },
    { key: "used_count", label: "调用", sortable: true, numeric: true, width: 76 },
    { key: "response_time_ms", label: "响应", sortable: true, width: 120, render: (_, ch) => <div className={styles.stack}><span>{ch.ttft_ms ? `${ch.ttft_ms} ms` : "未测试"}</span><small title={formatTime(ch.last_test_at)}>{ch.last_test_at ? formatTime(ch.last_test_at).slice(5, 16) : "—"}</small><span className={styles.credential}>{ch.has_credential ? "账号已绑定" : ch.has_key ? ch.key_hint : "未配置凭据"}</span></div> },
    { key: "actions", label: "操作", sortable: false, width: 185, render: (_, ch) => <div className={styles.rowActions}>{mayEdit && <><Button size="sm" variant="secondary" loading={busy[ch.id]} disabled={busy[ch.id]} onClick={() => void test(ch)}>测试</Button><Button size="sm" variant="ghost" disabled={busy[ch.id]} onClick={() => openEdit(ch)}>编辑</Button><Button size="sm" variant="ghost" disabled={busy[ch.id]} onClick={() => ch.status === 1 ? setConfirmAccount({ account: ch, type: "disable" }) : void toggle(ch)}>{ch.status === 1 ? "禁用" : "启用"}</Button></>}{mayDelete && <Button size="sm" variant="ghost" disabled={busy[ch.id]} onClick={() => setConfirmAccount({ account: ch, type: "delete" })}>删除</Button>}{(ch.last_error || ch.status_reason) && <div className={styles.rowError}><Accordion size="sm" defaultOpen={-1} items={[{ title: "异常详情", content: <p className={styles.rowErrorText}>{ch.status_reason} {ch.last_error}</p> }]} /></div>}</div> },
  ];

  /*
    分组 / 优先级 / 权重。

    两条路径（设备授权账号、普通 API 账号）共用同一块，避免以后改一处漏一处。
    外观是「带边框的分组卡片 + 行间分隔线 + 值靠右」：
    标签在左、控件贴右缘，行与行之间用一条细分隔线断开。
  */
  const groupOptions = [{ value: "", label: "所有分组" }, ...groups.map((g) => ({ value: g.name, label: g.name }))];
  const configGroup = (
    <div className={styles.configGroup}>
      <div className={styles.configRow}>
        <span className={styles.configLabel}>所属分组</span>
        <MorphSelect
          hideLabel
          label="所属分组"
          items={groupOptions}
          value={draft.groupName}
          onValueChange={(groupName) => setDraft((d) => ({ ...d, groupName }))}
          searchable="auto"
          searchPlaceholder="搜索分组"
          panelWidth={240}
          align="end"
        />
      </div>
      <div className={styles.configRow}>
        <span className={styles.configLabel}>优先级</span>
        <NumberField hideLabel label="优先级" size="sm" value={draft.priority} min={0} max={9999} limitHint={false} onValueChange={(priority) => setDraft((d) => ({ ...d, priority }))} />
      </div>
      <div className={styles.configRow}>
        <span className={styles.configLabel}>权重</span>
        <NumberField hideLabel label="权重" size="sm" value={draft.weight} min={1} max={100} limitHint={false} onValueChange={(weight) => setDraft((d) => ({ ...d, weight }))} />
      </div>
      {/* 限流三项与调度三项同属「这个账号怎么被调度」，放同一张卡片，
          0 都是合法值（不限），与上面两项共用同一套行式布局。 */}
      <div className={styles.configRow}>
        <span className={styles.configLabel}>并发上限</span>
        <NumberField hideLabel label="并发上限" size="sm" value={draft.concurrency} min={0} max={1000} limitHint={false} onValueChange={(concurrency) => setDraft((d) => ({ ...d, concurrency }))} />
      </div>
      <div className={styles.configRow}>
        <span className={styles.configLabel}>最小间隔</span>
        <NumberField hideLabel label="最小间隔" size="sm" suffix=" ms" value={draft.minGapMs} min={0} max={600000} limitHint={false} onValueChange={(minGapMs) => setDraft((d) => ({ ...d, minGapMs }))} />
      </div>
      <div className={styles.configRow}>
        <span className={styles.configLabel}>每分钟上限</span>
        <NumberField hideLabel label="每分钟上限" size="sm" value={draft.maxPerMin} min={0} max={100000} limitHint={false} onValueChange={(maxPerMin) => setDraft((d) => ({ ...d, maxPerMin }))} />
      </div>
    </div>
  );

  return <AdminLayout crumbs={[{ label: "后台", href: "/admin" }, { label: "账号管理" }]} actions={mayEdit && <Button size="sm" onClick={openCreate}>添加账号</Button>}>
    <div className={styles.page}>
      <h1 className={styles.title}>账号管理</h1>
      <div className={styles.toolbar}>
        <SearchField label="搜索账号" placeholder="名称、接口地址或模型" value={query} onValueChange={(value) => { setQuery(value); setPage(1); }} />
        <Select label="厂商 / 平台" value={vendor} options={vendorOptions} onValueChange={(value) => { setVendor(value); setPage(1); }} />
        <Button variant="secondary" size="sm" loading={loading} onClick={() => void load()}><RefreshCw size={14} />刷新</Button>
        <span className={styles.total}>共 {filtered.length} 个账号</span>
      </div>
      {loadError && <p className={styles.err} role="alert">{loadError}</p>}
      {loading && !channels.length ? <p className={styles.loading}>正在加载账号…</p> : <div className={styles.table}><SortableDataTable<Channel> rows={rows} columns={columns} rowKey="id" caption="上游账号列表" emptyMessage={channels.length ? "没有匹配的账号" : "尚未添加上游账号"} defaultSort={{ key: "priority", direction: "desc" }} onSortChange={(next) => { setSort(next); setPage(1); }} itemName={{ one: "个账号", other: "个账号" }} /></div>}
      <div className={styles.pagination}><span>每页 {PAGE_SIZE} 条</span><Pagination page={shownPage} pageCount={pageCount} onPageChange={setPage} label="账号分页" /></div>
    </div>

    <Dialog open={open} onOpenChange={(value) => { if (!saveGuard.busy && !fetchGuard.busy) setOpen(value); }}>
      <DialogContent className={styles.wideDialog} bodyClassName={styles.dialogBody} title={editing ? "编辑账号" : "添加账号"}>
        <div className={styles.editor}>
          <aside className={styles.providerPicker} aria-label="选择上游厂商">
            <SearchField label="查找厂商或平台" value={providerQuery} onValueChange={setProviderQuery} placeholder="搜索厂商" />
            
            <ScrollArea className={styles.providerScroll} label="厂商列表" fade={12}><div className={styles.providers}>{providerChoices.map((p) => <Button key={p.key} size="sm" variant={draft.vendor === p.key ? "secondary" : "ghost"} aria-pressed={draft.vendor === p.key} disabled={saveGuard.busy || Boolean(editingDeviceMethod)} onClick={() => selectProvider(p.key)}><VendorMark vendor={p.key} label /></Button>)}{!providerChoices.length && <p className={styles.muted}>没有匹配的厂商</p>}</div></ScrollArea>
          </aside>
          <ScrollArea className={styles.formScroll} viewportClassName={styles.form} label="账号配置" fade={12}>
            <fieldset disabled={saveGuard.busy}>
              {/* 账号名就地编辑：这里是弹窗的第一行，替代原来的「厂商名 + 账号名称输入框」两行。
                  厂商名不必在右侧再写一遍 —— 左侧选中态已经显示了是哪一个；
                  但厂商图标要留着，它是这一行最直接的身份提示。 */}
              <div className={styles.nameRow}>
                <VendorMark vendor={draft.vendor} />
                <InlineEdit
                  value={draft.name}
                  label="账号名称"
                  placeholder="用于区分同厂商的多个账号"
                  variant="title"
                  as="h3"
                  validate={(next) => (next.trim() ? null : "账号名称不能为空")}
                  onSave={(next) => {
                    nameTouched.current = true;
                    setDraft((d) => ({ ...d, name: next.trim() }));
                  }}
                />
              </div>
              {/* 接入方式：多个选项用 Tabs，只有一个时不占地方（省掉一行控件）。
                  设备授权的地址由服务端推导，编辑已有设备账号时也不允许更换。 */}
              {connectionChoices.length > 1 && (
                <div className={styles.connectionTabs}>
                  <span className={styles.fieldLabel}>接入方式</span>
                  <Tabs value={draft.connection} onValueChange={(id) => {
                    setDeviceTicket(""); setDeviceAuthorized(false);
                    const preset = connections.find((c) => c.id === id);
                    if (!preset || preset.disabled) return;
                    /*
                      切接入方式时同步刷新默认名（「Claude 订阅 账号」而不是停在
                      「Anthropic / Claude MESSAGES 账号」）—— 前提同样是用户没手改过。
                      渠道类型变了名字还留着上一种的说法，是纯粹的误导。
                    */
                    setDraft((d) => ({
                      ...d,
                      ...presetPatch(preset),
                      name: !editing && !nameTouched.current ? defaultAccountName(draft.vendor, preset.id) : d.name,
                    }));
                  }}>
                    <TabsList aria-label="接入方式">
                      {connectionChoices.map((c) => <TabsTrigger key={c.id} value={c.id} disabled={c.disabled}>{c.label}</TabsTrigger>)}
                    </TabsList>
                  </Tabs>
                </div>
              )}
              {selectedConnection?.hint && <p className={styles.hint}>{selectedConnection.hint}</p>}
              {/* 设备授权的接口地址由服务端按凭据推导，用户改不了 —— 与其显示一个
                  永远置灰的输入框，不如不显示（下面 DeviceLoginPanel 会说明去向）。 */}
              {isLoginChannel ? (
                /*
                  设备账号：左 40% 是授权状态（渐变面板），右 60% 是分组/优先级/权重等配置。
                  授权状态是「这个账号能不能用」的答案，占独立一栏比塞在表单流里更醒目；
                  配置项留在右侧用行式控件（标签在左、控件在右），与左栏形成清楚的分工。
                */
                <div className={styles.deviceSplit}>
                  <div className={styles.deviceAside}>
                    {isSubscriptionLogin ? (subscriptionVendor && subscriptionMethod ? <SubscriptionLoginPanel
                      key={subscriptionPanelKey}
                      vendor={subscriptionVendor as SubscriptionVendor}
                      channelId={editingSubscriptionMethod && editing ? editing.id : undefined}
                      authorized={deviceAuthorized}
                      bound={Boolean(editingSubscriptionMethod && editing?.has_credential) && !deviceAuthorized}
                      disabled={saveGuard.busy}
                      onAuthorized={(ticket) => {
                        /*
                          订阅登录是一次性的：凭据句柄换回来就立即用它拉模型
                          （账号可能还没落库），保存时服务端再消费同一个句柄
                          把凭据写进渠道。编辑已有账号时，句柄在 PUT 时用于重新授权。
                        */
                        setDeviceTicket(ticket);
                        setDeviceAuthorized(true);
                        if (ticket) void autoFetchModels(ticket);
                        if (editing) void load(true);
                      }}
                    /> : <p className={styles.hint}>请选择上方的接入方式以继续一键登录。</p>) : deviceVendor && deviceMethod ? <DeviceLoginPanel
                      key={devicePanelKey}
                      // deviceVendor 来自预设（含 "grok"）；面板类型可能仍停在 cline/kiro/workbuddy，
                      // 断言桥接，等面板自身加入 grok 后类型自然覆盖。
                      vendor={deviceVendor as DeviceLoginVendor}
                      method={deviceMethod as DeviceLoginMethod}
                      channelId={editingDeviceMethod && editing ? editing.id : undefined}
                      authorized={deviceAuthorized}
                      bound={Boolean(editingDeviceMethod && editing?.has_credential) && !deviceAuthorized}
                      disabled={saveGuard.busy}
                      onAuthorized={(ticket) => {
                        setDeviceTicket(ticket ?? "");
                        setDeviceAuthorized(true);
                        /*
                          授权成功即自动拉取全部模型（模型是保存的必需项，
                          让用户先存空账号再回头点「获取模型」会死锁在保存按钮上）。

                          两条路径按票据是否还在区分：
                          - 新建：票据未被消费，用票据里的凭据拉（账号还没落库）；
                          - 编辑：服务端在轮询时已把票据写入渠道并清空，
                            改按渠道 id 拉（此时库里已是新凭据）。
                        */
                        if (ticket) void autoFetchModels(ticket);
                        else if (editing) void fetchModels(true);
                        if (editing) void load(true);
                      }}
                    /> : <p className={styles.hint}>请选择上方的接入方式以继续一键登录。</p>}
                  </div>
                  {configGroup}
                </div>
              ) : (
                <>
                  {/* 接口地址与上游密钥同属「连到哪、用什么身份」的一组，
                      收进一张卡片（与下面「所属分组」那张同一种视觉语言：
                      标签在左、控件贴右、行间分隔线）。 */}
                  <div className={styles.configGroup}>
                    <div className={styles.configRow}>
                      <span className={styles.configLabel}>接口地址</span>
                      <div className={styles.rowText}>
                        <Input label="接口地址" value={draft.baseURL} onChange={(e) => setDraft({ ...draft, baseURL: e.target.value })} placeholder="https://example.com/v1" description="不包含末尾的 /chat/completions、/messages 或 /responses；仅允许公网地址。" />
                      </div>
                    </div>
                    <div className={styles.configRow}>
                      <span className={styles.configLabel}>上游 API 密钥</span>
                      <div className={styles.rowText}>
                        <Input label="上游 API 密钥" type="password" value={draft.apiKey} onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })} placeholder={editing?.has_key ? `留空保留现有密钥（${editing.key_hint}）` : "填写服务的 API 密钥"} description="填写 API 服务密钥；不要粘贴账号密码或 OAuth JSON。" />
                      </div>
                    </div>
                  </div>
                  {configGroup}
                </>
              )}
              {/* 支持的模型：一个模型一个标签，带品牌图标；输入时模糊搜索，回车取第一条匹配。
                  设备账号在本次会话内尚未授权、且没有已存凭据时不显示（showModels）。 */}
              {showModels && <div className={styles.modelsField}>
                <div className={styles.modelsHead}>
                  <span className={styles.fieldLabel}>支持的模型</span>
                  {/* 拉取链接紧跟在标题后面（它是标题的补充动作），批量操作放最右侧。
                      设备账号有两条凭据来源：新建时用刚授权的票据，编辑时用库里的 id。 */}
                  <button
                    type="button"
                    className={styles.linkAction}
                    disabled={fetchGuard.busy || saveGuard.busy || selectedConnection?.disabled || (isLoginChannel && !(editing && editing.id > 0) && !deviceTicket)}
                    onClick={() => void fetchModels()}
                  >
                    {fetchGuard.busy ? "获取中…" : "从上游获取模型列表"}
                  </button>
                  <span className={styles.modelsSpacer} />
                  {/* 快捷操作：列表为空时整组不显示（没有可操作的对象） */}
                  {modelTags.length > 0 && (
                    <div className={styles.modelsTools}>
                      <button
                        type="button"
                        className={styles.toolAction}
                        data-active={modelSelectMode || undefined}
                        onClick={() => { setModelSelectMode((on) => !on); setSelectedModels([]); }}
                      >
                        {modelSelectMode ? "取消多选" : "多选"}
                      </button>
                      {modelSelectMode && (
                        <button
                          type="button"
                          className={styles.toolAction}
                          onClick={() => setSelectedModels(allSelected ? [] : [...modelTags])}
                        >
                          {allSelected ? "取消全选" : "全选"}
                        </button>
                      )}
                      {modelSelectMode && selectedModels.length > 0 && (
                        <button
                          type="button"
                          className={`${styles.toolAction} ${styles.toolDanger}`}
                          onClick={() => {
                            const keep = modelTags.filter((m) => !liveSelected.includes(m));
                            setDraft((d) => ({ ...d, models: keep.join("\n") }));
                            setSelectedModels([]);
                          }}
                        >
                          删除选中 {liveSelected.length}
                        </button>
                      )}
                      <button
                        type="button"
                        className={styles.toolAction}
                        onClick={() => { setDraft((d) => ({ ...d, models: "" })); setSelectedModels([]); setModelSelectMode(false); }}
                      >
                        清空
                      </button>
                    </div>
                  )}
                </div>
                <TagInput
                  label=""
                  value={modelTags}
                  onValueChange={(next) => setDraft((d) => ({ ...d, models: next.join("\n") }))}
                  placeholder="输入模型名，回车添加；支持模糊匹配"
                  suggestions={modelSuggestions}
                  selectable={modelSelectMode}
                  selectedTags={liveSelected}
                  onSelectedTagsChange={setSelectedModels}
                  renderTag={(tag) => <ModelMark model={tag} fallback={draft.vendor} />}
                />
                {/* 保存的前置条件提示贴在输入框下方：它讲的就是这个字段的问题，
                    放到弹窗底部的按钮旁边会与所指的对象脱节，用户看到红字却不知道
                    在说哪里。 */}
                {modelTags.length === 0 && (
                  <p className={styles.modelsHint}>至少添加一个支持的模型后才能保存</p>
                )}
              </div>}
              {/*
                模型绑定：把上游自造的别名（default-model / fast-model …）
                对应到真实模型。

                布局：整行全宽，左栏是上游模型名、右栏直接选真实模型，
                一列一行 —— 别名与目标之间的对应关系一眼可读，
                不需要在窄下拉里横向挤着看（那正是被裁剪的原因）。
                选中即生效（不再有「绑定」按钮）：这里只是**选择**，
                真正的写入发生在保存账号时（与其他字段一起提交）。

                绑定是账号级的：同一个 default-model 在不同上游是不同的模型。
              */}
              {showModels && unboundAliases.length > 0 && <div className={styles.bindField}>
                <div className={styles.bindIntro}>
                  <span className={styles.fieldLabel}>需要绑定真实模型（{unboundAliases.length}）</span>
                  <span className={styles.muted}>
                    这些是上游自定义的别名，看不出是什么模型、也没有定价（会按 0 计费）。
                    为每一个选择它对应的真实模型 —— 绑定后官方定价与能力参数会自动配好。
                  </span>
                </div>
                <div className={styles.bindList}>
                  {unboundAliases.map((alias) => (
                    <div key={alias} className={styles.bindRow}>
                      {/* ModelMark 自带图标与模型名，不要再拼一遍名字 */}
                      <span className={styles.bindAlias} title={alias}>
                        <ModelMark model={alias} fallback={draft.vendor} />
                      </span>
                      <span className={styles.bindArrow} aria-hidden="true">→</span>
                      <div className={styles.bindPicker}>
                        <MorphSelect
                          hideLabel
                          label={alias + " 绑定到"}
                          items={realModelGroups}
                          value={bindDraft[alias] ?? ""}
                          onValueChange={(realID) => setBindDraft((prev) => ({ ...prev, [alias]: realID }))}
                          searchable
                          searchPlaceholder="搜索模型名或厂商…"
                          panelWidth={420}
                          align="end"
                          placeholder="选择对应的真实模型"
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>}
              {/* 计费与外发：不再折叠，直接显示。
                  折叠会让「这个账号按什么口径计费」被藏起来，
                  而它直接影响账单，属于该一眼看到的配置。 */}
              <div className={styles.advancedBody}>
                <p className={styles.advancedGroupTitle}>计费与外发</p>
                <div className={styles.configGroup}>
                  <div className={styles.configRow}>
                    <span className={styles.configLabel}>计费口径</span>
                    <MorphSelect hideLabel label="计费口径" items={CONTEXT_BILLING_OPTIONS} value={draft.contextBilling} onValueChange={(contextBilling) => setDraft((d) => ({ ...d, contextBilling }))} align="end" panelWidth={280} />
                  </div>
                  <div className={styles.configRow}>
                    <span className={styles.configLabel}>调用来源限制</span>
                    <div className={styles.rowText}>
                      <Input label="调用来源限制" placeholder="如 codex, claude-code；留空不限" value={draft.requireCaller} onChange={(e) => setDraft({ ...draft, requireCaller: e.target.value })} />
                    </div>
                  </div>
                  <div className={styles.configRow}>
                    <span className={styles.configLabel}>出口代理</span>
                    <div className={styles.rowText}>
                      <Input label="出口代理" placeholder="http://127.0.0.1:7890 或 socks5://host:1080" value={draft.proxyUrl} onChange={(e) => setDraft({ ...draft, proxyUrl: e.target.value })} />
                    </div>
                  </div>
                  <div className={styles.configRow}>
                    <span className={styles.configLabel}>TLS 指纹</span>
                    <MorphSelect hideLabel label="TLS 指纹" items={TLS_FINGERPRINT_OPTIONS} value={draft.tlsFingerprint} onValueChange={(tlsFingerprint) => setDraft((d) => ({ ...d, tlsFingerprint }))} align="end" panelWidth={300} />
                  </div>
                  <div className={styles.configRow}>
                    <span className={styles.configLabel}>Namespace</span>
                    <div className={styles.rowText}>
                      <Input label="Namespace" maxLength={64} placeholder="上游命名空间" value={draft.namespace} onChange={(e) => setDraft({ ...draft, namespace: e.target.value })} />
                    </div>
                  </div>
                  <div className={styles.configRow}>
                    <span className={styles.configLabel}>备注</span>
                    <div className={styles.rowText}>
                      <Input label="备注" maxLength={255} placeholder="给自己看的说明" value={draft.remark} onChange={(e) => setDraft({ ...draft, remark: e.target.value })} />
                    </div>
                  </div>
                </div>
              </div>
              {/* 协议路由与附加请求头：不再折叠，直接展开显示 ——
                  它是「把请求发对地方」的关键配置，藏在折叠项里容易被忽略。
                  授权类渠道（设备码 / 订阅登录）的协议路径由服务端固定，
                  这里不显示：显示了也改不动，只会让人以为配置没生效。 */}
              {!isLoginChannel && (
                <div className={styles.advancedBody}>
                  <p className={styles.advancedGroupTitle}>协议路由与附加请求头</p>
                  <Textarea label="按模型的协议路由" value={draft.modelPaths} onChange={(e) => setDraft({ ...draft, modelPaths: e.target.value })} rows={3} placeholder="messages: claude-4-*、responses: gpt-*、chat: *" />
                  <Textarea label="附加请求头" value={draft.headers} onChange={(e) => setDraft({ ...draft, headers: e.target.value })} rows={3} placeholder="x-opencode-session: {{session}}" />
                </div>
              )}
            </fieldset>
          </ScrollArea>
        </div>
        {/*
          底部提示：模型是保存的必需项，但它的控件在表单中间，
          滚到底部按保存时看不到「为什么按钮是灰的」—— 所以在按钮左边说清楚。
        */}
        <div className={styles.dialogActions}>
          <Button size="sm" variant="secondary" disabled={saveGuard.busy || fetchGuard.busy} onClick={() => setOpen(false)}>取消</Button><Button size="sm" loading={saveGuard.busy} disabled={saveGuard.busy || fetchGuard.busy || selectedConnection?.disabled || !modelTags.length || unboundAliases.length > 0 || (isDeviceLogin && !editing && !deviceTicket)} onClick={() => void save()}>{editing ? "保存修改" : "添加账号"}</Button>
        </div>
      </DialogContent>
    </Dialog>

    {/* 账号模型清单用 Bottom sheet：属于「看一眼全貌」的次级浏览任务，
        底部上滑比打断式弹窗更合适（组件库明确推荐这类场景）。 */}
    <BottomSheet
      open={Boolean(modelsAccount)}
      onOpenChange={(value) => { if (!value) setModelsAccount(null); }}
      title={modelsAccount ? `「${modelsAccount.name}」的模型` : "账号模型"}
      description={modelsAccount ? `共 ${modelsAccount.models.length} 个模型 · 分组 ${modelsAccount.group_name || "所有分组"}` : undefined}
      detents={[0.55, 0.9]}
      closeLabel="关闭"
    >
      {/* BottomSheet 的 body 本身就是受控滚动容器（含拖拽手势协调），
          此处不再嵌 ScrollArea，避免双滚动互相打架。 */}
      {modelsAccount && (
        <div className={styles.fullModels}>
          {modelsAccount.models.map((m) => <ModelMark key={m} model={m} fallback={modelsAccount.vendor} />)}
          {!modelsAccount.models.length && <EmptyState icon={<Network size={20} />} title="未限定模型" description="该账号未限定模型，分组白名单内的模型都可调度。" />}
        </div>
      )}
    </BottomSheet>
    <Dialog open={Boolean(confirmAccount)} onOpenChange={(value) => { if (!value && !busy[confirmAccount?.account.id ?? -1]) setConfirmAccount(null); }}><DialogContent title={confirmAccount?.type === "delete" ? "删除账号" : "禁用账号"}>{confirmAccount && <><p className={styles.confirmText}>{confirmAccount.type === "delete" ? `将永久删除「${confirmAccount.account.name}」的配置，之后无法通过该账号调度请求。` : `「${confirmAccount.account.name}」将停止接收新请求；已在执行的请求不受影响。`}</p><div className={styles.dialogActions}><Button variant="secondary" size="sm" disabled={busy[confirmAccount.account.id]} onClick={() => setConfirmAccount(null)}>取消</Button><HoldToConfirm label={confirmAccount.type === "delete" ? "按住删除账号" : "按住禁用账号"} confirmed={false} disabled={busy[confirmAccount.account.id]} tone="danger" onConfirm={() => void (confirmAccount.type === "delete" ? remove(confirmAccount.account) : toggle(confirmAccount.account))} /></div></>}</DialogContent></Dialog>
  </AdminLayout>;
}
