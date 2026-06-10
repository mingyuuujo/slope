/** GeoStudio Materials.Color = COLORREF */

/** ulong 문자열/숫자 → { r, g, b } (R + G<<8 + B<<16) */
export function geostudioULongToRgb(val) {
  if (val == null || val === "") return null;
  const n = parseInt(String(val).trim(), 10);
  if (!Number.isFinite(n)) return null;
  const r = n & 255;
  const g = (n >> 8) & 255;
  const b = (n >> 16) & 255;
  return { r, g, b };
}

export function rgbTripletToULong(r, g, b) {
  const rr = Math.max(0, Math.min(255, Math.round(Number(r))));
  const gg = Math.max(0, Math.min(255, Math.round(Number(g))));
  const bb = Math.max(0, Math.min(255, Math.round(Number(b))));
  return String(rr | (gg << 8) | (bb << 16));
}

export function colorValueToGeostudioULong(val) {
  if (val == null) return null;
  const s = String(val).trim();
  if (!s) return null;
  if (/^\d{1,10}$/.test(s)) return String(parseInt(s, 10));
  const m = s.match(/RGB\s*=\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/i);
  if (m) return rgbTripletToULong(m[1], m[2], m[3]);
  const nums = s.match(/\d+/g);
  if (nums && nums.length >= 3) return rgbTripletToULong(nums[0], nums[1], nums[2]);
  return null;
}

export function normalizeMaterialColor(text) {
  if (text == null || !String(text).trim()) return null;
  const s = String(text).trim();
  const m = s.match(/RGB\s*=\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/i);
  if (m) return `${m[1]},${m[2]},${m[3]}`;
  const nums = s.match(/\d+/g);
  if (nums && nums.length >= 3) return `${nums[0]},${nums[1]},${nums[2]}`;
  return s;
}
