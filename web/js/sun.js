// NOAA solar position (Meeus-based, as in the NOAA solar calculator). Degrees; dates are UTC instants.

const RAD = Math.PI / 180;
const DAY = 86400000;
const J2000 = 2451545;

function params(jd) {
  const T = (jd - J2000) / 36525;
  const L0 = (280.46646 + T * (36000.76983 + T * 0.0003032)) % 360;
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
  const Mr = M * RAD;
  const C = Math.sin(Mr) * (1.914602 - T * (0.004817 + 0.000014 * T)) + Math.sin(2 * Mr) * (0.019993 - 0.000101 * T) + Math.sin(3 * Mr) * 0.000289;
  const trueLong = L0 + C;
  const omega = 125.04 - 1934.136 * T;
  const lambda = trueLong - 0.00569 - 0.00478 * Math.sin(omega * RAD);
  const eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(omega * RAD);
  const decl = Math.asin(Math.sin(eps * RAD) * Math.sin(lambda * RAD)) / RAD;
  const y = Math.tan(eps * RAD / 2) ** 2;
  const L0r = L0 * RAD;
  const eqTime = 4 / RAD * (y * Math.sin(2 * L0r) - 2 * e * Math.sin(Mr) + 4 * e * y * Math.sin(Mr) * Math.cos(2 * L0r) - 0.5 * y * y * Math.sin(4 * L0r) - 1.25 * e * e * Math.sin(2 * Mr));
  return { decl, eqTime };
}

const jdOf = date => date.getTime() / DAY + 2440587.5;

// Elevation includes standard atmospheric refraction.
export function sunPosition(date, lat, lon) {
  const { decl, eqTime } = params(jdOf(date));
  const minutes = date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60 + date.getUTCMilliseconds() / 60000;
  const tst = (minutes + eqTime + 4 * lon + 1440 * 10) % 1440;
  const ha = tst / 4 - 180;
  const lr = lat * RAD, dr = decl * RAD, hr = ha * RAD;
  const cosZ = Math.min(1, Math.max(-1, Math.sin(lr) * Math.sin(dr) + Math.cos(lr) * Math.cos(dr) * Math.cos(hr)));
  const zen = Math.acos(cosZ);
  const alt = 90 - zen / RAD;
  let az;
  const sz = Math.sin(zen);
  if (sz < 1e-9) az = 180;
  else {
    const c = Math.min(1, Math.max(-1, (Math.sin(lr) * cosZ - Math.sin(dr)) / (Math.cos(lr) * sz)));
    const a = Math.acos(c) / RAD;
    az = ha > 0 ? (a + 180) % 360 : (540 - a) % 360;
  }
  let refr;
  if (alt > 85) refr = 0;
  else {
    const t = Math.tan(alt * RAD);
    if (alt > 5) refr = 58.1 / t - 0.07 / t ** 3 + 0.000086 / t ** 5;
    else if (alt > -0.575) refr = 1735 + alt * (-518.2 + alt * (103.4 + alt * (-12.79 + alt * 0.711)));
    else refr = -20.772 / t;
    refr /= 3600;
  }
  return { elevation: alt + refr, azimuth: az };
}

function solarDay(date, lon) {
  // Date.UTC midnight of the calendar day whose solar noon at `lon` is nearest `date`.
  const localMs = date.getTime() + lon / 15 * 3600000;
  const d = new Date(localMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - lon / 15 * 3600000;
}

function eventsAt(date, lat, lon, elev) {
  const base = solarDay(date, lon); // local solar midnight (UTC ms) of the day containing date
  const noonGuess = new Date(base + 12 * 3600000);
  const { eqTime } = params(jdOf(noonGuess));
  const solarNoon = new Date(base + 12 * 3600000 - eqTime * 60000);
  const lr = lat * RAD;
  const at = rising => {
    let t = solarNoon.getTime() + (rising ? -6 : 6) * 3600000;
    for (let i = 0; i < 5; i++) {
      const { decl, eqTime: eq } = params(jdOf(new Date(t)));
      const dr = decl * RAD;
      const c = (Math.sin(elev * RAD) - Math.sin(lr) * Math.sin(dr)) / (Math.cos(lr) * Math.cos(dr));
      if (c > 1 || c < -1) return null;
      const ha = Math.acos(c) / RAD * (rising ? -1 : 1);
      t = base + 12 * 3600000 + (ha * 4 - eq) * 60000;
    }
    return new Date(t);
  };
  return { rise: at(true), set: at(false), noon: solarNoon };
}

// Sunrise/sunset (sun's upper limb, -0.833 deg) for the solar day containing `date`. null at polar day/night.
export function sunTimes(date, lat, lon) {
  const e = eventsAt(date, lat, lon, -0.833);
  return { sunrise: e.rise, sunset: e.set, solarNoon: e.noon };
}

// Period when the sun is higher than minElevation; null if it never gets that high.
export function goodLightWindow(date, lat, lon, minElevation = 30) {
  const e = eventsAt(date, lat, lon, minElevation);
  return e.rise && e.set ? { start: e.rise, end: e.set } : null;
}
