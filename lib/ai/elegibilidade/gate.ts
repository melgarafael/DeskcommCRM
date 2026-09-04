/**
 * O GATE DE ELEGIBILIDADE DA IA — "deny by default" por canal.
 *
 * ─── Por que este arquivo existe ────────────────────────────────────────────
 *
 * O DeskcommCRM responde `allow by default`: publicou um agente para a sessão de
 * WhatsApp, a IA atende TODO mundo que mandar mensagem. Isso é o certo para o
 * lojista cujo número existe só para vender. É o ERRADO para quem usa o mesmo
 * número para falar com cliente atual, fornecedor e contato pessoal — a IA
 * assume conversa que era de gente.
 *
 * O gate é OPT-IN, por canal: `channel_sessions.metadata.ai_gate`.
 *
 *   'open' (ausente / default)  → comportamento de hoje, nenhuma checagem nova.
 *   'allowlist'                 → a IA só responde quando há uma condição
 *                                 POSITIVA de elegibilidade no contato.
 *
 * ─── A regra é pura ─────────────────────────────────────────────────────────
 *
 * `decidirElegibilidade` não toca banco: recebe o estado já lido (gate do canal,
 * flags do contato, silêncio da conversa) e devolve `permite` + `motivo`. Os
 * dois consumidores — o drain (`lib/agent-engine/edge/crm/drain.ts`, que decide
 * ENFILEIRAR) e o turno (`lib/agent-engine/agent/inbound-turn.ts`, que decide
 * RODAR) — chamam a MESMA função. Regra duplicada nos dois lados divergiria na
 * primeira vez que alguém acrescentasse um motivo.
 *
 * ─── O que NÃO torna um contato elegível ────────────────────────────────────
 *
 * Mensagem nova sozinha. Conversa aberta. Conversa sem responsável. Conversa
 * aguardando resposta. Histórico. Cliente antigo. `channel_session` existir.
 * Nada disso. Só `contacts.ai_authorized_at` — carimbado por uma origem
 * elegível (webhook do Respondi, match de campanha, ação de automação, retomada
 * manual pela tela) e dentro da janela de validade.
 */

/** Valores aceitos em `channel_sessions.metadata.ai_gate`. */
export const AI_GATE_MODES = ["open", "allowlist"] as const;
export type AiGateMode = (typeof AI_GATE_MODES)[number];

/**
 * Normaliza o valor cru do jsonb para um modo conhecido. Ausente, `null`,
 * string desconhecida → `'open'` (o padrão seguro: não muda o comportamento de
 * quem nunca configurou nada).
 */
export function lerModoDoGate(raw: unknown): AiGateMode {
  return raw === "allowlist" ? "allowlist" : "open";
}

export interface EstadoDeElegibilidade {
  /** `channel_sessions.metadata.ai_gate` já normalizado. */
  modo: AiGateMode;
  /** `contacts.force_human` — a trava irrevogável pelo agente (regra dura 2). */
  forceHuman: boolean;
  /** `conversations.bot_silenced_until` (ou o da conversa em questão). `'infinity'` do Postgres vira `Infinity`. */
  botSilencedUntil: Date | number | null;
  /** `conversations.assignee_kind` — `'user'` = uma pessoa é a dona do thread. */
  assigneeKind: string | null;
  /** `contacts.ai_authorized_at`. `null` = nunca autorizado. */
  aiAuthorizedAt: Date | null;
  /** Agora, injetável para teste. */
  agora: Date;
  /** Janela de validade da autorização (`AI_ALLOWLIST_TTL_DAYS` em ms). */
  ttlMs: number;
}

export type MotivoDeElegibilidade =
  | "gate_aberto"
  | "force_human"
  | "conversa_silenciada"
  | "conversa_de_humano"
  | "sem_autorizacao"
  | "autorizacao_expirada"
  | "autorizado";

export interface DecisaoDeElegibilidade {
  permite: boolean;
  motivo: MotivoDeElegibilidade;
  /**
   * `true` quando o motivo do NÃO é específico do gate 'allowlist'
   * (sem_autorizacao / autorizacao_expirada). O drain usa isto para não gastar
   * um job; o turno, para logar como "conversa não autorizada" e não como erro.
   */
  bloqueioPorAllowlist: boolean;
}

function silenciadoAgora(until: Date | number | null, agora: Date): boolean {
  if (until === null) return false;
  const t = typeof until === "number" ? until : until.getTime();
  return t > agora.getTime();
}

/**
 * A decisão. Vetos que valem SEMPRE (mesmo com o gate aberto) vêm primeiro —
 * eles já eram lidos pelo motor (`isLeadInHandoff`, `skip("assigned_to_human")`)
 * e continuam valendo. O gate 'allowlist' só ACRESCENTA a exigência de
 * autorização positiva.
 */
export function decidirElegibilidade(e: EstadoDeElegibilidade): DecisaoDeElegibilidade {
  if (e.forceHuman) {
    return { permite: false, motivo: "force_human", bloqueioPorAllowlist: false };
  }
  if (silenciadoAgora(e.botSilencedUntil, e.agora)) {
    return { permite: false, motivo: "conversa_silenciada", bloqueioPorAllowlist: false };
  }
  if (e.assigneeKind === "user") {
    return { permite: false, motivo: "conversa_de_humano", bloqueioPorAllowlist: false };
  }

  if (e.modo === "open") {
    return { permite: true, motivo: "gate_aberto", bloqueioPorAllowlist: false };
  }

  // modo 'allowlist': exige condição positiva.
  if (e.aiAuthorizedAt === null) {
    return { permite: false, motivo: "sem_autorizacao", bloqueioPorAllowlist: true };
  }
  const idadeMs = e.agora.getTime() - e.aiAuthorizedAt.getTime();
  if (idadeMs > e.ttlMs) {
    return { permite: false, motivo: "autorizacao_expirada", bloqueioPorAllowlist: true };
  }
  return { permite: true, motivo: "autorizado", bloqueioPorAllowlist: false };
}

/** Default da janela de validade da autorização, em dias. Knob: `AI_ALLOWLIST_TTL_DAYS`. */
export const AI_ALLOWLIST_TTL_DAYS_DEFAULT = 21;

/** Lê o knob do ambiente (dias → ms). Valor ausente/inválido → default. */
export function ttlDaAutorizacaoMs(env: Record<string, string | undefined>): number {
  const raw = env.AI_ALLOWLIST_TTL_DAYS;
  const dias = raw !== undefined && raw !== "" ? Number(raw) : NaN;
  const efetivo = Number.isFinite(dias) && dias > 0 ? dias : AI_ALLOWLIST_TTL_DAYS_DEFAULT;
  return efetivo * 24 * 60 * 60 * 1000;
}

/**
 * Normaliza um instante cru de qualquer transporte para o que `silenciadoAgora`
 * entende: `Date`, `Infinity` (o `'infinity'` do Postgres, que o `pg` devolve
 * como string e o supabase-js também) ou `null`. String de data inválida → `null`.
 */
export function normalizarInstante(v: Date | string | number | null | undefined): Date | number | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v;
  if (typeof v === "number") return v;
  if (v === "infinity") return Number.POSITIVE_INFINITY;
  if (v === "-infinity") return Number.NEGATIVE_INFINITY;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Monta o `EstadoDeElegibilidade` a partir dos campos crus lidos do banco — a
 * MESMA normalização para os dois transportes (`consulta-pg.ts` via pool `pg` e
 * `consulta-supabase.ts` via supabase-js). Uma cópia por transporte divergiria
 * na primeira vez que alguém tratasse `'infinity'` num lado e esquecesse do
 * outro. Não roda a regra — só normaliza; quem decide é `decidirElegibilidade`.
 */
export function montarEstadoDeElegibilidade(raw: {
  aiGate: unknown;
  forceHuman: unknown;
  assigneeKind: string | null;
  botSilencedUntil: Date | string | number | null | undefined;
  aiAuthorizedAt: Date | string | null | undefined;
  agora: Date;
  ttlMs: number;
}): EstadoDeElegibilidade {
  const autorizadoEm = normalizarInstante(raw.aiAuthorizedAt);
  return {
    modo: lerModoDoGate(raw.aiGate),
    forceHuman: raw.forceHuman === true,
    botSilencedUntil: normalizarInstante(raw.botSilencedUntil),
    assigneeKind: raw.assigneeKind,
    aiAuthorizedAt: autorizadoEm instanceof Date ? autorizadoEm : null,
    agora: raw.agora,
    ttlMs: raw.ttlMs,
  };
}
