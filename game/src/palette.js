// game/src/palette.js
//
// Kosakata warna arena. Satu dunia industri dingin -- beton, baja, kabut pagi --
// ditemani dua sinyal panas: oranye buat hal yang "lagi penting", merah buat hal
// yang mau nembak balik. Gak ada tekstur sama sekali di game ini, jadi warna
// yang harus misahin lantai / dinding / crate / badan bot / kepala bot.
//
// Cara baca daftar di bawah:
//   floor, wall      dingin & rendah saturasi -> mata cepat nge-ignore, gak capek
//   crate            coklat hangat, satu-satunya benda yang bisa dipakai buat cover
//   accent, muzzle   oranye-kuning: tanda amunisi, garis HUD, kilat moncong
//   bot, botHead     merah; kepala sengaja lebih terang biar target headshot kebaca
//   hit, ink         sinyal instan (hit marker) dan semua garis / angka HUD
//
// `shade()` dipakai buat turunan kecil dari warna yang sama -- trim dinding,
// grout lantai, sisi crate yang ketutup bayangan, dsb -- supaya satu permukaan
// tetap kelihatan satu keluarga tanpa perlu nambah entri baru ke palet.
//
// Semua nilai sRGB hex, semua dirakit jadi MeshStandardMaterial / MeshBasicMaterial
// di src/level.js dan src/weapon.js. File ini cuma data + satu fungsi murni.

export const PALETTE = Object.freeze({
  // --- permukaan arena -----------------------------------------------------
  floor:   '#242a33', // aspal-beton gelap, sedikit kebiruan
  wall:    '#3a4351', // baja dicat abu-biru, lebih terang dari lantai
  crate:   '#8a5a33', // kayu/palet tua, satu-satunya hangat di lantai

  // --- langit & atmosfer ---------------------------------------------------
  sky:     '#7fa7c9', // biru pucat, pagi mendung
  fog:     '#93a9bd', // kabut: lebih terang dari sky biar cakrawala luntur

  // --- pihak yang salah ----------------------------------------------------
  bot:     '#b8382c', // badan bot: merah bata, sengaja gak nyala
  botHead: '#e8604a', // kepala bot: versi lebih terang = zona damage besar

  // --- tangan pemain -------------------------------------------------------
  gun:     '#1b1f26', // gunmetal hampir hitam, jangan sampai nabrak dinding
  muzzle:  '#ffd166', // kilat moncong + muzzle light

  // --- umpan balik & UI ----------------------------------------------------
  accent:  '#ff8a3d', // oranye aksi: ammo low, garis tepi, reticle
  hit:     '#ff2e63', // hit marker: pink-panas, beda jelas dari merah bot
  ink:     '#0a0c10', // hampir hitam: outline, teks HUD, vignette
});

// Luma Rec.709 buat mutusin arah shade (gelap -> dibagusin, terang -> digelapin).
const LUMA_WEIGHT = Object.freeze({ r: 0.2126, g: 0.7152, b: 0.0722 });
const SHADE_CUTOFF = 0.42; // di atas ini dianggap "sudah terang"
const DARKEN = 0.8;        // terang: dikali, rasio antar-channel tetap
const LIGHTEN = 0.24;      // gelap: ditarik ke putih, biar gak jadi abu mati

const HEX_RE = /^#?(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

function toRgb(hex) {
  if (typeof hex !== 'string' || !HEX_RE.test(hex)) {
    throw new TypeError(`palette: "${String(hex)}" bukan warna hex`);
  }
  let h = hex.replace('#', '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = parseInt(h, 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

function toChannel(v) {
  const c = v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
  return c.toString(16).padStart(2, '0');
}

function toHex(rgb) {
  return '#' + toChannel(rgb.r) + toChannel(rgb.g) + toChannel(rgb.b);
}

function luma(rgb) {
  return (LUMA_WEIGHT.r * rgb.r + LUMA_WEIGHT.g * rgb.g + LUMA_WEIGHT.b * rgb.b) / 255;
}

// shade('wall') -> versi wall yang sedikit lebih gelap/terang.
// Murni: input sama selalu keluar string sama, gak nyentuh state, gak ada
// Math.random / Date. Nama yang gak dikenal sengaja dilempar, bukan diem-diem
// jadi hitam -- kalau level code salah nulis nama, kita mau tahu saat itu juga.
export function shade(name) {
  if (typeof name !== 'string' || !Object.prototype.hasOwnProperty.call(PALETTE, name)) {
    throw new RangeError(`palette.shade: "${String(name)}" gak ada di PALETTE`);
  }
  const rgb = toRgb(PALETTE[name]);
  if (luma(rgb) >= SHADE_CUTOFF) {
    return toHex({ r: rgb.r * DARKEN, g: rgb.g * DARKEN, b: rgb.b * DARKEN });
  }
  return toHex({
    r: rgb.r + (255 - rgb.r) * LIGHTEN,
    g: rgb.g + (255 - rgb.g) * LIGHTEN,
    b: rgb.b + (255 - rgb.b) * LIGHTEN,
  });
}
