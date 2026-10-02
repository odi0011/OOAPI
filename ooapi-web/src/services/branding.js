export const DEFAULT_LOGO = '/logo.jpg';

// Logo 与 favicon 只接受图片来源地址，空值统一回落到站点默认标识。
export function brandImageUrl(value, fallback = DEFAULT_LOGO) {
  const url = String(value || '').trim();
  if (!url) return fallback;
  if (/^data:image\/(png|jpeg|webp|gif|svg\+xml);base64,/i.test(url)) return url;
  try {
    const parsed = new URL(url, window.location.origin);
    return ['http:', 'https:'].includes(parsed.protocol) ? url : fallback;
  } catch { return fallback; }
}
