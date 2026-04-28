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
  // Visual size hint. The canvas matches this CSS dimension; the
  // actual pixel buffer scales with devicePixelRatio (capped at 2).
  // Default tuned so the BrainCallouts grid sits above the fold on
  // typical iPhone-class viewports (~667-844 px logical height).
  heightPx?: number;
  // Source PNG path. Default works once the user uploads to
  // public/brain/brain.png. Can be overridden for testing variants.
  imageSrc?: string;
};

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
};

const TARGET_FPS = 24;
const MIN_FRAME_MS = 1000 / TARGET_FPS;
const MAX_DPR = 2;

export function BrainCanvas({
  entryCount,
  lastRunAtISO,
  heightPx = 220,
  imageSrc = '/brain/brain.png',
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
  }>({
    entryCount,
    lastRunAt: lastRunAtISO ? new Date(lastRunAtISO) : null,
  });
  useEffect(() => {
    propsRef.current = {
      entryCount,
      lastRunAt: lastRunAtISO ? new Date(lastRunAtISO) : null,
    };
  }, [entryCount, lastRunAtISO]);

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

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Load the brain PNG into an offscreen canvas to sample its
    // alpha channel. Synapse anchor positions are picked from
    // pixels with alpha > threshold — guarantees they sit on the
    // brain, not in empty corners.
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = imageSrc;

    let validPositions: Array<{ x: number; y: number }> = [];
    let synapses: Synapse[] = [];
    let dpr = 1;

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
      if (!canvas) return;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      const off = document.createElement('canvas');
      off.width = w;
      off.height = h;
      const offCtx = off.getContext('2d');
      if (!offCtx) return;
      // Letterbox the brain image to fit the canvas aspect.
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
      const pixels = offCtx.getImageData(0, 0, w, h).data;

      const positions: Array<{ x: number; y: number }> = [];
      const step = 6; // grid spacing — tighter = more candidates
      for (let y = 0; y < h; y += step) {
        for (let x = 0; x < w; x += step) {
          const i = (y * w + x) * 4 + 3; // alpha byte
          if (pixels[i] > 80) positions.push({ x, y });
        }
      }
      validPositions = positions;
    }

    function spawnSynapse(birthMs: number): Synapse | null {
      if (validPositions.length === 0) return null;
      const pos = validPositions[Math.floor(Math.random() * validPositions.length)];
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
      const peakR = baseR + env * 2.0;
      const hue = 150 + s.hueShift;

      // Soft outer glow. Radius reduced from peakR*6 → peakR*4.5
      // per user feedback: at the larger radius, halos around
      // synapses near the brain's silhouette were extending past
      // the brain's edges into the card gradient and reading as
      // "clipping" at the brain image boundary. The tighter radius
      // keeps each synapse's bloom contained within the local
      // brain region.
      const grad = ctx!.createRadialGradient(x, y, 0, x, y, peakR * 4.5);
      grad.addColorStop(0, `hsla(${hue}, 90%, 65%, ${env * 0.55})`);
      grad.addColorStop(0.4, `hsla(${hue}, 90%, 55%, ${env * 0.18})`);
      grad.addColorStop(1, `hsla(${hue}, 90%, 50%, 0)`);
      ctx!.fillStyle = grad;
      ctx!.beginPath();
      ctx!.arc(x, y, peakR * 4.5, 0, Math.PI * 2);
      ctx!.fill();

      // Bright core.
      ctx!.fillStyle = `hsla(${hue}, 100%, 80%, ${env})`;
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
      if (nowMs - lastFrameMs < MIN_FRAME_MS) {
        frameHandle = requestAnimationFrame(tick);
        return;
      }
      lastFrameMs = nowMs;

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
      const { entryCount: ec, lastRunAt: lr } = propsRef.current;
      const intensity = brainIntensity({ entryCount: ec, lastRunAt: lr });
      const targetCount = activeSynapseCount(intensity);

      // Top up active synapses to target.
      synapses = synapses.filter((s) => nowMs - s.birthMs <= s.lifeMs);
      while (synapses.length < targetCount) {
        const s = spawnSynapse(nowMs);
        if (!s) break;
        synapses.push(s);
      }

      // Render. Firing arcs were removed in 0aff... — they didn't read
      // as "neural activity", they read as random scribbles. The
      // undulating synapse glows alone carry the "alive" feeling.
      // Future enhancement: animated tracers that follow the brain's
      // own circuit-board pattern would be cooler still — needs a
      // path-extraction step from the brain PNG that's beyond this
      // pass.
      ctx!.clearRect(0, 0, canvas!.clientWidth, canvas!.clientHeight);
      ctx!.globalCompositeOperation = 'lighter';
      for (const s of synapses) drawSynapse(s, nowMs);
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

    const onResize = () => {
      if (!alive) return;
      resize();
      sampleValidPositions();
    };
    window.addEventListener('resize', onResize);

    return () => {
      alive = false;
      cancelAnimationFrame(frameHandle);
      window.removeEventListener('resize', onResize);
    };
    // Animation effect deliberately depends ONLY on imageSrc — the
    // animation loop reads entryCount + lastRunAt via propsRef and
    // doesn't need to restart on either changing. This is the fix
    // for the multi-loop pile-up bug: the previous deps array
    // included a fresh `new Date(lastRunAtISO)` which had a new
    // identity every render, so the effect re-ran every render,
    // each time starting another rAF loop on top of the previous.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageSrc]);

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
