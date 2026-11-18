import { describe, expect, it } from "vitest";

import { getAction } from "@/lib/automation/actions";
import "@/lib/automation/actions/assign-owner";
import { CABECALHO_DO_ASSISTIDO } from "@/lib/automation/parada-no-assistido";
import type { ActionCtx } from "@/lib/automation/types";

/**
 * Doc 301 = B (#4319), o caminho do `assign_owner`: a regra A (disparada pela IA
 * no assistido) troca o dono, e o GATILHO do banco emite `lead.assigned` — que é
 * gatilho escolhível na tela. O gatilho só vê a marca pelo cabeçalho da
 * requisição; sem ele, a regra B em `lead.assigned` mandava WhatsApp sem
 * aprovação. A ação escreve o dono por DOIS caminhos (UPDATE direto no modo
 * fixo, `fn_automation_rodizio_atribuir` no rodízio): os dois levam a marca.
 *
 * O controle é o mesmo evento sem a marca: nenhum cabeçalho.
 */

const PESSOA = "11111111-1111-4111-8111-111111111111";

type Escrita = { alvo: string; cabecalhos?: Record<string, string> };

/**
 * Builder encadeável e "thenable", como o do PostgREST, que anota o cabeçalho.
 * A escrita conta a partir do `update` (tabela) ou da criação (RPC).
 */
function builder(alvo: string, escritas: Escrita[], resposta: { data: unknown; error: null }) {
  const registro: Escrita = { alvo };
  if (alvo.startsWith("rpc:")) escritas.push(registro);
  const b = {
    select: () => b,
    eq: () => b,
    is: () => b,
    update: () => {
      escritas.push(registro);
      return b;
    },
    maybeSingle: () => b,
    setHeader(nome: string, valor: string) {
      registro.cabecalhos = { ...(registro.cabecalhos ?? {}), [nome]: valor };
      return b;
    },
    then: (ok: (v: unknown) => unknown, falha?: (e: unknown) => unknown) => Promise.resolve(resposta).then(ok, falha),
  };
  return b;
}

function adminFalso() {
  const escritas: Escrita[] = [];
  const admin = {
    from: (tabela: string) =>
      builder(tabela, escritas, {
        data: tabela === "user_organizations" ? { user_id: PESSOA, role: "agent" } : null,
        error: null,
      }),
    rpc: (fn: string) => builder(`rpc:${fn}`, escritas, { data: { user_id: PESSOA, posicao: 1 }, error: null }),
    auth: { admin: { getUserById: async () => ({ data: { user: { user_metadata: { full_name: "Ana" } } }, error: null }) } },
  };
  return { admin, escritas };
}

function ctx(admin: unknown, metadata: Record<string, unknown>): ActionCtx {
  return {
    admin: admin as ActionCtx["admin"],
    organizationId: "org-1",
    ruleId: "rule-a",
    ruleName: "Regra A: passa o negócio",
    requestId: "req-1",
    event: { id: "evt-1", organization_id: "org-1", event_type: "lead.stage_changed", metadata } as ActionCtx["event"],
    context: { lead: { id: "lead-1", contact_id: null } },
  };
}

const MARCADO = { actor_type: "ai_agent", actor_operation_mode: "assisted" };
const SEM_MARCA = { actor_type: "ai_agent" };

describe("assign_owner herda a marca do assistido", () => {
  it("modo fixo, evento da IA no assistido: o UPDATE do dono leva o cabeçalho", async () => {
    const { admin, escritas } = adminFalso();
    const r = await getAction("assign_owner")!.execute(ctx(admin, MARCADO), { user_id: PESSOA });
    expect(r.status).toBe("success");
    const escrita = escritas.find((e) => e.alvo === "crm_leads");
    expect(escrita?.cabecalhos).toEqual({ [CABECALHO_DO_ASSISTIDO]: "assisted" });
  });

  it("rodízio, evento da IA no assistido: a função que grava o dono recebe o cabeçalho", async () => {
    const { admin, escritas } = adminFalso();
    const r = await getAction("assign_owner")!.execute(ctx(admin, MARCADO), { modo: "rodizio", fila: [] });
    expect(r.status).toBe("success");
    const chamada = escritas.find((e) => e.alvo === "rpc:fn_automation_rodizio_atribuir");
    expect(chamada?.cabecalhos).toEqual({ [CABECALHO_DO_ASSISTIDO]: "assisted" });
  });

  it("CONTROLE: o mesmo evento sem a marca não leva cabeçalho em nenhum dos dois caminhos", async () => {
    const fixo = adminFalso();
    expect((await getAction("assign_owner")!.execute(ctx(fixo.admin, SEM_MARCA), { user_id: PESSOA })).status).toBe("success");
    const escrita = fixo.escritas.find((e) => e.alvo === "crm_leads");
    expect(escrita).toBeDefined();
    expect(escrita?.cabecalhos).toBeUndefined();

    const rodizio = adminFalso();
    expect(
      (await getAction("assign_owner")!.execute(ctx(rodizio.admin, SEM_MARCA), { modo: "rodizio", fila: [] })).status,
    ).toBe("success");
    const chamada = rodizio.escritas.find((e) => e.alvo === "rpc:fn_automation_rodizio_atribuir");
    expect(chamada).toBeDefined();
    expect(chamada?.cabecalhos).toBeUndefined();
  });
});
