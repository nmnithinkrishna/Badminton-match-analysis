import { RATINGS, SHOTS, ZONES, type Moment, type PlayerProfile, type Report } from "../../shared/report";
import { fmt, toSeconds } from "../../shared/time";

export type TRally = {
  start: number;
  end: number;
  n: number;
  winner: "me" | "opponent" | "unclear";
  shots: number;
  endedBy: Report["rallies"][number]["ended_by"];
  finalShot: string;
  intensity: { me: number; opponent: number };
  /** Score after this rally (estimated rallies won). */
  score: { me: number; opponent: number };
};
export type TMoment = Omit<Moment, "time"> & { t: number };
export type Timeline = {
  headline: string;
  rallies: TRally[];
  moments: TMoment[];
  players: Report["players"];
  takeaways: { title: string; action: string }[];
};

export const BRAND = "CourtSense";
/** Player identity colours, used everywhere (charts and video). Validated colour-blind safe as a pair. */
export const PLAYER_COLOR = { me: "#3987e5", opponent: "#d95926", both: "#d4d4d8" } as const;
export const PLAYER_NAME = { me: "You", opponent: "Opponent", both: "Both" } as const;

const MOMENT_BEFORE = 0.5;
const MOMENT_AFTER = 3.5;
const POINT_BANNER_S = 2.5;
const INTRO_S = 4;

export function buildTimeline(report: Report): Timeline {
  const score = { me: 0, opponent: 0 };
  const rallies = report.rallies
    .map((r) => ({ ...r, s: toSeconds(r.start), e: toSeconds(r.end) }))
    .filter((r) => Number.isFinite(r.s) && Number.isFinite(r.e) && r.e >= r.s)
    .sort((a, b) => a.s - b.s)
    .map((r, i): TRally => {
      if (r.winner !== "unclear") score[r.winner]++;
      return {
        start: r.s,
        end: r.e,
        n: i + 1,
        winner: r.winner,
        shots: r.shots,
        endedBy: r.ended_by,
        finalShot: r.final_shot,
        intensity: r.intensity,
        score: { ...score },
      };
    });
  const moments = report.moments
    .map(({ time, ...m }) => ({ ...m, t: toSeconds(time) }))
    .filter((m) => Number.isFinite(m.t))
    .sort((a, b) => a.t - b.t);
  return {
    headline: report.summary.headline,
    rallies,
    moments,
    players: report.players,
    takeaways: report.takeaways.map(({ title, action }) => ({ title, action })),
  };
}

export function activeMoment(tl: Timeline, t: number) {
  let found: TMoment | undefined;
  for (const m of tl.moments) {
    if (t >= m.t - MOMENT_BEFORE && t <= m.t + MOMENT_AFTER) found = m; // latest wins
  }
  return found;
}

export function activeRally(tl: Timeline, t: number) {
  return tl.rallies.find((r) => t >= r.start && t <= r.end + 0.5);
}

/** Estimated score at time t: rallies that have finished by then. */
export function scoreAt(tl: Timeline, t: number) {
  let s = { me: 0, opponent: 0 };
  for (const r of tl.rallies) if (r.end <= t) s = r.score;
  return s;
}

/** The rally whose point was just decided (for the "point" banner). */
export function justEnded(tl: Timeline, t: number) {
  return tl.rallies.find((r) => r.winner !== "unclear" && t > r.end && t <= r.end + POINT_BANNER_S);
}

// ---------- Between-rally stats panels ----------

export const PANELS = ["h2h", "speed", "shots", "coverage", "momentum", "takeaways"] as const;
type Panel = (typeof PANELS)[number];
const MIN_GAP_S = 3;

/** Gap between two rallies long enough for a stats panel; i counts gaps so panels rotate. */
export function activeGap(tl: Timeline, t: number) {
  for (let i = 0; i < tl.rallies.length - 1; i++) {
    const a = tl.rallies[i].end + POINT_BANNER_S;
    const b = tl.rallies[i + 1].start - 0.3;
    if (b - a >= MIN_GAP_S && t >= a && t <= b) return { i, start: a, end: b };
  }
  return undefined;
}

const RATING_LABEL: Record<(typeof RATINGS)[number], string> = {
  speed: "Speed", footwork: "Footwork", attack: "Attack", defence: "Defence", net_play: "Net play", consistency: "Consistency",
};
const PANEL_TITLE: Record<Panel, string> = {
  h2h: "Head to head", speed: "Movement speed", shots: "Shot mix", coverage: "Where they hit from",
  momentum: "Score so far", takeaways: "Your 3 takeaways",
};

export function drawPanel(ctx: Ctx, w: number, h: number, u0: number, t: number, tl: Timeline, kind: Panel) {
  const rows = kind === "h2h" ? 6 : kind === "shots" ? 6 : kind === "takeaways" ? 3 : 4;
  const rowUnits = kind === "takeaways" ? 40 : 22;
  const units = 52 + rows * rowUnits + (kind === "coverage" || kind === "speed" ? 40 : 0);
  // Shrink the panel to fit short (e.g. portrait phone) videos rather than overflow them.
  const u = Math.min(u0, (h - 16) / units, (w - 16) / 400);
  const pw = Math.min(w - 20 * u, 400 * u);
  const rowH = rowUnits * u;
  const ph = units * u;
  const x = (w - pw) / 2;
  const y = Math.max(8, (h - ph) / 2);
  ctx.fillStyle = "rgba(10,10,14,0.82)";
  roundRect(ctx, x, y, pw, ph, 14 * u);
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.font = `800 ${15 * u}px ${FONT}`;
  ctx.fillText(PANEL_TITLE[kind], x + 16 * u, y + 20 * u);
  if (kind !== "takeaways") legend(ctx, x + pw - 16 * u, y + 20 * u, u);
  const bx = x + 16 * u;
  const bw = pw - 32 * u;
  const top = y + 44 * u;
  const { me, opponent } = tl.players;

  if (kind === "h2h") {
    RATINGS.forEach((k, i) => butterfly(ctx, bx, top + i * rowH, bw, u, RATING_LABEL[k], me.ratings[k], opponent.ratings[k], 10, ""));
  } else if (kind === "shots") {
    SHOTS.forEach((k, i) => butterfly(ctx, bx, top + i * rowH, bw, u, cap(k), me.shot_mix[k], opponent.shot_mix[k], 60, "%"));
  } else if (kind === "speed") {
    const col = (p: PlayerProfile, who: "me" | "opponent", cx: number) => {
      ctx.fillStyle = PLAYER_COLOR[who];
      ctx.font = `700 ${11 * u}px ${FONT}`;
      ctx.fillText(PLAYER_NAME[who].toUpperCase(), cx, top + 6 * u);
      ctx.fillStyle = "#fff";
      ctx.font = `800 ${30 * u}px ${FONT}`;
      const big = p.speed.est_top_speed_kmh ? `~${Math.round(p.speed.est_top_speed_kmh)}` : "–";
      ctx.fillText(big, cx, top + 34 * u);
      const bwid = ctx.measureText(big).width;
      ctx.font = `600 ${12 * u}px ${FONT}`;
      ctx.fillText("km/h top", cx + bwid + 6 * u, top + 38 * u);
      ctx.fillStyle = "rgba(255,255,255,0.75)";
      ctx.fillText(cap(p.speed.level), cx, top + 62 * u);
      for (let i = 0; i < 10; i++) {
        ctx.fillStyle = i < p.ratings.speed ? PLAYER_COLOR[who] : "rgba(255,255,255,0.18)";
        roundRect(ctx, cx + i * 13 * u, top + 76 * u, 10 * u, 10 * u, 2 * u);
        ctx.fill();
      }
      ctx.fillStyle = "rgba(255,255,255,0.75)";
      ctx.font = `400 ${11 * u}px ${FONT}`;
      wrap(ctx, p.speed.note, bw / 2 - 12 * u, 2).forEach((l, i) => ctx.fillText(l, cx, top + 102 * u + i * 14 * u));
    };
    col(me, "me", bx);
    col(opponent, "opponent", bx + bw / 2 + 8 * u);
  } else if (kind === "coverage") {
    const cw = Math.min(bw / 2 - 30 * u, 70 * u);
    const heat = (p: PlayerProfile, who: "me" | "opponent", cx: number) => {
      ctx.fillStyle = PLAYER_COLOR[who];
      ctx.font = `700 ${11 * u}px ${FONT}`;
      ctx.fillText(PLAYER_NAME[who].toUpperCase(), cx, top + 4 * u);
      heatCourt(ctx, cx, top + 30 * u, cw, u, p.court_coverage, PLAYER_COLOR[who]);
    };
    heat(me, "me", bx + bw / 4 - cw / 2);
    heat(opponent, "opponent", bx + (3 * bw) / 4 - cw / 2);
  } else if (kind === "momentum") {
    momentum(ctx, bx, top, bw, rows * rowH, u, t, tl);
  } else {
    tl.takeaways.forEach((k, i) => {
      const cy = top + i * rowH;
      ctx.fillStyle = PLAYER_COLOR.me;
      ctx.font = `800 ${15 * u}px ${FONT}`;
      ctx.fillText(String(i + 1), bx, cy + 2 * u);
      ctx.fillStyle = "#fff";
      ctx.font = `700 ${13 * u}px ${FONT}`;
      ctx.fillText(wrap(ctx, k.title, bw - 20 * u, 1)[0] ?? "", bx + 20 * u, cy + 2 * u);
      ctx.fillStyle = "rgba(255,255,255,0.75)";
      ctx.font = `400 ${11 * u}px ${FONT}`;
      ctx.fillText(wrap(ctx, k.action, bw - 20 * u, 1)[0] ?? "", bx + 20 * u, cy + 18 * u);
    });
  }
}

function legend(ctx: Ctx, right: number, cy: number, u: number) {
  ctx.font = `600 ${11 * u}px ${FONT}`;
  let x = right;
  for (const who of ["opponent", "me"] as const) {
    const label = PLAYER_NAME[who];
    x -= ctx.measureText(label).width;
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.fillText(label, x, cy);
    x -= 14 * u;
    ctx.fillStyle = PLAYER_COLOR[who];
    roundRect(ctx, x, cy - 5 * u, 10 * u, 10 * u, 2 * u);
    ctx.fill();
    x -= 12 * u;
  }
}

/** One row: label in the middle, "me" bar growing left, "opponent" bar growing right, values at bar ends. */
function butterfly(ctx: Ctx, x: number, y: number, w: number, u: number, label: string, a: number, b: number, max: number, unit: string) {
  const mid = x + w / 2;
  const labelW = 74 * u;
  const half = w / 2 - labelW / 2 - 26 * u;
  ctx.font = `600 ${11 * u}px ${FONT}`;
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.fillText(label, mid - ctx.measureText(label).width / 2, y);
  const la = (half * Math.min(a, max)) / max;
  const lb = (half * Math.min(b, max)) / max;
  ctx.fillStyle = PLAYER_COLOR.me;
  roundRect(ctx, mid - labelW / 2 - la, y - 5 * u, Math.max(la, 2 * u), 10 * u, 3 * u);
  ctx.fill();
  ctx.fillStyle = PLAYER_COLOR.opponent;
  roundRect(ctx, mid + labelW / 2, y - 5 * u, Math.max(lb, 2 * u), 10 * u, 3 * u);
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.font = `700 ${11 * u}px ${FONT}`;
  const ta = `${a}${unit}`;
  ctx.fillText(ta, mid - labelW / 2 - la - 6 * u - ctx.measureText(ta).width, y);
  ctx.fillText(`${b}${unit}`, mid + labelW / 2 + lb + 6 * u, y);
}

/** Half court heatmap: opacity of the player colour = share of shots from that zone. */
function heatCourt(ctx: Ctx, x: number, y: number, cw: number, u: number, cov: Record<string, number>, color: string) {
  const ch = cw * 1.3;
  const maxV = Math.max(1, ...ZONES.map((z) => cov[z] ?? 0));
  ZONES.forEach((z) => {
    const [row, col] = z.split("_");
    const r = { front: 0, mid: 1, back: 2 }[row as "front"];
    const c = col === "left" ? 0 : 1;
    const v = cov[z] ?? 0;
    const zx = x + (c * cw) / 2;
    const zy = y + (r * ch) / 3;
    ctx.fillStyle = "#1f2a24";
    ctx.fillRect(zx, zy, cw / 2, ch / 3);
    ctx.globalAlpha = 0.15 + 0.85 * (v / maxV);
    ctx.fillStyle = color;
    ctx.fillRect(zx + 1 * u, zy + 1 * u, cw / 2 - 2 * u, ch / 3 - 2 * u);
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#fff";
    ctx.font = `700 ${11 * u}px ${FONT}`;
    const s = `${v}%`;
    ctx.fillText(s, zx + cw / 4 - ctx.measureText(s).width / 2, zy + ch / 6);
  });
  ctx.strokeStyle = "rgba(255,255,255,0.8)";
  ctx.lineWidth = Math.max(1, u);
  ctx.strokeRect(x, y, cw, ch);
  ctx.fillStyle = "rgba(255,255,255,0.7)";
  ctx.font = `700 ${9 * u}px ${FONT}`;
  ctx.fillText("NET", x + cw / 2 - ctx.measureText("NET").width / 2, y - 6 * u);
}

/** Running lead (your points minus opponent's) after each finished rally, up to time t. */
function momentum(ctx: Ctx, x: number, y: number, w: number, hgt: number, u: number, t: number, tl: Timeline) {
  const done = tl.rallies.filter((r) => r.end <= t);
  const s = scoreAt(tl, t);
  ctx.font = `600 ${12 * u}px ${FONT}`;
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  const lead = s.me - s.opponent;
  ctx.fillText(
    `${s.me}–${s.opponent} after ${done.length} rallies · ${lead === 0 ? "level" : lead > 0 ? `you lead by ${lead}` : `opponent leads by ${-lead}`}`,
    x, y,
  );
  const gy = y + 16 * u;
  const gh = hgt - 20 * u;
  const n = Math.max(tl.rallies.length, 2);
  const diffs = [0, ...done.map((r) => r.score.me - r.score.opponent)];
  const maxAbs = Math.max(3, ...tl.rallies.map((r) => Math.abs(r.score.me - r.score.opponent)));
  const px = (i: number) => x + (w * i) / n;
  const py = (d: number) => gy + gh / 2 - (d / maxAbs) * (gh / 2 - 4 * u);
  ctx.strokeStyle = "rgba(255,255,255,0.3)";
  ctx.lineWidth = Math.max(1, u);
  ctx.beginPath();
  ctx.moveTo(x, py(0));
  ctx.lineTo(x + w, py(0));
  ctx.stroke();
  ctx.fillStyle = "rgba(255,255,255,0.6)";
  ctx.font = `600 ${9 * u}px ${FONT}`;
  ctx.fillText("You ahead", x + w - ctx.measureText("You ahead").width, gy + 4 * u);
  ctx.fillText("Opponent ahead", x + w - ctx.measureText("Opponent ahead").width, gy + gh - 4 * u);
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 2 * u;
  ctx.beginPath();
  diffs.forEach((d, i) => (i ? ctx.lineTo(px(i), py(d)) : ctx.moveTo(px(i), py(d))));
  ctx.stroke();
  done.forEach((r, i) => {
    if (r.winner === "unclear") return;
    ctx.fillStyle = PLAYER_COLOR[r.winner];
    ctx.beginPath();
    ctx.arc(px(i + 1), py(diffs[i + 1]), 4 * u, 0, Math.PI * 2);
    ctx.fill();
  });
}

const KIND = { strength: "✓ Strength", weakness: "! Work on", tip: "• Tip" } as const;
const ENDED = { winner: "winner", forced_error: "forced error", unforced_error: "error", unclear: "" } as const;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, " ");

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
const FONT = "system-ui, -apple-system, sans-serif";
const PANEL = "rgba(10,10,14,0.72)";

/**
 * Draws the AI annotations for time `t` onto a canvas of size w×h. Used by the live player and the export.
 * `minUnit` keeps text readable on small screens (the live player passes ~0.85 × devicePixelRatio).
 */
export function drawOverlay(ctx: Ctx, w: number, h: number, t: number, tl: Timeline, minUnit = 0.6): void {
  const u = Math.max(minUnit, Math.min(w, (h * 16) / 9) / 640); // scale unit; 1 at 640px wide
  ctx.save();
  ctx.textBaseline = "middle";

  // Small (e.g. portrait phone) videos get a compact layout so the layers don't collide.
  const compact = w / u < 560;
  const m = activeMoment(tl, t);
  const ended = justEnded(tl, t);
  const gap = !m && !ended && t >= INTRO_S ? activeGap(tl, t) : undefined;

  if (!compact) pill(ctx, 10 * u, 10 * u, `${BRAND} · AI-estimated`, PANEL, "#fff", 11 * u);
  if (tl.rallies.length && !(compact && gap)) {
    if (compact) compactScore(ctx, w, u, t, tl);
    else scoreboard(ctx, w, u, t, tl);
  }
  if (ended) pointBanner(ctx, compact ? 10 * u : w / 2, compact ? 10 * u : 44 * u, u, ended, compact);
  if (gap) drawPanel(ctx, w, h, u, t, tl, PANELS[gap.i % PANELS.length]);

  if (t < INTRO_S && tl.headline) {
    card(ctx, w, h, u, { accent: "#a78bfa", kicker: "Match summary", title: tl.headline });
  }
  if (m && !(t < INTRO_S && tl.headline && m.t < INTRO_S)) {
    card(ctx, w, h, u, {
      accent: PLAYER_COLOR[m.player],
      kicker: `${PLAYER_NAME[m.player]} · ${KIND[m.kind]} · ${fmt(m.t)}`,
      title: m.label,
      detail: m.detail,
      shot: m.shot,
      speed: m.speed,
      zone: m.zone,
    });
  }
  ctx.restore();
}

function scoreboard(ctx: Ctx, w: number, u: number, t: number, tl: Timeline) {
  const s = scoreAt(tl, t);
  const rally = activeRally(tl, t);
  const bw = 150 * u;
  const rowH = 20 * u;
  const rows = rally ? 4 : 2;
  const bh = rowH * rows + 12 * u;
  const x = w - bw - 10 * u;
  const y = 10 * u;
  ctx.fillStyle = PANEL;
  roundRect(ctx, x, y, bw, bh, 10 * u);
  ctx.fill();

  const line = (i: number, who: "me" | "opponent") => {
    const cy = y + 6 * u + rowH * (i + 0.5);
    ctx.fillStyle = PLAYER_COLOR[who];
    roundRect(ctx, x + 10 * u, cy - 6 * u, 4 * u, 12 * u, 2 * u);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.font = `600 ${12 * u}px ${FONT}`;
    ctx.fillText(PLAYER_NAME[who], x + 20 * u, cy);
    ctx.font = `800 ${15 * u}px ${FONT}`;
    const v = String(s[who]);
    ctx.fillText(v, x + bw - 12 * u - ctx.measureText(v).width, cy);
  };
  line(0, "me");
  line(1, "opponent");

  if (rally) {
    let cy = y + 6 * u + rowH * 2.5;
    ctx.fillStyle = "rgba(255,255,255,0.75)";
    ctx.font = `600 ${11 * u}px ${FONT}`;
    ctx.fillText(`Rally ${rally.n} · ~${rally.shots} shots`, x + 10 * u, cy);
    cy += rowH;
    // Movement intensity of both players in this rally (AI estimate, 1-10).
    ctx.fillStyle = "rgba(255,255,255,0.75)";
    ctx.font = `600 ${10 * u}px ${FONT}`;
    ctx.fillText("Movement", x + 10 * u, cy);
    const bx = x + 70 * u;
    const full = bw - 80 * u;
    (["me", "opponent"] as const).forEach((who, i) => {
      const by = cy - 6 * u + i * 7 * u;
      ctx.fillStyle = "rgba(255,255,255,0.15)";
      roundRect(ctx, bx, by, full, 5 * u, 2.5 * u);
      ctx.fill();
      ctx.fillStyle = PLAYER_COLOR[who];
      roundRect(ctx, bx, by, (full * rally.intensity[who]) / 10, 5 * u, 2.5 * u);
      ctx.fill();
    });
  }
}

function pointBanner(ctx: Ctx, ax: number, y: number, u: number, r: TRally, leftAligned: boolean) {
  const who = r.winner as "me" | "opponent";
  const how = [cap(r.finalShot === "unknown" ? "" : r.finalShot), ENDED[r.endedBy]].filter(Boolean).join(" ");
  const text = `Point ${PLAYER_NAME[who]}${how ? ` · ${how}` : ""}`;
  ctx.font = `800 ${15 * u}px ${FONT}`;
  const tw = ctx.measureText(text).width + 28 * u;
  const x = leftAligned ? ax : ax - tw / 2;
  ctx.fillStyle = PLAYER_COLOR[who];
  roundRect(ctx, x, y, tw, 30 * u, 15 * u);
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.fillText(text, x + 14 * u, y + 15 * u);
}

/** One-line score for small videos: "You 3 – 2 Opp", plus the rally line while a rally is on. */
function compactScore(ctx: Ctx, w: number, u: number, t: number, tl: Timeline) {
  const s = scoreAt(tl, t);
  const rally = activeRally(tl, t);
  const parts: [string, string][] = [
    ["You ", "#fff"], [String(s.me), PLAYER_COLOR.me], [" – ", "#fff"], [String(s.opponent), PLAYER_COLOR.opponent], [" Opp", "#fff"],
  ];
  ctx.font = `800 ${14 * u}px ${FONT}`;
  const tw = parts.reduce((a, [p]) => a + ctx.measureText(p).width, 0);
  const sub = rally ? `Rally ${rally.n} · ~${rally.shots} shots` : "AI-estimated";
  ctx.font = `600 ${10 * u}px ${FONT}`;
  const bw = Math.max(tw, ctx.measureText(sub).width) + 20 * u;
  const x = w - bw - 8 * u;
  const y = 8 * u;
  ctx.fillStyle = PANEL;
  roundRect(ctx, x, y, bw, 40 * u, 10 * u);
  ctx.fill();
  let cx = x + 10 * u;
  ctx.font = `800 ${14 * u}px ${FONT}`;
  for (const [p, c] of parts) {
    ctx.fillStyle = c;
    ctx.fillText(p, cx, y + 13 * u);
    cx += ctx.measureText(p).width;
  }
  ctx.fillStyle = "rgba(255,255,255,0.75)";
  ctx.font = `600 ${10 * u}px ${FONT}`;
  ctx.fillText(sub, x + 10 * u, y + 30 * u);
}

type CardInput = {
  accent: string;
  kicker: string;
  title: string;
  detail?: string;
  shot?: string;
  speed?: number;
  zone?: string;
};

function card(ctx: Ctx, w: number, h: number, u: number, c: CardInput) {
  const pad = 12 * u;
  const maxW = Math.min(w - 20 * u, 560 * u);
  const hasCourt = !!c.zone;
  const courtW = hasCourt ? 46 * u : 0;
  const textW = maxW - pad * 2 - 6 * u - (hasCourt ? courtW + 12 * u : 0);
  const titleSize = 18 * u;
  const detailSize = 13 * u;
  ctx.font = `700 ${titleSize}px ${FONT}`;
  const titleLines = wrap(ctx, c.title, textW, 2);
  ctx.font = `400 ${detailSize}px ${FONT}`;
  const detailLines = c.detail ? wrap(ctx, c.detail, textW, 2) : [];
  const hasChips = !!c.shot || c.speed !== undefined;
  const textH = 14 * u + titleLines.length * titleSize * 1.25 + detailLines.length * detailSize * 1.35 + (hasChips ? 24 * u : 0);
  const height = pad * 2 + Math.max(textH, hasCourt ? courtW * 1.3 + 10 * u : 0);
  const x = (w - maxW) / 2;
  const y = h - height - 12 * u;

  ctx.fillStyle = "rgba(10,10,14,0.8)";
  roundRect(ctx, x, y, maxW, height, 12 * u);
  ctx.fill();
  ctx.fillStyle = c.accent;
  roundRect(ctx, x, y, 6 * u, height, 3 * u);
  ctx.fill();

  const tx = x + pad + 6 * u;
  let cy = y + pad + 6 * u;
  ctx.fillStyle = c.accent;
  ctx.font = `800 ${11 * u}px ${FONT}`;
  ctx.fillText(c.kicker.toUpperCase(), tx, cy);
  cy += 8 * u + titleSize * 0.65;
  ctx.fillStyle = "#fff";
  ctx.font = `700 ${titleSize}px ${FONT}`;
  for (const line of titleLines) {
    ctx.fillText(line, tx, cy);
    cy += titleSize * 1.25;
  }
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.font = `400 ${detailSize}px ${FONT}`;
  for (const line of detailLines) {
    ctx.fillText(line, tx, cy - titleSize * 0.15);
    cy += detailSize * 1.35;
  }

  if (hasChips) {
    let cx = tx;
    const cyc = cy + 4 * u;
    if (c.shot) {
      const label = cap(c.shot);
      ctx.font = `700 ${11 * u}px ${FONT}`;
      const cw = ctx.measureText(label).width + 16 * u;
      ctx.fillStyle = "rgba(255,255,255,0.14)";
      roundRect(ctx, cx, cyc - 10 * u, cw, 20 * u, 10 * u);
      ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.fillText(label, cx + 8 * u, cyc);
      cx += cw + 10 * u;
    }
    if (c.speed !== undefined) {
      ctx.fillStyle = "rgba(255,255,255,0.75)";
      ctx.font = `600 ${11 * u}px ${FONT}`;
      ctx.fillText("Speed", cx, cyc);
      cx += ctx.measureText("Speed").width + 6 * u;
      for (let i = 0; i < 10; i++) {
        ctx.fillStyle = i < c.speed ? c.accent : "rgba(255,255,255,0.18)";
        roundRect(ctx, cx + i * 7 * u, cyc - 5 * u, 5 * u, 10 * u, 1.5 * u);
        ctx.fill();
      }
    }
  }

  if (hasCourt) miniCourt(ctx, x + maxW - pad - courtW, y + pad, courtW, u, c.zone!, c.accent);
}

/** Half court seen from behind the player: net at the top, 3 rows (front/mid/back) × 2 columns. */
function miniCourt(ctx: Ctx, x: number, y: number, cw: number, u: number, zone: string, color: string) {
  const ch = cw * 1.3;
  const [row, col] = zone.split("_");
  const r = { front: 0, mid: 1, back: 2 }[row as "front"] ?? 1;
  const c = col === "left" ? 0 : 1;
  ctx.fillStyle = "#1f5135";
  roundRect(ctx, x, y + 8 * u, cw, ch, 3 * u);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.fillRect(x + (c * cw) / 2 + 1 * u, y + 8 * u + (r * ch) / 3 + 1 * u, cw / 2 - 2 * u, ch / 3 - 2 * u);
  ctx.strokeStyle = "rgba(255,255,255,0.8)";
  ctx.lineWidth = Math.max(1, 1 * u);
  ctx.strokeRect(x, y + 8 * u, cw, ch);
  ctx.beginPath();
  ctx.moveTo(x + cw / 2, y + 8 * u);
  ctx.lineTo(x + cw / 2, y + 8 * u + ch);
  for (const k of [1, 2]) {
    ctx.moveTo(x, y + 8 * u + (k * ch) / 3);
    ctx.lineTo(x + cw, y + 8 * u + (k * ch) / 3);
  }
  ctx.stroke();
  ctx.fillStyle = "rgba(255,255,255,0.7)";
  ctx.font = `700 ${8 * u}px ${FONT}`;
  ctx.fillText("NET", x + cw / 2 - ctx.measureText("NET").width / 2, y + 3 * u);
}

function pill(ctx: Ctx, x: number, y: number, text: string, bg: string, fg: string, size: number) {
  ctx.font = `600 ${size}px ${FONT}`;
  const padX = size * 0.8;
  const hgt = size * 2;
  const wid = ctx.measureText(text).width + padX * 2;
  ctx.fillStyle = bg;
  roundRect(ctx, x, y, wid, hgt, hgt / 2);
  ctx.fill();
  ctx.fillStyle = fg;
  ctx.fillText(text, x + padX, y + hgt / 2);
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
  ctx.roundRect(x, y, w, h, Math.max(0, Math.min(r, w / 2, h / 2)));
}
