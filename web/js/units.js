// Metres <-> feet conversion and display formatting. All internal values are metres.

export const FT = 0.3048;

export const toDisplay = (m, unit) => unit === 'ft' ? m / FT : m;
export const fromDisplay = (v, unit) => unit === 'ft' ? v * FT : v;
export const lenUnit = unit => unit === 'ft' ? 'ft' : 'm';

export function fmtLen(m, unit, digits = 0) {
  return `${toDisplay(m, unit).toFixed(digits)} ${lenUnit(unit)}`;
}

// Longer distances: km / miles when large, else m / ft.
export function fmtDistance(m, unit) {
  if (unit === 'ft') return m >= 1609.344 ? `${(m / 1609.344).toFixed(2)} mi` : `${Math.round(m / FT)} ft`;
  return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`;
}

// Ground sample distance (cm per pixel) -> short size text.
export function fmtSmall(cm, unit) {
  if (unit === 'ft') return `${(cm / 2.54).toFixed(cm < 2.54 ? 2 : 1)} in`;
  return `${cm.toFixed(cm < 10 ? 1 : 0)} cm`;
}

// Rounds a metres value so that it looks tidy in the chosen unit (e.g. 91.44 m -> 300 ft).
export function tidy(m, unit, step = 1) {
  return fromDisplay(Math.round(toDisplay(m, unit) / step) * step, unit);
}
