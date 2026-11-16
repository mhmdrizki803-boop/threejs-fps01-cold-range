// game/src/player.js
// -----------------------------------------------------------------------------
// Counter-Strike-flavoured first-person movement + collision for the arena FPS.
//
// The player is a vertical capsule approximated by an AABB (radius R, eased
// height).  Physics is Quake/CS style: ground friction bleeds momentum, then an
// acceleration term pulls the velocity toward the *wanted* velocity, which makes
// stopping snappy and strafing feel weighted.  Collision is resolved one axis at
// a time against every Box3 in `colliders`, so running into a wall slides along
// it instead of sticking.
// -----------------------------------------------------------------------------

import * as THREE from 'three';
import * as PALETTE from './palette.js';

// --- tuning -----------------------------------------------------------------
const R          = 0.34;   // body half-width (AABB)
const STAND_H    = 1.82;   // body height standing
const CROUCH_H   = 1.20;   // body height crouched
const EYE_STAND  = 1.70;   // eye height standing
const EYE_CROUCH = 1.10;   // eye height crouched
const EYE_RATE   = 25.0;   // ~95% of the crouch eye transition in 0.12 s

const WALK_SPEED   = 6.5;
const CROUCH_SPEED = 3.0;
const SPRINT_SPEED = 9.0;

const GROUND_ACCEL = 10.5;  // x wish speed
const AIR_ACCEL    = 2.6;
const AIR_WISH_CAP = 3.0;   // CS-like: barely any air steering
const FRICTION     = 6.2;   // quake friction coefficient
const STOP_SPEED   = 1.6;   // friction floor -> quick, clean stops

const GRAVITY      = 26.0;
const JUMP_VEL     = 7.2;
const MAX_FALL     = -42.0;

const STEP_HEIGHT  = 0.42;  // crates / kerbs you can walk up
const EPS          = 5e-4;
const JUMP_BUFFER  = 0.12;
const COYOTE       = 0.08;

const LOOK_SENS    = 0.0022;
const PITCH_LIMIT  = 1.5;

const MAX_HEALTH   = 100;

// --- helpers ----------------------------------------------------------------
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Palette lookups are name-tolerant: if an export name ever changes we fall
 *  back to a sane hex instead of throwing at import time. */
function paletteColor(names, fallback) {
  for (let i = 0; i < names.length; i++) {
    const n = names[i];
    const v = PALETTE[n] !== undefined ? PALETTE[n]
            : PALETTE[n.toUpperCase()] !== undefined ? PALETTE[n.toUpperCase()]
            : PALETTE[n.toLowerCase()];
    if (v === undefined || v === null) continue;
    try { return new THREE.Color(v); } catch (err) { /* not a colour, keep trying */ }
  }
  return new THREE.Color(fallback);
}

/** Read a boolean-ish action out of an input object without assuming its shape:
 *  direct props, nested key bags (Set / map / plain object) are all accepted. */
function isDown(input, aliases) {
  if (!input || typeof input !== 'object') return false;
  for (let i = 0; i < aliases.length; i++) {
    const v = input[aliases[i]];
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v > 0.5;
    if (v && typeof v === 'object' && typeof v.value === 'boolean') return v.value;
  }
  const bags = [input.keys, input.down, input.held, input.buttons, input.state, input.actions];
  for (let b = 0; b < bags.length; b++) {
    const bag = bags[b];
    if (!bag || typeof bag !== 'object') continue;
    for (let i = 0; i < aliases.length; i++) {
      const a = aliases[i];
      if (typeof bag.has === 'function') { if (bag.has(a)) return true; }
      else if (typeof bag[a] === 'boolean' && bag[a]) return true;
      else if (typeof bag[a] === 'number' && bag[a] > 0.5) return true;
    }
  }
  return false;
}

const AXES = {
  forward: ['forward', 'fwd', 'w', 'W', 'KeyW', 'ArrowUp', 'up'],
  back:    ['back', 'backward', 'b', 's', 'S', 'KeyS', 'ArrowDown', 'down'],
  left:    ['left', 'l', 'a', 'A', 'KeyA', 'ArrowLeft'],
  right:   ['right', 'r', 'd', 'D', 'KeyD', 'ArrowRight'],
  jump:    ['jump', 'space', 'Space', 'KeySpace', 'Spacebar', ' '],
  crouch:  ['crouch', 'ctrl', 'Control', 'ControlLeft', 'KeyC', 'c', 'C', 'sneak'],
  sprint:  ['sprint', 'shift', 'Shift', 'ShiftLeft', 'KeyShift', 'run']
};

function readAxis(input) {
  const f = (isDown(input, AXES.forward) ? 1 : 0) - (isDown(input, AXES.back) ? 1 : 0);
  const r = (isDown(input, AXES.right) ? 1 : 0) - (isDown(input, AXES.left) ? 1 : 0);
  return { f, r };
}

/** Mouse / stick look deltas, whatever the caller happens to call them. */
function readLook(input) {
  if (!input) return null;
  const probes = [
    ['mouseX', 'mouseY'], ['dx', 'dy'], ['lookX', 'lookY'],
    ['movementX', 'movementY'], ['deltaX', 'deltaY'], ['yawDelta', 'pitchDelta']
  ];
  for (let i = 0; i < probes.length; i++) {
    const x = input[probes[i][0]];
    const y = input[probes[i][1]];
    if (typeof x === 'number' || typeof y === 'number') {
      return { dx: typeof x === 'number' ? x : 0, dy: typeof y === 'number' ? y : 0 };
    }
  }
  const look = input.look || input.delta || input.mouse;
  if (look && typeof look === 'object' &&
      (typeof look.x === 'number' || typeof look.y === 'number')) {
    return { dx: look.x || 0, dy: look.y || 0 };
  }
  return null;
}

// ---------------------------------------------------------------------------
export function createPlayer(colliders) {
  // ------------------------------------------------------------------ state
  const position = new THREE.Vector3(0, 0, 0);
  const velocity = new THREE.Vector3(0, 0, 0);
  const spawn = new THREE.Vector3(0, 0, 0);

  const state = {
    health: MAX_HEALTH,
    alive: true,
    crouching: false,
    crouchLatch: false,     // one-frame external request
    eyeHeight: EYE_STAND,
    yaw: 0,
    pitch: 0,
    grounded: false,
    sprinting: false,
    spread: 0.012,
    moveFactor: 0,
    speed: 0,
    jumpBuffer: 0,
    coyote: 0
  };

  // scratch objects (no per-frame allocation)
  const _body  = new THREE.Box3();
  const _fwd   = new THREE.Vector3(0, 0, -1);
  const _right = new THREE.Vector3(1, 0, 0);
  const _wish  = new THREE.Vector3();
  const _camDir = new THREE.Vector3();

  // Optional ground shadow: main.js may add `player.object` to the scene.  It is
  // purely decorative and never affects physics.
  const shadowGeo = new THREE.CircleGeometry(R * 1.2, 20);
  const shadowMat = new THREE.MeshBasicMaterial({
    color: paletteColor(['shadow', 'ground', 'floor', 'accent'], 0x0b0f14),
    transparent: true,
    opacity: 0.34,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2
  });
  const object = new THREE.Group();
  const shadow = new THREE.Mesh(shadowGeo, shadowMat);
  shadow.rotation.x = -Math.PI / 2;
  shadow.renderOrder = 2;
  object.add(shadow);

  // ---------------------------------------------------------------- colliders
  let cached = null;
  let cachedSource = null;
  function world() {
    const src = colliders;
    if (typeof src === 'function') {
      const out = src();
      if (out === cachedSource) return cached;
      cachedSource = out;
      cached = Array.isArray(out) ? out : [];
      return cached;
    }
    if (Array.isArray(src)) return src;
    return [];
  }

  // ------------------------------------------------------------- body volume
  function bodyBox(px, py, pz, h) {
    _body.min.set(px - R + EPS, py + EPS, pz - R + EPS);
    _body.max.set(px + R - EPS, py + h - EPS, pz + R - EPS);
    return _body;
  }

  function overlaps(px, py, pz, h, boxes) {
    const b = bodyBox(px, py, pz, h);
    for (let i = 0; i < boxes.length; i++) {
      const c = boxes[i];
      if (c && c.isBox3 && c.intersectsBox(b)) return true;
      if (c && c.min && c.max) {
        // tolerate plain {min:{x,y,z}, max:{...}} data
        if (!(c.max.x < b.min.x || c.min.x > b.max.x ||
              c.max.y < b.min.y || c.min.y > b.max.y ||
              c.max.z < b.min.z || c.min.z > b.max.z)) return true;
      }
    }
    return false;
  }

  function bodyHeight() { return state.eyeHeight + 0.1; }

  /** Highest walkable top under the footprint, at or below `py`. */
  function topUnder(px, py, pz, boxes) {
    let best = -Infinity;
    for (let i = 0; i < boxes.length; i++) {
      const c = boxes[i];
      if (!c || !c.min || !c.max) continue;
      if (c.max.y > py + 1e-3) continue;
      if (c.max.x < px - R || c.min.x > px + R) continue;
      if (c.max.z < pz - R || c.min.z > pz + R) continue;
      if (c.max.y > best) best = c.max.y;
    }
    return best === -Infinity ? null : best;
  }

  /** Move along a single axis, then push out of everything we ended up inside.
   *  Resolving one axis at a time is what produces wall sliding.
   *
   *  Two guards keep it honest:
   *   - vertical pushes are direction aware, so a head already poking into a
   *     ceiling is never "resolved" by teleporting the body onto its roof;
   *   - any correction longer than the step we just tried is refused (we snap
   *     back to where we started) which makes deep overlaps safe instead of
   *     explosive. */
  function moveAxis(axis, delta, boxes, h) {
    if (delta !== 0) position[axis] += delta;
    const from = position[axis] - delta;
    let hit = false;
    const slack = Math.abs(delta) + 0.75;

    for (let i = 0; i < boxes.length; i++) {
      const c = boxes[i];
      if (!c || !c.min || !c.max) continue;
      const b = bodyBox(position.x, position.y, position.z, h);
      const inside = typeof c.intersectsBox === 'function'
        ? c.intersectsBox(b)
        : !(c.max.x < b.min.x || c.min.x > b.max.x ||
            c.max.y < b.min.y || c.min.y > b.max.y ||
            c.max.z < b.min.z || c.min.z > b.max.z);
      if (!inside) continue;

      hit = true;
      let target;
      if (axis === 'x') {
        target = delta > 0 ? c.min.x - R - EPS : c.max.x + R + EPS;
      } else if (axis === 'z') {
        target = delta > 0 ? c.min.z - R - EPS : c.max.z + R + EPS;
      } else if (delta > 0) {
        // moving up: only a real ceiling (we started below it) can stop the head
        target = from + h <= c.min.y + 0.02 ? c.min.y - h - EPS : from;
      } else {
        // moving down: only a real floor (we started above it) can catch us
        target = from >= c.max.y - 0.02 ? c.max.y + 1e-4 : from;
      }
      position[axis] = Math.abs(target - from) > slack ? from : target;
    }
    return hit;
  }

  /** Walk up a small ledge instead of being stopped dead by it. */
  function tryStepUp(dx, dz, boxes, h) {
    if (!state.grounded) return false;
    if (Math.abs(dx) + Math.abs(dz) < 1e-5) return false;
    const lifted = position.y + STEP_HEIGHT * 1.05;
    if (overlaps(position.x, lifted, position.z, h, boxes)) return false; // no headroom
    const nx = position.x + dx;
    const nz = position.z + dz;
    if (overlaps(nx, lifted, nz, h, boxes)) return false;
    const support = topUnder(nx, lifted, nz, boxes);
    if (support === null) return false;
    if (support > lifted + 1e-3 || support < position.y + 0.02) return false;
    position.x = nx;
    position.z = nz;
    position.y = support;
    state.grounded = true;
    return true;
  }

  // ------------------------------------------------------- velocity shaping
  function applyFriction(dt) {
    const speed = Math.hypot(velocity.x, velocity.z);
    if (speed < 1e-4) { velocity.x = 0; velocity.z = 0; return; }
    const control = speed < STOP_SPEED ? STOP_SPEED : speed;
    const drop = control * FRICTION * dt;
    const scale = Math.max(0, speed - drop) / speed;
    velocity.x *= scale;
    velocity.z *= scale;
  }

  function accelerate(dirX, dirZ, wishSpeed, accel, dt) {
    if (wishSpeed <= 0) return;
    const current = velocity.x * dirX + velocity.z * dirZ;
    const add = wishSpeed - current;
    if (add <= 0) return;
    const accelSpeed = Math.min(accel * dt * wishSpeed, add);
    velocity.x += dirX * accelSpeed;
    velocity.z += dirZ * accelSpeed;
  }

  // --------------------------------------------------------------- orientation
  function resolveBasis(input) {
    // 1) an explicit camera/object is authoritative when the caller hands one in
    const cam = input && (input.camera || input.cam || input.view);
    if (cam && typeof cam.getWorldDirection === 'function') {
      cam.getWorldDirection(_camDir);
      _camDir.y = 0;
      if (_camDir.lengthSq() > 1e-6) {
        _camDir.normalize();
        _fwd.copy(_camDir);
        state.yaw = Math.atan2(-_fwd.x, -_fwd.z);
        _right.set(-_fwd.z, 0, _fwd.x);
        return;
      }
    }
    // 2) an explicit yaw number
    if (input) {
      let yaw = null;
      if (typeof input.yaw === 'number') yaw = input.yaw;
      else if (typeof input.heading === 'number') yaw = input.heading;
      else if (input.rotation && typeof input.rotation.y === 'number') yaw = input.rotation.y;
      if (yaw !== null) state.yaw = yaw;
    }
    // 3) otherwise integrate any mouse deltas we were given
    const look = readLook(input);
    if (look) {
      state.yaw -= look.dx * LOOK_SENS;
      state.pitch = clamp(state.pitch - look.dy * LOOK_SENS, -PITCH_LIMIT, PITCH_LIMIT);
    }
    const y = state.yaw;
    _fwd.set(-Math.sin(y), 0, -Math.cos(y));
    _right.set(Math.cos(y), 0, -Math.sin(y));
  }

  // ------------------------------------------------------------------ update
  function update(dt, input) {
    if (typeof dt !== 'number' || !isFinite(dt) || dt <= 0) return;
    dt = Math.min(dt, 0.05);          // never let a hitch tunnel us through walls

    if (!state.alive) {
      velocity.set(0, 0, 0);
      state.speed = 0;
      state.moveFactor = 0;
      shadow.visible = false;
      return;
    }

    const boxes = world();
    resolveBasis(input);

    // ---- stance -------------------------------------------------------------
    const wantCrouch = isDown(input, AXES.crouch) || state.crouchLatch;
    state.crouchLatch = false;
    if (wantCrouch) {
      state.crouching = true;
    } else if (state.crouching) {
      // only stand back up if the taller body actually fits
      if (!overlaps(position.x, position.y, position.z, STAND_H, boxes)) state.crouching = false;
    }
    const targetEye = state.crouching ? EYE_CROUCH : EYE_STAND;
    const k = 1 - Math.exp(-dt * EYE_RATE);        // ~0.12 s to settle
    state.eyeHeight += (targetEye - state.eyeHeight) * k;
    if (Math.abs(targetEye - state.eyeHeight) < 1e-4) state.eyeHeight = targetEye;
    const h = bodyHeight();

    // ---- wanted velocity ----------------------------------------------------
    const { f, r } = readAxis(input);
    state.sprinting = false;
    let maxSpeed = WALK_SPEED;
    if (state.crouching) maxSpeed = CROUCH_SPEED;
    else if (isDown(input, AXES.sprint) && f > 0 && r === 0) {
      state.sprinting = true;
      maxSpeed = SPRINT_SPEED;
    }

    _wish.set(0, 0, 0);
    if (f !== 0) _wish.addScaledVector(_fwd, f);
    if (r !== 0) _wish.addScaledVector(_right, r);
    const wishLen = _wish.length();
    let wishSpeed = 0;
    if (wishLen > 1e-5) {
      _wish.multiplyScalar(1 / wishLen);
      wishSpeed = maxSpeed;                         // no diagonal speed boost
    } else {
      _wish.set(0, 0, 0);
    }

    // ---- ground / air acceleration -----------------------------------------
    if (state.grounded) {
      applyFriction(dt);
      accelerate(_wish.x, _wish.z, wishSpeed, GROUND_ACCEL, dt);
    } else {
      accelerate(_wish.x, _wish.z, Math.min(wishSpeed, AIR_WISH_CAP), AIR_ACCEL, dt);
    }

    // ---- jump (with buffer + coyote time) ----------------------------------
    state.jumpBuffer = isDown(input, AXES.jump) ? JUMP_BUFFER : Math.max(0, state.jumpBuffer - dt);
    state.coyote = state.grounded ? COYOTE : Math.max(0, state.coyote - dt);
    if (state.jumpBuffer > 0 && state.coyote > 0) {
      velocity.y = JUMP_VEL;
      state.grounded = false;
      state.jumpBuffer = 0;
      state.coyote = 0;
    }

    // ---- gravity + integration ---------------------------------------------
    velocity.y = Math.max(velocity.y - GRAVITY * dt, MAX_FALL);

    const dx = velocity.x * dt;
    const dz = velocity.z * dt;
    const steps = Math.max(1, Math.min(8,
      Math.ceil(Math.max(Math.abs(dx), Math.abs(dz), Math.abs(velocity.y * dt)) / 0.3)));
    const sdt = 1 / steps;
    let stepped = false;

    for (let s = 0; s < steps; s++) {
      const px = dx * sdt;
      const pz = dz * sdt;
      const hitX = moveAxis('x', px, boxes, h);
      const hitZ = moveAxis('z', pz, boxes, h);
      if ((hitX || hitZ) && !stepped) {
        stepped = tryStepUp(px, pz, boxes, h);
      }
      if (velocity.y !== 0) {
        const dy = velocity.y * dt * sdt;   // dt is the frame slice, sdt splits it
        const hitY = moveAxis('y', dy, boxes, h);
        if (hitY) {
          if (velocity.y < 0) state.grounded = true;
          velocity.y = 0;
        } else if (velocity.y > 0) {
          state.grounded = false;
        }
      }
    }

    // ---- ground probe (stand still on ledges without bouncing) -------------
    if (!state.grounded && velocity.y <= 0 && overlaps(position.x, position.y - 0.04, position.z, h, boxes)) {
      moveAxis('y', -0.04, boxes, h);
      velocity.y = 0;
      state.grounded = true;
    } else if (!state.grounded && velocity.y <= 0) {
      const support = topUnder(position.x, position.y + 0.02, position.z, boxes);
      if (support !== null && position.y - support < 0.06) {
        position.y = support;
        velocity.y = 0;
        state.grounded = true;
      }
    }

    // ---- fall-out safety net ------------------------------------------------
    if (position.y < -60) reset(spawn);

    // ---- derived stats used by the weapon / HUD ----------------------------
    const hSpeed = Math.hypot(velocity.x, velocity.z);
    state.speed = hSpeed;
    state.moveFactor = clamp(hSpeed / WALK_SPEED, 0, 1.6);

    // Spread grows with speed, sprint, and time spent in the air; crouching and
    // standing still keep it tight, which is what makes stopping to aim pay.
    let spread = 0.010;
    spread += state.moveFactor * 0.030;
    if (state.sprinting && hSpeed > WALK_SPEED * 0.9) spread += 0.022;
    if (!state.grounded) spread += 0.055;
    if (state.crouching) spread -= 0.005;
    state.spread = clamp(spread, 0.004, 0.14);

    // ---- shadow -------------------------------------------------------------
    object.position.set(position.x, position.y + 0.012, position.z);
    shadow.visible = state.grounded;
    shadowMat.opacity = 0.34;
  }

  // ------------------------------------------------------------------ damage
  function damage(n) {
    if (!state.alive) return;
    const amount = typeof n === 'number' ? n : Number(n);
    if (!isFinite(amount) || amount <= 0) return;
    state.health = Math.max(0, state.health - amount);
    if (state.health <= 0) {
      state.health = 0;
      state.alive = false;
      velocity.set(0, 0, 0);
    }
  }

  // ------------------------------------------------------------------ reset
  function reset(at) {
    const s = at || spawn;
    if (s) {
      if (s.isVector3 || typeof s.x === 'number') {
        position.set(s.x || 0, typeof s.y === 'number' ? s.y : 0, s.z || 0);
      } else if (Array.isArray(s)) {
        position.set(s[0] || 0, s[1] || 0, s[2] || 0);
      }
    } else {
      position.set(0, 0, 0);
    }
    if (at) spawn.copy(position);
    if (s && typeof s.yaw === 'number') state.yaw = s.yaw;

    velocity.set(0, 0, 0);
    state.health = MAX_HEALTH;
    state.alive = true;
    state.crouching = false;
    state.crouchLatch = false;
    state.eyeHeight = EYE_STAND;
    state.pitch = 0;
    state.grounded = false;
    state.sprinting = false;
    state.spread = 0.010;
    state.moveFactor = 0;
    state.speed = 0;
    state.jumpBuffer = 0;
    state.coyote = 0;
    object.position.set(position.x, position.y, position.z);
  }

  // ------------------------------------------------------------------ player
  const player = {
    update,
    reset,
    damage,
    position,
    velocity,
    object,
    radius: R,
    standHeight: STAND_H,
    crouchHeight: CROUCH_H,
    maxHealth: MAX_HEALTH,
    getForward(out) {
      const v = out || new THREE.Vector3();
      return v.set(-Math.sin(state.yaw), 0, -Math.cos(state.yaw));
    },
    look(dx, dy) {
      state.yaw -= (dx || 0) * LOOK_SENS;
      state.pitch = clamp(state.pitch - (dy || 0) * LOOK_SENS, -PITCH_LIMIT, PITCH_LIMIT);
    },

    get position_y() { return position.y; },
    get eyeHeight() { return state.eyeHeight; },
    set eyeHeight(v) { if (typeof v === 'number') state.eyeHeight = v; },
    get health() { return state.health; },
    set health(v) { state.health = clamp(typeof v === 'number' ? v : 0, 0, MAX_HEALTH); if (state.health <= 0) state.alive = false; },
    get alive() { return state.alive; },
    set alive(v) { state.alive = !!v; },
    // `crouch` reads the live stance; writing it requests a crouch for one frame
    // (write it again each frame to hold), which keeps simple callers working.
    get crouch() { return state.crouching; },
    set crouch(v) { if (v) state.crouchLatch = true; else state.crouchLatch = false; },

    get yaw() { return state.yaw; },
    set yaw(v) { if (typeof v === 'number') state.yaw = v; },
    get pitch() { return state.pitch; },
    set pitch(v) { if (typeof v === 'number') state.pitch = clamp(v, -PITCH_LIMIT, PITCH_LIMIT); },
    get grounded() { return state.grounded; },
    get sprinting() { return state.sprinting; },
    get speed() { return state.speed; },
    get moveFactor() { return state.moveFactor; },
    get spread() { return state.spread; },
    get spawn() { return spawn; }
  };

  player.reset();
  return player;
}

export default createPlayer;
