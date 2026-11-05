import { describe, expect, it } from "vitest";
import { apply, bandOf, COURT_L, COURT_W, finish, homography, positionAt } from "../src/lib/track";

// A plausible camera view of a court: far baseline narrow and high, near baseline wide and low.
const corners = [
  { x: 0.35, y: 0.3 },
  { x: 0.65, y: 0.3 },
  { x: 0.9, y: 0.9 },
  { x: 0.1, y: 0.9 },
];
const court = [
  { x: 0, y: 0 },
  { x: COURT_W, y: 0 },
  { x: COURT_W, y: COURT_L },
  { x: 0, y: COURT_L },
];

describe("homography", () => {
  const H = homography(corners, court);
  const Hinv = homography(court, corners);

  it("maps the tapped corners onto the court corners", () => {
    corners.forEach((c, i) => {
      const p = apply(H, c);
      expect(p.x).toBeCloseTo(court[i].x, 6);
      expect(p.y).toBeCloseTo(court[i].y, 6);
    });
  });

  it("round-trips image -> court -> image", () => {
    const img = { x: 0.52, y: 0.71 };
    const back = apply(Hinv, apply(H, img));
    expect(back.x).toBeCloseTo(img.x, 6);
    expect(back.y).toBeCloseTo(img.y, 6);
  });

  it("puts the net halfway in court metres, above the image midpoint (perspective)", () => {
    const net = apply(Hinv, { x: COURT_W / 2, y: COURT_L / 2 });
    expect(net.y).toBeLessThan(0.6);
    expect(net.y).toBeGreaterThan(0.3);
  });
});

describe("speed and movements", () => {
  // 10 fps: stand still 2 s, run 3 m sideways in 0.75 s (14.4 km/h), stand still 2 s.
  const times: number[] = [];
  for (let t = 0; t < 4.75; t += 0.1) times.push(Math.round(t * 10) / 10);
  const raw = times.map((t) => {
    const cx = t < 2 ? 1.5 : t < 2.75 ? 1.5 + ((t - 2) / 0.75) * 3 : 4.5;
    return { t, x: 0.5, y: 0.8, bh: 0.2, cx, cy: 11 };
  });
  const track = finish(raw, times);

  it("finds one fast movement of about 3 m", () => {
    expect(track.movements).toHaveLength(1);
    const m = track.movements[0];
    expect(m.distance).toBeGreaterThan(2.5);
    expect(m.distance).toBeLessThan(3.3);
    expect(m.band).toBe("fast");
    expect(m.peak).toBeGreaterThan(11);
    expect(m.peak).toBeLessThan(18);
  });

  it("reports near-zero speed while standing", () => {
    expect(positionAt(track, 0.8)!.v).toBeLessThan(1);
    expect(positionAt(track, 4.2)!.v).toBeLessThan(1);
  });

  it("ignores a single-frame detection glitch", () => {
    const glitch = raw.map((r, i) => (i === 10 ? { ...r, cx: 6 } : r));
    expect(finish(glitch, times).movements).toHaveLength(1);
  });

  it("does not interpolate across long gaps", () => {
    const gappy = raw.map((r, i) => (i >= 5 && i < 20 ? null : r));
    expect(positionAt(finish(gappy, times), 1.2)).toBeUndefined();
  });

  it("bands speeds", () => {
    expect(bandOf(3)).toBe("slow");
    expect(bandOf(8)).toBe("medium");
    expect(bandOf(15)).toBe("fast");
  });
});
