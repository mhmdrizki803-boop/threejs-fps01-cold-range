/**
 * game/src/weapon.js
 *
 * The player's carbine: a first-person view model built from boxes and
 * parented to the camera, plus the ammunition, spread, recoil and reload model
 * that gunplay hangs off.
 *
 *   import { createWeapon } from './weapon.js';
 *   const weapon = createWeapon(camera);   // camera must already be in the scene
 *   weapon.mesh                            // THREE.Group, a child of the camera
 *   weapon.mag                             // rounds in the magazine (read/write)
 *   weapon.reserve                         // rounds in reserve (read/write)
 *   weapon.canFire()                       // false when empty or mid-reload
 *   weapon.fire(spread, moving)            // Vector3 shot direction, or null
 *   weapon.reload()                        // true if the 2.1 s reload began
 *   weapon.update(dt)                      // once per frame
 *   weapon.recoil                          // radians of accumulated kick
 *
 * Everything is geometry and materials built in code: no textures, no models,
 * no audio, no network. Ammunition: 24 in the magazine, 96 in reserve.
 *
 * Spread is the reason stopping to aim pays. The cone half-angle is 0.004 rad
 * at rest in a crouch, and grows by 0.020 rad whenever the player is moving and
 * by 0.012 rad whenever the player is standing. A running, standing shot is
 * therefore about eight times wider than a crouched, planted one.
 */

import * as THREE from 'three';
import { PALETTE, shade } from './palette.js';

/* ------------------------------------------------------------------ tuning */

const MAG_SIZE = 24;
const RESERVE_START = 96;
const RELOAD_TIME = 2.1;   // seconds
const FLASH_TIME = 0.06;   // 60 ms muzzle flash

const CONE_BASE = 0.004;     // half-angle at rest, crouched
const CONE_MOVING = 0.020;   // added while moving
const CONE_STANDING = 0.012; // added while not crouched
const CONE_MAX = 0.09;       // ceiling, so a bad argument can't hose the screen

// Recoil is a pitch impulse that decays between shots, so a held trigger walks
// the muzzle up and a paced trigger keeps it flat.
const KICK_MIN = 0.0115;
const KICK_VAR = 0.0065;
const KICK_MAX = 0.10;

// Resting pose: low and to the right, so at 1280x800 the gun fills the
// lower-right quadrant and never covers the reticle or the round timer.
const REST_POS = new THREE.Vector3(0.215, -0.205, -0.520);
const REST_ROT = new THREE.Euler(0.030, 0.055, 0.006);

/* --------------------------------------------------------------- materials */

const GUN = PALETTE.gun;       // near-black gunmetal
const GUN_HI = shade('gun');   // one step lighter: rail, barrel, magazine
const MUZZLE = PALETTE.muzzle; // flash
const ACCENT = PALETTE.accent; // front sight post
const INK = PALETTE.ink;       // grip and stock shadow

function gunMaterial(color, opts) {
  const o = opts || {};
  const m = new THREE.MeshStandardMaterial({
    color: new THREE.Color(color),
    roughness: o.roughness !== undefined ? o.roughness : 0.55,
    metalness: o.metalness !== undefined ? o.metalness : 0.42,
    flatShading: !!o.flat,
    // A touch of self light keeps the view model legible in a dim corner of the
    // arena without turning it into a glowing toy.
    emissive: new THREE.Color(color).multiplyScalar(o.emissive !== undefined ? o.emissive : 0.18),
  });
  // The view model is painted over the world: it must never be swallowed by a
  // wall we are hugging, and it must not z-fight with its own parts.
  m.depthTest = false;
  m.depthWrite = false;
  return m;
}

function box(w, h, d, mat) {
  return new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
}

/* ------------------------------------------------------------------ factory */

export function createWeapon(camera) {
  if (!camera) throw new Error('createWeapon(camera): camera is required');

  const mBody = gunMaterial(GUN, { roughness: 0.62, metalness: 0.38, emissive: 0.16 });
  const mSteel = gunMaterial(GUN_HI, { roughness: 0.34, metalness: 0.72, emissive: 0.14 });
  const mGrip = gunMaterial(INK, { roughness: 0.88, metalness: 0.10, emissive: 0.30 });
  const mAccent = gunMaterial(ACCENT, { roughness: 0.30, metalness: 0.35, emissive: 0.75 });

  /* ------------------------------------------------------------ view model */

  const root = new THREE.Group();
  root.name = 'viewmodel';
  root.position.copy(REST_POS);
  root.rotation.copy(REST_ROT);
  root.frustumCulled = false;

  // `depth` is the part's z, used to sort the draw order by hand further down.
  const parts = [];
  function add(mesh, depth) {
    parts.push({ mesh, depth });
    root.add(mesh);
    return mesh;
  }

  // Receiver: the body, with the rail running along its spine.
  const receiver = add(box(0.098, 0.112, 0.400, mBody), -0.020);
  receiver.position.set(0, 0, -0.020);

  const rail = add(box(0.052, 0.020, 0.300, mSteel), -0.100);
  rail.position.set(0, 0.066, -0.100);

  // Handguard wrapping the barrel.
  const handguard = add(box(0.078, 0.078, 0.220, mBody), -0.310);
  handguard.position.set(0, 0.008, -0.310);

  // Barrel and muzzle collar.
  const barrel = add(box(0.040, 0.040, 0.340, mSteel), -0.500);
  barrel.position.set(0, 0.010, -0.500);

  const collar = add(box(0.058, 0.058, 0.048, mSteel), -0.655);
  collar.position.set(0, 0.010, -0.655);

  // Magazine: the part that drops out of the well during a reload.
  const magMesh = add(box(0.062, 0.185, 0.098, mSteel), 0.018);
  magMesh.position.set(0, -0.135, 0.018);
  magMesh.rotation.x = -0.16;

  // Pistol grip.
  const grip = add(box(0.058, 0.155, 0.078, mGrip), 0.150);
  grip.position.set(0, -0.120, 0.152);
  grip.rotation.x = 0.34;

  // Trigger guard, three thin boxes.
  const guardFront = add(box(0.013, 0.060, 0.013, mBody), 0.078);
  guardFront.position.set(0, -0.086, 0.078);
  const guardBottom = add(box(0.013, 0.013, 0.082, mBody), 0.116);
  guardBottom.position.set(0, -0.116, 0.116);
  const guardBack = add(box(0.013, 0.056, 0.013, mBody), 0.156);
  guardBack.position.set(0, -0.088, 0.156);

  // Rear sight block.
  const rearSight = add(box(0.050, 0.020, 0.022, mSteel), 0.112);
  rearSight.position.set(0, 0.088, 0.112);

  // Front sight post in the accent colour, flanked by two protective wings: the
  // barrel axis and the top of the gun read instantly in a screenshot.
  const frontSight = add(box(0.013, 0.054, 0.014, mAccent), -0.632);
  frontSight.position.set(0, 0.058, -0.632);
  const wingL = add(box(0.008, 0.040, 0.030, mBody), -0.630);
  wingL.position.set(-0.028, 0.052, -0.630);
  const wingR = add(box(0.008, 0.040, 0.030, mBody), -0.630);
  wingR.position.set(0.028, 0.052, -0.630);

  // Stock stub: gives the silhouette a rifle read from the low right.
  const stock = add(box(0.070, 0.078, 0.160, mGrip), 0.235);
  stock.position.set(0, -0.020, 0.235);

  /* ---------------------------------------------------------- muzzle flash */

  const flashMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(MUZZLE),
    transparent: true,
    opacity: 0.95,
    blending: THREE.AdditiveBlending,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  const flashGeo = new THREE.PlaneGeometry(0.21, 0.21);

  const flash = new THREE.Group();
  flash.name = 'muzzle-flash';
  flash.position.set(0, 0.010, -0.700);
  flash.visible = false;
  flash.frustumCulled = false;

  const flashStar = new THREE.Mesh(flashGeo, flashMat);
  flashStar.rotation.z = Math.PI * 0.25;
  flashStar.renderOrder = 600;
  flashStar.frustumCulled = false;

  const flashCross = new THREE.Mesh(flashGeo, flashMat.clone());
  flashCross.rotation.y = Math.PI * 0.5;
  flashCross.renderOrder = 600;
  flashCross.frustumCulled = false;

  const flashCore = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.075, 0.085), flashMat.clone());
  flashCore.renderOrder = 599;
  flashCore.frustumCulled = false;

  flash.add(flashStar, flashCross, flashCore);
  root.add(flash);

  // A real light, so the flash lights the wall being shot at.
  const flashLight = new THREE.PointLight(new THREE.Color(MUZZLE), 0, 7, 2);
  flashLight.position.set(0, 0.010, -0.700);
  flashLight.visible = false;
  root.add(flashLight);

  /* ------------------------------------------------------- draw ordering */

  // depthTest is off, so paint the gun back-to-front by hand: far parts first.
  parts.sort(function (a, b) { return a.depth - b.depth; });
  for (let i = 0; i < parts.length; i++) parts[i].mesh.renderOrder = 100 + i;

  /* --------------------------------------------------------------- state */

  let mag = MAG_SIZE;
  let reserve = RESERVE_START;

  let reloading = false;
  let reloadT = 0;

  let flashT = 0;

  let recoilAngle = 0;
  let sway = 0;       // -1..1 horizontal kick from the last shots
  let kick = 0;       // 0..1 visual punch
  let bobPhase = 0;
  let speed01 = 0;    // 0..1 walk speed hint, drives the bob
  let crouchFlag = false;
  let crouchSource = null;

  const restPos = REST_POS.clone();
  const restRot = REST_ROT.clone();
  const baseMagY = magMesh.position.y;
  const baseMagZ = magMesh.position.z;
  const baseMagRotX = magMesh.rotation.x;

  const _q = new THREE.Quaternion();

  /* -------------------------------------------------------------- helpers */

  function isCrouched() {
    if (typeof crouchSource === 'function') return !!crouchSource();
    const ud = camera.userData;
    if (ud && typeof ud.crouched === 'boolean') return ud.crouched;
    return crouchFlag === true;
  }

  function coneHalf(spread, moving) {
    // `spread` scales the base cone; anything unusable means "nominal" (1).
    const scale = typeof spread === 'number' && isFinite(spread) && spread > 0 ? spread : 1;
    let half = CONE_BASE * scale;
    if (moving) half += CONE_MOVING;
    if (!isCrouched()) half += CONE_STANDING;
    return Math.min(half, CONE_MAX);
  }

  function canFire() {
    return !reloading && mag > 0;
  }

  function startFlash() {
    flashT = FLASH_TIME;
    flash.visible = true;
    flashLight.visible = true;
    flashLight.intensity = 2.6;
    flash.rotation.z = Math.random() * Math.PI;
    const s = 0.85 + Math.random() * 0.55;
    flash.scale.set(s, s, 1);
  }

  function endFlash() {
    flashT = 0;
    flash.visible = false;
    flashLight.visible = false;
    flashLight.intensity = 0;
  }

  /* --------------------------------------------------------------- public */

  const weapon = {
    mesh: root,
    recoil: 0,

    MAG_SIZE,
    RESERVE_START,
    RELOAD_TIME,
    FLASH_TIME,

    // Ammunition lives in two places: the private counters above drive the
    // simulation, and these accessors are the only way in or out, so a caller
    // reading weapon.mag always sees the same number canFire() just tested.
    get mag() { return mag; },
    set mag(v) {
      mag = Math.max(0, Math.min(MAG_SIZE, Math.floor(Number(v) || 0)));
    },
    get reserve() { return reserve; },
    set reserve(v) {
      reserve = Math.max(0, Math.floor(Number(v) || 0));
    },

    get reloading() { return reloading; },
    get reloadProgress() { return reloading ? Math.min(1, reloadT / RELOAD_TIME) : 0; },
    get reloadTimeRemaining() { return reloading ? Math.max(0, RELOAD_TIME - reloadT) : 0; },
    get crouched() { return isCrouched(); },

    canFire,

    /**
     * Spend one round and return the shot direction in world space.
     * @param {number} spread  multiplier on the base 0.004 rad cone (1 = nominal)
     * @param {boolean} moving true when the player is actually translating
     * @returns {THREE.Vector3|null} normalised direction, or null if it clicked
     */
    fire(spread, moving) {
      if (!canFire()) return null;

      mag -= 1;

      // Recoil: pitch up, alternating horizontal sway, and a visual punch.
      const shotKick = KICK_MIN + Math.random() * KICK_VAR;
      recoilAngle = Math.min(KICK_MAX, recoilAngle + shotKick);
      weapon.recoil = recoilAngle;

      const side = Math.random() < 0.5 ? -1 : 1;
      sway = THREE.MathUtils.clamp(sway + side * (0.55 + Math.random() * 0.45), -1, 1);
      kick = 1;

      startFlash();

      // Build a basis from the camera, then land a point uniformly inside the
      // disc of half-angle `half`, and aim at it.
      const q = camera.getWorldQuaternion(_q);
      const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);

      const half = coneHalf(spread, moving);
      const radius = half * Math.sqrt(Math.random()); // sqrt -> uniform area
      const theta = Math.random() * Math.PI * 2;

      dir.addScaledVector(right, Math.cos(theta) * radius);
      dir.addScaledVector(up, Math.sin(theta) * radius);

      if (dir.lengthSq() < 1e-10) dir.set(0, 0, -1).applyQuaternion(q);
      return dir.normalize();
    },

    /** Begin a reload. Refused when the magazine is full or reserve is dry. */
    reload() {
      if (reloading) return false;
      if (mag >= MAG_SIZE) return false;
      if (reserve <= 0) return false;
      reloading = true;
      reloadT = 0;
      return true;
    },

    /** Per-frame hint for the walk bob (m/s) and, optionally, crouch state. */
    setMotion(speed, crouching) {
      const v = typeof speed === 'number' && isFinite(speed) ? Math.abs(speed) : 0;
      speed01 = Math.min(1, v / 6.0);
      if (typeof crouching === 'boolean') crouchFlag = crouching;
    },

    /** Accept a boolean, or a function that reports the player's crouch state. */
    setCrouched(v) {
      if (typeof v === 'function') { crouchSource = v; return; }
      if (typeof v === 'boolean') { crouchFlag = v; crouchSource = null; }
    },

    /** World-space muzzle position: tracer origin, impact start point. */
    muzzleWorldPosition(target) {
      const out = target || new THREE.Vector3();
      return flash.getWorldPosition(out);
    },

    update(dt) {
      const d = typeof dt === 'number' && isFinite(dt) && dt > 0 ? Math.min(dt, 0.25) : 0;

      /* --- muzzle flash: 60 ms --- */
      if (flashT > 0) {
        flashT -= dt;
        if (flashT <= 0) {
          endFlash();
        } else {
          flashLight.intensity = 2.6 * (flashT / FLASH_TIME);
          const g = 1 + dt * 1.5;
          flash.scale.multiplyScalar(g);
        }
      }

      /* --- reload: 2.1 s, then move rounds from reserve to magazine --- */
      if (reloading) {
        reloadT += dt;
        if (reloadT >= RELOAD_TIME) {
          const take = Math.min(MAG_SIZE - mag, reserve);
          mag += take;
          reserve -= take;
          reloading = false;
          reloadT = 0;
        }
      }

      /* --- recoil, sway and kick recovery --- */
      recoilAngle *= Math.exp(-d * 6.5);
      if (recoilAngle < 1e-5) recoilAngle = 0;
      weapon.recoil = recoilAngle;

      sway *= Math.exp(-d * 5.0);
      if (Math.abs(sway) < 1e-3) sway = 0;

      kick *= Math.exp(-d * 7.0);
      if (kick < 1e-3) kick = 0;

      /* --- reload dip: 0 at both ends, 1 in the middle --- */
      let dip = 0;
      if (reloading) {
        const p = THREE.MathUtils.clamp(reloadT / RELOAD_TIME, 0, 1);
        const s = Math.sin(Math.PI * p);
        dip = s * s * (3 - 2 * s); // smoothstep, so the hold reads as a hold
      }

      /* --- walk bob --- */
      if (speed01 > 0.02) bobPhase += d * (6.0 + speed01 * 5.0);
      const bobAmt = speed01 * 0.011;
      const bobX = Math.sin(bobPhase) * bobAmt;
      const bobY = Math.abs(Math.cos(bobPhase)) * bobAmt * 0.7;

      /* --- pose = rest + bob + sway + recoil + dip --- */
      const rp = recoilAngle / KICK_MAX; // 0..1

      root.position.set(
        restPos.x + bobX + sway * 0.010 - dip * 0.030,
        restPos.y + bobY + kick * 0.006 - dip * 0.150,
        restPos.z + rp * 0.045 + dip * 0.020
      );

      root.rotation.set(
        restRot.x + rp * 0.16 + dip * 0.90,
        restRot.y - sway * 0.045 - dip * 0.10,
        restRot.z + sway * 0.030 - dip * 0.26
      );

      // The magazine drops out of the well, then is slapped back in.
      magMesh.position.y = baseMagY - dip * 0.155;
      magMesh.position.z = baseMagZ + dip * 0.045;
      magMesh.rotation.x = baseMagRotX + dip * 0.55;

      // Barrel and flash ride the recoil a hair.
      barrel.position.z = -0.500 + rp * 0.018;
      flash.position.z = -0.700 + rp * 0.018;
      flashLight.position.z = flash.position.z;
    },
  };

  camera.add(root);
  return weapon;
}

export default createWeapon;
