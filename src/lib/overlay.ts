import type { Report } from "../../shared/report";
import { fmt, toSeconds } from "../../shared/time";

export type Timeline = {
  headline: string;
  rallies: { start: number; end: number; n: number; winner: string }[];
  moments: { t: number; kind: "strength" | "weakness" | "tip"; label: string; detail: string }[];
};

export const BRAND = "CourtSense";
const MOMENT_BEFORE = 0.5;
const MOMENT_AFTER = 3.5;
const INTRO_S = 4;

export function buildTimeline(report: Report): Timeline {
  const rallies = report.rallies
    .map((r) => ({ start: toSeconds(r.start), end: toSeconds(r.end), winner: r.estimated_winner }))
    .filter((r) => Number.isFinite(r.start) && Number.isFinite(r.end) && r.end >= r.start)
    .sort((a, b) => a.start - b.start)
    .map((r, i) => ({ ...r, n: i + 1 }));
  const moments = report.moments
    .map((m) => ({ t: toSeconds(m.time), kind: m.kind, label: m.label, detail: m.detail }))
    .filter((m) => Number.isFinite(m.t))
    .sort((a, b) => a.t - b.t);
  return { headline: report.summary.headline, rallies, moments };
}

export function activeMoment(tl: Timeline, t: number) {
  let found: Timeline["moments"][number] | undefined;
  for (const m of tl.moments) {
    if (t >= m.t - MOMENT_BEFORE && t <= m.t + MOMENT_AFTER) found = m; // latest wins
  }
  return found;
}

export function activeRally(tl: Timeline, t: number) {
  return tl.rallies.find((r) => t >= r.start && t <= r.end + 0.5);
}

const COLORS = { strength: "#22c55e", weakness: "#f59e0b", tip: "#38bdf8" } as const;
const KIND_LABEL = { strength: "Strength", weakness: "Work on", tip: "Tip" } as const;

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Draws the AI annotations for time `t` onto a canvas of size w×h. Used by the live player and the export. */
export function drawOverlay(ctx: Ctx, w: number, h: number, t: number, tl: Timeline): void {
  const u = Math.max(1, Math.min(w, h * 16 / 9) / 640); // scale unit; 1 at 640px wide
  ctx.save();
  ctx.textBaseline = "middle";

  // Brand + honesty badge, top-left.
  pill(ctx, 12 * u, 12 * u, `${BRAND} · AI-estimated`, "rgba(0,0,0,0.55)", "#fff", 12 * u);

  // Rally counter, top-right.
  const rally = activeRally(tl, t);
  if (rally) {
    const text = `Rally ${rally.n} · est.`;
    ctx.font = `600 ${13 * u}px system-ui, sans-serif`;
    const tw = ctx.measureText(text).width + 20 * u;
    pill(ctx, w - tw - 12 * u, 12 * u, text, "rgba(0,0,0,0.55)", "#fff", 13 * u);
  }

  // Intro headline for the first seconds.
  if (t < INTRO_S && tl.headline) {
    card(ctx, w, h, u, "#a78bfa", "Match summary", tl.headline, "");
  }

  const m = activeMoment(tl, t);
  if (m && !(t < INTRO_S && tl.headline && m.t < INTRO_S)) {
    card(ctx, w, h, u, COLORS[m.kind], `${KIND_LABEL[m.kind]} · ${fmt(m.t)}`, m.label, m.detail);
  }
  ctx.restore();
}

function pill(ctx: Ctx, x: number, y: number, text: string, bg: string, fg: string, size: number) {
  ctx.font = `600 ${size}px system-ui, sans-serif`;
  const padX = size * 0.8;
  const hgt = size * 2;
  const wid = ctx.measureText(text).width + padX * 2;
  ctx.fillStyle = bg;
  roundRect(ctx, x, y, wid, hgt, hgt / 2);
  ctx.fill();
  ctx.fillStyle = fg;
  ctx.fillText(text, x + padX, y + hgt / 2);
}

function card(ctx: Ctx, w: number, h: number, u: number, accent: string, kicker: string, title: string, detail: string) {
  const pad = 14 * u;
  const maxW = Math.min(w - 24 * u, 560 * u);
  const titleSize = 20 * u;
  const detailSize = 14 * u;
  ctx.font = `700 ${titleSize}px system-ui, sans-serif`;
  const titleLines = wrap(ctx, title, maxW - pad * 2 - 6 * u, 2);
  ctx.font = `400 ${detailSize}px system-ui, sans-serif`;
  const detailLines = detail ? wrap(ctx, detail, maxW - pad * 2 - 6 * u, 2) : [];
  const height = pad * 2 + 16 * u + titleLines.length * titleSize * 1.25 + detailLines.length * detailSize * 1.35;
  const x = (w - maxW) / 2;
  const y = h - height - 16 * u;

  ctx.fillStyle = "rgba(10,10,14,0.78)";
  roundRect(ctx, x, y, maxW, height, 12 * u);
  ctx.fill();
  ctx.fillStyle = accent;
  roundRect(ctx, x, y, 6 * u, height, 3 * u);
  ctx.fill();

  let cy = y + pad + 7 * u;
  ctx.fillStyle = accent;
  ctx.font = `700 ${12 * u}px system-ui, sans-serif`;
  ctx.fillText(kicker.toUpperCase(), x + pad + 6 * u, cy);
  cy += 9 * u + titleSize * 0.65;
  ctx.fillStyle = "#fff";
  ctx.font = `700 ${titleSize}px system-ui, sans-serif`;
  for (const line of titleLines) {
    ctx.fillText(line, x + pad + 6 * u, cy);
    cy += titleSize * 1.25;
  }
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.font = `400 ${detailSize}px system-ui, sans-serif`;
  for (const line of detailLines) {
    ctx.fillText(line, x + pad + 6 * u, cy - titleSize * 0.15);
    cy += detailSize * 1.35;
  }
}

function wrap(ctx: Ctx, text: string, maxW: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width > maxW && line) {
      lines.push(line);
      line = word;
      if (lines.length === maxLines) break;
    } else line = next;
  }
  if (lines.length < maxLines && line) lines.push(line);
  else if (lines.length === maxLines && words.join(" ") !== lines.join(" ")) {
    lines[maxLines - 1] = lines[maxLines - 1].replace(/\s*\S*$/, "…");
  }
  return lines;
}

function roundRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}
