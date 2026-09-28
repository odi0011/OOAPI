// 帖子列表项 —— 社区大厅与个人主页共用（第 80 批重排）
// ---------------------------------------------------------------------------
// 仍然是**单列列表式**（不用卡片瀑布流：开发者社区的长标题、日志、代码片段在卡片里会折行破碎）。
// 这次调整的是行内的信息排布，参照 Discourse / V2EX / GitHub Discussions 的通行做法：
//
//   [头像] 标题（置顶/状态）                              ┌──┐
//          摘要（最多 2 行）                               │12│ ← 回复数：固定右列，扫一眼就知道哪帖在热议
//          [微缩图 ×3]                                     └──┘
//          [话题] 作者 · 3 小时前 · 赞 · 浏览 · 「XX 5 分钟前回复」
//
// 原排布的问题（用户：「帖子目前这种排列方式是否不方便观看」）：
//   ① 作者头像 18px 挤在元信息行里，扫列表时分不清是谁发的；
//   ② 话题是一个灰色小 Tag，与作者/时间混在一起，几乎看不见；
//   ③ 缩略图有时出现在右侧有时没有，右边缘参差不齐，眼睛没有稳定的落点；
//   ④ 只有发帖时间，看不出「这帖刚有人回复」—— 讨论区最重要的活跃信号缺失。
// 三条硬规则保留：摘要 2 行截断；多图只给 3 张微缩图 + N；阅读流由标题主导。
import React from "react";
import { Tag, Skeleton, Empty, Tooltip } from "antd";
import { LikeOutlined, EyeOutlined, PushpinFilled, PictureOutlined } from "@ant-design/icons";
import { Link } from "react-router-dom";
import UserAvatar from "./UserAvatar";
import TopicIcon from "./TopicIcon";
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

export default function PostList({ items = [], loading, empty = "还没有帖子", onOpen, showStatus = false, onTopic }) {
  if (loading) {
    return (
      <div style={{ padding: 16 }}>
        <Skeleton avatar active paragraph={{ rows: 2 }} />
        <Skeleton avatar active paragraph={{ rows: 2 }} />
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
    <div className="oo-post-list">
      {items.map((p) => {
        const media = Array.isArray(p.media) ? p.media : [];
        const thumbs = media.slice(0, 3);
        const rest = media.length - thumbs.length;
        const replied = Number(p.last_reply_user_id) > 0 && Number(p.last_reply_time) > Number(p.created_time);
        const hotReplies = (p.comment_count || 0) >= 10;
        return (
          <article
            key={p.id}
            className={`oo-post-item${p.is_pinned ? " is-pinned" : ""}`}
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
            {p.author ? (
              <Link
                to={`/u/${p.author.id}`}
                className="oo-post-avatar"
                onClick={(e) => e.stopPropagation()}
                aria-label={`${p.author.display_name || p.author.username} 的主页`}
              >
                <UserAvatar user={p.author} size={38} />
              </Link>
            ) : (
              <span className="oo-post-avatar" />
            )}

            <div className="oo-post-main">
              <h3 className="oo-post-title">
                {p.is_pinned ? (
                  <Tooltip title="置顶">
                    <PushpinFilled className="oo-post-pin" />
                  </Tooltip>
                ) : null}
                <span>{p.title}</span>
                {/* 作者自己的已删/隐藏帖也会出现在自己的流里（后端 visibilityClause 的有意设计），
                    必须标出状态，否则看起来像「删除没生效」（三个人格都报过） */}
                {showStatus && Number(p.status) === 2 ? <Tag color="red">已删除</Tag> : null}
                {showStatus && Number(p.status) === 3 ? <Tag color="orange">已隐藏</Tag> : null}
              </h3>

              {p.summary ? <p className="oo-post-summary">{p.summary}</p> : null}

              {thumbs.length ? (
                <div className="oo-post-thumbs">
                  {thumbs.map((m) =>
                    m.url ? (
                      <img key={m.id} src={m.url} alt="" className="oo-post-thumb" loading="lazy" />
                    ) : (
                      <span key={m.id} className="oo-thumb-more"><PictureOutlined /></span>
                    )
                  )}
                  {rest > 0 ? <span className="oo-thumb-more">+{rest}</span> : null}
                </div>
              ) : null}

              <div className="oo-post-meta">
                {p.topic ? (
                  <button
                    type="button"
                    className="oo-post-topic"
                    onClick={(e) => {
                      if (!onTopic) return;
                      e.stopPropagation();
                      onTopic(p.topic_id);
                    }}
                    tabIndex={onTopic ? 0 : -1}
                  >
                    <TopicIcon icon={p.topic_icon} imageUrl={p.topic_image_url} size={14} plain />
                    {p.topic}
                  </button>
                ) : null}
                {p.author ? <span className="oo-post-author">{p.author.display_name || p.author.username}</span> : null}
                <span title={fmtDate(p.created_time, "YYYY-MM-DD HH:mm")}>{relTime(p.created_time)}</span>
                {p.like_count ? (
                  <span className="oo-post-stat"><LikeOutlined /> {fmtCompact(p.like_count)}</span>
                ) : null}
                {p.view_count ? (
                  <span className="oo-post-stat"><EyeOutlined /> {fmtCompact(p.view_count)}</span>
                ) : null}
                {replied ? (
                  <span className="oo-post-last">
                    {p.last_reply_name || "有人"} {relTime(p.last_reply_time)}回复
                  </span>
                ) : null}
              </div>
            </div>

            <div className={`oo-post-replies${p.comment_count ? "" : " is-zero"}${hotReplies ? " is-hot" : ""}`} aria-label={`${p.comment_count || 0} 条回复`}>
              <b>{fmtCompact(p.comment_count || 0)}</b>
              <span>回复</span>
            </div>
          </article>
        );
      })}
    </div>
  );
}
