/** Escape Discord markdown + neutralise mentions in untrusted text (callsigns are user-controlled). */
export function escapeDiscord(text: string): string {
  return text
    .replace(/[\\*_~`|>[\]]/g, '\\$&')
    .replace(/@/g, '@​')
    .replace(/[\u0000-\u001f\u007f]/g, '');
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`;
}

export function flagEmoji(iso2: string | null | undefined): string | null {
  if (!iso2 || !/^[A-Za-z]{2}$/.test(iso2)) return null;
  const A = 0x1f1e6;
  return String.fromCodePoint(...[...iso2.toUpperCase()].map((c) => A + c.charCodeAt(0) - 65));
}

export function mapsLink(lat: number, lon: number): string {
  return `https://www.google.com/maps?q=${lat.toFixed(5)},${lon.toFixed(5)}`;
}

export function pad3(n: number): string {
  return String(Math.trunc(n)).padStart(3, '0');
}

/** Flight level from metres. Uses the standard 100 ft = 1 FL convention on geometric altitude (not pressure-corrected). */
export function flightLevel(altMeters: number): string {
  const ft = altMeters / 0.3048;
  const fl = Math.round(ft / 100);
  return `FL${fl < 0 ? '-' + pad3(Math.abs(fl)) : pad3(fl)}`;
}
