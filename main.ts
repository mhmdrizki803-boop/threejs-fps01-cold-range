import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildDossier } from './vendor/makefun-threejs.ts';
const out = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
mkdirSync(out, { recursive: true });
cpSync(join('.', 'game'), join(out, 'game'), { recursive: true });
cpSync(join('.', 'screenshots'), join(out, 'screenshots'), { recursive: true });
writeFileSync(join(out, 'dossier.json'), buildDossier(out, {
  text_max_bytes: 163840, screenshots: { max: 4, max_bytes: 262144 },
  game_max_files: 993, game_max_bytes: 50331648,
}));
console.error('entry: copied game/ and screenshots/, wrote dossier.json');
