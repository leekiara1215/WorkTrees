export const THEME_COLORS = [
  { id: 'green', label: '绿色' },
  { id: 'blue', label: '蓝色' },
  { id: 'purple', label: '紫色' },
  { id: 'red', label: '红色' },
  { id: 'orange', label: '橙色' },
  { id: 'teal', label: '青色' },
] as const;

export type ThemeColor = typeof THEME_COLORS[number]['id'];

export const DEFAULT_THEME_COLOR: ThemeColor = 'green';

export function isThemeColor(value: unknown): value is ThemeColor {
  return THEME_COLORS.some(color => color.id === value);
}
