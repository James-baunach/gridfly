// Pre-flight checklist with numbers worked out for this specific mission, in beginner language.

import { haversine } from './geo.js';

const MB_PER_PHOTO = 12; // Mavic 3 family 4/3 Hasselblad 20 MP JPEG, typical
const DRONES = { mavic3: 'Mavic 3', mavic3classic: 'Mavic 3 Classic', mavic3pro: 'Mavic 3 Pro' };
const CONTROLLERS = {
  rc: 'DJI RC', rc2: 'DJI RC 2', 'rcn-android': 'RC-N1/N3 with an Android phone', 'rcn-ios': 'RC-N1/N3 with an iPhone',
};
const LEVEL_MARK = { todo: '[ ]', info: '(i)', warn: '(!)', stop: '(STOP)' };

const ceilTo = (v, step) => Math.ceil(v / step - 1e-9) * step;
const item = (text, level = 'todo', extra = {}) => ({ text, level, ...extra });

export function buildChecklist(ctx) {
  const { missions = [], home, homeGround = null, droneKey = 'mavic3', controller = 'rc', captureMode = 'waypoint', interval = null, alt, gsd, photoCount = 0, finishAction } = ctx;
  const drone = DRONES[droneKey] || 'Mavic 3';
  const pts = missions.flatMap(m => m.points || []);
  const heights = pts.map(p => p.height);
  const maxH = heights.length ? Math.max(...heights) : 0;
  const minH = heights.length ? Math.min(...heights) : 0;
  const far = home ? Math.max(0, ...pts.map(p => haversine(home, p))) : 0;
  const n = missions.length;
  const batteries = n + 1;
  const sdGb = photoCount * MB_PER_PHOTO / 1000;
  const sdShown = sdGb < 10 ? sdGb.toFixed(1) : Math.ceil(sdGb);
  const maxAlt = ceilTo(maxH + 10, 10);
  const rth = ceilTo(maxH + 15, 5);
  const maxDist = ceilTo(far + 100, 100);
  const timer = captureMode === 'timer';

  const stops = [];
  if (!n || !pts.length) stops.push(item('There are no missions yet. Plan an area and generate waypoints first.', 'stop'));
  // Legal limits apply above the ground, which terrain following keeps constant, so judge those on
  // ground clearance when elevation is known and on height above takeoff otherwise.
  const agl = p => p.ground != null && homeGround != null ? p.height - (p.ground - homeGround) : p.height;
  const maxAgl = pts.length ? Math.max(...pts.map(agl)) : 0;
  const minAgl = pts.length ? Math.min(...pts.map(agl)) : 0;
  if (pts.length && maxAgl > 120) stops.push(item(`Your flight reaches ${Math.round(maxAgl)} m above the ground, over the 120 m (400 ft) limit in many countries.`, 'stop', { detail: 'Check your local rules before flying, or lower the flight height and regenerate.' }));
  if (pts.length && maxH > 500) stops.push(item(`Your highest waypoint is ${Math.round(maxH)} m above takeoff. DJI Fly cannot go higher than 500 m above takeoff.`, 'stop', { detail: 'Take off from higher ground, or split the area so each part is flown from a nearby takeoff point.' }));
  if (pts.length && minAgl < 5) stops.push(item(`Some waypoints are only ${minAgl.toFixed(1)} m above the ground. The drone could hit the ground or something near it.`, 'stop', { detail: 'Raise the flight height, or check terrain heights and the takeoff point.' }));
  if (pts.length && minH < 0) stops.push(item(`Some waypoints are below your takeoff point (lowest ${Math.round(minH)} m). That is normal when the area slopes downhill, but double-check the route in DJI Fly before flying.`, 'warn'));

  const home1 = [
    item(`Charge ${batteries} batteries fully`, 'todo', { value: `${batteries}`, detail: `${n} for the ${n === 1 ? 'mission' : 'missions'} plus 1 spare. Each mission is flown on its own battery.` }),
    item(`Make sure the SD card has at least ${sdShown} GB free`, 'todo', { value: `${sdShown} GB`, detail: `${photoCount} photos at about ${MB_PER_PHOTO} MB each (${drone} 20 MP JPEG). Use a fast card (UHS-I U3 or better) and format it before you go if you have already copied the old photos off.` }),
    item(`Update DJI Fly and the ${drone} firmware, and update your controller (${CONTROLLERS[controller] || controller})`, 'todo', { detail: 'Do this at home on Wi-Fi, not in the field. Do not update right before a flight in case something changes.' }),
    item(`Save ${n} placeholder ${n === 1 ? 'mission' : 'missions'} in DJI Fly (Waypoint, then create and save)`, 'todo', { value: `${n}`, detail: 'GridFly replaces the contents of each saved mission with your planned waypoints.' }),
    item('Check the weather and wind forecast for your flight time', 'todo', { detail: 'Wind over about 7 m/s (25 km/h) at flight height, rain, or very low sun all make bad maps.' }),
  ];
  if (home1.length && finishAction) home1.push(item(`When each mission ends the drone will: ${finishAction}`, 'info'));

  const heightNote = Number.isFinite(alt) ? ` Your planned height is ${Math.round(alt)} m above ground${Number.isFinite(gsd) ? `, giving about ${gsd.toFixed(1)} cm per pixel` : ''}.` : '';
  const safety = [
    item('Max altitude', 'todo', { value: `${maxAlt} m or more`, detail: `Your highest waypoint is ${Math.round(maxH)} m above takeoff, so set this to at least ${maxAlt} m in DJI Fly (Safety, Max altitude) or the drone will refuse to climb.${heightNote}` }),
    item('Return-to-home altitude', 'todo', { value: `${rth} m or more`, detail: `Set this at least 15 m above your highest waypoint (${Math.round(maxH)} m) so an automatic return goes over everything you flew past. Also keep it above any trees or buildings nearby.` }),
    item('Max distance', 'todo', { value: `${maxDist} m or No limit`, detail: `Your farthest waypoint is about ${Math.round(far)} m from takeoff. Set at least ${maxDist} m, or choose No limit.` }),
    item('Obstacle avoidance', 'todo', { value: 'Brake', detail: 'Set it to Brake, not Bypass. Bypass can steer the drone off the flight path and leave gaps in your map. Remember the drone cannot see wires or thin branches.' }),
    item('Signal lost action', 'todo', { value: 'Return to home', detail: 'If the controller loses contact the drone should fly home, not hover or land where it is.' }),
  ];

  const camera = [
    timer
      ? item('Photo mode: Timed Shot (Interval)', 'todo', { value: interval ? `every ${interval} s` : undefined, detail: `Set the interval to ${interval ? `${interval} seconds` : 'the value GridFly gave you'}. Start it right after the mission starts (once the drone begins its first leg), and stop it when the mission ends.` })
      : item('Photo mode: Single shot', 'todo', { detail: 'The mission takes each photo itself at every waypoint, so do not use Timed Shot.' }),
    item('Format: JPEG', 'todo', { detail: 'JPEG is fine for mapping and keeps files small. Raw files are bigger and slower to process.' }),
    item('Aspect ratio: 4:3', 'todo', { detail: 'This uses the full sensor, so you get the most overlap per photo.' }),
    item('Switch to Pro mode and use shutter priority (S): 1/1000 s or faster', 'todo', { value: '1/1000 s+', detail: `A fast shutter stops motion blur from the moving drone and reduces rolling-shutter skew, which warps buildings and ruins the map. In low light raise ISO instead of slowing the shutter.${droneKey === 'mavic3pro' ? ' On the Mavic 3 Pro use the main (Hasselblad) camera, not the tele cameras.' : ''}` }),
    item('ISO: Auto, with the maximum set to 800', 'todo', { value: 'max 800', detail: 'Higher ISO makes grainy photos that map software matches poorly.' }),
    item('White balance: fixed (Sunny or Cloudy), not Auto', 'todo', { detail: 'Auto white balance changes colour from photo to photo and leaves visible patches in the final map.' }),
    item('Focus: tap the ground on the screen at flight height, then keep auto focus', 'todo', { detail: `Do this once the drone is hovering at ${Number.isFinite(alt) ? Math.round(alt) + ' m' : 'mission height'}, looking straight down, so the ground is sharp for every photo.` }),
    item('Gimbal pointing straight down (-90°)', 'todo', { value: '-90°' }),
    item('Turn off Night mode, Hyperlapse and any other special shooting modes', 'todo'),
  ];

  const site = [
    item('Take off from the planned takeoff (H) point', 'todo', { detail: 'The heights in the mission are measured from where you take off. If you start somewhere else, the drone will be too high or too low everywhere.' }),
    item('Keep the drone in sight the whole time', 'todo', { detail: 'You are required to keep visual line of sight in most countries. Use a spotter if the area is large.' }),
    item('Look for people, vehicles, trees, wires and anything taller than your flight height', 'todo', { detail: 'Stay clear of people who are not part of the job. Check for power lines in particular.' }),
    item(`Fly the missions in order, 1${n > 1 ? ' to ' + n : ''}`, 'todo'),
    item('Between batteries, do not move the takeoff point', 'todo', { detail: 'Land at or near the same spot and take off from there again. Fit the fresh battery without turning the controller around or changing the home point.' }),
  ];
  if (n > 1) site.push(item(`Your flight uses ${n} batteries; land with at least 25% left when a mission is done`, 'info'));

  const after = [
    item('Copy all photos off the SD card to your computer, and keep a backup', 'todo'),
    item("Run GridFly's photo check to find blurry, missing or poorly placed photos", 'todo', { detail: 'Reflying one small gap while you are still on site is much easier than coming back another day.' }),
    item('Process the photos in WebODM', 'todo', { detail: 'Add all photos from all missions to a single project.' }),
  ];

  const sections = [
    { id: 'home', title: 'Before you leave home', items: [...stops, ...home1] },
    { id: 'settings', title: 'DJI Fly safety settings', items: safety },
    { id: 'camera', title: 'Camera settings', items: camera },
    { id: 'site', title: 'At the site', items: site },
    { id: 'after', title: 'After the flight', items: after },
  ];
  const ready = !sections.some(s => s.items.some(i => i.level === 'stop'));
  return { ready, sections };
}

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const COLORS = { stop: '#b00020', warn: '#b26a00', info: '#555', todo: '#111' };

export function checklistHtml(checklist, { title = 'GridFly pre-flight checklist' } = {}) {
  const rows = s => s.items.map(i => {
    const box = i.level === 'info' ? '<span style="display:inline-block;width:1.1em;text-align:center">i</span>'
      : i.level === 'stop' ? '<span style="display:inline-block;width:1.1em;text-align:center;font-weight:bold;color:#b00020">!</span>'
      : '<input type="checkbox" style="margin:0 .4em 0 0;vertical-align:middle">';
    return `<li style="list-style:none;margin:0 0 .55em -1.2em;color:${COLORS[i.level] || COLORS.todo};break-inside:avoid">${box} ` +
      `<strong>${esc(i.text)}${i.level === 'stop' ? ' (do not fly yet)' : ''}</strong>${i.value ? ` <span style="background:#eef;border-radius:3px;padding:0 .35em;white-space:nowrap">${esc(i.value)}</span>` : ''}` +
      (i.detail ? `<div style="font-size:.88em;color:#444;margin-left:1.6em">${esc(i.detail)}</div>` : '') + '</li>';
  }).join('');
  return `<div class="gridfly-checklist" style="font-family:system-ui,sans-serif;max-width:46em;line-height:1.35;color:#111">` +
    `<h2 style="margin:0 0 .3em">${esc(title)}</h2>` +
    (checklist.ready ? '' : '<p style="color:#b00020;font-weight:bold">Fix the items marked STOP before you fly.</p>') +
    checklist.sections.map(s => `<h3 style="margin:1em 0 .4em;border-bottom:1px solid #999;break-after:avoid">${esc(s.title)}</h3><ul style="padding-left:1.2em;margin:0">${rows(s)}</ul>`).join('') +
    '</div>';
}

export function checklistText(checklist) {
  const out = [];
  if (!checklist.ready) out.push('FIX THE (STOP) ITEMS BEFORE YOU FLY.', '');
  for (const s of checklist.sections) {
    out.push(s.title.toUpperCase());
    for (const i of s.items) {
      out.push(`${LEVEL_MARK[i.level] || '[ ]'} ${i.text}${i.value ? ` - ${i.value}` : ''}`);
      if (i.detail) out.push(`    ${i.detail}`);
    }
    out.push('');
  }
  return out.join('\n').trimEnd() + '\n';
}
