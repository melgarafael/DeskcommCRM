"use client";
import { useEffect, useLayoutEffect, useRef } from "react";
import { toast } from "sonner";
import { useActiveOrg, usePermission, useUser } from "@/hooks/auth/AuthProvider";
import { apiClient } from "@/lib/api/client";
import {
  EpisodeDrainCancelled,
  RetainedEpisodeDrain,
  type RetainedEpisode,
  type RetainedPage,
} from "@/lib/realtime/drain-retained-episodes";
interface CentralEpisode extends RetainedEpisode {
  title: string;
  body: string | null;
}
/** Mounted only by the visible bell. Existing list refetch/signal drives retries; no second sound source. */
export function useCentralEpisodeRecovery(listUpdatedAt: number) {
  const user = useUser(),
    org = useActiveOrg(),
    allowed = usePermission("ai.inbox.view");
  const identity = `${user.id}:${org?.orgId ?? ""}:${allowed}`;
  const current = useRef(identity);
  useLayoutEffect(() => {
    current.current = identity;
  }, [identity]);
  const refresh = useRef<() => void>(() => {});
  useEffect(() => {
    if (!allowed || !org) return;
    let alive = true,
      busy = false,
      again = false;
    let continuation: ReturnType<typeof setTimeout> | undefined;
    const drain = new RetainedEpisodeDrain<CentralEpisode>({
      isCurrent: () => alive && current.current === identity,
      page: async () =>
        (await apiClient.get<{ data: RetainedPage<CentralEpisode> }>("/api/v1/ai/inbox/episodes"))
          .data,
      present: async (item) => {
        if (typeof item.title !== "string" || (item.body !== null && typeof item.body !== "string"))
          throw new Error("invalid notice");
        toast.info(item.title, { description: item.body ?? undefined });
      },
      ack: async (items) => {
        await apiClient.post("/api/v1/ai/inbox/episodes", { items });
      },
    });
    const run = () => {
      if (!alive) return;
      if (busy) {
        again = true;
        return;
      }
      if (continuation !== undefined) {
        clearTimeout(continuation);
        continuation = undefined;
      }
      busy = true;
      void drain
        .drain()
        .then(({ more }) => {
          if (more && alive && current.current === identity) {
            // Yield between bounded batches; do not require a later list refresh to finish recovery.
            continuation = setTimeout(() => {
              continuation = undefined;
              run();
            }, 1_000);
          }
        })
        .catch((error) => {
          if (!(error instanceof EpisodeDrainCancelled) && alive)
            console.warn("[central-notice] recovery pending; retry on next authorized refresh");
        })
        .finally(() => {
          busy = false;
          if (again && alive) {
            again = false;
            run();
          }
        });
    };
    refresh.current = run;
    run();
    return () => {
      alive = false;
      drain.cancel();
      if (continuation !== undefined) clearTimeout(continuation);
      if (refresh.current === run) refresh.current = () => {};
    };
  }, [user.id, org?.orgId, allowed, identity]);
  useEffect(() => {
    refresh.current();
  }, [listUpdatedAt]);
}
