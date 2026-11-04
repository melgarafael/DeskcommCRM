"use client";
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiClient } from "@/lib/api/client";
import { useNoticeSignal } from "@/hooks/realtime/useNoticeSignal";
import {
  RetainedEpisodeDrain,
  EpisodeDrainCancelled,
  type RetainedPage,
} from "@/lib/realtime/drain-retained-episodes";
import { formatDerivedNotice, type DerivedNotice } from "@/lib/realtime/derived-notice";
export function useAlertsRealtime(actorId: string) {
  const qc = useQueryClient();
  const actor = useRef(actorId);
  useLayoutEffect(() => {
    actor.current = actorId;
  }, [actorId]);
  const request = useRef<() => void>(() => {});
  const refresh = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ["admin", "dashboard", "kpis"] });
    request.current();
  }, [qc]);
  useNoticeSignal("platform_alerts", refresh);
  useEffect(() => {
    let alive = true,
      busy = false,
      again = false;
    const uid = actorId;
    const drain = new RetainedEpisodeDrain<DerivedNotice>(
      {
        isCurrent: () => alive && actor.current === uid,
        page: async () =>
          (
            await apiClient.get<{ data: RetainedPage<DerivedNotice> }>(
              "/api/v1/admin/notices/episodes",
            )
          ).data,
        present: async (item) => {
          const text = formatDerivedNotice(item);
          toast.warning(`Novo ${text.label}`, { description: text.message });
        },
        ack: async (items) => {
          await apiClient.post("/api/v1/admin/notices/episodes", { items });
        },
      },
      10,
      "persisted_derived_episodes",
    );
    const run = () => {
      if (!alive) return;
      if (busy) {
        again = true;
        return;
      }
      busy = true;
      void drain
        .drain()
        .catch((error) => {
          if (!(error instanceof EpisodeDrainCancelled) && alive)
            console.warn("[derived-notice] recovery pending; retry on next authorized refresh");
        })
        .finally(() => {
          busy = false;
          if (again && alive) {
            again = false;
            run();
          }
        });
    };
    request.current = run;
    const timer = setInterval(run, 30_000);
    run();
    return () => {
      alive = false;
      drain.cancel();
      clearInterval(timer);
      if (request.current === run) request.current = () => {};
    };
  }, [actorId]);
}
