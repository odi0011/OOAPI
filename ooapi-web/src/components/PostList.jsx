// 帖子列表项 —— 社区大厅与个人主页共用
// ---------------------------------------------------------------------------
// 形态依据（Gemini 评审第 4 点）：**单列列表式，不用卡片瀑布流**。
// 开发者社区讨论的多是 Prompt 调试、网关报错日志、模型评测，
// 卡片式在宽屏上极易让长标题折行破碎，也会破坏代码块与日志的阅读连续性。
//
// 三条硬规则：
//   ① 摘要严格 2 行截断（-webkit-line-clamp: 2），完整正文只在详情页展开；
//   ② 多图不在流里展开九宫格 —— 只取前 3 张 56px 微缩图 + 「+N」；
//   ③ 阅读流由「标签 + 标题」主导，摘要与缩略图只是辅助判读。
import React from "react";
import { Tag, Skeleton, Empty, Tooltip } from "antd";
import { LikeOutlined, MessageOutlined, EyeOutlined, PushpinFilled } from "@ant-design/icons";
import { Link } from "react-router-dom";
import UserAvatar from "./UserAvatar";
import { fmtCompact } from "./Charts";
import { fmtDate } from "../services/format";

/** 相对时间：列表里「3 小时前」比完整时间戳更好判读 */
export function relTime(ts) {
  const t = Number(ts) || 0;
  if (!t) return "-";
  const diff = Math.floor(Date.now() / 1000) - t;
  if (diff < 60) return "刚刚";
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)} 天前`;
  return fmtDate(t, "YYYY-MM-DD");
}

export default function PostList({ items = [], loading, empty = "还没有帖子", onOpen, showStatus = false }) {
  if (loading) {
    return (
      <div style={{ padding: 16 }}>
        <Skeleton active paragraph={{ rows: 3 }} />
      </div>
    );
  }
  if (!items.length) {
    return (
      <div style={{ padding: "48px 0" }}>
        <Empty description={empty} image={Empty.PRESENTED_IMAGE_SIMPLE} />
      </div>
    );
  }
  return (
    <div>
      {items.map((p) => {
        const media = Array.isArray(p.media) ? p.media : [];
        const thumbs = media.slice(0, 3);
        const rest = media.length - thumbs.length;
        return (
          <div
            key={p.id}
            className="oo-post-item"
            role="button"
            tabIndex={0}
            onClick={() => onOpen?.(p)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onOpen?.(p);
              }
            }}
          >
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                {p.is_pinned ? (
                  <Tooltip title="置顶">
                    <PushpinFilled style={{ color: "var(--orange)", fontSize: 12 }} />
                  </Tooltip>
                ) : null}
                <span className="oo-post-title oo-truncate">{p.title}</span>
                {showStatus && Number(p.status) === 3 ? <Tag color="orange">已隐藏</Tag> : null}
              </div>

              {p.summary ? <div className="oo-post-summary">{p.summary}</div> : null}

              <div className="oo-post-meta">
                {p.topic ? <Tag style={{ marginInlineEnd: 0 }}>{p.topic}</Tag> : null}
                {p.author ? (
                  <Link
                    to={`/u/${p.author.id}`}
                    onClick={(e) => e.stopPropagation()}
                    style={{ display: "inline-flex", alignItems: "center", gap: 4, color: "inherit" }}
                  >
                    <UserAvatar user={p.author} size={18} />
                    <span className="oo-truncate" style={{ maxWidth: 120 }}>
                      {p.author.display_name || p.author.username}
                    </span>
                  </Link>
                ) : null}
                <span>{relTime(p.created_time)}</span>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
                  <LikeOutlined /> {fmtCompact(p.like_count || 0)}
                </span>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
                  <MessageOutlined /> {fmtCompact(p.comment_count || 0)}
                </span>
                {p.view_count !== undefined ? (
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
                    <EyeOutlined /> {fmtCompact(p.view_count || 0)}
                  </span>
                ) : null}
              </div>
            </div>

            {/* 微缩图：只在有图时出现，最多 3 张，其余用 +N 标注 */}
            {thumbs.length ? (
              <div className="oo-post-thumbs" style={{ alignSelf: "center" }}>
                {thumbs.map((m) =>
                  m.url ? (
                    <img key={m.id} src={m.url} alt="" className="oo-post-thumb" loading="lazy" />
                  ) : (
                    <span key={m.id} className="oo-thumb-more">图</span>
                  )
                )}
                {rest > 0 ? <span className="oo-thumb-more">+{rest}</span> : null}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
