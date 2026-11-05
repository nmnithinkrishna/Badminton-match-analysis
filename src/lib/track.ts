// On-device player tracking: MediaPipe pose detection on sampled frames + a court homography from 4 tapped
// corners, giving each player's position in metres and their real movement speed. Runs entirely in the browser.
import { ALL_FORMATS, BlobSource, CanvasSink, Input } from "mediabunny";
import type { FilesetResolver as FR, PoseLandmarker as PL } from "@mediapipe/tasks-vision";

/** Normalised image point (0-1 of the video frame). */
export type Pt = { x: number; y: number };
/** Court corners as seen in the video: far-left, far-right, near-right, near-left (doubles outer lines). */
export type Corners = [Pt, Pt, Pt, Pt];

export const COURT_W = 6.1; // m, doubles width
export const COURT_L = 13.4; // m, full length
const NET_Y = COURT_L / 2;

export type TrackPoint = {
  t: number; // s
  x: number; // feet, normalised image x
  y: number; // feet, normalised image y
  bh: number; // body height, normalised image units
  cx: number; // court metres across (0 = left sideline seen from the near end)
  cy: number; // court metres from the far baseline
  v: number; // speed, km/h (smoothed)
};

export type Movement = {
  start: number;
  end: number;
  distance: number; // m
  avg: number; // km/h
  peak: number; // km/h
  band: SpeedBand;
};

export type SpeedBand = "slow" | "medium" | "fast";
export const bandOf = (kmh: number): SpeedBand => (kmh >= 11 ? "fast" : kmh >= 6 ? "medium" : "slow");

export type PlayerTrack = {
  points: TrackPoint[];
  movements: Movement[];
  stats: { distance: number; top: number; avgMoving: number; coverage: number };
};

export type Tracks = { version: 1; fps: number; corners: Corners; near: PlayerTrack; far: PlayerTrack };

// ---------- Homography (image <-> court) ----------

/** 3×3 homography mapping 4 source points onto 4 destination points (direct linear transform). */
export function homography(src: Pt[], dst: Pt[]): number[] {
  const A: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i];
    const { x: u, y: v } = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  // Gaussian elimination on the 8×9 augmented matrix.
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    if (Math.abs(A[c][c]) < 1e-12) throw new Error("Court corners are degenerate");
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k < 9; k++) A[r][k] -= f * A[c][k];
    }
  }
  const h = A.map((row, i) => row[8] / row[i]);
  return [...h, 1];
}

export function apply(H: number[], p: Pt): Pt {
  const d = H[6] * p.x + H[7] * p.y + H[8];
  return { x: (H[0] * p.x + H[1] * p.y + H[2]) / d, y: (H[3] * p.x + H[4] * p.y + H[5]) / d };
}

const COURT_PTS: Pt[] = [
  { x: 0, y: 0 },
  { x: COURT_W, y: 0 },
  { x: COURT_W, y: COURT_L },
  { x: 0, y: COURT_L },
];

// ---------- Tracking ----------

const SAMPLE_FPS = 8;
const MAX_GAP_S = 1;
const MAX_KMH = 32; // anything faster is a detection glitch

async function landmarker(): Promise<{ create: () => Promise<PL> }> {
  const mp = await import("@mediapipe/tasks-vision");
  const vision = await (mp.FilesetResolver as typeof FR).forVisionTasks("/mediapipe/wasm");
  const opts = (delegate: "GPU" | "CPU") => ({
    baseOptions: { modelAssetPath: "/mediapipe/pose_landmarker_lite.task", delegate },
    runningMode: "VIDEO" as const,
    numPoses: 3,
    minPoseDetectionConfidence: 0.3,
    minPosePresenceConfidence: 0.3,
    minTrackingConfidence: 0.3,
  });
  // GPU is much faster on most phones but can be far slower where WebGL is emulated: time both, keep the faster.
  const bench = async (delegate: "GPU" | "CPU") => {
    try {
      const pl = await mp.PoseLandmarker.createFromOptions(vision, opts(delegate));
      const c = new OffscreenCanvas(640, 360);
      c.getContext("2d")!.fillRect(0, 0, 640, 360);
      pl.detectForVideo(c as unknown as HTMLCanvasElement, 0);
      const t0 = performance.now();
      for (let i = 1; i <= 4; i++) pl.detectForVideo(c as unknown as HTMLCanvasElement, i * 100);
      const ms = (performance.now() - t0) / 4;
      pl.close();
      return ms;
    } catch {
      return Infinity;
    }
  };
  const gpu = await bench("GPU");
  const delegate = gpu < 40 ? "GPU" : gpu <= (await bench("CPU")) ? "GPU" : "CPU";
  return { create: () => mp.PoseLandmarker.createFromOptions(vision, opts(delegate)) };
}

type Raw = { t: number; x: number; y: number; bh: number; cx: number; cy: number } | null;

/** Region of the frame (normalised) where a player on this half of the court can appear, body included. */
function halfRegion(corners: Corners, Hinv: number[], half: "near" | "far") {
  const yNet = [apply(Hinv, { x: 0, y: NET_Y }), apply(Hinv, { x: COURT_W, y: NET_Y })];
  const ends = half === "far" ? [corners[0], corners[1]] : [corners[2], corners[3]];
  const pts = [...yNet, ...ends];
  const minX = Math.min(...pts.map((p) => p.x));
  const maxX = Math.max(...pts.map((p) => p.x));
  const minY = Math.min(...pts.map((p) => p.y));
  const maxY = Math.max(...pts.map((p) => p.y));
  const hgt = maxY - minY;
  const padX = (maxX - minX) * 0.25;
  // Bodies stand up from the court: extend upwards by ~1.2× the half's image height (far) or 0.9× (near).
  const up = hgt * (half === "far" ? 1.4 : 0.9);
  const down = half === "near" ? hgt * 0.35 : hgt * 0.15;
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  const x0 = clamp(minX - padX);
  const y0 = clamp(minY - up);
  const x1 = clamp(maxX + padX);
  const y1 = clamp(maxY + down);
  return { x0, y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * Tracks the near and far player through the video. Calls onProgress with 0-1.
 * Detection runs on a crop of each half so the (small) far player is found too.
 */
export async function trackPlayers(
  file: File,
  corners: Corners,
  onProgress: (p: number) => void,
  signal?: AbortSignal,
): Promise<Tracks> {
  const H = homography(corners, COURT_PTS); // image -> court
  const Hinv = homography(COURT_PTS, corners); // court -> image
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error("No video track found");
  const duration = await input.computeDuration();
  const aspect = track.displayWidth / track.displayHeight;
  const frameW = Math.min(1280, track.displayWidth);
  const sink = new CanvasSink(track, { width: frameW, poolSize: 2 });
  const frameH = Math.round(frameW / aspect);

  const { create } = await landmarker();
  const halves = ["near", "far"] as const;
  const regions = { near: halfRegion(corners, Hinv, "near"), far: halfRegion(corners, Hinv, "far") };
  const models = { near: await create(), far: await create() };
  const crop = new OffscreenCanvas(1, 1);
  const cctx = crop.getContext("2d")!;
  const raw: Record<"near" | "far", Raw[]> = { near: [], far: [] };
  const last: Record<"near" | "far", Raw> = { near: null, far: null };

  const times: number[] = [];
  for (let t = 0; t < duration; t += 1 / SAMPLE_FPS) times.push(t);
  let i = 0;
  for await (const wrapped of sink.canvasesAtTimestamps(times)) {
    if (signal?.aborted) throw new Error("Tracking cancelled");
    const t = times[i++];
    if (!wrapped) {
      for (const half of halves) raw[half].push(null);
      continue;
    }
    for (const half of halves) {
      const r = regions[half];
      // Upscale the crop so the far player is big enough for the pose model.
      const sw = r.w * frameW;
      const sh = r.h * frameH;
      const scale = Math.min(3, Math.max(1, 640 / Math.max(sw, sh)));
      crop.width = Math.round(sw * scale);
      crop.height = Math.round(sh * scale);
      cctx.drawImage(wrapped.canvas as CanvasImageSource, r.x0 * frameW, r.y0 * frameH, sw, sh, 0, 0, crop.width, crop.height);
      const res = models[half].detectForVideo(crop as unknown as HTMLCanvasElement, Math.round(t * 1000));
      let best: Raw = null;
      let bestScore = -Infinity;
      for (const lm of res.landmarks) {
        // Feet = lowest visible ankle/heel/toe; head = nose. Convert crop coords back to full-frame coords.
        const toFrame = (p: { x: number; y: number }) => ({ x: r.x0 + p.x * r.w, y: r.y0 + p.y * r.h });
        const feetIdx = [27, 28, 29, 30, 31, 32].filter((k) => (lm[k]?.visibility ?? 1) > 0.2);
        if (!feetIdx.length) continue;
        const fl = feetIdx.map((k) => toFrame(lm[k]));
        const foot = { x: fl.reduce((a, p) => a + p.x, 0) / fl.length, y: Math.max(...fl.map((p) => p.y)) };
        const head = toFrame(lm[0]);
        const c = apply(H, foot);
        const inHalf = half === "far" ? c.y > -2 && c.y < NET_Y + 0.5 : c.y > NET_Y - 0.5 && c.y < COURT_L + 2;
        if (!inHalf || c.x < -1.5 || c.x > COURT_W + 1.5) continue; // spectators, umpire, other courts
        const prev = last[half];
        const dist = prev ? Math.hypot(c.x - prev.cx, c.y - prev.cy) : 0;
        const size = foot.y - head.y;
        const score = (prev ? -dist * 3 : 0) + size * 10 - Math.abs(c.x - COURT_W / 2) * 0.2;
        if (score > bestScore) {
          bestScore = score;
          best = { t, x: foot.x, y: foot.y, bh: Math.max(0.02, size * 1.12), cx: c.x, cy: c.y };
        }
      }
      raw[half].push(best);
      if (best) last[half] = best;
    }
    onProgress(i / times.length);
  }
  models.near.close();
  models.far.close();
  input.dispose();
  return { version: 1, fps: SAMPLE_FPS, corners, near: finish(raw.near, times), far: finish(raw.far, times) };
}

/** Fill short gaps, smooth, then compute speed, movements and stats. */
export function finish(raw: Raw[], times: number[]): PlayerTrack {
  const n = raw.length;
  const pts: (Omit<TrackPoint, "v"> | null)[] = raw.map((r) => (r ? { ...r } : null));
  // Reject glitches: a point more than 1 m from the median of its neighbours (±0.3 s) is a mis-detection.
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    if (!p) continue;
    const nb = raw.slice(Math.max(0, i - 3), i + 4).filter((r, k) => r && k !== Math.min(3, i)) as NonNullable<Raw>[];
    if (nb.length < 2) continue;
    const med = (k: "cx" | "cy") => [...nb.map((r) => r[k])].sort((a, b) => a - b)[Math.floor(nb.length / 2)];
    if (Math.hypot(p.cx - med("cx"), p.cy - med("cy")) > 1) pts[i] = null;
  }
  // Interpolate gaps up to MAX_GAP_S.
  let lastIdx = -1;
  for (let i = 0; i < n; i++) {
    if (!pts[i]) continue;
    if (lastIdx >= 0 && i - lastIdx > 1 && times[i] - times[lastIdx] <= MAX_GAP_S) {
      const a = pts[lastIdx]!;
      const b = pts[i]!;
      for (let k = lastIdx + 1; k < i; k++) {
        const f = (k - lastIdx) / (i - lastIdx);
        pts[k] = {
          t: times[k],
          x: a.x + (b.x - a.x) * f,
          y: a.y + (b.y - a.y) * f,
          bh: a.bh + (b.bh - a.bh) * f,
          cx: a.cx + (b.cx - a.cx) * f,
          cy: a.cy + (b.cy - a.cy) * f,
        };
      }
    }
    lastIdx = i;
  }
  // Median then mean filter (5 samples) on each coordinate, within continuous runs.
  const keys = ["x", "y", "bh", "cx", "cy"] as const;
  const smooth = (src: typeof pts, f: (w: number[]) => number) =>
    src.map((p, i) => {
      if (!p) return null;
      const win = src.slice(Math.max(0, i - 2), i + 3).filter(Boolean) as NonNullable<(typeof pts)[number]>[];
      const out = { ...p };
      for (const k of keys) out[k] = f(win.map((w) => w[k]));
      return out;
    });
  const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
  const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
  const sm = smooth(smooth(pts, median), mean);

  // Speed over a ±0.2 s window, km/h.
  const out: TrackPoint[] = [];
  for (let i = 0; i < n; i++) {
    const p = sm[i];
    if (!p) continue;
    const a = sm[i - 2] ?? sm[i - 1] ?? p;
    const b = sm[i + 2] ?? sm[i + 1] ?? p;
    const dt = b.t - a.t;
    let v = dt > 0 ? (Math.hypot(b.cx - a.cx, b.cy - a.cy) / dt) * 3.6 : 0;
    if (v > MAX_KMH) continue; // physically implausible for a badminton player: tracking glitch
    out.push({ ...p, v: Math.round(v * 10) / 10 });
  }

  // Movements: runs above 5 km/h lasting ≥0.4 s.
  const movements: Movement[] = [];
  let s = -1;
  for (let i = 0; i <= out.length; i++) {
    const moving = i < out.length && out[i].v >= 5 && (i === 0 || out[i].t - out[i - 1].t < 0.25);
    if (moving && s < 0) s = i;
    if (!moving && s >= 0) {
      const seg = out.slice(s, i);
      const dur = seg.at(-1)!.t - seg[0].t;
      if (dur >= 0.4) {
        let d = 0;
        for (let k = 1; k < seg.length; k++) d += Math.hypot(seg[k].cx - seg[k - 1].cx, seg[k].cy - seg[k - 1].cy);
        const avg = (d / dur) * 3.6;
        const sorted = seg.map((p) => p.v).sort((a, b) => b - a);
        const peak = sorted[Math.min(1, sorted.length - 1)]; // 2nd highest: robust to a single noisy sample
        movements.push({ start: seg[0].t, end: seg.at(-1)!.t, distance: round1(d), avg: round1(avg), peak: round1(peak), band: bandOf(avg) });
      }
      s = -1;
    }
  }

  let distance = 0;
  for (let k = 1; k < out.length; k++) {
    if (out[k].t - out[k - 1].t > 0.25) continue;
    const d = Math.hypot(out[k].cx - out[k - 1].cx, out[k].cy - out[k - 1].cy);
    if (d < 1.5) distance += d;
  }
  const movingTime = movements.reduce((a, m) => a + (m.end - m.start), 0);
  const movingDist = movements.reduce((a, m) => a + m.distance, 0);
  return {
    points: out,
    movements,
    stats: {
      distance: Math.round(distance),
      top: round1(Math.max(0, ...movements.filter((m) => m.distance >= 0.8).map((m) => m.peak))),
      avgMoving: movingTime ? round1((movingDist / movingTime) * 3.6) : 0,
      coverage: times.length ? Math.round((out.length / times.length) * 100) : 0,
    },
  };
}

const round1 = (v: number) => Math.round(v * 10) / 10;

/** Position of a player at time t (linear interpolation), or undefined when not tracked then. */
export function positionAt(pt: PlayerTrack, t: number): TrackPoint | undefined {
  const p = pt.points;
  if (!p.length || t < p[0].t || t > p.at(-1)!.t) return undefined;
  let lo = 0;
  let hi = p.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (p[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = p[lo];
  const b = p[hi];
  if (b.t - a.t > 0.25) return t - a.t < 0.15 ? a : undefined; // untracked gap
  const f = b.t === a.t ? 0 : (t - a.t) / (b.t - a.t);
  const lerp = (k: "x" | "y" | "bh" | "v") => a[k] + (b[k] - a[k]) * f;
  return { t, x: lerp("x"), y: lerp("y"), bh: lerp("bh"), cx: a.cx, cy: a.cy, v: lerp("v") };
}

/** Recent path of a player (for the trail), newest last. */
export function trailAt(pt: PlayerTrack, t: number, seconds = 1.2): TrackPoint[] {
  return pt.points.filter((p) => p.t <= t && p.t >= t - seconds);
}

// ---------- Cache (per video file, in this browser) ----------

const DB = "courtsense-tracks";
function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore("tracks");
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
export const trackKey = (analysisId: string, f: File) => `${analysisId}:${f.name}:${f.size}`;

export async function loadTracks(key: string): Promise<Tracks | undefined> {
  try {
    const d = await db();
    return await new Promise((resolve) => {
      const r = d.transaction("tracks").objectStore("tracks").get(key);
      r.onsuccess = () => resolve(r.result as Tracks | undefined);
      r.onerror = () => resolve(undefined);
    });
  } catch {
    return undefined;
  }
}

export async function saveTracks(key: string, tracks: Tracks): Promise<void> {
  try {
    const d = await db();
    d.transaction("tracks", "readwrite").objectStore("tracks").put(tracks, key);
  } catch {
    /* cache is a convenience only */
  }
}
