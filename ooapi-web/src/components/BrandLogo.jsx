import React, { useState } from 'react';
import { useApp } from '../context/AppContext';
import { brandImageUrl, DEFAULT_LOGO } from '../services/branding';

export default function BrandLogo({ size = 24, src, alt = '', style, ...props }) {
  const { status } = useApp();
  const source = brandImageUrl(src === undefined ? status?.logo : src);
  const [failed, setFailed] = useState('');
  return <img {...props} data-brand-logo="true" src={failed === source ? DEFAULT_LOGO : source} alt={alt}
    width={size} height={size} draggable={false} onError={() => setFailed(source)}
    style={{ width: size, height: size, objectFit: 'contain', flexShrink: 0, verticalAlign: 'middle', ...style }} />;
}

export function BrandName() {
  const { status } = useApp();
  return status?.system_name || 'OOAPI';
}
