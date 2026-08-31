/**
 * Acesso tipado às tabelas núcleo do harness. SQL cru, sem ORM.
 *
 * ponytail: fluxo de espelho morto no porte para o SonghaiCRM (mesmo banco agora) —
 * removidos createTenant, upsertLead, getLead, listLeads, ingestCrmEvent,
 * listCrmEvents e os tipos TenantRow/LeadRow/EventInboxRow (organizations/contacts
 * são as tabelas reais do CRM; o drain lê event_log direto). Sobra o inbox de
 * escalação humana (agent_inbox_items).
 *
 * Regra de isolamento (F2-02): toda query filtra `organization_id` — nenhuma função
 * devolve linha de outra org (`null` = item de plataforma).
 */
import type pg from 'pg';

/**
 * O vocabulário dos avisos do runtime. Espelha o CHECK de
 * `agent_inbox_items.kind` — e o espelho é MECÂNICO: o invariante
 * `tests/invariants/vocabulario-banco-x-typescript.test.ts` compara os dois
 * conjuntos contra Postgres real, porque o compilador não enxerga o banco.
 *
 * Esta lista já ficou 3 valores atrás do banco (`judge_unaligned`,
 * `followup_dead`, `next_action_ambiguous`) sem nada falhar. Quem adiciona um
 * kind numa migration adiciona aqui na mesma mudança.
 */
export type InboxKind =
  | 'qr_rescan'
  | 'job_dead'
  | 'event_dead'
  | 'budget_exceeded'
  | 'handoff'
  | 'promotion_review'
  | 'judge_unaligned'
  | 'followup_dead'
  | 'snooze_expired'
  | 'next_action_ambiguous'
  | 'risk_backlog_seeded'
  | 'reactivation_expired'
  | 'capabilities_missing'
  | 'message_send_stuck'
  // (migration 0120) A plataforma do canal decide sozinha: reprova um modelo
  // aprovado, suspende o número, exige KYC. Nada disso chegava ao operador — a
  // descoberta acontecia no disparo que não saiu.
  //
  // Estes DOIS nomes precisam existir aqui, e não só no CHECK do banco:
  // `vocabulario-banco-x-typescript` exige que os dois vocabulários digam a
  // mesma coisa, e foi ele que pegou a primeira versão desta mudança — que
  // tinha o banco atualizado e o tipo não.
  | 'channel_template_review'
  | 'channel_number_alert'
  | 'midia_nao_lida'
  | 'promise_unfulfilled'
  | 'contact_proposal_expired'
  // (migration 0159) O degrau de AVISO do teto de gasto de IA — o que a
  // organização vê antes de qualquer parada. Existe separado de
  // `budget_exceeded` porque diz coisa diferente: um relata que algo
  // ACONTECEU e a IA segue; o outro, que ela parou. Severity 'warn'.
  | 'budget_warning'
  // (migration 0166) Agendamento (`appointments`) que passou de `scheduled`
  // para "deveria ter terminado há mais de 1h" e ninguém confirmou o
  // desfecho. Emitido só pelo cron appointment-outcome-nudge.
  | 'appointment_outcome_pending'
  | 'other';

export interface InboxItemRow {
  id: string;
  organization_id: string | null;
  kind: InboxKind;
  severity: 'info' | 'warn' | 'critical';
  title: string;
  body: string | null;
  ref_kind: string | null;
  ref_id: string | null;
  status: 'open' | 'ack' | 'resolved';
  created_at: Date;
}

function one<T>(rows: T[], what: string): T {
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`esperava uma linha de ${what}, veio nenhuma`);
  }
  return row;
}

/**
 * Como não abrir um segundo aviso para o mesmo problema ainda aberto.
 *
 * `kind` — um por organização. Serve para defeito SISTÊMICO, que não é de um
 * cliente: teto de orçamento estourado, capacidades que não montaram.
 *
 * `kind_e_ref` — um por (kind, ref). Serve para aviso que fala de UMA conversa
 * ou de UM lead. Dedupar esses por `kind` sozinho engoliria o aviso de outro
 * cliente, que é pior que repetir: some sinal em vez de sobrar ruído.
 */
export type InboxDedupe = 'kind' | 'kind_e_ref';

/**
 * Abre um aviso na Central.
 *
 * ═══ POR QUE O DEDUP MORA AQUI, E NÃO EM CADA CHAMADOR ═══
 *
 * A guarda de "não abre outro enquanto o anterior está aberto" existia escrita
 * três vezes à mão, em SQL inline, em três arquivos — e nunca na função que todos
 * usam. Quem chama `insertInboxItem` não tinha como pedi-la, então não deduplicava:
 * o aviso de promessa do papel Operador nascia de novo a cada turno, e N cópias do
 * mesmo item enterram o item que pedia decisão. Alarme repetido treina o dono a
 * ignorar o alarme certo.
 *
 * Omitir `dedupe` mantém o comportamento de sempre — uma linha por chamada —, e
 * isso é deliberado: há kinds que QUEREM uma linha por evento (`job_dead` é um
 * registro de ocorrência, não um estado).
 *
 * `where not exists` e não `on conflict`: um índice único exigiria incluir
 * `status`, que é MUTÁVEL, e isso quebraria reabrir um item resolvido. A corrida
 * de dois inserts simultâneos é a mesma que as três irmãs já aceitam — no pior
 * caso nascem dois avisos idênticos, que é exatamente o estado de hoje.
 *
 * Devolve `null` quando o dedup barrou. Não lança: "já havia um aviso aberto" é
 * desfecho normal, não erro.
 */
export async function insertInboxItem(
  db: pg.Pool,
  tenantId: string | null, // null = plataforma (ex.: infra)
  input: { kind: InboxKind; title: string; severity?: InboxItemRow['severity']; body?: string; refKind?: string; refId?: string },
  dedupe?: InboxDedupe,
): Promise<InboxItemRow | null> {
  const valores = [
    tenantId,
    input.kind,
    input.severity ?? 'warn',
    input.title,
    input.body ?? null,
    input.refKind ?? null,
    input.refId ?? null,
  ];

  if (dedupe === undefined) {
    const { rows } = await db.query<InboxItemRow>(
      `insert into agent_inbox_items (organization_id, kind, severity, title, body, ref_kind, ref_id)
       values ($1, $2, $3, $4, $5, $6, $7)
       returning *`,
      valores,
    );
    return one(rows, 'agent_inbox_items');
  }

  // `is not distinct from` e não `=`: organização nula (avisos de plataforma) e
  // ref nula precisam casar com nula, e `null = null` é null, não true.
  const { rows } = await db.query<InboxItemRow>(
    `insert into agent_inbox_items (organization_id, kind, severity, title, body, ref_kind, ref_id)
     select $1, $2, $3, $4, $5, $6, $7
      where not exists (
        select 1 from agent_inbox_items
         where organization_id is not distinct from $1
           and kind = $2
           and status = 'open'
           and ($8 = false or (ref_kind is not distinct from $6 and ref_id is not distinct from $7))
      )
     returning *`,
    [...valores, dedupe === 'kind_e_ref'],
  );
  return rows[0] ?? null;
}

export async function listOpenInboxItems(db: pg.Pool, tenantId: string): Promise<InboxItemRow[]> {
  const { rows } = await db.query<InboxItemRow>(
    `select * from agent_inbox_items
     where organization_id = $1 and status = 'open'
     order by created_at desc`,
    [tenantId],
  );
  return rows;
}
