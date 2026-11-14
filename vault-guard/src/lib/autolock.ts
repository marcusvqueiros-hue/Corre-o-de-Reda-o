"use client";
import { useEffect, useRef } from "react";

export const LOCK_CHOICES = [1, 5, 15, 30] as const;
export const DEFAULT_LOCK_MINUTES = 5;
const KEY = "vg.pref.lockMinutes"; // preferência não sensível

export function readLockMinutes(): number {
  try {
    const v = Number(localStorage.getItem(KEY));
    return (LOCK_CHOICES as readonly number[]).includes(v) ? v : DEFAULT_LOCK_MINUTES;
  } catch {
    return DEFAULT_LOCK_MINUTES;
  }
}
export function writeLockMinutes(m: number): void {
  try {
    localStorage.setItem(KEY, String(m));
  } catch {
    /* sem storage: vale só nesta sessão */
  }
}

const EVENTS = ["pointerdown", "keydown", "touchstart", "scroll"] as const;

/** Bloqueia após `minutes` sem atividade. Também confere o relógio ao voltar para a aba. */
export function useAutoLock(active: boolean, minutes: number, onLock: () => void): void {
  const cb = useRef(onLock);
  useEffect(() => {
    cb.current = onLock;
  });
  useEffect(() => {
    if (!active) return;
    const limit = minutes * 60_000;
    let last = Date.now();
    let timer: ReturnType<typeof setTimeout>;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => cb.current(), limit);
    };
    const touch = () => {
      last = Date.now();
      arm();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible" && Date.now() - last >= limit) cb.current();
    };
    arm();
    EVENTS.forEach((e) => window.addEventListener(e, touch, { passive: true }));
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearTimeout(timer);
      EVENTS.forEach((e) => window.removeEventListener(e, touch));
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [active, minutes]);
}
