"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { SwarmState, TickReport } from "@/lib/orchestrator";

/** Fetch the aggregated swarm state. */
export function useSwarmState(enabled = true, refetchMs = 4000) {
  return useQuery<SwarmState>({
    queryKey: ["swarm-state"],
    queryFn: async () => {
      const r = await fetch("/api/state", { cache: "no-store" });
      if (!r.ok) throw new Error(`state fetch failed: ${r.status}`);
      return (await r.json()) as SwarmState;
    },
    enabled,
    refetchInterval: refetchMs,
    staleTime: 2000,
  });
}

/** Run a single orchestration tick. */
export function useTick() {
  const qc = useQueryClient();
  return useMutation<TickReport, Error, void>({
    mutationFn: async () => {
      const r = await fetch("/api/orchestrator/tick", {
        method: "POST",
      });
      if (!r.ok) throw new Error(`tick failed: ${r.status}`);
      return (await r.json()) as TickReport;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["swarm-state"] });
    },
  });
}

/**
 * Autopilot: run a tick every `intervalMs` while ON.
 *
 * §3 Sequential Queue Model
 * -------------------------
 * Previously this used `setInterval`, which fires the next tick at the
 * fixed interval REGARDLESS of whether the previous tick has finished.
 * A tick that takes 8s with a 6s interval would pile up 2 concurrent
 * ticks, then 3, then 4 — each racing on the RevenueStream balance,
 * the stream lock, and the RevenueEvent migration loop.
 *
 * Now: recursive `setTimeout`. The next tick is scheduled ONLY after
 * the previous tick's promise settles (success or error). This is the
 * "sequential queue" model from Recommended Action Plan §3 — a new
 * job cannot start until the previous one finishes.
 *
 * Combined with the server-side global tick mutex (orchestrator.ts),
 * this gives 2-layer protection against tick overlap:
 *   Layer A (client): useAutopilot never fires a tick while one is in flight
 *   Layer B (server): tick() acquires `tick:global` with backoff+retry,
 *                     skips if contended, releases in finally
 *
 * If the user opens 2 browser tabs, both with autopilot on, Layer A
 * can't help (each tab has its own timer). Layer B will — one tab's
 * tick will acquire the lock, the other's will back off and skip.
 */
export function useAutopilot(intervalMs = 6000) {
  const [on, setOn] = useState(false);
  const tick = useTick();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Track whether a tick is in-flight so we don't schedule a new one
  // while the previous is still running. This is the Layer A guard.
  const tickingRef = useRef(false);

  useEffect(() => {
    if (!on) {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      tickingRef.current = false;
      return;
    }

    let cancelled = false;

    // Recursive setTimeout — schedules the next tick ONLY after the
    // previous tick's mutate() settles. If the previous tick is still
    // pending when the timer fires, we reschedule for +500ms.
    const scheduleNext = (delay: number) => {
      if (cancelled) return;
      timer.current = setTimeout(async () => {
        if (cancelled) return;
        // Layer A guard: if the previous tick is somehow still running
        // (e.g., a very slow Base44 window), push the next tick out.
        if (tickingRef.current) {
          scheduleNext(500);
          return;
        }
        tickingRef.current = true;
        try {
          await tick.mutateAsync();
        } catch {
          // Swallow — the error is surfaced via tick.error on the
          // returned hook state. We don't want a failed tick to stop
          // the autopilot loop.
        } finally {
          tickingRef.current = false;
        }
        if (!cancelled) scheduleNext(intervalMs);
      }, delay);
    };

    // Fire the first tick immediately, then schedule the next.
    scheduleNext(0);

    return () => {
      cancelled = true;
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      tickingRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, intervalMs]);

  return {
    on,
    setOn,
    isTicking: tick.isPending,
    lastReport: tick.data,
    lastError: tick.error,
  };
}

export function useToggleAgent() {
  const qc = useQueryClient();
  return useMutation<{ id: string; status: string }, Error, string>({
    mutationFn: async (agentId) => {
      const r = await fetch(`/api/agents/toggle?id=${agentId}`, {
        method: "POST",
      });
      if (!r.ok) throw new Error(`toggle failed: ${r.status}`);
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["swarm-state"] });
    },
  });
}

export function useIngestHits() {
  const qc = useQueryClient();
  return useMutation<{ ingested: number }, Error, void>({
    mutationFn: async () => {
      const r = await fetch("/api/orchestrator/ingest", { method: "POST" });
      if (!r.ok) throw new Error(`ingest failed: ${r.status}`);
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["swarm-state"] });
    },
  });
}

export function usePreviewHits(enabled = true) {
  return useQuery<{ hits: import("@/lib/hit-market").HIT[] }>({
    queryKey: ["preview-hits"],
    queryFn: async () => {
      const r = await fetch("/api/marketplace/hits?count=12", {
        cache: "no-store",
      });
      if (!r.ok) throw new Error(`hits fetch failed: ${r.status}`);
      return r.json();
    },
    enabled,
    refetchInterval: 15_000,
    staleTime: 10_000,
  });
}

export function useCreateMission() {
  const qc = useQueryClient();
  return useMutation<unknown, Error, Record<string, unknown>>({
    mutationFn: async (body) => {
      const r = await fetch("/api/missions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`create mission failed: ${r.status}`);
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["swarm-state"] });
    },
  });
}
