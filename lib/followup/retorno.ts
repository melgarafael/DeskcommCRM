/**
 * O RETORNO AGENDADO — a regra, num lugar só.
 *
 * "Retorno" é o nome de gente para o que o banco chama de promessa: uma linha em
 * `cron_jobs` (kind='at', job_kind='followup_turn') que, no horário combinado,
 * enfileira um turno do agente para aquele contato. É o mecanismo anti-morte do
 * invariante 4 da doutrina (`docs/doctrine/sistema-vivo.md`): nenhuma demanda
 * aberta pode ficar sem próximo passo.
 *
 * ⚠️ POR QUE ESTE MÓDULO EXISTE. A regra já era executada pelo motor do agente
 * (`lib/agent-engine/agent/schedule-followup.ts`, sobre `pg.Pool`) e passou a ser
 * executada também pela capacidade configurável na tela e pela rota do humano —
 * dois runtimes com clientes de banco diferentes. Reescrever a validação de
 * janela e o guard anti-empilhamento do outro lado faria a IA e o humano
 * operarem por regras diferentes, e o sistema mentiria para um dos dois. Aqui a
 * DECISÃO é única; o que varia por runtime é só o acesso ao banco, atrás da
 * porta `RetornoDb`.
 *
 * O que NÃO mora aqui: a emissão de `crm_lead_activities`. Os dois runtimes
 * escrevem a timeline por caminhos diferentes (`emitLeadActivity` com o client do
 * Supabase, `emitAgentActivityForContact` com `pg.Pool`), e a regra da LINHA já é
 * compartilhada por `buildLeadActivityRow`. Duplicar aqui a escolha do emissor
 * seria inventar um terceiro.
 */
import { computeInitialRunAt } from "@/lib/agent-engine/cron/schedule";

import type { JanelaDeRetorno } from "./janela";

/**
 * As três situações de um retorno — e por que `cancelado` precisou de coluna.
 *
 * `enabled = false` significa DUAS coisas no `cron_jobs`: o one-shot disparou
 * (fireOneDue) ou alguém cancelou. Enquanto a diferença não era observável, o
 * agente não tinha como saber que o humano desmarcou o retorno — e o invariante
 * 2 (continuidade humano→IA) ficava pela metade. `cancelled_at` (migration 0102)
 * é o que torna as duas distinguíveis. `nao_disparado` é o terceiro `enabled = false`:
 * o scheduler desligou o disparo porque a empresa estava parada (`last_error =
 * 'org_nao_operante'`) — o retorno NÃO saiu, e quem lê não pode dizer que saiu.
 */
export type SituacaoDoRetorno = "agendado" | "disparado" | "nao_disparado" | "cancelado";

/** O payload que viaja no `cron_jobs` e chega ao turno futuro do agente. */
export interface PayloadDoRetorno {
  /** Por que voltar a falar — vai ao turno futuro e à timeline. Sem PII nova. */
  reason: string;
  /** O que foi prometido ao cliente, nas palavras do agente. */
  promise: string | null;
  /** O instante ABSOLUTO prometido, como o agente o escreveu (ISO). */
  promised_at: string | null;
  /** Contexto curto para o run futuro se reencontrar. */
  context_snapshot?: string | null;
  /** De onde veio o agendamento (ex.: `reactivation`). */
  source?: string;
}

export interface RetornoAgendado {
  id: string;
  contactId: string;
  /** Quando o sistema vai (ou foi) falar com a pessoa — já com o stagger. ISO. */
  quando: string;
  /** O instante como o agente prometeu, antes do stagger. ISO ou null. */
  prometidoPara: string | null;
  situacao: SituacaoDoRetorno;
  motivo: string;
  promessa: string | null;
  canceladoEm: string | null;
  motivoDoCancelamento: string | null;
}

/**
 * Acesso ao banco, estreito por consumidor — mesma doutrina de `FollowupGateDb`.
 * Estreito para ser implementável tanto sobre `pg.Pool` quanto sobre o client do
 * Supabase, e para os testes da REGRA não precisarem de Postgres.
 */
export interface RetornoDb {
  /** O retorno VIVO do contato, se houver (o guard anti-empilhamento). */
  buscaRetornoVivo(orgId: string, contactId: string): Promise<RetornoAgendado | null>;
  /** Cria a linha. `quando` já vem com o stagger aplicado por quem chama. */
  insere(
    orgId: string,
    input: { contactId: string; quando: Date; payload: PayloadDoRetorno },
  ): Promise<RetornoAgendado>;
  buscaPorId(orgId: string, retornoId: string): Promise<RetornoAgendado | null>;
  /** Marca cancelado. `false` = a linha já não estava agendada (corrida perdida). */
  marcaCancelado(
    orgId: string,
    retornoId: string,
    quando: Date,
    motivo: string,
  ): Promise<boolean>;
  /** Histórico do contato, mais próximo do disparo primeiro. */
  lista(orgId: string, contactId: string, limite: number): Promise<RetornoAgendado[]>;
}

// ---------------------------------------------------------------------------
// A regra, pura
// ---------------------------------------------------------------------------

export type RecusaDeAgendamento =
  | "instante_invalido"
  | "instante_no_passado"
  | "instante_fora_da_janela"
  | "ja_existe_retorno";

export interface InstanteAceito {
  ok: true;
  quando: Date;
}
export interface InstanteRecusado {
  ok: false;
  codigo: Exclude<RecusaDeAgendamento, "ja_existe_retorno">;
}

/** Duração em português — só ordem de grandeza, nunca PII. */
export function duracaoLegivel(ms: number): string {
  const minutos = Math.round(ms / 60_000);
  if (minutos < 60) return `${minutos} min`;
  const horas = Math.round(ms / 3_600_000);
  if (horas < 48) return `${horas} h`;
  return `${Math.round(ms / 86_400_000)} dias`;
}

/**
 * O instante prometido cabe na janela?
 *
 * Pura de propósito: é a única parte da regra que precisa ser exercitada em
 * todos os cantos (limite inferior, limite superior, data podre) sem banco.
 */
export function validaInstanteDoRetorno(
  prometidoIso: string,
  agora: Date,
  janela: JanelaDeRetorno,
): InstanteAceito | InstanteRecusado {
  const ms = Date.parse(prometidoIso);
  if (Number.isNaN(ms)) return { ok: false, codigo: "instante_invalido" };

  const agoraMs = agora.getTime();
  if (ms <= agoraMs) return { ok: false, codigo: "instante_no_passado" };
  if (ms < agoraMs + janela.minAheadMs || ms > agoraMs + janela.maxAheadMs) {
    return { ok: false, codigo: "instante_fora_da_janela" };
  }
  return { ok: true, quando: new Date(ms) };
}

// ---------------------------------------------------------------------------
// Operações
// ---------------------------------------------------------------------------

export interface AgendaRetornoInput {
  /** Por que voltar a falar. */
  motivo: string;
  /** Instante ABSOLUTO, ISO 8601. Relativo ("amanhã") é lido dias depois e não significa nada. */
  prometidoPara: string;
  /** O que foi prometido ao cliente. */
  promessa: string;
  contexto?: string | null;
  source?: string;
}

export type ResultadoDoAgendamento =
  | { ok: true; retorno: RetornoAgendado }
  | {
      ok: false;
      codigo: RecusaDeAgendamento;
      /** O retorno que já existia — só em `ja_existe_retorno`. */
      existente?: RetornoAgendado;
      /** A janela em vigor — quem traduz a recusa em texto precisa dela. */
      janela: JanelaDeRetorno;
    };

/**
 * Agenda o retorno, aplicando janela e guard anti-empilhamento.
 *
 * ⚠️ UM RETORNO VIVO POR CONTATO. Sem este guard o agente marca "reconfirmar
 * amanhã" a cada turno e a pessoa vira alvo de N sequências paralelas — o bug de
 * spam que já aconteceu em produção. Recusar não é erro fatal: quem chama ENSINA
 * (modelo) ou informa (humano) que já existe um retorno a caminho.
 */
export async function agendaRetorno(
  db: RetornoDb,
  cfg: { agora: Date; janela: JanelaDeRetorno },
  ids: { orgId: string; contactId: string },
  input: AgendaRetornoInput,
): Promise<ResultadoDoAgendamento> {
  const instante = validaInstanteDoRetorno(input.prometidoPara, cfg.agora, cfg.janela);
  if (!instante.ok) return { ok: false, codigo: instante.codigo, janela: cfg.janela };

  const vivo = await db.buscaRetornoVivo(ids.orgId, ids.contactId);
  if (vivo) {
    return { ok: false, codigo: "ja_existe_retorno", existente: vivo, janela: cfg.janela };
  }

  // Stagger determinístico: dois retornos marcados para o mesmo minuto nascem
  // espalhados. O mesmo cálculo do cron do motor — importado, não recopiado.
  const quando = computeInitialRunAt(
    { kind: "at", at: instante.quando },
    cfg.agora.getTime(),
    cfg.janela.staggerWindowMs,
    ids.contactId,
  );

  const retorno = await db.insere(ids.orgId, {
    contactId: ids.contactId,
    quando,
    payload: {
      reason: input.motivo,
      promise: input.promessa,
      promised_at: input.prometidoPara,
      context_snapshot: input.contexto ?? null,
      ...(input.source ? { source: input.source } : {}),
    },
  });

  return { ok: true, retorno };
}

export type RecusaDeCancelamento = "nao_encontrado" | "ja_encerrado";

export type ResultadoDoCancelamento =
  | { ok: true; retorno: RetornoAgendado }
  | { ok: false; codigo: RecusaDeCancelamento; existente?: RetornoAgendado };

/**
 * Cancela um retorno ainda não disparado.
 *
 * ⚠️ CANCELAR NÃO É APAGAR (Decisão 2 do briefing): a linha fica, com a marca de
 * quando e por quê. É isso que permite ao agente descobrir, ao retomar, que o
 * humano desmarcou — e não repropor o que já foi negado.
 *
 * `ja_encerrado` cobre tanto o disparado quanto o já cancelado: em nenhum dos
 * dois há o que cancelar, e reescrever o desfecho de um retorno que já aconteceu
 * transformaria histórico em ficção.
 */
export async function cancelaRetorno(
  db: RetornoDb,
  cfg: { agora: Date },
  ids: { orgId: string; retornoId: string },
  input: { motivo: string },
): Promise<ResultadoDoCancelamento> {
  const atual = await db.buscaPorId(ids.orgId, ids.retornoId);
  if (!atual) return { ok: false, codigo: "nao_encontrado" };
  if (atual.situacao !== "agendado") {
    return { ok: false, codigo: "ja_encerrado", existente: atual };
  }

  // O UPDATE condicional é a trava real: entre a leitura e a escrita o cron pode
  // ter disparado. Perder essa corrida é `ja_encerrado`, não erro interno.
  const marcou = await db.marcaCancelado(ids.orgId, ids.retornoId, cfg.agora, input.motivo);
  if (!marcou) {
    const relido = await db.buscaPorId(ids.orgId, ids.retornoId);
    return { ok: false, codigo: "ja_encerrado", ...(relido ? { existente: relido } : {}) };
  }

  return {
    ok: true,
    retorno: {
      ...atual,
      situacao: "cancelado",
      canceladoEm: cfg.agora.toISOString(),
      motivoDoCancelamento: input.motivo,
    },
  };
}

/** Teto de linhas devolvidas — histórico de retorno é curto por natureza. */
export const LIMITE_PADRAO_DA_LISTA = 20;

export async function listaRetornos(
  db: RetornoDb,
  ids: { orgId: string; contactId: string },
  opts: { limite?: number } = {},
): Promise<RetornoAgendado[]> {
  const limite = Math.min(Math.max(opts.limite ?? LIMITE_PADRAO_DA_LISTA, 1), 100);
  return db.lista(ids.orgId, ids.contactId, limite);
}

/**
 * Como uma linha de `cron_jobs` vira um retorno — a derivação da situação num
 * lugar só, para os dois adaptadores concordarem.
 */
export function situacaoDoRetorno(row: {
  enabled: boolean;
  cancelled_at: string | null;
  last_error?: string | null;
}): SituacaoDoRetorno {
  if (row.cancelled_at !== null) return "cancelado";
  if (row.enabled) return "agendado";
  return row.last_error === "org_nao_operante" ? "nao_disparado" : "disparado";
}

/**
 * O status que a fila de IA › Follow-ups mostra para uma promessa. `enabled=false`
 * com `last_error='org_nao_operante'` é o disparo único que o scheduler DESLIGOU
 * porque a empresa estava parada: não foi entregue, e "concluída" diria o contrário.
 */
export function statusDaPromessaNaFila(row: {
  enabled: boolean;
  cancelled_at: string | null;
  last_error: string | null;
}): "agendada" | "concluída" | "cancelada" | "não disparada" {
  const situacao = situacaoDoRetorno(row);
  if (situacao === "cancelado") return "cancelada";
  if (situacao === "agendado") return "agendada";
  return situacao === "nao_disparado" ? "não disparada" : "concluída";
}
