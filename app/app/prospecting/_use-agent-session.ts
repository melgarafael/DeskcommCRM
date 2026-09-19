"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiClient } from "@/lib/api/client";
import type {
  AgentSessionResponse,
  AgentSetupSession,
} from "@/lib/prospecting/agent-session-schema";

const endpoint = "/api/v1/prospecting/agents/session";

/** One campaign owns one durable conversation. Saves are serialized, never last-write-wins. */
export function useAgentSetupSession(campaignId: string) {
  const [session, setSession] = useState<AgentSetupSession | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = useRef<AgentSetupSession | null>(null);
  const revision = useRef(0);
  const edit = useRef(0);
  const saved = useRef(0);
  const blocked = useRef(false);
  const mounted = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);
  const loadSequence = useRef(0);

  const accept = useCallback((response: AgentSessionResponse) => {
    current.current = response.session;
    revision.current = response.revision;
    saved.current = edit.current;
    blocked.current = false;
    if (mounted.current) {
      setSession(response.session);
      setError(null);
    }
  }, []);

  const reload = useCallback(async () => {
    const load = ++loadSequence.current;
    if (timer.current) clearTimeout(timer.current);
    if (inFlight.current) await inFlight.current.catch(() => {});
    try {
      const result = await apiClient.get<{ data: AgentSessionResponse }>(
        `${endpoint}?campaign_id=${campaignId}`,
      );
      if (load === loadSequence.current) accept(result.data);
      return result.data;
    } catch (cause) {
      if (load !== loadSequence.current) throw cause;
      blocked.current = true;
      if (mounted.current)
        setError(cause instanceof Error ? cause.message : "Não foi possível carregar a conversa.");
      throw cause;
    }
  }, [accept, campaignId]);

  const flush = useCallback(async (): Promise<void> => {
    if (timer.current) clearTimeout(timer.current);
    if (inFlight.current) return inFlight.current;
    if (blocked.current) throw new Error("Recarregue a conversa salva antes de continuar.");
    if (!current.current || edit.current === saved.current) return;
    if (mounted.current) setSaving(true);
    // The promise covers the entire drain, including edits typed during a save.
    // A send/prepare waiting for autosave therefore cannot start a parallel PATCH.
    const operation = (async () => {
      try {
        while (current.current && edit.current !== saved.current) {
          const snapshot = current.current;
          const sequence = edit.current;
          const result = await apiClient.patch<{ data: AgentSessionResponse }>(endpoint, {
            campaign_id: campaignId,
            revision: revision.current,
            session: {
              messages: snapshot.messages,
              draft: snapshot.draft,
              input: snapshot.input,
              enable_router_continuity: snapshot.enable_router_continuity,
              ...(snapshot.attempt
                ? { attempt: snapshot.attempt, attempt_action: snapshot.attempt_action }
                : {}),
              uncertain: snapshot.uncertain,
            },
          });
          revision.current = result.data.revision;
          saved.current = sequence;
          if (sequence === edit.current) accept(result.data);
        }
      } catch (cause) {
        blocked.current = true;
        if (mounted.current)
          setError(cause instanceof Error ? cause.message : "Não foi possível salvar a conversa.");
        throw cause;
      }
    })();
    inFlight.current = operation;
    try {
      await operation;
    } finally {
      inFlight.current = null;
      if (mounted.current) setSaving(false);
    }
  }, [accept, campaignId]);

  const change = useCallback(
    (values: Partial<AgentSetupSession>) => {
      if (!current.current) return;
      current.current = { ...current.current, ...values };
      edit.current++;
      setSession(current.current);
      setSaving(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush().catch(() => {}), 500);
    },
    [flush],
  );

  useEffect(() => {
    mounted.current = true;
    void Promise.resolve()
      .then(reload)
      .catch(() => {});
    return () => {
      mounted.current = false;
      if (timer.current) clearTimeout(timer.current);
      // Navigating between campaigns must not discard the text just entered.
      void flush().catch(() => {});
    };
  }, [flush, reload]);

  return { session, saving, error, change, flush, reload, accept, current, revision };
}
