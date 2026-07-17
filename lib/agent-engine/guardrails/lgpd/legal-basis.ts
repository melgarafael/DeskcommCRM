/**
 * Conformidade LGPD como gate de release (F4-09; edge-contract §5.5 achado 5.6 +
 * §6 "Metadado legal_basis + data_origin por contato"). Duas checagens de base legal,
 * ambas de fonte confiável (tabelas canônicas do CRM, lidas no turno — nunca do body,
 * regra dura nº 1):
 *
 *   (a) is_anonymized — contato anonimizado (anonimização é IRREVERSÍVEL): NENHUMA
 *       escrita/envio pode ir a ele, nunca (não é só o 1º toque). Veto `lgpd_anonymized`.
 *   (b) 1º toque de PROSPECÇÃO sem base legal válida (legitimate_interest com
 *       legal_basis_ref/LIA, OU consent concedido; origem 'import' SEM prova é sempre
 *       inválida) → veto `lgpd_missing_legal_basis`. "Prospecção" = envio que NÃO
 *       responde a um inbound do lead (cold touch): responder a quem te procurou não é
 *       prospecção e não exige base legal de prospecção — do contrário todo 1º reply de
 *       inbound (o MVP inteiro) seria vetado. O cold first-touch é pós-MVP (edge-contract §6),
 *       então em MVP isProspecting é sempre false e este ramo é inócuo para inbound/follow-up.
 *
 * Fonte dos sinais pós-fusão: `contacts.consent` (jsonb de consentimento POR FINALIDADE
 * do Deskcomm — `{marketing: {granted_at, source, version}, transactional: ..., profiling: ...}`),
 * `contacts.source` (data_origin) e `contacts.is_anonymized` — tudo no mesmo banco, sem gap
 * de MCP. Consentimento de PROSPECÇÃO = finalidade `marketing` concedida (`granted_at`
 * não-vazio). LIA = leitura DEFENSIVA de `consent.legitimate_interest.ref` (chave que o
 * default do CRM não cria — presente só quando o operador a registra); campo ausente =
 * sem base legal.
 */
import type pg from 'pg';
import type { Logger } from '../../obs/logger';

/** Base legal de um contato para prospecção (LGPD art. 7º). */
export interface LegalBasis {
  /** hipótese derivada do `contacts.consent`; null = nenhuma. */
  basis: 'consent' | 'legitimate_interest' | null;
  /** referência da LIA (Legitimate Interest Assessment) — exigida para legitimate_interest. */
  legalBasisRef: string | null;
  /** consentimento de marketing efetivamente concedido (consent.marketing.granted_at no CRM). */
  consentGranted: boolean;
  /** origem do dado (contacts.source): 'whatsapp', 'import', etc. 'import' sem prova = inválida. */
  dataOrigin: string | null;
}

/** O que o gate LGPD lê, montado de fonte confiável (CRM) fora da cadeia. */
export interface LgpdInput {
  isAnonymized: boolean;
  /** true = envio de PROSPECÇÃO (cold, sem inbound do lead); false = resposta a inbound (MVP). */
  isProspecting: boolean;
  legalBasis: LegalBasis;
}

/** Há PROVA da base legal? (consent concedido OU LIA documentada). */
function hasProof(lb: LegalBasis): boolean {
  return (lb.basis === 'consent' && lb.consentGranted) || (lb.legalBasisRef !== null && lb.legalBasisRef.trim() !== '');
}

/**
 * Base legal VÁLIDA para prospecção? consent concedido, OU legitimate_interest com LIA.
 * Origem 'import' sem prova NUNCA é válida (achado 5.6 — listas compradas/raspadas).
 * Função pura — reusada pelo gate e pelo relatório de conformidade (mesma régua).
 */
export function isLegalBasisValid(lb: LegalBasis): boolean {
  if (lb.dataOrigin === 'import' && !hasProof(lb)) return false;
  if (lb.basis === 'consent') return lb.consentGranted;
  if (lb.basis === 'legitimate_interest') return lb.legalBasisRef !== null && lb.legalBasisRef.trim() !== '';
  return false;
}

/** Shape mínimo do contato que carrega os sinais de LGPD (linha de `contacts` do CRM). */
export interface LgpdContactFields {
  source: string | null;
  consent: Record<string, unknown> | null;
  is_anonymized: boolean;
}

/** Leitura segura de um sub-objeto do jsonb `consent` (chave ausente/tipo errado → null). */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Deriva o LgpdInput de uma linha de `contacts`. `isProspecting` NÃO vem do contato — é do
 * fluxo (o caller decide se é cold touch); em MVP é sempre false (resposta a inbound).
 * Consent por FINALIDADE do Deskcomm: prospecção usa `marketing.granted_at` (string
 * não-vazia = concedido). LIA em `legitimate_interest.ref` (leitura defensiva — a chave só
 * existe quando registrada). Sem nenhum dos dois → basis null (sem base legal).
 */
export function deriveLgpdFromContact(c: LgpdContactFields, isProspecting: boolean): LgpdInput {
  const consent = c.consent ?? {};
  const marketing = asRecord(consent.marketing);
  const consentGranted = typeof marketing?.granted_at === 'string' && marketing.granted_at.trim() !== '';
  const lia = asRecord(consent.legitimate_interest);
  const legalBasisRef = typeof lia?.ref === 'string' && lia.ref.trim() !== '' ? lia.ref : null;
  const basis = consentGranted ? 'consent' : legalBasisRef !== null ? 'legitimate_interest' : null;
  return {
    isAnonymized: c.is_anonymized === true,
    isProspecting,
    legalBasis: {
      basis,
      legalBasisRef,
      consentGranted,
      dataOrigin: c.source ?? null,
    },
  };
}

/**
 * Escala um veto de LGPD à inbox do RUNTIME (regra dura nº 13; tabela `agent_inbox_items`).
 * Dedup por episódio aberto (mesmo padrão do escalateJailbreakPromise/handoff): 2× no mesmo
 * contato com item aberto → 1. `kind='other'` + `ref_kind='lgpd_escalation'` evita mexer no
 * check de `kind` (sem migration de constraint). ref_id = contact_id de fonte confiável (row
 * do job). Corpo SEM PII: só o código do veto e o que o DPO precisa checar no CRM. Falha aqui
 * vira log.error, nunca derruba o veto (o gate já barrou o envio — a inbox é o alerta, não o
 * enforcement).
 */
export async function escalateLgpdVeto(
  db: pg.Pool,
  input: { tenantId: string; leadId: string; code: string },
  log: Logger,
): Promise<void> {
  const isAnon = input.code === 'lgpd_anonymized';
  const title = isAnon
    ? 'Contato anonimizado — envio bloqueado por LGPD'
    : 'Base legal ausente/inválida — 1º toque bloqueado por LGPD';
  const body = isAnon
    ? 'O contato deste lead está anonimizado no CRM (anonimização é irreversível): nenhum envio ' +
      'pode ir a ele. Confira o cadastro no CRM — se for engano, reverta a anonimização lá.'
    : 'O 1º toque de prospecção a este lead foi bloqueado por falta de base legal válida ' +
      '(consent concedido, ou legitimate_interest com LIA; origem "import" exige prova). ' +
      'Registre a base legal no CRM antes de prospectar este contato.';
  try {
    await db.query(
      `insert into agent_inbox_items (organization_id, kind, severity, title, body, ref_kind, ref_id)
       select $1, 'other', 'critical', $2, $3, 'lgpd_escalation', $4
       where not exists (
         select 1 from agent_inbox_items
         where organization_id = $1 and ref_kind = 'lgpd_escalation' and ref_id = $4 and status = 'open'
       )`,
      [input.tenantId, title, body, input.leadId],
    );
  } catch (err) {
    log.error('falha ao escalar veto de LGPD à inbox (segue: o gate já barrou o envio)', {
      code: input.code,
      error: err instanceof Error ? err.name : 'unknown',
    });
  }
}
