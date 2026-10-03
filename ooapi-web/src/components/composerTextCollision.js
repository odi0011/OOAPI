// textarea 不提供文字矩形；用相同排版的不可见镜像测量，不能用字符数猜中文、换行和滚动位置。
export function composerTextRects(textarea) {
  if (!textarea?.value) return [];
  const box = textarea.getBoundingClientRect(), css = getComputedStyle(textarea);
  const mirror = document.createElement("div");
  mirror.setAttribute("aria-hidden", "true");
  for (const key of ["boxSizing", "fontFamily", "fontSize", "fontWeight", "fontStyle", "fontVariant", "fontStretch", "lineHeight", "letterSpacing", "wordSpacing", "textIndent", "textAlign", "textTransform", "direction", "tabSize", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth", "wordBreak", "overflowWrap"]) mirror.style[key] = css[key];
  Object.assign(mirror.style, { position: "fixed", visibility: "hidden", pointerEvents: "none", margin: "0", left: `${box.left}px`, top: `${box.top - textarea.scrollTop}px`, width: `${box.width - (textarea.offsetWidth - textarea.clientWidth - parseFloat(css.borderLeftWidth) - parseFloat(css.borderRightWidth))}px`, height: "auto", borderStyle: "solid", whiteSpace: "pre-wrap" });
  mirror.textContent = textarea.value;
  document.body.appendChild(mirror);
  try {
    const range = document.createRange(); range.selectNodeContents(mirror);
    return [...range.getClientRects()].map(r => ({ left: Math.max(r.left - textarea.scrollLeft, box.left), right: Math.min(r.right - textarea.scrollLeft, box.right), top: Math.max(r.top, box.top), bottom: Math.min(r.bottom, box.bottom) })).filter(r => r.right > r.left && r.bottom > r.top);
  } finally { mirror.remove(); }
}

export function textNearDrapedCat(textarea, anchor, clearance = 7, text = composerTextRects(textarea)) {
  if (!text.length || !anchor) return false;
  const edge = anchor.getBoundingClientRect().top;
  const viewport = anchor.querySelector(".lele-edge-viewport");
  const clip = getComputedStyle(viewport).clipPath.match(/^inset\(\S+\s+\S+\s+(-?[\d.]+)px/);
  const visibleBottom = viewport.getBoundingClientRect().bottom - Number(clip?.[1] || 0);
  return [...anchor.querySelectorAll("[data-drape-contact]")].some(part => {
    const r = part.getBoundingClientRect(), top = Math.max(edge, r.top), bottom = Math.min(r.bottom, visibleBottom);
    return bottom > top && text.some(t => t.right + clearance >= r.left && t.left - clearance <= r.right && t.bottom + clearance >= top && t.top - clearance <= bottom);
  });
}
