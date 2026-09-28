// 社区话题图标（第 80 批）：内置图标 或 自定义图片，不再用 emoji
// ---------------------------------------------------------------------------
// 用户原话：「不要拿 emoji 啊，要么就给社区分类加一个 img 标签……两者都可选也行」。
// emoji 的问题：各系统字形不同（Windows 上是扁平黑白、Mac 上是彩色）、大小对不齐、
// 与站内线性图标风格冲突。这里两种来源：
//   · icon：内置 key → AntD 线性图标（key 白名单与后端 routes/community.js#TOPIC_ICON_KEYS 一致）
//   · image_url：管理员上传的图片（优先）
// 颜色按 key 派生一个固定色相，同一个话题在任何页面颜色都一样。
import React, { useState } from "react";
import {
  MessageOutlined, BugOutlined, ExperimentOutlined, ApiOutlined, CoffeeOutlined, BulbOutlined,
  NotificationOutlined, RocketOutlined, BookOutlined, ToolOutlined, CodeOutlined, RobotOutlined,
  CloudServerOutlined, PictureOutlined, QuestionCircleOutlined, StarOutlined, FireOutlined,
  TeamOutlined, SafetyOutlined, GiftOutlined, TagOutlined,
} from "@ant-design/icons";

export const TOPIC_ICONS = [
  { key: "chat", label: "讨论", icon: <MessageOutlined />, hue: 220 },
  { key: "question", label: "问答", icon: <QuestionCircleOutlined />, hue: 200 },
  { key: "bug", label: "问题反馈", icon: <BugOutlined />, hue: 8 },
  { key: "lab", label: "评测", icon: <ExperimentOutlined />, hue: 275 },
  { key: "plug", label: "接入", icon: <ApiOutlined />, hue: 170 },
  { key: "api", label: "服务", icon: <CloudServerOutlined />, hue: 190 },
  { key: "code", label: "代码", icon: <CodeOutlined />, hue: 240 },
  { key: "robot", label: "模型", icon: <RobotOutlined />, hue: 260 },
  { key: "bulb", label: "技巧", icon: <BulbOutlined />, hue: 45 },
  { key: "book", label: "教程", icon: <BookOutlined />, hue: 150 },
  { key: "tool", label: "工具", icon: <ToolOutlined />, hue: 30 },
  { key: "rocket", label: "发布", icon: <RocketOutlined />, hue: 330 },
  { key: "notice", label: "公告", icon: <NotificationOutlined />, hue: 15 },
  { key: "image", label: "作品", icon: <PictureOutlined />, hue: 300 },
  { key: "star", label: "精选", icon: <StarOutlined />, hue: 40 },
  { key: "fire", label: "热门", icon: <FireOutlined />, hue: 20 },
  { key: "team", label: "交友", icon: <TeamOutlined />, hue: 185 },
  { key: "shield", label: "安全", icon: <SafetyOutlined />, hue: 135 },
  { key: "gift", label: "活动", icon: <GiftOutlined />, hue: 350 },
  { key: "coffee", label: "闲聊", icon: <CoffeeOutlined />, hue: 25 },
];
const BY_KEY = Object.fromEntries(TOPIC_ICONS.map((x) => [x.key, x]));

/**
 * @param {object} props
 * @param {string} props.icon       内置图标 key
 * @param {string} props.imageUrl   自定义图片（优先）
 * @param {number} props.size       边长 px
 * @param {boolean} props.plain     只画图标、不带底色块（行内小尺寸用）
 */
export default function TopicIcon({ icon, imageUrl, size = 20, plain = false, title }) {
  const [broken, setBroken] = useState(false);
  const def = BY_KEY[icon];
  const style = { width: size, height: size, fontSize: Math.round(size * (plain ? 0.9 : 0.56)) };
  if (imageUrl && !broken) {
    return (
      <span className="oo-topic-ico is-image" style={style} title={title}>
        <img src={imageUrl} alt="" onError={() => setBroken(true)} />
      </span>
    );
  }
  const hue = def?.hue ?? 220;
  return (
    <span
      className={`oo-topic-ico${plain ? " is-plain" : ""}`}
      style={{ ...style, "--hue": hue }}
      title={title}
      aria-hidden={title ? undefined : "true"}
    >
      {def?.icon || <TagOutlined />}
    </span>
  );
}
