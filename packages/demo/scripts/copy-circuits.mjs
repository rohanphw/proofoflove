import { cpSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const build = resolve(__dirname, '../../circuits/build');
const publicCircuits = resolve(__dirname, '../public/circuits');

const files = [
  { src: 'wealth_tier_js/wealth_tier.wasm', dest: 'wealth_tier.wasm' },
  { src: 'keys/wealth_tier_final.zkey', dest: 'wealth_tier_final.zkey' },
  { src: 'keys/verification_key.json', dest: 'verification_key.json' },
];

for (const f of files) {
  const src = resolve(build, f.src);
  if (!existsSync(src)) {
    console.error(`Missing: ${src}`);
    process.exit(1);
  }
}

mkdirSync(publicCircuits, { recursive: true });

for (const f of files) {
  cpSync(resolve(build, f.src), resolve(publicCircuits, f.dest));
  console.log(`Copied ${f.dest}`);
}

console.log('\nCircuit artifacts ready in public/circuits/');
