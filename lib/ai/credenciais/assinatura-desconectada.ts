/**
 * A ASSINATURA DESCONECTADA NÃO FICA DESCONECTADA EM SILÊNCIO (#3371, fatia 2).
 *
 * ## O que aconteceu em produção
 *
 * Cliente Obralivre: `401 · Provided authentication token is expired` em 107
 * turnos seguidos, ~26 h sem a IA responder, cota sobrando — e a Central de
 * avisos VAZIA. Quem olhava a operação não tinha por que suspeitar da conta: o
 * único vestígio era a linha de `llm_calls`, que ninguém abre para descobrir que
 * o problema é um login vencido.
 *
 * ## A regra, e só ela
 *
 * Sem banco e sem rede (é ela que precisa de casos): UM item por incidente —
 * 107 turnos não podem virar 107 avisos —, aberto quando o provedor recusa o
 * token COM sinal de expiração e a renovação também foi recusada, e FECHADO
 * sozinho quando o login volta (mesmo padrão do `canal-pausado` do #2389: aviso
 * que só sai no clique de alguém vira lista que ninguém lê).
 *
 * Quem aplica é `./aviso-da-assinatura.ts`, chamado pelo seam do turno (que
 * abre) e pela rota que recebe o login novo (que fecha).
 */

/** O kind em `agent_inbox_items` (vocabulário fechado por CHECK, migration 9027). */
export const KIND_ASSINATURA_DESCONECTADA = "assinatura_desconectada" as const;

/** O título do item. Diz a CONSEQUÊNCIA para quem atende, não o token. */
export const TITULO_DO_AVISO_DE_ASSINATURA =
  "A conta do ChatGPT desconectou — a IA parou de responder";

/** O item aberto desta organização, se houver — um incidente = um item. */
export interface ItemDaAssinaturaAberto {
  id: string;
  body: string | null;
}

/** O que a decisão precisa saber. Nada de token, nada de mensagem do provedor. */
export interface SituacaoDaAssinatura {
  /**
   * O login voltou? `true` = a credencial renovou (ou foi reconectada), e o
   * aviso fecha sozinho. `false` = houve recusa.
   */
  conectada: boolean;
  /**
   * O motivo da recusa, no vocabulário da fatia 3 (`refresh_token_revoked`,
   * `invalid_grant`, `token_expired`, `fetch_failed`, `timeout`, `recusado`,
   * `desconhecido`). `null` = a falha NÃO é de login (rede, cota, 5xx): aí não
   * se anuncia conta desconectada, porque reconectar não conserta nada.
   */
  recusa: string | null;
}

export type DecisaoDoAvisoDaAssinatura =
  /** Recusou e não havia item: nasce um. */
  | { acao: "abrir"; titulo: string; corpo: string }
  /** Recusou de novo com o item aberto: atualiza o corpo, nunca um segundo. */
  | { acao: "atualizar"; item: ItemDaAssinaturaAberto; titulo: string; corpo: string }
  /** O login voltou com o item aberto: fecha sozinho, com o motivo no corpo. */
  | { acao: "resolver"; item: ItemDaAssinaturaAberto; corpo: string }
  /** Nada a fazer: sem item e sem recusa, ou já resolvido. */
  | { acao: "nada" };

/**
 * O motivo cru vira frase. Sem isto o corpo do aviso mostraria
 * `refresh_token_revoked` para o dono do negócio — que decide entre reconectar
 * a conta e chamar o suporte.
 */
const MOTIVO_LEGIVEL: Record<string, string> = {
  refresh_token_revoked:
    "a OpenAI revogou o acesso da conta — alguém desconectou, ou o token foi trocado fora daqui",
  invalid_grant: "a OpenAI recusou o pedido de renovação do login",
  token_expired: "o login venceu e a renovação não foi aceita",
  fetch_failed: "não foi possível falar com a OpenAI para renovar o login",
  timeout: "a OpenAI não respondeu a tempo de renovar o login",
  recusado: "a OpenAI recusou a renovação do login",
  desconhecido: "a renovação do login falhou sem motivo identificado",
};

/**
 * A frase do motivo; um motivo fora do vocabulário não vira jargão na tela.
 *
 * O turno entrega `<motivo>:<rótulo>` (ex.: `falha:refresh_token_revoked`, de
 * `run-model-call.ts`), não o rótulo puro — por isso o mapa é consultado pelo
 * que vem depois do último `:`. Sem isso todo aviso real dizia "sem motivo
 * identificado".
 */
export function motivoLegivelDaAssinatura(recusa: string): string {
  const rotulo = recusa.slice(recusa.lastIndexOf(":") + 1);
  return MOTIVO_LEGIVEL[rotulo] ?? MOTIVO_LEGIVEL.desconhecido!;
}

/**
 * O corpo do aviso que PEDE a reconexão. Sem data e sem token: o corpo é lido
 * por qualquer pessoa da equipe, e a linha do item já carrega o horário.
 */
export function corpoDoAvisoDeAssinatura(recusa: string): string {
  return (
    `A conta do ChatGPT que atende esta empresa foi recusada: ${motivoLegivelDaAssinatura(recusa)}.\n\n` +
    "Enquanto isso, a IA não responde aos clientes que escrevem — as mensagens chegam e ficam sem resposta. " +
    "A cota da assinatura NÃO é o problema.\n\n" +
    "Para voltar: reconecte a conta em IA › Credenciais. Este aviso se fecha sozinho quando o login voltar."
  );
}

/** A frase do fechamento, para "o login voltou" não ficar igual a "alguém fechou". */
export const CORPO_DA_RESOLUCAO_DA_ASSINATURA =
  "Resolvido pelo sistema: o login da conta foi renovado e a IA voltou a responder.";

/**
 * A decisão, para UMA organização, num instante.
 *
 * A ordem importa: o login voltando resolve SEMPRE (inclusive item aberto por um
 * incidente anterior), e só a recusa de LOGIN abre item. Recusa que não é de
 * login (`recusa === null`) não pode anunciar conta desconectada — mandaria o
 * operador reconectar uma conta que está boa.
 */
export function avaliarAvisoDaAssinatura(
  situacao: SituacaoDaAssinatura,
  item: ItemDaAssinaturaAberto | null,
): DecisaoDoAvisoDaAssinatura {
  if (situacao.conectada) {
    if (!item) return { acao: "nada" };
    const anterior = (item.body ?? "").trim();
    return {
      acao: "resolver",
      item,
      corpo:
        anterior === ""
          ? CORPO_DA_RESOLUCAO_DA_ASSINATURA
          : `${anterior}\n\n${CORPO_DA_RESOLUCAO_DA_ASSINATURA}`,
    };
  }
  if (situacao.recusa === null) return { acao: "nada" };
  const corpo = corpoDoAvisoDeAssinatura(situacao.recusa);
  if (item) {
    return { acao: "atualizar", item, titulo: TITULO_DO_AVISO_DE_ASSINATURA, corpo };
  }
  return { acao: "abrir", titulo: TITULO_DO_AVISO_DE_ASSINATURA, corpo };
}
