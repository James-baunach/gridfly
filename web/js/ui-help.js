// "?" tooltips, the keyboard shortcuts dialog and the first-run tour.

import { $, state, emit, on, pref, setPref } from './state.js';

// ---------- Tooltips ----------

function initTips() {
  const pop = $('tipPop');
  document.querySelectorAll('[data-help]').forEach(el => {
    const text = el.dataset.help;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tip';
    b.textContent = '?';
    b.title = text;
    b.setAttribute('aria-label', 'Help: ' + text);
    b.onclick = e => {
      e.preventDefault();
      e.stopPropagation();
      if (!pop.hidden && pop._for === b) { pop.hidden = true; return; }
      pop.textContent = text;
      pop._for = b;
      pop.hidden = false;
      const r = b.getBoundingClientRect();
      const w = Math.min(260, window.innerWidth - 24);
      pop.style.width = w + 'px';
      pop.style.left = Math.max(12, Math.min(window.innerWidth - w - 12, r.left - 20)) + 'px';
      const below = r.bottom + 8;
      pop.style.top = (below + pop.offsetHeight > window.innerHeight ? Math.max(8, r.top - pop.offsetHeight - 8) : below) + 'px';
    };
    const ctrl = el.tagName === 'LABEL' && !el.classList.contains('check') ? el.querySelector('input,select') : null;
    ctrl ? el.insertBefore(b, ctrl) : el.appendChild(b);
  });
  document.addEventListener('click', () => { pop.hidden = true; });
}

// ---------- Shortcuts ----------

export function toggleHelp(show = $('help').hidden) { $('help').hidden = !show; }

// ---------- Tour ----------

const TOUR = [
  { title: 'Welcome to GridFly', step: 1, text: 'GridFly plans photo-mapping flights for DJI Fly drones. The panel takes you through three phases: Plan, Prepare and Fly back. Start by picking your drone and controller.' },
  { title: 'Mark the area', step: 2, text: 'Search for your site at the top, then tap Map this view to plan what the map shows, or draw a polygon, rectangle or circle. Drag the orange corners to adjust. The plan updates by itself.' },
  { title: 'One card tells you everything', step: 4, text: 'The card at the top of the panel shows the flight time, batteries and detail, whether the mission is ready to fly, and the next thing to do. Slide Quality to trade speed for detail.' },
  { title: 'Check, install, fly, map', step: 6, text: 'GridFly checks the weather, airspace and obstacles, gets the mission onto your controller and gives you a checklist. After flying, drop the photos in to find gaps and make a quick map. Everything else is in the menu (top right).' },
];
let tourAt = 0;

function showTour() {
  const t = TOUR[tourAt];
  $('tour').hidden = false;
  $('tourCount').textContent = `Quick tour · ${tourAt + 1} of ${TOUR.length}`;
  $('tourTitle').textContent = t.title;
  $('tourText').textContent = t.text;
  $('btnTourNext').textContent = tourAt === TOUR.length - 1 ? 'Start planning' : 'Next';
  if (state.easy) emit('goStep', t.step);
}

function endTour() {
  $('tour').hidden = true;
  setPref('tourDone', true);
  if (state.easy) emit('goStep', 1);
}

export function startTour() { tourAt = 0; showTour(); }

export function initHelp({ firstRun }) {
  initTips();
  $('btnHelp').onclick = () => toggleHelp();
  $('btnHelpClose').onclick = () => toggleHelp(false);
  $('help').onclick = e => { if (e.target === $('help')) toggleHelp(false); };
  $('btnTour').onclick = startTour;
  $('btnTourSkip').onclick = endTour;
  $('btnTourNext').onclick = () => { if (++tourAt >= TOUR.length) endTour(); else showTour(); };
  if (firstRun && !pref('tourDone', false)) {
    // Only in the planner: the home page explains itself.
    let shown = false;
    const go = () => { if (!shown && document.documentElement.dataset.view === 'app') { shown = true; setTimeout(() => { if (!pref('tourDone', false)) startTour(); }, 500); } };
    go();
    on('view', go);
  }
}
