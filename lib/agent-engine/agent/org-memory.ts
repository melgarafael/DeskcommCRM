/**
 * Memória Geral da Org (Fase 1 do épico harness — spec 2026-07-23).
 *
 * Doc-mãe versionado+ponteiro (mesmo padrão do playbook 0004) + entradas de
 * aprendizado (manual | flywheel aprovado | agent, via MCP). Resolvida no início de CADA run —
 * sem cache de processo, de propósito: publicar ⇒ próximo turno já vê.
 * O bloco renderizado entra no PREFIXO ESTÁVEL: determinístico byte-a-byte
 * para a mesma versão+entries (ordem estável por created_at, id).
 */
import type pg from 'pg';

export interface OrgMemoryEntry {
  id: string;
  title: string;
  body: string;
}

export interface LoadedOrgMemory {
  content: string | null;
  entries: OrgMemoryEntry[];
}

export async function loadOrgMemory(db: pg.Pool, tenantId: string): Promise<LoadedOrgMemory> {
  const { rows: docRows } = await db.query<{ content: string }>(
    `select v.content
     from org_memory_pointers p join org_memory_versions v on v.id = p.version_id
     where p.organization_id = $1`,
    [tenantId],
  );
  const { rows: entryRows } = await db.query<OrgMemoryEntry>(
    `select id, title, body
     from org_memory_entries
     where organization_id = $1 and status = 'active'
     order by created_at asc, id asc`,
    [tenantId],
  );
  return { content: docRows[0]?.content ?? null, entries: entryRows };
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
