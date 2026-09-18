import React, { useEffect, useMemo, useState, useCallback, useRef } from "react";
import {
  Table, Space, Typography, Input, Popconfirm, Modal, Form, Select, Switch,
  InputNumber, App as AntApp, Tooltip, Row, Col, Alert, Radio, Divider, Button, Spin,
} from "antd";
import {
  PlusOutlined, ReloadOutlined, ThunderboltOutlined, DeleteOutlined, EditOutlined,
  UndoOutlined, KeyOutlined, LoginOutlined, ApiOutlined, GlobalOutlined,
  InfoCircleOutlined, SafetyCertificateOutlined,
} from "@ant-design/icons";
import { API } from "../services/api";
import { fmtDate } from "../services/format";
import useLatest from "../hooks/useLatest";
import PageHeader from "../components/PageHeader";
import StatCard from "../components/StatCard";
import { VendorIcon, ModelLabel } from "../components/VendorIcon";

const { Text } = Typography;

// 状态单元格
function StatusCell({ r }) {
  if (r.status === 3) {
    return (
      <Space direction="vertical" size={2}>
        <span className="bui-chip bui-chip--red">
          <span className="bui-dot bui-dot--err" />
          自动禁用
        </span>
        {r.last_error ? (
          <Tooltip title={r.last_error}>
            <span style={{ fontSize: 11, color: "var(--ink-3)" }}>{r.last_error.slice(0, 20)}…</span>
          </Tooltip>
        ) : null}
      </Space>
    );
  }
  if (r.status === 2) {
    return (
      <span className="bui-chip" style={{ background: "transparent", padding: 0 }}>
        <span className="bui-dot bui-dot--idle" />
        已禁用
      </span>
    );
  }
  if (r.cooling) {
    return (
      <Space direction="vertical" size={2}>
        <span className="bui-chip bui-chip--orange">
          <span className="bui-dot bui-dot--warn" />
          冷却中
        </span>
        <span style={{ fontSize: 11, color: "var(--ink-3)" }}>至 {r.cooldown_text}</span>
      </Space>
    );
  }
  return (
    <span className="bui-chip" style={{ background: "transparent", padding: 0 }}>
      <span className="bui-dot bui-dot--ok" />
      已启用
    </span>
  );
}

/**
 * 厂商选择：一行一个厂商卡片（图标 + 名称 + 支持的接入方式）。
 * 刻意不做分类。厂商就是厂商，接入方式是它内部的属性，
 * 拆成「反代渠道 / API 渠道」两栏只会让同一个厂商出现两次。
 */
function ProviderPicker({ providers, activeKey, onPick }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: 330, overflowY: "auto", paddingRight: 2 }}>
      {providers.map((p) => {
        const active = activeKey === p.key;
        return (
          <div
            key={p.key}
            onClick={() => onPick(p)}
            role="button"
            tabIndex={0}
            aria-pressed={active}
            aria-label={`选择厂商 ${p.name}`}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onPick(p);
              }
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 11,
              padding: "10px 13px",
              borderRadius: "var(--r-card)",
              cursor: "pointer",
              background: active ? "var(--accent-tint)" : "var(--surface)",
              boxShadow: active ? "0 0 0 1.5px var(--accent)" : "var(--shadow-hairline)",
              transition: "background 120ms, box-shadow 120ms",
            }}
          >
            <VendorIcon type={p.vendor} size={22} />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 13.5, fontWeight: 550, color: "var(--ink)" }}>{p.name}</div>
              <div className="oo-truncate" style={{ fontSize: 11.5, color: "var(--ink-3)" }}>{p.desc}</div>
            </div>
            {active ? (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20 6L9 17l-5-5" />
              </svg>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export default function AdminChannelsPage() {
  const { message } = AntApp.useApp();

  const [items, setItems] = useState([]);
  const [providers, setProviders] = useState([]);
  const [stats, setStats] = useState(null);
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [providersError, setProvidersError] = useState("");
  const [statsError, setStatsError] = useState("");
  const [selectedKeys, setSelectedKeys] = useState([]);
  const [testingId, setTestingId] = useState(null);
  const [actionBusyId, setActionBusyId] = useState(null);

  const [keyword, setKeyword] = useState("");
  const [filterProvider, setFilterProvider] = useState("");

  const [addOpen, setAddOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [batchOpen, setBatchOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  // 批量导入（CPA / sub2api 凭据文件）
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [importBusy, setImportBusy] = useState(false);
  const [importResult, setImportResult] = useState(null);

  // 添加流程：先选厂商，再选该厂商的接入方式
  const [pickProvider, setPickProvider] = useState(null);
  const [pickMethod, setPickMethod] = useState(null);
  const [addMode, setAddMode] = useState("password");
  const [addSubmitting, setAddSubmitting] = useState(false);
  const [editSubmitting, setEditSubmitting] = useState(false);
  const [browserOpen, setBrowserOpen] = useState(false);
  const [browserTarget, setBrowserTarget] = useState(null);
  const [browserShot, setBrowserShot] = useState(null);
  const [browserBusy, setBrowserBusy] = useState(false);
  // 登录态远程抓取（粘贴登录态的厂商：打开登录页 → 登录 → 自动回填 token/cookies）
  const [capOpen, setCapOpen] = useState(false);
  const [capSid, setCapSid] = useState("");
  const [capShot, setCapShot] = useState(null);
  const [capBusy, setCapBusy] = useState(false);
  const [capCands, setCapCands] = useState(null);
  const [capPick, setCapPick] = useState("");
  const [capText, setCapText] = useState("");
  const capImgRef = useRef(null);
  const [addForm] = Form.useForm();
  const [editForm] = Form.useForm();
  const [batchForm] = Form.useForm();
  const { begin, isLatest } = useLatest();

  const load = useCallback(async () => {
    const token = begin();
    setLoading(true);
    setLoadError("");
    setProvidersError("");
    setStatsError("");
    try {
      // allSettled：某一个接口失败（如 stats 表未建好）不应让整页停在旧数据
      const [list, st, ps, gs] = await Promise.allSettled([
        API.get("/channel/", { params: { keyword, type: filterProvider } }),
        API.get("/channel/stats"),
        API.get("/channel/providers"),
        API.get("/channel/groups"),
      ]);
      if (!isLatest(token)) return;
      if (list.status === "fulfilled") setItems(list.value);
      else setLoadError(list.reason?.message || "渠道列表加载失败");
      if (st.status === "fulfilled") setStats(st.value);
      else setStatsError(st.reason?.message || "渠道统计加载失败");
      if (ps.status === "fulfilled") setProviders(ps.value);
      else setProvidersError(ps.reason?.message || "厂商列表加载失败");
      if (gs.status === "fulfilled") setGroups(gs.value);
      const failed = [list, st, ps, gs].find((r) => r.status === "rejected");
      if (failed) message.error(failed.reason?.message || "部分数据加载失败");
    } catch (e) {
      if (isLatest(token)) message.error(e.message);
    } finally {
      if (isLatest(token)) setLoading(false);
    }
  }, [keyword, filterProvider, message, begin, isLatest]);

  useEffect(() => {
    load();
  }, [load]);

  // 切换筛选/搜索时清空已选：否则批量操作会作用到当前不可见的渠道
  useEffect(() => {
    setSelectedKeys([]);
  }, [keyword, filterProvider]);

  const visibleItems = items;

  // 把厂商支持的凭据摊平成「一个选择」，而不是嵌套两层单选。
  // 用户的心智是「我怎么证明身份」：账号密码、粘贴登录态、还是 API Key。
  const credOptions = useMemo(() => {
    if (!pickProvider) return [];
    const out = [];
    for (const m of pickProvider.methods) {
      if (m.key === "api") {
        out.push({ id: "api", method: "api", mode: null, label: "API Key" });
      } else {
        for (const lm of m.loginModes || []) {
          out.push({
            // id 必须带 method 前缀：同一厂商出现多个 paste 方式时不能撞车
            id: `${m.key}:${lm}`,
            method: m.key, // relay / codex / claude-oauth / antigravity
            mode: lm,
            label: m.oauth
              ? "粘贴凭据"
              : lm === "password"
                ? "账号密码"
                : lm === "paste"
                  ? "粘贴登录态"
                  : "浏览器登录",
          });
        }
      }
    }
    return out;
  }, [pickProvider]);

  const isApi = pickMethod?.key === "api";
  // 非 API 的接入方式（relay 反代 / 订阅 OAuth）走同一套「凭据登录」提交流程
  const isRelay = Boolean(pickMethod) && !isApi;

  // 当前选中的凭据项（注意：必须放在 isApi 声明之后，否则 const 的暂时性死区会直接白屏）
  const credId = isApi ? "api" : pickMethod ? `${pickMethod.key}:${addMode}` : "";

  // ---------- 添加 ----------
  const openAdd = () => {
    setPickProvider(null);
    setPickMethod(null);
    setAddMode("password");
    addForm.resetFields();
    setAddOpen(true);
  };

  const chooseProvider = (p) => {
    setPickProvider(p);
    const mKey = p.defaultMethod || p.methods[0].key;
    applyMethod(p, p.methods.find((m) => m.key === mKey));
  };

  const applyMethod = (p, m, forceMode = null) => {
    if (!m) return;
    setPickMethod(m);
    const mode = forceMode || (m.loginModes && m.loginModes[0]) || "apikey";
    setAddMode(mode);
    const init = {
      name: p.name,
      base_url: m.baseUrl || "",
      api_key: "",
      models: (m.defaultModels || []).map((x) => x.id),
      priority: 0,
      // 非 API 方式（反代/订阅）后端会把 <=0 的权重归一到 1，表单默认值保持一致
      weight: m.key === "api" ? 0 : 1,
      group_name: "default",
      auto_ban: true,
    };
    for (const f of m.loginFields || []) {
      if (f.default !== undefined) init[f.key] = f.default;
    }
    addForm.resetFields();
    addForm.setFieldsValue(init);
  };

  const submitAdd = async () => {
    if (!pickProvider || !pickMethod) return message.warning("请先选择厂商与接入方式");
    if (addSubmitting) return; // 防重入：登录/创建耗时，双击会建出两条渠道
    let v;
    try {
      v = await addForm.validateFields();
    } catch {
      return; // 校验未通过：antd 已在表单上标红
    }

    setAddSubmitting(true);
    try {
      if (isRelay) {
        // relay 也要提交这些字段：后端 /channel/login 已支持落库（此前被丢弃，编辑无效）
        const payload = {
          type: pickProvider.key,
          method: pickMethod.key, // relay / codex / claude-oauth / antigravity
          mode: addMode,
          name: v.name,
          priority: v.priority,
          models: v.models,
          group_name: v.group_name,
          weight: v.weight,
          auto_ban: v.auto_ban,
        };
        if (addMode === "password") {
          payload.account = v.account;
          payload.password = v.password;
          payload.areaCode = v.areaCode || "+86";
        } else if (addMode === "paste") {
          payload.token = v.token;
          payload.cookies = v.cookies;
        }
        const r = await API.post("/channel/login", payload);
        message.success(`渠道「${r.name}」已添加`);
      } else {
        await API.post("/channel/", {
          name: v.name,
          type: pickProvider.key,
          method: "api",
          base_url: v.base_url,
          api_key: v.api_key,
          models: v.models,
          group_name: v.group_name,
          priority: v.priority,
          weight: v.weight,
          auto_ban: v.auto_ban,
        });
        message.success(`渠道「${v.name}」已创建`);
      }
      setAddOpen(false);
      await load();
    } catch (e) {
      // 浏览器登录类：渠道已入库但还没登录，引导管理员去完成人工登录
      if (pickMethod.needsBrowser && /已创建/.test(e.message || "")) {
        setAddOpen(false);
        await load();
        message.warning("渠道已创建，请在列表点「浏览器登录」完成登录");
        return;
      }
      message.error(e.message);
    } finally {
      setAddSubmitting(false);
    }
  };

  // ---------- 批量导入（CPA / sub2api） ----------
  const openImport = () => {
    setImportText("");
    setImportResult(null);
    setImportOpen(true);
  };
  const readImportFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) return message.warning("文件过大（上限 2MB）");
    try {
      setImportText(await file.text());
    } catch {
      message.error("读取文件失败");
    }
  };
  const submitImport = async () => {
    if (importBusy) return;
    if (!importText.trim()) return message.warning("请粘贴或选择要导入的 JSON 文件");
    setImportBusy(true);
    try {
      const r = await API.post("/channel/import", { text: importText });
      setImportResult(r);
      const bad = (r?.results || []).filter((x) => !x.ok && !x.skipped).length + (r?.parseErrors || []).length;
      if (bad) message.warning(`导入完成：成功 ${r?.created ?? 0}，跳过 ${r?.skipped ?? 0}，失败 ${bad}`);
      else message.success(`导入完成：成功 ${r?.created ?? 0}，跳过 ${r?.skipped ?? 0}`);
      load();
    } catch (e) {
      message.error(e.message);
    } finally {
      setImportBusy(false);
    }
  };

  // ---------- 编辑 ----------
  const openEdit = (r) => {
    setEditing(r);
    // resetFields：清掉上一次编辑残留（尤其 API Key），避免把 A 渠道的 Key 写进 B 渠道
    editForm.resetFields();
    editForm.setFieldsValue({
      name: r.name,
      base_url: r.base_url,
      api_key: "",
      models: r.models,
      group_name: r.group_name,
      priority: r.priority,
      weight: r.weight,
      remark: r.remark,
      auto_ban: r.auto_ban !== false,
      status: r.status === 1,
    });
    setEditOpen(true);
  };

  const submitEdit = async () => {
    if (editSubmitting) return; // 防重入
    let v;
    try {
      v = await editForm.validateFields();
    } catch {
      return;
    }
    setEditSubmitting(true);
    try {
      const payload = {
        id: editing.id,
        name: v.name,
        base_url: v.base_url,
        models: v.models,
        group_name: v.group_name,
        priority: v.priority,
        weight: v.weight,
        remark: v.remark,
        auto_ban: v.auto_ban,
      };
      // status 只在开关真正变化时提交：服务端收到 status 会清冷却/重置运行状态，
      // 只改备注不该顺手把「冷却中」的渠道重置。
      const nextStatus = v.status ? 1 : 2;
      if (nextStatus !== editing.status) payload.status = nextStatus;
      if (editing.method === "api" && v.api_key) payload.api_key = v.api_key;
      await API.put("/channel/", payload);
      message.success("已保存");
      setEditOpen(false);
      await load();
    } catch (e) {
      message.error(e.message);
    } finally {
      setEditSubmitting(false);
    }
  };

  // ---------- 操作 ----------
  const doTest = async (r) => {
    if (testingId) return; // 防并发：单值状态被覆盖会让前一个按钮提前恢复可点
    setTestingId(r.id);
    try {
      // 订阅渠道 verify 内部可能先刷新 token，服务端超时 60s；前端必须留足余量
      const res = await API.post(`/channel/${r.id}/test`, undefined, { timeoutMs: 90_000 });
      if (res?.success) message.success(`「${r.name}」可用（${res.time}ms）`);
      else message.warning(res?.message || "测试失败");
      await load();
    } catch (e) {
      message.error(e.message);
    } finally {
      setTestingId(null);
    }
  };

  const doReset = async (r) => {
    if (actionBusyId) return;
    setActionBusyId(r.id);
    try {
      await API.post("/channel/batch", { ids: [r.id], action: "enable" });
      message.success("已恢复");
      await load();
    } catch (e) {
      message.error(e.message);
    } finally {
      setActionBusyId(null);
    }
  };

  const openBrowser = async (r) => {
    setBrowserTarget(r);
    setBrowserShot(null);
    setBrowserBusy(true);
    try {
      const res = await API.post(`/channel/${r.id}/browser/open`);
      setBrowserShot(res);
    } catch (e) {
      message.error(e.message);
    } finally {
      setBrowserBusy(false);
    }
  };

  const refreshShot = async () => {
    if (!browserTarget) return;
    setBrowserBusy(true);
    try {
      const res = await API.post(`/channel/${browserTarget.id}/browser/open`);
      setBrowserShot(res);
    } catch (e) {
      message.error(e.message);
    } finally {
      setBrowserBusy(false);
    }
  };

  const confirmBrowserReady = async () => {
    if (!browserTarget) return;
    setBrowserBusy(true);
    try {
      const res = await API.post(`/channel/${browserTarget.id}/browser/check`);
      if (res?.success) {
        message.success(`「${browserTarget.name}」登录就绪，渠道可用`);
        setBrowserOpen(false);
        await load();
      } else {
        message.warning(res?.message || "尚未就绪，请先完成登录");
      }
    } catch (e) {
      message.error(e.message);
    } finally {
      setBrowserBusy(false);
    }
  };

  // ---------- 登录态远程抓取 ----------
  const startCapture = async () => {
    if (!pickProvider) return;
    setCapCands(null);
    setCapPick("");
    setCapText("");
    setCapShot(null);
    setCapBusy(true);
    try {
      const res = await API.post("/channel/capture/start", { type: pickProvider.key });
      setCapSid(res.sid);
      setCapShot({ dataUrl: res.dataUrl, url: res.url, hint: res.hint });
      setCapOpen(true);
    } catch (e) {
      message.error(e.message);
    } finally {
      setCapBusy(false);
    }
  };

  // 未抓取完成前每 4 秒刷新一次截图（登录过程可见；二维码也能跟着刷新）
  useEffect(() => {
    if (!capOpen || !capSid || capCands) return undefined;
    const timer = setInterval(async () => {
      try {
        const res = await API.get(`/channel/capture/${capSid}/shot`);
        setCapShot((old) => ({ ...old, dataUrl: res.dataUrl, url: res.url }));
      } catch {
        /* 会话过期时由用户重新打开，无需打断 */
      }
    }, 4000);
    return () => clearInterval(timer);
  }, [capOpen, capSid, capCands]);

  const capAct = async (op) => {
    if (!capSid) return;
    try {
      const res = await API.post(`/channel/capture/${capSid}/act`, op);
      setCapShot((old) => ({ ...old, dataUrl: res.dataUrl, url: res.url }));
    } catch (e) {
      message.error(e.message);
    }
  };

  // 截图按原始分辨率换算坐标：页面显示宽度 ≠ 真实视口宽度
  const onCapShotClick = (e) => {
    const img = capImgRef.current;
    if (!img || !img.naturalWidth) return;
    const rect = img.getBoundingClientRect();
    const x = Math.round((e.clientX - rect.left) * (img.naturalWidth / rect.width));
    const y = Math.round((e.clientY - rect.top) * (img.naturalHeight / rect.height));
    capAct({ action: "click", x, y });
  };

  const finishCapture = async () => {
    if (!capSid) return;
    setCapBusy(true);
    try {
      const res = await API.post(`/channel/capture/${capSid}/capture`);
      setCapCands({ cookies: res.cookies, tokens: res.tokens || [] });
      setCapPick(res.tokens?.[0]?.value || "");
    } catch (e) {
      message.error(e.message);
    } finally {
      setCapBusy(false);
    }
  };

  const applyCapture = () => {
    if (!capCands) return;
    addForm.setFieldsValue({ token: capPick, cookies: capCands.cookies || "" });
    message.success("已回填登录态，请继续完善其他字段");
    closeCapture(true);
  };

  const closeCapture = async (keep) => {
    const sid = capSid;
    setCapOpen(false);
    setCapSid("");
    setCapShot(null);
    setCapCands(null);
    setCapPick("");
    setCapText("");
    if (sid && !keep) await API.post(`/channel/capture/${sid}/close`).catch(() => {});
  };

  const doDelete = async (r) => {
    if (actionBusyId) return;
    setActionBusyId(r.id);
    try {
      await API.del(`/channel/${r.id}`);
      message.success("已删除");
      setSelectedKeys((prev) => prev.filter((id) => id !== r.id));
      await load();
    } catch (e) {
      message.error(e.message);
    } finally {
      setActionBusyId(null);
    }
  };

  const doBatch = async (action, payload) => {
    if (!selectedKeys.length) return message.warning("请先选择渠道");
    try {
      await API.post("/channel/batch", { ids: selectedKeys, action, payload });
      message.success("操作成功");
      setSelectedKeys([]);
      await load();
    } catch (e) {
      message.error(e.message);
    }
  };

  const fetchModels = async () => {
    const { base_url, api_key } = addForm.getFieldsValue(["base_url", "api_key"]);
    if (!api_key) return message.warning("请先填写 API Key");
    try {
      const list = await API.post("/channel/fetch-models", { base_url, api_key, type: pickProvider?.key });
      if (list?.length) {
        addForm.setFieldsValue({ models: list });
        message.success(`获取到 ${list.length} 个模型`);
      } else message.info("上游未返回模型列表，可手动输入");
    } catch (e) {
      message.error(e.message);
    }
  };

  // ---------- 表格列 ----------
  const columns = [
    { title: "ID", dataIndex: "id", width: 60, render: (v) => <span className="oo-num" style={{ color: "var(--ink-3)" }}>{v}</span> },
    {
      title: "名称",
      dataIndex: "name",
      width: 210,
      render: (v, r) => (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <VendorIcon type={r.type} size={18} />
          <span style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 550 }} className="oo-truncate">{v}</div>
            {r.account ? (
              <div style={{ fontSize: 11.5, color: "var(--ink-3)", fontFamily: "var(--font-mono)" }}>{r.account}</div>
            ) : r.remark ? (
              <div style={{ fontSize: 11.5, color: "var(--ink-3)" }} className="oo-truncate">{r.remark}</div>
            ) : null}
          </span>
        </span>
      ),
    },
    {
      title: "厂商",
      dataIndex: "typeName",
      width: 120,
      render: (v) => <span className="bui-chip">{v}</span>,
    },
    { title: "状态", dataIndex: "status", width: 128, render: (_, r) => <StatusCell r={r} /> },
    {
      title: "模型",
      dataIndex: "models",
      width: 250,
      render: (list) => (
        <Tooltip
          title={
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {(list || []).map((m) => <ModelLabel key={m} model={m} size={13} />)}
            </div>
          }
        >
          <span style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "nowrap", overflow: "hidden" }}>
            {(list || []).slice(0, 2).map((m) => <ModelLabel key={m} model={m} size={14} />)}
            {(list?.length || 0) > 2 ? <span className="bui-chip">+{list.length - 2}</span> : null}
          </span>
        </Tooltip>
      ),
    },
    {
      // 凭据种类直接写清（账号 / Key），这样就不需要单独一列讲「接入方式」
      title: "凭据",
      width: 126,
      render: (_, r) => {
        if (!r.has_credential) {
          return <span className="bui-chip bui-chip--orange"><InfoCircleOutlined /> 未配置</span>;
        }
        const isApi = r.method === "api";
        return (
          <span className="bui-chip" title={r.methodLabel}>
            {isApi ? <KeyOutlined /> : <LoginOutlined />}
            {isApi ? (r.key_count > 1 ? `${r.key_count} 个 Key` : "Key") : "账号"}
          </span>
        );
      },
    },
    { title: "分组", dataIndex: "group_name", width: 90 },
    { title: "优先级", dataIndex: "priority", width: 86, sorter: (a, b) => a.priority - b.priority, render: (v) => <span className="oo-num">{v}</span> },
    { title: "权重", dataIndex: "weight", width: 74, render: (v) => <span className="oo-num">{v}</span> },
    {
      title: "响应",
      dataIndex: "response_time",
      width: 94,
      render: (v, r) =>
        r.tested_time ? (
          <span className="oo-num" style={{ color: v > 3000 ? "var(--orange)" : "var(--ink)" }}>{v ? `${v}ms` : "-"}</span>
        ) : (
          <Text type="secondary" style={{ fontSize: 12 }}>未测试</Text>
        ),
    },
    { title: "调用", dataIndex: "used_count", width: 78, sorter: (a, b) => a.used_count - b.used_count, render: (v) => <span className="oo-num">{v}</span> },
    {
      title: "最近测试",
      dataIndex: "tested_time",
      width: 138,
      render: (v) => <span className="oo-num" style={{ fontSize: 12 }}>{v ? fmtDate(v, "MM-DD HH:mm") : "-"}</span>,
    },
    {
      title: "操作",
      width: 150,
      fixed: "right",
      render: (_, r) => (
        <Space size={2}>
          {r.needsBrowser ? (
            <Tooltip title={r.browserReady ? "浏览器登录（已就绪）" : "浏览器登录（未完成）"}>
              <button
                className="bui-icon-btn"
                style={r.browserReady ? undefined : { color: "var(--orange)" }}
                aria-label={`${r.name} 浏览器登录`}
                disabled={Boolean(actionBusyId) || browserBusy}
                onClick={() => { setBrowserOpen(true); openBrowser(r); }}
              >
                <GlobalOutlined />
              </button>
            </Tooltip>
          ) : null}
          <Tooltip title="测试">
            <button className="bui-icon-btn" aria-label={`${r.name} 测试`} onClick={() => doTest(r)} disabled={Boolean(actionBusyId) || testingId === r.id} aria-busy={testingId === r.id}>
              {testingId === r.id ? <Spin size="small" /> : <ThunderboltOutlined />}
            </button>
          </Tooltip>
          {r.cooling ? (
            <Tooltip title="恢复">
              <button className="bui-icon-btn" aria-label={`${r.name} 恢复`} onClick={() => doReset(r)} disabled={Boolean(actionBusyId) || testingId === r.id} aria-busy={actionBusyId === r.id}>
                {actionBusyId === r.id ? <Spin size="small" /> : <UndoOutlined />}
              </button>
            </Tooltip>
          ) : null}
          <Tooltip title="编辑">
            <button className="bui-icon-btn" aria-label={`${r.name} 编辑`} onClick={() => openEdit(r)} disabled={Boolean(actionBusyId) || testingId === r.id}><EditOutlined /></button>
          </Tooltip>
          <Popconfirm title={`确认删除「${r.name}」？`} onConfirm={() => doDelete(r)}>
            <Tooltip title="删除">
              <button className="bui-icon-btn" aria-label={`${r.name} 删除`} disabled={Boolean(actionBusyId) || testingId === r.id} aria-busy={actionBusyId === r.id} style={{ color: "var(--red)" }}>
                {actionBusyId === r.id ? <Spin size="small" /> : <DeleteOutlined />}
              </button>
            </Tooltip>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div className="oo-page">
      <PageHeader
        title="渠道管理"
        desc="一个渠道绑定一个厂商；同一个厂商可以建多个渠道，各用各的账号或 Key"
        extra={
          <>
            <Input
              placeholder="搜索名称 / 地址 / 模型"
              allowClear
              prefix={<GlobalOutlined style={{ color: "var(--ink-3)" }} />}
              style={{ width: 210 }}
              onPressEnter={(e) => setKeyword(e.target.value)}
              onChange={(e) => { if (!e.target.value) setKeyword(""); }}
            />
            <Select
              placeholder="全部厂商" allowClear style={{ width: 140 }}
              value={filterProvider || undefined} onChange={(v) => setFilterProvider(v || "")}
              options={providers.map((p) => ({ value: p.key, label: p.name }))}
            />
            {selectedKeys.length ? (
              <>
                <button className="bui-btn" onClick={() => doBatch("enable")}>批量启用</button>
                <button className="bui-btn" onClick={() => doBatch("disable")}>批量禁用</button>
                <button className="bui-btn" onClick={() => setBatchOpen(true)}>批量修改</button>
                <Popconfirm title="确认批量删除？" onConfirm={() => doBatch("delete")}>
                  <button className="bui-btn" style={{ color: "var(--red)" }}>批量删除</button>
                </Popconfirm>
              </>
            ) : null}
            <button className="bui-btn" onClick={load}><ReloadOutlined /> 刷新</button>
            <button className="bui-btn" onClick={openImport}>导入凭据</button>
            <button className="bui-btn bui-btn--primary" onClick={openAdd}><PlusOutlined /> 添加渠道</button>
          </>
        }
      />

      <div className="oo-grid">
        <StatCard label="渠道总数" value={statsError ? "—" : stats?.total ?? 0} icon={<ApiOutlined />} foot={<span>{statsError ? "统计加载失败" : `${providers.length} 个厂商可选`}</span>} />
        <StatCard
          label="已启用" value={statsError ? "—" : stats?.enabled ?? 0} tone="success" glow="color-mix(in srgb, var(--green) 18%, transparent)"
          foot={<span className="oo-flex oo-gap-2">{statsError ? "统计加载失败" : <><span className="bui-dot bui-dot--ok" />调度正常</>}</span>}
        />
        <StatCard label="冷却中" value={statsError ? "—" : stats?.cooling ?? 0} tone={!statsError && (stats?.cooling ?? 0) > 0 ? "warning" : undefined} foot={<span>自动恢复</span>} />
        <StatCard
          label="可用模型"
          value={loadError ? "—" : new Set(items.flatMap((x) => x.models || [])).size}
          foot={<span>全部渠道合计</span>}
        />
      </div>

      <div className="oo-panel">
        {loadError ? (
          <Alert
            type="error"
            showIcon
            message="渠道列表加载失败"
            description={loadError}
            action={<Button size="small" onClick={load} loading={loading}>重试</Button>}
            style={{ marginBottom: 12 }}
          />
        ) : null}
        <Table
          className="oo-table"
          rowKey="id"
          loading={loading}
          dataSource={visibleItems}
          columns={columns}
          scroll={{ x: 1660 }}
          rowSelection={{ selectedRowKeys: selectedKeys, onChange: setSelectedKeys }}
          pagination={{ pageSize: 20, showSizeChanger: true, showTotal: (t) => `共 ${t} 个渠道` }}
        />
      </div>

      {/* ============ 添加渠道（中心弹窗）============ */}
      <Modal
        title="添加渠道"
        open={addOpen}
        onCancel={() => setAddOpen(false)}
        width={620}
        destroyOnClose
        maskClosable={false}
        footer={
          <Space>
            <button className="bui-btn" onClick={() => setAddOpen(false)}>取消</button>
            <button className="bui-btn bui-btn--primary" onClick={submitAdd} disabled={!pickMethod || addSubmitting}>
              {isRelay ? "登录并添加" : "创建渠道"}
            </button>
          </Space>
        }
      >
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 9 }}>1. 选择厂商</div>
          {providersError ? (
            <Alert
              type="error"
              showIcon
              message="厂商列表加载失败"
              description={providersError}
              action={<Button size="small" onClick={load} loading={loading}>重试</Button>}
              style={{ marginBottom: 10 }}
            />
          ) : null}
          {!providersError && !providers.length ? (
            <Alert
              type="info"
              showIcon
              message="暂无可用厂商"
              description="请先配置厂商，或点击刷新重新加载列表。"
              action={<Button size="small" onClick={load} loading={loading}>刷新</Button>}
              style={{ marginBottom: 10 }}
            />
          ) : null}
          <ProviderPicker providers={providers} activeKey={pickProvider?.key} onPick={chooseProvider} />
        </div>

        {pickProvider ? (
          <>
            <Divider style={{ margin: "2px 0 14px" }} />
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>2. 填写配置</div>
            {pickMethod ? (
              <>
                <Form form={addForm} layout="vertical" requiredMark={false}>
                  <Form.Item name="name" label="渠道名称" rules={[{ required: true, message: "请填写名称" }]}>
                    <Input placeholder={`例如：${pickProvider.name}-主力`} maxLength={64} />
                  </Form.Item>

                  {/* 只有一种凭据时不必让用户选，直接展示对应字段 */}
                  {credOptions.length > 1 ? (
                    <Form.Item label="凭据">
                      <Radio.Group
                        value={credId}
                        onChange={(e) => {
                          const opt = credOptions.find((o) => o.id === e.target.value);
                          if (!opt) return;
                          const m = pickProvider.methods.find((x) => x.key === opt.method);
                          applyMethod(pickProvider, m, opt.mode);
                        }}
                      >
                        {credOptions.map((o) => (
                          <Radio.Button key={o.id} value={o.id}>{o.label}</Radio.Button>
                        ))}
                      </Radio.Group>
                    </Form.Item>
                  ) : null}

                  {isRelay ? (
                    <>
                      {addMode === "password" ? (
                        <>
                          <Form.Item name="account" label="手机号 / 邮箱" rules={[{ required: true, message: "请填写手机号或邮箱" }]}>
                            <Input placeholder="13800138000 或 you@example.com" autoComplete="off" />
                          </Form.Item>
                          <Row gutter={12}>
                            <Col span={8}>
                              <Form.Item name="areaCode" label="区号"><Input placeholder="+86" /></Form.Item>
                            </Col>
                            <Col span={16}>
                              <Form.Item name="password" label="密码" rules={[{ required: true, message: "请填写密码" }]}>
                                <Input.Password placeholder="账号密码" autoComplete="new-password" />
                              </Form.Item>
                            </Col>
                          </Row>
                        </>
                      ) : addMode === "paste" ? (
                        <>
                          {pickMethod.canCapture ? (
                            <Form.Item label="快捷登录（推荐）">
                              <Space wrap>
                                <Button icon={<GlobalOutlined />} onClick={startCapture} loading={capBusy}>
                                  打开登录页自动抓取
                                </Button>
                                <span style={{ fontSize: 12, color: "var(--ink-3)" }}>
                                  {pickMethod.captureHint || "在服务器端登录页完成登录后，自动读取登录态回填下面"}
                                </span>
                              </Space>
                            </Form.Item>
                          ) : null}
                          <Form.Item
                            name="token"
                            label={pickMethod.oauth ? "凭据 JSON" : "登录态"}
                            rules={[{ required: true, message: pickMethod.oauth ? "请粘贴凭据 JSON" : "请粘贴登录态" }]}
                            extra={pickMethod.pasteHint}
                          >
                            <Input.TextArea
                              rows={pickMethod.oauth ? 6 : 3}
                              placeholder={pickMethod.oauth ? "粘贴官方 CLI 凭据文件的完整内容（JSON）" : "粘贴登录态值"}
                            />
                          </Form.Item>
                          {!pickMethod.oauth && (
                            <Form.Item name="cookies" label="Cookies（可选，建议填写）" extra='JSON 数组，例如 [{"name":"ds_session_id","value":"..."}]'>
                              <Input.TextArea rows={2} placeholder='[{"name":"...","value":"..."}]' />
                            </Form.Item>
                          )}
                        </>
                      ) : addMode === "browser" ? (
                        <Alert
                          type="warning"
                          showIcon
                          style={{ marginBottom: 16 }}
                          message="需要浏览器登录"
                          description={
                            <span style={{ fontSize: 12 }}>
                              {pickMethod.browserHint || "点击「登录并添加」后，平台会在服务器上打开浏览器完成登录，验证码与风控由页面自动处理。"}
                            </span>
                          }
                        />
                      ) : null}
                    </>
                  ) : (
                    <>
                      <Form.Item name="base_url" label="接口地址（Base URL）" rules={[{ required: true, message: "请填写地址" }]}>
                        <Input placeholder="https://..." />
                      </Form.Item>
                      <Form.Item name="api_key" label="API Key" rules={[{ required: true, message: "请填写 API Key" }]}>
                        <Input.Password placeholder={pickMethod.keyHint || "填写上游 API Key"} autoComplete="new-password" />
                      </Form.Item>
                      <Form.Item label="拉取上游模型">
                        <button className="bui-btn" onClick={fetchModels}>从上游获取模型列表</button>
                      </Form.Item>
                    </>
                  )}

                  <Form.Item
                    name="models"
                    label="支持的模型"
                    rules={[{ required: true, message: "请至少选择一个模型" }]}
                    extra={isRelay ? "已按该厂商默认填入，可增删" : "输入模型名后回车"}
                  >
                    <Select mode="tags" placeholder="输入模型名后回车" tokenSeparators={[","]} />
                  </Form.Item>

                  <Row gutter={12}>
                    <Col span={8}>
                      <Form.Item name="group_name" label="分组">
                        <Select options={groups.map((g) => ({ value: g, label: g }))} placeholder="default" />
                      </Form.Item>
                    </Col>
                    <Col span={8}>
                      <Form.Item name="priority" label="优先级" extra="越大越优先">
                        <InputNumber style={{ width: "100%" }} min={0} />
                      </Form.Item>
                    </Col>
                    <Col span={8}>
                      <Form.Item name="weight" label="权重" extra="同级随机">
                        <InputNumber style={{ width: "100%" }} min={0} />
                      </Form.Item>
                    </Col>
                  </Row>

                  <Form.Item name="auto_ban" label="测试失败自动禁用" valuePropName="checked">
                    <Switch />
                  </Form.Item>
                </Form>
              </>
            ) : null}
          </>
        ) : null}
      </Modal>

      {/* ============ 编辑渠道 ============ */}
      <Modal
        title={`编辑渠道：${editing?.name || ""}`}
        open={editOpen}
        onCancel={() => setEditOpen(false)}
        onOk={submitEdit}
        confirmLoading={editSubmitting}
        destroyOnClose
        okText="保存"
        width={580}
      >
        <Form form={editForm} layout="vertical" requiredMark={false}>
          <Form.Item name="name" label="渠道名称" rules={[{ required: true, message: "请填写名称" }]}>
            <Input maxLength={64} />
          </Form.Item>
          <Form.Item name="base_url" label="接口地址（Base URL）">
            <Input placeholder="https://..." />
          </Form.Item>
          {editing?.method === "api" ? (
            <Form.Item name="api_key" label="API Key" extra="留空表示不修改">
              <Input.Password placeholder="留空不修改" autoComplete="new-password" />
            </Form.Item>
          ) : (
            <Alert
              type="info" showIcon style={{ marginBottom: 16 }}
              message="凭据修改"
              description={<span style={{ fontSize: 12 }}>登录态不支持直接编辑；如需重新登录，请删除后重新添加。</span>}
            />
          )}
          <Form.Item name="models" label="支持的模型" rules={[{ required: true, message: "请至少选择一个模型" }]}>
            <Select mode="tags" placeholder="输入模型名后回车" tokenSeparators={[","]} />
          </Form.Item>
          <Row gutter={12}>
            <Col span={8}>
              <Form.Item name="group_name" label="分组">
                <Select options={groups.map((g) => ({ value: g, label: g }))} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="priority" label="优先级"><InputNumber style={{ width: "100%" }} min={0} /></Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="weight" label="权重"><InputNumber style={{ width: "100%" }} min={0} /></Form.Item>
            </Col>
          </Row>
          <Form.Item name="remark" label="备注"><Input maxLength={255} placeholder="可选" /></Form.Item>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="status" label="启用状态" valuePropName="checked">
                <Switch checkedChildren="启用" unCheckedChildren="禁用" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="auto_ban" label="失败自动禁用" valuePropName="checked"><Switch /></Form.Item>
            </Col>
          </Row>
        </Form>
      </Modal>

      {/* ============ 浏览器登录 ============ */}
      <Modal
        title={`浏览器登录：${browserTarget?.name || ""}`}
        open={browserOpen}
        onCancel={() => setBrowserOpen(false)}
        width={860}
        destroyOnClose
        footer={
          <Space>
            <button className="bui-btn" onClick={() => setBrowserOpen(false)}>关闭</button>
            <button className="bui-btn" onClick={refreshShot} disabled={browserBusy}>
              <ReloadOutlined /> 刷新画面
            </button>
            <button className="bui-btn bui-btn--primary" onClick={confirmBrowserReady} disabled={browserBusy}>
              {browserBusy ? "处理中…" : "我已完成登录，检测状态"}
            </button>
          </Space>
        }
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="服务器上没有桌面，请先在这个页面里完成登录"
          description={
            <span style={{ fontSize: 12 }}>
              下方是上游网页的实时截图。若出现二维码，请用手机扫码；登录完成后点「检测状态」。
              登录成功后登录态会保存在服务器上，之后长期有效，无需重复登录。
            </span>
          }
        />
        {browserShot?.error ? (
          <Alert type="warning" showIcon style={{ marginBottom: 12 }} message={browserShot.error} />
        ) : null}
        <div
          style={{
            background: "var(--inset)",
            borderRadius: "var(--r-card)",
            padding: 8,
            minHeight: 320,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            overflow: "auto",
          }}
        >
          {browserBusy && !browserShot ? (
            <span style={{ color: "var(--ink-3)", fontSize: 13 }}>正在打开浏览器并加载页面，请稍候…</span>
          ) : browserShot?.dataUrl ? (
            <img
              src={browserShot.dataUrl}
              alt="上游页面截图"
              style={{ maxWidth: "100%", borderRadius: 8, display: "block" }}
            />
          ) : (
            <span style={{ color: "var(--ink-3)", fontSize: 13 }}>暂无画面</span>
          )}
        </div>
        {browserShot?.url ? (
          <div style={{ marginTop: 8, fontSize: 12, color: "var(--ink-3)", fontFamily: "var(--font-mono)" }} className="oo-truncate">
            {browserShot.url}
          </div>
        ) : null}
      </Modal>

      {/* ============ 登录态远程抓取 ============ */}
      <Modal
        title="登录并自动抓取登录态"
        open={capOpen}
        onCancel={() => closeCapture(false)}
        footer={null}
        destroyOnClose
        width={720}
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="操作说明"
          description={
            <span style={{ fontSize: 12 }}>
              {capShot?.hint || "在下方页面里完成登录（可扫码），然后点「抓取登录态」。"}
              截图每 4 秒自动刷新；可直接在截图上点击（如同意条款、切换登录方式）。
            </span>
          }
        />

        <div
          style={{
            background: "var(--canvas)",
            borderRadius: 8,
            padding: 8,
            minHeight: 260,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {capShot?.dataUrl ? (
            <img
              ref={capImgRef}
              src={capShot.dataUrl}
              alt="登录页截图"
              onClick={onCapShotClick}
              style={{ maxWidth: "100%", borderRadius: 6, display: "block", cursor: "crosshair" }}
            />
          ) : (
            <Spin tip="正在打开登录页…" />
          )}
        </div>
        {capShot?.url ? (
          <div style={{ marginTop: 8, fontSize: 12, color: "var(--ink-3)", fontFamily: "var(--font-mono)" }} className="oo-truncate">
            {capShot.url}
          </div>
        ) : null}

        {!capCands ? (
          <Space direction="vertical" style={{ width: "100%", marginTop: 12 }} size={8}>
            <Space wrap>
              <Input
                style={{ width: 220 }}
                placeholder="输入验证码 / 账号（可选）"
                value={capText}
                onChange={(e) => setCapText(e.target.value)}
                onPressEnter={() => {
                  if (capText) {
                    capAct({ action: "type", text: capText });
                    setCapText("");
                  }
                }}
              />
              <Button
                onClick={() => {
                  if (capText) {
                    capAct({ action: "type", text: capText });
                    setCapText("");
                  }
                }}
              >
                输入到页面
              </Button>
              <Button onClick={() => capAct({ action: "key", key: "Enter" })}>回车</Button>
              <Button onClick={() => capAct({ action: "key", key: "Tab" })}>Tab</Button>
              <Button onClick={() => capAct({ action: "key", key: "Backspace" })}>退格</Button>
              <Button onClick={() => capAct({ action: "scroll", dy: 600 })}>向下滚</Button>
              <Button onClick={() => capAct({ action: "scroll", dy: -600 })}>向上滚</Button>
            </Space>
            <Space>
              <Button type="primary" onClick={finishCapture} loading={capBusy}>
                我已登录，抓取登录态
              </Button>
              <Button onClick={() => closeCapture(false)}>放弃</Button>
            </Space>
          </Space>
        ) : (
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>
              选择要填入表单的登录态（共 {capCands.tokens.length} 个候选）
            </div>
            {capCands.tokens.length ? (
              <Radio.Group
                value={capPick}
                onChange={(e) => setCapPick(e.target.value)}
                style={{ display: "flex", flexDirection: "column", gap: 6 }}
              >
                {capCands.tokens.map((t) => (
                  <Radio key={t.key} value={t.value}>
                    <span style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>
                      {t.key} = {t.value.slice(0, 24)}…{t.value.slice(-6)}
                    </span>
                  </Radio>
                ))}
              </Radio.Group>
            ) : (
              <div style={{ fontSize: 12, color: "var(--orange)" }}>没有抓到 token 类登录态，只回填 cookies。</div>
            )}
            <div style={{ marginTop: 6, fontSize: 12, color: "var(--ink-3)" }}>
              Cookies：{capCands.cookies ? `${capCands.cookies.slice(0, 60)}…` : "（空）"}
            </div>
            <Space style={{ marginTop: 12 }}>
              <Button type="primary" onClick={applyCapture} disabled={!capPick && !capCands.cookies}>
                填入表单
              </Button>
              <Button onClick={() => closeCapture(false)}>取消</Button>
            </Space>
          </div>
        )}
      </Modal>

      {/* ============ 批量修改 ============ */}
      <Modal
        title={`批量修改 ${selectedKeys.length} 个渠道`}
        open={batchOpen}
        onCancel={() => setBatchOpen(false)}
        footer={null}
        destroyOnClose
        width={460}
      >
        <Form
          form={batchForm}
          layout="vertical"
          requiredMark={false}
          onFinish={async (v) => {
            const payload = {};
            if (v.action === "set_priority") payload.priority = v.priority;
            if (v.action === "set_group") payload.group_name = v.group_name;
            if (v.action === "add_models") payload.models = v.models;
            await doBatch(v.action, payload);
            setBatchOpen(false);
            batchForm.resetFields();
          }}
        >
          <Form.Item name="action" label="操作" rules={[{ required: true, message: "请选择操作" }]}>
            <Select
              options={[
                { value: "set_priority", label: "设置优先级" },
                { value: "set_group", label: "设置分组" },
                { value: "add_models", label: "追加模型" },
              ]}
            />
          </Form.Item>
          <Form.Item noStyle shouldUpdate={(p, c) => p.action !== c.action}>
            {({ getFieldValue }) => {
              const a = getFieldValue("action");
              if (a === "set_priority") {
                return (
                  <Form.Item name="priority" label="优先级" rules={[{ required: true, message: "请填写" }]}>
                    <InputNumber style={{ width: "100%" }} min={0} />
                  </Form.Item>
                );
              }
              if (a === "set_group") {
                return (
                  <Form.Item name="group_name" label="分组" rules={[{ required: true, message: "请填写" }]}>
                    <Select options={groups.map((g) => ({ value: g, label: g }))} />
                  </Form.Item>
                );
              }
              if (a === "add_models") {
                return (
                  <Form.Item name="models" label="要追加的模型" rules={[{ required: true, message: "请填写" }]}>
                    <Select mode="tags" placeholder="输入模型名后回车" tokenSeparators={[","]} />
                  </Form.Item>
                );
              }
              return null;
            }}
          </Form.Item>
          <button className="bui-btn bui-btn--primary" type="submit">执行</button>
        </Form>
      </Modal>

      {/* ============ 导入凭据（CPA / sub2api） ============ */}
      <Modal
        title="导入凭据（CPA / sub2api）"
        open={importOpen}
        onCancel={() => setImportOpen(false)}
        onOk={submitImport}
        confirmLoading={importBusy}
        okText="开始导入"
        width={680}
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="支持格式"
          description={
            <span style={{ fontSize: 12 }}>
              sub2api 导出文件（accounts 数组）、CPA auth 文件（type=codex/claude/antigravity/gemini/xai）；
              可一次选择或粘贴多个文件内容，自动识别厂商与接入方式，重复账号自动跳过。
            </span>
          }
        />
        <input type="file" accept=".json,application/json" onChange={readImportFile} style={{ marginBottom: 10 }} />
        <Input.TextArea
          rows={10}
          value={importText}
          onChange={(e) => setImportText(e.target.value)}
          placeholder="粘贴 JSON 文件内容（例如 sub2api 导出、CPA auths/*.json）"
        />
        {importResult ? (
          <pre
            style={{
              marginTop: 12,
              maxHeight: 220,
              overflow: "auto",
              fontSize: 12,
              background: "var(--surface-2, #f6f6f6)",
              padding: 10,
              borderRadius: 8,
            }}
          >
            {JSON.stringify(
              {
                成功: importResult.created,
                跳过: importResult.skipped,
                明细: (importResult.results || []).map(
                  (x) => `${x.ok ? "[OK]" : x.skipped ? "[SKIP]" : "[FAIL]"} ${x.name}${x.reason ? `（${x.reason}）` : ""}`
                ),
                解析失败: (importResult.parseErrors || []).map((x) => `${x.name}：${x.reason}`),
              },
              null,
              2
            )}
          </pre>
        ) : null}
      </Modal>
    </div>
  );
}
