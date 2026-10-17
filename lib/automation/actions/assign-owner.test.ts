import { describe, it, expect, vi } from "vitest";
import type { ActionCtx } from "@/lib/automation/types";

import { getAction } from "@/lib/automation/actions";
import "@/lib/automation/actions/assign-owner";

const PESSOA = "11111111-1111-4111-8111-111111111111";

/**
 * O admin que a ação recebe. Só `rpc` e `auth.admin.getUserById` existem: o modo
 * rodízio não pode tocar `from(...)` — escolher, registrar e gravar o dono é da
 * função SQL, numa transação só (#2041). Se a ação voltar a gravar o dono por
 * conta própria, `from` não existe e o teste quebra.
 */
function adminFalso(rpc: { data: unknown; error: { message: string } | null }, nome: string | null = "Ana") {
  return {
    rpc: vi.fn().mockResolvedValue(rpc),
    auth: {
      admin: {
        getUserById: vi.fn().mockResolvedValue({
          data: { user: nome ? { user_metadata: { full_name: nome } } : { user_metadata: {} } },
          error: null,
        }),
      },
    },
  };
}

function ctx(admin: ReturnType<typeof adminFalso>, lead: { id: string } | null = { id: "lead-1" }): ActionCtx {
  return {
    admin: admin as unknown as ActionCtx["admin"],
    organizationId: "org-1",
    ruleId: "rule-1",
    ruleName: "Regra",
    requestId: "evt-1",
    event: {
      id: "evt-1",
      organization_id: "org-1",
      event_type: "lead.created",
      entity_kind: "crm_lead",
      entity_id: "lead-1",
      payload: {},
      metadata: {},
      consumed_by: [],
      attempts: 0,
    },
    context: lead ? { lead } : {},
  };
}

const RODIZIO = { modo: "rodizio", fila: [{ user_id: PESSOA, pausado: false }] };

describe("assign_owner em rodízio", () => {
  it("chama a função pela regra, pelo lead e pelo evento, e escreve a frase da vez", async () => {
    const admin = adminFalso({ data: { user_id: PESSOA, posicao: 2 }, error: null });
    const r = await getAction("assign_owner")!.execute(ctx(admin), RODIZIO);
    // A fila NÃO vai na chamada: a função lê a da regra gravada.
    expect(admin.rpc).toHaveBeenCalledWith("fn_automation_rodizio_atribuir", {
      p_org: "org-1",
      p_rule: "rule-1",
      p_lead: "lead-1",
      // O id do evento vai junto: é a chave que impede o reprocessamento de andar a fila.
      p_event: "evt-1",
    });
    expect(r).toEqual({
      type: "assign_owner",
      status: "success",
      detail: { user_id: PESSOA, posicao: 2, nome: "Ana", explicacao: "Vez de Ana, posição 2 da fila do rodízio." },
    });
  });

  it("sem nome no perfil, a frase usa o começo do id em vez de falhar", async () => {
    const admin = adminFalso({ data: { user_id: PESSOA, posicao: 1 }, error: null }, null);
    const r = await getAction("assign_owner")!.execute(ctx(admin), RODIZIO);
    expect(r.status).toBe("success");
    expect(r.detail?.explicacao).toBe("Vez de 11111111, posição 1 da fila do rodízio.");
  });

  it("ninguém disponível (todos pausados ou fora da equipe) é skipped com o motivo", async () => {
    const admin = adminFalso({ data: { motivo: "ninguem_disponivel" }, error: null });
    const r = await getAction("assign_owner")!.execute(ctx(admin), RODIZIO);
    expect(r).toEqual({ type: "assign_owner", status: "skipped", detail: { reason: "ninguem_disponivel" } });
  });

  it("regra que perdeu o rodízio e lead de fora viram failed com o código", async () => {
    const semRodizio = await getAction("assign_owner")!.execute(ctx(adminFalso({ data: { motivo: "sem_rodizio" }, error: null })), RODIZIO);
    expect(semRodizio).toEqual({ type: "assign_owner", status: "failed", error: "sem_rodizio" });
    const semLead = await getAction("assign_owner")!.execute(ctx(adminFalso({ data: { motivo: "lead_nao_encontrado" }, error: null })), RODIZIO);
    expect(semLead).toEqual({ type: "assign_owner", status: "failed", error: "lead_nao_encontrado" });
  });

  it("erro da RPC é failed com a mensagem, sem inventar dono", async () => {
    const admin = adminFalso({ data: null, error: { message: "connection reset" } });
    const r = await getAction("assign_owner")!.execute(ctx(admin), RODIZIO);
    expect(r).toEqual({ type: "assign_owner", status: "failed", error: "connection reset" });
    expect(admin.auth.admin.getUserById).not.toHaveBeenCalled();
  });

  it("sem lead no contexto não chama a função", async () => {
    const admin = adminFalso({ data: null, error: null });
    const r = await getAction("assign_owner")!.execute(ctx(admin, null), RODIZIO);
    expect(r).toEqual({ type: "assign_owner", status: "skipped", detail: { reason: "missing_input" } });
    expect(admin.rpc).not.toHaveBeenCalled();
  });
});
