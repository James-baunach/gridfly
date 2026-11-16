// Motion blur: while the drone moves during the exposure, the picture smears across some pixels.
// blur (px) = ground speed x exposure time / ground sample distance.

export const SHUTTERS = [1000, 1250, 1600, 2000, 2500, 3200, 4000, 5000, 6400, 8000]; // 1/x s
export const SLOWEST = 1000;   // never suggest slower than 1/1000 s
export const WARN_AT = 2000;   // warn when the shutter has to be faster than 1/2000 s

/** Blur in pixels for a speed (m/s), exposure (s) and detail (cm per pixel). */
export const blurPixels = (speed, exposure, gsdCm) => speed * exposure / (gsdCm / 100);

/** Photos are taken on the move when flying through points or on a timer. */
export const movingPhotos = ({ turnMode, captureMode }) =>
  captureMode === 'timer' || turnMode === 'straight-pass' || turnMode === 'curved';

/**
 * The shutter that keeps blur under `maxBlur` pixels, as the number x in 1/x s (never slower than 1/1000).
 * `exact` is the raw figure; `denominator` is the next standard setting, or the exact figure above 1/8000.
 * Returns null when the drone is stopped for each photo (no blur) or the inputs are unusable.
 */
export function neededShutter({ speed, gsdCm, moving = true, maxBlur = 1 }) {
  if (!moving || !(speed > 0) || !(gsdCm > 0)) return null;
  const exact = speed / (maxBlur * gsdCm / 100); // 1 / longest allowed exposure
  const denominator = exact <= SLOWEST ? SLOWEST : SHUTTERS.find(d => d >= exact - 1e-9) ?? Math.ceil(exact);
  return { exact, denominator, tooFast: denominator > WARN_AT, beyondCamera: exact > SHUTTERS.at(-1) };
}

/** The fastest speed (m/s) that stays under `maxBlur` pixels at 1/1000 s, rounded down to 0.1. */
export const speedForShutter = (gsdCm, shutter = SLOWEST, maxBlur = 1) => Math.floor(maxBlur * gsdCm / 100 * shutter * 10) / 10;
