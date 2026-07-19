/**
 * Skills situacionais com guideline-matching (F3-09; blueprint 3.3/linha 177; padrão
 * Parlant). Playbooks de situação (objeção de preço, reativação D+30, agendamento, STOP
 * ambíguo) versionados JUNTO do playbook e ativados por PONTEIRO — mesmo mecanismo de
 * imutabilidade+ponteiro de daemon/src/agent/playbook.ts (F2-07; CLAUDE.md regra dura 10):
 * conteúdo em `skill_versions` (imutável — trigger no banco veta UPDATE), ativação em
 * `skill_pointers`; trocar/rollback = mover o ponteiro, sem restart.
 *
 * Disclosure progressivo (blueprint 3.3): só o ÍNDICE (name+description) reside no prompt
 * estável org-wide (vai junto do system do playbook — prefixo cacheável F2-17). O CORPO
 * carrega SÓ quando o matcher if-then dispara no turno, e vai no SUFIXO por-lead (situacional,
 * volátil — depois do breakpoint de cache), NUNCA no prefixo estável. Situação neutra → 0
 * corpos injetados (economia de tokens por construção).
 *
 * O matcher é DETERMINÍSTICO — opera sobre sinais do contexto do turno (a última mensagem
 * inbound do lead), jamais sobre um LLM vivo: mesmo sinal ⇒ mesmo conjunto de skills. Isso
 * mantém o comportamento testável e o prefixo de cache estável.
 *
 * Misses de matching ('devia ter usado a skill X e não usou') viram candidatos ao golden
 * set (blueprint 3.3): um `probe_keyword` que dispara SEM o `any_keyword` do hard-match é um
 * near-miss — o runtime grava o trace em GOLDEN_CANDIDATES_DIR (fs em runtime, não a tool
 * Write) para curadoria humana. O sinal (texto do lead, PII) vai ao ARQUIVO de curadoria,
 * mas NUNCA a log (regra dura 8).
 *
 * tenant_id é fonte confiável (row do job); skill de um tenant NUNCA vaza para outro.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import type { Queryable } from '../queue/queue';
import { countPayloadTokens, type LeadContextMessage } from '../edge/crm/get-lead-context';
import type { Logger } from '../obs/logger';

/** Teto de linhas do corpo de uma skill — skill É playbook situacional (regra 9). */
export const MAX_SKILL_BODY_LINES = 200;

/**
 * Condição if-then determinística (guideline-matching). `any_keywords`: hard-match →
 * injeta o corpo. `probe_keywords`: sinal FRACO da situação — dispara SEM hard-match =
 * near-miss (candidato ao golden). Sem sinal fraco, use só any_keywords.
 * ponytail: matcher por keyword (substring normalizado) cobre os 4 tipos de skill do
 * blueprint; adicionar matcher temporal/por-stage quando uma skill precisar (ex.: D+30
 * "dias desde o último inbound") — o campo matcher é jsonb, extensível sem migration.
 */
export const skillMatcherSchema = z.strictObject({
  any_keywords: z.array(z.string().min(1).max(120)).min(1).max(50),
  probe_keywords: z.array(z.string().min(1).max(120)).max(50).optional(),
});
export type SkillMatcher = z.infer<typeof skillMatcherSchema>;

export interface SkillVersionRow {
  id: string;
  organization_id: string | null;
  name: string;
  description: string;
  body: string;
  matcher: SkillMatcher;
  created_at: Date;
}

/** Skill ativa carregada por ponteiro — o que o runtime resolve no início do run. */
export interface LoadedSkill {
  name: string;
  description: string;
  body: string;
  matcher: SkillMatcher;
}

function countLines(content: string): number {
  const parts = content.split('\n');
  return parts[parts.length - 1] === '' ? parts.length - 1 : parts.length;
}

/** Forma do corpo: não-vazio e ≤200 linhas (mesma disciplina do playbook). */
export function validateSkillBody(body: string): void {
  const lines = countLines(body);
  if (lines > MAX_SKILL_BODY_LINES) {
    throw new Error(
      `corpo de skill com ${lines} linhas excede o teto de ${MAX_SKILL_BODY_LINES} (regra 9) — quebre em skills menores`,
    );
  }
}

/**
 * Publica uma versão nova de skill (imutável desde o INSERT — o trigger do banco veta
 * UPDATE). `tenantId` null = skill de plataforma (global). O matcher é validado aqui.
 */
export async function insertSkillVersion(
  db: Queryable,
  input: { tenantId: string | null; name: string; description: string; body: string; matcher: SkillMatcher },
): Promise<SkillVersionRow> {
  if (input.name.trim() === '') {
    throw new Error('skill sem name — o índice precisa de um nome estável');
  }
  if (input.description.trim() === '') {
    throw new Error('skill sem description — o índice residente precisa da descrição');
  }
  validateSkillBody(input.body);
  const matcher = skillMatcherSchema.parse(input.matcher);
  const { rows } = await db.query<SkillVersionRow>(
    `insert into skill_versions (organization_id, name, description, body, matcher)
     values ($1, $2, $3, $4, $5)
     returning *`,
    [input.tenantId, input.name, input.description, input.body, JSON.stringify(matcher)],
  );
  const row = rows[0];
  if (row === undefined) {
    throw new Error('insert em skill_versions não devolveu linha');
  }
  return row;
}

/**
 * Move o ponteiro do escopo (tenant, name) para uma versão — é O deploy e O rollback
 * (segundos, sem restart). Escopo e nome vêm DA VERSÃO no próprio SQL (fonte confiável),
 * nunca de payload: apontar para versão de outro tenant/nome é impossível por construção.
 */
export async function setSkillPointer(
  db: Queryable,
  input: { tenantId: string | null; name: string; versionId: string },
): Promise<void> {
  const conflict =
    input.tenantId === null
      ? '(name) where organization_id is null'
      : '(organization_id, name) where organization_id is not null';
  const { rowCount } = await db.query(
    `insert into skill_pointers (organization_id, name, version_id)
     select v.organization_id, v.name, v.id
     from skill_versions v
     where v.id = $1 and v.name = $2 and v.organization_id is not distinct from $3
     on conflict ${conflict} do update
       set version_id = excluded.version_id,
           updated_at = now()`,
    [input.versionId, input.name, input.tenantId],
  );
  if (rowCount === 0) {
    throw new Error('versão de skill não encontrada para o escopo (tenant/name) — ponteiro não movido');
  }
}

/**
 * Resolve os ponteiros e devolve as skills ativas do run — skills de plataforma (globais)
 * + skills do tenant. Chamada no início de CADA run (sem cache de processo): ponteiro
 * movido ⇒ próximo run já vê a versão nova, sem restart. Ordem ESTÁVEL por nome (o índice
 * injetado é byte-determinístico — o prefixo de cache F2-17 depende disso). Se um tenant e
 * a plataforma têm skill de mesmo nome, a do tenant vence (override local).
 */
export async function loadSkills(db: Queryable, tenantId: string): Promise<LoadedSkill[]> {
  const { rows } = await db.query<{
    organization_id: string | null;
    name: string;
    description: string;
    body: string;
    matcher: SkillMatcher;
  }>(
    `select v.organization_id, v.name, v.description, v.body, v.matcher
     from skill_pointers p
     join skill_versions v on v.id = p.version_id
     where p.organization_id is null or p.organization_id = $1`,
    [tenantId],
  );
  // tenant vence plataforma no mesmo nome; ordem final estável por nome (prefixo estável).
  const byName = new Map<string, LoadedSkill>();
  for (const r of rows) {
    if (!byName.has(r.name) || r.organization_id !== null) {
      byName.set(r.name, { name: r.name, description: r.description, body: r.body, matcher: r.matcher });
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Índice das skills (name+description) — a metade SEMPRE residente no prompt (disclosure
 * progressivo). Vai no prefixo estável org-wide (junto do system do playbook). Corpo JAMAIS
 * aqui. Vazio → '' (o call site não injeta o bloco).
 */
export function renderSkillIndex(skills: readonly LoadedSkill[]): string {
  if (skills.length === 0) {
    return '';
  }
  return skills.map((s) => `- ${s.name}: ${s.description}`).join('\n');
}

/** Normaliza para o matching: minúsculas + remove acentos (matcher robusto a diacrítico). */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

export interface SkillMissCandidate {
  /** nome da skill que a situação sugeria (probe disparou) mas não teve hard-match. */
  skill: string;
  reason: 'probe_matched_without_hard_match';
}

export interface SkillMatchResult {
  /** skills com hard-match — os corpos que serão injetados no turno. */
  matched: LoadedSkill[];
  /** near-misses: probe disparou sem hard-match — candidatos ao golden set. */
  missCandidates: SkillMissCandidate[];
}

/**
 * Guideline-matching if-then DETERMINÍSTICO: avalia cada skill contra o SINAL do turno
 * (texto). `any_keywords` casando (substring normalizado) = hard-match → o corpo carrega.
 * `probe_keywords` casando SEM hard-match = near-miss → candidato ao golden. Sinal vazio
 * (ex.: follow-up sem inbound) ⇒ nada casa, nada vira candidato.
 */
export function matchSkills(skills: readonly LoadedSkill[], signal: string): SkillMatchResult {
  const norm = normalize(signal);
  const matched: LoadedSkill[] = [];
  const missCandidates: SkillMissCandidate[] = [];
  if (norm.trim() === '') {
    return { matched, missCandidates };
  }
  const hit = (keywords: readonly string[]): boolean => keywords.some((k) => norm.includes(normalize(k)));
  for (const skill of skills) {
    if (hit(skill.matcher.any_keywords)) {
      matched.push(skill);
    } else if (skill.matcher.probe_keywords !== undefined && hit(skill.matcher.probe_keywords)) {
      missCandidates.push({ skill: skill.name, reason: 'probe_matched_without_hard_match' });
    }
  }
  return { matched, missCandidates };
}

/**
 * Bloco do SUFIXO com os corpos das skills casadas (situacional, por-lead — depois do
 * prefixo cacheável). Vazio → '' (nada injetado; a economia de tokens da situação neutra).
 */
export function renderMatchedSkillBodies(matched: readonly LoadedSkill[]): string {
  if (matched.length === 0) {
    return '';
  }
  return [
    '## Skills situacionais ativas neste turno (siga o playbook abaixo)',
    ...matched.map((s) => `### ${s.name}\n${s.body}`),
  ].join('\n\n');
}

/** Custo em tokens de um texto — mesma heurística do resto do harness (chars/3,5). */
export function skillBlockTokens(block: string): number {
  return block === '' ? 0 : countPayloadTokens(block);
}

/** Extrai o SINAL do matcher: a última mensagem inbound do lead (o gatilho do turno). */
export function latestInboundSignal(messages: readonly LeadContextMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m !== undefined && m.direction === 'inbound') {
      return m.body;
    }
  }
  return '';
}

/**
 * Grava os near-misses como candidatos ao golden set (blueprint 3.3) — fs em RUNTIME
 * (mkdir recursivo + writeFile), NÃO a tool Write, então o freeze do golden não se aplica
 * a este caminho executado. O arquivo é para CURADORIA HUMANA: carrega o sinal (texto do
 * lead), então NUNCA é logado (regra dura 8) — só a CONTAGEM e os nomes das skills vão a log.
 * Um arquivo por (skill, job): retry re-grava o mesmo candidato, não acumula duplicata.
 */
export async function recordSkillMissCandidates(
  dir: string,
  trace: { tenantId: string; leadId: string; jobId: string; signal: string; candidates: readonly SkillMissCandidate[] },
  log: Logger,
): Promise<void> {
  if (trace.candidates.length === 0) {
    return;
  }
  await mkdir(dir, { recursive: true });
  for (const c of trace.candidates) {
    const record = {
      recorded_at: new Date().toISOString(),
      source: 'skill_match_miss',
      note:
        `devia ter usado a skill '${c.skill}' e não usou (near-miss de matching: ${c.reason}) — ` +
        'candidato ao golden set para curadoria humana (blueprint 3.3).',
      tenant_id: trace.tenantId,
      lead_id: trace.leadId,
      job_id: trace.jobId,
      expected_skill: c.skill,
      reason: c.reason,
      // sinal do turno (texto do lead — PII): fica no ARQUIVO de curadoria, jamais em log.
      signal: trace.signal,
    };
    const file = path.join(dir, `skill-miss_${c.skill}_${trace.jobId}.json`);
    await writeFile(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  }
  // PII fora do log: só contagem e nomes das skills (não o sinal).
  log.info('candidatos ao golden set registrados (skill match miss)', {
    count: trace.candidates.length,
    skills: trace.candidates.map((c) => c.skill),
  });
}
