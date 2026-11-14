import { beforeEach, describe, expect, it, vi } from "vitest";

const rpcAdmin = vi.hoisted(() => vi.fn(async (_fn: string, _args: unknown) => ({ data: null, error: null })));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ rpc: rpcAdmin }) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

import { getAction } from "@/lib/automation/actions";
import "@/lib/automation/actions/create-or-move-lead";
import { CABECALHO_DO_ASSISTIDO } from "@/lib/automation/parada-no-assistido";
import type { ActionCtx } from "@/lib/automation/types";
import { ORG_ID, PIPE, etapa, funilRow, makeDb, negocio } from "@/tests/helpers/stages-db-double";

/**
 * Doc 301 = B (#4319), achados 2 e a do cético: a regra A que só MOVE o card
 * (não é segurada) rodou por causa da IA no assistido. O que ela escreve leva a
 * mesma marca, pelos dois canais por onde a marca chega a quem fala com o cliente:
 *
 *   - o metadata do `lead.stage_changed` que o handler emite (o gatilho de
 *     follow-up por etapa lê dali);
 *   - o cabeçalho da escrita em `crm_leads`, que o gatilho do banco lê em
 *     `request.headers` para marcar `lead.won`/`lead.lost` (migration 9337).
 *
 * O controle é o mesmo evento sem a marca: nenhum dos dois aparece.
 */

const ORIGEM = etapa({ id: "novo", name: "Novo lead", position: 1000 });
const GANHO = etapa({ id: "ganho", name: "Ganho", position: 3000, is_won: true });

function ctx(admin: ActionCtx["admin"], metadata: Record<string, unknown>): ActionCtx {
  return {
    admin,
    organizationId: ORG_ID,
    ruleId: "rule-a",
    ruleName: "Regra A: leva ao ganho",
    event: { id: "evt-1", organization_id: ORG_ID, event_type: "lead.stage_changed", metadata } as ActionCtx["event"],
    requestId: "req-1",
    context: { lead: { id: "lead-1", pipeline_id: PIPE, status: "open" } },
  };
}

function db() {
  return makeDb({
    pipelines: [funilRow({ id: PIPE, name: "Funil comercial" })],
    stages: [ORIGEM, GANHO],
    leads: [negocio("lead-1", "novo", { status: "open", updated_at: "2026-11-09T10:00:00.000Z" })],
  });
}

function metadataDoEventoEmitido(): Record<string, unknown> | undefined {
  const chamada = rpcAdmin.mock.calls.find(
    ([fn, args]) => fn === "emit_event" && (args as { p_event_type?: string }).p_event_type === "lead.stage_changed",
  );
  return (chamada?.[1] as { p_metadata?: Record<string, unknown> } | undefined)?.p_metadata;
}

beforeEach(() => rpcAdmin.mockClear());

describe("create_or_move_lead herda a marca do assistido", () => {
  it("evento da IA no assistido: o movimento leva o cabeçalho e o evento derivado leva a marca", async () => {
    const banco = db();
    const r = await getAction("create_or_move_lead")!.execute(
      ctx(banco.client as unknown as ActionCtx["admin"], { actor_type: "ai_agent", actor_operation_mode: "assisted" }),
      { pipeline_id: PIPE, stage_id: "ganho" },
    );

    expect(r.status).toBe("success");
    const escrita = banco.escritas.find((e) => e.tipo === "update" && e.table === "crm_leads");
    expect(escrita?.cabecalhos).toEqual({ [CABECALHO_DO_ASSISTIDO]: "assisted" });
    expect(metadataDoEventoEmitido()).toMatchObject({ actor_type: "webhook_source", actor_operation_mode: "assisted" });
  });

  it("CONTROLE: o mesmo movimento por evento sem a marca não leva nem um nem outro", async () => {
    const banco = db();
    const r = await getAction("create_or_move_lead")!.execute(
      ctx(banco.client as unknown as ActionCtx["admin"], { actor_type: "ai_agent" }),
      { pipeline_id: PIPE, stage_id: "ganho" },
    );

    expect(r.status).toBe("success");
    const escrita = banco.escritas.find((e) => e.tipo === "update" && e.table === "crm_leads");
    expect(escrita).toBeDefined();
    expect(escrita?.cabecalhos).toBeUndefined();
    const meta = metadataDoEventoEmitido();
    expect(meta).toBeDefined();
    expect(meta).not.toHaveProperty("actor_operation_mode");
  });
});
