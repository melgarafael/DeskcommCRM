import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type * as Support from "@/lib/impersonate/support";
import { fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { atualizarEtapa } from "@/lib/leads/stage-operations";
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/impersonate/support", async (importOriginal) => ({
  ...(await importOriginal<typeof Support>()),
  requireSupportWrite: vi.fn(async () => null),
}));
import {
  ORG_ID,
  OUTRA_ORG,
  PIPE,
  USER_ID,
  authOk,
  comAutoria,
  funil,
  makeDb,
} from "@/tests/helpers/stages-db-double";
const ctx = { params: Promise.resolve({ id: PIPE, stageId: "e2" }) };
const request = (color: unknown) =>
  new NextRequest(`http://localhost/api/v1/pipelines/${PIPE}/stages/e2`, {
    method: "PATCH",
    body: JSON.stringify({ color }),
    headers: { "content-type": "application/json" },
  });
async function callPatch(color: unknown) {
  const { PATCH } = await import("./route");
  return PATCH(request(color), ctx);
}
beforeEach(() => vi.clearAllMocks());
describe("cor decorativa da etapa pela rota nativa", () => {
  it("grava somente cor e autoria, com escopo e papel de gerente", async () => {
    authOk();
    const db = makeDb({ stages: funil() });
    expect((await callPatch("#7291ab")).status).toBe(200);
    expect(requireRole).toHaveBeenCalledWith("manager", expect.anything());
    expect(db.escritas).toHaveLength(1);
    expect(db.escritas[0]?.patch).toEqual(comAutoria({ color: "#7291ab" }));
    expect(db.escritas[0]?.filtros).toEqual(
      expect.arrayContaining([
        ["id", "e2"],
        ["organization_id", ORG_ID],
        ["pipeline_id", PIPE],
      ]),
    );
  });
  it("restaurar remove somente a cor, sem mudar ganho/perda", async () => {
    authOk();
    const db = makeDb({ stages: funil() });
    expect((await callPatch(null)).status).toBe(200);
    expect(db.escritas[0]?.patch).toEqual(comAutoria({ color: null }));
    expect(db.tabelas.crm_stages.find((e) => e.id === "e3")?.is_won).toBe(true);
  });
  it("recusa cores executáveis e incompletas antes da escrita", async () => {
    for (const color of ["url(https://example.test)", "#abc", "red", "#000000;display:none"]) {
      authOk();
      const db = makeDb({ stages: funil() });
      expect((await callPatch(color)).status).toBe(422);
      expect(db.escritas).toEqual([]);
    }
  });
  it("não escreve sem o papel autorizado", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: fail("forbidden_role", "Sem permissão", 403, {}),
    });
    const db = makeDb({ stages: funil() });
    expect((await callPatch("#7291ab")).status).toBe(403);
    expect(db.escritas).toEqual([]);
  });
  it("não escreve em etapa de outro tenant", async () => {
    authOk();
    const db = makeDb({ stages: funil().map((e) => ({ ...e, organization_id: OUTRA_ORG })) });
    expect((await callPatch("#7291ab")).status).toBe(404);
    expect(db.escritas).toEqual([]);
  });
  it("a função compartilhada também recusa cor inválida sem depender do Zod HTTP", async () => {
    authOk();
    const db = makeDb({ stages: funil() });
    await expect(
      atualizarEtapa(
        {
          supabase: db.client as unknown as SupabaseClient,
          organizationId: ORG_ID,
          actor: { type: "user", id: USER_ID },
          requestId: "color-validation",
        },
        { pipelineId: PIPE, stageId: "e2", pedido: { color: "red" } },
      ),
    ).rejects.toMatchObject({ status: 422 });
    expect(db.escritas).toEqual([]);
  });
});
