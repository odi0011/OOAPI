// 模型范围选择器 —— 渠道新增/编辑共用
// ---------------------------------------------------------------------------
// 交互核心优化：
// 1. 点击「从上游获取模型」：成功后直接自动填入下方模型字段，无需用户二次操作；
// 2. 「全选」与「清空」合二为一：根据当前选中状态智能切换（未全选时显示「全选全部」，全选后显示「清空所选」）；
// 3. 友好清洗上游报错（提炼 token_revoked / 401 等常见异常，杜绝倾倒原始 JSON）。
import React, { useEffect, useMemo, useState } from "react";
import { Select, Button, Space, Tooltip, Tag, App as AntApp, Alert, Segmented } from "antd";
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

export default function ModelPicker({
  value = [],
  onChange,
  channelId = 0,
  providerKey = "",
  // 新建渠道时用：未保存的 base_url / api_key。有它们就能**先拉模型再保存**，
  // 不必先建渠道再回头改模型（见 fetchModels 里的死锁说明）。
  baseUrl = "",
  apiKey = "",
  disabled = false,
  extra,
}) {
  const { message } = AntApp.useApp();
  const [options, setOptions] = useState([]);
  const [source, setSource] = useState("");
  const [note, setNote] = useState("");
  const [errNote, setErrNote] = useState("");
  const [busy, setBusy] = useState(false);
  // 上游返回的分组（目前只有 Cline 这类 `vendor/model` 目录型渠道会给）。
  // 454 个模型平铺进多选框时，管理员既看不出「哪些便宜、哪些是旗舰」，
  // 也不知道选中之后按什么价收费 —— 而这两件事恰好决定该选哪些。
  // 分组是**可选的展示层**：上游没给就退回原来的平铺多选，行为不变。
  const [groups, setGroups] = useState(null);
  // 分组视图：tier = 按档位（免费/轻量/中/旗舰，选模型的主维度：直接对应成本）；
  // vendor = 按厂商（同族横向比较用）。默认档位，因为「先定预算再选型号」更常见。
  const [groupMode, setGroupMode] = useState("tier");

  const list = Array.isArray(value) ? value : [];

  // 渠道编辑弹窗打开时，静默拉取候选供下拉筛选（不覆盖用户已配置的选择）
  useEffect(() => {
    if (channelId) {
      fetchModels(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId]);

  const fetchModels = async (isManual = false) => {
    // 两条路径：
    //   ① 已保存的渠道 → /channel/:id/upstream-models（能走适配器探测，含订阅渠道）；
    //   ② 新建未保存的渠道 → /channel/fetch-models，带表单里刚填的 base_url + api_key。
    //
    // 为什么必须有第 ② 条：早先只支持 ①，于是新建渠道点「从上游获取模型」只能提示
    // 「请先保存」；而后端保存时又要求「请至少选择一个模型」—— 两个校验互相锁死，
    // 管理员无路可走（实测反馈）。用户的原话是对的：填了 Key 就该能拉模型。
    const canPrefetch = !channelId && Boolean(apiKey);
    if (!channelId && !canPrefetch) {
      if (isManual) message.warning("请先填写 API Key，填好后即可直接从上游获取模型");
      return;
    }
    setBusy(true);
    setErrNote("");
    try {
      if (!channelId) {
        const resp = await API.post(
          "/channel/fetch-models",
          { base_url: baseUrl, api_key: apiKey, type: providerKey },
          { timeoutMs: 90_000 }
        );
        // 后端返回 `{ models, source, clineGroups? }`；旧版是**裸数组**，两种都要认
        //（这条分支曾经只认数组，于是新形状被当成空清单：添加渠道时明明拉到了 457 个
        //  模型，界面却显示「上游未返回模型清单」+「未探测」，分组选择器也不出现 ——
        //  管理员在这一步完全被误导。编辑渠道那条分支读的是对象，所以只有添加路径坏）。
        const arr = Array.isArray(resp) ? resp : Array.isArray(resp?.models) ? resp.models : [];
        setOptions(arr.map((m) => ({ value: m, label: m })));
        setSource((Array.isArray(resp) ? "" : resp?.source) || (arr.length ? "upstream" : "none"));
        // 目录型渠道（Cline 那种 457 个 `vendor/model`）要带上分组，否则这里会
        // 一次性全选，把旗舰档也放开（含 $600/M 的 o1-pro）
        setGroups(Array.isArray(resp) ? null : resp?.clineGroups || null);
        if (arr.length) {
          setNote(`已从上游接口拉取到 ${arr.length} 个实时模型`);
          if (isManual) {
            // 目录型渠道不自动全选：交给下面的分组按钮挑（与编辑路径同一口径）
            if (!Array.isArray(resp) && resp?.clineGroups) {
              message.info(`上游返回 ${arr.length} 个模型，已按档位/厂商分组，请用下方分组按钮挑选`);
            } else {
              onChange?.(arr);
              message.success(`已成功从上游获取并自动填入 ${arr.length} 个模型`);
            }
          }
        } else {
          setNote("上游未返回模型清单，可留空（= 该厂商全部模型）或手工输入");
          if (isManual) message.warning("上游未返回任何可用模型，可留空后直接保存");
        }
        return;
      }
      const r = await API.post(`/channel/${channelId}/upstream-models`, undefined, { timeoutMs: 90_000 });
      const models = Array.isArray(r?.models) ? r.models : [];
      setOptions(models.map((m) => ({ value: m, label: m })));
      setSource(r?.source || "none");
      // 目录型渠道（Cline：454 个 `vendor/model`）才带分组；其它渠道是 null → 退回平铺
      setGroups(r?.clineGroups || null);

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
      // **但目录型渠道例外**：Cline 那种 454 个模型的清单一次性全选，
      // 等于把 454 个模型都放开（含 $600/M 的 o1-pro），既不是用户想要的、
      // 也会让定价页瞬间多出几百个待定价项。这种情况改为提示用户用分组选择。
      if (isManual) {
        if (models.length) {
          if (r?.clineGroups) {
            message.info(`上游返回 ${models.length} 个模型，已按档位/厂商分组，请用下方分组按钮挑选`);
          } else {
            onChange?.(models);
            message.success(`已成功从上游获取并自动填入 ${models.length} 个模型`);
          }
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

  // 分组视图的当前数据（档位 / 厂商）
  const groupItems = useMemo(() => {
    if (!groups) return [];
    return groupMode === "tier" ? groups.tiers || [] : groups.groups || [];
  }, [groups, groupMode]);

  // 某个分组是否已全部选中 —— 用来把按钮文案切成「取消选择」
  const groupAllSelected = (g) => {
    const ms = g.models || [];
    return ms.length > 0 && ms.every((id) => list.includes(typeof id === "string" ? id : id.id));
  };

  // 点分组按钮：整组加选 / 整组取消（幂等，不会把别的组误删）
  const toggleGroup = (g) => {
    const ids = (g.models || []).map((m) => (typeof m === "string" ? m : m.id));
    if (!ids.length) return;
    const set = new Set(list);
    if (groupAllSelected(g)) {
      ids.forEach((id) => set.delete(id));
      message.info(`已取消「${g.label}」的 ${ids.length} 个模型`);
    } else {
      ids.forEach((id) => set.add(id));
      message.success(`已加入「${g.label}」的 ${ids.length} 个模型`);
    }
    onChange?.([...set]);
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

      {/* 分组选择（目录型渠道专属）：Cline 实测 454 个模型，平铺进多选框既选不动、
          也看不出「选中之后按什么价收费」。这里按**档位**（免费/轻量/中/旗舰，
          直接对应成本）与**厂商**两个维度各给一组按钮，点一下整组加选/取消。
          一次点击代替几十次勾选，且选之前就能看到每个档位有多少个、什么价位。
          上游没返回分组时（groups 为 null）整块不渲染，行为与从前完全一致。 */}
      {groups ? (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 6,
            padding: "8px 10px",
            border: "1px solid var(--line)",
            borderRadius: 6,
            background: "var(--surface-2, transparent)",
          }}
        >
          <Space wrap size={8} align="center">
            <Segmented
              size="small"
              value={groupMode}
              onChange={setGroupMode}
              options={[
                { label: "按档位", value: "tier" },
                { label: "按厂商", value: "vendor" },
              ]}
              disabled={disabled}
            />
            <span style={{ fontSize: 12, color: "var(--ink-3)" }}>
              共 {groups.total} 个模型
              {groups.freeCount ? `，其中 ${groups.freeCount} 个标了免费` : ""}
            </span>
          </Space>
          <Space wrap size={6}>
            {groupItems.map((g) => {
              const on = groupAllSelected(g);
              return (
                <Tooltip
                  key={g.key}
                  title={
                    // 档位给价格区间；厂商标出组内模型数 —— 两者都是「选之前想知道的事」
                    g.desc
                      ? `${g.label}：${g.desc}（${g.count} 个）`
                      : `${g.label}：${g.count} 个模型`
                  }
                >
                  <Button
                    size="small"
                    type={on ? "primary" : "default"}
                    disabled={disabled || !g.count}
                    onClick={() => toggleGroup(g)}
                    icon={on ? <CheckSquareOutlined /> : null}
                  >
                    {g.label} {g.count}
                  </Button>
                </Tooltip>
              );
            })}
          </Space>
        </div>
      ) : null}

      {/* mode="tags" 而不是 "multiple"：
          multiple 只接受**候选列表里已存在**的选项，输入自定义模型名按回车会被静默丢弃
          —— 用户以为填上了、保存了，其实模型字段仍是空的，刷新后显示「未探测」。
          而「手工输入模型名」是明确要支持的（上游探测失败时的唯一出路，
          上方 none 状态的提示也写着「支持手动输入」）。
          tags 允许任意输入成为标签，正好对应「可以是上游没列的模型」。 */}
      <Select
        mode="tags"
        allowClear
        disabled={disabled}
        value={list}
        onChange={onChange}
        placeholder="留空 = 该厂商全部模型（不限）；也可直接输入模型名后回车添加"
        options={options.length ? options : list.map((m) => ({ value: m, label: m }))}
        optionRender={(opt) => <ModelLabel model={opt.value} size={14} />}
        // tags 模式下下拉里会出现「输入的内容 + 回车」的候选项，这里过滤掉纯输入项，
        // 避免它和真实模型名混在一起（antd 用 __rc_select__ 之类的伪选项标记）
        filterOption={(input, opt) => String(opt?.value || "").toLowerCase().includes(String(input || "").toLowerCase())}
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

