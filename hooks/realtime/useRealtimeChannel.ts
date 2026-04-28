"use client";
import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/browser";
import type { RealtimeChannel } from "@supabase/supabase-js";

export type RealtimeStatus =
  | "connecting"
  | "subscribed"
  | "channel_error"
  | "timed_out"
  | "closed";

export interface UseRealtimeChannelOpts {
  name: string;
  postgresChanges?: {
    event: "INSERT" | "UPDATE" | "DELETE" | "*";
    schema?: string;
    table: string;
    filter?: string;
  };
  broadcast?: { event: string };
  onChange: (payload: unknown) => void;
  enabled?: boolean;
}

export function useRealtimeChannel(opts: UseRealtimeChannelOpts): { status: RealtimeStatus } {
  const { name, postgresChanges, broadcast, onChange, enabled = true } = opts;

  // ref makes onChange identity-stable so changing handler doesn't re-subscribe
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  const [status, setStatus] = useState<RealtimeStatus>(enabled ? "connecting" : "closed");

  useEffect(() => {
    if (!enabled) {
      setStatus("closed");
      return;
    }
    const supabase = createClient();
    let channel: RealtimeChannel | null = supabase.channel(name);

    const handler = (payload: unknown) => {
      onChangeRef.current(payload);
    };

    if (postgresChanges) {
      channel = channel.on(
        "postgres_changes",
        {
          event: postgresChanges.event,
          schema: postgresChanges.schema ?? "public",
          table: postgresChanges.table,
          ...(postgresChanges.filter ? { filter: postgresChanges.filter } : {}),
        },
        handler,
      );
    }

    if (broadcast) {
      channel = channel.on("broadcast", { event: broadcast.event }, handler);
    }

    setStatus("connecting");
    channel.subscribe((s) => {
      // s is one of "SUBSCRIBED" | "CHANNEL_ERROR" | "TIMED_OUT" | "CLOSED"
      const map: Record<string, RealtimeStatus> = {
        SUBSCRIBED: "subscribed",
        CHANNEL_ERROR: "channel_error",
        TIMED_OUT: "timed_out",
        CLOSED: "closed",
      };
      setStatus(map[s] ?? "connecting");
    });

    return () => {
      if (channel) {
        supabase.removeChannel(channel);
        channel = null;
      }
    };
    // intentionally omit onChange (ref); only re-subscribe when channel topology changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, enabled, postgresChanges?.event, postgresChanges?.table, postgresChanges?.filter, postgresChanges?.schema, broadcast?.event]);

  return { status };
}
