/**
 * game/src/main.js
 *
 * Judge, start here.
 *
 * BREACH POINT is a 90-second arena FPS you can finish in one sitting. You hold
 * a corner of a walled, crate-cluttered floor with a 24-round carbine against six
 * red hostiles. Mouse looks, WASD moves, the bots patrol until they get a clear
 * line to your chest and then they shoot back with real damage on your health.
 *
 * Where to look, in order:
 *   1. `shoot()` — the round is a ray cast from the camera through
 *      `weapon.fire(spread, moving)`, which perturbs it inside a cone that widens
 *      while you move, sprint or leave the ground and narrows to almost nothing
 *      when you plant your feet in a crouch. Head hit = 34, body = 17, on a
 *      100 hp bot: three heads or six bodies.
 *   2. The recoil block in `frame()` — `weapon.recoil` is added straight into
 *      pitch as it rises and is never paid back, so a held trigger walks the
 *      muzzle off the target. Spread plus climb is why stopping to aim pays.
 *   3. `startRound()` / `finishRound()` — six kills before 0:00 is a win; 0 hp or
 *      a dead clock is a loss; the overlay carries the score (kills + 1 per 10 s)
 *      and deploy wipes the arena back to full for the next round.
 *
 * Everything below is the hub: renderer, camera, loop, input, and the wiring
 * between world, player, shooters, weapon and hud. Nothing is fetched: the whole
 * game is geometry and materials built in code.
 */

import * as THREE from 'three';
import { PALETTE } from './palette.js';
import { createWorld } from './world.js';
import { createPlayer } from './player.js';
import { createShooters } from './shooters.js';
import { createWeapon } from './weapon.js';
import { createHud } from './hud.js';

/* ------------------------------------------------------------------ tuning */

const ROUND_TIME = 90;                        // seconds on the clock
const HEAD_DAMAGE = 34;
const BODY_DAMAGE = 17;
const BOT_COUNT = 6;
const SHOT_RANGE = 220;
const FOV = 74;
const PITCH_LIMIT = THREE.MathUtils.degToRad(85);
const LOOK_SENS = 0.0022;
const FIRE_INTERVAL = 0.105;                  // seconds between rounds held down
const MAX_DELTA = 0.05;                       // never step the sim more than this
const SPREAD_NOMINAL = 0.010;                 // player.spread at rest, standing
const INCOMING_SCALE = 0.55;                  // bot round -> player hp, see adapter
const REGEN_DELAY = 6.0;                      // s out of contact before health returns
const REGEN_RATE = 5.0;                       // hp per second
// South-west corner, looking across the diagonal at the mid walls and the
// pillar pair: the whole arena is in frame on the first frame of a round.
// Forward is (-sin yaw, 0, -cos yaw), so -pi/4 aims at (+x, -z): dead centre.
const SPAWN = { x: -16.0, y: 0, z: 16.0, yaw: -0.785, pitch: 0 };

/* --------------------------------------------------------------- the canvas */

const canvas = document.getElementById('view');
if (!canvas) throw new Error('main: #view canvas is missing from index.html');

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  powerPreference: 'high-performance',
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
if (THREE.SRGBColorSpace && 'outputColorSpace' in renderer) {
  renderer.outputColorSpace = THREE.SRGBColorSpace;
}
// Clear to the palette ink so a frame is never white before the world is drawn.
renderer.setClearColor(new THREE.Color(PALETTE.ink), 1);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(FOV, window.innerWidth / window.innerHeight, 0.05, 260);
camera.rotation.order = 'YXZ';
scene.add(camera);

/* ---------------------------------------------------------------- the world */

const world = createWorld(scene);
const colliders = world.colliders;

// The floor is drawn by the world but deliberately not registered as a collider
// there (a 40x40 slab in that list would fight every body-resolution sweep), so
// the hub owns the ground plane: one thin box under the play area. With it the
// player's own collision sweep grounds the feet, jumps land, and a shot that
// skips off the concrete stops there instead of flying through it.
colliders.push(new THREE.Box3(
  new THREE.Vector3(-20, -2, -20),
  new THREE.Vector3(20, 0, 20)
));

const player = createPlayer(colliders);
scene.add(player.object);
player.reset(SPAWN);

const shooters = createShooters(scene, colliders);
const weapon = createWeapon(camera);
const hud = createHud();

// The hub owns hit resolution (34 / 17), so the weapon is deliberately NOT hung
// off `player`: the shooter module infers a shot from a player's ammo counters
// and would resolve every round a second time at its own 26 / 78. Bots still
// see, aim at and hurt the real player through position / eyeHeight / health.
weapon.setCrouched(function () { return player.crouch; });

/* ------------------------------------------------------- feeder for the bots */

// Six hostiles that all see you at once put out roughly 57 hp a second, which
// ended a round in seven seconds in testing: unfair, and it made the health bar
// unreadable. Rather than edit the shooter module, the hub hands it a thin
// adapter — same position, same eye height, same health, same takeDamage path —
// that scales the incoming round to 55 % and stamps the last-hit clock the
// regen below reads. Bots still shoot at the real body and hit detection on
// their side is untouched.
let hurtAt = -999;

const botTarget = {
  get position() { return player.position; },
  get eyeHeight() { return player.eyeHeight; },
  get health() { return player.health; },
  get alive() { return player.alive; },
  get crouchHeight() { return player.crouchHeight; },
  damage(amount) {
    const dealt = Number(amount);
    if (!isFinite(dealt) || dealt <= 0) return;
    hurtAt = elapsed;
    player.damage(dealt * INCOMING_SCALE);
  },
};

/* ------------------------------------------------------------------ session */

let yaw = SPAWN.yaw;
let pitch = SPAWN.pitch;
let phase = 'idle';              // 'idle' | 'live' | 'over'
let roundLeft = ROUND_TIME;
let elapsed = 0;
let kills = 0;
let score = 0;
let fireCooldown = 0;
let lastRecoil = 0;
let locked = false;
let everLocked = false;          // true once the browser has actually given us the mouse
let paused = false;              // round frozen because the mouse was handed back
let triggerDown = false;

const pressed = new Set();
const shotDir = new THREE.Vector3();
const shotOrigin = new THREE.Vector3();

function currentScore() {
  // Bots killed, plus one for every full ten seconds the round has lasted.
  return kills + Math.floor(elapsed / 10);
}

/* -------------------------------------------------------------- hit probing */

/** Ray vs one AABB: distance to the near face, or -1 when it misses. */
function rayBox(origin, dir, box, maxT) {
  let tmin = 0;
  let tmax = maxT;
  for (let axis = 0; axis < 3; axis++) {
    const o = axis === 0 ? origin.x : axis === 1 ? origin.y : origin.z;
    const d = axis === 0 ? dir.x : axis === 1 ? dir.y : dir.z;
    const lo = axis === 0 ? box.min.x : axis === 1 ? box.min.y : box.min.z;
    const hi = axis === 0 ? box.max.x : axis === 1 ? box.max.y : box.max.z;
    if (Math.abs(d) < 1e-9) {
      if (o < lo || o > hi) return -1;
      continue;
    }
    let t1 = (lo - o) / d;
    let t2 = (hi - o) / d;
    if (t1 > t2) { const swap = t1; t1 = t2; t2 = swap; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return -1;
  }
  return tmin > 0.01 ? tmin : -1;
}

/** Distance along the shot to the nearest wall, crate or pillar. */
function wallDistance(origin, dir, far) {
  let best = far;
  for (let i = 0; i < colliders.length; i++) {
    const t = rayBox(origin, dir, colliders[i], best);
    if (t > 0 && t < best) best = t;
  }
  return best;
}

function hurtBot(bot, isHead) {
  const damage = isHead ? HEAD_DAMAGE : BODY_DAMAGE;
  bot.health = Math.max(0, bot.health - damage);
  bot.flash = 0.12;
  if (bot.materials && bot.materials.body) {
    bot.materials.body.emissive.setHex(isHead ? 0xff2e63 : 0xffffff);
    bot.materials.body.emissiveIntensity = 0.9;
  }
  hud.hitmarker();

  if (bot.health <= 0) {
    bot.health = 0;
    bot.alive = false;
    bot.state = 'dead';
    bot.group.visible = false;
    // Stays down for the rest of the round: the module's own 2.5 s respawn would
    // otherwise refill the arena and "clear all six" could never be reached.
    bot.respawnTimer = Infinity;
    kills += 1;
  }
}

function shoot() {
  const moving = player.speed > 0.8 || !player.grounded;
  // The module builds its cone as CONE_BASE * spread, so hand it the player's
  // state as a multiple of the rested value: planted and crouched is a hair
  // over a third of nominal, a sprint or a jump is four times nominal.
  const spread = THREE.MathUtils.clamp(player.spread / SPREAD_NOMINAL, 0.35, 4);

  const dir = weapon.fire(spread, moving);
  if (!dir) return;                       // clicked empty, or still reloading
  shotDir.copy(dir);

  camera.getWorldPosition(shotOrigin);

  // Bodies first, then the map: a bot behind cover is not a hit.
  const bodyHit = shooters.hitTest(shotOrigin, shotDir, SHOT_RANGE);
  const wall = wallDistance(shotOrigin, shotDir, SHOT_RANGE);

  if (bodyHit && bodyHit.distance < wall) hurtBot(bodyHit.bot, bodyHit.isHead);
}

/* -------------------------------------------------------------- round state */

function requestLock() {
  if (document.pointerLockElement === canvas) return;
  if (typeof canvas.requestPointerLock !== 'function') return;
  try {
    const req = canvas.requestPointerLock();
    if (req && typeof req.catch === 'function') req.catch(function () { locked = false; });
  } catch (err) {
    locked = false;
  }
}

function startRound() {
  player.reset(SPAWN);
  yaw = SPAWN.yaw;
  pitch = SPAWN.pitch;
  camera.rotation.set(pitch, yaw, 0, 'YXZ');

  // Finish any reload left in the air by the last round, then refill: setting
  // the counters alone would leave the gun dipped for the first two seconds.
  weapon.update(weapon.RELOAD_TIME + 0.1);
  weapon.mag = weapon.MAG_SIZE;
  weapon.reserve = weapon.RESERVE_START;
  lastRecoil = 0;

  shooters.reset();

  paused = false;
  roundLeft = ROUND_TIME;
  elapsed = 0;
  hurtAt = -999;
  kills = 0;
  score = 0;
  fireCooldown = 0;
  triggerDown = false;
  phase = 'live';

  hud.hideEnd();
  hud.setHealth(player.health);
  hud.setAmmo(weapon.mag, weapon.reserve);
  hud.setTimer(roundLeft);
  hud.setScore(0);
  requestLock();
}

function finishRound(win) {
  if (phase !== 'live') return;
  phase = 'over';
  score = currentScore();
  hud.setScore(score);

  const bonus = Math.floor(elapsed / 10);
  const tally = kills + ' of ' + BOT_COUNT + ' hostiles down · ' +
                kills + ' kills + ' + bonus + ' time';
  hud.showEnd({
    title: win ? 'ROUND WON' : 'ROUND LOST',
    copy: win
      ? 'Arena cleared with ' + roundLeft.toFixed(1) + ' s left on the clock. ' + tally +
        '. Final score ' + score + '. Deploy to run it again.'
      : (player.health <= 0 ? 'You went down. ' : 'The clock ran out. ') + tally +
        '. Final score ' + score + '. Deploy to reset the arena.',
  });

  if (document.exitPointerLock) {
    try { document.exitPointerLock(); } catch (err) { /* ignore */ }
  }
}

hud.onPlay = startRound;

/* ------------------------------------------------------------------- input */

window.addEventListener('keydown', function (ev) {
  pressed.add(ev.code || ev.key);
  if (ev.code === 'Space' || ev.code === 'Tab') ev.preventDefault();
  if (ev.code === 'KeyR' && phase === 'live') weapon.reload();
});
window.addEventListener('keyup', function (ev) {
  pressed.delete(ev.code || ev.key);
});
window.addEventListener('blur', function () {
  pressed.clear();
  triggerDown = false;
});

canvas.addEventListener('click', function () {
  if (phase !== 'live') return;           // the overlay owns that click
  requestLock();
});

document.addEventListener('pointerlockchange', function () {
  locked = document.pointerLockElement === canvas;
  if (locked) {
    everLocked = true;
    paused = false;
    hud.hideEnd();
    return;
  }
  pressed.clear();
  triggerDown = false;
  // Only freeze a round the player was actually steering: a browser that never
  // granted the lock must not leave the arena standing still forever.
  if (phase === 'live' && everLocked) {
    paused = true;
    hud.setMessage('PAUSED', 'The mouse was handed back, so the round is held. Press Deploy to re-arm and drop straight back in.');
  }
});

document.addEventListener('mousemove', function (ev) {
  if (!locked || phase !== 'live') return;
  yaw -= ev.movementX * LOOK_SENS;
  pitch = THREE.MathUtils.clamp(pitch - ev.movementY * LOOK_SENS, -PITCH_LIMIT, PITCH_LIMIT);
});

canvas.addEventListener('mousedown', function (ev) {
  if (ev.button !== 0) return;
  triggerDown = true;
  if (phase === 'live' && document.pointerLockElement !== canvas) requestLock();
});
window.addEventListener('mouseup', function (ev) {
  if (ev.button === 0) triggerDown = false;
});
canvas.addEventListener('contextmenu', function (ev) { ev.preventDefault(); });

/* -------------------------------------------------------------------- loop */

function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(w, h);
}
window.addEventListener('resize', resize);

const clock = new THREE.Clock();

function frame() {
  requestAnimationFrame(frame);

  const dt = Math.min(clock.getDelta(), MAX_DELTA);

  // --- the view is the source of truth for heading while the round is live ---
  camera.rotation.set(pitch, yaw, 0, 'YXZ');

  if (phase === 'live' && !paused) {
    player.update(dt, { keys: pressed, camera: camera });

    // Recoil is a real kick off the shoulder: added into pitch as it rises, never
    // paid back, so spraying climbs off the target and a paced shot stays flat.
    const rise = weapon.recoil - lastRecoil;
    if (rise > 0) pitch = THREE.MathUtils.clamp(pitch + rise, -PITCH_LIMIT, PITCH_LIMIT);
    lastRecoil = weapon.recoil;

    // The world module is static geometry and publishes only its colliders, so
    // its tick is optional today: the guard means a future live element (a door,
    // a moving light) hooks in here without the hub needing surgery.
    if (typeof world.update === 'function') world.update(dt);

    weapon.setMotion(player.speed, player.crouch);
    weapon.setCrouched(player.crouch);
    weapon.update(dt);

    // Bots see the adapter: real body, real eye line, scaled-down rounds.
    shooters.update(dt, botTarget);

    // Out of contact for six seconds, health climbs back. Standing in the open
    // still kills you; breaking line of sight is what buys the next push.
    if (player.alive && elapsed - hurtAt > REGEN_DELAY && player.health < player.maxHealth) {
      player.health = Math.min(player.maxHealth, player.health + REGEN_RATE * dt);
    }

    fireCooldown -= dt;
    if (triggerDown && fireCooldown <= 0) {
      if (weapon.canFire()) {
        shoot();
        fireCooldown = FIRE_INTERVAL;
      } else if (weapon.reserve > 0) {
        weapon.reload();
      }
    }
    if (weapon.mag === 0 && weapon.reserve > 0 && !weapon.reloading) weapon.reload();

    elapsed += dt;
    roundLeft = Math.max(0, ROUND_TIME - elapsed);
    score = currentScore();

    hud.setHealth(player.health);
    hud.setAmmo(weapon.mag, weapon.reserve);
    hud.setTimer(roundLeft);
    hud.setScore(score);

    if (kills >= BOT_COUNT) finishRound(true);
    else if (player.health <= 0) finishRound(false);
    else if (roundLeft <= 0) finishRound(false);
  } else {
    weapon.update(dt);
  }

  // --- the eye rides the body: crouch drops it, a jump lifts it --------------
  camera.position.set(
    player.position.x,
    player.position.y + player.eyeHeight,
    player.position.z
  );
  camera.updateMatrixWorld();

  renderer.render(scene, camera);
}

hud.setHealth(player.health);
hud.setAmmo(weapon.mag, weapon.reserve);
hud.setTimer(ROUND_TIME);
hud.setScore(0);

frame();

