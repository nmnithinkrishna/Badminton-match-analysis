import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  Conversion,
  Input,
  Mp4OutputFormat,
  Output,
  QUALITY_LOW,
  QUALITY_MEDIUM,
} from "mediabunny";
import { drawOverlay, type Timeline } from "./overlay";

/** Files smaller than this are uploaded as-is. */
const COMPRESS_ABOVE_BYTES = 60 * 1024 * 1024;

export async function probeDuration(file: File): Promise<number> {
  try {
    const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
    const d = await input.computeDuration();
    input.dispose();
    if (d > 0) return d;
  } catch {
    /* fall back to the media element */
  }
  return new Promise((resolve, reject) => {
    const v = document.createElement("video");
    v.preload = "metadata";
    v.onloadedmetadata = () => {
      URL.revokeObjectURL(v.src);
      resolve(v.duration);
    };
    v.onerror = () => reject(new Error("Could not read this video"));
    v.src = URL.createObjectURL(file);
  });
}

/**
 * Shrinks the video for upload (480p, 15 fps, mono audio). Gemini samples ~1 frame/s,
 * so this keeps analysis quality while cutting upload size ~10×. Returns the original on any failure.
 */
export async function compressForUpload(file: File, onProgress: (p: number) => void): Promise<File> {
  if (file.size <= COMPRESS_ABOVE_BYTES || typeof VideoEncoder === "undefined") return file;
  try {
    const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target: new BufferTarget() });
    const track = await input.getPrimaryVideoTrack();
    const tall = track ? Math.min(track.displayWidth, track.displayHeight) > 480 : false;
    const conversion = await Conversion.init({
      input,
      output,
      video: { ...(tall ? { height: 480 } : {}), frameRate: 15, codec: "avc", quality: QUALITY_LOW },
      audio: { codec: "aac", numberOfChannels: 1, sampleRate: 22050, bitrate: 48_000 },
      showWarnings: false,
    });
    if (!conversion.isValid) return file;
    conversion.onProgress = onProgress;
    await conversion.execute();
    const buf = (output.target as BufferTarget).buffer;
    input.dispose();
    if (!buf || buf.byteLength >= file.size) return file;
    return new File([buf], file.name.replace(/\.\w+$/, "") + "-480p.mp4", { type: "video/mp4" });
  } catch (e) {
    console.warn("compression skipped", e);
    return file;
  }
}

/** Renders the original video with the AI annotations burned in, as an MP4 Blob. */
export async function renderAnnotated(
  file: File,
  tl: Timeline,
  onProgress: (p: number) => void,
  signal?: AbortSignal,
): Promise<Blob> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target: new BufferTarget() });
  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error("No video track found");

  // Cap at 720p for speed on phones.
  const scale = Math.min(1, 720 / Math.min(track.displayWidth, track.displayHeight));
  const w = Math.round((track.displayWidth * scale) / 2) * 2;
  const h = Math.round((track.displayHeight * scale) / 2) * 2;
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d")!;

  const conversion = await Conversion.init({
    input,
    output,
    video: {
      codec: "avc",
      quality: QUALITY_MEDIUM,
      processedWidth: w,
      processedHeight: h,
      process: (sample) => {
        ctx.clearRect(0, 0, w, h);
        sample.draw(ctx, 0, 0, w, h);
        drawOverlay(ctx, w, h, sample.timestamp, tl);
        return canvas;
      },
    },
    audio: { codec: "aac" },
    showWarnings: false,
  });
  if (!conversion.isValid) throw new Error("This browser can't export this video");
  conversion.onProgress = onProgress;
  signal?.addEventListener("abort", () => void conversion.cancel());
  await conversion.execute();
  input.dispose();
  const buf = (output.target as BufferTarget).buffer;
  if (!buf) throw new Error("Export produced no data");
  return new Blob([buf], { type: "video/mp4" });
}
