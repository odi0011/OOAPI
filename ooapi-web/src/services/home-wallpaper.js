export const HOME_WALLPAPERS = {
  light: '/illustrations/home-day.webp',
  dark: '/illustrations/home-night.webp',
};

export function homeWallpaperUrl(value, mode = 'light') {
  const fallback = HOME_WALLPAPERS[mode] || HOME_WALLPAPERS.light;
  const source = String(value || '').trim();
  if (!source || source.length > 4096 || /[\s\\]/.test(source)) return fallback;
  if (/^\/(?!\/)/.test(source)) return source;
  try {
    const url = new URL(source);
    if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) return source;
  } catch { /* 与设置接口保持一致，旧配置中的无效地址回落到内置图片。 */ }
  return fallback;
}
