import type { InfiniteData } from "@tanstack/react-query";

/**
 * A MENSAGEM QUE CHEGA PELO REALTIME ENTRA NO FIO SEM REDE (#4325 item 5).
 *
 * ─── O que este arquivo substitui ───────────────────────────────────────────
 * `useMessagesRealtime` invalidava `["messages", conversaId]` a cada evento do
 * canal. Numa `useInfiniteQuery` isso refaz TODAS as páginas do histórico: quem
 * rolou três páginas para trás pagava três GET por mensagem — e o canal também
 * entrega os `UPDATE` de confirmação (enviada, entregue, lida), que chegam
 * vários por mensagem enviada. Na prática, a conversa aberta era a tela mais
 * caríssima do inbox, e por um evento que já traz a linha inteira.
 *
 * ─── Por que mesclar é seguro aqui, e não no caso das conversas ─────────────
 * A lista de conversas é ordenada NO SERVIDOR e cada linha carrega joins que o
 * evento não tem (`contacts`, `channel_sessions`) — por isso lá a mescla é
 * cercada por `atualizacao-da-lista.ts` e desiste em vários casos.
 *
 * O fio da conversa é o oposto: as páginas vêm em ordem de `sent_at` desc, a
 * página 0 é sempre a MAIS NOVA, e a linha de `messages` que o evento entrega é
 * exatamente a linha que a rota devolve (nomes de quem enviou só existem como
 * campo derivado, e o evento não os apaga — `undefined` não sobrescreve).
 * Então:
 *
 *  - `INSERT` entra no TOPO de `pages[0]`, e a conversa cresce sem GET;
 *  - `UPDATE` de confirmação é mesclado PELO `id`, na página onde a mensagem
 *    estiver (o status é a única coisa que muda, e ela aparece no balão);
 *  - `DELETE` sai de onde estiver.
 *
 * ─── O que continua sendo rede ──────────────────────────────────────────────
 * Nada, no caminho comum. O que não dá para aplicar (payload sem `id`, cache
 * ainda sem página) devolve `null`, e o chamador decide — hoje, invalidar, que
 * é o comportamento de antes. E a rede de segurança (`useRefetchDeSeguranca`)
 * segue no lugar: se a mescla perder um evento, é ela que percebe pela
 * assinatura (contagem + id do topo) e ressincroniza.
 */

/** Uma página do fio, do jeito que o `useInfiniteQuery` a guarda. */
export interface PaginaDeMensagens {
  data: Array<Record<string, unknown>>;
  meta?: { cursor?: string | null; has_more?: boolean };
}

type FioEmCache = InfiniteData<PaginaDeMensagens>;

export type EventoDeMensagem =
  | { tipo: "insercao"; linha: Record<string, unknown> }
  | { tipo: "atualizacao"; linha: Record<string, unknown> }
  | { tipo: "remocao"; id: string };

function linhaComId(valor: unknown): Record<string, unknown> | null {
  if (!valor || typeof valor !== "object") return null;
  const linha = valor as Record<string, unknown>;
  return typeof linha.id === "string" && linha.id.length > 0 ? linha : null;
}

/**
 * O evento do canal, traduzido — `null` para o que não é evento de `messages`
 * (o canal é assinado só nessa tabela, mas o payload chega como `unknown`).
 */
export function eventoDeMensagem(payload: unknown): EventoDeMensagem | null {
  if (!payload || typeof payload !== "object") return null;
  const evento = payload as { eventType?: unknown; table?: unknown; new?: unknown; old?: unknown };

  if (typeof evento.table === "string" && evento.table !== "messages") return null;

  if (evento.eventType === "INSERT" || evento.eventType === "UPDATE") {
    const linha = linhaComId(evento.new);
    if (!linha) return null;
    return { tipo: evento.eventType === "INSERT" ? "insercao" : "atualizacao", linha };
  }

  if (evento.eventType === "DELETE") {
    // O `old` do DELETE depende do REPLICA IDENTITY da tabela (default: só a
    // PK, que é o que precisamos). Sem id não há o que remover.
    const linha = linhaComId(evento.old);
    if (!linha) return null;
    return { tipo: "remocao", id: linha.id as string };
  }

  return null;
}

/** Os campos do evento por cima da mensagem em cache; ausente não apaga. */
function mesclar(
  mensagem: Record<string, unknown>,
  atualizacao: Record<string, unknown>,
): Record<string, unknown> {
  const mesclada = { ...mensagem };
  for (const [campo, valor] of Object.entries(atualizacao)) {
    if (valor !== undefined) mesclada[campo] = valor;
  }
  return mesclada;
}

/**
 * O fio em cache com o evento aplicado — ou `null` quando não há onde aplicar.
 *
 * `INSERT` de uma mensagem que já está no cache é IGNORADO: o canal pode
 * reentregar, e duplicar o balão é pior que não fazer nada (a rede de segurança
 * confere a assinatura de qualquer forma).
 */
export function aplicarEventoNoFio(
  dados: FioEmCache | undefined,
  evento: EventoDeMensagem,
): FioEmCache | null {
  if (!dados || !Array.isArray(dados.pages) || dados.pages.length === 0) return null;
  const primeira = dados.pages[0];
  if (!primeira || !Array.isArray(primeira.data)) return null;

  const id = evento.tipo === "remocao" ? evento.id : (evento.linha.id as string);
  const jaNoFio = dados.pages.some((p) => p.data.some((m) => m.id === id));

  if (evento.tipo === "insercao") {
    if (jaNoFio) return dados;
    return {
      ...dados,
      pages: [{ ...primeira, data: [evento.linha, ...primeira.data] }, ...dados.pages.slice(1)],
    };
  }

  if (!jaNoFio) return null;

  if (evento.tipo === "remocao") {
    return {
      ...dados,
      pages: dados.pages.map((p) =>
        p.data.some((m) => m.id === id) ? { ...p, data: p.data.filter((m) => m.id !== id) } : p,
      ),
    };
  }

  return {
    ...dados,
    pages: dados.pages.map((p) =>
      p.data.some((m) => m.id === id)
        ? {
            ...p,
            data: p.data.map((m) => (m.id === id ? mesclar(m, evento.linha) : m)),
          }
        : p,
    ),
  };
}
