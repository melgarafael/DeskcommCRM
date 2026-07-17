/**
 * lead_notes — memória durável por lead (F3-05; migration 0015; blueprint órgão 2, a
 * inversão 1:N). O modelo escreve notas via a tool `save_lead_note`; o ÍNDICE (só as
 * headlines + id, curto) é sempre injetado no SUFIXO do prompt de abertura (após o
 * prefixo cacheável F2-17 — como o bloco temporal da F3-03), com ORÇAMENTO FIXO de
 * tokens (knob LEAD_NOTES_INDEX_MAX_TOKENS). O CORPO vem sob demanda pela tool
 * `get_lead_note`, jamais no índice.
 *
 * lead_id é chave de 1ª classe: TODA query filtra (tenant_id, lead_id) de fonte
 * confiável (row do job, nunca do payload — regra dura nº 1). Nota de um lead NUNCA
 * aparece em run de outro.
 *
 * Hard cap (padrão Hermes de tool_guardrails, blueprint 2.1): o orçamento morde na
 * ESCRITA — save_lead_note recusa a nota que faria o índice estourar e devolve um erro
 * de ENSINO pt-br pedindo CURADORIA (consolide via supersedes ou remova notas antigas).
 * Assim o índice injetado cabe no orçamento POR CONSTRUÇÃO — nunca truncado em silêncio.
 * A consolidação é actionable: save_lead_note aceita `supersedes` (ids que o modelo viu
 * no índice) e os remove na MESMA transação do insert (o orçamento é medido no estado
 * pós-supersede — substituir N notas por 1 alivia o cap de verdade).
 *
 * Disciplina de payload espelhada de update_lead_state (F2-10)/schedule_followup (F3-02):
 * whitelist .strict() + guard de prototype pollution ANTES do parse; campo extra/forjado
 * vira ENSINO, nunca strip silencioso. PII: as notas VÃO ao prompt (é o ponto — memória
 * do lead), mas o corpo/headline NUNCA entram em log estruturado nem em mensagem de erro.
 */
import { z } from 'zod';

import type { Queryable } from '../queue/queue';
import { countPayloadTokens } from '../edge/crm/get-lead-context';
import { findForbiddenKey, zodIssuesSummary } from './lead-state';

/** Whitelist EXATA do que o modelo salva — .strict() rejeita o resto (padrão F2-10). */
export const saveLeadNoteInputSchema = z.strictObject({
  headline: z.string().min(1).max(300),
  body: z.string().min(1).max(4_000),
  /** ids de notas que ESTA nota substitui (consolidação) — o modelo os vê no índice. */
  supersedes: z.array(z.string().min(1).max(64)).max(50).optional(),
});
export type SaveLeadNoteInput = z.infer<typeof saveLeadNoteInputSchema>;

/** Uma linha do índice: id (o modelo cita em get_lead_note/supersedes) + headline. */
export interface LeadNoteIndexEntry {
  id: string;
  headline: string;
}

export type SaveLeadNoteResult =
  | { ok: true; noteId: string; superseded: number; message: string }
  | {
      ok: false;
      error: {
        code: 'invalid_payload' | 'index_budget_exceeded';
        message: string;
      };
    };

const PAYLOAD_TEACHING =
  'Campos aceitos: headline (linha curta do índice, sempre visível), body (corpo completo, ' +
  'lido sob demanda por get_lead_note) e supersedes (ids de notas que esta substitui) — nada além. ' +
  'Lead e organização vêm do runtime, nunca do payload da tool.';

function teachInvalidPayload(issues: string): SaveLeadNoteResult {
  return {
    ok: false,
    error: { code: 'invalid_payload', message: `payload inválido em save_lead_note (${issues}). ${PAYLOAD_TEACHING}` },
  };
}

/**
 * Renderização determinística do índice (headlines + ids) — a MESMA visão que vai ao
 * prompt e que o orçamento mede. Vazio → linha coerente (nunca omite o bloco).
 */
export function renderNotesIndex(entries: LeadNoteIndexEntry[]): string {
  if (entries.length === 0) {
    return '— sem notas registradas para este lead.';
  }
  return entries.map((e) => `- [${e.id}] ${e.headline}`).join('\n');
}

/** Custo em tokens do índice (heurística determinística chars/3,5 — F2-08/F2-17). */
export function estimateIndexTokens(entries: LeadNoteIndexEntry[]): number {
  return countPayloadTokens(renderNotesIndex(entries));
}

/** Índice das notas do lead (id + headline), da mais antiga para a mais nova. */
export async function getLeadNotesIndex(
  db: Queryable,
  tenantId: string,
  leadId: string,
): Promise<LeadNoteIndexEntry[]> {
  const { rows } = await db.query<LeadNoteIndexEntry>(
    `select id, headline from lead_notes
     where organization_id = $1 and contact_id = $2
     order by created_at, id`,
    [tenantId, leadId],
  );
  return rows;
}

/** Corpo de UMA nota do lead — sob demanda (tool get_lead_note); null se não existe. */
export async function getLeadNoteBody(
  db: Queryable,
  tenantId: string,
  leadId: string,
  noteId: string,
): Promise<string | null> {
  // id::text = $3 (não $3::uuid): um note_id forjado/não-uuid vira MISS limpo (null),
  // nunca erro de cast 22P02 que derrubaria o job. Filtra por (tenant, lead) primeiro.
  const { rows } = await db.query<{ body: string }>(
    'select body from lead_notes where organization_id = $1 and contact_id = $2 and id::text = $3',
    [tenantId, leadId, noteId],
  );
  return rows[0]?.body ?? null;
}

/**
 * Bloco do ritual de abertura com o índice das notas (SUFIXO — nunca no prefixo
 * cacheável). O orçamento é imposto na ESCRITA, então o índice cabe por construção; a
 * checagem aqui é backstop defensivo (ex.: knob reduzido entre runs): se ainda assim
 * estourar, NÃO trunca — injeta tudo e prepende um aviso de curadoria (padrão Hermes).
 */
export async function buildNotesIndexBlock(
  db: Queryable,
  tenantId: string,
  leadId: string,
  budgetTokens: number,
): Promise<string> {
  const entries = await getLeadNotesIndex(db, tenantId, leadId);
  const rendered = renderNotesIndex(entries);
  if (entries.length > 0 && estimateIndexTokens(entries) > budgetTokens) {
    return (
      'ATENÇÃO: o índice de notas excedeu o orçamento de tokens. Consolide as notas ' +
      '(use save_lead_note com supersedes para fundir/substituir as antigas) antes de adicionar novas.\n' +
      rendered
    );
  }
  return rendered;
}

/**
 * Aplica um save_lead_note: valida whitelist, remove as notas de `supersedes` e insere a
 * nova — atômico (CTE). O orçamento do índice é medido no estado PÓS-operação; estouro →
 * ENSINO pedindo curadoria, SEM gravar nada (hard cap). Idempotência de escrita não se
 * aplica (cada save é uma nota nova, por design); o retry do run re-executa o turno e o
 * modelo decide de novo. ponytail: read-then-write sem lock — a fila tem lane por lead
 * (F2-03), turnos do mesmo lead nunca correm em paralelo.
 */
export async function applySaveLeadNote(
  db: Queryable,
  ids: { tenantId: string; leadId: string },
  cfg: { budgetTokens: number },
  rawInput: unknown,
): Promise<SaveLeadNoteResult> {
  const forbidden = findForbiddenKey(rawInput);
  if (forbidden !== null) {
    return teachInvalidPayload(`campos não reconhecidos: ${forbidden}`);
  }
  const parsed = saveLeadNoteInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return teachInvalidPayload(zodIssuesSummary(parsed.error));
  }
  const input = parsed.data;
  const superseded = new Set(input.supersedes ?? []);

  // Índice que RESULTARIA: notas atuais menos as substituídas, mais a nova headline.
  // toDelete = interseção com as notas REAIS deste lead (ids vindos do DB, uuids
  // válidos + já escopados por tenant/lead) — id forjado/de outro lead vira no-op, nunca
  // erro de cast nem deleção cruzada.
  const current = await getLeadNotesIndex(db, ids.tenantId, ids.leadId);
  const toDelete = current.filter((e) => superseded.has(e.id)).map((e) => e.id);
  // Placeholder do MESMO comprimento de um uuid (36) para a nota nova: o custo estimado
  // na escrita bate com o render de leitura (id real), então "cabe no orçamento" no save
  // ⇒ cabe no índice injetado — a invariante do hard cap não vaza por sub-contagem.
  const wouldBe: LeadNoteIndexEntry[] = [
    ...current.filter((e) => !superseded.has(e.id)),
    { id: '00000000-0000-0000-0000-000000000000', headline: input.headline },
  ];
  if (estimateIndexTokens(wouldBe) > cfg.budgetTokens) {
    return {
      ok: false,
      error: {
        code: 'index_budget_exceeded',
        message:
          `o índice de notas deste lead excederia o orçamento de ${cfg.budgetTokens} tokens. ` +
          'Consolide antes de adicionar: escreva UMA nota que resuma as antigas e liste os ids delas em ' +
          '"supersedes" (para removê-las), ou deixe de fora o que não é essencial. Não é possível apenas acumular.',
      },
    };
  }

  // Insert + supersede numa única transação implícita (CTE): a nova nota entra e as
  // substituídas saem juntas — nunca um estado intermediário fora do orçamento.
  const { rows } = await db.query<{ id: string; superseded: string }>(
    `with removed as (
       delete from lead_notes
       where organization_id = $1 and contact_id = $2 and id = any($3::uuid[])
       returning id
     ),
     inserted as (
       insert into lead_notes (organization_id, contact_id, headline, body)
       values ($1, $2, $4, $5)
       returning id
     )
     select inserted.id, (select count(*) from removed)::text as superseded from inserted`,
    [ids.tenantId, ids.leadId, toDelete, input.headline, input.body],
  );
  const row = rows[0]!;
  const supersededCount = Number(row.superseded);
  return {
    ok: true,
    noteId: row.id,
    superseded: supersededCount,
    message:
      supersededCount > 0
        ? `nota salva; ${supersededCount} nota(s) antiga(s) consolidada(s)/removida(s).`
        : 'nota salva na memória do lead.',
  };
}
