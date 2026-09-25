import React, { useCallback, useEffect, useState } from "react";
import { Table, Input, Tag, Alert, App as AntApp } from "antd";
import { API } from "../services/api";
import { useApp } from "../context/AppContext";
import PageHeader from "../components/PageHeader";
import { ModelLabel } from "../components/VendorIcon";
import { CURRENCY_NAME, unitsPerOd } from "../services/format";

/**
 * 模型价格表（用户端只读）
 *
 * 为什么要这一页（人格实测报的，独立开发者人格）：
 *   「价格表完全找不到 —— /pricing、/models、/console/pricing、/price
 *     全被弹回首页，/api/pricing 要管理员权限。所以我只能反推实际扣费，
 *     **无法核对『标价』与『实收』是否一致**。
 *     对一个会认真比价的用户来说这是硬伤。」
 *
 * 而后台设置项 `expose_pricing_to_user`（默认开）早就存在、也早就在
 * /api/status 里下发了，只是**没有页面消费它**。（这也是第二次遇到
 * 「设置项存在但前端没接」——第一次是 expose_pricing_to_user 同名的
 * 首页开关，见 AI协作.md 的登记。）
 *
 * 这里只展示**单价**，供用户估算成本与比价；成本、倍率、上游来源
 * 属于管理端信息，不在这里暴露。
 */
export default function PricingPage() {
  const { status } = useApp();
  const { message } = AntApp.useApp();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);
  const [q, setQ] = useState("");
  const perUnit = unitsPerOd(status);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await API.get("/pricing/public");
      setItems(Array.isArray(d?.items) ? d.items : []);
      setDenied(false);
    } catch (e) {
      // 403 = 管理员把「向用户展示定价」关了：这不是错误，是配置，给一句说明即可
      if (e.status === 403) setDenied(true);
      else message.error(e.message || "价格加载失败");
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    load();
  }, [load]);

  if (denied) {
    return (
      <div className="oo-page">
        <PageHeader title="模型价格" />
        <Alert
          type="info"
          showIcon
          message="管理员未开启价格公示"
          description="可以在「使用记录」里查看每次调用的实际扣费；若需要完整价目表，请联系站点管理员。"
        />
      </div>
    );
  }

  const kw = q.trim().toLowerCase();
  const rows = kw ? items.filter((m) => String(m.model).toLowerCase().includes(kw)) : items;

  const columns = [
    {
      title: "模型",
      dataIndex: "model",
      render: (v) => <ModelLabel model={v} size={14} />,
    },
    {
      title: "输入（每百万 token）",
      dataIndex: "input",
      width: 180,
      sorter: (a, b) => Number(a.input) - Number(b.input),
      render: (v) => <span className="oo-num">{Number(v) || 0} {CURRENCY_NAME}</span>,
    },
    {
      title: "输出（每百万 token）",
      dataIndex: "output",
      width: 180,
      sorter: (a, b) => Number(a.output) - Number(b.output),
      render: (v) => <span className="oo-num">{Number(v) || 0} {CURRENCY_NAME}</span>,
    },
    {
      title: "缓存命中（每百万 token）",
      dataIndex: "cache",
      width: 190,
      render: (v) =>
        v ? (
          <span className="oo-num">{Number(v)} {CURRENCY_NAME}</span>
        ) : (
          <span style={{ color: "var(--ink-3)" }}>—</span>
        ),
    },
  ];

  return (
    <div className="oo-page">
      <PageHeader
        title="模型价格"
        tags={
          <span style={{ fontSize: 12.5, color: "var(--ink-3)" }}>
            {/* 币值必须写出来。Round 4 子线实测（第 92 轮）：5 个人格、去重后 330 条发言
                在问「OD币到底值多少 / 0.0088 是八分还是八毛 / 得知道我充值比例才能算」。
                这里原来只写了「= 10000 额度」，那是**额度单位**的换算，不是币值 ——
                用户看完仍然不知道一个币值多少钱。补上 1:1 的美元锚点即可自算，
                不引入人民币汇率（全站硬约束：币制只有一条规则）。 */}
            共 {items.length} 个模型 · 单价按每百万 token 计 · 1 {CURRENCY_NAME} = {Number(perUnit).toLocaleString()} 额度
            （1 {CURRENCY_NAME} = 1 美元）
          </span>
        }
      />
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="这里的单价用于估算；每次调用的实际扣费以「使用记录」为准"
        description={
          <>
            实际扣费 = 提示 tokens × 输入单价 + 补全 tokens × 输出单价
            （命中缓存的部分按缓存单价），再乘上你所用分组的倍率。
            {/* 这句话原来是个死胡同：让用户「乘上分组的倍率」，却没说去哪看自己的倍率。
                Round 4 子线实测（第 92 轮，4/5 人格、去重 68 条）：
                  「那个『分组倍率』是啥我根本没找着，光有单价没用啊」
                  「两边加完再乘我那个分组的倍率。不过我现在不知道自己的分组倍率是多少」

                第 93 轮又发现：只写「悬浮分组名」不够 —— 手机上没有悬浮这回事，
                而且窄屏下令牌列表的「分组」列整列被 responsive 收起（TokenPage 该列
                是 responsive: ["lg"]）。实测 390px 下表头只剩「名称/复制/状态/额度/操作」，
                按这句话去手机上找，是找不到的（子线原话：「我点了半天没找着」）。
                所以给两条路径，其中手机那条是实测可达的：创建令牌的分组下拉里
                每个分组右侧直接带 ×N 徽章（触屏可点、文字可读）。 */}
            （你的分组倍率在「令牌管理」页可以查到：电脑上悬浮密钥的「分组」标签，
            手机上点「创建令牌」看分组下拉 —— 每个分组后面直接标着
            <b> ×N</b>；<b>没标倍率就是 ×1、不加价</b>。）
            高峰/非高峰时段的价格可能不同，具体以调用当时的扣费为准。
          </>
        }
      />
      <div style={{ marginBottom: 12, maxWidth: 320 }}>
        <Input.Search placeholder="搜索模型名" allowClear value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <Table
        className="oo-table"
        rowKey="model"
        loading={loading}
        size="small"
        columns={columns}
        dataSource={rows}
        pagination={{ pageSize: 20, showSizeChanger: true, pageSizeOptions: [20, 50, 100], showTotal: (t) => `共 ${t} 个模型` }}
      />
    </div>
  );
}
