/**
 * A DISTRIBUIÇÃO ESPERA A IA QUALIFICAR (issue #3966) — a regra pura.
 *
 * ## O defeito que este arquivo fecha
 *
 * Com rodízio ou carga ligado, a conversa era distribuída **no nascimento**:
 * `trg_conversation_routing_requested` (AFTER INSERT em `conversations`) emite
 * `conversation.routing_requested`, o `routing-worker` consome em até um minuto e
 * `decideRouting` sorteia entre os elegíveis. `fn_channel_routing_claim` →
 * `fn_conversation_assign` gravam `assignee_kind = 'user'`, e o gate da IA
 * (`lib/ai/elegibilidade/gate.ts`, motivo `conversa_de_humano`) cala o agente.
 *
 * Ou seja: o próprio roteamento desligava quem deveria qualificar. Num número
 * com agente de qualificação, o lead recebia a primeira resposta da IA e era
 * entregue a uma pessoa em menos de um minuto — a IA parava, e o lead ficava sem
 * atendimento até alguém abrir a conversa.
 *
 * ## A pergunta que este módulo responde
 *
 * "Esta conversa deve ESPERAR a IA terminar antes de ganhar dono?" — e a
 * resposta tem de ser um FATO medido, nunca uma suposição do worker. As fontes,
 * cada uma com o motivo de existir:
 *
 *   1. a OPÇÃO, ligada para a organização ou para o número
 *      (`settings.routing.distribute_only_after_qualification` e
 *      `channel_sessions.metadata.routing.distribute_only_after_qualification`);
 *   2. existe AGENTE DE IA no ar atendendo este número (`agenteAtende` — pausado,
 *      arquivado ou sem versão publicada não atende);
 *   3. a IA NÃO está calada nesta conversa (`force_human`, `ai_opt_out`,
 *      `is_blocked`, `bot_silenced_until` no futuro) — quem calou a IA não pode
 *      ficar preso esperando uma qualificação que nunca vem;
 *   4. o CASO mais recente não está pedindo uma pessoa (`awaiting_human` /
 *      `escalated`) — quando pede, a qualificação ACABOU;
 *   5. o lead não passou da qualificação (`lead_state.stage` em
 *      `qualified`/`negotiating`/`won`) — aí a IA já fez o trabalho dela.
 *
 * ## O limite de espera, e por que ele existe
 *
 * As quatro fontes acima dependem de alguém ESCREVER um sinal: a ferramenta de
 * caso do modelo, a passagem para humano, a ferramenta de estágio do lead. Um
 * agente sem essas ferramentas, um modelo que não as chama, ou um lead que
 * simplesmente para de responder não produzem sinal nenhum — e a conversa
 * ficaria sem dono para sempre. O limite é a saída: passado `X` desde o
 * NASCIMENTO da conversa, a distribuição acontece mesmo sem sinal.
 *
 * Medido desde `conversations.created_at`, e não desde a última mensagem: são
 * relógios diferentes com consequências opostas. Reiniciar a contagem a cada
 * mensagem deixaria o lead que conversa muito — e nunca se qualifica — sem
 * nenhum humano para sempre, que é o defeito ao contrário.
 *
 * Puro de propósito (nada de banco, relógio injetado): quem lê as cinco fontes
 * é `lib/routing/worker.ts`, e é por unit que as combinações são provadas sem um
 * Postgres vivo.
 */

/** Faixa do limite de espera, em minutos. O default do schema é {@link ESPERA_PADRAO_MINUTOS}. */
export const ESPERA_MINIMA_MINUTOS = 15;
export const ESPERA_MAXIMA_MINUTOS = 10080; // 7 dias

/**
 * O padrão do limite: **um dia**. Curto demais reabre o defeito que a opção
 * fecha (o lead que escreve às 22h não pode ganhar um dono humano às 22h30 —
 * ninguém vai responder, e a IA para); longo demais deixa a conversa sem dono
 * por uma semana. Um dia é o ciclo inteiro de um lead de anúncio, inclusive o
 * fim de semana curto.
 */
export const ESPERA_PADRAO_MINUTOS = 1440;

export type MotivoDaEspera =
  /** ESPERA: a IA está atendendo e ainda não sinalizou o fim da qualificação. */
  | "ia_qualificando"
  | "opcao_desligada"
  | "sem_agente_de_ia"
  /** A IA não responde nesta conversa (trava, opt-out, silêncio, bloqueio). */
  | "ia_calada"
  | "caso_pede_pessoa"
  | "lead_qualificado"
  | "limite_esgotado"
  /** `created_at` ilegível: falha ABERTA — distribui como hoje. */
  | "sem_nascimento";

export interface FatosDaQualificacao {
  /** A opção vale para esta conversa (organização ∧ número)? */
  ligada: boolean;
  /** Há agente de IA no ar que atende o número desta conversa? */
  iaAtende: boolean;
  /** `contacts.force_human` — a passagem para humano já aconteceu. */
  forceHuman: boolean;
  /** `contacts.ai_opt_out` — a marca permanente de "sempre humano". */
  aiOptOut: boolean;
  /** `contacts.is_blocked` — o contato pediu para não receber mais nada. */
  contatoBloqueado: boolean;
  /** `conversations.bot_silenced_until` (ISO, inclusive o literal `infinity`). */
  botSilencedUntil: string | null;
  /** O caso mais recente da conversa está em `awaiting_human`/`escalated`. */
  casoPedePessoa: boolean;
  /** `lead_state.stage` do contato já passou da qualificação. */
  leadQualificado: boolean;
  /** `conversations.created_at`. */
  nasceuEm: string | null;
  agora: Date;
  /** `settings.routing.qualification_wait_minutes`. */
  limiteMinutos: number;
}

export interface EsperaDecidida {
  espera: boolean;
  motivo: MotivoDaEspera;
  /**
   * ISO do instante em que a espera ACABA sozinha (`nascimento + limite`).
   * `null` quando não há espera ou quando o nascimento é ilegível.
   */
  limiteEm: string | null;
}

/** `qualified`/`negotiating`/`won` — daqui para frente a IA já qualificou. */
const DEPOIS_DA_QUALIFICACAO = new Set(["qualified", "negotiating", "won"]);

/**
 * O lead já passou da qualificação? Status fora do vocabulário conhecido
 * respondem `false` (não bloqueiam a espera): quem não sabe não afirma.
 */
export function leadJaQualificado(stage: string | null | undefined): boolean {
  return typeof stage === "string" && DEPOIS_DA_QUALIFICACAO.has(stage);
}

/**
 * O silêncio vale AGORA? Mesma leitura do gate (`lib/ai/elegibilidade/gate.ts`,
 * `silenciadoAgora`): o literal `infinity` que o Postgres devolve em `text` é
 * silêncio eterno, e data ilegível não é silêncio.
 */
function silenciadaAgora(iso: string | null | undefined, agora: Date): boolean {
  if (typeof iso !== "string" || iso.length === 0) return false;
  if (iso === "infinity") return true;
  const ms = Date.parse(iso);
  return !Number.isNaN(ms) && ms > agora.getTime();
}

/**
 * A decisão. A ordem é a do custo da pergunta: primeiro "a opção vale?", depois
 * "há IA para esperar?", e só então os fatos da conversa — quem desligou a opção
 * não paga leitura nenhuma além desta.
 */
export function decidirEsperaPelaQualificacao(f: FatosDaQualificacao): EsperaDecidida {
  if (!f.ligada) return { espera: false, motivo: "opcao_desligada", limiteEm: null };
  if (!f.iaAtende) return { espera: false, motivo: "sem_agente_de_ia", limiteEm: null };
  if (
    f.forceHuman ||
    f.aiOptOut ||
    f.contatoBloqueado ||
    silenciadaAgora(f.botSilencedUntil, f.agora)
  ) {
    return { espera: false, motivo: "ia_calada", limiteEm: null };
  }
  if (f.casoPedePessoa) return { espera: false, motivo: "caso_pede_pessoa", limiteEm: null };
  if (f.leadQualificado) return { espera: false, motivo: "lead_qualificado", limiteEm: null };

  const nasceu = typeof f.nasceuEm === "string" ? Date.parse(f.nasceuEm) : Number.NaN;
  if (Number.isNaN(nasceu)) {
    // Falha ABERTA, como o resto do worker: sem saber quando a conversa nasceu
    // não há limite a calcular, e parar de distribuir por causa disso é o
    // desfecho caro.
    return { espera: false, motivo: "sem_nascimento", limiteEm: null };
  }

  const limiteMs = Math.max(f.limiteMinutos, ESPERA_MINIMA_MINUTOS) * 60_000;
  const limiteEm = new Date(nasceu + limiteMs).toISOString();
  if (f.agora.getTime() >= nasceu + limiteMs) {
    return { espera: false, motivo: "limite_esgotado", limiteEm };
  }
  return { espera: true, motivo: "ia_qualificando", limiteEm };
}

/**
 * A opção do NÚMERO, lida de `channel_sessions.metadata.routing` — o mesmo
 * caminho em que mora `metadata.ai_gate` (#573). Tri-estado:
 *
 *   `true` / `false` → o número decide por si;
 *   ausente/ilegível → herda a organização.
 *
 * Qualquer coisa que não seja o booleano literal é AUSENTE, nunca `false`:
 * `"true"` em texto num jsonb editado à mão não pode desligar, na surdina, o que
 * a organização ligou.
 */
export function lerEsperaDoCanal(metadata: unknown): boolean | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const routing = (metadata as Record<string, unknown>).routing;
  if (!routing || typeof routing !== "object" || Array.isArray(routing)) return null;
  const valor = (routing as Record<string, unknown>).distribute_only_after_qualification;
  return typeof valor === "boolean" ? valor : null;
}

/**
 * A opção que VALE para a conversa: o número, quando decidiu; a organização,
 * quando o número não decidiu. A mesma precedência de
 * `resolverRoteamentoPorNumero` (modo e destino padrão do número vencem a
 * organização) — uma régua de herança por eixo, não duas.
 */
export function esperaDaLigada(daOrganizacao: boolean, doCanal: boolean | null): boolean {
  return doCanal ?? daOrganizacao;
}
