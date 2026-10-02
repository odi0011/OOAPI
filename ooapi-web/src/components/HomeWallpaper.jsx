import React, { useState } from 'react';
import { useApp } from '../context/AppContext';
import { useTheme } from '../theme/ThemeContext';
import { HOME_WALLPAPERS, homeWallpaperUrl } from '../services/home-wallpaper';

export function WallpaperImage({ value, mode, ...props }) {
  const source = homeWallpaperUrl(value, mode);
  const [failedSource, setFailedSource] = useState('');
  const fallback = HOME_WALLPAPERS[mode] || HOME_WALLPAPERS.light;
  // 错误关联当前地址；管理员更换地址或主题后可以再次加载，避免错误状态粘住。
  return <img {...props} src={failedSource === source ? fallback : source} alt="" decoding="async"
    referrerPolicy="no-referrer" onError={() => setFailedSource(source)} />;
}

export default function HomeWallpaper() {
  const { status } = useApp();
  const { resolved } = useTheme();
  const mode = resolved === 'dark' ? 'dark' : 'light';
  return <div className="studio-desktop-wallpaper" aria-hidden="true" data-wallpaper-mode={mode}>
    <WallpaperImage value={status?.[`home_background_${mode}`]} mode={mode} />
  </div>;
}
