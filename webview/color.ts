// Turning computed CSS colors into the #rrggbb strings that <input type=color> and Mermaid accept.

type Rgba = [number, number, number, number];

function alpha(value: string | undefined): number {
  if (value === undefined) return 1;
  return value.endsWith('%') ? Number(value.slice(0, -1)) / 100 : Number(value);
}

/** Parses a computed color: rgb(), rgba() or color(srgb ...), the forms getComputedStyle returns. */
export function parseColor(color: string): Rgba | undefined {
  const srgb = /^color\(srgb\s+([\d.e+-]+)\s+([\d.e+-]+)\s+([\d.e+-]+)(?:\s*\/\s*([\d.e+-]+%?))?/.exec(color);
  if (srgb) return [Number(srgb[1]) * 255, Number(srgb[2]) * 255, Number(srgb[3]) * 255, alpha(srgb[4])];
  const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?/.exec(color);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3]), alpha(m[4])];
  return undefined;
}

/**
 * Converts a computed color to #rrggbb. A translucent color is composited over `backdrop` (itself a
 * computed color) when one is given, otherwise its alpha is dropped. Unparseable colors give black.
 */
export function toHex(color: string, backdrop?: string): string {
  const c = parseColor(color);
  if (!c) return '#000000';
  let rgb = c.slice(0, 3);
  const under = backdrop !== undefined && c[3] < 1 ? parseColor(backdrop) : undefined;
  if (under) rgb = rgb.map((v, i) => v * c[3] + under[i] * (1 - c[3]));
  return '#' + rgb.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('');
}
