/**
 * Human-like browser interaction engine: curved Bezier cursor motion, visible
 * in-page cursor overlay, Fitts's Law pacing, hover hesitation, bionic wheel
 * scrolling and organic micro-behaviors.
 *
 * Adapted from MIT-licensed browser humanization techniques (cubic Bezier mouse
 * paths with piecewise easing & hand jitter, WindMouse-inspired drift, and
 * multi-step randomized scrolling). Pure ES module with zero dependencies and
 * full dependency injection (`document`, `wait`, `random`) so every behavior is
 * unit-testable in Node without a real browser.
 *
 * Strictly CSP-safe on instagram.com: the visible virtual cursor mounts inside
 * a closed/open Shadow DOM with `pointer-events: none` and sets every style
 * through CSSOM (no inline style attributes, no innerHTML, no external assets).
 */

import { interruptibleWait } from './pacing.js';

export const CURSOR_HOST_ID = 'ui-pointer-layer';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Return a random float in [min, max]. */
export function randBetween(min, max, random = Math.random) {
  return min + random() * Math.max(0, max - min);
}

/** Return a random integer in [min, max] inclusive. */
export function randInt(min, max, random = Math.random) {
  return Math.floor(randBetween(min, max + 0.9999, random));
}

/**
 * Log-normal-like human reaction / reading delay in [minMs, maxMs].
 *
 * Real people produce right-skewed timings (mostly quick-to-medium, with
 * occasional longer hesitations) rather than flat uniform rectangles. Averaging
 * two uniforms and skewing toward the lower-middle mimics that curve cleanly
 * with zero math dependencies.
 */
export function humanDelayMs(minMs, maxMs, random = Math.random) {
  const lo = Math.max(0, Number(minMs) || 0);
  const hi = Math.max(lo, Number(maxMs) || lo);
  if (hi <= lo) return lo;
  // Right-skewed sample in [0, 1]
  const u = (random() + random()) * 0.5;
  const skewed = Math.pow(u, 1.35);
  return Math.round(lo + (hi - lo) * skewed);
}

/**
 * Piecewise ease-in / linear / ease-out curve for natural hand velocity.
 * Accelerates smoothly off the start, cruises through the middle, and
 * decelerates with precision into the target (Fitts's Law).
 */
export function humanEase(t) {
  const clamped = Math.max(0, Math.min(1, t));
  if (clamped < 0.2) {
    const k = clamped / 0.2;
    return 0.2 * k * k;
  }
  if (clamped > 0.8) {
    const k = (1 - clamped) / 0.2;
    return 1 - 0.2 * k * k;
  }
  return clamped;
}

/**
 * Generate a human-like cubic Bezier cursor trajectory from `from` to `to`.
 *
 * Features:
 *   - Single-side organic arc (control points biased off the straight chord)
 *   - Fitts's Law step count scaled by travel distance
 *   - Hand micro-jitter in the mid-flight segment (fades to 0 at start & target)
 *   - Optional subtle overshoot & correction on longer moves (> 140px)
 *   - Per-point step delay (`dtMs`) including occasional mid-path micro-pause
 *
 * @returns {Array<{ clientX: number, clientY: number, dtMs: number }>}
 */
export function generateHumanPath(from, to, {
  random = Math.random,
  minSteps = 10,
  maxSteps = 32,
  allowOvershoot = true,
} = {}) {
  const sx = Number(from?.clientX ?? 0);
  const sy = Number(from?.clientY ?? 0);
  const ex = Number(to?.clientX ?? 0);
  const ey = Number(to?.clientY ?? 0);

  const dx = ex - sx;
  const dy = ey - sy;
  const dist = Math.hypot(dx, dy);

  if (dist < 2) {
    return [{ clientX: Math.round(ex), clientY: Math.round(ey), dtMs: randInt(10, 24, random) }];
  }

  // Fitts's Law: longer travel uses more points; short nudges stay nimble.
  const steps = Math.max(minSteps, Math.min(maxSteps, Math.round(minSteps + Math.sqrt(dist) * 0.85)));

  // Pick one consistent arc side so the curve looks like a natural wrist swing.
  const side = random() < 0.5 ? 1 : -1;
  const perpX = (-dy / dist) * side;
  const perpY = (dx / dist) * side;
  const spread = Math.min(120, Math.max(14, dist * randBetween(0.14, 0.32, random)));

  const cp1x = sx + dx * randBetween(0.22, 0.38, random) + perpX * spread * randBetween(0.6, 1.1, random);
  const cp1y = sy + dy * randBetween(0.22, 0.38, random) + perpY * spread * randBetween(0.6, 1.1, random);
  const cp2x = sx + dx * randBetween(0.62, 0.82, random) + perpX * spread * randBetween(0.3, 0.85, random);
  const cp2y = sy + dy * randBetween(0.62, 0.82, random) + perpY * spread * randBetween(0.3, 0.85, random);

  // Subtle overshoot on ~20% of longer journeys, followed by a gentle pull-back.
  const willOvershoot = allowOvershoot && dist > 140 && random() < 0.2;
  const overDist = willOvershoot ? randBetween(5, 14, random) : 0;
  const targetX = ex + (dx / dist) * overDist;
  const targetY = ey + (dy / dist) * overDist;

  // Occasional brief mid-path hesitation (~12% chance)
  const pauseIndex = random() < 0.12 ? randInt(Math.floor(steps * 0.35), Math.floor(steps * 0.7), random) : -1;

  const points = [];
  for (let i = 1; i <= steps; i += 1) {
    const rawT = i / steps;
    const t = humanEase(rawT);
    const inv = 1 - t;

    let x = inv * inv * inv * sx
      + 3 * inv * inv * t * cp1x
      + 3 * inv * t * t * cp2x
      + t * t * t * targetX;
    let y = inv * inv * inv * sy
      + 3 * inv * inv * t * cp1y
      + 3 * inv * t * t * cp2y
      + t * t * t * targetY;

    // Subtle hand tremor peaks mid-flight and settles to 0 at endpoints.
    const tremorScale = Math.sin(rawT * Math.PI) * Math.min(2.4, dist * 0.015);
    if (i < steps) {
      x += (random() - 0.5) * 2 * tremorScale;
      y += (random() - 0.5) * 2 * tremorScale;
    }

    // Velocity modulation: slightly slower at start & end, crisp in the middle.
    let dtMs = rawT < 0.2 || rawT > 0.8
      ? randInt(14, 28, random)
      : randInt(8, 18, random);
    if (i === pauseIndex) dtMs += randInt(55, 160, random);

    points.push({ clientX: Math.round(x), clientY: Math.round(y), dtMs });
  }

  if (willOvershoot) {
    const settleSteps = randInt(2, 4, random);
    const fromX = points[points.length - 1].clientX;
    const fromY = points[points.length - 1].clientY;
    for (let s = 1; s <= settleSteps; s += 1) {
      const k = s / settleSteps;
      points.push({
        clientX: Math.round(fromX + (ex - fromX) * k),
        clientY: Math.round(fromY + (ey - fromY) * k),
        dtMs: randInt(18, 36, random),
      });
    }
  }

  return points;
}

/** Pick a jittered point inside the safe inner 60% of an element's rect. */
export function targetPointFor(element, random = Math.random) {
  const rect = element?.getBoundingClientRect?.();
  if (!rect || !Number.isFinite(rect.width) || rect.width <= 0 || !Number.isFinite(rect.height) || rect.height <= 0) {
    return { clientX: 0, clientY: 0, hasRect: false };
  }
  const padX = Math.max(2, Math.min(rect.width * 0.22, 16));
  const padY = Math.max(2, Math.min(rect.height * 0.22, 10));
  const innerW = Math.max(1, rect.width - padX * 2);
  const innerH = Math.max(1, rect.height - padY * 2);
  return {
    clientX: Math.round(rect.left + padX + random() * innerW),
    clientY: Math.round(rect.top + padY + random() * innerH),
    hasRect: true,
  };
}

/* ----------------------------------------------------- visible virtual cursor */

/**
 * Mount a subtle, pointer-events-none visual cursor inside a Shadow DOM overlay
 * on instagram.com so the owner can literally watch every mouse move and click
 * happen in front of them.
 *
/**
 * Mount a subtle, closed-Shadow-DOM live visualization overlay on instagram.com
 * ONLY while a task is actively running so the user can watch every move,
 * target highlight, click, scroll, and count live in front of them — and remove
 * it completely as soon as the task ends.
 *
 * Uses `attachShadow({ mode: 'closed' })` and CSSOM-only styling (no innerHTML,
 * no inline style attributes, no exposed bot identifiers) so it is invisible to
 * host page scripts and strictly CSP-safe.
 */
export function createVirtualCursor(document, { onStop = null } = {}) {
  let host = null;
  let pointerEl = null;
  let rippleEl = null;
  let tagEl = null;
  let highlightEl = null;
  let hudEl = null;
  let hudDotEl = null;
  let hudTextEl = null;
  let hudCountEl = null;
  let hudBarFillEl = null;
  let hudBarTrackEl = null;
  let x = 240;
  let y = 180;
  let visible = false;

  function ensureMounted() {
    if (!document?.body || typeof document.createElement !== 'function') return false;
    if (host && (document.body.contains?.(host) || host.parentNode === document.body)) return true;

    const existing = document.getElementById?.(CURSOR_HOST_ID);
    if (existing) existing.remove?.();

    host = document.createElement('div');
    host.id = CURSOR_HOST_ID;
    Object.assign(host.style, {
      position: 'fixed',
      inset: '0',
      pointerEvents: 'none',
      zIndex: '2147483500',
      overflow: 'hidden',
      display: 'none',
    });

    const mountRoot = typeof host.attachShadow === 'function' ? host.attachShadow({ mode: 'closed' }) : host;

    highlightEl = document.createElement('div');
    Object.assign(highlightEl.style, {
      position: 'fixed',
      left: '0px',
      top: '0px',
      width: '0px',
      height: '0px',
      borderRadius: '8px',
      border: '2px solid #e5472b',
      background: 'rgba(229, 71, 43, 0.12)',
      boxShadow: '0 0 0 3px rgba(229, 71, 43, 0.18)',
      pointerEvents: 'none',
      opacity: '0',
      transition: 'opacity 140ms ease, transform 120ms ease',
    });

    pointerEl = document.createElement('div');
    Object.assign(pointerEl.style, {
      position: 'fixed',
      left: '0px',
      top: '0px',
      width: '24px',
      height: '24px',
      pointerEvents: 'none',
      transform: `translate3d(${x}px, ${y}px, 0)`,
      transition: 'transform 16ms linear',
      willChange: 'transform',
      filter: 'drop-shadow(0 2px 4px rgba(58, 42, 34, 0.38))',
    });

    if (typeof document.createElementNS === 'function') {
      const svg = document.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('width', '22');
      svg.setAttribute('height', '22');
      const arrow = document.createElementNS(SVG_NS, 'path');
      arrow.setAttribute('d', 'M4 3l14 9-6.2 1.4L9 20 4 3z');
      arrow.setAttribute('fill', '#e5472b');
      arrow.setAttribute('stroke', '#f3e6cf');
      arrow.setAttribute('stroke-width', '1.8');
      arrow.setAttribute('stroke-linejoin', 'round');
      svg.append(arrow);
      pointerEl.append(svg);
    }

    rippleEl = document.createElement('div');
    Object.assign(rippleEl.style, {
      position: 'fixed',
      left: '0px',
      top: '0px',
      width: '28px',
      height: '28px',
      marginLeft: '-14px',
      marginTop: '-14px',
      borderRadius: '999px',
      border: '2px solid #e5472b',
      background: 'rgba(229, 71, 43, 0.16)',
      pointerEvents: 'none',
      opacity: '0',
      transform: `translate3d(${x}px, ${y}px, 0) scale(0.4)`,
      transition: 'transform 260ms ease-out, opacity 260ms ease-out',
    });

    tagEl = document.createElement('div');
    Object.assign(tagEl.style, {
      position: 'fixed',
      left: '0px',
      top: '0px',
      padding: '3px 8px',
      borderRadius: '999px',
      background: 'rgba(26, 26, 28, 0.92)',
      color: '#f3e6cf',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      fontSize: '11px',
      fontWeight: '600',
      letterSpacing: '0.01em',
      whiteSpace: 'nowrap',
      pointerEvents: 'none',
      opacity: '0',
      transform: `translate3d(${x + 18}px, ${y + 18}px, 0)`,
      transition: 'transform 40ms linear, opacity 140ms ease',
    });

    // Top-center floating live action HUD so the user sees exact step + count + Stop
    hudEl = document.createElement('div');
    Object.assign(hudEl.style, {
      position: 'fixed',
      top: '14px',
      left: '50%',
      transform: 'translateX(-50%)',
      display: 'flex',
      alignItems: 'center',
      gap: '10px',
      padding: '8px 14px',
      borderRadius: '999px',
      background: 'rgba(26, 26, 28, 0.94)',
      color: '#f3e6cf',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      fontSize: '12.5px',
      fontWeight: '600',
      boxShadow: '0 8px 24px rgba(26, 26, 28, 0.34)',
      border: '2px solid #e5472b',
      pointerEvents: 'auto',
      maxWidth: '90vw',
    });

    hudDotEl = document.createElement('span');
    Object.assign(hudDotEl.style, {
      width: '9px',
      height: '9px',
      borderRadius: '999px',
      background: '#e5472b',
      boxShadow: '0 0 0 3px rgba(229, 71, 43, 0.35)',
      flexShrink: '0',
    });

    hudTextEl = document.createElement('span');
    Object.assign(hudTextEl.style, {
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      maxWidth: '380px',
    });
    hudTextEl.textContent = 'Working…';

    hudCountEl = document.createElement('span');
    Object.assign(hudCountEl.style, {
      fontVariantNumeric: 'tabular-nums',
      color: '#f8d3c9',
      fontSize: '12px',
      display: 'none',
    });

    hudBarTrackEl = document.createElement('div');
    Object.assign(hudBarTrackEl.style, {
      width: '72px',
      height: '5px',
      borderRadius: '999px',
      background: 'rgba(243, 230, 207, 0.2)',
      overflow: 'hidden',
      display: 'none',
      flexShrink: '0',
    });
    hudBarFillEl = document.createElement('div');
    Object.assign(hudBarFillEl.style, {
      width: '0%',
      height: '100%',
      borderRadius: '999px',
      background: '#e5472b',
      transition: 'width 180ms ease',
    });
    hudBarTrackEl.append(hudBarFillEl);

    hudEl.append(hudDotEl, hudTextEl, hudCountEl, hudBarTrackEl);

    if (typeof onStop === 'function') {
      const stopBtn = document.createElement('button');
      stopBtn.setAttribute('type', 'button');
      stopBtn.textContent = 'Stop';
      Object.assign(stopBtn.style, {
        border: 'none',
        borderRadius: '999px',
        padding: '4px 10px',
        background: '#e5472b',
        color: '#f3e6cf',
        fontFamily: 'inherit',
        fontSize: '11.5px',
        fontWeight: '700',
        cursor: 'pointer',
        marginLeft: '2px',
        flexShrink: '0',
      });
      stopBtn.addEventListener?.('click', (event) => {
        event?.stopPropagation?.();
        event?.preventDefault?.();
        onStop();
      });
      hudEl.append(stopBtn);
    }

    mountRoot.append(highlightEl, rippleEl, pointerEl, tagEl, hudEl);
    document.body.append(host);
    return true;
  }

  return {
    get position() {
      return { clientX: x, clientY: y };
    },
    show(label = null) {
      if (!ensureMounted()) return;
      visible = true;
      host.style.display = 'block';
      if (label !== null) this.label(label);
    },
    hide() {
      visible = false;
      if (host) host.style.display = 'none';
      if (tagEl) tagEl.style.opacity = '0';
      if (highlightEl) highlightEl.style.opacity = '0';
    },
    move(nx, ny) {
      x = Math.round(Number(nx) || 0);
      y = Math.round(Number(ny) || 0);
      if (!visible) this.show();
      if (pointerEl) pointerEl.style.transform = `translate3d(${x}px, ${y}px, 0)`;
      if (tagEl) tagEl.style.transform = `translate3d(${x + 18}px, ${y + 20}px, 0)`;
    },
    label(text) {
      const clean = String(text ?? '').trim();
      if (tagEl) {
        tagEl.textContent = clean;
        tagEl.style.opacity = clean ? '1' : '0';
      }
      if (hudTextEl && clean) {
        hudTextEl.textContent = clean;
      }
    },
    progress(count, limit) {
      if (!ensureMounted()) return;
      const c = Math.max(0, Number(count) || 0);
      const l = Math.max(0, Number(limit) || 0);
      if (hudCountEl) {
        hudCountEl.style.display = l > 0 ? 'inline' : 'none';
        hudCountEl.textContent = l > 0 ? `${c}/${l}` : '';
      }
      if (hudBarTrackEl && hudBarFillEl) {
        hudBarTrackEl.style.display = l > 0 ? 'block' : 'none';
        const pct = l > 0 ? Math.min(100, Math.round((c / l) * 100)) : 0;
        hudBarFillEl.style.width = `${pct}%`;
      }
      if (hudDotEl) {
        hudDotEl.style.background = c > 0 ? '#22c55e' : '#e5472b';
      }
    },
    highlight(element) {
      if (!highlightEl || !element?.getBoundingClientRect) return;
      const rect = element.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) {
        highlightEl.style.opacity = '0';
        return;
      }
      const pad = 4;
      highlightEl.style.left = `${Math.max(0, Math.round(rect.left - pad))}px`;
      highlightEl.style.top = `${Math.max(0, Math.round(rect.top - pad))}px`;
      highlightEl.style.width = `${Math.round(rect.width + pad * 2)}px`;
      highlightEl.style.height = `${Math.round(rect.height + pad * 2)}px`;
      highlightEl.style.opacity = '1';
    },
    clearHighlight() {
      if (highlightEl) highlightEl.style.opacity = '0';
    },
    pulseClick(cx = x, cy = y) {
      if (!rippleEl) return;
      rippleEl.style.transition = 'none';
      rippleEl.style.opacity = '0.95';
      rippleEl.style.transform = `translate3d(${Math.round(cx)}px, ${Math.round(cy)}px, 0) scale(0.35)`;
      const raf = typeof globalThis.requestAnimationFrame === 'function'
        ? globalThis.requestAnimationFrame
        : (fn) => setTimeout(fn, 16);
      raf(() => {
        if (!rippleEl) return;
        rippleEl.style.transition = 'transform 260ms ease-out, opacity 260ms ease-out';
        rippleEl.style.opacity = '0';
        rippleEl.style.transform = `translate3d(${Math.round(cx)}px, ${Math.round(cy)}px, 0) scale(1.65)`;
      });
    },
    destroy() {
      visible = false;
      if (host) {
        if (typeof host.remove === 'function') host.remove();
        else host.parentNode?.removeChild?.(host);
      }
      host = null;
      pointerEl = null;
      rippleEl = null;
      tagEl = null;
      highlightEl = null;
      hudEl = null;
      hudDotEl = null;
      hudTextEl = null;
      hudCountEl = null;
      hudBarFillEl = null;
      hudBarTrackEl = null;
    },
  };
}

/* ----------------------------------------------------- pointer & click engine */

function firePointer(target, type, init = {}) {
  const view = target?.ownerDocument?.defaultView ?? globalThis.window ?? undefined;
  const EventCtor = type.startsWith('pointer')
    ? (globalThis.PointerEvent ?? globalThis.MouseEvent ?? globalThis.Event)
    : (globalThis.MouseEvent ?? globalThis.Event);
  try {
    target?.dispatchEvent?.(new EventCtor(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      pointerType: 'mouse',
      isPrimary: true,
      view,
      ...init,
    }));
  } catch {
    try {
      target?.dispatchEvent?.(new Event(type, { bubbles: true, cancelable: true }));
    } catch { /* minimal shim */ }
  }
}

/** Ensure a cursor state object exists on `ctx` so movements stay continuous. */
export function cursorStateOf(ctx) {
  if (!ctx) return { clientX: 240, clientY: 180 };
  if (!ctx.cursor) ctx.cursor = { clientX: 240, clientY: 180 };
  return ctx.cursor;
}

/**
 * Glide the cursor along a cubic Bezier curve to a screen point or DOM element.
 */
export async function humanMoveTo(ctx, targetOrPoint, {
  signal = null,
  label = null,
  fast = false,
} = {}) {
  const wait = ctx?.wait ?? interruptibleWait;
  const random = typeof ctx?.random === 'function' ? ctx.random : Math.random;
  const cursor = cursorStateOf(ctx);
  const visual = ctx?.virtualCursor ?? null;

  const isElement = Boolean(targetOrPoint && typeof targetOrPoint.dispatchEvent === 'function');
  const dest = isElement
    ? targetPointFor(targetOrPoint, random)
    : { clientX: Number(targetOrPoint?.clientX ?? 0), clientY: Number(targetOrPoint?.clientY ?? 0), hasRect: true };

  if (visual) {
    visual.show(label);
  }

  const path = generateHumanPath(cursor, dest, {
    random,
    minSteps: fast ? 6 : 10,
    maxSteps: fast ? 16 : 28,
    allowOvershoot: !fast,
  });

  const eventTarget = isElement ? targetOrPoint : (ctx?.document?.body ?? null);
  for (const pt of path) {
    if (signal?.aborted) return { ok: false, aborted: true };
    cursor.clientX = pt.clientX;
    cursor.clientY = pt.clientY;
    visual?.move(pt.clientX, pt.clientY);
    if (eventTarget) {
      firePointer(eventTarget, 'pointermove', { clientX: pt.clientX, clientY: pt.clientY, buttons: 0 });
      firePointer(eventTarget, 'mousemove', { clientX: pt.clientX, clientY: pt.clientY, buttons: 0 });
    }
    const stepDelay = fast ? Math.max(4, Math.round(pt.dtMs * 0.5)) : pt.dtMs;
    await wait(stepDelay, { signal });
  }

  return { ok: true, clientX: cursor.clientX, clientY: cursor.clientY };
}

/**
 * Scroll an element smoothly into view, glide the visible human cursor along a
 * Bezier arc onto it, hesitate briefly like a human reading the label, press
 * and release with realistic hold time, and trigger click.
 */
export async function humanClickTarget(ctx, element, {
  signal = null,
  label = null,
  hoverMinMs = 140,
  hoverMaxMs = 420,
} = {}) {
  if (!element) return false;
  if (signal?.aborted) return false;

  const wait = ctx?.wait ?? interruptibleWait;
  const random = typeof ctx?.random === 'function' ? ctx.random : Math.random;
  const visual = ctx?.virtualCursor ?? null;

  try {
    element.scrollIntoView?.({ block: 'center', inline: 'nearest', behavior: 'smooth' });
  } catch {
    try { element.scrollIntoView?.({ block: 'center' }); } catch { /* shim */ }
  }
  await wait(humanDelayMs(120, 280, random), { signal });
  if (signal?.aborted) return false;

  const moved = await humanMoveTo(ctx, element, { signal, label });
  if (!moved.ok || signal?.aborted) return false;

  visual?.highlight?.(element);
  const point = { clientX: moved.clientX, clientY: moved.clientY };
  firePointer(element, 'pointerover', point);
  firePointer(element, 'pointerenter', point);
  firePointer(element, 'mouseover', point);
  await wait(humanDelayMs(hoverMinMs, hoverMaxMs, random), { signal });
  if (signal?.aborted) {
    visual?.clearHighlight?.();
    return false;
  }

  visual?.pulseClick(point.clientX, point.clientY);
  firePointer(element, 'pointerdown', { ...point, button: 0, buttons: 1 });
  firePointer(element, 'mousedown', { ...point, button: 0, buttons: 1 });
  element.focus?.();
  await wait(humanDelayMs(45, 125, random), { signal });
  if (signal?.aborted) {
    visual?.clearHighlight?.();
    return false;
  }

  firePointer(element, 'pointerup', { ...point, button: 0, buttons: 0 });
  firePointer(element, 'mouseup', { ...point, button: 0, buttons: 0 });
  if (typeof element.click === 'function') {
    element.click();
  } else {
    firePointer(element, 'click', { ...point, button: 0, buttons: 0 });
  }
  visual?.clearHighlight?.();
  return true;
}

/* ----------------------------------------------------- bionic human scrolling */

function dispatchWheelAndScroll(container, deltaY) {
  if (!container) return;
  try {
    if (typeof globalThis.WheelEvent === 'function') {
      container.dispatchEvent?.(new globalThis.WheelEvent('wheel', {
        deltaY,
        deltaMode: 0,
        bubbles: true,
        cancelable: true,
      }));
    }
  } catch { /* minimal shim */ }
  try {
    container.dispatchEvent?.(new Event('scroll', { bubbles: false }));
  } catch { /* minimal shim */ }
}

/**
 * Perform one natural multi-step scroll gesture on a scrollable container
 * (or the window/documentElement) with randomized wheel bursts, micro-pauses,
 * occasional tiny upward "re-read" nudges, and gentle cursor drift.
 *
 * Returns `{ movedPx, atBottom, didWander, didPause }` so callers can detect
 * genuine end-of-list stalls.
 */
export async function humanScrollContainer(ctx, container, {
  signal = null,
  ratioMin = 0.55,
  ratioMax = 0.88,
  allowMicroBehaviors = true,
  label = 'Scrolling list…',
} = {}) {
  if (!container || signal?.aborted) return { movedPx: 0, atBottom: true, didWander: false, didPause: false };

  const wait = ctx?.wait ?? interruptibleWait;
  const random = typeof ctx?.random === 'function' ? ctx.random : Math.random;
  const visual = ctx?.virtualCursor ?? null;

  const beforeTop = Number(container.scrollTop ?? 0);
  const clientH = Math.max(120, Number(container.clientHeight ?? 420));
  const scrollH = Number(container.scrollHeight ?? 0);

  // Move cursor inside the scrollable area first if it is far outside
  const rect = container.getBoundingClientRect?.();
  if (rect && rect.width > 40 && rect.height > 40) {
    const cur = cursorStateOf(ctx);
    const outside = cur.clientX < rect.left || cur.clientX > rect.right
      || cur.clientY < rect.top || cur.clientY > rect.bottom;
    if (outside) {
      await humanMoveTo(ctx, {
        clientX: Math.round(rect.left + rect.width * randBetween(0.25, 0.78, random)),
        clientY: Math.round(rect.top + rect.height * randBetween(0.28, 0.72, random)),
      }, { signal, label, fast: true });
    } else {
      visual?.label(label);
    }
  }

  // Split the scroll into 2..5 uneven mouse-wheel flicks like a real hand
  const totalDelta = Math.round(clientH * randBetween(ratioMin, ratioMax, random));
  const flicks = randInt(2, 5, random);
  let remaining = totalDelta;

  for (let i = 0; i < flicks; i += 1) {
    if (signal?.aborted) break;
    const isLast = i === flicks - 1;
    const chunk = isLast
      ? remaining
      : Math.max(24, Math.round((remaining / (flicks - i)) * randBetween(0.65, 1.35, random)));
    remaining = Math.max(0, remaining - chunk);

    const prev = Number(container.scrollTop ?? 0);
    const maxTop = Math.max(0, Number(container.scrollHeight ?? scrollH) - clientH);
    const nextTop = maxTop > 0 ? Math.min(maxTop, prev + chunk) : prev + chunk;
    container.scrollTop = nextTop;
    dispatchWheelAndScroll(container, chunk);

    await wait(humanDelayMs(75, 220, random), { signal });
  }

  let didWander = false;
  let didPause = false;

  // Organic human micro-behaviors while reading the newly revealed rows
  if (allowMicroBehaviors && !signal?.aborted) {
    const roll = random();
    if (roll < 0.11 && Number(container.scrollTop ?? 0) > 140) {
      // Tiny upward "re-read" micro-scroll, then resume gently downward
      const back = randInt(35, 110, random);
      container.scrollTop = Math.max(0, Number(container.scrollTop ?? 0) - back);
      dispatchWheelAndScroll(container, -back);
      await wait(humanDelayMs(240, 620, random), { signal });
      container.scrollTop = Number(container.scrollTop ?? 0) + Math.round(back * 0.7);
      dispatchWheelAndScroll(container, Math.round(back * 0.7));
    } else if (roll < 0.28 && rect && rect.width > 60 && rect.height > 60) {
      // Gentle cursor wander / hover over a visible item inside the list
      didWander = true;
      await humanMoveTo(ctx, {
        clientX: Math.round(rect.left + rect.width * randBetween(0.18, 0.82, random)),
        clientY: Math.round(rect.top + rect.height * randBetween(0.2, 0.82, random)),
      }, { signal, label: 'Reading…', fast: true });
    }

    // Occasional longer natural reading pause (~10% of scroll cycles)
    if (random() < 0.1 && !signal?.aborted) {
      didPause = true;
      visual?.label('Pausing naturally…');
      await wait(humanDelayMs(1600, 3800, random), { signal });
    }
  }

  const afterTop = Number(container.scrollTop ?? 0);
  const finalScrollH = Number(container.scrollHeight ?? scrollH);
  const atBottom = finalScrollH > 0 && (afterTop + clientH >= finalScrollH - 12);

  return {
    movedPx: Math.max(0, afterTop - beforeTop),
    atBottom,
    didWander,
    didPause,
  };
}

/**
 * Scroll-up-then-down recovery nudge for Instagram's virtualized list modals.
 *
 * On 2026 desktop Instagram, Followers / Following / Likes / Comments modals
 * occasionally stall at the bottom without firing the next lazy-load request
 * until the user scrolls slightly upward and then back down.
 */
export async function humanNudgeScroll(ctx, container, {
  signal = null,
  label = 'Loading more…',
} = {}) {
  if (!container || signal?.aborted) return { nudged: false };
  const wait = ctx?.wait ?? interruptibleWait;
  const random = typeof ctx?.random === 'function' ? ctx.random : Math.random;
  const visual = ctx?.virtualCursor ?? null;
  visual?.label?.(label);

  const clientH = Math.max(120, Number(container.clientHeight ?? 400));
  const upPx = randInt(120, Math.min(260, Math.round(clientH * 0.65)), random);
  const startTop = Number(container.scrollTop ?? 0);

  // 1. Gentle upward pull
  const upTarget = Math.max(0, startTop - upPx);
  container.scrollTop = upTarget;
  dispatchWheelAndScroll(container, -(startTop - upTarget || upPx));
  await wait(humanDelayMs(240, 520, random), { signal });
  if (signal?.aborted) return { nudged: false };

  // 2. Smooth downward return to trigger pagination observer
  const downPx = upPx + randInt(120, 260, random);
  const scrollH = Number(container.scrollHeight ?? 0);
  const maxTop = Math.max(0, scrollH - clientH);
  const nextTop = maxTop > 0 ? Math.min(maxTop, upTarget + downPx) : upTarget + downPx;
  container.scrollTop = nextTop;
  dispatchWheelAndScroll(container, downPx);
  await wait(humanDelayMs(220, 480, random), { signal });
  return { nudged: true };
}

/**
 * Brief idle human "look around" behavior upon arriving on a page or opening a
 * post: drifts the cursor naturally and pauses like a real person glancing at
 * the screen before clicking.
 */
export async function humanArriveOnPage(ctx, { signal = null, label = 'Looking at page…' } = {}) {
  if (signal?.aborted) return;
  const wait = ctx?.wait ?? interruptibleWait;
  const random = typeof ctx?.random === 'function' ? ctx.random : Math.random;
  const vw = Number(ctx?.document?.documentElement?.clientWidth ?? 1100);
  const vh = Number(ctx?.document?.documentElement?.clientHeight ?? 760);

  await humanMoveTo(ctx, {
    clientX: Math.round(vw * randBetween(0.26, 0.72, random)),
    clientY: Math.round(vh * randBetween(0.18, 0.56, random)),
  }, { signal, label, fast: true });
  await wait(humanDelayMs(350, 950, random), { signal });
}

/** Close a modal by pressing Escape cleanly (fallback when no Close icon is found). */
export function humanPressEscape(document) {
  const target = document?.activeElement ?? document?.body ?? document;
  if (!target?.dispatchEvent) return;
  const Ctor = globalThis.KeyboardEvent ?? globalThis.Event;
  for (const type of ['keydown', 'keyup']) {
    try {
      target.dispatchEvent(new Ctor(type, { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, cancelable: true }));
    } catch {
      try { target.dispatchEvent(new Event(type, { bubbles: true, cancelable: true })); } catch { /* shim */ }
    }
  }
}
