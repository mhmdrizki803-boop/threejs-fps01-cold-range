/**
 * game/src/shooters.js
 *
 * Enemy bots for the arena shooter.
 *
 * Bodies are built from boxes: torso, legs, arms, and a separate head box that
 * hangs off the torso as its own mesh, so a ray can tell a head hit from a body
 * hit and pay the player accordingly.
 *
 * Behaviour: patrol between two seeded waypoints; when the player is inside 30
 * units with a clear segment to the chest, stop, turn to face them and fire on a
 * seeded 0.9 - 1.4 s cadence for 8 - 14 damage. Hitscan both ways.
 *
 * Bots never clip the level: they are clamped to the arena footprint and pushed
 * out of every Box3 collider one axis at a time, nearest face first.
 *
 * A dead bot comes back 2.5 s later at a seeded spawn point, preferring one far
 * from the player. Six bots are alive at once.
 *
 * One mulberry32 generator drives every random choice, so a match replays the
 * same way twice.
 */

import * as THREE from 'three';
import * as PALETTE from './palette.js';

/* ------------------------------------------------------------------------- *
 * Seeded PRNG
 * ------------------------------------------------------------------------- */

const SEED = 0x1a2b3c4d;

function mulberry32(a) {
  let s = a | 0;
  return function rng() {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------------- *
 * Palette
 * ------------------------------------------------------------------------- */

function toColor(value) {
  if (value == null) return null;
  if (value && value.isColor) return value.clone();
  if (typeof value === 'number') return new THREE.Color(value);
  if (typeof value === 'string') {
    try {
      return new THREE.Color(value);
    } catch (err) {
      return null;
    }
  }
  if (Array.isArray(value) && value.length >= 3) {
    return new THREE.Color(value[0], value[1], value[2]);
  }
  if (typeof value === 'object' && 'r' in value && 'g' in value && 'b' in value) {
    return new THREE.Color(value.r, value.g, value.b);
  }
  return null;
}

function paletteColor(names, fallbackHex) {
  const pools = [PALETTE, PALETTE && PALETTE.colors, PALETTE && PALETTE.palette, PALETTE && PALETTE.default];
  for (let p = 0; p < pools.length; p++) {
    const pool = pools[p];
    if (!pool || typeof pool !== 'object') continue;
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      if (!(name in pool)) continue;
      const c = toColor(pool[name]);
      if (c) return c;
    }
  }
  return new THREE.Color(fallbackHex);
}

/* ------------------------------------------------------------------------- *
 * Tuning
 * ------------------------------------------------------------------------- */

const BOT_COUNT = 6;
const BOT_HEALTH = 100;
const BODY_DAMAGE = 26;
const HEAD_MULTIPLIER = 3;
const SIGHT_RANGE = 30;
const FIRE_MIN = 0.9;
const FIRE_MAX = 1.4;
const BOT_DAMAGE_MIN = 8;
const BOT_DAMAGE_MAX = 14;
const RESPAWN_DELAY = 2.5;
const BOT_RADIUS = 0.42;
const BOT_SPEED_MIN = 1.6;
const BOT_SPEED_MAX = 2.4;
const TURN_PATROL = 5.0;
const TURN_COMBAT = 8.5;
const BODY_TOP = 1.72;
const HEAD_WORLD_Y = 1.54;
const Z_AXIS = new THREE.Vector3(0, 0, 1);

/* ------------------------------------------------------------------------- *
 * Helpers
 * ------------------------------------------------------------------------- */

function num(value, fallback) {
  return typeof value === 'number' && isFinite(value) ? value : fallback;
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function vec3(value) {
  if (!value) return null;
  if (value.isVector3) return value.clone();
  if (Array.isArray(value) && value.length >= 3) {
    return new THREE.Vector3(num(value[0], 0), num(value[1], 0), num(value[2], 0));
  }
  if (typeof value === 'object' && typeof value.x === 'number') {
    return new THREE.Vector3(num(value.x, 0), num(value.y, 0), num(value.z, 0));
  }
  return null;
}

function shortAngleDelta(from, to) {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function turnToward(current, target, maxStep) {
  const d = shortAngleDelta(current, target);
  if (Math.abs(d) <= maxStep) return target;
  return current + (d > 0 ? maxStep : -maxStep);
}

/** Does this collider stand in the walking volume? */
function blocksBody(box) {
  return box.max.y > 0.2 && box.min.y < BODY_TOP;
}

/** Slab test over every solid box. True when the segment touches nothing. */
function segmentClear(a, b, colliders) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  for (let i = 0; i < colliders.length; i++) {
    const box = colliders[i];
    let tmin = 0;
    let tmax = 1;
    let hit = true;
    for (let axis = 0; axis < 3; axis++) {
      const origin = axis === 0 ? a.x : axis === 1 ? a.y : a.z;
      const delta = axis === 0 ? dx : axis === 1 ? dy : dz;
      const lo = axis === 0 ? box.min.x : axis === 1 ? box.min.y : box.min.z;
      const hi = axis === 0 ? box.max.x : axis === 1 ? box.max.y : box.max.z;
      if (Math.abs(delta) < 1e-8) {
        if (origin < lo || origin > hi) {
          hit = false;
          break;
        }
        continue;
      }
      let t1 = (lo - origin) / delta;
      let t2 = (hi - origin) / delta;
      if (t1 > t2) {
        const swap = t1;
        t1 = t2;
        t2 = swap;
      }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) {
        hit = false;
        break;
      }
    }
    if (hit) return false;
  }
  return true;
}

/** Distance along a ray to the first solid surface, capped at `far`. */
function rayDistance(origin, dir, far, colliders) {
  let best = far;
  for (let i = 0; i < colliders.length; i++) {
    const box = colliders[i];
    let tmin = 0;
    let tmax = best;
    let hit = true;
    for (let axis = 0; axis < 3; axis++) {
      const o = axis === 0 ? origin.x : axis === 1 ? origin.y : origin.z;
      const d = axis === 0 ? dir.x : axis === 1 ? dir.y : dir.z;
      const lo = axis === 0 ? box.min.x : axis === 1 ? box.min.y : box.min.z;
      const hi = axis === 0 ? box.max.x : axis === 1 ? box.max.y : box.max.z;
      if (Math.abs(d) < 1e-8) {
        if (o < lo || o > hi) {
          hit = false;
          break;
        }
        continue;
      }
      let t1 = (lo - o) / d;
      let t2 = (hi - o) / d;
      if (t1 > t2) {
        const swap = t1;
        t1 = t2;
        t2 = swap;
      }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) {
        hit = false;
        break;
      }
    }
    if (hit && tmin > 0.01 && tmin < best) best = tmin;
  }
  return best;
}

/* ------------------------------------------------------------------------- *
 * createShooters
 * ------------------------------------------------------------------------- */

export function createShooters(scene, colliders) {
  const boxes = [];
  const source = Array.isArray(colliders) ? colliders : [];
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (!c) continue;
    if (c.isBox3) {
      boxes.push(c);
    } else if (c.min && c.max) {
      const min = vec3(c.min);
      const max = vec3(c.max);
      if (min && max) boxes.push(new THREE.Box3(min, max));
    }
  }

  const rand = mulberry32(SEED);

  /* ---- arena footprint ---------------------------------------------------- */

  const arenaMin = new THREE.Vector3(-18, 0, -18);
  const arenaMax = new THREE.Vector3(18, 8, 18);
  if (boxes.length) {
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    let maxY = 0;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      if (b.min.x < minX) minX = b.min.x;
      if (b.min.z < minZ) minZ = b.min.z;
      if (b.max.x > maxX) maxX = b.max.x;
      if (b.max.z > maxZ) maxZ = b.max.z;
      if (b.max.y > maxY) maxY = b.max.y;
    }
    if (isFinite(minX) && maxX - minX > 3 && maxZ - minZ > 3) {
      arenaMin.set(minX + 0.15, 0, minZ + 0.15);
      arenaMax.set(maxX - 0.15, Math.max(4, maxY), maxZ - 0.15);
    }
  }

  /* ---- colours ------------------------------------------------------------ */

  const bodyColor = paletteColor(['bot', 'enemyBody', 'enemy', 'hostile', 'steel'], 0x2b3340);
  const headColor = paletteColor(['botHead', 'enemyHead', 'ink'], 0x8e97a8);
  const accentColor = paletteColor(['accent', 'enemyAccent', 'danger', 'alert'], 0xff5a3c);
  const hitColor = paletteColor(['hit', 'muzzle'], 0xfff1c2);
  const tracerColor = paletteColor(['tracer', 'bullet', 'accent'], 0xffb066);

  const bodyBase = bodyColor.clone();
  const headBase = headColor.clone();

  /* ---- shared geometry ---------------------------------------------------- */

  const torsoGeo = new THREE.BoxGeometry(0.62, 0.78, 0.36);
  const headGeo = new THREE.BoxGeometry(0.32, 0.32, 0.32);
  const visorGeo = new THREE.BoxGeometry(0.24, 0.08, 0.03);
  const legGeo = new THREE.BoxGeometry(0.46, 0.72, 0.3);
  const armGeo = new THREE.BoxGeometry(0.14, 0.6, 0.18);
  const tracerGeo = new THREE.BoxGeometry(0.035, 0.035, 1);
  const sparkGeo = new THREE.IcosahedronGeometry(0.11, 0);

  /* ---- effect pools ------------------------------------------------------- */

  function makePool(geometry, color, count) {
    const pool = [];
    for (let i = 0; i < count; i++) {
      const material = new THREE.MeshBasicMaterial({
        color: color.clone(),
        transparent: true,
        opacity: 0.95,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.visible = false;
      mesh.frustumCulled = false;
      scene.add(mesh);
      pool.push({ mesh, life: 0, maxLife: 1 });
    }
    return pool;
  }

  function take(pool) {
    let oldest = pool[0];
    for (let i = 0; i < pool.length; i++) {
      if (pool[i].life <= 0) return pool[i];
      if (pool[i].life < oldest.life) oldest = pool[i];
    }
    return oldest;
  }

  function stepPool(pool, dt) {
    for (let i = 0; i < pool.length; i++) {
      const item = pool[i];
      if (item.life <= 0) continue;
      item.life -= dt;
      if (item.life <= 0) {
        item.life = 0;
        item.mesh.visible = false;
      } else {
        item.mesh.material.opacity = 0.95 * (item.life / item.maxLife);
      }
    }
  }

  const tracers = makePool(tracerGeo, tracerColor, 16);
  const sparks = makePool(sparkGeo, hitColor, 20);

  function spawnTracer(from, to) {
    const dir = to.clone().sub(from);
    const len = dir.length();
    if (len < 1e-4) return;
    dir.divideScalar(len);
    const item = take(tracers);
    item.life = 0.07;
    item.maxLife = 0.07;
    item.mesh.visible = true;
    item.mesh.material.opacity = 0.95;
    item.mesh.position.copy(from).addScaledVector(dir, len * 0.5);
    item.mesh.quaternion.setFromUnitVectors(Z_AXIS, dir);
    item.mesh.scale.set(1, 1, len);
  }

  function spawnSpark(at) {
    const item = take(sparks);
    item.life = 0.16;
    item.maxLife = 0.16;
    item.mesh.visible = true;
    item.mesh.material.opacity = 0.95;
    item.mesh.position.copy(at);
    item.mesh.scale.setScalar(0.7 + rand() * 0.5);
  }

  /* ---- walkable placement ------------------------------------------------- */

  function blockedXZ(x, z, pad) {
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      if (!blocksBody(b)) continue;
      if (x > b.min.x - pad && x < b.max.x + pad && z > b.min.z - pad && z < b.max.z + pad) return true;
    }
    return false;
  }

  function samplePoint(pad) {
    const x0 = arenaMin.x + pad;
    const x1 = arenaMax.x - pad;
    const z0 = arenaMin.z + pad;
    const z1 = arenaMax.z - pad;
    for (let attempt = 0; attempt < 48; attempt++) {
      const x = x0 + (x1 - x0) * rand();
      const z = z0 + (z1 - z0) * rand();
      if (!blockedXZ(x, z, pad)) return new THREE.Vector3(x, 0, z);
    }
    return new THREE.Vector3((arenaMin.x + arenaMax.x) * 0.5, 0, (arenaMin.z + arenaMax.z) * 0.5);
  }

  const spawnPoints = [];
  for (let i = 0; i < 8; i++) spawnPoints.push(samplePoint(1.2));

  /* ---- body vs. level ----------------------------------------------------- */

  function pushOut(pos, radius) {
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < boxes.length; i++) {
        const b = boxes[i];
        if (!blocksBody(b)) continue;

        const minX = b.min.x - radius;
        const maxX = b.max.x + radius;
        const minZ = b.min.z - radius;
        const maxZ = b.max.z + radius;
        if (pos.x <= minX || pos.x >= maxX || pos.z <= minZ || pos.z >= maxZ) continue;

        // eject along the shallower axis first...
        const penX = Math.min(pos.x - minX, maxX - pos.x);
        const penZ = Math.min(pos.z - minZ, maxZ - pos.z);
        if (penX <= penZ) {
          pos.x = pos.x - minX < maxX - pos.x ? minX : maxX;
        } else {
          pos.z = pos.z - minZ < maxZ - pos.z ? minZ : maxZ;
        }

        // ...then settle the other axis if the body still overlaps it
        if (pos.x > minX && pos.x < maxX && pos.z > minZ && pos.z < maxZ) {
          pos.z = pos.z - minZ < maxZ - pos.z ? minZ : maxZ;
        }
      }
    }
  }

  function confine(pos) {
    pos.y = 0;
    pos.x = clamp(pos.x, arenaMin.x + BOT_RADIUS, arenaMax.x - BOT_RADIUS);
    pos.z = clamp(pos.z, arenaMin.z + BOT_RADIUS, arenaMax.z - BOT_RADIUS);
    pushOut(pos, BOT_RADIUS);
    pos.x = clamp(pos.x, arenaMin.x + BOT_RADIUS, arenaMax.x - BOT_RADIUS);
    pos.z = clamp(pos.z, arenaMin.z + BOT_RADIUS, arenaMax.z - BOT_RADIUS);
  }

  /* ---- bots --------------------------------------------------------------- */

  const list = [];

  function buildBot(id) {
    const group = new THREE.Group();
    group.name = 'bot_' + id;

    const bodyMat = new THREE.MeshStandardMaterial({
      color: bodyBase.clone(),
      roughness: 0.78,
      metalness: 0.14,
      emissive: new THREE.Color(0x000000),
      emissiveIntensity: 0,
    });
    const headMat = new THREE.MeshStandardMaterial({
      color: headBase.clone(),
      roughness: 0.5,
      metalness: 0.22,
      emissive: accentColor.clone(),
      emissiveIntensity: 0.22,
    });
    const visorMat = new THREE.MeshStandardMaterial({
      color: accentColor.clone(),
      roughness: 0.3,
      metalness: 0.45,
      emissive: accentColor.clone(),
      emissiveIntensity: 0.9,
    });

    const torso = new THREE.Mesh(torsoGeo, bodyMat);
    torso.position.y = 0.98;
    torso.userData.part = 'torso';
    group.add(torso);

    // the head is its own mesh, parented to the torso, so a ray can single it out
    const head = new THREE.Mesh(headGeo, headMat);
    head.name = 'head';
    head.position.y = 0.56;
    head.userData.part = 'head';
    torso.add(head);

    const visor = new THREE.Mesh(visorGeo, visorMat);
    visor.position.set(0, 0.03, 0.17);
    visor.userData.part = 'head';
    head.add(visor);

    const legs = new THREE.Mesh(legGeo, bodyMat);
    legs.position.y = 0.36;
    legs.userData.part = 'torso';
    group.add(legs);

    for (let s = -1; s <= 1; s += 2) {
      const arm = new THREE.Mesh(armGeo, bodyMat);
      arm.position.set(s * 0.39, 1.0, 0.02);
      arm.userData.part = 'torso';
      group.add(arm);
    }

    scene.add(group);

    const bot = {
      id,
      group,
      torso,
      head,
      materials: { body: bodyMat, head: headMat, visor: visorMat },
      health: BOT_HEALTH,
      maxHealth: BOT_HEALTH,
      alive: true,
      aim: new THREE.Vector3(),
      state: 'patrol',
      yaw: 0,
      speed: BOT_SPEED_MIN + (BOT_SPEED_MAX - BOT_SPEED_MIN) * rand(),
      waypoints: [samplePoint(1.0), samplePoint(1.0)],
      wpIndex: 0,
      pause: 0,
      fireTimer: FIRE_MIN + rand() * (FIRE_MAX - FIRE_MIN),
      respawnTimer: 0,
      flash: 0,
    };

    group.userData.botRef = bot;
    return bot;
  }

  for (let i = 0; i < BOT_COUNT; i++) {
    const bot = buildBot(i);
    const spawn = spawnPoints[i % spawnPoints.length];
    bot.group.position.copy(spawn);
    bot.yaw = rand() * Math.PI * 2;
    bot.group.rotation.y = bot.yaw;
    bot.aim.set(spawn.x + Math.sin(bot.yaw) * 3, HEAD_WORLD_Y, spawn.z + Math.cos(bot.yaw) * 3);
    list.push(bot);
  }

  /* ---- the player --------------------------------------------------------- */

  function playerChest(player) {
    if (!player) return null;
    const explicit = vec3(player.chest) || vec3(player.chestPosition);
    if (explicit) return explicit;

    const base = vec3(player.position) || vec3(player.pos) || vec3(player.feet) || vec3(player.cameraPosition);
    if (!base) return null;

    // player.position is the feet; eyeHeight is measured from there, so the chest
    // sits a little under the eye line. Without an eyeHeight we fall back to the
    // height heuristic for modules that report the camera position instead.
    let y;
    if (typeof player.chestHeight === 'number') y = base.y + player.chestHeight;
    else if (typeof player.eyeHeight === 'number') y = base.y + Math.max(0.9, player.eyeHeight - 0.45);
    else if (base.y > 1.0) y = base.y - 0.45;
    else y = base.y + 1.2;
    return new THREE.Vector3(base.x, y, base.z);
  }

  function playerIsAlive(player) {
    if (!player) return false;
    if (player.alive === false) return false;
    if (typeof player.health === 'number' && player.health <= 0) return false;
    return true;
  }

  function damagePlayer(player, amount) {
    if (typeof player.damage === 'function') player.damage(amount);
    else if (typeof player.takeDamage === 'function') player.takeDamage(amount);
    else if (typeof player.hurt === 'function') player.hurt(amount);
    else if (typeof player.health === 'number') player.health = Math.max(0, player.health - amount);
    else if (typeof player.hp === 'number') player.hp = Math.max(0, player.hp - amount);
  }

  /* ---- reading the player's shot ------------------------------------------ */
  /* The weapon may publish its shot as a record (origin + direction/target), via
   * consumeShot(), or just by dropping ammunition — the last case falls back to
   * the view ray, which is where the crosshair was pointing anyway. */

  const SHOT_FIELDS = ['shot', 'lastShot', 'lastShotRay', 'shotRay', 'playerShot', 'shotInfo', 'lastShotInfo'];
  const WEAPON_FIELDS = ['weapon', 'gun', 'currentWeapon', 'rifle', 'arms'];
  const COUNT_FIELDS = ['shotsFired', 'shotCount', 'shots', 'roundsFired', 'bulletsFired', 'fireCount'];
  const seen = new WeakSet();
  let lastSignature = null;
  let lastAmmo = null;
  let lastCount = null;

  function ammoOf(player) {
    const direct = num(player.ammo, num(player.ammoInMag, num(player.magazine, NaN)));
    if (isFinite(direct)) return direct;
    for (let i = 0; i < WEAPON_FIELDS.length; i++) {
      const w = player[WEAPON_FIELDS[i]];
      if (!w || typeof w !== 'object') continue;
      const a = num(w.ammo, num(w.ammoInMag, num(w.magazine, num(w.mag, NaN))));
      if (isFinite(a)) return a;
    }
    return NaN;
  }

  /** Monotonic number of rounds the weapon has fired, if it publishes one. */
  function shotCountOf(player) {
    const direct = num(player.shotsFired, num(player.shotCount, NaN));
    if (isFinite(direct)) return direct;
    for (let i = 0; i < WEAPON_FIELDS.length; i++) {
      const w = player[WEAPON_FIELDS[i]];
      if (!w || typeof w !== 'object') continue;
      for (let j = 0; j < COUNT_FIELDS.length; j++) {
        const v = num(w[COUNT_FIELDS[j]], NaN);
        if (isFinite(v)) return v;
      }
    }
    for (let j = 0; j < COUNT_FIELDS.length; j++) {
      const v = num(player[COUNT_FIELDS[j]], NaN);
      if (isFinite(v)) return v;
    }
    return NaN;
  }

  function parseShot(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const origin = vec3(raw.origin) || vec3(raw.from) || vec3(raw.start) || vec3(raw.position);
    if (!origin) return null;

    let dir = vec3(raw.direction) || vec3(raw.dir) || vec3(raw.forward);
    if (!dir) {
      const to = vec3(raw.to) || vec3(raw.target) || vec3(raw.end) || vec3(raw.point) || vec3(raw.hitPoint);
      if (!to) return null;
      dir = to.clone().sub(origin);
    }
    if (dir.lengthSq() < 1e-8) return null;
    dir.normalize();

    const key = [
      origin.x.toFixed(3), origin.y.toFixed(3), origin.z.toFixed(3),
      dir.x.toFixed(4), dir.y.toFixed(4), dir.z.toFixed(4),
    ].join('|');

    return {
      origin,
      dir,
      range: num(raw.range, num(raw.far, num(raw.distance, 220))),
      damage: num(raw.damage, NaN),
      key,
    };
  }

  function aimRay(player) {
    const origin = vec3(player.position) || vec3(player.pos);
    if (!origin) return null;
    // eye level: feet + eyeHeight, unless the module already reports the camera
    if (typeof player.eyeHeight === 'number') origin.y += player.eyeHeight;
    else if (origin.y < 1.0) origin.y += 1.62;
    const yaw = num(player.yaw, 0);
    const pitch = num(player.pitch, 0);
    const cp = Math.cos(pitch);
    // same convention as player.getForward(): forward = (-sin(yaw), 0, -cos(yaw))
    const dir = new THREE.Vector3(-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp).normalize();
    return { origin, dir, range: 220, damage: NaN, key: 'aim' };
  }

  function pollShot(player) {
    if (!player) return null;

    if (typeof player.consumeShot === 'function') {
      let consumed = null;
      try {
        consumed = player.consumeShot();
      } catch (err) {
        consumed = null;
      }
      const parsed = parseShot(consumed);
      if (parsed) {
        lastAmmo = ammoOf(player);
        return parsed;
      }
    }

    const candidates = [];
    for (let i = 0; i < SHOT_FIELDS.length; i++) {
      const s = player[SHOT_FIELDS[i]];
      if (s && typeof s === 'object') candidates.push(s);
    }
    for (let i = 0; i < WEAPON_FIELDS.length; i++) {
      const w = player[WEAPON_FIELDS[i]];
      if (!w || typeof w !== 'object') continue;
      for (let j = 0; j < SHOT_FIELDS.length; j++) {
        const s = w[SHOT_FIELDS[j]];
        if (s && typeof s === 'object') candidates.push(s);
      }
    }

    for (let i = 0; i < candidates.length; i++) {
      const raw = candidates[i];
      const parsed = parseShot(raw);
      if (!parsed) continue;
      if (seen.has(raw) && parsed.key === lastSignature) continue;
      seen.add(raw);
      lastSignature = parsed.key;
      lastAmmo = ammoOf(player);
      return parsed;
    }

    // Nothing published a ray, so infer the shot: a rising shot counter or a
    // falling magazine both mean a round left the barrel this frame.
    const countNow = shotCountOf(player);
    const ammoNow = ammoOf(player);
    const counterRose = isFinite(countNow) && isFinite(lastCount) && countNow > lastCount;
    const ammoFell = isFinite(ammoNow) && isFinite(lastAmmo) && ammoNow < lastAmmo;
    lastCount = countNow;
    lastAmmo = ammoNow;
    if (counterRose || ammoFell) return aimRay(player);
    return null;
  }

  /* ---- hits --------------------------------------------------------------- */

  const raycaster = new THREE.Raycaster();

  function partOf(object) {
    let node = object;
    while (node) {
      if (node.userData && node.userData.part) return node.userData.part;
      node = node.parent;
    }
    return null;
  }

  function botOf(object) {
    let node = object;
    while (node) {
      if (node.userData && node.userData.botRef) return node.userData.botRef;
      node = node.parent;
    }
    return null;
  }

  function liveTargets() {
    const targets = [];
    for (let i = 0; i < list.length; i++) {
      const bot = list[i];
      if (!bot.alive) continue;
      bot.group.updateMatrixWorld(true);
      targets.push(bot.group);
    }
    return targets;
  }

  /**
   * Ray against the bots, stopping at the first wall.
   * Returns { bot, point, isHead, distance } or null. A bot behind cover is not
   * a hit, which is what makes the level's walls and crates mean something.
   */
  function hitTest(origin, direction, range) {
    const o = vec3(origin);
    const d = vec3(direction);
    if (!o || !d || d.lengthSq() < 1e-8) return null;
    d.normalize();

    const far = num(range, 220);
    const wallDist = rayDistance(o, d, far, boxes);

    raycaster.set(o, d);
    raycaster.far = far;
    const hits = raycaster.intersectObjects(liveTargets(), true);
    for (let i = 0; i < hits.length; i++) {
      const hit = hits[i];
      const part = partOf(hit.object);
      const bot = botOf(hit.object);
      if (!part || !bot || !bot.alive) continue;
      // a closer solid surface means the round never reached the body
      if (hit.distance > wallDist + 0.02) return null;
      return { bot, point: hit.point.clone(), isHead: part === 'head', distance: hit.distance };
    }
    return null;
  }

  function isHeadDamage(isHead) {
    return isHead ? BODY_DAMAGE * HEAD_MULTIPLIER : BODY_DAMAGE;
  }

  function damageFor(shot, isHead) {
    const base = isFinite(shot.damage) && shot.damage > 0 && shot.damage <= 200 ? shot.damage : BODY_DAMAGE;
    return isHead ? Math.round(base * HEAD_MULTIPLIER) : base;
  }

  function applyHit(bot, point, isHead, damage, onHit) {
    if (!bot || !bot.alive) return;
    bot.health = Math.max(0, bot.health - damage);
    bot.flash = 0.12;
    bot.materials.body.emissive.copy(hitColor);
    bot.materials.body.emissiveIntensity = 0.9;
    spawnSpark(point || bot.head.getWorldPosition(new THREE.Vector3()));

    if (typeof onHit === 'function') onHit(bot, point || new THREE.Vector3(), !!isHead);

    if (bot.health <= 0) {
      bot.health = 0;
      bot.alive = false;
      bot.state = 'dead';
      bot.group.visible = false;
      bot.materials.body.emissiveIntensity = 0;
      bot.respawnTimer = RESPAWN_DELAY;
      bot.pause = 0;
      bot.fireTimer = FIRE_MIN;
    }
  }

  function respawn(bot, player) {
    let index = Math.floor(rand() * spawnPoints.length) % spawnPoints.length;
    const chest = playerChest(player);
    if (chest) {
      for (let attempt = 0; attempt < spawnPoints.length; attempt++) {
        const candidate = spawnPoints[(index + attempt) % spawnPoints.length];
        if (candidate.distanceTo(chest) > 7) {
          index = (index + attempt) % spawnPoints.length;
          break;
        }
      }
    }
    const spawn = spawnPoints[index];
    bot.group.position.copy(spawn);
    bot.group.visible = true;
    bot.alive = true;
    bot.health = BOT_HEALTH;
    bot.state = 'patrol';
    bot.respawnTimer = 0;
    bot.flash = 0;
    bot.pause = 0;
    bot.wpIndex = 0;
    bot.waypoints[0] = samplePoint(1.0);
    bot.waypoints[1] = samplePoint(1.0);
    bot.yaw = rand() * Math.PI * 2;
    bot.group.rotation.y = bot.yaw;
    bot.fireTimer = FIRE_MIN + rand() * (FIRE_MAX - FIRE_MIN);
    bot.aim.set(spawn.x + Math.sin(bot.yaw) * 3, HEAD_WORLD_Y, spawn.z + Math.cos(bot.yaw) * 3);
    bot.materials.body.emissiveIntensity = 0;
  }

  /* ---- behaviour ---------------------------------------------------------- */

  const tmpHead = new THREE.Vector3();
  const tmpMuzzle = new THREE.Vector3();

  function headWorld(bot, out) {
    return out.set(bot.group.position.x, bot.group.position.y + HEAD_WORLD_Y, bot.group.position.z);
  }

  function patrol(bot, dt) {
    if (bot.pause > 0) {
      bot.pause -= dt;
      bot.aim.set(
        bot.group.position.x + Math.sin(bot.yaw) * 3.5,
        HEAD_WORLD_Y,
        bot.group.position.z + Math.cos(bot.yaw) * 3.5
      );
      return;
    }

    const wp = bot.waypoints[bot.wpIndex];
    const dx = wp.x - bot.group.position.x;
    const dz = wp.z - bot.group.position.z;
    const dist = Math.sqrt(dx * dx + dz * dz);

    if (dist < 0.45) {
      bot.wpIndex = bot.wpIndex === 0 ? 1 : 0;
      bot.pause = 0.3 + rand() * 1.0;
      return;
    }

    const ux = dx / dist;
    const uz = dz / dist;
    const travel = Math.min(bot.speed * dt, dist);
    bot.group.position.x += ux * travel;
    bot.group.position.z += uz * travel;
    bot.yaw = turnToward(bot.yaw, Math.atan2(ux, uz), TURN_PATROL * dt);
    bot.aim.set(bot.group.position.x + ux * 3.5, HEAD_WORLD_Y, bot.group.position.z + uz * 3.5);
  }

  function botFire(bot, chest, player) {
    const muzzle = headWorld(bot, tmpMuzzle).clone();
    muzzle.x += Math.sin(bot.yaw) * 0.32;
    muzzle.z += Math.cos(bot.yaw) * 0.32;

    spawnTracer(muzzle, chest);
    spawnSpark(muzzle);

    const damage = BOT_DAMAGE_MIN + Math.floor(rand() * (BOT_DAMAGE_MAX - BOT_DAMAGE_MIN + 1));
    damagePlayer(player, damage);
    bot.fireTimer = FIRE_MIN + rand() * (FIRE_MAX - FIRE_MIN);
  }

  function stepBot(bot, dt, player, onHit) {
    if (!bot.alive) {
      bot.respawnTimer -= dt;
      if (bot.respawnTimer <= 0) respawn(bot, player);
      return;
    }

    if (bot.flash > 0) {
      bot.flash -= dt;
      if (bot.flash <= 0) {
        bot.flash = 0;
        bot.materials.body.emissiveIntensity = 0;
      }
    }

    const chest = playerChest(player);
    const head = headWorld(bot, tmpHead);

    let sees = false;
    if (chest && playerIsAlive(player)) {
      const dx = chest.x - head.x;
      const dy = chest.y - head.y;
      const dz = chest.z - head.z;
      if (dx * dx + dy * dy + dz * dz <= SIGHT_RANGE * SIGHT_RANGE) {
        sees = segmentClear(head, chest, boxes);
      }
    }

    if (sees) {
      // stop, face the player, fire on a seeded cadence
      if (bot.state !== 'engage') {
        bot.state = 'engage';
        bot.fireTimer = Math.min(bot.fireTimer, 0.4 + rand() * 0.35);
      }
      bot.aim.copy(chest);

      const targetYaw = Math.atan2(chest.x - bot.group.position.x, chest.z - bot.group.position.z);
      bot.yaw = turnToward(bot.yaw, targetYaw, TURN_COMBAT * dt);
      bot.group.rotation.y = bot.yaw;

      const facing = Math.abs(shortAngleDelta(bot.yaw, targetYaw)) < 0.5;
      bot.fireTimer -= dt;
      if (bot.fireTimer <= 0 && facing) {
        const muzzle = headWorld(bot, tmpMuzzle).clone();
        muzzle.x += Math.sin(bot.yaw) * 0.32;
        muzzle.z += Math.cos(bot.yaw) * 0.32;
        if (segmentClear(muzzle, chest, boxes)) botFire(bot, chest, player);
        else bot.fireTimer = 0.35;
      }
    } else {
      if (bot.state === 'engage') {
        bot.state = 'patrol';
        bot.fireTimer = Math.max(bot.fireTimer, 0.5);
      }
      patrol(bot, dt);
    }

    bot.group.rotation.y = bot.yaw;
    confine(bot.group.position);
  }

  /* ---- update ------------------------------------------------------------- */

  function update(dt, player, onHit) {
    const step = clamp(num(dt, 1 / 60), 0, 0.05);

    for (let i = 0; i < list.length; i++) stepBot(list[i], step, player, onHit);

    // keep bodies from collapsing into one silhouette
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (!a.alive) continue;
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        if (!b.alive) continue;
        const dx = b.group.position.x - a.group.position.x;
        const dz = b.group.position.z - a.group.position.z;
        const dist = Math.sqrt(dx * dx + dz * dz);
        const minDist = BOT_RADIUS * 2.2;
        if (dist > 1e-4 && dist < minDist) {
          const push = (minDist - dist) * 0.5;
          const ux = dx / dist;
          const uz = dz / dist;
          a.group.position.x -= ux * push;
          a.group.position.z -= uz * push;
          b.group.position.x += ux * push;
          b.group.position.z += uz * push;
          confine(a.group.position);
          confine(b.group.position);
        }
      }
    }

    if (player && playerIsAlive(player)) {
      const shot = pollShot(player);
      if (shot) {
        const hit = hitTest(shot.origin, shot.dir, shot.range);
        if (hit) {
          applyHit(hit.bot, hit.point, hit.isHead, damageFor(shot, hit.isHead), onHit);
        } else {
          // the round stopped on the level: mark the impact, not the sky
          const reach = Math.min(shot.range, 80);
          const dist = rayDistance(shot.origin, shot.dir, reach, boxes);
          if (dist < reach) spawnSpark(shot.origin.clone().addScaledVector(shot.dir, dist));
        }
      }
    } else if (player) {
      lastAmmo = ammoOf(player);
    }

    stepPool(tracers, step);
    stepPool(sparks, step);
  }

  function reset() {
    for (let i = 0; i < list.length; i++) {
      const bot = list[i];
      bot.waypoints[0] = samplePoint(1.0);
      bot.waypoints[1] = samplePoint(1.0);
      bot.group.visible = true;
      respawn(bot, null);
    }
    lastAmmo = null;
    lastCount = null;
    lastSignature = null;
  }

  return {
    list,
    update,
    reset,
    hitTest,
    /** Let the weapon test its own shot: same damage rules, same callback. */
    handleShot(origin, direction, range, onHit) {
      const hit = hitTest(origin, direction, range);
      if (!hit) return null;
      applyHit(hit.bot, hit.point, hit.isHead, isHeadDamage(hit.isHead), onHit);
      return hit;
    },
    arena: { min: arenaMin, max: arenaMax },
  };
}

export default createShooters;
