/**
 * DEVOLUÇÃO AUTOMÁTICA AO AGENTE — a regra pura, sem banco.
 *
 * ## O que muda em relação à IA-06
 *
 * A regra IA-06 (spec 05 §7) diz que o bot **não reassume** depois da passagem
 * a humano: `bot_silenced_until = 'infinity'` até alguém clicar "Devolver ao
 * automático". Ela continua sendo o PADRÃO — quem instalou e nunca mexeu em
 * nada não vê diferença.
 *
 * O que este arquivo acrescenta é um prazo OPCIONAL, por organização
 * (`organizations.settings.routing.handoff_return_after_minutes`): passado esse
 * tempo sem NENHUM sinal humano na conversa, o produto devolve o atendimento
 * ao agente sozinho, pela MESMA função que o botão da tela usa
 * (`devolverAtendimentoAoAgente`, que solta as três travas certas).
 *
 * Medido numa instalação real antes de escrever: 12 de 31 conversas ativas do
 * dia estavam em handoff formal, nenhuma foi devolvida, e o cliente que
 * escreveu de novo ficou sem resposta — humano ocupado, IA proibida. O botão
 * existe; ninguém clica.
 *
 * ## Como o prazo conta
 *
 * A partir do ÚLTIMO SINAL HUMANO, não da passagem: o maior entre a passagem
 * (`last_handoff_at`), o "assumir" (`assigned_at`) e a última mensagem que
 * saiu (`last_outbound_at`). Enquanto a conversa está em handoff a IA não
 * envia, então toda saída nesse período é de gente — inclusive a feita pelo
 * celular, que a ingestão grava como `external_device`. Contar da passagem
 * interromperia um atendimento de 1h30 no meio, que é o pior desfecho
 * possível: justamente quando há uma pessoa na conversa.
 *
 * ## O que fica de fora, e por quê
 *
 * - **Conversa que uma pessoa assumiu** (dono humano) e **conversa em que uma
 *   pessoa respondeu depois da passagem**, mesmo sem clicar em Assumir. O prazo
 *   vale só para a passagem que ninguém pegou; atendimento humano em curso só
 *   volta à IA por ação explícita de alguém (`pessoaNoComando`, abaixo, e o
 *   cron `handoff-devolucao`). Antes desta regra o prazo também devolvia
 *   conversas com dono — e "contar do último sinal humano" não protegia o
 *   técnico que passou o prazo sem escrever, ocupado resolvendo o problema.
 *
 * - **Sessão sem agente publicado.** Devolver "para ninguém" tira a conversa
 *   da fila humana e ninguém responde — pior que deixá-la com a pessoa. O cron
 *   só devolve onde há quem atenda (`sessoesComAgente`).
 * - **Conversa encerrada.** Devolver conversa fechada a reabriria como
 *   `ai_handling`; o encerramento é decisão, não abandono.
 * - **Pausa por resposta pelo celular** (`bot_silenced_until` finito, ver
 *   `atendimento-manual.ts`): tem prazo próprio e vence sozinha. Aqui só entra
 *   quem está com humano de forma durável: `'infinity'`, `assignee_kind='user'`
 *   ou `assigned_to_user_id` preenchido.
 * - **Conversa no modo "IA com o dono"** (#3967): ali a IA responde de
 *   propósito sem soltar o dono, então o "sinal humano" que este prazo espera
 *   nunca vem. Devolver seria justamente soltar quem ligou o modo para não
 *   soltar. Sem dono, o modo é inerte e a régua abaixo é a de sempre.
 */

import { modoProtegeODono } from "@/lib/ai/elegibilidade/ia-com-dono";

/**
 * Piso do prazo, em minutos. Abaixo de 5 a IA volta no meio da digitação.
 *
 * O TETO da devolução ao agente deixou de existir (#3313): uma agência de
 * viagens declarou 24 h curto — cotação internacional leva dias de ida e volta
 * com fornecedores, e a IA reassumir no meio do intervalo atrapalha. O teto
 * antigo (24 h) NÃO virou teto novo: virou faixa de outro knob, e é por isso
 * que existem DUAS constantes. `PRAZO_MAX_MINUTOS` continua medindo o silêncio
 * da IA depois de uma resposta pelo celular e a devolução ao rodízio, onde o
 * teto curto é a razão de ser da regra (quem atende pelo celular o dia inteiro
 * renova o prazo a cada fala — #2005).
 */
export const PRAZO_MIN_MINUTOS = 5;

/** Teto do silêncio da IA e da devolução ao rodízio: 24 h. */
export const PRAZO_MAX_MINUTOS = 24 * 60;

/**
 * Teto da DEVOLUÇÃO AO AGENTE sozinho: 30 dias. Não é "sem limite" — é limite
 * largo o bastante para o caso real medido, e ainda um número que o formulário
 * consegue mostrar (`max` do input) e o zod consegue recusar. O que protege o
 * operador de digitar 500.000 por engano não é o teto: é o texto do campo, que
 * diz o que o prazo faz.
 */
export const PRAZO_MAX_MINUTOS_DEVOLUCAO = 30 * 24 * 60;

/** Status em que faz sentido devolver — os mesmos de `retomada.ts`. */
const STATUS_DEVOLVIVEIS = new Set(["open", "pending", "claimed", "ai_handling"]);

export interface ConversaEmHandoff {
  id: string;
  organization_id: string;
  channel_session_id: string | null;
  status: string | null;
  assignee_kind: string | null;
  assigned_to_user_id: string | null;
  assigned_at: string | null;
  bot_silenced_until: string | null;
  last_handoff_at: string | null;
  last_outbound_at: string | null;
  status_changed_at: string | null;
  /**
   * `conversations.metadata`. Obrigatório de propósito: é daqui que sai o modo
   * "IA com o dono" (#3967), e esquecer de selecionar a coluna faria o cron
   * devolver ao agente uma conversa que alguém ligou para a IA acompanhar.
   */
  metadata: unknown;
}

/**
 * O modo "IA com o dono" (#3967) protege um dono que existe?
 *
 * Exportado daqui porque é nesta régua que a pergunta importa primeiro, e o
 * route do cron filtra o mesmo caso antes de montar a rodada.
 */
export function emModoIaComDono(c: ConversaEmHandoff): boolean {
  return modoProtegeODono({ metadata: c.metadata, assignedToUserId: c.assigned_to_user_id });
}

/**
 * Lê o prazo de `organizations.settings`. Ausente, nulo ou fora da faixa é
 * "nunca" — a IA-06 de sempre. Defensivo porque `settings` é jsonb livre.
 *
 * A faixa é a DA DEVOLUÇÃO AO AGENTE (`PRAZO_MAX_MINUTOS_DEVOLUCAO`, 30 dias),
 * não a do silêncio do celular: este leitor é o único caminho do cron, e um
 * teto de 24 h aqui descartaria em silêncio — sem log, sem auditoria, com a
 * rodada respondendo `organizacoes: 0` — o prazo que a tela deixou salvar.
 */
export function lerPrazoDeDevolucaoMinutos(settings: unknown): number | null {
  const routing = (settings as { routing?: unknown } | null)?.routing;
  const valor = (routing as { handoff_return_after_minutes?: unknown } | null)
    ?.handoff_return_after_minutes;
  if (typeof valor !== "number" || !Number.isFinite(valor)) return null;
  if (valor < PRAZO_MIN_MINUTOS || valor > PRAZO_MAX_MINUTOS_DEVOLUCAO) return null;
  return Math.floor(valor);
}

/** A conversa está com uma pessoa de forma durável (não é a pausa do celular). */
export function estaComHumanoDuravel(c: ConversaEmHandoff): boolean {
  if (c.assigned_to_user_id !== null) return true;
  if (c.assignee_kind === "user") return true;
  return c.bot_silenced_until === "infinity";
}

function epoch(iso: string | null): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * O instante do último sinal humano, em ms. `null` quando a conversa não tem
 * nenhum carimbo — não dá para dizer há quanto tempo está parada, então não
 * se devolve (melhor um falso "ainda com a pessoa" que uma devolução cega).
 */
export function ultimoSinalHumanoMs(c: ConversaEmHandoff): number | null {
  const candidatos = [
    epoch(c.last_handoff_at),
    epoch(c.assigned_at),
    epoch(c.last_outbound_at),
  ].filter((t): t is number => t !== null);
  if (candidatos.length === 0) {
    // Sem carimbo de passagem nem de saída: o único relógio que sobra é o da
    // última mudança de status — que é a própria passagem quando ela veio
    // pelo orchestrator.
    return epoch(c.status_changed_at);
  }
  return Math.max(...candidatos);
}

export interface Selecao {
  prazoPorOrg: ReadonlyMap<string, number>;
  /** `organization_id` → sessões com agente publicado (ou roteador ativo). */
  sessoesComAgente: ReadonlyMap<string, ReadonlySet<string>>;
  agoraMs: number;
}

export type MotivoDeNaoDevolver =
  | "sem_prazo"
  | "ia_com_dono"
  | "nao_esta_com_humano"
  | "status_nao_devolvivel"
  | "sessao_sem_agente"
  | "sem_relogio"
  | "dentro_do_prazo";

/**
 * A pergunta do RELÓGIO: o prazo desta conversa venceu?
 *
 * Responder `devolver: true` aqui NÃO basta para devolver: o lote
 * (`selecionarVencidas`) ainda descarta a conversa com dono humano, e o cron
 * descarta a que recebeu resposta humana depois da passagem.
 */
export function avaliarDevolucao(
  c: ConversaEmHandoff,
  sel: Selecao,
): { devolver: true; minutos: number } | { devolver: false; motivo: MotivoDeNaoDevolver } {
  const minutos = sel.prazoPorOrg.get(c.organization_id);
  if (minutos === undefined) return { devolver: false, motivo: "sem_prazo" };
  // #3967: no modo "IA com o dono" a conversa tem dono E automático, e o
  // "sinal humano" que este prazo espera nunca vem — quem responde é a IA, de
  // propósito. Devolver aqui seria soltar o dono exatamente de quem ligou o
  // modo para não soltá-lo. Sem dono, o modo é inerte: a conversa segue a régua
  // de sempre (e pode voltar ao rodízio como qualquer outra).
  if (emModoIaComDono(c)) return { devolver: false, motivo: "ia_com_dono" };
  if (!estaComHumanoDuravel(c)) return { devolver: false, motivo: "nao_esta_com_humano" };
  if (!STATUS_DEVOLVIVEIS.has(c.status ?? "")) {
    return { devolver: false, motivo: "status_nao_devolvivel" };
  }
  const sessoes = sel.sessoesComAgente.get(c.organization_id);
  if (!c.channel_session_id || !sessoes?.has(c.channel_session_id)) {
    return { devolver: false, motivo: "sessao_sem_agente" };
  }
  const sinal = ultimoSinalHumanoMs(c);
  if (sinal === null) return { devolver: false, motivo: "sem_relogio" };
  if (sel.agoraMs - sinal < minutos * 60_000) return { devolver: false, motivo: "dentro_do_prazo" };
  return { devolver: true, minutos };
}

/**
 * UMA PESSOA ASSUMIU ESTA CONVERSA — e relógio nenhum a tira dela.
 *
 * O prazo de `handoff_return_after_minutes` nasceu para a passagem que NINGUÉM
 * pegou (a fila esquecida). Aplicado a uma conversa com dono, ele devolvia à IA,
 * sozinho, um atendimento que uma pessoa tinha tomado para si — e o técnico que
 * levou 40 minutos testando um equipamento voltava para a conversa com a IA
 * respondendo por cima dele. A regra do produto passou a ser: depois que alguém
 * assume, só uma AÇÃO EXPLÍCITA de pessoa devolve o atendimento ("Devolver ao
 * automático", encerrar marcando a devolução, a tool `crm_resume_ai_attendance`
 * chamada por gente, o `#on` do celular). Tempo não é ação.
 *
 * Por que o critério é só `assigned_to_user_id`: o CHECK
 * `conversations_assignee_kind_coherence` (migration 0032) garante que
 * `assignee_kind = 'user'` existe exatamente quando há esse id — ler os dois
 * seria repetir a mesma pergunta, e ler só o `kind` aceitaria um estado que o
 * banco recusa.
 *
 * Por que aqui, e não dentro de `avaliarDevolucao`: aquela função responde à
 * pergunta do RELÓGIO ("o prazo venceu?"), e `tests/invariants/
 * reabertura-com-devolucao-automatica.test.ts` — congelado — a julga exatamente
 * nesses termos. A decisão de devolver é do LOTE, e o lote é quem ouve esta regra.
 * O cron ainda a reconfere no momento da escrita (`expectedAssignee: null` em
 * `devolverAtendimentoAoAgente`), porque alguém pode assumir entre a leitura e ela.
 */
export function pessoaNoComando(c: Pick<ConversaEmHandoff, "assigned_to_user_id">): boolean {
  return c.assigned_to_user_id !== null;
}

/**
 * As conversas vencidas, com o prazo que venceu cada uma.
 *
 * Conversa com dono humano NUNCA entra, por mais que o prazo tenha vencido —
 * ver `pessoaNoComando`. A outra metade da regra ("uma pessoa respondeu depois
 * da passagem, sem clicar em Assumir") precisa ler `messages` e por isso mora no
 * cron, que a aplica sobre este lote.
 */
export function selecionarVencidas(
  conversas: readonly ConversaEmHandoff[],
  sel: Selecao,
): Array<{ conversa: ConversaEmHandoff; minutos: number }> {
  const out: Array<{ conversa: ConversaEmHandoff; minutos: number }> = [];
  for (const conversa of conversas) {
    if (pessoaNoComando(conversa)) continue;
    const r = avaliarDevolucao(conversa, sel);
    if (r.devolver) out.push({ conversa, minutos: r.minutos });
  }
  return out;
}
