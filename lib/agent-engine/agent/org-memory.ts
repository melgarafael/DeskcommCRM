/**
 * Memória Geral da Org (Fase 1 do épico harness — spec 2026-07-23).
 *
 * Doc-mãe versionado+ponteiro (mesmo padrão do playbook 0004) + entradas de
 * aprendizado (manual | flywheel aprovado | agent, via MCP). Resolvida no início de CADA run —
 * sem cache de processo, de propósito: publicar ⇒ próximo turno já vê.
 * O bloco renderizado entra no PREFIXO ESTÁVEL: determinístico byte-a-byte
 * para a mesma versão+entradas VIGENTES (ordem estável por created_at, id).
 *
 * ─── Prazo de validade (#2369) ─────────────────────────────────────────────
 *
 * Uma entrada pode ter `valid_until` (data de calendário): programação da
 * semana, promoção do mês, cardápio do dia. Vencida, ela deixa de ser
 * carregada — é o que impede o prompt de sexta continuar anunciando a atração
 * na terça seguinte só porque ninguém lembrou de arquivar. `null` (todas as
 * entradas anteriores a esta coluna) continua valendo para sempre.
 *
 * "Vencida" é decidida no FUSO DA ORGANIZAÇÃO, e não em UTC: às 23h de domingo
 * em São Paulo ainda é domingo (`dataIsoNoFuso`, a mesma régua do
 * `valid_until` de proposta, D8). E o prefixo deixa de ser determinístico "para
 * sempre": ele muda quando o dia vira — de propósito, e é a virada do dia que
 * faz a programação velha sair do prompt.
 */
import type pg from 'pg';

import { dataIsoNoFuso } from '@/lib/propostas/data-no-fuso';
import { fusoUtilizavel } from '@/lib/tempo/fusos';

export interface OrgMemoryEntry {
  id: string;
  title: string;
  body: string;
  /** `YYYY-MM-DD` no fuso da organização; `null` = sem prazo. */
  valid_until: string | null;
}

export interface LoadedOrgMemory {
  content: string | null;
  entries: OrgMemoryEntry[];
}

/**
 * A entrada vale no próprio dia do prazo e depois dele: `valid_until` é o
 * ÚLTIMO dia válido. Comparação de strings ISO — a mesma régua de
 * `dentroDaValidade` em `proposals/[id]/send`.
 */
export function entradaVigente(entry: { valid_until: string | null }, hoje: string): boolean {
  return entry.valid_until === null || entry.valid_until >= hoje;
}

export function entradasVigentes<T extends { valid_until: string | null }>(
  entries: readonly T[],
  hoje: string,
): T[] {
  return entries.filter((entry) => entradaVigente(entry, hoje));
}

export async function loadOrgMemory(
  db: pg.Pool,
  tenantId: string,
  deps: { agora?: Date } = {},
): Promise<LoadedOrgMemory> {
  const { rows: docRows } = await db.query<{ content: string }>(
    `select v.content
     from org_memory_pointers p join org_memory_versions v on v.id = p.version_id
     where p.organization_id = $1`,
    [tenantId],
  );
  // O fuso vem na MESMA consulta (é a organização da entrada): uma ida ao banco
  // a menos por turno, e a data sai em TEXTO — o driver converte `date` em
  // `Date` à meia-noite local, e aí a comparação de calendário compararia
  // instantes.
  const { rows: entryRows } = await db.query<OrgMemoryEntry & { fuso: string | null }>(
    `select e.id, e.title, e.body,
            to_char(e.valid_until, 'YYYY-MM-DD') as valid_until,
            o.timezone as fuso
       from org_memory_entries e
       join organizations o on o.id = e.organization_id
      where e.organization_id = $1 and e.status = 'active'
      order by e.created_at asc, e.id asc`,
    [tenantId],
  );
  const hoje = dataIsoNoFuso(deps.agora ?? new Date(), fusoUtilizavel(entryRows[0]?.fuso));
  const entries = entradasVigentes(entryRows, hoje).map(({ fuso: _fuso, ...entry }) => entry);
  return { content: docRows[0]?.content ?? null, entries };
}

/** Bloco do prefixo estável — '' quando a org não tem memória (zero custo). */
export function renderOrgMemory(mem: LoadedOrgMemory): string {
  if (mem.content === null && mem.entries.length === 0) return '';
  const parts: string[] = ['=== memória da organização (regras e aprendizados — valem para TODO atendimento) ==='];
  if (mem.content !== null) parts.push(mem.content.trim());
  if (mem.entries.length > 0) {
    parts.push('--- aprendizados ---');
    for (const e of mem.entries) parts.push(`- ${e.title}: ${e.body}`);
  }
  return parts.join('\n');
}

/** Ordem canônica do prefixo: playbook → memória da org → índice de skills. */
export function composeSystemPrompt(input: {
  playbookPrompt: string;
  orgMemoryBlock: string;
  skillIndex: string;
}): string {
  const blocks = [input.playbookPrompt];
  if (input.orgMemoryBlock !== '') blocks.push(input.orgMemoryBlock);
  if (input.skillIndex !== '') {
    blocks.push(
      `=== skills (índice — o corpo carrega no turno quando a situação dispara) ===\n${input.skillIndex}`,
    );
  }
  return blocks.join('\n\n');
}
