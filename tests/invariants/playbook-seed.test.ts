import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { loadPlaybook } from "@/lib/agent-engine/agent/playbook";
import {
  PLATFORM_PLAYBOOK_PATH,
  seedPlatformPlaybook,
} from "@/lib/agent-engine/agent/playbook-seed";

/**
 * Seed da camada platform no boot do worker (fix self-host: sem ele, o 1º
 * inbound_turn de todo clone morre "ponteiro da camada plataforma ausente").
 *
 * Congela, contra o PG efêmero do test-db.sh (baseline aplicado):
 *   1. estado limpo → seed 2x = exatamente +1 versão e 1 ponteiro, e
 *      loadPlaybook PARA de lançar;
 *   2. regra dura nº 10: ponteiro existente + arquivo divergente → seed não
 *      muda NADA (nem versão nova, nem ponteiro movido);
 *   3. concorrência: 2 seeds simultâneos (2 workers subindo) = 1 seed só.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:invariants` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 4,
});

// Org qualquer: loadPlaybook só a usa como filtro das camadas tenant/campaign.
const ORG = "cccccccc-0000-4000-8000-000000000001";

async function platformState(): Promise<{ versions: number; pointerVersionId: string | null }> {
  const { rows } = await pool.query<{ versions: number; pointer_version_id: string | null }>(
    `select
       (select count(*)::int from playbook_versions
         where organization_id is null and layer = 'platform') as versions,
       (select version_id from playbook_pointers
         where organization_id is null and layer = 'platform') as pointer_version_id`,
  );
  return { versions: rows[0]?.versions ?? 0, pointerVersionId: rows[0]?.pointer_version_id ?? null };
}

async function deletePlatformPointer(): Promise<void> {
  await pool.query(`delete from playbook_pointers where organization_id is null and layer = 'platform'`);
}

beforeAll(async () => {
  // Estado "self-host limpo": sem ponteiro global. Versões antigas podem
  // sobrar de outros testes — as asserções são por DELTA, não por absoluto.
  await deletePlatformPointer();
});

afterAll(async () => {
  // Deixa o banco num estado válido pros demais arquivos (ponteiro presente).
  await seedPlatformPlaybook(pool);
  await pool.end();
});

describe("seedPlatformPlaybook (boot do worker, self-host)", () => {
  it("estado limpo: loadPlaybook lança; seed 2x = +1 versão, 1 ponteiro; loadPlaybook para de lançar", async () => {
    await expect(loadPlaybook(pool, ORG)).rejects.toThrow(/ponteiro da camada plataforma ausente/);

    const before = await platformState();
    expect(before.pointerVersionId).toBeNull();

    await expect(seedPlatformPlaybook(pool)).resolves.toBe("seeded");
    await expect(seedPlatformPlaybook(pool)).resolves.toBe("kept");

    const after = await platformState();
    expect(after.versions).toBe(before.versions + 1);
    expect(after.pointerVersionId).not.toBeNull();

    const loaded = await loadPlaybook(pool, ORG);
    expect(loaded.prompt).toContain("=== playbook:platform ===");
    expect(loaded.prompt).toContain("assistente virtual");
    expect(loaded.versionIds.platform).toBe(after.pointerVersionId);
  });

  it("regra dura nº 10: ponteiro existente + arquivo divergente → seed não muda NADA", async () => {
    const before = await platformState();
    expect(before.pointerVersionId).not.toBeNull();

    const dir = mkdtempSync(path.join(tmpdir(), "playbook-seed-"));
    const divergente = path.join(dir, "platform.md");
    writeFileSync(divergente, "## Divergente\n\nConteúdo que NUNCA pode entrar sozinho no banco.\n");

    await expect(seedPlatformPlaybook(pool, { filePath: divergente })).resolves.toBe("kept");

    const after = await platformState();
    expect(after.versions).toBe(before.versions);
    expect(after.pointerVersionId).toBe(before.pointerVersionId);
    const { rows } = await pool.query(
      `select 1 from playbook_versions where content like '%NUNCA pode entrar sozinho%'`,
    );
    expect(rows.length).toBe(0);
  });

  it("concorrência: 2 workers subindo ao mesmo tempo = exatamente 1 seed", async () => {
    await deletePlatformPointer();
    const before = await platformState();

    const results = await Promise.all([
      seedPlatformPlaybook(pool, { filePath: PLATFORM_PLAYBOOK_PATH }),
      seedPlatformPlaybook(pool, { filePath: PLATFORM_PLAYBOOK_PATH }),
    ]);

    expect(results.filter((r) => r === "seeded")).toHaveLength(1);
    expect(results.filter((r) => r === "kept")).toHaveLength(1);

    const after = await platformState();
    expect(after.versions).toBe(before.versions + 1);
    expect(after.pointerVersionId).not.toBeNull();
  });
});
