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
import { traduzir } from "@/lib/i18n/dicionario";
import { preencher } from "@/lib/i18n/idioma-do-aviso";
import type { Idioma } from "@/lib/i18n/idiomas";

export const KIND_ASSINATURA_DESCONECTADA = "assinatura_desconectada" as const;

/** O título do item. Diz a CONSEQUÊNCIA para quem atende, não o token. */
export const TITULO_DO_AVISO_DE_ASSINATURA =
  "A conta do ChatGPT desconectou — a IA parou de responder";

/**
 * O título do aviso de "a IA inteira está fora" (#4610). É ele que separa, na
 * MESMA linha da Central, o episódio em que o login caiu daquele em que as duas
 * credenciais — assinatura e reserva — recusaram a chamada.
 */
export const TITULO_DA_IA_FORA = "A IA parou de responder — a assinatura e a reserva falharam";

/** O item aberto desta organização, se houver — um incidente = um item. */
export interface ItemDaAssinaturaAberto {
  id: string;
  body: string | null;
  /** Ausente nos itens de clone antigo e nos dublês que só carregam `body`. */
  title?: string | null;
}

/**
 * Um lado da falha, **já redigido e truncado** pelo `normalizarErro` do seam.
 *
 * Este módulo é puro e NÃO redige nada: quem o chama entrega a mensagem que já
 * passou por `redigirMensagemDoProvedor`. Duas redações em série seriam duas
 * réguas, e a segunda apagaria o que a primeira deixou de propósito.
 */
export interface LadoQueFalhou {
  provider: string;
  http_status: number | null;
  error_code: string;
  error_message: string;
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
  /**
   * A IA INTEIRA FICOU FORA (#4610): a assinatura caiu **e** a reserva também
   * falhou. Os dois lados entram no corpo, nomeados — foi a leitura de um só
   * deles que, no incidente de 06/11, mandou trocar a chave errada.
   *
   * Ausente/`null` = o caso de sempre, em que só o login recusou.
   */
  iaFora?: { assinatura: LadoQueFalhou; reserva: LadoQueFalhou } | null;
  /**
   * Como a IA voltou. `true` = uma CHAMADA passou (o login pode seguir
   * quebrado, com a reserva atendendo); ausente/`false` = o login voltou.
   *
   * Só muda a frase do fechamento e o alcance dele: uma chamada que passa
   * fecha o item do episódio "IA fora" e **não** o item de login, porque o
   * segundo continua verdadeiro enquanto a conta não for reconectada.
   */
  voltaPorChamada?: boolean;
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
export function motivoLegivelDaAssinatura(recusa: string, idioma: Idioma = "pt-BR"): string {
  const rotulo = recusa.slice(recusa.lastIndexOf(":") + 1);
  const chave = Object.hasOwn(MOTIVO_LEGIVEL, rotulo) ? rotulo : "desconhecido";
  return traduzir(MOTIVO_LEGIVEL[chave] as string, idioma);
}

/**
 * O corpo do aviso que PEDE a reconexão. Sem data e sem token: o corpo é lido
 * por qualquer pessoa da equipe, e a linha do item já carrega o horário.
 */
export function corpoDoAvisoDeAssinatura(recusa: string, idioma: Idioma = "pt-BR"): string {
  // No idioma da ORGANIZAÇÃO: a Central mostra o texto como foi gravado.
  return (
    preencher(traduzir("A conta do ChatGPT que atende esta empresa foi recusada: {motivo}.", idioma), {
      motivo: motivoLegivelDaAssinatura(recusa, idioma),
    }) +
    "\n\n" +
    traduzir(
      "Enquanto isso, a IA não responde aos clientes que escrevem — as mensagens chegam e ficam sem resposta. A cota da assinatura NÃO é o problema.",
      idioma,
    ) +
    "\n\n" +
    traduzir(
      "Para voltar: reconecte a conta em IA › Credenciais. Este aviso se fecha sozinho quando o login voltar.",
      idioma,
    )
  );
}

/** A frase do fechamento, para "o login voltou" não ficar igual a "alguém fechou". */
export const CORPO_DA_RESOLUCAO_DA_ASSINATURA =
  "Resolvido pelo sistema: o login da conta foi renovado e a IA voltou a responder.";

/**
 * O fechamento quando foi uma CHAMADA que voltou a passar (#4610). Diz o que de
 * fato aconteceu: no incidente de 06/11 a IA voltou sozinha, sem ninguém
 * reconectar nada — anunciar "login renovado" ali seria inventar um conserto.
 */
export const CORPO_DA_RESOLUCAO_PELA_CHAMADA =
  "Resolvido pelo sistema: uma chamada de IA voltou a passar e os agentes voltaram a responder.";

/**
 * O corpo do aviso de "a IA inteira está fora" (#4610).
 *
 * Sequência do incidente: a assinatura passou a recusar todas as chamadas e a
 * chave de reserva também falhou. Ninguém disse isso a ninguém — a Central
 * mostrava só um `job_dead` genérico. Este corpo diz as três coisas que quem
 * administra precisa: QUEM recusou, com que motivo, e que o cliente está sem
 * resposta agora.
 *
 * Os dois motivos chegam já redigidos e truncados pelo `normalizarErro`; aqui só
 * se dá NOME a cada lado. Sem o nome, a leitura aponta para a chave errada —
 * exatamente o que aconteceu quando só a metade da reserva aparecia.
 */
export function corpoDoAvisoDaIaFora(
  d: {
    assinatura: LadoQueFalhou;
    reserva: LadoQueFalhou;
  },
  idioma: Idioma = "pt-BR",
): string {
  // No idioma da ORGANIZAÇÃO, como o resto deste arquivo (#4724); pt-BR é o texto de antes.
  const t = (s: string) => traduzir(s, idioma);
  const lado = (l: LadoQueFalhou): string =>
    `${l.provider} — ${l.error_code} (HTTP ${l.http_status ?? t("sem status")}): ${l.error_message.slice(0, 240)}`;
  return (
    t("As duas credenciais de IA desta empresa recusaram a chamada:") +
    "\n\n" +
    preencher(t("• assinatura: {lado}"), { lado: lado(d.assinatura) }) +
    "\n" +
    preencher(t("• reserva: {lado}"), { lado: lado(d.reserva) }) +
    "\n\n" +
    t(
      "Sem nenhum provedor de pé, os agentes não respondem aos clientes que escrevem — as mensagens chegam e ficam " +
        "sem resposta. O problema NÃO é a cota de mensagens do WhatsApp.",
    ) +
    "\n\n" +
    t(
      "Para voltar: reconecte a conta em IA › Credenciais e confira a chave de reserva em Agente de IA › Provedores. " +
        "Este aviso se fecha sozinho quando uma chamada de IA voltar a passar.",
    )
  );
}

/**
 * A decisão, para UMA organização, num instante.
 *
 * A ordem importa, e é ela que separa os dois episódios do MESMO item:
 *
 *  1. o login voltando resolve o item aberto (inclusive o de um incidente
 *     anterior) — mas, quando a volta é por CHAMADA (`voltaPorChamada`), só o
 *     item do episódio "IA fora" fecha;
 *  2. as DUAS pontas fora (`iaFora`) abrem/atualizam com o texto completo, que
 *     nomeia assinatura e reserva;
 *  3. só a recusa de LOGIN abre o texto da conta desconectada. Recusa que não é
 *     de login (`recusa === null`) não pode anunciar conta desconectada —
 *     mandaria o operador reconectar uma conta que está boa.
 */
export function avaliarAvisoDaAssinatura(
  situacao: SituacaoDaAssinatura,
  item: ItemDaAssinaturaAberto | null,
  /** O idioma da organização; `pt-BR` (o padrão) é o texto de antes, byte a byte. */
  idioma: Idioma = "pt-BR",
): DecisaoDoAvisoDaAssinatura {
  if (situacao.conectada) {
    if (!item) return { acao: "nada" };
    // Uma chamada que passou fecha o episódio "IA fora" — e só ele. O item de
    // LOGIN continua aberto enquanto a conta não for reconectada, porque a
    // reserva responder não conserta o login: fechá-lo aqui esconderia a conta
    // quebrada atrás de uma IA que voltou pela chave paga.
    if (
      situacao.voltaPorChamada === true &&
      item.title !== TITULO_DA_IA_FORA &&
      item.title !== traduzir(TITULO_DA_IA_FORA, idioma)
    )
      return { acao: "nada" };
    const anterior = (item.body ?? "").trim();
    const resolucao = traduzir(
      situacao.voltaPorChamada === true ? CORPO_DA_RESOLUCAO_PELA_CHAMADA : CORPO_DA_RESOLUCAO_DA_ASSINATURA,
      idioma,
    );
    return {
      acao: "resolver",
      item,
      corpo: anterior === "" ? resolucao : `${anterior}\n\n${resolucao}`,
    };
  }
  // As DUAS pontas fora é o caso mais informativo e vence o de login: o corpo
  // nomeia assinatura e reserva, e é ele que quem investiga precisa ler.
  if (situacao.iaFora) {
    const corpo = corpoDoAvisoDaIaFora(situacao.iaFora, idioma);
    const titulo = traduzir(TITULO_DA_IA_FORA, idioma);
    return item ? { acao: "atualizar", item, titulo, corpo } : { acao: "abrir", titulo, corpo };
  }
  if (situacao.recusa === null) return { acao: "nada" };
  const corpo = corpoDoAvisoDeAssinatura(situacao.recusa, idioma);
  const titulo = traduzir("A conta do ChatGPT desconectou — a IA parou de responder", idioma);
  if (item) {
    return { acao: "atualizar", item, titulo, corpo };
  }
  return { acao: "abrir", titulo, corpo };
}
