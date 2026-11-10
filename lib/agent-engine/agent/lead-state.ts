/**
 * lead_state — estado do funil por lead (F2-10; migration 0008).
 *
 * Doutrina (feature list / Anthropic aplicada ao lead): o modelo MARCA avanços
 * via tool `update_lead_state`; ele nunca redefine nem regride livremente. A
 * máquina de estados vive AQUI, no código (regra dura nº 9 — comportamento
 * crítico é determinístico): transição inválida vira erro de ENSINO pt-br
 * citando o estágio atual e os avanços válidos, nunca gravação silenciosa.
 *
 * Grafo v0 FIXO (não é knob por org — parametrização por tenant é F5):
 *   new → contacted → qualifying → qualified → negotiating → won | lost
 *   `lost` é alcançável de qualquer estágio ativo; won/lost são terminais.
 *
 * Payload da tool é whitelisted por Zod .strict(): campo extra (tenant_id/
 * lead_id/stage_id forjado, __proto__…) é REJEITADO com ensino — nunca stripped
 * em silêncio (stripping esconderia o ataque do modelo-professor). tenant/lead
 * vêm SEMPRE do runtime (row do job), jamais do payload.
 */
import { z } from 'zod';

import type { Queryable } from '../queue/queue';

export const LEAD_STAGES = [
  'new',
  'contacted',
  'qualifying',
  'qualified',
  'negotiating',
  'won',
  'lost',
] as const;
export type LeadStage = (typeof LEAD_STAGES)[number];

/** Grafo de transições v0 — fonte única; o CHECK da 0008 é só backstop. */
export const LEAD_STAGE_TRANSITIONS: Readonly<Record<LeadStage, readonly LeadStage[]>> = {
  new: ['contacted', 'lost'],
  contacted: ['qualifying', 'lost'],
  qualifying: ['qualified', 'lost'],
  qualified: ['negotiating', 'lost'],
  negotiating: ['won', 'lost'],
  won: [],
  lost: [],
};

export function isValidTransition(from: LeadStage, to: LeadStage): boolean {
  return LEAD_STAGE_TRANSITIONS[from].includes(to);
}

/** Whitelist EXATA do que o modelo pode marcar — .strict() rejeita o resto. */
export const updateLeadStateInputSchema = z.strictObject({
  stage: z.enum(LEAD_STAGES).optional(),
  qualification: z
    .strictObject({
      budget: z.string().max(300).optional(),
      authority: z.string().max(300).optional(),
      need: z.string().max(300).optional(),
      timeline: z.string().max(300).optional(),
    })
    .optional(),
  next_action: z.string().max(500).nullable().optional(),
  reason: z.string().max(500).optional(),
});
export type UpdateLeadStateInput = z.infer<typeof updateLeadStateInputSchema>;

// "Responder o cliente" não é próxima ação: o agente já responde a cada
// mensagem, e a frase ocuparia a faixa do card (a proposta, com Aprovar e
// Ignorar) sem dizer nada a quem vende — escondendo "esfriando", a retomada e a
// probabilidade, que moram na MESMA faixa (`lib/kanban/card-state.ts`).
//
// Só a frase VAZIA cai aqui: um verbo de resposta + palavras de enchimento, e
// nada mais. "Responder ao cliente com o orçamento do modelo X" tem conteúdo e
// passa. As listas são curtas de propósito: o alvo é a frase que não diz nada,
// não julgar o texto do modelo. Verbos e substantivos aqui valem em espanhol
// também ("Responder al cliente"), idioma em que o agente igualmente opera.
const VERBOS_DE_RESPOSTA = new Set(['responder', 'atender', 'retornar']);
const SO_FIGURANTES = new Set([
  'cliente',
  'lead',
  'contato',
  'mensagem',
  'duvida',
  'pergunta',
  'agora',
  'logo',
]);
const DE_LIGACAO = new Set([
  'a',
  'as',
  'o',
  'os',
  'ao',
  'aos',
  'do',
  'da',
  'de',
  'para',
  'pro',
  'pra',
  'nova',
  'ultima',
  // espanhol
  'al',
  'el',
  'la',
  'los',
  'las',
  'del',
]);

/**
 * A frase é só "responder o cliente" (ou equivalente): não é próxima ação.
 *
 * Sem acento e sem caixa, porque o modelo escreve "Responder à dúvida do
 * cliente", "responder ao cliente." e "Atender o lead" para dizer a MESMA coisa:
 * a resposta que ele já dá sozinho a cada mensagem.
 */
export function proximaAcaoGenerica(texto: string): boolean {
  const [verbo, ...resto] = texto
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((p) => p !== '' && !DE_LIGACAO.has(p));
  return (
    verbo !== undefined && VERBOS_DE_RESPOSTA.has(verbo) && resto.every((p) => SO_FIGURANTES.has(p))
  );
}

export interface LeadStateRow {
  id: string;
  organization_id: string;
  contact_id: string;
  stage: LeadStage;
  qualification: Record<string, string>;
  next_action: string | null;
  /** Identidade da proposta corrente — ver migration 0073 e o upsert abaixo. */
  next_action_seq: number;
  updated_at: Date;
}

export type LeadStateUpdateResult =
  | {
      ok: true;
      state: LeadStateRow;
      /** null = update sem mudança de estágio (inclui o no-op idempotente). */
      transition: { from: LeadStage; to: LeadStage; reason?: string } | null;
      message: string;
    }
  | { ok: false; error: { code: 'invalid_payload' | 'invalid_transition'; message: string } };

function teachInvalidTransition(current: LeadStage, to: LeadStage): LeadStateUpdateResult {
  const valid = LEAD_STAGE_TRANSITIONS[current];
  const options =
    valid.length > 0
      ? `A partir de "${current}" os avanços válidos são: ${valid.map((s) => `"${s}"`).join(', ')}.`
      : `"${current}" é estágio terminal — não há transições possíveis.`;
  return {
    ok: false,
    error: {
      code: 'invalid_transition',
      message:
        `transição de estágio inválida: o lead está em "${current}" e "${to}" não é um avanço permitido ` +
        `(regressão ou salto no funil é proibido). ${options} Marque apenas o próximo avanço real.`,
    },
  };
}

const PAYLOAD_TEACHING =
  'Campos aceitos: stage, qualification {budget, authority, need, timeline}, next_action, reason — ' +
  'nada além. Lead e organização vêm do runtime, nunca do payload da tool.';

function teachInvalidPayload(issues: string): LeadStateUpdateResult {
  return {
    ok: false,
    error: {
      code: 'invalid_payload',
      message: `payload inválido em update_lead_state (${issues}). ${PAYLOAD_TEACHING}`,
    },
  };
}

export function zodIssuesSummary(error: z.ZodError): string {
  // Só NOMES de campos/códigos na mensagem — nunca valores (podem carregar PII).
  return error.issues
    .map((i) =>
      i.code === 'unrecognized_keys'
        ? `campos não reconhecidos: ${i.keys.join(', ')}`
        : `${i.path.join('.') || '(raiz)'}: ${i.code}`,
    )
    .join('; ');
}

// Zod v4 DROPA chaves __proto__ silenciosamente (hardening próprio) em vez de
// acusá-las em unrecognized_keys — aqui o acceptance exige REJEIÇÃO com ensino
// (strip silencioso esconderia o ataque do modelo-professor), então a checagem
// é explícita, antes do parse, recursiva no payload raso da tool.
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function findForbiddenKey(value: unknown): string | null {
  if (value === null || typeof value !== 'object') {
    return null;
  }
  for (const key of Object.getOwnPropertyNames(value)) {
    if (FORBIDDEN_KEYS.has(key)) {
      return key;
    }
    const nested = findForbiddenKey((value as Record<string, unknown>)[key]);
    if (nested !== null) {
      return nested;
    }
  }
  return null;
}

export async function getLeadState(
  db: Queryable,
  tenantId: string,
  leadId: string,
): Promise<LeadStateRow | null> {
  const { rows } = await db.query<LeadStateRow>(
    'select * from lead_state where organization_id = $1 and contact_id = $2',
    [tenantId, leadId],
  );
  return rows[0] ?? null;
}

/**
 * Aplica um update marcado pelo modelo: valida whitelist + transição, faz upsert
 * do estado e (se houve avanço) grava a transição no histórico — upsert e append
 * num ÚNICO statement (CTE), atômico sem plumbing de transação.
 *
 * Idempotente: stage igual ao atual → no-op amigável (retry do run não assusta o
 * modelo nem duplica histórico). ponytail: read-then-write sem lock — a fila tem
 * lane por lead (F2-03), turnos do mesmo lead nunca correm em paralelo.
 */
export async function applyLeadStateUpdate(
  db: Queryable,
  ids: { tenantId: string; leadId: string; jobId?: string | null },
  rawInput: unknown,
): Promise<LeadStateUpdateResult> {
  const forbidden = findForbiddenKey(rawInput);
  if (forbidden !== null) {
    return teachInvalidPayload(`campos não reconhecidos: ${forbidden}`);
  }
  const parsed = updateLeadStateInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return teachInvalidPayload(zodIssuesSummary(parsed.error));
  }
  const input = parsed.data;

  // A frase que não diz nada não é gravada — o resto da chamada vale (a mesma
  // chamada pode marcar avanço de estágio) e o modelo recebe o aviso na resposta
  // da ferramenta. Não gravar é também o que impede `next_action_seq` de andar:
  // a proposta que a pessoa está vendo no card continua sendo a mesma.
  const generica = typeof input.next_action === 'string' && proximaAcaoGenerica(input.next_action);
  const novaProximaAcao = generica ? undefined : input.next_action;

  const current = await getLeadState(db, ids.tenantId, ids.leadId);
  const currentStage: LeadStage = current?.stage ?? 'new';

  let transition: { from: LeadStage; to: LeadStage; reason?: string } | null = null;
  let noop = false;
  if (input.stage !== undefined && input.stage !== currentStage) {
    if (!isValidTransition(currentStage, input.stage)) {
      return teachInvalidTransition(currentStage, input.stage);
    }
    transition = { from: currentStage, to: input.stage, ...(input.reason !== undefined ? { reason: input.reason } : {}) };
  } else if (input.stage !== undefined) {
    noop = true;
  }

  const nextStage = transition?.to ?? currentStage;
  const qualification = { ...(current?.qualification ?? {}), ...(input.qualification ?? {}) };
  const nextAction =
    novaProximaAcao !== undefined ? novaProximaAcao : (current?.next_action ?? null);

  // `next_action_seq` só avança quando a próxima ação é REESCRITA nesta chamada
  // ($6), e avança mesmo que o texto novo seja idêntico ao anterior: é o que
  // distingue "a mesma proposta" de "a mesma frase". A autorização humana
  // carrega este número e a execução o compara — comparar o texto deixaria
  // passar a proposta reescrita com as mesmas palavras, e comparar `updated_at`
  // recusaria autorização válida a cada escrita de estágio ou BANT.
  //
  // Este é o ÚNICO caminho de escrita de `next_action`, então o incremento tem
  // um lugar só. Trigger não serviria: do lado do banco, "escreveu o mesmo
  // valor de novo" é indistinguível de "não escreveu".
  const upsert = `
    insert into lead_state (organization_id, contact_id, stage, qualification, next_action, next_action_seq)
    values ($1, $2, $3, $4::jsonb, $5, case when $6::boolean then 1 else 0 end)
    on conflict (organization_id, contact_id) do update
      set stage = excluded.stage,
          qualification = excluded.qualification,
          next_action = excluded.next_action,
          next_action_seq = lead_state.next_action_seq + case when $6::boolean then 1 else 0 end,
          updated_at = now()
    returning *`;
  const upsertParams = [
    ids.tenantId,
    ids.leadId,
    nextStage,
    JSON.stringify(qualification),
    nextAction,
    novaProximaAcao !== undefined,
  ];

  let state: LeadStateRow;
  if (transition !== null) {
    const { rows } = await db.query<LeadStateRow>(
      `with up as (${upsert}),
       tr as (
         insert into lead_state_transitions (organization_id, contact_id, job_id, from_stage, to_stage, reason)
         values ($1, $2, $7, $8, $3, $9)
       )
       select * from up`,
      [...upsertParams, ids.jobId ?? null, transition.from, transition.reason ?? null],
    );
    state = rows[0]!;
  } else {
    const { rows } = await db.query<LeadStateRow>(upsert, upsertParams);
    state = rows[0]!;
  }

  const message = transition
    ? `estado atualizado: o lead avançou de "${transition.from}" para "${transition.to}".`
    : noop
      ? `o lead já está em "${currentStage}" — nada a alterar no estágio.`
      : `estado atualizado (estágio permanece "${currentStage}").`;
  // O aviso vai na `message`, que é de onde o modelo lê o desfecho da
  // ferramenta. Recusar a chamada inteira seria pior: o avanço de estágio que
  // veio junto é legítimo e se perderia por causa de um campo de texto.
  const avisoDaGenerica = generica
    ? ' A próxima ação NÃO foi gravada: responder o cliente é o que você já faz a cada ' +
      'mensagem. Grave next_action só quando houver uma ação concreta (o que, e até ' +
      'quando); sem ela, não envie o campo.'
    : '';
  return { ok: true, state, transition, message: message + avisoDaGenerica };
}
