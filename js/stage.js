/*
 * stage.js — the hero "stage": a parametric hand rig that forms each mudra.
 *
 * Public API (window.Stage):
 *   Stage.goTo(mudra) -> Promise<boolean>  hands move into the mudra's pose, the book illustration
 *                                          and the info card appear. Resolves true when finished,
 *                                          false if a later goTo/reset interrupted it.
 *   Stage.reset()     -> Promise<boolean>  hands return to rest, illustration + card go away.
 *   Stage.current     -> the mudra on stage, or null.
 *   Stage.state       -> "rest" | "busy" | "shown"
 *   Stage.traditionIcon(t) -> inline SVG string for "yoga" | "dance" (also used by app.js).
 *
 * How the rig works
 *   - Pose data (window.POSES, see POSE_SCHEMA.md) is turned into a flat set of NUMBERS per hand:
 *     placement (x, y, rot, scale, mirror), view (phi: 0 front, 90 side, 180 back), and joint angles
 *     for every finger + the thumb. `buildTarget()` does this, including the small geometry solves
 *     that make fingertips actually meet the thumb.
 *   - `handParts()` turns those numbers into SVG. Each finger is a 3-segment chain whose flexion is
 *     projected onto the screen: bending a finger toward the palm shortens it and, past 90°, folds it
 *     down over the palm (that is what a curled finger looks like from the front).
 *   - The animation simply interpolates every number from the current values to the target ones
 *     (requestAnimationFrame), so a new goTo() mid-animation just retargets from wherever we are.
 *
 * Hand sides: `R` is the practitioner's right hand. We look AT the practitioner (like the book's
 * photos), so R is drawn on the viewer's LEFT and L on the viewer's right.
 */
(function () {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const EASE = "cubic-bezier(.45, 0, .2, 1)";
  const RAD = Math.PI / 180;
  const VIEW_W = 600, VIEW_H = 440; // SVG viewBox

  let els = null;
  let state = "rest"; // "rest" | "busy" | "shown"
  let token = 0;      // increments on every goTo/reset; older sequences bail out
  let running = [];   // live Web Animations (card + illustration fades)
  let current = null;

  /* ================================================================ hand model
   * Local frame of ONE hand: wrist at (0,0), fingers point up (-y), thumb on the -x side,
   * palm toward the viewer. Mirroring/rotation into place happens in the SVG transform.
   */
  const FINGERS = ["index", "middle", "ring", "little"];
  const MCP = { index: [-31, -100], middle: [-10, -105], ring: [11, -101], little: [30, -92] }; // knuckles
  const LEN = { index: [42, 25, 20], middle: [47, 29, 21], ring: [44, 27, 20], little: [33, 20, 17] };
  const WID = { index: 19, middle: 20, ring: 19, little: 16 };
  const THUMB = { base: [-30, -28], l1: 46, l2: 36, w: 21 };

  // Joint angles (deg) for each finger state; touch is solved per pose.
  const CURL = {
    ext: [0, 0, 0],
    relaxed: [7, 10, 6],
    bent: [28, 55, 40],
    curled: [88, 100, 70],
    pressed: [88, 100, 70]
  };
  const TOUCH_CURL = [55, 95, 55];                                  // shape used when solving a touch
  const TOUCH_PSI = { index: 42, middle: 32, ring: 24, little: 18 }; // tilt of the bend toward the thumb
  const SPLAY = { spread: [-15, -5, 6, 17], together: [-3, -1, 1, 3], relaxed: [-8, -2, 4, 10] };

  // Where a free (non-touching) thumb tip goes, in local coords (x is scaled by the palm squash).
  const THUMB_AT = {
    ext: [-92, -80], side: [-44, -112], folded: [14, -52], up: [-36, -106], relaxed: [-80, -88]
  };

  const sq = (phi) => Math.max(Math.abs(Math.cos(phi * RAD)), 0.36); // palm width factor (side view = narrow)

  // Points of one finger chain [MCP, PIP, DIP, tip] in local coords (no mirror / foreshortening yet).
  // Flexion bends each segment out of the palm plane; we see its projection: "up" shrinks by cos,
  // and a sideways part (toward the thumb) appears when the bend plane is tilted (psi) or seen from the side.
  function chain(name, f, phi) {
    const m = sq(phi);
    const k = Math.abs(Math.sin(phi * RAD));
    const psi = (f.psi + (90 - f.psi) * k) * RAD; // side view: the bend is seen in full profile
    const a = f.a * m * RAD; // abduction is mostly hidden when the hand is seen edge-on
    let x = MCP[name][0] * m, y = MCP[name][1], th = 0;
    const pts = [[x, y]];
    [f.t1, f.t2, f.t3].forEach((t, i) => {
      th += t * RAD;
      const lat = -Math.sin(psi) * Math.sin(th); // toward the thumb (-x)
      const up = Math.cos(th);
      const vx = lat, vy = -up;                   // unrotated direction
      const L = LEN[name][i];
      x += L * (vx * Math.cos(a) - vy * Math.sin(a));
      y += L * (vx * Math.sin(a) + vy * Math.cos(a));
      pts.push([x, y]);
    });
    return pts;
  }

  // Make a finger's tip land on point M by choosing how much it curls (c) and its sideways angle (a).
  function solveTouch(name, M, phi) {
    const base = [MCP[name][0] * sq(phi), MCP[name][1]];
    const v = [M[0] - base[0], M[1] - base[1]];
    const d = Math.hypot(v[0], v[1]);
    const psi = TOUCH_PSI[name];
    const off = (c) => {
      const p = chain(name, { a: 0, psi, t1: TOUCH_CURL[0] * c, t2: TOUCH_CURL[1] * c, t3: TOUCH_CURL[2] * c }, phi);
      return [p[3][0] - p[0][0], p[3][1] - p[0][1]];
    };
    // reach shrinks as c grows: bisect for |off(c)| = d
    let lo = 0, hi = 1;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      const o = off(mid);
      if (Math.hypot(o[0], o[1]) > d) lo = mid; else hi = mid;
    }
    const c = (lo + hi) / 2;
    const o = off(c);
    let a = (Math.atan2(v[1], v[0]) - Math.atan2(o[1], o[0])) / RAD;
    a = ((a + 540) % 360) - 180;
    a = Math.max(-70, Math.min(70, a)) / sq(phi); // chain() scales the angle back by the squash
    return { a, psi, t1: TOUCH_CURL[0] * c, t2: TOUCH_CURL[1] * c, t3: TOUCH_CURL[2] * c };
  }

  // Two-segment IK for the thumb: base B, target T -> absolute segment angles (deg).
  // Solved in the palm plane (x unsquashed), so in a side view the thumb is foreshortened with the palm.
  function solveThumb(Tview, phi) {
    const T = [Tview[0] / sq(phi), Tview[1]];
    let B = [THUMB.base[0], THUMB.base[1]];
    const { l1, l2 } = THUMB;
    let dx = T[0] - B[0], dy = T[1] - B[1], d = Math.hypot(dx, dy);
    // Out of reach: the thumb's root (CMC joint) can slide a little toward the target.
    const reach = l1 + l2 - 1;
    if (d > reach) {
      const s = Math.min(d - reach, 22) / d;
      B = [B[0] + dx * s, B[1] + dy * s];
      dx = T[0] - B[0]; dy = T[1] - B[1]; d = Math.hypot(dx, dy);
    }
    d = Math.max(Math.abs(l1 - l2) + 1, Math.min(d, reach));
    const base = Math.atan2(dy, dx);
    const bend = Math.acos(Math.max(-1, Math.min(1, (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d))));
    // Two possible elbows; the thumb's knuckle bulges outward/downward, away from the palm.
    const pick = [base + bend, base - bend].map((a1) => {
      const J = [B[0] + l1 * Math.cos(a1), B[1] + l1 * Math.sin(a1)];
      const a2 = Math.atan2(B[1] + d * Math.sin(base) - J[1], B[0] + d * Math.cos(base) - J[0]);
      return { a1, a2, score: -J[0] + 0.6 * J[1] };
    }).sort((p, q) => q.score - p.score)[0];
    return { bx: B[0], by: B[1], a1: pick.a1 / RAD, a2: pick.a2 / RAD };
  }

  function thumbPoints(p) {
    const B = [p.th_bx, p.th_by];
    const J = [B[0] + THUMB.l1 * Math.cos(p.th_a1 * RAD), B[1] + THUMB.l1 * Math.sin(p.th_a1 * RAD)];
    const T = [J[0] + THUMB.l2 * Math.cos(p.th_a2 * RAD), J[1] + THUMB.l2 * Math.sin(p.th_a2 * RAD)];
    const m = sq(p.phi);
    return [B, J, T].map((q) => [q[0] * m, q[1]]);
  }

  /* ============================================================= pose -> numbers */

  const DIR_ROT = { up: 0, down: 180, in: 90, out: -90, forward: 0 }; // for R (left side); L is negated
  const FACE_PHI = { front: 0, side: 90, back: 180 };

  // One hand object from the pose data -> flat numeric params (placement filled in later by layout()).
  function handParams(h, side) {
    h = h || {};
    const dir = DIR_ROT[h.dir] != null ? h.dir : "up";
    const phi = FACE_PHI[h.face] != null ? FACE_PHI[h.face] : 0;
    const horizontal = dir === "in" || dir === "out";
    // R sits on the viewer's left with its thumb toward the centre; drawing it means mirroring the
    // local frame (whose thumb is on -x). Hands held horizontally keep the thumb on top
    // (side view: palm facing up), as in nearly all of the book's two-hand photos.
    let mir = side === "R" ? -1 : 1;
    if (horizontal) mir = -mir;
    const p = {
      x: 0, y: 0, scale: 1, op: 1, mir, phi,
      rot: side === "R" ? DIR_ROT[dir] : -DIR_ROT[dir],
      fore: dir === "forward" ? 0.62 : 1
    };

    // Normalise finger states against what the thumb touches.
    const thumb = h.thumb || "relaxed";
    const targets = typeof thumb === "object" && Array.isArray(thumb.to)
      ? thumb.to.filter((f) => FINGERS.includes(f)) : [];
    const at = typeof thumb === "object" ? thumb.at || "tip" : null;
    const st = {};
    FINGERS.forEach((f) => {
      let s = h[f] || "ext";
      if (targets.includes(f) && at === "tip") s = "touch";
      if (targets.includes(f) && at === "nail" && (s === "ext" || s === "touch")) s = "pressed";
      if (s === "touch" && !targets.length) s = "bent";
      if (!CURL[s] && s !== "touch") s = "ext";
      st[f] = s;
    });
    const splay = h.spread === true ? SPLAY.spread : h.relaxed ? SPLAY.relaxed : SPLAY.together;
    FINGERS.forEach((f, i) => {
      const c = st[f] === "touch" ? CURL.bent : CURL[st[f]];
      Object.assign(p, { [f + "_a"]: splay[i], [f + "_psi"]: 0, [f + "_t1"]: c[0], [f + "_t2"]: c[1], [f + "_t3"]: c[2] });
    });
    const fingerOf = (f) => ({ a: p[f + "_a"], psi: p[f + "_psi"], t1: p[f + "_t1"], t2: p[f + "_t2"], t3: p[f + "_t3"] });
    const setFinger = (f, v) => Object.assign(p, { [f + "_a"]: v.a, [f + "_psi"]: v.psi, [f + "_t1"]: v.t1, [f + "_t2"]: v.t2, [f + "_t3"]: v.t3 });
    const m = sq(phi);
    const B = [THUMB.base[0] * m, THUMB.base[1]];
    const touching = FINGERS.filter((f) => st[f] === "touch");

    let T;
    if (targets.length && at === "tip") {
      // Meeting point between the knuckles of the target fingers and the thumb's root; fingertips
      // are placed side by side around it, then the thumb aims at where they actually ended up.
      const C = avg(targets.map((f) => [MCP[f][0] * m, MCP[f][1]]));
      const pull = targets.includes("index") ? 0.42 : 0.36;
      const M = [C[0] + (B[0] - C[0]) * pull - 12 * m, C[1] + (B[1] - C[1]) * pull];
      const tips = touching.map((f, i) => {
        const shift = (i - (touching.length - 1) / 2) * 9;
        setFinger(f, solveTouch(f, [M[0] + shift, M[1] - shift * 0.3], phi));
        return chain(f, fingerOf(f), phi)[3];
      });
      T = avg(tips.length ? tips : [M]);
    } else if (targets.length) {
      T = avg(targets.map((f) => {
        const pts = chain(f, fingerOf(f), phi);
        if (at === "base") return [pts[0][0] + 2, pts[0][1] + 10];
        if (at === "middle") return pts[1];
        // nail: on a curled finger the visible part is the folded middle phalanx
        return st[f] === "curled" || st[f] === "pressed" ? lerp(pts[2], pts[3], 0.3) : lerp(pts[2], pts[3], 0.6);
      }));
      touching.forEach((f) => setFinger(f, solveTouch(f, T, phi)));
    } else {
      const key = typeof thumb === "string" && THUMB_AT[thumb] ? thumb : "relaxed";
      T = [THUMB_AT[key][0] * m, THUMB_AT[key][1]];
    }
    const th = solveThumb(T, phi);
    Object.assign(p, { th_bx: th.bx, th_by: th.by, th_a1: th.a1, th_a2: th.a2 });
    return p;
  }

  const REST_HAND = { dir: "up", face: "front", thumb: "relaxed", relaxed: true,
    index: "relaxed", middle: "relaxed", ring: "relaxed", little: "relaxed" };

  // Whole pose -> { R, L, meta }. Missing pose -> neutral open hands.
  function buildTarget(pose, mudra) {
    if (!pose) {
      const single = mudra && mudra.hands === "single";
      pose = { layout: single ? "single" : "pair", R: { ...REST_HAND, thumb: "side", relaxed: false, index: "ext", middle: "ext", ring: "ext", little: "ext" }, L: null, fit: "approx", missing: true };
    }
    const layoutName = pose.layout || "single";
    const rh = pose.R || pose.L;
    const lh = layoutName === "single" ? null : (pose.L || pose.R);
    const R = handParams(rh, "R");
    const L = handParams(lh || REST_HAND, "L");
    const meta = { layout: layoutName, front: "R", interlock: layoutName === "interlocked" };
    layout(R, L, meta, false);
    return { R, L, meta };
  }

  function restTarget() {
    const R = handParams(REST_HAND, "R");
    const L = handParams(REST_HAND, "L");
    const meta = { layout: "rest", front: "R", interlock: false };
    layout(R, L, meta, true);
    return { R, L, meta };
  }

  /* ================================================================== layout
   * Place both hands (x, y, extra rotation), then measure their real outlines and fit the
   * group into the free zone of the canvas (left part when the illustration card is showing).
   */
  function layout(R, L, meta, rest) {
    const kind = meta.layout;
    const horiz = (p) => Math.abs(Math.sin(p.rot * RAD)) > 0.7;
    if (rest) {
      R.x = -125; L.x = 125; R.rot -= 8; L.rot += 8;
    } else if (kind === "single") {
      L.op = 0; // the left hand fades away below
    } else if (kind === "pair" || kind === "apart") {
      R.x = -118; L.x = 118;
    } else if (kind === "crossed") {
      // wrists cross at the centre, hands open outward; R in front
      R.x = 26; L.x = -26; R.rot -= 26; L.rot += 26; R.y = -6;
    } else {
      // touching / interlocked / stacked: bring the facing edges together
      const h = horiz(R) || horiz(L);
      let overlap = 6;
      if (kind === "interlocked") overlap = h ? 52 : 26;
      if (kind === "stacked") overlap = h ? 70 : 0;
      const bR = bbox(R), bL = bbox(L);
      if (kind === "stacked" && !h) {
        R.y = -60; // one hand above the other
      } else {
        R.x = -bR.maxX + overlap / 2;
        L.x = -bL.minX - overlap / 2;
      }
      if (kind === "stacked" && h) R.y = -16;
      if (kind === "interlocked" && h) L.y = 10; // offset so the fingers fall between each other
    }

    // Fit into the zone.
    const zone = meta.zone || stageZone(rest);
    const parts = [bbox(R)];
    if (L.op > 0) parts.push(bbox(L));
    const u = parts.reduce((a, b) => ({ minX: Math.min(a.minX, b.minX), maxX: Math.max(a.maxX, b.maxX), minY: Math.min(a.minY, b.minY), maxY: Math.max(a.maxY, b.maxY) }));
    const maxScale = rest ? 1.05 : kind === "single" ? 1.4 : 1.2;
    const k = Math.min(maxScale, (zone.x1 - zone.x0) / (u.maxX - u.minX), (zone.y1 - zone.y0) / (u.maxY - u.minY));
    const cx = (u.minX + u.maxX) / 2, cy = (u.minY + u.maxY) / 2;
    const zx = (zone.x0 + zone.x1) / 2, zy = (zone.y0 + zone.y1) / 2;
    [R, L].forEach((p) => {
      p.x = zx + (p.x - cx) * k;
      p.y = zy + (p.y - cy) * k;
      p.scale *= k;
    });
    if (kind === "single") { L.x = R.x + 40; L.y = R.y + 120; } // hidden hand drifts off low
  }

  // Free drawing area in viewBox units. With a mudra shown, the illustration card takes the right side.
  function stageZone(rest) {
    let right = VIEW_W - 14;
    if (!rest && els && els.figure && els.canvas.offsetWidth) {
      right = VIEW_W * (1 - els.figure.offsetWidth / els.canvas.offsetWidth) - 14;
    }
    return { x0: 14, x1: right, y0: 22, y1: VIEW_H - 18 };
  }

  // Screen-space bounding box of one hand (palm without forearm, fingers, thumb), incl. stroke widths.
  function bbox(p) {
    const pts = handOutlinePoints(p).map((q) => toScreen(p, q));
    const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
    const pad = 11 * p.scale;
    return { minX: Math.min(...xs) - pad, maxX: Math.max(...xs) + pad, minY: Math.min(...ys) - pad, maxY: Math.max(...ys) + pad };
  }

  function handOutlinePoints(p) {
    const pts = palmPoints(p.phi).slice(0, 8).concat([[0, 50]]);
    FINGERS.forEach((f) => pts.push(...chain(f, fingerParams(p, f), p.phi)));
    pts.push(...thumbPoints(p));
    return pts.map((q) => finalLocal(p, q));
  }

  /* ================================================================= drawing */

  const sgn = (p) => (Math.cos(p.phi * RAD) >= -1e-6 ? 1 : -1); // back view flips the thumb side
  const finalLocal = (p, q) => [q[0] * sgn(p), q[1] * p.fore];
  function toScreen(p, q) {
    const x = q[0] * p.mir * p.scale, y = q[1] * p.scale;
    const c = Math.cos(p.rot * RAD), s = Math.sin(p.rot * RAD);
    return [p.x + x * c - y * s, p.y + x * s + y * c];
  }
  const fingerParams = (p, f) => ({ a: p[f + "_a"], psi: p[f + "_psi"], t1: p[f + "_t1"], t2: p[f + "_t2"], t3: p[f + "_t3"] });

  // Palm + forearm outline (local, x squashed). First 8 points = the hand itself (for measuring).
  function palmPoints(phi) {
    const m = sq(phi);
    return [
      [-44, -96], [-12, -108], [14, -104], [40, -90], [46, -56], [38, -18], [30, 2], [-29, 2],
      [-38, -14], [-48, -46], [-47, -76]
    ].map(([x, y]) => [x * m, y]);
  }

  const f1 = (n) => Math.round(n * 10) / 10;
  const pt = (q) => `${f1(q[0])} ${f1(q[1])}`;
  const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  const avg = (ps) => [ps.reduce((s, q) => s + q[0], 0) / ps.length, ps.reduce((s, q) => s + q[1], 0) / ps.length];

  // Smooth closed path through points (Catmull-Rom -> cubic Bézier).
  function smoothPath(ps) {
    const n = ps.length;
    let d = `M${pt(ps[0])}`;
    for (let i = 0; i < n; i++) {
      const p0 = ps[(i - 1 + n) % n], p1 = ps[i], p2 = ps[(i + 1) % n], p3 = ps[(i + 2) % n];
      const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
      const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
      d += `C${pt(c1)} ${pt(c2)} ${pt(p2)}`;
    }
    return d + "Z";
  }

  // A finger or thumb as a tube: saffron outline stroke under a skin-coloured stroke.
  function tube(ps, w, opts) {
    const d = "M" + ps.map(pt).join("L");
    let s = `<path class="r-edge" d="${d}" stroke-width="${w + 3}"/><path class="r-skin${opts.folded ? " is-folded" : ""}" d="${d}" stroke-width="${w}"/>`;
    const n = ps.length;
    const tip = ps[n - 1], prev = ps[n - 2];
    const segLen = Math.hypot(tip[0] - prev[0], tip[1] - prev[1]);
    if (opts.back) {
      // nail near the tip (only if the last segment is visible), knuckle lines
      if (segLen > 6) {
        const c = lerp(prev, tip, 0.72), ang = Math.atan2(tip[1] - prev[1], tip[0] - prev[0]) / RAD;
        s += `<ellipse class="r-nail" cx="${f1(c[0])}" cy="${f1(c[1])}" rx="${f1(Math.min(segLen * 0.32, 7))}" ry="${f1(w * 0.3)}" transform="rotate(${f1(ang)} ${f1(c[0])} ${f1(c[1])})"/>`;
      }
      for (let i = 1; i < n - 1; i++) s += crease(ps, i, w, "r-knuckle");
    } else {
      // henna on the fingertip + a dot, and creases at the joints
      const from = segLen > 4 ? lerp(prev, tip, 0.45) : tip;
      s += `<path class="r-henna" d="M${pt(from)}L${pt(tip)}" stroke-width="${w - 1}"/>`;
      for (let i = 1; i < n - 1; i++) s += crease(ps, i, w, "r-crease");
      if (n === 4 && Math.hypot(ps[2][0] - ps[1][0], ps[2][1] - ps[1][1]) > 10) {
        const dot = lerp(ps[1], ps[2], 0.5);
        s += `<circle class="r-dot" cx="${f1(dot[0])}" cy="${f1(dot[1])}" r="1.6"/>`;
      }
    }
    return s;
  }

  // Short line across the tube at joint i (perpendicular to the average direction).
  function crease(ps, i, w, cls) {
    const a = ps[i - 1], b = ps[i + 1];
    let dx = b[0] - a[0], dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    if (len < 4) return "";
    dx /= len; dy /= len;
    const h = w * 0.32;
    const c = ps[i];
    return `<path class="${cls}" d="M${pt([c[0] - dy * h, c[1] + dx * h])}L${pt([c[0] + dy * h, c[1] - dx * h])}"/>`;
  }

  // All drawable parts of one hand, each with a z value (parts of both hands are sorted together).
  function handParts(p, side, meta) {
    if (p.op <= 0.01) return [];
    const back = Math.cos(p.phi * RAD) < 0;
    const frontness = Math.max(0, Math.cos(p.phi * RAD)); // henna medallion fades when turning
    const L = (q) => finalLocal(p, q);
    const wrap = (inner) => `<g transform="translate(${f1(p.x)} ${f1(p.y)}) rotate(${f1(p.rot)}) scale(${f1(p.mir * p.scale * 1000) / 1000} ${f1(p.scale * 1000) / 1000})" opacity="${f1(p.op * 100) / 100}">${inner}</g>`;
    const base = meta.front === side ? 100 : 0;
    const parts = [];

    // palm + forearm
    const m = sq(p.phi);
    const palm = palmPoints(p.phi).map(L);
    const arm = [[30 * m, 2], [33 * m, 56], [-33 * m, 56], [-29 * m, 2]].map(L);
    let ps = `<path class="r-palm" d="${smoothPath(palm)}"/>`;
    ps += `<path class="r-palm" d="M${arm.map(pt).join("L")}Z"/>`;
    ps += `<path class="r-palm-fill" d="${smoothPath(palm)}"/>`;
    const bangle = (y) => { const a = L([-33 * m, y]), b = L([33 * m, y]), c = L([0, y + 8]); return `M${pt(a)}Q${pt(c)} ${pt(b)}`; };
    ps += `<path class="r-bangle" d="${bangle(30)} ${bangle(42)}"/>`;
    if (!back) {
      ps += `<path class="r-crease" d="M${pt(L([-36 * m, -70]))}C${pt(L([-10 * m, -78]))} ${pt(L([16 * m, -74]))} ${pt(L([40 * m, -82]))}M${pt(L([-34 * m, -52]))}C${pt(L([-18 * m, -40]))} ${pt(L([-12 * m, -24]))} ${pt(L([-10 * m, -8]))}"/>`;
      if (frontness > 0.3) {
        const c = L([6 * m, -44]);
        ps += `<g class="r-medallion" opacity="${f1(frontness)}" transform="translate(${pt(c)}) scale(${f1(m * sgn(p) * 100) / 100} ${p.fore})">
          <circle r="13" class="r-henna-line"/><circle r="19" class="r-henna-dots"/><circle r="4" class="r-henna-fill"/>
          <path class="r-henna-line" d="M0 -13Q5 -7 0 0Q-5 -7 0 -13M13 0Q7 5 0 0Q7 -5 13 0M0 13Q-5 7 0 0Q5 7 0 13M-13 0Q-7 -5 0 0Q-7 5 -13 0"/></g>`;
      }
    } else {
      // back of the hand: knuckle bumps + a small henna vine
      ps += `<path class="r-knuckle" d="M${pt(L([-36 * m, -92]))}Q${pt(L([0, -102]))} ${pt(L([36 * m, -86]))}"/>`;
      ps += `<path class="r-henna-dots" d="M${pt(L([0, -4]))}C${pt(L([-10 * m, -30]))} ${pt(L([10 * m, -60]))} ${pt(L([-2 * m, -88]))}"/>`;
    }
    parts.push({ z: base + 20 + (side === "R" ? 1 : 0), s: wrap(ps) });

    // fingers: those folded toward the viewer are drawn over the palm, others under it
    FINGERS.forEach((f, i) => {
      const fp = fingerParams(p, f);
      const raw = chain(f, fp, p.phi);
      const folded = raw[3][1] > MCP[f][1] - LEN[f][0] * 0.55;
      const over = folded !== back; // front view: folds come toward us; back view: they go behind
      let z = base + (over ? 30 : 10) + i;
      if (meta.interlock) z = 50 + (((i % 2 === 0) === (side === "R")) ? 10 : 0) + i * 0.1;
      parts.push({ z, s: wrap(tube(raw.map(L), WID[f] * (0.85 + 0.15 * m), { back, folded: folded && !back })) });
    });

    // thumb
    const tz = meta.interlock ? 80 : base + (back ? 5 : 40);
    parts.push({ z: tz, s: wrap(tube(thumbPoints(p).map(L), THUMB.w, { back })) });
    return parts;
  }

  /* =============================================================== animation */

  let cur = null;   // params currently drawn
  let anim = null;  // { from, to, t0, done }
  let rafId = 0;

  const ANGLE_KEYS = /_a1$|_a2$/;
  function stagger(key) {
    const f = FINGERS.findIndex((n) => key.startsWith(n + "_"));
    if (f >= 0) return 90 + f * 70;
    if (key.startsWith("th_")) return 40;
    return 0;
  }
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

  function mix(a, b, key, t) {
    if (ANGLE_KEYS.test(key)) {
      let d = ((b - a + 540) % 360) - 180; // shortest way round
      return a + d * t;
    }
    return a + (b - a) * t;
  }

  function draw() {
    if (!cur) return;
    const parts = [...handParts(cur.R, "R", cur.meta), ...handParts(cur.L, "L", cur.meta)];
    parts.sort((a, b) => a.z - b.z);
    els.rig.innerHTML = parts.map((q) => q.s).join("");
  }

  const DURATION = 900;
  // Animate the rig to `target`. Resolves true when it arrives, false if retargeted first.
  function animateTo(target) {
    if (anim) anim.done(false);
    cancelAnimationFrame(rafId);
    if (!cur || reducedMotion()) {
      cur = target;
      draw();
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      anim = { from: JSON.parse(JSON.stringify(cur)), to: target, t0: performance.now(), done: resolve };
      cur.meta = target.meta;
      const tick = (now) => {
        if (!anim) return;
        const el = now - anim.t0;
        let finished = true;
        ["R", "L"].forEach((h) => {
          const from = anim.from[h], to = anim.to[h], out = cur[h];
          for (const key in to) {
            const t = Math.max(0, Math.min(1, (el - stagger(key)) / DURATION));
            if (t < 1) finished = false;
            out[key] = mix(from[key], to[key], key, ease(t));
          }
        });
        draw();
        if (finished) {
          const a = anim;
          anim = null;
          cur = JSON.parse(JSON.stringify(a.to));
          a.done(true);
        } else rafId = requestAnimationFrame(tick);
      };
      rafId = requestAnimationFrame(tick);
    });
  }

  /* --------------------------------------------------------------- utilities */

  function traditionIcon(t) {
    if (t === "dance") {
      // ghungroo — dancer's ankle bells
      return `<svg class="t-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M3 7c5 3.5 13 3.5 18 0"/><circle cx="6.5" cy="13" r="2.6"/><circle cx="12" cy="14.6" r="2.6"/><circle cx="17.5" cy="13" r="2.6"/><path d="M6.5 15.6v.8M12 17.2v.8M17.5 15.6v.8"/></svg>`;
    }
    // lotus — yoga
    return `<svg class="t-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 4c2.2 3.2 2.2 7.6 0 11.2-2.2-3.6-2.2-8 0-11.2Z"/><path d="M12 15.2C8.5 14.4 5 11.4 5 7.6c3.2.3 5.8 3.2 7 7.6Z"/><path d="M12 15.2c3.5-.8 7-3.8 7-7.6-3.2.3-5.8 3.2-7 7.6Z"/><path d="M3.5 15.5c3.5 3.4 13.5 3.4 17 0"/></svg>`;
  }

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  // Rangoli-like mandala: dotted rings + rotated petals. data-mandala = petal count.
  function drawMandala(svg) {
    const n = Number(svg.dataset.mandala) || 12;
    let petals = "";
    for (let i = 0; i < n; i++) {
      const a = (360 / n) * i;
      petals += `<path transform="rotate(${a})" d="M0 -40 C14 -56 12 -78 0 -92 C-12 -78 -14 -56 0 -40 Z"/>`;
      petals += `<circle transform="rotate(${a + 180 / n})" cx="0" cy="-62" r="2.2" class="m-dot"/>`;
    }
    svg.innerHTML = `
      <g class="mandala-rot">
        <circle r="97" class="m-dotted"/>
        <circle r="92" class="m-line"/>
        <g class="m-petals">${petals}</g>
        <circle r="38" class="m-line"/>
        <circle r="30" class="m-dotted"/>
        <circle r="6" class="m-dot"/>
      </g>`;
  }

  // Run one Web Animation and track it. Resolves when finished OR cancelled.
  function play(node, keyframes, opts) {
    if (!node) return Promise.resolve();
    const a = node.animate(keyframes, Object.assign({ duration: 600, easing: EASE, fill: "forwards" }, opts));
    running.push(a);
    return a.finished.catch(() => {});
  }

  // Freeze every tracked animation where it is (write the value to inline style), then drop it.
  function settle() {
    running.forEach((a) => {
      try { a.commitStyles(); } catch (e) { /* element not rendered (e.g. hidden) */ }
      a.cancel();
    });
    running = [];
  }

  // Preload the illustration off-screen; resolves true/false (loaded/missing). Never rejects.
  function preload(src) {
    return new Promise((resolve) => {
      if (!src) return resolve(false);
      const img = new Image();
      const timer = setTimeout(() => resolve(img.complete && img.naturalWidth > 0), 2500);
      img.onload = () => { clearTimeout(timer); resolve(true); };
      img.onerror = () => { clearTimeout(timer); resolve(false); };
      img.src = src;
    });
  }

  function showImage(m, ok) {
    els.img.alt = `${m.name} as photographed in the book`;
    if (ok) {
      els.img.src = m.image;
      els.img.hidden = false;
      els.placeholder.hidden = true;
    } else {
      // Missing image: stylized placeholder with the mudra's initial.
      els.img.removeAttribute("src");
      els.img.hidden = true;
      els.placeholder.hidden = false;
      els.placeholder.querySelector("span").textContent = (m.name || "?").charAt(0);
    }
    els.refCap.textContent = m.bookPage ? `From the book, p. ${m.bookPage}` : "From the book";
  }

  function showNote(pose) {
    let text = "";
    if (!pose) text = "Hand pose not yet drawn — see the illustration for the exact form";
    else if (pose.fit === "approx") text = "Simplified pose — the real gesture differs in detail";
    els.note.textContent = text;
    els.note.title = pose && pose.why ? pose.why : "";
    els.note.hidden = !text;
  }

  /* -------------------------------------------------------------- info card */

  const SECTIONS = [
    ["description", "Description"],
    ["technique", "Technique"],
    ["application", "Application"],
    ["benefits", "Benefits"],
    ["note", "Note"],
    ["caution", "Caution"]
  ];

  function fillCard(m) {
    const badges = $("#info-badges");
    badges.replaceChildren();
    (m.traditions || []).forEach((t) => {
      const b = el("span", `badge badge-${t}`);
      b.innerHTML = traditionIcon(t);
      b.append(t === "dance" ? "Dance" : "Yoga");
      badges.append(b);
    });
    if (m.hands) badges.append(el("span", "badge badge-hands", m.hands === "joint" ? "Both hands" : "Single hand"));

    $("#info-name").textContent = m.name;
    const alt = (m.altNames || []).length ? ` · also ${m.altNames.join(", ")}` : "";
    $("#info-english").textContent = (m.english || "") + alt;
    $("#info-function").textContent = m.function || "";

    const tidbit = $("#info-tidbit");
    tidbit.replaceChildren();
    if (m.tidbit) {
      tidbit.append(el("p", null, m.tidbit));
      if (m.bookPage) tidbit.append(el("cite", null, `p. ${m.bookPage}`));
    }
    tidbit.hidden = !m.tidbit;

    // Category + chakra chips. Clicking a category fires a "mudra:category" event
    // on document (detail: { name }) for the search/filter code to handle.
    const chips = $("#info-chips");
    chips.replaceChildren();
    (m.categories || []).forEach((c) => {
      const b = el("button", "chip chip-small", c);
      b.type = "button";
      b.dataset.category = c;
      b.title = `Show all mudras for ${c}`;
      chips.append(b);
    });
    (m.chakras || []).forEach((c) => chips.append(el("span", "chip chip-small chip-chakra", c)));
    chips.hidden = !chips.children.length;

    // Second illustration (a few mudras have one), shown small under the chips.
    const extra = $("#info-extra");
    extra.replaceChildren();
    (m.extraImages || []).forEach((src) => {
      const img = el("img");
      img.src = src;
      img.alt = `Another view of ${m.name}`;
      img.loading = "lazy";
      img.addEventListener("error", () => img.remove(), { once: true });
      extra.append(img);
    });
    if (extra.children.length) extra.append(el("figcaption", null, "Another view"));
    extra.hidden = !extra.children.length;

    const sections = $("#info-sections");
    sections.replaceChildren();
    SECTIONS.forEach(([key, label], i) => {
      const text = (m[key] || "").trim();
      if (!text) return;
      const d = el("details", "info-section");
      if (i === 0) d.open = true; // description open by default
      d.append(el("summary", null, label));
      text.split(/\n\s*\n/).forEach((para) => d.append(el("p", null, para.trim())));
      sections.append(d);
    });

    $("#info-cite").textContent = m.bookPage ? `Mudras of India, p. ${m.bookPage}` : "";
    els.handsSvg.setAttribute("aria-label", `Stylized hands forming ${m.name}`);
  }

  /* ---------------------------------------------------------------- states */

  function announce(m) {
    els.status.textContent = m ? `${m.name}${m.english ? ", " + m.english : ""}. ${m.function || ""}` : "Returned to the resting hands.";
  }

  function poseFor(m) {
    const all = window.POSES || {};
    return m && Object.prototype.hasOwnProperty.call(all, m.id) ? all[m.id] : null;
  }

  /* ------------------------------------------------------------- sequences */

  async function goTo(m) {
    if (!m) return false;
    init();
    const t = ++token;
    settle();
    const was = state;
    state = "busy";
    current = m;
    els.canvas.classList.add("is-active");
    const imageReady = preload(m.image);
    const pose = poseFor(m);

    if (reducedMotion()) {
      const ok = await imageReady;
      if (t !== token) return false;
      showImage(m, ok);
      fillCard(m);
      showNote(pose);
      els.intro.hidden = true;
      els.card.hidden = false;
      els.figure.classList.add("is-shown");
      [els.card, els.figure, els.note].forEach((n) => n.removeAttribute("style"));
      els.figure.style.opacity = "1";
      await animateTo(buildTarget(pose, m));
      state = "shown";
      announce(m);
      return true;
    }

    // Old content out (quick), unless we start from rest.
    if (was !== "rest") {
      await Promise.all([
        play(els.card, [{ opacity: 0, transform: "translateY(10px)" }], { duration: 200 }),
        play(els.figure, [{ opacity: 0, transform: "translateY(-50%) scale(.96)" }], { duration: 200 }),
        play(els.note, [{ opacity: 0 }], { duration: 150 })
      ]);
      if (t !== token) return false;
      settle();
    } else {
      await play(els.intro, [{ opacity: 0, transform: "translateY(-8px)" }], { duration: 220 });
      if (t !== token) return false;
      settle();
    }
    els.intro.hidden = true;
    els.figure.classList.add("is-shown"); // takes its place in the layout (still transparent)
    fillCard(m);
    showNote(pose);

    // 1. Hands move into the mudra (the target is laid out around the illustration card).
    const moved = animateTo(buildTarget(pose, m));

    // 2. While they move: the book illustration and the info card come in.
    const ok = await imageReady;
    if (t !== token) return false;
    showImage(m, ok);
    els.card.hidden = false;
    await Promise.all([
      moved,
      play(els.figure, [
        { opacity: 0, transform: "translateY(-50%) translateX(16px)" },
        { opacity: 1, transform: "translateY(-50%)" }
      ], { duration: 600, delay: 350 }),
      play(els.note, [{ opacity: 0 }, { opacity: 1 }], { duration: 500, delay: 900 }),
      play(els.card, [
        { opacity: 0, transform: "translateY(24px)" },
        { opacity: 1, transform: "none" }
      ], { duration: 480, delay: 250 })
    ]);
    if (t !== token) return false;
    settle();
    state = "shown";
    announce(m);
    return true;
  }

  async function reset() {
    init();
    const t = ++token;
    settle();
    const was = state;
    state = "busy";
    current = null;

    const finish = () => {
      [els.card, els.figure, els.intro, els.note].forEach((n) => n.removeAttribute("style"));
      els.card.hidden = true;
      els.note.hidden = true;
      els.figure.classList.remove("is-shown");
      els.intro.hidden = false;
      els.canvas.classList.remove("is-active");
      els.handsSvg.setAttribute("aria-label", "Two stylized hands at rest");
    };

    if (reducedMotion() || was === "rest") {
      finish();
      await animateTo(restTarget());
      state = "rest";
      if (was !== "rest") announce(null);
      return true;
    }

    await Promise.all([
      play(els.card, [{ opacity: 0, transform: "translateY(16px)" }], { duration: 300 }),
      play(els.figure, [{ opacity: 0, transform: "translateY(-50%) translateX(16px)" }], { duration: 300 }),
      play(els.note, [{ opacity: 0 }], { duration: 200 })
    ]);
    if (t !== token) return false;
    settle();
    finish();
    els.intro.style.opacity = "0";
    await Promise.all([
      animateTo(restTarget()),
      play(els.intro, [{ opacity: 0 }, { opacity: 1 }], { duration: 500, delay: 400 })
    ]);
    if (t !== token) return false;
    settle();
    els.intro.removeAttribute("style");
    state = "rest";
    announce(null);
    return true;
  }

  /* ------------------------------------------------------------------ init */

  function init() {
    if (els) return;
    const handsSvg = $("#stage-hands");
    handsSvg.setAttribute("viewBox", `0 0 ${VIEW_W} ${VIEW_H}`);
    handsSvg.innerHTML = `
      <defs>
        <linearGradient id="palm-grad" gradientUnits="userSpaceOnUse" x1="0" y1="-110" x2="0" y2="80">
          <stop offset="0" stop-color="var(--hand-top)"/>
          <stop offset="1" stop-color="var(--hand-bottom)"/>
        </linearGradient>
      </defs>
      <g class="rig"></g>`;
    document.querySelectorAll("svg[data-mandala]").forEach(drawMandala);
    els = {
      canvas: $("#stage-canvas"),
      handsSvg,
      rig: handsSvg.querySelector(".rig"),
      figure: $("#stage-figure"),
      img: $("#stage-img"),
      refCap: $("#stage-ref-cap"),
      placeholder: $("#stage-placeholder"),
      note: $("#stage-note"),
      card: $("#info-card"),
      intro: $("#stage-intro"),
      status: $("#stage-status")
    };
    cur = restTarget();
    draw();
    $("#info-back").addEventListener("click", () => reset());
    // The free zone beside the illustration depends on the canvas width: re-fit after a resize.
    let resizeTimer = 0;
    window.addEventListener("resize", () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (anim) return;
        cur = state === "shown" && current ? buildTarget(poseFor(current), current) : state === "rest" ? restTarget() : cur;
        draw();
      }, 150);
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();

  // Public build: SVG markup of a mudra's final pose (used for gallery thumbnails).
  function poseMarkup(m) {
    const t = buildTarget(poseFor(m), m);
    return [...handParts(t.R, "R", t.meta), ...handParts(t.L, "L", t.meta)]
      .sort((p, q) => p.z - q.z).map((p) => p.s).join("");
  }

  window.Stage = {
    poseMarkup,
    goTo,
    reset,
    traditionIcon,
    get current() { return current; },
    get state() { return state; }
  };
})();
