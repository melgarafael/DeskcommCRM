/**
 * O CANAL PAUSADO NÃO FICA PAUSADO EM SILÊNCIO (issue #2389).
 *
 * Pausar uma conexão é uma decisão de EQUIPE, e hoje ela só é visível para
 * quem clicou: a tela mostra o canal pausado, quem está no celular, no plantão
 * ou em outro turno não vê nada e continua achando que o número está no ar. O
 * audit já registra (`channel.disabled` / `channel.enabled`,
 * `lib/audit/actions.ts:260-261`), mas audit é histórico para quem procura,
 * não comunicação.
 *
 * A Central de avisos (`agent_inbox_items`) é o lugar onde a operação inteira
 * olha. É lá que este item nasce — e é lá que ele MORRE sozinho, sem clique de
 * ninguém: aviso que só some no clique de alguém vira lista que ninguém lê
 * (lição do #1023, "conexão excluída deixa um aviso crítico aberto para
 * sempre").
 *
 * ── Este arquivo é só a REGRA ───────────────────────────────────────────────
 *
 * Sem banco e sem rede, porque é ela que precisa de casos: quem aplica é
 * `lib/channels/central-de-pausa.ts`, chamado pelos handlers de pausa/retoma e
 * de arquivamento — a MESMA rodada abre e fecha o aviso, no formato do laço do
 * `canal-mudo.ts` / `canal-mudo-watcher`, só que instantâneo: a transição
 * acontece dentro do próprio clique, não numa varredura diária.
 *
 * ── Por que `status` NÃO aparece aqui ───────────────────────────────────────
 *
 * O tipo `CanalAvaliado` não carrega `status`, e isso é a resposta ao critério
 * 4 da issue: um canal fora do ar por SAÚDE (`STOPPED`/`FAILED`) não gera este
 * item, porque quem avisa disso é o `channel-health`. Dois avisos para o mesmo
 * silêncio seria a Central disputando com ela mesma a atenção de quem lê. Só
 * existe caminho para `abrir` partindo do booleano `metadata.disabled` — que só
 * muda quando uma PESSOA pausa. A saúde do transporte nem é lida.
 *
 * ── Sem PII de conversa ─────────────────────────────────────────────────────
 *
 * O corpo nomeia o canal (rótulo/número), quem pausou e quando. Nada de
 * mensagem, cliente ou conteúdo de conversa — a mesma régua de não-PII do
 * `canal-mudo-watcher`.
 */
import { canalDesativado } from "@/lib/channels/desativado";
import { nomeDoCanal } from "@/lib/channels/estado";
import { tagDeIdioma } from "@/lib/i18n/datas";
import type { Idioma } from "@/lib/i18n/idiomas";
import { FUSO_PADRAO } from "@/lib/tempo/fusos";

/** O kind do aviso em `agent_inbox_items` (vocabulário fechado por CHECK, migration 0589). */
export const KIND_CANAL_PAUSADO = "canal_pausado" as const;

/**
 * O canal, e só o que a regra lê.
 *
 * `status` fica DE PROPÓSITO de fora: ver acima. `archived_at` decide o
 * desfecho de quem excluiu o canal pausado (o item nunca fica órfão).
 */
export interface CanalAvaliado {
  id: string;
  organization_id: string;
  display_name?: string | null;
  phone_number?: string | null;
  archived_at: string | null;
  metadata: Record<string, unknown> | null;
}

/** O item aberto deste canal, se houver — um canal pausado = um item. */
export interface ItemDePausaAberto {
  id: string;
  body: string | null;
}

/**
 * Por que o aviso deixou de valer. O motivo entra no corpo, para "o operador
 * resolveu" e "o sistema viu que acabou" não ficarem iguais.
 */
export type MotivoDaResolucaoDePausa = "reativado" | "canal_arquivado";

export type DecisaoDeAvisoDePausa =
  /** Pausou e não havia item: nasce um. */
  | { acao: "abrir"; titulo: string; corpo: string }
  /** Pausa repetida/renovada com o item aberto: atualiza o corpo, nunca um segundo. */
  | { acao: "atualizar"; item: ItemDePausaAberto; titulo: string; corpo: string }
  /** Retomou ou arquivou com o item aberto: fecha sozinho, com o motivo no corpo. */
  | { acao: "resolver"; item: ItemDePausaAberto; motivo: MotivoDaResolucaoDePausa; corpo: string }
  /** Nada a fazer: sem item e nada que resolva, ou o canal nem está pausado. */
  | { acao: "nada" };

/** O que a decisão recebe de quem operou o clique. */
export interface ContextoDaPausa {
  /** Nome (ou e-mail) de quem pausou — é a primeira pergunta de quem lê no outro turno. */
  autor: string;
  /** Relógio: fake no teste, real na rota. */
  agora: Date;
  /**
   * O idioma de quem está operando. O item é LINHA GRAVADA — a Central mostra
   * como veio —, então é na escrita que o horário ganha o idioma de quem vai
   * ler, pela MESMA camada de todo o resto (`lib/i18n/datas.ts`).
   */
  idioma?: Idioma;
}

/** O motivo vira frase — sem isto, quem lê o corpo vê um identificador cru. */
const MOTIVO_LEGIVEL: Record<MotivoDaResolucaoDePausa, string> = {
  reativado: "o canal foi reativado",
  canal_arquivado: "o canal foi arquivado",
};

/** O título do item. Diz a CONSEQUÊNCIA, não a configuração. */
export const TITULO_DO_AVISO_DE_PAUSA =
  "Este canal está pausado — não recebe nem envia mensagens";

/**
 * O horário no fuso que a interface já usa (`FUSO_PADRAO`) e no idioma de quem
 * vai ler. Relógio entra como parâmetro em toda a regra: com `agora` fake o
 * teste é determinístico, sem depender do relógio da máquina que roda a suíte.
 *
 * O idioma passa por `tagDeIdioma` — é a camada que o repo designou para isto
 * (`tests/unit/i18n-a-data-segue-o-idioma.test.ts`), e fixar `"pt-BR"` aqui
 * seria a mesma tela meio traduzida que aquele guarda existe para impedir.
 */
export function momentoDaPausa(agora: Date, idioma?: Idioma): string {
  return new Intl.DateTimeFormat(tagDeIdioma(idioma ?? "pt-BR"), {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: FUSO_PADRAO,
  }).format(agora);
}

/**
 * O corpo do aviso aberto/atualizado: o canal, quem pausou e quando, e a saída.
 *
 * Sem PII de conversa — só rótulo do canal, autor e horário.
 */
export function corpoDoAvisoDePausa(
  canal: CanalAvaliado,
  contexto: ContextoDaPausa,
): string {
  const rotulo = nomeDoCanal(canal);
  return (
    `«${rotulo}» está pausado desde ` +
    `${momentoDaPausa(contexto.agora, contexto.idioma)} — quem pausou foi ${contexto.autor}.\n\n` +
    "Enquanto a pausa durar, as mensagens não entram nem saem por este canal. " +
    "Para voltar, retome a pausa em Conexões."
  );
}

/**
 * A decisão, para UM canal, num instante.
 *
 * A ordem dos testes é a ordem da vida do canal: arquivado resolve (nunca fica
 * órfão), desligado resolve como `reativado`, ligado com item atualiza e ligado
 * sem item abre. Repetir a pausa nunca chega a um segundo item — é o `item`
 * aberto que decide, não a contagem.
 */
export function avaliarAvisoDePausa(
  canal: CanalAvaliado,
  item: ItemDePausaAberto | null,
  contexto: ContextoDaPausa,
): DecisaoDeAvisoDePausa {
  if (canal.archived_at !== null) {
    return item ? resolver(item, "canal_arquivado") : { acao: "nada" };
  }
  if (!canalDesativado(canal.metadata)) {
    return item ? resolver(item, "reativado") : { acao: "nada" };
  }
  const titulo = TITULO_DO_AVISO_DE_PAUSA;
  const corpo = corpoDoAvisoDePausa(canal, contexto);
  if (item) return { acao: "atualizar", item, titulo, corpo };
  return { acao: "abrir", titulo, corpo };
}

/** Fecha o item com o motivo visível no CORPO, preservando o que já estava lá. */
function resolver(
  item: ItemDePausaAberto,
  motivo: MotivoDaResolucaoDePausa,
): DecisaoDeAvisoDePausa {
  const anterior = (item.body ?? "").trim();
  const linha = `Resolvido pelo sistema: ${MOTIVO_LEGIVEL[motivo]}.`;
  return {
    acao: "resolver",
    item,
    motivo,
    corpo: anterior === "" ? linha : `${anterior}\n\n${linha}`,
  };
}
