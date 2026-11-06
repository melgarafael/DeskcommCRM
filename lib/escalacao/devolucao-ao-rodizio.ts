/**
 * DEVOLUÇÃO AO RODÍZIO — a regra pura, sem banco (issue #2985, fatia 1).
 *
 * ## O defeito
 *
 * O rodízio entrega a conversa a quem está de plantão, e é isso que o modo
 * `round_robin`/`load` promete. Só que a entrega é uma aposta: quem recebeu pode
 * não estar olhando. Quando ninguém responde, a conversa fica PARADA no dono —
 * o cliente escreveu, o rodízio escolheu uma pessoa, e a fila que existia antes
 * da entrega sumiu. A conversa com dono não volta para a fila sozinha.
 *
 * ## O que esta fatia acrescenta
 *
 * Um prazo OPCIONAL por organização
 * (`organizations.settings.routing.unanswered_return_minutes`): passado esse
 * tempo desde a ENTREGA pelo rodízio sem NENHUMA mensagem humana na conversa, o
 * produto solta o dono e devolve a conversa à distribuição. `null` — o padrão,
 * porque quem já instalou não pode mudar de comportamento — desliga tudo.
 *
 * ## O relógio conta da ENTREGA, e o desenho é conservador de propósito
 *
 * Diferente da irmã `devolucao-automatica.ts` (que conta do último sinal humano
 * para não interromper um atendimento em curso), aqui a régua é o instante do
 * último evento de atribuição — o `created_at` do evento com `reason = 'routing'`.
 * A pergunta é outra: "o rodízio entregou e ninguém falou nada DESDE ENTÃO?".
 * Por isso a metade que o banco responde sozinha (`avaliarEntregaAoRodizio`) e a
 * metade que depende das mensagens (`houveRespostaHumanaDepoisDaEntrega`) são
 * funções separadas: quem chama só vai ao banco perguntar por mensagem depois de
 * a conversa passar no portão barato.
 *
 * ## A trava das 3 horas: estoque antigo não volta de uma vez
 *
 * Ligar o prazo numa instalação que já roda transformaria todo o histórico em
 * candidatas na primeira rodada. Por isso só entra entrega das últimas 3 h
 * (`JANELA_DE_ENTREGA_RECENTE_MINUTOS`): a devolução conserta o plantão de
 * agora, não redistribui o mês passado. O preço é explícito — prazo acima de
 * 180 min nunca dispara, porque quando vence a entrega já saiu da janela.
 *
 * ## A exclusão de 24 h, e por que ela é o que faz a devolução servir
 *
 * Soltar o dono sem mais nada não conserta nada: o `routing-worker` roda 1×/min
 * e o rodízio escolheria a MESMA pessoa de novo (numa instalação com um
 * atendente só, sempre ela) — a conversa voltaria ao colo de quem já provou que
 * não responderia, agora com um evento de devolução no histórico. A marca em
 * `conversations.metadata` diz "esta pessoa não recebe ESTA conversa de novo por
 * 24 h", e o rodízio a respeita em `filtrarCandidatosExcluidos` (chamado por
 * `lib/routing/worker.ts`). Sem essa metade, a outra não tem efeito.
 *
 * ## O teto de 2 devoluções
 *
 * Duas devoluções bastam para provar que a conversa não é de ninguém naquele
 * dia. Depois disso ela sai do ciclo (`ciclos_esgotados`): fica onde estiver —
 * na fila, se o rodízio ainda não a entregou, ou com o terceiro dono, que ao
 * menos viu a conversa chegar. Avisar alguém é a fatia 3 (aqui não há
 * notificação nenhuma, por decisão de recorte).
 *
 * O contador NÃO zera com o tempo: é contagem de devoluções da conversa, não
 * "devoluções recentes" (a pergunta do mantenedor no #2988). `ultima_devolucao_em`
 * é a régua já gravada se a decisão mudar — zerar por silêncio seria "passou
 * tanto tempo que a conversa é nova de novo", e isso é da fatia 2/3, com o
 * tamanho da janela decidido por quem opera.
 *
 * ## Como a marca se lê, e por que ela é defensiva
 *
 * `conversations.metadata` é jsonb livre, escrito por vários módulos (o próprio
 * handoff técnico usa a mesma ideia). Tudo aqui trata lixo como ausência:
 * `devolucoes` ilegível vira 0, exclusão sem `user_id`/`ate` válidos é ignorada,
 * e exclusão vencida não exclui ninguém. O custo de errar para "não havia marca"
 * é uma devolução a mais; o de errar para "havia" é a conversa presa.
 */
import { PRAZO_MAX_MINUTOS, PRAZO_MIN_MINUTOS } from "@/lib/escalacao/devolucao-automatica";

/**
 * A faixa do prazo é a MESMA da devolução ao agente (`devolucao-automatica.ts`):
 * abaixo de 5 min a devolução volta no meio da digitação; 24 h é o teto em que
 * "o dia terminou" ainda significa alguma coisa. Constantes importadas e não
 * recriadas para as duas réguas não divergirem em silêncio.
 */

/** Quantas devoluções antes de a conversa sair do ciclo. */
export const MAX_DEVOLUCOES_AO_RODIZIO = 2;

/** Por quanto tempo a pessoa devolvida fica fora DESTA conversa. */
export const JANELA_DE_EXCLUSAO_MINUTOS = 24 * 60;

/**
 * A TRAVA DAS 3 HORAS (issue #2985), e por que ela existe
 *
 * Ligar o prazo numa instalação que já roda há meses transformaria TODO o
 * estoque de conversas antigas entregues pelo rodízio em candidatas na primeira
 * rodada: a fila receberia de uma vez conversas de dias atrás, e o rodízio as
 * redistribuiria — o oposto de "quem recebeu e não respondeu no prazo". A trava
 * corta isso na régua: só é candidata a entrega das últimas 3 horas.
 *
 * O efeito colateral é conhecido e é a régua que se quer: um prazo acima de
 * 180 min nunca dispara, porque quando ele vence a entrega já é estoque antigo.
 * A faixa do knob continua a da devolução ao agente (5 min – 24 h) — baixar o
 * teto aqui faria o knob mentir sobre o valor gravado.
 */
export const JANELA_DE_ENTREGA_RECENTE_MINUTOS = 3 * 60;

/** Chave do objeto dentro de `conversations.metadata`. */
export const CHAVE_DA_DEVOLUCAO_AO_RODIZIO = "devolucao_ao_rodizio";

/** Status em que faz sentido devolver — os mesmos das regras irmãs. */
const STATUS_DEVOLVIVEIS = new Set(["open", "pending", "claimed", "ai_handling"]);

/** O evento de atribuição que veio do rodízio (`fn_channel_routing_claim`). */
export const MOTIVO_DO_RODIZIO = "routing";

export interface ExclusaoDoRodizio {
  /** Quem não recebe esta conversa de novo dentro da janela. */
  user_id: string;
  /** ISO — fim da janela. Exclusão vencida não exclui ninguém. */
  ate: string;
}

export interface MarcasDeDevolucaoAoRodizio {
  devolucoes: number;
  exclusoes: ExclusaoDoRodizio[];
  ultima_devolucao_em?: string;
}

/**
 * A linha da conversa como o cron a lê, já com o que só o banco sabe sobre o
 * ÚLTIMO evento de atribuição. `ultimoEventoMotivo`/`entregueEm` vêm de
 * `conversation_assignment_events` (ordem `created_at desc`, primeira linha).
 */
export interface ConversaEntregueAoRodizio {
  id: string;
  organization_id: string;
  status: string | null;
  assigned_to_user_id: string | null;
  metadata: unknown;
  /** `reason` do último evento de atribuição; `null` quando não há evento nenhum. */
  ultimoEventoMotivo: string | null;
  /** `created_at` do último evento de atribuição — o instante da entrega. */
  entregueEm: string | null;
}

/**
 * Lê o prazo de `organizations.settings`. Ausente, nulo ou fora da faixa é
 * "nunca" — o padrão de quem nunca abriu a tela. Defensivo porque `settings` é
 * jsonb livre.
 */
export function lerPrazoDeDevolucaoAoRodizioMinutos(settings: unknown): number | null {
  const routing = (settings as { routing?: unknown } | null)?.routing;
  const valor = (routing as { unanswered_return_minutes?: unknown } | null)
    ?.unanswered_return_minutes;
  if (typeof valor !== "number" || !Number.isFinite(valor)) return null;
  if (valor < PRAZO_MIN_MINUTOS || valor > PRAZO_MAX_MINUTOS) return null;
  return Math.floor(valor);
}

/** O objeto de marcas, ou o vazio — nunca lança, nunca inventa. */
export function lerMarcasDeDevolucaoAoRodizio(metadata: unknown): MarcasDeDevolucaoAoRodizio {
  const vazio: MarcasDeDevolucaoAoRodizio = { devolucoes: 0, exclusoes: [] };
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return vazio;
  const bruto = (metadata as Record<string, unknown>)[CHAVE_DA_DEVOLUCAO_AO_RODIZIO];
  if (!bruto || typeof bruto !== "object" || Array.isArray(bruto)) return vazio;
  const objeto = bruto as Record<string, unknown>;

  const devolucoes =
    typeof objeto.devolucoes === "number" && Number.isFinite(objeto.devolucoes) && objeto.devolucoes > 0
      ? Math.floor(objeto.devolucoes)
      : 0;

  const exclusoes: ExclusaoDoRodizio[] = Array.isArray(objeto.exclusoes)
    ? objeto.exclusoes.flatMap((entrada) => {
        if (!entrada || typeof entrada !== "object" || Array.isArray(entrada)) return [];
        const item = entrada as Record<string, unknown>;
        if (typeof item.user_id !== "string" || item.user_id.length === 0) return [];
        if (typeof item.ate !== "string" || Number.isNaN(Date.parse(item.ate))) return [];
        return [{ user_id: item.user_id, ate: item.ate }];
      })
    : [];

  const ultima =
    typeof objeto.ultima_devolucao_em === "string" && !Number.isNaN(Date.parse(objeto.ultima_devolucao_em))
      ? objeto.ultima_devolucao_em
      : undefined;

  return { devolucoes, exclusoes, ...(ultima ? { ultima_devolucao_em: ultima } : {}) };
}

/** Quantas devoluções esta conversa já levou. */
export function contarDevolucoesAoRodizio(metadata: unknown): number {
  return lerMarcasDeDevolucaoAoRodizio(metadata).devolucoes;
}

/** A pessoa está fora desta conversa AGORA? Exclusão vencida não exclui. */
export function pessoaExcluidaDoRodizio(metadata: unknown, userId: string, agoraMs: number): boolean {
  return lerMarcasDeDevolucaoAoRodizio(metadata).exclusoes.some(
    (e) => e.user_id === userId && Date.parse(e.ate) > agoraMs,
  );
}

/**
 * O rodízio respeita a exclusão AQUI — é a única adaptação da regra irmã que o
 * caminho de distribuição precisa. Genérico no tipo para viver em `lib/` sem
 * importar `RoutingCandidate` (o worker importa os dois; o contrário seria
 * ciclo).
 */
export function filtrarCandidatosExcluidos<T extends { userId: string }>(
  candidatos: readonly T[],
  metadata: unknown,
  agoraMs: number,
): T[] {
  const { exclusoes } = lerMarcasDeDevolucaoAoRodizio(metadata);
  if (exclusoes.length === 0) return [...candidatos];
  return candidatos.filter(
    (c) => !exclusoes.some((e) => e.user_id === c.userId && Date.parse(e.ate) > agoraMs),
  );
}

/**
 * A marca que a devolução grava: mais uma devolução contada, a pessoa fora por
 * 24 h e as exclusões vencidas podadas (senão o metadata cresce para sempre).
 * Devolve o metadata NOVO — quem escreve é o cron, num UPDATE só.
 */
export function registrarDevolucaoAoRodizio(
  metadata: unknown,
  userId: string,
  agoraMs: number,
): Record<string, unknown> {
  const atuais = lerMarcasDeDevolucaoAoRodizio(metadata);
  const vivas = atuais.exclusoes.filter((e) => Date.parse(e.ate) > agoraMs && e.user_id !== userId);
  const ate = new Date(agoraMs + JANELA_DE_EXCLUSAO_MINUTOS * 60_000).toISOString();
  const base =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? { ...(metadata as Record<string, unknown>) }
      : {};
  return {
    ...base,
    [CHAVE_DA_DEVOLUCAO_AO_RODIZIO]: {
      devolucoes: atuais.devolucoes + 1,
      exclusoes: [...vivas, { user_id: userId, ate }],
      ultima_devolucao_em: new Date(agoraMs).toISOString(),
    } satisfies MarcasDeDevolucaoAoRodizio,
  };
}

/**
 * A METADE DAS MENSAGENS. Saiu alguma mensagem de GENTE depois da entrega?
 * `sent_via` `user` é o inbox; `external_device` é o celular — o MESMO par que
 * o handoff técnico já conta (`lib/escalacao/handoff-tecnico.ts`). O aviso do
 * próprio produto sai com `ai` e não conta.
 *
 * Falha de leitura chega aqui como "respondeu" (string ilegível): errar para
 * "houve resposta" mantém a conversa com a pessoa, que é o estado de antes
 * desta fatia — e o oposto tiraria uma conversa em atendimento da mão de quem
 * está atendendo.
 */
export function houveRespostaHumanaDepoisDaEntrega(
  entregueEm: string,
  ultimaRespostaHumanaEm: string | null,
): boolean {
  if (!ultimaRespostaHumanaEm) return false;
  const entrega = Date.parse(entregueEm);
  const resposta = Date.parse(ultimaRespostaHumanaEm);
  if (Number.isNaN(entrega) || Number.isNaN(resposta)) return true;
  return resposta > entrega;
}

export interface Selecao {
  prazoPorOrg: ReadonlyMap<string, number>;
  agoraMs: number;
}

export type MotivoDeNaoDevolver =
  | "sem_prazo"
  | "status_nao_devolvivel"
  | "sem_dono"
  | "ciclos_esgotados"
  | "ultimo_evento_nao_e_rodizio"
  | "sem_entrega"
  | "entrega_antiga"
  | "dentro_do_prazo";

/**
 * O PORTÃO BARATO: tudo o que o banco responde sem tocar em mensagem. Quem
 * passa daqui ainda NÃO pode ser devolvido — falta `houveRespostaHumana...`,
 * que exige uma consulta por conversa. Consultar mensagem de toda conversa
 * atribuída da instalação a cada 5 min seria pagar caro para descobrir o mesmo
 * nada.
 */
export function avaliarEntregaAoRodizio(
  c: ConversaEntregueAoRodizio,
  sel: Selecao,
): { candidata: true; minutos: number; entregueEm: string } | { candidata: false; motivo: MotivoDeNaoDevolver } {
  const minutos = sel.prazoPorOrg.get(c.organization_id);
  if (minutos === undefined) return { candidata: false, motivo: "sem_prazo" };
  if (!STATUS_DEVOLVIVEIS.has(c.status ?? "")) return { candidata: false, motivo: "status_nao_devolvivel" };
  // Sem dono não há entrega para desfazer: a devolução já aconteceu, ou a
  // conversa nunca foi do rodízio. Nos dois casos não há nada a fazer.
  if (c.assigned_to_user_id === null) return { candidata: false, motivo: "sem_dono" };
  if (contarDevolucoesAoRodizio(c.metadata) >= MAX_DEVOLUCOES_AO_RODIZIO) {
    return { candidata: false, motivo: "ciclos_esgotados" };
  }
  if (c.ultimoEventoMotivo !== MOTIVO_DO_RODIZIO) {
    return { candidata: false, motivo: "ultimo_evento_nao_e_rodizio" };
  }
  const entregaMs = c.entregueEm === null ? NaN : Date.parse(c.entregueEm);
  if (Number.isNaN(entregaMs)) return { candidata: false, motivo: "sem_entrega" };
  // A trava de estoque vem ANTES do prazo: com ela, "entregue há dias" sai por
  // `entrega_antiga` e não por `dentro_do_prazo` — o motivo importa para quem
  // ler o log e para o teste que guarda a promessa da issue.
  if (sel.agoraMs - entregaMs > JANELA_DE_ENTREGA_RECENTE_MINUTOS * 60_000) {
    return { candidata: false, motivo: "entrega_antiga" };
  }
  if (sel.agoraMs - entregaMs < minutos * 60_000) return { candidata: false, motivo: "dentro_do_prazo" };
  return { candidata: true, minutos, entregueEm: c.entregueEm! };
}

/** As conversas que passaram no portão, cada uma com o prazo e a entrega. */
export function selecionarCandidatasAoRodizio(
  conversas: readonly ConversaEntregueAoRodizio[],
  sel: Selecao,
): Array<{ conversa: ConversaEntregueAoRodizio; minutos: number; entregueEm: string }> {
  const out: Array<{ conversa: ConversaEntregueAoRodizio; minutos: number; entregueEm: string }> = [];
  for (const conversa of conversas) {
    const r = avaliarEntregaAoRodizio(conversa, sel);
    if (r.candidata) out.push({ conversa, minutos: r.minutos, entregueEm: r.entregueEm });
  }
  return out;
}
