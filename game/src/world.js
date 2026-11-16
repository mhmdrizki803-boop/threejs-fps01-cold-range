// game/src/world.js — arena construction for the browser FPS.
//
// Everything is built from three.js primitives in code: no textures, no models,
// no audio, no network. The layout is fully deterministic (seeded PRNG, never
// Math.random) so the map is identical on every load and the screenshots always
// agree with this source.
//
// createWorld(scene) returns { colliders }: one world-space THREE.Box3 per solid
// object. Player movement and hitscan shots both resolve against that one list,
// so cover visibly stops bodies and bullets in exactly the same places.
//
// Layout intent (Counter-Strike in spirit, our own map, 40 x 40 units):
//   - a sealed box: floor plane + four outer walls
//   - a centre divider with a 4 unit gap ("mid doors") that decides the middle
//   - four pillars cutting the long diagonals between the spawn corners
//   - four low ramps: crouch behind them and you vanish, stand and you peek over
//   - crate clusters in every quadrant plus two lone crates flanking the gap
//   - dark lane markings so orientation reads instantly in a screenshot

import * as THREE from 'three';
import { PALETTE } from './palette.js';

const ARENA = 40;                     // playable square, roughly 40 x 40 units
const HALF = ARENA / 2;               // 20: inner face of every outer wall
const WALL_HEIGHT = 5;
const WALL_THICK = 0.8;

// mulberry32 — 32 bit deterministic PRNG. Same seed, byte-identical arena.
function createRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// PALETTE is the single source of truth for colour; the fallbacks only guarantee
// that a missing key can never produce an invisible (black) surface.
function pick(name, fallback) {
  const value = PALETTE ? PALETTE[name] : undefined;
  return value === undefined || value === null ? fallback : value;
}

// Derive surface shades from the palette entries that do exist, so the whole map
// stays one palette instead of a pile of hardcoded hex values.
function tint(base, factor) {
  const c = new THREE.Color(base);
  if (factor >= 0) c.lerp(new THREE.Color(0xffffff), factor);
  else c.multiplyScalar(1 + factor);
  return c;
}

// Crates are rotated in eighths: reads as hand placed cover, not debris.
function snapAngle(rng) {
  return Math.round(rng() * 7) * (Math.PI / 4);
}

export function createWorld(scene) {
  if (!scene) throw new Error('createWorld(scene) needs a THREE.Scene');

  const colliders = [];
  const rng = createRng(0x1337beef);

  const arena = new THREE.Group();
  arena.name = 'arena';
  arena.userData.colliders = colliders;
  scene.add(arena);

  // --- sky, fog, light -----------------------------------------------------
  // Fog shares the sky colour so the far wall dissolves instead of ending in a
  // hard seam, and so distant geometry never pops against a flat backdrop.
  scene.background = new THREE.Color(pick('sky', 0x8fb7d6));
  scene.fog = new THREE.Fog(pick('fog', 0x9db9d2), 26, 74);

  const hemi = new THREE.HemisphereLight(
    tint(pick('sky', 0x8fb7d6), 0.55),
    tint(pick('ink', 0x141821), 0.08),
    1.2
  );
  hemi.position.set(0, 34, 0);
  scene.add(hemi);

  // One directional key light. Shadows are deliberately OFF: the fill rate of a
  // 40x40 shadow map buys less than a steady frame rate for gunplay.
  const sun = new THREE.DirectionalLight(tint(0xfff3dd, 0.1), 1.6);
  sun.position.set(17, 30, 12);
  sun.castShadow = false;
  sun.target.position.set(0, 0, 0);
  scene.add(sun);
  scene.add(sun.target);

  // --- materials (all procedural, all derived from PALETTE) ---------------
  const wallBase = pick('wall', 0x6d7684);
  const crateBase = pick('crate', 0x9b6a3c);
  const mat = {
    floor: new THREE.MeshStandardMaterial({
      color: tint(pick('floor', 0x3d424c), -0.08),
      roughness: 0.97, metalness: 0.02,
    }),
    lane: new THREE.MeshStandardMaterial({
      color: tint(pick('floor', 0x3d424c), -0.42),
      roughness: 1.0, metalness: 0.0,
    }),
    wall: new THREE.MeshStandardMaterial({
      color: wallBase, roughness: 0.92, metalness: 0.04,
    }),
    trim: new THREE.MeshStandardMaterial({
      color: tint(pick('accent', 0x2f6f8f), -0.1),
      roughness: 0.65, metalness: 0.2,
    }),
    crate: new THREE.MeshStandardMaterial({
      color: crateBase, roughness: 0.86, metalness: 0.0,
    }),
    crateLid: new THREE.MeshStandardMaterial({
      color: tint(crateBase, -0.34), roughness: 0.9, metalness: 0.0,
    }),
    pillar: new THREE.MeshStandardMaterial({
      color: tint(wallBase, -0.22), roughness: 0.7, metalness: 0.22,
    }),
    ramp: new THREE.MeshStandardMaterial({
      color: tint(wallBase, 0.12), roughness: 0.8, metalness: 0.1,
    }),
  };

  // --- helpers -------------------------------------------------------------
  // addSolid builds the mesh, adds it to the render graph AND registers it as a
  // collider, so bodies and bullets stop at the same surface.
  function addSolid(geometry, material, x, y, z, rx = 0, ry = 0, rz = 0) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    mesh.rotation.set(rx, ry, rz);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    arena.add(mesh);
    mesh.updateWorldMatrix(true, false);

    const box = new THREE.Box3().setFromObject(mesh);
    colliders.push(box);
    mesh.userData.collider = box;
    return mesh;
  }

  // addDecor is visual only: floor paint and trim that sits inside a volume that
  // is already solid, so it needs no collider of its own.
  function addDecor(geometry, material, x, y, z, rx = 0, ry = 0, rz = 0) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    mesh.rotation.set(rx, ry, rz);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    arena.add(mesh);
    return mesh;
  }

  // --- floor ---------------------------------------------------------------
  // The ground is the ground, not an obstacle: the player is clamped to y >= 0
  // instead of resolving against it, so the floor is intentionally NOT a
  // collider (a full-map AABB in that list would shove bodies around). Shots
  // that hit nothing expire, same as a wall that is out of ammo.
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(ARENA + WALL_THICK * 2, ARENA + WALL_THICK * 2),
    mat.floor
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = 0;
  floor.receiveShadow = false;
  arena.add(floor);

  // Floor paint: a centre cross for orientation, four spawn pads in the corners.
  addDecor(new THREE.BoxGeometry(ARENA, 0.02, 0.36), mat.lane, 0, 0.011, 0);
  addDecor(new THREE.BoxGeometry(0.36, 0.02, ARENA), mat.lane, 0, 0.011, 0);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      addDecor(new THREE.BoxGeometry(4.2, 0.02, 4.2), mat.lane, sx * 15.6, 0.011, sz * 15.6);
    }
  }

  // --- outer walls ---------------------------------------------------------
  // Inner faces sit exactly on +-20, so HALF is the true play area on every side.
  const wallSpanX = new THREE.BoxGeometry(ARENA + WALL_THICK * 2, WALL_HEIGHT, WALL_THICK);
  const wallSpanZ = new THREE.BoxGeometry(WALL_THICK, WALL_HEIGHT, ARENA + WALL_THICK * 2);
  addSolid(wallSpanX, mat.wall, 0, WALL_HEIGHT / 2, -(HALF + WALL_THICK / 2));
  addSolid(wallSpanX, mat.wall, 0, WALL_HEIGHT / 2, HALF + WALL_THICK / 2);
  addSolid(wallSpanZ, mat.wall, -(HALF + WALL_THICK / 2), WALL_HEIGHT / 2, 0);
  addSolid(wallSpanZ, mat.wall, HALF + WALL_THICK / 2, WALL_HEIGHT / 2, 0);

  // A pale baseboard strip along each wall: pure paint, gives the eye a horizon
  // line at chest height and makes the map read as built, not dumped.
  for (const s of [-1, 1]) {
    addDecor(new THREE.BoxGeometry(ARENA, 0.34, 0.06), mat.trim, 0, 1.15, s * (HALF - 0.03));
    addDecor(new THREE.BoxGeometry(0.06, 0.34, ARENA), mat.trim, s * (HALF - 0.03), 1.15, 0);
  }

  // --- centre divider ("mid doors") ---------------------------------------
  // Two half walls leave a 4 unit gap. Chest height on purpose: you can only
  // shoot over them from the raised angles the ramps create.
  const midWallGeo = new THREE.BoxGeometry(1.1, 3.4, 6.2);
  addSolid(midWallGeo, mat.wall, 0, 1.7, -5.1);
  addSolid(midWallGeo, mat.wall, 0, 1.7, 5.1);
  // Trim caps mark the gap edges; they sit on top of the mid walls, so they are
  // visual only and are placed without colliders.
  for (const s of [-1, 1]) {
    addDecor(new THREE.BoxGeometry(1.3, 0.22, 6.2), mat.trim, 0, 3.51, s * 5.1);
  }

  // --- pillars -------------------------------------------------------------
  // Four columns that cut the long diagonals between spawn corners; the safe
  // centre hold simply does not exist, which is what makes the lanes matter.
  const pillarGeo = new THREE.CylinderGeometry(0.95, 1.05, WALL_HEIGHT, 12);
  const pillarCapGeo = new THREE.BoxGeometry(2.2, 0.35, 2.2);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const px = sx * 9.5;
      const pz = sz * 9.5;
      addSolid(pillarGeo, mat.pillar, px, WALL_HEIGHT / 2, pz);
      addSolid(pillarCapGeo, mat.pillar, px, WALL_HEIGHT + 0.175, pz);
    }
  }

  // --- low ramps -----------------------------------------------------------
  // Tilted slabs topping out near 1.5 units. Crouched behind one you are gone;
  // standing you peek over. They are cover first, not walkways: this map is
  // about holding angles, so the player is not meant to run up them.
  const rampGeo = new THREE.BoxGeometry(3.4, 0.5, 4.4);
  const RAMP_TILT = -0.26;
  const RAMP_Y = 0.66;
  const rampSpots = [
    { x: -11.0, z: 0.0, ry: 0.0 },
    { x: 11.0, z: 0.0, ry: 0.0 },
    { x: 0.0, z: -12.5, ry: Math.PI / 2 },
    { x: 0.0, z: 12.5, ry: Math.PI / 2 },
  ];
  for (const spot of rampSpots) {
    addSolid(rampGeo, mat.ramp, spot.x, RAMP_Y, spot.z, RAMP_TILT, spot.ry, 0);
  }

  // --- crates --------------------------------------------------------------
  const geoCache = new Map();
  function cached(key, make) {
    let geo = geoCache.get(key);
    if (!geo) {
      geo = make();
      geoCache.set(key, geo);
    }
    return geo;
  }
  const crateGeo = (size) =>
    cached(`c:${size.toFixed(2)}`, () => new THREE.BoxGeometry(size, size, size));
  const crateLidGeo = (size) =>
    cached(`l:${size.toFixed(2)}`, () => new THREE.BoxGeometry(size * 1.05, 0.16, size * 1.05));

  // A crate is one solid body plus a flush lid slab. The lid is inside the body's
  // own footprint, so it never needs a collider of its own.
  function placeCrate(x, z, size, lift = 0, ry = 0) {
    const body = addSolid(crateGeo(size), mat.crate, x, lift + size / 2, z, 0, ry, 0);
    addDecor(crateLidGeo(size), mat.crateLid, x, lift + size - 0.075, z, 0, ry, 0);
    return body;
  }

  // Quadrant clusters: a base crate, a smaller stacked box on top when the zone
  // has weight, then 1-2 satellites on a seeded ring. Zones stay clear of the
  // spawn pads, the pillar footprints and the two long lanes.
  const crateZones = [
    { x: -13.0, z: -7.5, size: 1.7, count: 3 },
    { x: -13.5, z: 6.5, size: 1.5, count: 3 },
    { x: 13.2, z: -6.5, size: 1.6, count: 3 },
    { x: 13.5, z: 7.0, size: 1.8, count: 2 },
    { x: -6.5, z: -13.5, size: 1.5, count: 3 },
    { x: 6.0, z: -12.5, size: 1.3, count: 2 },
    { x: 7.0, z: 13.0, size: 1.6, count: 3 },
    { x: -6.0, z: 12.8, size: 1.4, count: 2 },
  ];

  for (const zone of crateZones) {
    const baseRy = snapAngle(rng);
    placeCrate(zone.x, zone.z, zone.size, 0, baseRy);

    if (zone.count >= 3) {
      // weight on the pile: same footprint, smaller box sitting flush on top
      placeCrate(zone.x + 0.06, zone.z + 0.06, zone.size * 0.68, zone.size, baseRy);
    }

    for (let i = 1; i < zone.count; i += 1) {
      const angle = (i / zone.count) * Math.PI * 2 + rng() * 0.5;
      const radius = 1.5 + rng() * 0.7;
      const size = zone.size * (0.8 + rng() * 0.35);
      placeCrate(
        zone.x + Math.cos(angle) * radius,
        zone.z + Math.sin(angle) * radius,
        size,
        0,
        snapAngle(rng)
      );
    }
  }

  // Two lone crates flanking the gap: free cover the second you commit to mid.
  placeCrate(-4.5, -3.0, 1.4, 0, Math.PI / 4);
  placeCrate(4.5, 3.0, 1.4, 0, Math.PI / 4);

  // --- done ----------------------------------------------------------------
  // colliders holds one world-space Box3 per solid object above: 4 outer walls,
  // 2 mid walls, 4 pillars + 4 caps, 4 ramps, and every crate body.
  return { colliders };
}
