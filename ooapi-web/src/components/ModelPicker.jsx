// 模型范围选择器 —— 渠道新增/编辑共用
// ---------------------------------------------------------------------------
// 交互核心优化：
// 1. 点击「从上游获取模型」：成功后直接自动填入下方模型字段，无需用户二次操作；
// 2. 「全选」与「清空」合二为一：根据当前选中状态智能切换（未全选时显示「全选全部」，全选后显示「清空所选」）；
// 3. 友好清洗上游报错（提炼 token_revoked / 401 等常见异常，杜绝倾倒原始 JSON）。
import React, { useEffect, useState } from "react";
import { Select, Button, Space, Tooltip, Tag, App as AntApp, Alert } from "antd";
import { CloudDownloadOutlined, CheckSquareOutlined, ClearOutlined } from "@ant-design/icons";
import { API } from "../services/api";
import { ModelLabel } from "./VendorIcon";

const SOURCE_LABEL = {
  upstream: { text: "上游实时", color: "green", tip: "从该账号的上游接口实时探测拉取，最准确" },
  registry: { text: "平台推荐", color: "orange", tip: "上游未暴露清单接口或探测失败，回退为平台注册推荐模型" },
  none: { text: "未探测", color: "default", tip: "尚未获取上游模型，支持手动输入" },
};

function formatErrorMessage(raw) {
  if (!raw) return "";
  const s = String(raw).trim();
  if (s.includes("token_revoked")) {
    return "上游授权凭据已失效或被官方撤销（token_revoked），请重新登录或更新账号凭据";
  }
  if (s.includes("401") || s.includes("Unauthorized") || s.includes("invalid_api_key")) {
    return "上游鉴权失败（401）：凭据无效或已过期，请检查 API Key 或访问令牌";
  }
  if (s.includes("429") || s.includes("rate_limit")) {
    return "上游请求触发限频（429 Too Many Requests），请稍后重试";
  }
  if (s.includes("{") && s.includes("}")) {
    try {
      const match = s.match(/\{[\s\S]*\}/);
      if (match) {
        const parsed = JSON.parse(match[0]);
        const msg = parsed?.error?.message || parsed?.message;
        if (msg) return `上游响应：${msg}`;
      }
    } catch {
      // ignore
    }
  }
  return s.length > 150 ? `${s.slice(0, 150)}...` : s;
}

export default function ModelPicker({ value = [], onChange, channelId = 0, providerKey = "", disabled = false, extra }) {
  const { message } = AntApp.useApp();
  const [options, setOptions] = useState([]);
  const [source, setSource] = useState("");
  const [note, setNote] = useState("");
  const [errNote, setErrNote] = useState("");
  const [busy, setBusy] = useState(false);

  const list = Array.isArray(value) ? value : [];

  // 渠道编辑弹窗打开时，静默拉取候选供下拉筛选（不覆盖用户已配置的选择）
  useEffect(() => {
    if (channelId) {
      fetchModels(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId]);

  const fetchModels = async (isManual = false) => {
    if (!channelId) {
      if (isManual) {
        message.info("新建渠道请先保存基础凭据，保存后即可从上游一键获取并填入可用模型");
      }
      return;
    }
    setBusy(true);
    setErrNote("");
    try {
      const r = await API.post(`/channel/${channelId}/upstream-models`, undefined, { timeoutMs: 90_000 });
      const models = Array.isArray(r?.models) ? r.models : [];
      setOptions(models.map((m) => ({ value: m, label: m })));
      setSource(r?.source || "none");

      const cleanErr = formatErrorMessage(r?.upstreamError);
      if (r?.source === "upstream") {
        setNote(`已从上游接口拉取到 ${models.length} 个实时模型`);
      } else if (r?.source === "registry") {
        setNote(`已加载平台注册的 ${models.length} 个推荐模型`);
        if (cleanErr) setErrNote(cleanErr);
      } else {
        setNote("未获取到模型清单，可手工输入模型名称");
      }

      // 用户主动点击按钮时，直接自动将探测到的模型完整填充至下方选择器中！
      if (isManual) {
        if (models.length) {
          onChange?.(models);
          message.success(`已成功从上游获取并自动填入 ${models.length} 个模型`);
        } else {
          message.warning("上游未返回任何可用模型");
        }
      }
    } catch (e) {
      setSource("none");
      const cleanErr = formatErrorMessage(e.message);
      setErrNote(cleanErr);
      if (isManual) message.error(cleanErr || "拉取上游模型失败");
    } finally {
      setBusy(false);
    }
  };

  const src = SOURCE_LABEL[source] || null;
  const isAllSelected = options.length > 0 && list.length >= options.length;

  const toggleSelectAll = () => {
    if (isAllSelected) {
      onChange?.([]);
      message.info("已清空模型选择（留空 = 不限模型）");
    } else {
      onChange?.(options.map((o) => o.value));
      message.success(`已全选 ${options.length} 个模型`);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <Space wrap size={6} align="center">
        <Button
          size="small"
          type="primary"
          ghost
          icon={<CloudDownloadOutlined />}
          loading={busy}
          onClick={() => fetchModels(true)}
          disabled={disabled}
        >
          从上游获取模型
        </Button>
        <Button
          size="small"
          icon={isAllSelected ? <ClearOutlined /> : <CheckSquareOutlined />}
          disabled={disabled || !options.length}
          onClick={toggleSelectAll}
        >
          {isAllSelected ? "清空（不限）" : `全选（${options.length}）`}
        </Button>
        {src ? (
          <Tooltip title={src.tip}>
            <Tag color={src.color} style={{ marginInlineEnd: 0 }}>{src.text}</Tag>
          </Tooltip>
        ) : null}
        {options.length ? (
          <span style={{ fontSize: 12, color: "var(--ink-3)" }}>
            已选 {list.length} / {options.length}
          </span>
        ) : null}
      </Space>

      <Select
        mode="multiple"
        allowClear
        disabled={disabled}
        value={list}
        onChange={onChange}
        placeholder="留空 = 该厂商全部模型（不限）"
        options={options.length ? options : list.map((m) => ({ value: m, label: m }))}
        optionRender={(opt) => <ModelLabel model={opt.value} size={14} />}
        maxTagCount={8}
        maxTagPlaceholder={(omitted) => `+${omitted.length}`}
        style={{ width: "100%" }}
      />

      {note ? <span style={{ fontSize: 12, color: "var(--ink-3)" }}>{note}</span> : null}
      {errNote ? (
        <Alert
          type="warning"
          showIcon
          message={errNote}
          style={{ padding: "4px 10px", fontSize: 12 }}
        />
      ) : null}
      {extra}
    </div>
  );
}

