import { cpSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const circuitsBuild = resolve(__dirname, "../../circuits/build");
const publicCircuits = resolve(__dirname, "../public/circuits");

const files = [
  "wealth_tier.wasm",
  "wealth_tier_final.zkey",
  "verification_key.json",
];

// Validate source files exist
for (const f of files) {
  const src = resolve(circuitsBuild, f);
  if (!existsSync(src)) {
    console.error(`❌ Missing: ${src}`);
    console.error(
      "Run circuit build first: pnpm --filter @proofoflove/circuits build",
    );
    process.exit(1);
  }
}

// Ensure target dir exists
mkdirSync(publicCircuits, { recursive: true });

// Copy
for (const f of files) {
  cpSync(resolve(circuitsBuild, f), resolve(publicCircuits, f));
  console.log(`✓ Copied ${f}`);
}

console.log("\n✅ Circuit artifacts ready in public/circuits/");
