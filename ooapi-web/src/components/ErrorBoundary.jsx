import React from "react";
import { Button, Result, Typography } from "antd";

const { Paragraph, Text } = Typography;

/**
 * 页面级错误边界。
 *
 * 为什么必须有（真实事故，2026-09-24）：
 *   一个未定义的标识符（`getFieldValue` / `SAMPLE_MODEL` / `endpoint`）
 *   会让 React 在渲染时抛错，而**没有边界的话整棵树直接卸载** ——
 *   用户看到的是纯白页，连左侧导航都没了，「返回」都点不了。
 *   两个独立人格对同一现象的描述完全一致：
 *     ·「整页纯白，一个字都没有，连错误提示都没有」
 *     ·「网站挂了 / 我账号被封了？连导航栏都没了」
 *     · 小白人格的原话：「用户侧至少要有个错误边界说一句『页面出错了，请刷新』」
 *
 * 放在**路由外层**（见 App.jsx）：任何页面崩了都还能看到这段提示与导航，
 * 而不是白屏。开发期可以直接看到错误原文，生产期只给「刷新 + 返回首页」，
 * 避免把内部实现细节暴露给用户。
 */
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // 留在控制台供排查（用户截图给我们时能直接看到）
    console.error("[ErrorBoundary]", error, info?.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    const isDev = Boolean(import.meta.env?.DEV);
    return (
      <div style={{ padding: "48px 16px", maxWidth: 720, margin: "0 auto" }}>
        <Result
          status="warning"
          title="这个页面出错了"
          subTitle="不是你的操作问题。可以刷新重试；如果一直这样，请把下面的信息反馈给站点管理员。"
          extra={[
            <Button key="reload" type="primary" onClick={() => window.location.reload()}>
              刷新页面
            </Button>,
            <Button key="home" onClick={() => { window.location.href = "/"; }}>
              返回首页
            </Button>,
          ]}
        >
          {isDev ? (
            <>
              <Paragraph>
                <Text strong>错误信息（仅开发环境可见）：</Text>
              </Paragraph>
              <Paragraph>
                <Text code style={{ whiteSpace: "pre-wrap" }}>
                  {String(error?.stack || error?.message || error)}
                </Text>
              </Paragraph>
            </>
          ) : (
            <Paragraph type="secondary" style={{ fontSize: 12 }}>
              错误标识：{String(error?.message || error).slice(0, 120)}
            </Paragraph>
          )}
        </Result>
      </div>
    );
  }
}
