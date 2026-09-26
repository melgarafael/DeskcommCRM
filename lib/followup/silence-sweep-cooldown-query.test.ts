import { describe, expect, it } from "vitest";

import { createSupabaseSilenceSweepDb } from "./silence-sweep";

/**
 * `loadContactIdsEmCooldown` — a query REAL contra o PostgREST (produção),
 * não o fake em memória nem a reimplementação em SQL cru dos invariantes.
 *
 * Sem este arquivo, a query que de fato roda em produção nunca era chamada
 * por nenhum teste — só um fake (lib/followup/silence-sweep-cooldown.test.ts)
 * e uma cópia em raw SQL (tests/invariants/followup-silence-sweep.test.ts, que
 * precisa de Postgres) exercitavam a LÓGICA de cooldown. É a mesma classe de
 * risco que o cabeçalho de tests/invariants/followup-silence-sweep.test.ts já
 * documenta para `loadSilentContactIds` (PR #420: produção e a cópia em SQL
 * já divergiram uma vez, e um teste media a cópia errada).
 *
 * O fake abaixo grava a cadeia de chamadas (.eq/.in/.not/.gte) em vez de
 * FILTRAR de verdade (isso é trabalho do Postgres) — o que se prova aqui é
 * que a rota de produção pede as colunas certas (updated_at, não started_at;
 * exclui os status vivos) e traduz a resposta corretamente.
 */
function fakeAdmin(rows: Array<{ contact_id: string }>) {
  const chamadas: Array<{ metodo: string; args: unknown[] }> = [];
  const chain: Record<string, unknown> = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === "then") {
          return (resolve: (value: unknown) => unknown) => resolve({ data: rows, error: null });
        }
        return (...args: unknown[]) => {
          chamadas.push({ metodo: String(prop), args });
          return chain;
        };
      },
    },
  );
  return { admin: { from: () => chain } as never, chamadas };
}

describe("createSupabaseSilenceSweepDb().loadContactIdsEmCooldown — a query de produção", () => {
  it("filtra por updated_at (fim da tentativa), NÃO por started_at (início)", async () => {
    const { admin, chamadas } = fakeAdmin([{ contact_id: "c-1" }]);
    const db = createSupabaseSilenceSweepDb(admin);

    await db.loadContactIdsEmCooldown("org-1", "pointer-1", ["c-1"], "2026-09-25T10:00:00.000Z");

    const gte = chamadas.find((c) => c.metodo === "gte");
    expect(gte?.args).toEqual(["updated_at", "2026-09-25T10:00:00.000Z"]);
    expect(chamadas.some((c) => c.metodo === "gte" && c.args[0] === "started_at")).toBe(false);
  });

  it("exclui os status VIVOS (active/waiting_reply/paused_handoff/paused_manual) — esses já são cobertos pelo índice único", async () => {
    const { admin, chamadas } = fakeAdmin([]);
    const db = createSupabaseSilenceSweepDb(admin);

    await db.loadContactIdsEmCooldown("org-1", "pointer-1", ["c-1"], "2026-09-25T10:00:00.000Z");

    const not = chamadas.find((c) => c.metodo === "not" && c.args[0] === "status");
    expect(not?.args).toEqual(["status", "in", "(active,waiting_reply,paused_handoff,paused_manual)"]);
  });

  it("traduz as linhas devolvidas num Set de contact_id", async () => {
    const { admin } = fakeAdmin([{ contact_id: "c-1" }, { contact_id: "c-2" }]);
    const db = createSupabaseSilenceSweepDb(admin);

    const resultado = await db.loadContactIdsEmCooldown(
      "org-1",
      "pointer-1",
      ["c-1", "c-2", "c-3"],
      "2026-09-25T10:00:00.000Z",
    );

    expect(resultado).toEqual(new Set(["c-1", "c-2"]));
    expect(resultado.has("c-3")).toBe(false);
  });

  it("contactIds vazio não bate no banco — devolve Set vazio direto", async () => {
    const { admin, chamadas } = fakeAdmin([{ contact_id: "não deveria aparecer" }]);
    const db = createSupabaseSilenceSweepDb(admin);

    const resultado = await db.loadContactIdsEmCooldown("org-1", "pointer-1", [], "2026-09-25T10:00:00.000Z");

    expect(resultado).toEqual(new Set());
    expect(chamadas).toHaveLength(0);
  });
});
