// 用户头像 —— 全站统一口径
// ---------------------------------------------------------------------------
// 设计：不引入外部头像库（Boring Avatars / DiceBear 之类），而是用「用户名 → 稳定色相」
// 生成首字母头像。理由：
//   1. 头像要在日志列表里成百上千次渲染，外部库的 SVG 生成成本与体积都不划算；
//   2. 同一个人在任何页面必须是同一个颜色（可辨识），所以色相只能由稳定字段派生，
//      不能用随机数或索引；
//   3. 用户没上传头像时也不该出现「灰色小方块」这种一眼像坏数据的占位。
// 上传的自定义头像（avatar 字段）优先，加载失败自动回退到首字母。
import React from "react";
import { Avatar } from "./arc/avatar/avatar";
import { useApp } from "../context/AppContext";

/** 由用户标识派生稳定色相（0-359）。种子只用稳定字段：id 优先，其次用户名。 */
export function hueOf(seed) {
  const s = String(seed ?? "");
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    // 简单 FNV 变体：够分散，且同一输入永远同值
    h = (h * 31 + s.charCodeAt(i)) % 360;
  }
  return h;
}

/** 取展示名（显示名优先，其次用户名），空值统一回 "?" */
export function displayNameOf(userOrName) {
  if (userOrName && typeof userOrName === "object") {
    return String(userOrName.display_name || userOrName.username || "").trim();
  }
  return String(userOrName || "").trim();
}

/**
 * 头像。
 * @param {object} props
 * @param {object|string} props.user   用户对象（含 id/username/display_name/avatar）或直接给名字
 * @param {number} props.size          像素尺寸
 * @param {boolean} props.showName     是否在右侧显示名字
 * @param {string} props.nameClass     名字的 class（便于各页控制字号）
 */
export default function UserAvatar({ user, size = 24, showName = false, nameClass = "", style, title }) {
  const { user: currentUser } = useApp();
  const id = typeof user === "object" ? user?.id ?? user?.user_id : null;

  const name = displayNameOf(user);
  // 优先用后端下发的 avatar_url（媒体库里的真实头像，URL 带 v= 版本号）；
  // 回退到调用方直接传的 avatar 字段（例如日志页从别处拿到的地址）。
  // 两者都没有 / 加载失败 → 走下面的首字母色块（无头像时的默认表现）。
  const avatar =
    id && Number(id) === Number(currentUser?.id) ? String(currentUser.avatar_url || "") : typeof user === "object" ? String(user?.avatar_url || user?.avatar || "") : "";

  const seed = typeof user === "object" ? id ?? user?.username : user;
  const hue = hueOf(seed);


  const box = <Avatar key={avatar} src={avatar || undefined} name={name || "?"} title={title || name} style={{width:size,height:size,flexShrink:0,background:`hsl(${hue} 62% 88%)`,color:`hsl(${hue} 55% 32%)`,fontSize:Math.max(9,Math.round(size*.44)),...style}}/>;

  if (!showName) return box;
  return (
    <span className="oo-user-label" style={{ display: "inline-flex", alignItems: "center", gap: 8, minWidth: 0, maxWidth: "100%" }}>
      {box}
      <span className={`oo-truncate ${nameClass}`} title={name || "未知用户"} style={{ minWidth: 0, display: "block", flex: "1 1 auto" }}>{name || "未知用户"}</span>
    </span>
  );
}
