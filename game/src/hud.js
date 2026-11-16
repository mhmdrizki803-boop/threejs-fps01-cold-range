/* ===========================================================================
 * threejs-fps-01 — game/src/hud.js
 * ---------------------------------------------------------------------------
 * Plain-DOM HUD controller for the arena shooter. No imports, no build step,
 * no dependencies: it only talks to markup that index.html already provides.
 *
 * Elements it drives:
 *   #health-value  #ammo-mag  #ammo-reserve  #timer-value  #score-value
 *   #hitmarker  #overlay  #overlay-title  #overlay-copy  #play
 *
 * Contract:
 *   const hud = createHud();
 *   hud.onPlay = () => startRound();   // assign any time; fired on #play click
 *                                      // or Enter, at most once per 250 ms
 *   hud.setHealth(hp)                  // auto-red + .low below 35 hp
 *   hud.setAmmo(mag, reserve)          // either argument may be omitted
 *   hud.setTimer(seconds)              // number (or pre-formatted string)
 *   hud.setScore(points)               // an increase flashes the hitmarker
 *   hud.setMessage(title, copy)        // overlay with transient copy
 *   hud.showEnd('start'|'win'|'loss')  // presets, or showEnd(title, copy)
 *   hud.hideEnd()
 *   hud.hitmarker()                    // direct 90 ms flash (optional/extra)
 *
 * Nothing in here throws on a missing element: every lookup is null-checked
 * and re-resolved lazily, so the HUD is safe against a partial DOM.
 * ======================================================================== */

export function createHud() {
  if (typeof document === 'undefined') {
    const noop = function () {};
    return {
      onPlay: null,
      setHealth: noop, setAmmo: noop, setTimer: noop, setScore: noop,
      setMessage: noop, showEnd: noop, hideEnd: noop, hitmarker: noop,
    };
  }

  /* --------------------------------------------------------------------- *
   * Element access — cached, lazily re-resolved, never throws.
   * --------------------------------------------------------------------- */
  const cache = Object.create(null);

  function el(id) {
    const hit = cache[id];
    if (hit && hit.isConnected !== false) return hit;
    let node = null;
    try { node = document.getElementById(id); } catch (err) { node = null; }
    cache[id] = node;
    return node;
  }

  /* --------------------------------------------------------------------- *
   * Closure state — the last value of every readout, so we only touch the
   * DOM when something actually changed.
   * --------------------------------------------------------------------- */
  const last = {
    health: null, mag: null, reserve: null,
    timer: null, score: null, title: null, copy: null,
  };

  function write(id, key, text) {
    const node = el(id);
    const next = String(text);
    const prev = last[key];
    last[key] = next;                       // remember even if the node is gone
    if (!node) return false;
    if (prev === next && node.textContent === next) return false;
    try { node.textContent = next; } catch (err) { return false; }
    return true;
  }

  /* --------------------------------------------------------------------- *
   * Health
   * --------------------------------------------------------------------- */
  function applyLow(low) {
    const node = el('health-value');
    if (!node || !node.style) return;
    if (node.classList) {
      node.classList.toggle('low', low);
      node.classList.toggle('danger', low);
    }
    node.style.color = low ? '#ff3b30' : '';
    node.style.textShadow = low ? '0 0 12px rgba(255, 59, 48, 0.75)' : '';
  }

  function setHealth(value) {
    bind();
    if (value === null || value === undefined) return;
    const num = Number(value);
    const hp = Number.isFinite(num) ? Math.max(0, Math.round(num)) : 0;
    write('health-value', 'health', hp);
    applyLow(hp < 35);                      // red readout below 35 hp
    return hp;
  }

  /* --------------------------------------------------------------------- *
   * Ammunition
   * --------------------------------------------------------------------- */
  function setAmmo(mag, reserve) {
    bind();
    if (mag !== null && mag !== undefined) {
      const n = Number(mag);
      write('ammo-mag', 'mag', Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0);
    }
    if (reserve !== null && reserve !== undefined) {
      const n = Number(reserve);
      write('ammo-reserve', 'reserve', Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0);
    }
  }

  /* --------------------------------------------------------------------- *
   * Round timer — accepts seconds or an already formatted string.
   * --------------------------------------------------------------------- */
  function formatTime(seconds) {
    const total = Math.max(0, Math.ceil(Number(seconds) || 0));
    const mins = Math.floor(total / 60);
    const secs = total % 60;
    return mins + ':' + (secs < 10 ? '0' + secs : String(secs));
  }

  function setTimer(value) {
    bind();
    if (value === null || value === undefined) return;
    const text = typeof value === 'number' ? formatTime(value) : String(value);
    write('timer-value', 'timer', text);
    return text;
  }

  /* --------------------------------------------------------------------- *
   * Score — a rising score means a hit landed, so flash the hitmarker too.
   * --------------------------------------------------------------------- */
  function setScore(value) {
    bind();
    if (value === null || value === undefined) return;
    const num = Number(value);
    const score = Number.isFinite(num) ? Math.round(num) : 0;
    const prev = last.score;
    write('score-value', 'score', score);
    if (prev !== null && score > Number(prev)) hitmarker();
    return score;
  }

  /* --------------------------------------------------------------------- *
   * Hitmarker — 90 ms flash, restarted on every hit.
   * --------------------------------------------------------------------- */
  let hitTimer = 0;

  function hitmarker() {
    const node = el('hitmarker');
    if (!node) return;
    try {
      if (node.classList) {
        node.classList.add('show');
        node.classList.add('active');
      }
      if (node.style) node.style.opacity = '1';
    } catch (err) { /* ignore */ }
    if (hitTimer) clearTimeout(hitTimer);
    hitTimer = setTimeout(function () {
      hitTimer = 0;
      const n = el('hitmarker');
      if (!n) return;
      try {
        if (n.classList) {
          n.classList.remove('show');
          n.classList.remove('active');
        }
        if (n.style) n.style.opacity = '';
      } catch (err) { /* ignore */ }
    }, 90);
  }

  /* --------------------------------------------------------------------- *
   * Overlay
   * --------------------------------------------------------------------- */
  const PRESETS = {
    start: {
      title: 'READY UP',
      copy: 'WASD to move · Mouse to aim · Click to fire · R to reload. ' +
            'Clear the arena before the clock hits zero.',
    },
    win: {
      title: 'ROUND WON',
      copy: 'Arena cleared. Press play or hit Enter to run it again.',
    },
    loss: {
      title: 'ROUND LOST',
      copy: 'You went down. Press play or hit Enter to reset the arena.',
    },
  };

  let overlayVisible = true;                // the start screen is up by default

  function paintOverlay(title, copy) {
    if (title !== null && title !== undefined) write('overlay-title', 'title', title);
    if (copy !== null && copy !== undefined) write('overlay-copy', 'copy', copy);
  }

  function revealOverlay() {
    overlayVisible = true;
    const ov = el('overlay');
    if (!ov) return;
    try {
      if (ov.classList) {
        ov.classList.remove('hidden');
        ov.classList.add('visible');
      }
      if (ov.style) {
        ov.style.display = 'flex';
        ov.style.opacity = '1';
        ov.style.pointerEvents = 'auto';
      }
      ov.setAttribute('aria-hidden', 'false');
    } catch (err) { /* ignore */ }
    const btn = el('play');
    if (btn) {
      try {
        btn.disabled = false;
        if (btn.style) btn.style.display = '';
      } catch (err) { /* ignore */ }
    }
  }

  function hideEnd() {
    overlayVisible = false;
    const ov = el('overlay');
    if (ov) {
      try {
        if (ov.classList) {
          ov.classList.add('hidden');
          ov.classList.remove('visible');
        }
        if (ov.style) {
          ov.style.display = 'none';
          ov.style.opacity = '0';
          ov.style.pointerEvents = 'none';
        }
        ov.setAttribute('aria-hidden', 'true');
      } catch (err) { /* ignore */ }
    }
    const btn = el('play');
    if (btn && typeof btn.blur === 'function') {
      try { btn.blur(); } catch (err) { /* ignore */ }
    }
  }

  function setMessage(title, copy) {
    bind();
    let head = title;
    let body = copy;
    if (body === null || body === undefined) {
      body = head;                          // single-argument form = copy line
      head = null;
    }
    paintOverlay(head, body === null || body === undefined ? null : String(body));
    if (!overlayVisible) revealOverlay();
  }

  function showEnd(a, b) {
    bind();
    let title = null;
    let copy = null;

    if (a && typeof a === 'object') {
      title = a.title;
      copy = a.copy !== undefined ? a.copy : a.body;
    } else if (typeof a === 'string' && (b === null || b === undefined)) {
      const preset = PRESETS[a.toLowerCase()];
      if (preset) {
        title = preset.title;
        copy = preset.copy;
      } else {
        title = a;
      }
    } else {
      title = a;
      copy = b;
    }

    paintOverlay(
      title === null || title === undefined ? null : String(title),
      copy === null || copy === undefined ? null : String(copy)
    );
    revealOverlay();
  }

  /* --------------------------------------------------------------------- *
   * Play trigger — #play click or Enter, deduped so a focused button that
   * synthesises a click from the same keystroke only fires once.
   * --------------------------------------------------------------------- */
  let lastFire = 0;
  let keysBound = false;

  function fire() {
    const fn = api.onPlay;
    if (typeof fn !== 'function') return;
    const now = Date.now();
    if (now - lastFire < 250) return;
    lastFire = now;
    try {
      fn();
    } catch (err) {
      if (typeof console !== 'undefined' && console.error) {
        console.error('[hud] onPlay handler failed', err);
      }
    }
  }

  function onKeyDown(ev) {
    if (!ev) return;
    const key = ev.key;
    if (key !== 'Enter' && key !== 'NumpadEnter') return;
    if (ev.repeat) return;
    if (ev.altKey || ev.ctrlKey || ev.metaKey) return;
    if (!overlayVisible) return;            // in-round Enter belongs to the game
    fire();
  }

  function bind() {
    const btn = el('play');
    if (btn && !btn.__hudBound) {
      btn.__hudBound = true;
      try {
        btn.addEventListener('click', function (ev) {
          if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
          fire();
        });
      } catch (err) { /* ignore */ }
    }
    if (!keysBound && typeof window !== 'undefined' && window.addEventListener) {
      keysBound = true;
      try { window.addEventListener('keydown', onKeyDown); } catch (err) { /* ignore */ }
    }
  }

  /* --------------------------------------------------------------------- */
  const api = {
    onPlay: null,
    setHealth: setHealth,
    setAmmo: setAmmo,
    setTimer: setTimer,
    setScore: setScore,
    setMessage: setMessage,
    showEnd: showEnd,
    hideEnd: hideEnd,
    hitmarker: hitmarker,
  };

  if (document.readyState === 'loading' && document.addEventListener) {
    document.addEventListener('DOMContentLoaded', bind, { once: true });
  } else {
    bind();
  }

  return api;
}
