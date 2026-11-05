// Copies the MediaPipe wasm runtime and pose model into public/ so the app serves them itself
// (no third-party CDN at runtime). Runs before dev and build; skips files that are already there.
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const out = "public/mediapipe";
mkdirSync(join(out, "wasm"), { recursive: true });
const pkg = dirname(createRequire(import.meta.url).resolve("@mediapipe/tasks-vision"));
for (const f of ["vision_wasm_internal.js", "vision_wasm_internal.wasm", "vision_wasm_nosimd_internal.js", "vision_wasm_nosimd_internal.wasm"]) {
  copyFileSync(join(pkg, "wasm", f), join(out, "wasm", f));
}
const model = join(out, "pose_landmarker_lite.task");
if (!existsSync(model)) {
  const url = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";
  const res = await fetch(url);
  if (!res.ok) throw new Error(`model download failed: ${res.status}`);
  writeFileSync(model, Buffer.from(await res.arrayBuffer()));
}
console.log("mediapipe assets ready in", out);
