import type { CSSProperties } from 'react';
const channels = (hex: string) =>
  [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16));
const hex = (rgb: number[]) =>
  '#' + rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
const contrast = (rgb: number[]) => {
  const linear = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 1.05 / (linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722 + 0.05);
};
export function organisationTheme(tint?: string): CSSProperties {
  if (!tint || !/^#[a-f\d]{6}$/i.test(tint)) return {};
  let rgb = channels(tint);
  while (contrast(rgb) < 4.5) rgb = rgb.map((v) => v * 0.9);
  return {
    '--primary': hex(rgb),
    '--primary-hover': hex(rgb.map((v) => v * 0.85)),
    '--primary-soft': hex(channels(tint).map((v) => 255 * 0.92 + v * 0.08)),
  } as CSSProperties;
}
