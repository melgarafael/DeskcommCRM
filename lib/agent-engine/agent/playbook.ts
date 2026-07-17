/**
 * Playbook em camadas versionado com carga por ponteiro (F2-07; blueprint 4.4/8.8,
 * linha 176; CLAUDE.md regra dura nº 10).
 *
 * - Conteúdo mora em `playbook_versions` (imutável — trigger no banco veta UPDATE;
 *   mudança = versão nova). O espelho em git (`playbooks/`) guarda seeds/templates.
 * - `loadPlaybook(db, tenantId)` resolve os PONTEIROS (playbook_pointers) no início
 *   de CADA run e concatena plataforma→tenant→campanha de forma determinística
 *   byte-a-byte (mesmas versões ⇒ mesmo output; nada volátil — regra dura nº 15,
 *   o prefixo de cache da F2-17 depende disso). Nenhum cache em memória: mover o
 *   ponteiro ⇒ o próximo run já monta o prompt novo, sem restart.
 * - Regra dura NUNCA vive no playbook (vai pro hook) — disciplina de conteúdo,
 *   validada em revisão; aqui só forma (≤200 linhas, seções nomeadas).
 */
import type pg from 'pg';

export type PlaybookLayer = 'platform' | 'tenant' | 'campaign';

/** Ordem FIXA de concatenação — nunca a ordem do banco (blueprint linha 176). */
const LAYER_ORDER: readonly PlaybookLayer[] = ['platform', 'tenant', 'campaign'];

/** Teto por camada (blueprint linha 176) — o lint do espelho git usa o MESMO teto. */
export const MAX_PLAYBOOK_LAYER_LINES = 200;

export interface PlaybookVersionRow {
  id: string;
  organization_id: string | null;
  layer: PlaybookLayer;
  content: string;
  created_at: Date;
}

export interface LoadedPlaybook {
  /** Prompt concatenado plataforma→tenant→campanha — byte-idêntico por conjunto de versões. */
  prompt: string;
  /** Versão ativa por camada no momento do run (auditoria/telemetria). */
  versionIds: Partial<Record<PlaybookLayer, string>>;
}

function countLines(content: string): number {
  const parts = content.split('\n');
  // trailing newline não conta linha extra (semântica wc -l, igual ao lint)
  return parts[parts.length - 1] === '' ? parts.length - 1 : parts.length;
}

/** Forma da camada: ≤200 linhas e pelo menos uma seção nomeada (## ...). */
export function validatePlaybookLayerContent(content: string): void {
  const lines = countLines(content);
  if (lines > MAX_PLAYBOOK_LAYER_LINES) {
    throw new Error(
      `camada de playbook com ${lines} linhas excede o teto de ${MAX_PLAYBOOK_LAYER_LINES} (blueprint linha 176) — quebre em skill situacional`,
    );
  }
  if (!/^## /m.test(content)) {
    throw new Error('camada de playbook sem seção nomeada (## ...) — cada camada é diffável por seção');
  }
}

/**
 * Publica uma versão nova (imutável desde o INSERT — o trigger do banco veta UPDATE).
 * `tenantId` null = camada plataforma (global); o CHECK do schema força a coerência.
 */
export async function insertPlaybookVersion(
  db: pg.Pool,
  input: { tenantId: string | null; layer: PlaybookLayer; content: string },
): Promise<PlaybookVersionRow> {
  validatePlaybookLayerContent(input.content);
  const { rows } = await db.query<PlaybookVersionRow>(
    `insert into playbook_versions (organization_id, layer, content)
     values ($1, $2, $3)
     returning *`,
    [input.tenantId, input.layer, input.content],
  );
  const row = rows[0];
  if (row === undefined) {
    throw new Error('insert em playbook_versions não devolveu linha');
  }
  return row;
}

/**
 * Move o ponteiro do escopo (tenant, layer) para uma versão — é O deploy e O
 * rollback (segundos, sem restart). Escopo e camada vêm DA VERSÃO no próprio SQL
 * (fonte confiável), nunca de payload: apontar para versão de outro tenant/camada
 * é impossível por construção.
 */
export async function setPlaybookPointer(
  db: pg.Pool,
  input: { tenantId: string | null; layer: PlaybookLayer; versionId: string },
): Promise<void> {
  const conflict =
    input.tenantId === null
      ? '(layer) where organization_id is null'
      : '(organization_id, layer) where organization_id is not null';
  const { rowCount } = await db.query(
    `insert into playbook_pointers (organization_id, layer, version_id)
     select v.organization_id, v.layer, v.id
     from playbook_versions v
     where v.id = $1 and v.layer = $2 and v.organization_id is not distinct from $3
     on conflict ${conflict} do update
       set version_id = excluded.version_id,
           updated_at = now()`,
    [input.versionId, input.layer, input.tenantId],
  );
  if (rowCount === 0) {
    throw new Error('versão de playbook não encontrada para o escopo (tenant/camada) — ponteiro não movido');
  }
}

/**
 * Resolve os ponteiros e monta o prompt do run. Chamada no início de CADA run —
 * sem cache de processo, de propósito: ponteiro movido = próximo run já vê a
 * versão nova com o daemon vivo (blueprint 8.8).
 * Plataforma é obrigatória (compliance); tenant/campanha entram se apontadas.
 */
export async function loadPlaybook(db: pg.Pool, tenantId: string): Promise<LoadedPlaybook> {
  const { rows } = await db.query<{ layer: PlaybookLayer; version_id: string; content: string }>(
    `select v.layer, v.id as version_id, v.content
     from playbook_pointers p
     join playbook_versions v on v.id = p.version_id
     where (p.organization_id is null and p.layer = 'platform')
        or (p.organization_id = $1 and p.layer in ('tenant', 'campaign'))`,
    [tenantId],
  );
  const byLayer = new Map(rows.map((r) => [r.layer, r]));
  if (!byLayer.has('platform')) {
    throw new Error('ponteiro da camada plataforma ausente — publique uma versão platform e aponte antes do primeiro run');
  }
  const versionIds: LoadedPlaybook['versionIds'] = {};
  for (const layer of LAYER_ORDER) {
    const row = byLayer.get(layer);
    if (row) {
      versionIds[layer] = row.version_id;
    }
  }
  return {
    prompt: composePlaybook(
      LAYER_ORDER.flatMap((layer) => {
        const row = byLayer.get(layer);
        return row ? [{ layer, content: row.content }] : [];
      }),
    ),
    versionIds,
  };
}

/**
 * Serialização determinística byte-a-byte: ordem FIXA plataforma→tenant→campanha,
 * marcador estável por camada, conteúdo verbatim. NADA volátil (timestamp, id de
 * run, ordem de Map) entra aqui — mesmas versões ⇒ mesmo sha256.
 */
export function composePlaybook(
  layers: ReadonlyArray<{ layer: PlaybookLayer; content: string }>,
): string {
  const byLayer = new Map(layers.map((l) => [l.layer, l.content]));
  return LAYER_ORDER.filter((layer) => byLayer.has(layer))
    .map((layer) => `=== playbook:${layer} ===\n${byLayer.get(layer) ?? ''}`)
    .join('\n\n');
}
