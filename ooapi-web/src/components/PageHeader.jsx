import React from "react";

// 统一页面头部：标题（+ 可选小标签）+ 描述 + 右侧操作区
// 所有页面必须使用，保证标题层级和间距一致
export default function PageHeader({ title, desc, tags, extra }) {
  return (
    <div className="oo-page-head">
      <div style={{ minWidth: 0 }}>
        <div className="oo-page-title-row">
          <h1 className="oo-page-title">{title}</h1>
          {tags ? <div className="oo-page-tags">{tags}</div> : null}
        </div>
        {desc ? <p className="oo-page-desc">{desc}</p> : null}
      </div>
      {extra ? <div className="oo-page-actions">{extra}</div> : null}
    </div>
  );
}
