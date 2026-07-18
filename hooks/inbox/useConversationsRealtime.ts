"use client";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { useRealtimeChannel } from "@/hooks/realtime/useRealtimeChannel";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import type { Conversation } from "@/lib/types/messaging";

export interface ContactSummary {
  id: string;
  display_name: string | null;
  name: string | null;
  phone_number: string | null;
  tags: string[];
  is_blocked: boolean;
  is_anonymized: boolean;
}

export type ConversationWithContact = Conversation & {
  contacts?: ContactSummary | null;
};

export interface ConversationsFilters {
  status?: "open" | "claimed" | "ai_handling" | "closed" | "archived";
  assigned_to?: "me" | "unassigned" | string;
  search?: string;
  channel_session_id?: string;
  tag?: string;
}

interface ListResponse {
  data: ConversationWithContact[];
  meta?: { cursor?: string | null; has_more?: boolean };
}

export function useConversationsRealtime(
  filters: ConversationsFilters,
  orgId: string | null,
) {
  const qc = useQueryClient();
  const queryKey = ["conversations", filters] as const;

  const query = useInfiniteQuery({
    queryKey,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
      const qs = new URLSearchParams();
      if (filters.status) qs.set("status", filters.status);
      if (filters.assigned_to) qs.set("assigned_to", filters.assigned_to);
      if (filters.search) qs.set("search", filters.search);
      if (filters.channel_session_id) qs.set("channel_session_id", filters.channel_session_id);
      if (filters.tag) qs.set("tag", filters.tag);
      if (pageParam) qs.set("cursor", pageParam);
      qs.set("limit", "50");
      try {
        return await apiClient.get<ListResponse>(`/api/v1/conversations?${qs.toString()}`);
      } catch (err) {
        showApiError(err);
        throw err;
      }
    },
    getNextPageParam: (last) =>
      last.meta?.has_more && last.meta.cursor ? last.meta.cursor : undefined,
  });

  const onChange = useCallback(() => {
    qc.invalidateQueries({ queryKey: ["conversations"] });
  }, [qc]);

  // G4-01 (visibility_mode): a subscription postgres_changes HERDA a RLS de
  // SELECT de `conversations` — o Supabase Realtime avalia as policies do usuário
  // autenticado antes de entregar cada change (docs: "Realtime respects RLS
  // policies"; requer a tabela na publication `supabase_realtime` + REPLICA
  // IDENTITY, já configurados na migration 0025). Como a policy `conversations_select`
  // (migration 0035) agora aplica fn_can_view_conversation(role + visibility_mode +
  // assigned_to), um agent NÃO recebe changes de conversa fora do seu escopo, mesmo
  // com o filtro amplo `organization_id=eq.<org>` abaixo. Prova do filtro em
  // tests/invariants/gov-5-visibility-scope.test.ts (SELECT sob role agent = 0 rows
  // para conversa de outro atendente — o mesmo SELECT que o Realtime executa).
  useRealtimeChannel({
    name: orgId ? `inbox-${orgId}` : "inbox-disabled",
    postgresChanges: orgId
      ? {
          event: "*",
          schema: "public",
          table: "conversations",
          filter: `organization_id=eq.${orgId}`,
        }
      : undefined,
    onChange,
    enabled: !!orgId,
  });

  return query;
}
