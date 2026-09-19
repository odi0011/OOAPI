import React from "react";

// 统一页面头部：标题（+ 可选小标签）+ 右侧操作区
// 刻意不接受「标题下的说明小字」：解释性文案一律收进对应控件自身的提示里，
// 页头只保留标题，避免每页顶部都堆一段说明。
export default function PageHeader({ title, tags, extra }) {
  return (
    <div className="oo-page-head">
      <div style={{ minWidth: 0 }}>
        <div className="oo-page-title-row">
          <h1 className="oo-page-title">{title}</h1>
          {tags ? <div className="oo-page-tags">{tags}</div> : null}
        </div>
      </div>
      {extra ? <div className="oo-page-actions">{extra}</div> : null}
    </div>
  );
}
