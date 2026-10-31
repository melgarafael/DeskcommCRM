import type { InfiniteData, QueryClient } from "@tanstack/react-query";
import { hashKey } from "@tanstack/react-query";
import type {
  ConversationsFilters,
  ConversationWithContact,
} from "@/hooks/inbox/useConversationsRealtime";
import {
  comandoDaConversa,
  STATUS_ENCERRADOS,
  type ComandoDoBanco,
} from "@/lib/inbox/comando-da-conversa";
import { marcadoresEscolhidos } from "@/lib/inbox/marcador-da-conversa";

/**
 * A ATUALIZAÇÃO DO REALTIME ENTRA NA LISTA QUE JÁ ESTÁ NA TELA (#2366).
 *
 * ─── O defeito que este arquivo fecha ───────────────────────────────────────
 * Uma automação aplica etiqueta ou estado numa conversa, o Realtime entrega um
 * `UPDATE` de `public.conversations`, e o inbox tratava TODO evento como "a
 * lista inteira está velha": `invalidateQueries(["conversations"])`, busca
 * completa. Para um evento que mudou UMA linha, a tela refazia a lista — é a
 * piscada que o operador relata, com a posição e o scroll indo junto. Pior: até
 * a resposta chegar, a linha afetada mostrava os valores VELHOS, então o efeito
 * visível era "nada aconteceu, e a lista tremeu".
 *
 * ─── Por que mesclar, e não só "não invalidar" ──────────────────────────────
 * Não invalidar seria trocar um problema por outro: a etiqueta nova nunca
 * apareceria. O evento JÁ traz a linha (`new`), completa — o trabalho é aplicá-la
 * no lugar certo, mantendo ordem, seleção e scroll, sem passar por estado de
 * carregamento.
 *
 * ─── O que NÃO é para esconder ─────────────────────────────────────────────
 *  - conversa NOVA: não está na lista, e pode ter entrado no filtro — quem sabe
 *    é o servidor. Aí (e só aí) a recarga continua, e é o que
 *    `aplicarAtualizacaoNaLista` devolve `false` para dizer;
 *  - conversa que SAI do filtro: sai de verdade, na hora, por
 *    `julgarAtualizacao` — a mesma régua de campos que o filtro pede ao banco;
 *  - filtro que o evento não consegue responder (busca livre, etiqueta do
 *    CONTATO): `indecidivel`, e a decisão volta para a recarga. Chutar "fica"
 *    aqui seria a tela afirmando um estado que não é o do servidor;
 *  - evento que muda a POSIÇÃO da linha (`CAMPOS_DA_ORDEM`): a lista é ordenada
 *    no servidor, e a conversa que acabou de receber mensagem tem de subir para
 *    o topo — mesclar no lugar a deixaria com o texto novo na posição velha.
 *
 * ─── O que o evento NÃO traz, e por isso não pode apagar ────────────────────
 * `contacts`, `channel_sessions` e `assigned_to_user_name` não são colunas de
 * `conversations`: são resolvidos na rota da lista. Mesclar o evento por cima da
 * linha em cache sem esta cerca apagaria o nome do cliente e o canal de TODA
 * conversa atualizada — a linha viraria "??" e o badge de canal sumiria.
 */

/** Uma página da lista, como o `useInfiniteQuery` a guarda. */
interface PaginaDaLista {
  data: ConversationWithContact[];
  meta?: { cursor?: string | null; has_more?: boolean };
}

type ListaEmCache = InfiniteData<PaginaDaLista>;

/** Campos que a ROTA resolve e o evento de `conversations` não carrega. */
const RESOLVIDOS_NA_ROTA = new Set(["contacts", "channel_sessions", "assigned_to_user_name"]);

/**
 * OS CAMPOS QUE DÃO A POSIÇÃO DE CADA LINHA — e que, por isso, a mescla NÃO
 * pode assumir que "fica onde estava".
 *
 * A lista é ordenada no servidor: por `last_message_at` desc fora da Fila, e por
 * `awaiting_since` asc na Fila (`ORDEM_DA_ESPERA`). Quando um destes muda, a
 * linha pode ter de ANDAR — e é exatamente o que a tela precisa mostrar: a
 * conversa que acabou de receber mensagem vai para o topo (é o que o e2e
 * `inbox-tempo-real` assere no PRIMEIRO item, e o que a pílula "Aguardando há…"
 * promete). Mesclar no lugar deixaria a conversa com o texto novo na posição
 * velha — uma lista plausível e desordenada, que é pior que a piscada.
 *
 * Quem sabe reordenar (com o desempate por `id` e a paginação por cursor) é o
 * servidor: mudou a ordem, o evento vira recarga.
 */
const CAMPOS_DA_ORDEM = [
  "last_message_at",
  "awaiting_since",
  "last_inbound_at",
  "last_outbound_at",
] as const;

/** A atualização muda onde a linha deveria estar? */
export function mudouAOrdem(
  anterior: ConversationWithContact,
  atualizacao: Record<string, unknown>,
): boolean {
  return CAMPOS_DA_ORDEM.some((campo) => {
    const valor = atualizacao[campo];
    if (valor === undefined) return false;
    return valor !== (anterior as unknown as Record<string, unknown>)[campo];
  });
}

/**
 * A linha de `conversations` que um evento do Realtime entrega — só para
 * `UPDATE`, e só com `id`.
 *
 * INSERT e DELETE ficam de fora de propósito: os dois mudam QUAIS conversas
 * pertencem à lista (entrou / saiu do conjunto), e é exatamente o que o cliente
 * não tem como decidir sozinho.
 */
export function conversaAtualizada(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== "object") return null;
  const evento = payload as { eventType?: unknown; table?: unknown; new?: unknown };
  if (evento.eventType !== "UPDATE") return null;
  if (typeof evento.table === "string" && evento.table !== "conversations") return null;
  const linha = evento.new;
  if (!linha || typeof linha !== "object") return null;
  const id = (linha as { id?: unknown }).id;
  if (typeof id !== "string" || id.length === 0) return null;
  return linha as Record<string, unknown>;
}

/**
 * A linha em cache com os valores do evento por cima — mantendo o que o evento
 * não sabe (`RESOLVIDOS_NA_ROTA`).
 *
 * `undefined` não sobrescreve: no payload do Realtime, ausente significa "não veio
 * nesta entrega", nunca "foi apagado".
 */
export function mesclarConversa(
  anterior: ConversationWithContact,
  atualizacao: Record<string, unknown>,
): ConversationWithContact {
  const mesclada: Record<string, unknown> = { ...anterior };
  for (const [campo, valor] of Object.entries(atualizacao)) {
    if (valor === undefined || RESOLVIDOS_NA_ROTA.has(campo)) continue;
    mesclada[campo] = valor;
  }
  // O nome de quem atende é resolvido no servidor a partir do `assigned_to_user_id`.
  // Dono novo com nome velho é pior que nome nenhum: a linha diria que a conversa
  // foi para a pessoa anterior.
  if (
    "assigned_to_user_id" in atualizacao &&
    atualizacao.assigned_to_user_id !== anterior.assigned_to_user_id
  ) {
    delete mesclada.assigned_to_user_name;
  }
  return mesclada as unknown as ConversationWithContact;
}

/** O que a atualização faz com a conversa, do ponto de vista do filtro da aba. */
export type Julgamento = "fica" | "sai" | "indecidivel";

/**
 * A conversa ainda pertence a esta lista depois da atualização?
 *
 * A régua é a MESMA dos filtros que a rota pede ao banco, e é aplicada sobre o
 * par (linha em cache, evento). Para `assigned_to: "me"` a pergunta é feita ao
 * contrário de propósito: a linha já estava nesta lista porque era minha, então
 * "continua sendo minha?" é `assigned_to_user_id` não mudou — e não exige saber
 * quem é o usuário logado aqui.
 */
export function julgarAtualizacao(
  anterior: ConversationWithContact,
  atualizacao: Record<string, unknown>,
  filtros: ConversationsFilters,
): Julgamento {
  // Busca livre e etiqueta: a busca olha o conteúdo e o marcador olha TAMBÉM o
  // contato (`contacts.tags_do_contato`, ver `_handler.ts`). Nenhum dos dois está
  // no evento de `conversations` — julgar aqui seria inventar.
  if (filtros.search?.trim()) return "indecidivel";
  const marcadores = marcadoresEscolhidos(
    typeof filtros.tag === "string" ? [filtros.tag] : (filtros.tag ?? []),
  );
  if (marcadores.length > 0) return "indecidivel";

  const atual = mesclarConversa(anterior, atualizacao);

  if (filtros.status) {
    // `readonly string[]` e não o tipo do filtro: a linha do evento chega como
    // `string`, e o que se compara aqui é o VALOR, não o vocabulário.
    const aceitos: readonly string[] =
      typeof filtros.status === "string" ? [filtros.status] : filtros.status;
    if (!aceitos.includes(atual.status)) return "sai";
  }
  if (filtros.exclude_finished && STATUS_ENCERRADOS.has(atual.status)) return "sai";

  if (filtros.assigned_to === "me") {
    // Ver o comentário acima: a lista já era a minha, então o que tira a conversa
    // dela é o dono TER MUDADO.
    if (atual.assigned_to_user_id !== anterior.assigned_to_user_id) return "sai";
  } else if (filtros.assigned_to === "unassigned") {
    if (atual.assigned_to_user_id !== null) return "sai";
  } else if (filtros.assigned_to) {
    if (atual.assigned_to_user_id !== filtros.assigned_to) return "sai";
  }

  if (filtros.unread && (atual.unread_count_for_assignee ?? 0) <= 0) return "sai";
  if (filtros.channel_session_id && atual.channel_session_id !== filtros.channel_session_id) {
    return "sai";
  }
  if (filtros.is_group !== undefined && Boolean(atual.is_group) !== filtros.is_group) return "sai";

  if (filtros.comando && filtros.comando.length > 0) {
    // `comandoDaConversa` é a régua única de "quem manda" (a linha da lista usa a
    // MESMA). O fato org-wide vai `undefined` = "não sei", que a função trata
    // assumindo que há automático — a Fila pede `aguardando` e `automatico`
    // juntos (`comandosDaFila`), então a ambiguidade não muda a resposta.
    const { comando } = comandoDaConversa({
      status: String(atual.status),
      assigned_to_user_id: atual.assigned_to_user_id ?? null,
      assigned_to_user_name: atual.assigned_to_user_name ?? null,
      assignee_kind: atual.assignee_kind ?? null,
      bot_silenced_until: atual.bot_silenced_until ?? null,
      last_handoff_reason: atual.last_handoff_reason ?? null,
      force_human: atual.contacts?.force_human ?? null,
      is_blocked: atual.contacts?.is_blocked ?? null,
      is_group: atual.is_group ?? false,
    });
    // `ninguem` é o mesmo balde do `automatico` no vocabulário do banco.
    const noVocabularioDoBanco: ComandoDoBanco =
      comando.quem === "ninguem" ? "automatico" : comando.quem;
    if (!filtros.comando.includes(noVocabularioDoBanco)) return "sai";
  }

  return "fica";
}

/** A lista com a linha trocada no LUGAR dela — e removida quando ela sai do filtro. */
function mesclarPaginas(
  listas: ListaEmCache | undefined,
  atualizacao: Record<string, unknown>,
  filtros: ConversationsFilters,
): ListaEmCache | undefined {
  if (!listas) return listas;
  const id = atualizacao.id as string;
  return {
    ...listas,
    pages: listas.pages.map((pagina) => {
      const indice = pagina.data.findIndex((c) => c.id === id);
      if (indice < 0) return pagina;
      const anterior = pagina.data[indice];
      if (!anterior) return pagina;
      if (julgarAtualizacao(anterior, atualizacao, filtros) === "sai") {
        return { ...pagina, data: pagina.data.filter((c) => c.id !== id) };
      }
      const data = pagina.data.slice();
      data[indice] = mesclarConversa(anterior, atualizacao);
      return { ...pagina, data };
    }),
  };
}

/**
 * Aplica o evento na lista que está na tela (e nas outras listas em cache).
 *
 * Devolve `true` quando o evento foi resolvido SEM rede — o chamador só chama a
 * recarga quando isto devolve `false`, que é o caso de "não sei responder daqui":
 * evento que não é `UPDATE` de conversa, linha fora da lista (pode ter ENTRADO no
 * filtro), lista ainda sem dado, ou filtro indecidível.
 */
export function aplicarAtualizacaoNaLista(
  qc: QueryClient,
  chaveAtiva: readonly unknown[],
  filtrosAtivos: ConversationsFilters,
  payload: unknown,
): boolean {
  const atualizacao = conversaAtualizada(payload);
  if (!atualizacao) return false;
  const id = atualizacao.id as string;

  const ativa = qc.getQueryData<ListaEmCache>(chaveAtiva);
  const naAtiva = ativa?.pages.flatMap((p) => p.data).find((c) => c.id === id);
  if (!naAtiva) return false;
  // A posição da linha mudou: reordenar é do servidor (ver `CAMPOS_DA_ORDEM`).
  if (mudouAOrdem(naAtiva, atualizacao)) return false;
  if (julgarAtualizacao(naAtiva, atualizacao, filtrosAtivos) === "indecidivel") return false;

  qc.setQueryData<ListaEmCache>(chaveAtiva, (listas) =>
    mesclarPaginas(listas, atualizacao, filtrosAtivos),
  );

  // As outras abas em cache (a anterior, a que a pessoa vai reabrir). Cada uma é
  // julgada pelo filtro DELA: a mesma conversa pode continuar em "Todas" e sair
  // da Fila. As que não dá para julgar ficam intocadas e se recarregam ao montar.
  for (const [chave, listas] of qc.getQueriesData<ListaEmCache>({ queryKey: ["conversations"] })) {
    if (hashKey(chave) === hashKey(chaveAtiva)) continue;
    const daquela = listas?.pages.flatMap((p) => p.data).find((c) => c.id === id);
    if (!daquela) continue;
    const filtrosDaquela = chave[1] as ConversationsFilters;
    if (julgarAtualizacao(daquela, atualizacao, filtrosDaquela) === "indecidivel") continue;
    qc.setQueryData<ListaEmCache>(chave, (atuais) =>
      mesclarPaginas(atuais, atualizacao, filtrosDaquela),
    );
  }

  /**
   * A CONVERSA ABERTA, quando já está em cache.
   *
   * Antes ela vinha pela mesma recarga (`["conversation"]` invalidada junto com a
   * lista) — e é por isso que ela não pode ficar de fora: o cabeçalho leria o
   * estado anterior à automação. Mesma linha, mesma mesclagem, zero rede.
   */
  qc.setQueryData<ConversationWithContact>(["conversation", id], (aberta) =>
    aberta ? mesclarConversa(aberta, atualizacao) : aberta,
  );

  return true;
}
