"use client";
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { useRealtimeChannel } from "@/hooks/realtime/useRealtimeChannel";
import { NoticeGate, NoticeBurst, type NoticeKind } from "@/lib/realtime/notice-contract";
export function useNoticeSignal(
  kind: NoticeKind,
  onRefresh: () => void,
  organizationId?: string,
  enabled = true,
) {
  const current = useRef(onRefresh);
  useLayoutEffect(() => {
    current.current = onRefresh;
  }, [onRefresh]);
  const active = useRef<{ gate: NoticeGate; burst: NoticeBurst } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const state = {
      gate: new NoticeGate(kind, organizationId),
      burst: new NoticeBurst(() => current.current()),
    };
    active.current = state;
    return () => {
      state.burst.close();
      if (active.current === state) active.current = null;
    };
  }, [kind, organizationId, enabled]);
  const onChange = useCallback((payload: unknown) => {
    const state = active.current;
    if (state && state.gate.consume(payload)) state.burst.request();
  }, []);
  return useRealtimeChannel({
    name: `notice-${kind}-${organizationId ?? "platform"}`,
    postgresChanges: {
      event: "*",
      schema: "public",
      table: "realtime_invalidations",
      filter: `table_name=eq.${kind}`,
    },
    enabled,
    onChange,
  });
}
