"use client";
import { useSyncExternalStore } from "react";

import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import {
  type ModoDeEtiqueta,
  marcadoresEscolhidos,
} from "@/lib/inbox/marcador-da-conversa";

export interface ConversationCounts {
  /**
   * OPCIONAIS de propósito: um cache de react-query gravado antes deste deploy
   * não tem estes campos, e a tela lê o cache antes da primeira resposta nova.
   * Marcá-los obrigatórios daria `undefined` onde o tipo promete `number` — e o
   * badge imprimiria "NaN" no primeiro segundo depois de atualizar.
   */
  fila?: number;
  automatico?: number;
  /** Nome antigo de `fila`, mantido pela rota versionada. Prefira `fila`. */
  unassigned: number;
  mine: number;
  all: number;
  /** Opcional pelo mesmo motivo dos de cima: cache gravado antes deste deploy não tem. */
  closed?: number;
  /** A aba "Arquivadas" (#923). Opcional pelo mesmo motivo: cache antigo não tem. */
  archived?: number;
  /**
   * As abas cujo número é ESTIMATIVA do planejador (#4325). Opcional pelo mesmo
   * motivo dos de cima: um cache gravado antes deste deploy não tem o campo, e
   * a tela não pode tratar "cache antigo" como "tudo exato" — sem o campo ela
   * simplesmente não marca nada até a primeira resposta nova.
   */
  aproximadas?: readonly ("closed" | "archived")[];
  /**
   * Quantas conversas ESPERAM gente em cada fila (#3876), por id de setor. É o
   * número que o seletor mostra ao lado do nome de cada fila. Opcional pela
   * mesma razão dos de cima, e vazio quando a organização não usa setores.
   */
  por_fila?: Record<string, number>;
}

/** Os filtros auxiliares ligados na barra, que a contagem tem de aplicar junto. */
export interface FiltrosDaContagem {
  unread?: boolean;
  /**
   * A etiqueta, ou VÁRIAS (#1274).
   *
   * O badge conta o MESMO que a lista mostra, então ele recebe a MESMA lista. E
   * `append`, nunca `set`: com `set` a segunda etiqueta substituiria a primeira e
   * o badge contaria um filtro diferente do que a lista aplicou — a divergência
   * que o módulo inteiro existe para impedir.
   */
  tag?: string | readonly string[];
  /** E ou OU entre as etiquetas escolhidas (#1274). `e` é o padrão. */
  tagMode?: ModoDeEtiqueta;
  channel_session_id?: string;
  /** O atendente escolhido pelo gerente — as contagens olham só as dele. */
  assigned_to?: string;
  /**
   * A fila escolhida (#3876). Entra na chave da query como os outros: o badge
   * tem de contar a fila que a lista mostra, não o total da aba.
   */
  sector_id?: string;
}

/**
 * De quanto em quanto tempo o badge se refaz com a aba do navegador VISÍVEL.
 *
 * 30 s é a cadência que a tela já tinha. O que mudou (#4325) é o que acontece
 * quando ninguém está olhando: nada.
 */
export const INTERVALO_DAS_CONTAGENS_MS = 30_000;

/**
 * "A aba do navegador está à vista?" — como ESTADO, não como leitura solta.
 *
 * ─── Por que virou estado ──────────────────────────────────────────────────
 *
 * O React Query já não BUSCA com o documento oculto (`refetchIntervalInBackground`
 * é `false` por padrão), mas isso é default de biblioteca: o intervalo seguia
 * ARMADO, disparando a cada 30 s para, dentro do callback, descobrir que não
 * devia buscar. A garantia também desapareceria no dia em que qualquer
 * `defaultOptions` global ligasse o refetch em segundo plano.
 *
 * Aqui a ocultação DESARMA o intervalo (`false`), porque ela re-renderiza o hook
 * e o React Query recalcula os timers. Ao voltar, o intervalo volta e o próprio
 * React Query refaz por foco — o número se atualiza sem polling cego no meio.
 */
function assinarVisibilidade(aoMudar: () => void): () => void {
  if (typeof document === "undefined") return () => {};
  document.addEventListener("visibilitychange", aoMudar);
  return () => document.removeEventListener("visibilitychange", aoMudar);
}

function lerVisibilidade(): boolean {
  return typeof document === "undefined" || document.visibilityState === "visible";
}

function useDocumentoVisivel(): boolean {
  // #4325: inicializador de `useState` que lê o navegador roda DE NOVO na
  // hidratação, com `window` de verdade, e o cliente diverge do HTML que o
  // servidor mandou (cerca `hidratacao-useState-nao-le-o-navegador`). Com
  // `useSyncExternalStore` o snapshot do servidor é determinístico e o do
  // cliente só é lido depois da montagem.
  return useSyncExternalStore(assinarVisibilidade, lerVisibilidade, () => true);
}

/**
 * Contagens por visão do inbox (G4-02). O endpoint usa o client RLS-scoped —
 * um agent em modo own* recebe a contagem do seu escopo, não o total da org.
 */
export function useConversationCounts(
  orgId: string | null,
  filtros: FiltrosDaContagem = {},
) {
  const documentoVisivel = useDocumentoVisivel();
  const qs = new URLSearchParams();
  if (filtros.unread) qs.set("unread", "true");
  for (const marcador of marcadoresEscolhidos(
    typeof filtros.tag === "string" ? [filtros.tag] : (filtros.tag ?? []),
  ))
    qs.append("tag", marcador);
  // Só `ou` viaja: `e` é o padrão, e mandar `&modo=e` num link de hoje mudaria a
  // URL sem mudar o sentido do filtro.
  if (filtros.tagMode === "ou") qs.set("modo", "ou");
  if (filtros.channel_session_id) qs.set("channel_session_id", filtros.channel_session_id);
  if (filtros.assigned_to) qs.set("assigned_to", filtros.assigned_to);
  if (filtros.sector_id) qs.set("sector_id", filtros.sector_id);
  const sufixo = qs.toString();

  return useQuery({
    // ⚠️ OS FILTROS ENTRAM NA CHAVE. Sem isso o react-query devolveria a contagem
    // guardada para OUTRO conjunto de filtros, sem ir ao servidor — e o badge
    // voltaria a mentir, agora pelo cache. Seria o mesmo defeito por outra porta.
    queryKey: ["conversation-counts", orgId, sufixo],
    enabled: !!orgId,
    // #4325: nada de refazer as cegas. Com o documento oculto o intervalo é
    // `false` (desarmado), e a garantia não fica dependendo de default de
    // biblioteca: `refetchIntervalInBackground: false` é declarado aqui.
    refetchIntervalInBackground: false,
    refetchInterval: documentoVisivel ? INTERVALO_DAS_CONTAGENS_MS : false,
    queryFn: () =>
      apiClient
        .get<{ data: ConversationCounts }>(
          `/api/v1/conversations/counts${sufixo ? `?${sufixo}` : ""}`,
        )
        .then((r) => r.data),
  });
}
