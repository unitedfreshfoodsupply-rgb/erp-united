"use client";

/**
 * Tiny synthesized-tone notification sounds (no audio files to host/ship).
 * Browsers block audio until a real user gesture happens on the page, so the
 * AudioContext is created lazily and only ever (re)started from `unlockAudio()`,
 * which the app wires up to the first tap/click anywhere.
 */
let ctx: AudioContext | null = null;
let unlocked = false;

function getContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const AC = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return null;
  if (!ctx) ctx = new AC();
  return ctx;
}

/** Call once from a real user gesture (click/touchstart) to satisfy autoplay policies. */
export function unlockAudio() {
  if (unlocked) return;
  const c = getContext();
  if (!c) return;
  if (c.state === "suspended") {
    c.resume().catch(() => {
      /* still locked — next gesture will retry */
    });
  }
  unlocked = true;
}

type ChimeKind = "success" | "attention" | "new-order" | "ready";

// Each chime is 1–2 short sine tones — quiet, short, and distinct enough to tell
// apart without being alarming in a warehouse setting.
const CHIMES: Record<ChimeKind, { freqs: number[]; gap: number; duration: number }> = {
  success: { freqs: [880], gap: 0, duration: 0.12 },
  ready: { freqs: [660, 880], gap: 0.09, duration: 0.11 },
  "new-order": { freqs: [523, 784], gap: 0.1, duration: 0.13 },
  attention: { freqs: [740, 550], gap: 0.11, duration: 0.14 },
};

export function playChime(kind: ChimeKind) {
  const c = getContext();
  if (!c) return;
  if (c.state === "suspended") {
    // Not unlocked yet (no user gesture seen) — fail silently rather than throw.
    c.resume().catch(() => {});
    if (c.state === "suspended") return;
  }
  try {
    const spec = CHIMES[kind];
    let t = c.currentTime;
    for (const freq of spec.freqs) {
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.16, t + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.001, t + spec.duration);
      osc.connect(gain).connect(c.destination);
      osc.start(t);
      osc.stop(t + spec.duration + 0.02);
      t += spec.gap + spec.duration;
    }
  } catch {
    // Never let a sound glitch break the UI.
  }
}
