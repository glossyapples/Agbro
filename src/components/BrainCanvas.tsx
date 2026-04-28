'use client';

// Animated brain hero for /brain. Loads the brain PNG as the base
// layer, samples its alpha channel to find pixels that ARE the
// brain, then renders an overlay <canvas> drawing animated synapses
// + occasional firing arcs only at those positions. Result: the
// brain illustration appears to be lit up from within by neural
// activity that scales with how much the agent has actually
// learned (entryCount) and intensifies right after a wake
// (lastRunAt).
//
// Performance:
//   - rAF-driven loop, capped at ~24fps to be battery-kind
//   - paused via Page Visibility API when the tab isn't visible
//   - respects prefers-reduced-motion (renders a static base image)
//   - canvas resolution matches device DPR up to a sane cap
//
// The math (synapseMultiplier × (idle + activityBurst), arc rate,
// active count) lives in src/lib/brain/animation-math.ts and is
// covered by unit tests there.

import { useEffect, useRef, useState } from 'react';
import {
  brainIntensity,
  activeSynapseCount,
} from '@/lib/brain/animation-math';

export type BrainCanvasProps = {
  // Total non-superseded brain entries. Drives the synapse density.
  entryCount: number;
  // ISO string of the most recent agent run start. Drives the
  // post-wake activity burst. null when there's never been a run.
  lastRunAtISO: string | null;
  // Currently-selected brain category (from /brain?category=X). When
  // set, synapses anchored on that region of the brain (per the
  // regions mask at /brain/regions.png) smoothly light up — brighter
  // core, slight hue shift toward the region's signature colour.
  // Falloff is a per-pixel mask sample, so region shapes follow the
  // brain's anatomy (frontal lobe, cerebellum, etc.) instead of
  // approximating with ellipses. Smooth crossfade over ~500-700ms
  // so transitions never feel poppy.
  selectedCategory?: string | null;
  // Visual size hint. The canvas matches this CSS dimension; the
  // actual pixel buffer scales with devicePixelRatio (capped at 2).
  // Default tuned so the BrainCallouts grid sits above the fold on
  // typical iPhone-class viewports (~667-844 px logical height).
  heightPx?: number;
  // Source PNG path. Default works once the user uploads to
  // public/brain/brain.png. Can be overridden for testing variants.
  imageSrc?: string;
  // Region mask PNG path. Each non-transparent pixel is coloured
  // according to which category that part of the brain belongs to.
  // Sampled per synapse to find each one's region.
  regionMaskSrc?: string;
};

// Maps mask hue → category + display hue for the boost. The mask
// PNG was hand-painted; these match the colours the artist used
// (verified by sampling the file). Tolerance ±25° handles edge
// anti-aliasing.
type CategoryColour = {
  category: string;
  // Hue range in HSL on the mask (used for matching).
  maskHueMin: number;
  maskHueMax: number;
  // Hue used for the synapse-light-up effect when this category is
  // selected. Same colour the mask uses, baked into a constant
  // because the synapse render reads HSL directly.
  glowHue: number;
};
const CATEGORY_COLOURS: CategoryColour[] = [
  // Hue ranges verified against actual mask via Pillow sampling
  // (script in scripts/clean-pngs.py adjacent debug session). Each
  // range is centred on the painted hue with ~±20° margin to absorb
  // anti-aliased edge pixels without bleeding into neighbouring
  // categories.
  // Green → Principle (mask center ~122°)
  { category: 'principle', maskHueMin: 95, maskHueMax: 145, glowHue: 130 },
  // Blue/cyan → Playbook (mask center ~215°)
  { category: 'playbook', maskHueMin: 195, maskHueMax: 240, glowHue: 215 },
  // Orange → Reference (mask center ~29°)
  { category: 'reference', maskHueMin: 12, maskHueMax: 55, glowHue: 32 },
  // Teal → Memory (mask center ~179°)
  { category: 'memory', maskHueMin: 150, maskHueMax: 192, glowHue: 175 },
  // Purple/violet → Hypothesis (mask center ~269°)
  { category: 'hypothesis', maskHueMin: 250, maskHueMax: 310, glowHue: 280 },
];

// rgb→hsl helper (returns hue in degrees, sat + lightness in [0,1]).
// Inlined here so we don't pull a colour library for one operation.
function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) * 60;
  else if (max === gn) h = ((bn - rn) / d + 2) * 60;
  else h = ((rn - gn) / d + 4) * 60;
  return { h, s, l };
}

// Classify an RGBA pixel from the regions mask into a category
// string, or null if the pixel is background / unknown. Saturation
// floor weeds out edge-anti-aliasing artifacts that have low
// chroma but happen to fall in a hue range.
function pixelToCategory(r: number, g: number, b: number, a: number): string | null {
  if (a < 80) return null;
  const { h, s } = rgbToHsl(r, g, b);
  if (s < 0.18) return null;
  for (const c of CATEGORY_COLOURS) {
    // Hue ranges are degrees; handle the wrap-around case for
    // categories whose range crosses 0/360 (none currently, but
    // future-proof).
    if (c.maskHueMin <= c.maskHueMax) {
      if (h >= c.maskHueMin && h <= c.maskHueMax) return c.category;
    } else {
      if (h >= c.maskHueMin || h <= c.maskHueMax) return c.category;
    }
  }
  return null;
}

// Tiny seedable Perlin-ish noise. Not a full Perlin implementation —
// we just need smooth pseudo-random drift to make synapses "breathe."
// Hash-based gradient noise is plenty.
function noise2(x: number, y: number): number {
  // Simple hash → [-1, 1] interpolated bilinearly between integer
  // grid points. Smooth enough for our "subtle drift" use case.
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  function h(ix: number, iy: number) {
    let n = ix * 374761393 + iy * 668265263;
    n = (n ^ (n >> 13)) >>> 0;
    n = (n * 1274126177) >>> 0;
    return ((n & 0xffff) / 0x8000) - 1;
  }
  const aa = h(xi, yi);
  const ab = h(xi, yi + 1);
  const ba = h(xi + 1, yi);
  const bb = h(xi + 1, yi + 1);
  return (
    aa * (1 - u) * (1 - v) +
    ba * u * (1 - v) +
    ab * (1 - u) * v +
    bb * u * v
  );
}

// One synapse's evolving state. Recycled in-place when its life ends
// to avoid GC churn over hours of animation.
type Synapse = {
  // Anchor pixel (immutable for the synapse's life). Picked from the
  // brain's alpha mask so it always sits on the brain surface.
  ax: number;
  ay: number;
  // Lifecycle: born at `birthMs`, dies at `birthMs + lifeMs`.
  birthMs: number;
  lifeMs: number;
  // Color hue offset (small variance around the brand palette).
  hueShift: number;
  // Radius multiplier (small variance per synapse so they don't all
  // look identical).
  rScale: number;
  // Which category region this synapse falls in (sampled from the
  // regions mask at spawn time). null if the synapse spawned outside
  // any region (e.g. on a part of the brain not coloured in the
  // mask). When the matching category is selected, this synapse
  // gets a brightness + hue boost.
  region: string | null;
};

const TARGET_FPS = 24;
const MIN_FRAME_MS = 1000 / TARGET_FPS;
const MAX_DPR = 2;

export function BrainCanvas({
  entryCount,
  lastRunAtISO,
  selectedCategory = null,
  heightPx = 220,
  imageSrc = '/brain/brain.png',
  regionMaskSrc = '/brain/regions.png',
}: BrainCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [imgLoaded, setImgLoaded] = useState(false);
  const [imgError, setImgError] = useState<string | null>(null);
  // Reduced-motion preference. If true we render a static base image
  // and skip the canvas loop entirely.
  const reducedMotionRef = useRef(false);

  // Live reference to the current props the animation tick needs to
  // read. Updated via a separate useEffect on prop change so the main
  // animation effect can stay mounted for the component's lifetime
  // without restarting on every navigation. Pre-fix the effect deps
  // included a freshly-constructed `new Date(lastRunAtISO)` which
  // changed identity every render → effect re-ran every render →
  // dozens of concurrent rAF loops piling up on the same canvas. The
  // user-visible symptom was the animation appearing "really fast"
  // after navigating between strategy / brain categories. Loops
  // eventually self-cleaned when GC ran or a deeper unmount fired.
  const propsRef = useRef<{
    entryCount: number;
    lastRunAt: Date | null;
    selectedCategory: string | null;
  }>({
    entryCount,
    lastRunAt: lastRunAtISO ? new Date(lastRunAtISO) : null,
    selectedCategory,
  });
  useEffect(() => {
    propsRef.current = {
      entryCount,
      lastRunAt: lastRunAtISO ? new Date(lastRunAtISO) : null,
      selectedCategory,
    };
  }, [entryCount, lastRunAtISO, selectedCategory]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    reducedMotionRef.current =
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  }, []);
  const lastRunAt = lastRunAtISO ? new Date(lastRunAtISO) : null;

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    if (reducedMotionRef.current) return;

    // Per-effect "alive" flag (NOT a shared ref). Each effect run gets
    // its own closure-local flag, so even if a stray rAF callback from
    // a stale effect fires after cleanup, it sees its OWN alive=false
    // and exits — no chance of two loops drawing on the same canvas.
    let alive = true;
    let frameHandle = 0;
    let lastFrameMs = 0;
    // Simulation clock. Advances by AT MOST one nominal frame's
    // worth of time per real frame. Decoupling the simulation from
    // wall-clock fixes the "synapses pop on scroll" bug: mobile
    // Safari pauses rAF during scroll, then fires queued frames in
    // a burst when scroll stops. With wall-clock time, that burst
    // would advance every synapse's lifecycle by hundreds of ms in
    // one tick — visible as instant "pops" through fade-in/fade-out.
    // Capping the per-tick delta means the simulation just looks
    // like it skipped a few frames (smooth) instead of leaping.
    let simTime = 0;
    const MAX_SIM_DELTA_MS = MIN_FRAME_MS * 2;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Load the brain PNG into an offscreen canvas to sample its
    // alpha channel. Synapse anchor positions are picked from
    // pixels with alpha > threshold — guarantees they sit on the
    // brain, not in empty corners.
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = imageSrc;

    // Region mask. Loaded in parallel with the brain image. Sampled
    // at sample time to label each candidate synapse position with
    // the category region it falls in. A separate Image so the two
    // load independently — animation can start as soon as the
    // brain loads; mask binding happens once the mask resolves
    // (synapses spawned before then carry region=null and just
    // never light up, which is acceptable visually for the brief
    // load window).
    const maskImg = new Image();
    maskImg.crossOrigin = 'anonymous';
    maskImg.src = regionMaskSrc;
    let maskLoaded = false;

    let validPositions: Array<{ x: number; y: number; region: string | null }> = [];
    let synapses: Synapse[] = [];
    let dpr = 1;
    // Brain placement bounds within the canvas (after object-contain
    // letterboxing). Stored so resize/sample passes share the math.
    let brainBounds = { x: 0, y: 0, w: 0, h: 0 };
    // Per-region intensity, smoothed toward target each tick (1 if
    // selectedCategory matches, 0 otherwise) via exponential lerp.
    // Multiple regions can be at non-zero intensity briefly during
    // a crossfade. Object literal so categories not in CATEGORY_COLOURS
    // (e.g. 'note') simply never appear here.
    const regionIntensities: Record<string, number> = {};
    // Map from category string → glow hue, looked up once for cheap
    // access during render.
    const glowHueByCategory = new Map<string, number>(
      CATEGORY_COLOURS.map((c) => [c.category, c.glowHue])
    );

    function resize() {
      if (!canvas || !container) return;
      const rect = container.getBoundingClientRect();
      dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
      canvas.width = Math.max(1, Math.floor(rect.width * dpr));
      canvas.height = Math.max(1, Math.floor(rect.height * dpr));
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function sampleValidPositions() {
      // Render the brain image into an offscreen canvas at the
      // displayed size, then sample alpha at a coarse grid.
      // Anything with alpha > threshold is a candidate synapse
      // anchor. Coarse grid keeps the candidate pool small enough
      // to pick from cheaply.
      //
      // ALSO render the regions mask into a second offscreen canvas
      // at the same letterboxed bounds, sample the same grid, and
      // attach the matching category to each position. brain.png
      // and regions.png have matching dimensions (verified post-
      // alignment in scripts/clean-pngs.py + a one-off resize), so
      // the same dx/dy/dw/dh works for both.
      if (!canvas) return;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      const off = document.createElement('canvas');
      off.width = w;
      off.height = h;
      const offCtx = off.getContext('2d');
      if (!offCtx) return;
      const ar = img.width / img.height;
      const cAr = w / h;
      let dw, dh, dx, dy;
      if (ar > cAr) {
        dw = w;
        dh = w / ar;
        dx = 0;
        dy = (h - dh) / 2;
      } else {
        dh = h;
        dw = h * ar;
        dx = (w - dw) / 2;
        dy = 0;
      }
      offCtx.drawImage(img, dx, dy, dw, dh);
      const brainPixels = offCtx.getImageData(0, 0, w, h).data;
      brainBounds = { x: dx, y: dy, w: dw, h: dh };

      // Mask sampling. Reuses the same offscreen canvas (cheap clear
      // + redraw) so we don't allocate two getImageData buffers
      // simultaneously.
      let maskPixels: Uint8ClampedArray | null = null;
      if (maskLoaded) {
        offCtx.clearRect(0, 0, w, h);
        offCtx.drawImage(maskImg, dx, dy, dw, dh);
        maskPixels = offCtx.getImageData(0, 0, w, h).data;
      }

      const positions: Array<{ x: number; y: number; region: string | null }> = [];
      const step = 6;
      for (let y = 0; y < h; y += step) {
        for (let x = 0; x < w; x += step) {
          const i = (y * w + x) * 4;
          if (brainPixels[i + 3] <= 80) continue; // outside the brain
          let region: string | null = null;
          if (maskPixels) {
            region = pixelToCategory(
              maskPixels[i],
              maskPixels[i + 1],
              maskPixels[i + 2],
              maskPixels[i + 3]
            );
          }
          positions.push({ x, y, region });
        }
      }
      validPositions = positions;
    }

    function spawnSynapse(birthMs: number): Synapse | null {
      if (validPositions.length === 0) return null;
      // Spatial spawn bias. When a category is selected, prefer
      // candidate positions IN that region so the lit-up effect is
      // visible — without this, synapses are uniformly distributed
      // across the brain and only ~20% fall in any one region.
      //
      // Bias dialled back from 80% → 55% per second-pass user
      // feedback ("the glow is very heavy"). At 80% the small
      // lobes (frontal, cerebellum) saturated to a bright white
      // wash because so many additively-blended glows stacked up
      // on a small area. 55% still reads as a denser cluster but
      // doesn't dominate.
      const sc = propsRef.current.selectedCategory;
      let pool = validPositions;
      if (sc) {
        const inRegion = validPositions.filter((p) => p.region === sc);
        if (inRegion.length > 0 && Math.random() < 0.55) {
          pool = inRegion;
        }
      }
      const pos = pool[Math.floor(Math.random() * pool.length)];
      return {
        ax: pos.x,
        ay: pos.y,
        birthMs,
        // 0.8s to 2.5s lifetime; keeps the canvas dynamic without
        // being seizure-inducing.
        lifeMs: 800 + Math.random() * 1700,
        // Hue shift in [-30, 30] around brand-emerald (~150°).
        hueShift: (Math.random() - 0.5) * 60,
        // Radius variance for visual interest.
        rScale: 0.8 + Math.random() * 0.6,
        // Region tag from the mask, or null if this synapse spawned
        // outside any region.
        region: pos.region,
      };
    }

    function drawSynapse(s: Synapse, nowMs: number) {
      const t = (nowMs - s.birthMs) / s.lifeMs;
      if (t < 0 || t > 1) return;
      // Lifecycle envelope: smooth fade in → peak → fade out.
      const env = Math.sin(Math.PI * t);
      // Perlin drift — small per-synapse position offset that
      // varies smoothly over time so the synapse "breathes."
      const seed = s.ax * 0.013 + s.ay * 0.017;
      const dx = noise2(seed, nowMs * 0.0003) * 3;
      const dy = noise2(seed + 100, nowMs * 0.0003) * 3;
      const x = s.ax + dx;
      const y = s.ay + dy;
      const baseR = 1.5 * s.rScale;

      // Region boost: if this synapse falls in the currently-selected
      // region, the region's intensity (smoothly lerped 0..1 by the
      // tick loop) lifts brightness + radius + shifts hue toward
      // the region's signature colour. Other synapses stay at
      // baseline.
      //
      // Per-synapse boost dialled WAY back from the second pass
      // (radius +2.5px, brightness +150%) because additive stacking
      // (globalCompositeOperation='lighter') saturated overlapping
      // glows to white. Now: radius +1px, brightness +50%. The
      // spawn-bias-driven density does the bulk of the "lit up"
      // visual work; per-synapse boost is supporting cast.
      const regionBoost = s.region ? regionIntensities[s.region] ?? 0 : 0;
      const peakR = baseR + env * (2.0 + regionBoost * 1.0);
      // Hue: blend the synapse's natural ~150° emerald toward the
      // region's signature hue at full boost.
      const baseHue = 150 + s.hueShift;
      const targetHue = s.region ? glowHueByCategory.get(s.region) ?? baseHue : baseHue;
      const hue = baseHue * (1 - regionBoost) + targetHue * regionBoost;
      // Brightness multiplier — +50% at full boost.
      const envBoosted = env * (1 + regionBoost * 0.5);

      // Soft outer glow. Radius reduced from peakR*6 → peakR*4.5
      // per user feedback: at the larger radius, halos around
      // synapses near the brain's silhouette were extending past
      // the brain's edges into the card gradient and reading as
      // "clipping" at the brain image boundary. The tighter radius
      // keeps each synapse's bloom contained within the local
      // brain region.
      const grad = ctx!.createRadialGradient(x, y, 0, x, y, peakR * 4.5);
      grad.addColorStop(0, `hsla(${hue}, 90%, 65%, ${envBoosted * 0.55})`);
      grad.addColorStop(0.4, `hsla(${hue}, 90%, 55%, ${envBoosted * 0.18})`);
      grad.addColorStop(1, `hsla(${hue}, 90%, 50%, 0)`);
      ctx!.fillStyle = grad;
      ctx!.beginPath();
      ctx!.arc(x, y, peakR * 4.5, 0, Math.PI * 2);
      ctx!.fill();

      // Bright core.
      ctx!.fillStyle = `hsla(${hue}, 100%, 80%, ${envBoosted})`;
      ctx!.beginPath();
      ctx!.arc(x, y, peakR, 0, Math.PI * 2);
      ctx!.fill();
    }

    function tick(nowMs: number) {
      // Local-flag check, NOT a shared ref. Even if a stale rAF
      // callback fires after this effect has been cleaned up, its
      // own alive=false stops it from scheduling another frame.
      if (!alive) return;
      // Frame-rate cap.
      const realDelta = lastFrameMs === 0 ? MIN_FRAME_MS : nowMs - lastFrameMs;
      if (realDelta < MIN_FRAME_MS) {
        frameHandle = requestAnimationFrame(tick);
        return;
      }
      lastFrameMs = nowMs;
      // Advance the SIMULATION clock by a capped delta. After a
      // long pause (scroll, tab switch) realDelta can be hundreds
      // of ms; we clamp so synapses don't leap through their
      // lifecycles in a single tick. Effect: long pauses look like
      // the animation just skipped frames, not like every synapse
      // rapid-cycled.
      simTime += Math.min(realDelta, MAX_SIM_DELTA_MS);

      // Skip when document hidden — saves battery on background
      // tabs. Page Visibility API check.
      if (typeof document !== 'undefined' && document.hidden) {
        frameHandle = requestAnimationFrame(tick);
        return;
      }

      // Read CURRENT props via the ref so prop changes (entryCount
      // grows, agent runs, etc.) take effect on the next tick without
      // needing the effect to re-run. The effect mounts once and
      // lives the whole component lifetime.
      const { entryCount: ec, lastRunAt: lr, selectedCategory: sc } = propsRef.current;
      const intensity = brainIntensity({ entryCount: ec, lastRunAt: lr });
      const targetCount = activeSynapseCount(intensity);

      // Smooth crossfade for region intensities. Each known category
      // lerps its current intensity toward 1 if it matches the
      // selected category, 0 otherwise. Exponential lerp with a
      // ~500ms time-constant — past 3τ (~1.5s) we're effectively at
      // the target. The user emphasised "never poppy"; this is the
      // primary mechanism that delivers that.
      const dtSec = MIN_FRAME_MS / 1000; // ~0.04s at 24fps
      const tau = 0.5;
      const lerpAlpha = 1 - Math.exp(-dtSec / tau);
      for (const c of CATEGORY_COLOURS) {
        const target = sc === c.category ? 1 : 0;
        const current = regionIntensities[c.category] ?? 0;
        regionIntensities[c.category] = current + (target - current) * lerpAlpha;
      }

      // Top up active synapses to target. Lifecycle math now uses
      // simTime, not wall clock, so a scroll-induced pause in rAF
      // doesn't cause every synapse to retire at once when the
      // loop resumes.
      synapses = synapses.filter((s) => simTime - s.birthMs <= s.lifeMs);
      while (synapses.length < targetCount) {
        const s = spawnSynapse(simTime);
        if (!s) break;
        synapses.push(s);
      }

      // Render. Firing arcs were removed in 645cf3f — they didn't
      // read as "neural activity", they read as random scribbles.
      // The undulating synapse glows alone carry the "alive" feeling.
      ctx!.clearRect(0, 0, canvas!.clientWidth, canvas!.clientHeight);
      ctx!.globalCompositeOperation = 'lighter';
      for (const s of synapses) drawSynapse(s, simTime);
      ctx!.globalCompositeOperation = 'source-over';

      frameHandle = requestAnimationFrame(tick);
    }

    img.onload = () => {
      // Critical: if the effect already cleaned up before the image
      // finished loading (rapid mount/unmount during navigation),
      // don't start a zombie loop on top of whatever new effect is
      // now alive.
      if (!alive) return;
      setImgLoaded(true);
      resize();
      sampleValidPositions();
      frameHandle = requestAnimationFrame(tick);
    };
    img.onerror = () => {
      if (!alive) return;
      setImgError('brain.png not found at ' + imageSrc);
    };

    // Mask loaded handler. If the brain has already been sampled
    // (synapses exist with region=null), re-sample to attach
    // regions retroactively. If the brain's not ready yet, just
    // mark the mask loaded — the brain's onload will sample both.
    maskImg.onload = () => {
      if (!alive) return;
      maskLoaded = true;
      if (validPositions.length > 0) {
        // Brain already sampled — re-sample to bind regions.
        sampleValidPositions();
        // Regions on existing synapses won't update; they live out
        // their current cycle as region=null. New ones spawn with
        // regions. This is acceptable for the brief load window.
      }
    };
    maskImg.onerror = () => {
      // Mask is non-essential for the base animation. Log + continue
      // without region tagging if it fails to load.
      if (!alive) return;
      // eslint-disable-next-line no-console
      console.warn('BrainCanvas: regions mask failed to load at', regionMaskSrc);
    };

    // Debounced + size-gated resize handler. Mobile Safari fires
    // resize events as the URL bar grows/shrinks during scroll
    // (because viewport height changes). Without guards, every
    // tiny scroll triggers a sampleValidPositions pass, which is
    // 30-100ms of getImageData + region classification — visible
    // as the synapses chattering. Two layers of defence:
    //   1. Debounce: collapse rapid resize events into one call
    //      after the last event in a 200ms window.
    //   2. Size gate: only re-sample if the canvas's actual
    //      client width / height changed. URL-bar resizes don't
    //      change the brain card's width, so they no-op here.
    let resizeTimer: number | null = null;
    let lastSampledW = 0;
    let lastSampledH = 0;
    const onResize = () => {
      if (!alive || !canvas) return;
      if (resizeTimer != null) window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        if (!alive || !canvas) return;
        resize();
        const w = canvas.clientWidth;
        const h = canvas.clientHeight;
        if (w === lastSampledW && h === lastSampledH) return;
        lastSampledW = w;
        lastSampledH = h;
        sampleValidPositions();
      }, 200);
    };
    window.addEventListener('resize', onResize);

    return () => {
      alive = false;
      cancelAnimationFrame(frameHandle);
      if (resizeTimer != null) window.clearTimeout(resizeTimer);
      window.removeEventListener('resize', onResize);
    };
    // Animation effect deliberately depends ONLY on imageSrc +
    // regionMaskSrc — the animation loop reads entryCount,
    // lastRunAt, and selectedCategory via propsRef and doesn't
    // need to restart on any of them changing. This is the fix
    // for the multi-loop pile-up bug: the previous deps array
    // included a fresh `new Date(lastRunAtISO)` which had a new
    // identity every render, so the effect re-ran every render,
    // each time starting another rAF loop on top of the previous.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageSrc, regionMaskSrc]);

  return (
    <div
      ref={containerRef}
      className="relative w-full overflow-hidden rounded-2xl"
      style={{ height: heightPx }}
      aria-label="Animated brain visualization"
      role="img"
    >
      {/* Base brain image. The canvas overlay sits exactly on top
          and renders synapse glows additively above it. We render
          the <img> with object-contain so it letterboxes inside the
          container at any aspect ratio. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={imageSrc}
        alt=""
        className={`absolute inset-0 h-full w-full object-contain transition-opacity duration-700 ${
          imgLoaded ? 'opacity-100' : 'opacity-0'
        }`}
        onLoad={() => setImgLoaded(true)}
        onError={() => setImgError('brain.png not found at ' + imageSrc)}
      />
      <canvas
        ref={canvasRef}
        className="pointer-events-none absolute inset-0 h-full w-full"
      />
      {imgError && (
        <div className="absolute inset-0 flex items-center justify-center text-center text-xs text-ink-500">
          <p>
            Drop the brain illustration at{' '}
            <code className="rounded bg-ink-800 px-1.5 py-0.5">{imageSrc}</code> and
            refresh.
          </p>
        </div>
      )}
    </div>
  );
}
