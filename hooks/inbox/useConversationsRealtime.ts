"use client";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { useRealtimeChannel } from "@/hooks/realtime/useRealtimeChannel";
import { useRefetchDeSeguranca } from "@/hooks/realtime/useRefetchDeSeguranca";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import type { Conversation } from "@/lib/types/messaging";
import type { ComandoDoBanco } from "@/lib/inbox/comando-da-conversa";

export interface ContactSummary {
  id: string;
  display_name: string | null;
  name: string | null;
  phone_number: string | null;
  tags: string[];
  is_blocked: boolean;
  is_anonymized: boolean;
  /** Caminho da foto no bucket privado. A tela nunca usa este valor como src —
   *  só para saber SE existe foto; a imagem vem de /api/v1/contacts/{id}/avatar,
   *  que assina a URL. Opcional: conversas em cache de antes do campo existir. */
  avatar_storage_path?: string | null;
  /**
   * A trava irrevogável pelo agente: ligada, NENHUM envio automático sai (o
   * guard de before-send lê esta coluna). É o sinal mais honesto de "a pessoa
   * está no comando desta conversa" — e o que decide se o botão de devolver o
   * atendimento aparece. Opcional: conversas em cache de antes do campo existir.
   */
  force_human?: boolean | null;
}

/**
 * O número POR ONDE a conversa entrou.
 *
 * Não é o número do cliente — é o da empresa. Com um canal só a distinção não
 * existe; com dois, saber por qual linha a pessoa escreveu é o que decide o tom
 * da resposta e qual número ela vai ver respondendo.
 */
export interface ChannelSummary {
  phone_number: string | null;
  display_name: string | null;
  /**
   * Quem impõe a regra deste número. A tela NÃO interpreta este valor — ela o
   * entrega a `estadoDaJanela` (lib/channels), que decide se há relógio a
   * mostrar. Ler o campo não é nomear o provider; o `if (provider === ...)` é
   * que a doutrina proíbe, e ele mora atrás do seam.
   */
  provider: string | null;
  social_platform?: string | null;
}

export type ConversationWithContact = Conversation & {
  contacts?: ContactSummary | null;
  channel_sessions?: ChannelSummary | null;
  /**
   * O nome de quem atende, resolvido no servidor.
   *
   * Opcional e nulável, e as duas coisas significam algo diferente: ausente é
   * resposta em cache de antes deste campo existir; `null` é um estado DECLARADO
   * — self-host sem service role, ou lookup que falhou (ver
   * `lib/users/nome-do-atendente.ts`). Nenhum dos dois quer dizer "sem
   * responsável": o dono é o `assigned_to_user_id`, o nome é a cortesia.
   */
  assigned_to_user_name?: string | null;
};

/** O vocabulário de LEITURA (7), que inclui os dois estados que só o motor escreve. */
export type StatusDeConversa =
  | "open"
  | "pending"
  | "resolved"
  | "claimed"
  | "ai_handling"
  | "closed"
  | "archived";

export interface ConversationsFilters {
  /** Um status ou vários — a aba Fila precisa de dois (open + pending). */
  status?: StatusDeConversa | readonly StatusDeConversa[];
  /** Esconde fechadas/arquivadas — ver `exclude_finished` no schema da rota. */
  exclude_finished?: boolean;
  assigned_to?: "me" | "unassigned" | string;
  /**
   * QUEM MANDA na conversa — o filtro que as abas Fila e Automático passaram a
   * usar (migration 0203). Pergunta diferente de `status`: aquele é ciclo de
   * vida, este é quem responde a próxima mensagem do cliente.
   */
  comando?: readonly ComandoDoBanco[];
  search?: string;
  /**
   * Só as que têm mensagem não lida para o dono. Vai ao BANCO — migration nenhuma,
   * a coluna `unread_count_for_assignee` já existe.
   */
  unread?: boolean;
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
  const queryKey = useMemo(() => ["conversations", filters] as const, [filters]);

  const query = useInfiniteQuery({
    queryKey,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
      const qs = new URLSearchParams();
      // Lista vira `open,pending`; valor único continua saindo como antes.
      if (filters.status) {
        const lista: readonly StatusDeConversa[] =
          typeof filters.status === "string" ? [filters.status] : filters.status;
        qs.set("status", lista.join(","));
      }
      // O `qs.set` é metade do trabalho, e é a metade que o typecheck NÃO pega:
      // com o campo no tipo e sem esta linha, a aba Fila pediria filtro nenhum e
      // mostraria a lista inteira — parecendo funcionar.
      if (filters.comando && filters.comando.length > 0) {
        qs.set("comando", filters.comando.join(","));
      }
      if (filters.exclude_finished) qs.set("exclude_finished", "true");
      if (filters.assigned_to) qs.set("assigned_to", filters.assigned_to);
      if (filters.search) qs.set("search", filters.search);
      if (filters.unread) qs.set("unread", "true");
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
    // Mesma razão do hilo de mensagens: o inbox é a tela em que a informação
    // chega de fora enquanto ninguém olha, e voltar para a aba é quando a
    // defasagem aparece. Segunda rede — a primeira é o Realtime.
    refetchOnWindowFocus: true,
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
  const { status: realtimeStatus, ultimaEntrega } = useRealtimeChannel({
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

  /**
   * A REDE DE SEGURANÇA — o inbox era a única tela viva que não tinha.
   *
   * O board e a linha do tempo do lead já a usavam; a lista de conversas só
   * tinha `refetchOnWindowFocus`, que exige a pessoa TROCAR DE ABA para
   * ressincronizar. Só que o inbox é a tela em que se fica parado olhando: com
   * o canal morto e a aba em foco, ela ficava congelada indefinidamente num
   * passado que parece presente — e o único conserto era o F5, que foi
   * exatamente o sintoma relatado.
   *
   * A assinatura é a contagem de conversas mais o maior `last_message_at`: é
   * sensível a tudo que o canal deveria ter trazido (conversa nova, mensagem
   * nova numa existente) e barata de calcular. `updated_at` não serviria
   * sozinho — o que muda a ordem da lista é a última mensagem.
   */
  const seguranca = useRefetchDeSeguranca<{ pages: ListResponse[] }>({
    queryKey,
    assinatura: (d) => {
      const conversas = d?.pages.flatMap((p) => p.data) ?? [];
      let maior = "";
      for (const c of conversas) {
        const t = c.last_message_at ?? "";
        if (t > maior) maior = t;
      }
      return `${conversas.length}:${maior}`;
    },
    ultimaEntrega,
    enabled: !!orgId,
  });

  return { ...query, realtimeStatus, seguranca };
}
