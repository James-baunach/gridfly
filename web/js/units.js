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

// ---------- Speed (m/s <-> mph) ----------

export const MPH = 0.44704; // metres per second in one mile per hour

export const toSpeed = (ms, unit) => unit === 'ft' ? ms / MPH : ms;
export const fromSpeed = (v, unit) => unit === 'ft' ? v * MPH : v;
export const speedUnit = unit => unit === 'ft' ? 'mph' : 'm/s';
export const fmtSpeed = (ms, unit, digits = 1) => `${toSpeed(ms, unit).toFixed(digits)} ${speedUnit(unit)}`;

// ---------- Area (hectares in metric, acres in feet mode) ----------

export const ACRE = 4046.8564224; // square metres

export function fmtArea(m2, unit) {
  if (unit === 'ft') {
    if (m2 >= 640 * ACRE) return `${(m2 / (640 * ACRE)).toFixed(2)} sq mi`;
    return m2 >= ACRE / 4 ? `${(m2 / ACRE).toFixed(m2 >= 10 * ACRE ? 1 : 2)} acres` : `${Math.round(m2 / (FT * FT))} sq ft`;
  }
  return m2 >= 1e6 ? `${(m2 / 1e6).toFixed(2)} km²` : m2 >= 1e3 ? `${(m2 / 1e4).toFixed(m2 >= 1e5 ? 1 : 2)} ha` : `${Math.round(m2)} m²`;
}

// ---------- Ground detail (stored as cm per pixel, shown as inches per pixel in feet mode) ----------

export const toGsd = (cm, unit) => unit === 'ft' ? cm / 2.54 : cm;
export const fromGsd = (v, unit) => unit === 'ft' ? v * 2.54 : v;
export const gsdUnit = unit => unit === 'ft' ? 'in' : 'cm';

// ---------- Unit-aware inputs ----------
// Every input marked data-len, data-speed or data-gsd holds a metric value (metres, m/s, cm per pixel)
// that is shown in the chosen unit. This table says how each kind converts and how many decimals it shows.

export const QTY = {
  len: { attr: 'len', cls: 'u-len', to: toDisplay, from: fromDisplay, label: lenUnit, decimals: u => u === 'ft' ? 0 : 1 },
  speed: { attr: 'speed', cls: 'u-speed', to: toSpeed, from: fromSpeed, label: speedUnit, decimals: () => 1 },
  gsd: { attr: 'gsd', cls: 'u-gsd', to: toGsd, from: fromGsd, label: gsdUnit, decimals: u => u === 'ft' ? 2 : 1 },
};

/** The text an input shows for the metric value `si`. */
export const qtyText = (kind, si, unit) => String(+QTY[kind].to(si, unit).toFixed(QTY[kind].decimals(unit)));
