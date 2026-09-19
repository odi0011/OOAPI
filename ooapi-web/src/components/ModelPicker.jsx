// 模型范围选择器 —— 渠道新增/编辑共用
// ---------------------------------------------------------------------------
// 需求（管理员视角）：「这个账号到底能用哪些模型？我希望直接从上游拉一份真实清单，
// 然后全选或勾几个，而不是自己手敲模型名。」
//
// 三个来源，按可信度排序，UI 上明确标注来源，避免误判：
//   upstream  从该账号的上游接口实时拉取（订阅/网页版账号的真实可见模型，最准）
//   registry  平台按该厂商注册的模型（上游没接口或调用失败时的兜底）
//   manual    管理员手工输入（补充上游没有的别名/自定义端点）
//
// 交互：拉取 → 列表勾选（含「全选/全不选/仅选已声明」）→ 保存为渠道 models 字段。
// 留空 = 该厂商全部模型（不限制），这是默认且推荐的状态。
import React, { useEffect, useState } from "react";
import { Select, Button, Space, Tooltip, Tag, App as AntApp, Spin } from "antd";
import { CloudDownloadOutlined, CheckSquareOutlined, CloseSquareOutlined } from "@ant-design/icons";
import { API } from "../services/api";
import { ModelLabel } from "./VendorIcon";

const SOURCE_LABEL = {
  upstream: { text: "上游实时", color: "green", tip: "从该账号的上游接口实时拉取，最准确" },
  registry: { text: "平台注册表", color: "orange", tip: "上游没返回清单，用的是平台按该厂商注册的模型" },
  none: { text: "无来源", color: "red", tip: "上游与注册表都没有可用清单，请手工输入" },
};

export default function ModelPicker({ value = [], onChange, channelId = 0, providerKey = "", disabled = false, extra }) {
  const { message } = AntApp.useApp();
  const [options, setOptions] = useState([]);
  const [source, setSource] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const list = Array.isArray(value) ? value : [];

  // 渠道已存在时自动拉一次（编辑弹窗打开即有清单，不用管理员先点按钮）
  useEffect(() => {
    if (channelId) fetchModels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId]);

  const fetchModels = async () => {
    if (!channelId) return message.info("请先保存渠道，再从上游获取模型");
    setBusy(true);
    try {
      const r = await API.post(`/channel/${channelId}/upstream-models`, undefined, { timeoutMs: 90_000 });
      const models = Array.isArray(r?.models) ? r.models : [];
      setOptions(models.map((m) => ({ value: m, label: m })));
      setSource(r?.source || "none");
      setNote(
        r?.source === "upstream"
          ? `已从上游拉取 ${models.length} 个模型`
          : r?.source === "registry"
            ? `上游未返回清单（${r?.upstreamError || "接口不可用"}），已回退到平台注册的 ${models.length} 个模型`
            : "没有可用的模型清单，请手工输入"
      );
      if (models.length) message.success(`获取到 ${models.length} 个模型`);
    } catch (e) {
      setSource("none");
      setNote(e.message);
      message.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  const src = SOURCE_LABEL[source] || null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <Space wrap size={6}>
        <Button size="small" icon={<CloudDownloadOutlined />} loading={busy} onClick={fetchModels} disabled={disabled}>
          从上游获取模型
        </Button>
        <Button
          size="small"
          icon={<CheckSquareOutlined />}
          disabled={disabled || !options.length}
          onClick={() => onChange(options.map((o) => o.value))}
        >
          全选
        </Button>
        <Button size="small" icon={<CloseSquareOutlined />} disabled={disabled || !list.length} onClick={() => onChange([])}>
          清空（= 全部）
        </Button>
        {src ? (
          <Tooltip title={src.tip}>
            <Tag color={src.color} style={{ marginInlineEnd: 0 }}>{src.text}</Tag>
          </Tooltip>
        ) : null}
        {options.length ? <span style={{ fontSize: 12, color: "var(--ink-3)" }}>可选 {options.length} 个</span> : null}
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
      {extra}
    </div>
  );
}
