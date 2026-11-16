// Target-based planning: work out the flying height that gives a wanted ground detail, or the lowest
// height whose plan still fits in the batteries you have. Pure functions (the real planner is passed in).

export const ALT_MIN = 5;   // same limits as the Height box
export const ALT_MAX = 500;

/** Flying height (m) that gives `gsdCm` centimetres per pixel with this camera. The inverse of gridMetrics().gsd. */
export const altForGsd = (cam, gsdCm) => gsdCm * cam.focal * cam.imageW / (cam.sensorW * 100);

/** Keeps a height inside the limits. `clamped` says which limit was hit, or null. */
export function clampAlt(alt, min = ALT_MIN, max = ALT_MAX) {
  if (alt < min) return { alt: min, clamped: 'low' };
  if (alt > max) return { alt: max, clamped: 'high' };
  return { alt, clamped: null };
}

/** Height for a detail target, rounded to `step` metres, plus a flag when it had to be clamped. */
export function solveForDetail(cam, gsdCm, { step = 1, min = ALT_MIN, max = ALT_MAX } = {}) {
  if (!(gsdCm > 0)) return null;
  const raw = altForGsd(cam, gsdCm);
  const c = clampAlt(raw, min, max);
  const alt = c.clamped ? c.alt : Math.min(max, Math.max(min, Math.round(raw / step) * step));
  return { alt, raw, clamped: c.clamped };
}

/** The battery search stops here: about 400 ft, the usual legal ceiling. */
export const ALT_BATTERY_MAX = 120;

/**
 * Lowest height (best detail) whose plan fits in `batteries` missions.
 * `missionsAt(alt)` runs the real planner and returns the number of missions (Infinity if impossible).
 * A higher flight usually needs fewer missions, but not always (the climb and the edge margin grow with
 * height), so this scans down from the top in coarse steps and then refines, instead of bisecting.
 * Returns { fits, alt, missions }. When nothing fits, alt is the maximum and missions the fewest found.
 */
export function solveForBatteries(batteries, missionsAt, { step = 1, min = ALT_MIN, max = ALT_BATTERY_MAX, coarse = 5 } = {}) {
  const lo0 = Math.ceil(min / step - 1e-9), hi0 = Math.floor(max / step + 1e-9);
  const at = k => k * step;
  const jump = Math.max(1, Math.round(coarse / step));
  let best = null, fewest = Infinity;
  for (let k = hi0; k >= lo0; k -= jump) {
    const n = missionsAt(at(k));
    if (n < fewest) fewest = n;
    if (n <= batteries) best = { k, n };
    else if (n === Infinity) break; // already too big to plan; lower is worse
  }
  if (!best) return { fits: false, alt: at(hi0), missions: fewest };
  for (let k = best.k - 1; k > best.k - jump && k >= lo0; k--) {
    const n = missionsAt(at(k));
    if (n <= batteries) best = { k, n }; else break;
  }
  return { fits: true, alt: at(best.k), missions: best.n };
}
