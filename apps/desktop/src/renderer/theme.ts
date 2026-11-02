export type ThemePref = 'system' | 'dark' | 'light';

const KEY = 'openferry.theme';

export function loadTheme(): ThemePref {
  const stored = window.localStorage.getItem(KEY);
  return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'system';
}

export function saveTheme(pref: ThemePref): void {
  window.localStorage.setItem(KEY, pref);
  applyTheme(pref);
}

/** 把偏好解析成实际主题。CSS 只有两个令牌块，不依赖媒体查询。 */
export function applyTheme(pref: ThemePref): void {
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const dark = pref === 'dark' || (pref === 'system' && prefersDark);
  document.documentElement.dataset['theme'] = dark ? 'dark' : 'light';
}

export function watchSystemTheme(getPref: () => ThemePref): () => void {
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const onChange = (): void => applyTheme(getPref());
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}
