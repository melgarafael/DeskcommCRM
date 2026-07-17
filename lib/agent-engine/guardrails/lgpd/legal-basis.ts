/**
 * Conformidade LGPD como gate de release (F4-09; edge-contract §5.5 achado 5.6 +
 * §6 "Metadado legal_basis + data_origin por contato"). Duas checagens de base legal,
 * ambas de fonte confiável (CRM, lido no turno — nunca do body, regra dura nº 1):
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
 * GAP de runtime documentado (como o de force_human): o crm_get_contact do MCP NÃO expõe
 * colunas dedicadas `legal_basis`/`legal_basis_ref` hoje — elas são a mudança de CRM da F4
 * (edge-contract §6). Até chegarem, derivamos best-effort do `contacts.source` (data_origin)
 * e do JSON `contacts.consent` (legal_basis/legal_basis_ref/granted). `is_anonymized` JÁ é
 * exposto pelo CRM (sem gap). Os TESTES de acceptance fornecem os campos por um CRM fake
 * (contract-style) e/ou passam o LgpdInput direto ao runner — determinísticos apesar do gap.
 */
import type pg from 'pg';
import type { Logger } from '../../obs/logger';

/** Base legal de um contato para prospecção (LGPD art. 7º). */
export interface LegalBasis {
  /** hipótese declarada no CRM; null = nenhuma. */
  basis: 'consent' | 'legitimate_interest' | null;
  /** referência da LIA (Legitimate Interest Assessment) — exigida para legitimate_interest. */
  legalBasisRef: string | null;
  /** consentimento efetivamente concedido (consent.granted no CRM). */
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

/** Shape mínimo do contato do CRM que carrega os sinais de LGPD (crm_get_contact). */
export interface LgpdContactFields {
  source: string | null;
  consent: Record<string, unknown> | null;
  is_anonymized: boolean;
}

/**
 * Deriva o LgpdInput de um contato do CRM. `isProspecting` NÃO vem do contato — é do fluxo
 * (o caller decide se é cold touch); default false (resposta a inbound). Enquanto as colunas
 * dedicadas de base legal não existem no CRM (gap F4), lê do JSON `consent`.
 */
export function deriveLgpdFromContact(c: LgpdContactFields, isProspecting: boolean): LgpdInput {
  const consent = c.consent ?? {};
  const basisRaw = typeof consent.legal_basis === 'string' ? consent.legal_basis : null;
  const basis = basisRaw === 'consent' || basisRaw === 'legitimate_interest' ? basisRaw : null;
  return {
    isAnonymized: c.is_anonymized === true,
    isProspecting,
    legalBasis: {
      basis,
      legalBasisRef: typeof consent.legal_basis_ref === 'string' ? consent.legal_basis_ref : null,
      consentGranted: consent.granted === true,
      dataOrigin: c.source ?? null,
    },
  };
}

/**
 * Escala um veto de LGPD à inbox do RUNTIME (regra dura nº 13). Dedup por episódio aberto
 * (mesmo padrão do escalateJailbreakPromise/handoff): 2× no mesmo lead com item aberto → 1.
 * `kind='other'` + `ref_kind='lgpd_escalation'` evita mexer no check de `kind` (sem migration
 * de constraint). ref_id = lead_id de fonte confiável (row do job). Corpo SEM PII: só o
 * código do veto e o que o DPO precisa checar no CRM. Falha aqui vira log.error, nunca
 * derruba o veto (o gate já barrou o envio — a inbox é o alerta, não o enforcement).
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
      `insert into inbox_items (tenant_id, kind, severity, title, body, ref_kind, ref_id)
       select $1, 'other', 'critical', $2, $3, 'lgpd_escalation', $4
       where not exists (
         select 1 from inbox_items
         where tenant_id = $1 and ref_kind = 'lgpd_escalation' and ref_id = $4 and status = 'open'
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
