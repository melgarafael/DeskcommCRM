/**
 * `remove_tag` — a irmã da `add_tag` no sentido contrário.
 *
 * Mede o que a AÇÃO faz: qual função chama, para qual alvo, e o que faz com a
 * resposta. O dublê emula o contrato de `fn_*_remover_etiquetas` (migration
 * 0768): casa pela chave canônica, devolve `tags` e `removidas`, nulo para linha
 * que não existe. A corrida entre dois eventos concorrentes é do banco e é
 * medida com transações de verdade em
 * `tests/invariants/remove-tag-concorrente-nao-apaga.test.ts`.
 */
import { describe, expect, it } from "vitest";

import { getAction } from "@/lib/automation/actions";
import "@/lib/automation/actions/register-all";
import type { ActionCtx } from "@/lib/automation/types";

const chave = (t: string) => t.trim().toLowerCase();

function banco(inicial: Record<string, string[]>, falha = false) {
  const linhas: Record<string, string[]> = { ...inicial };
  const chamadas: Array<{ rpc: string; args: Record<string, unknown> }> = [];
  const admin = {
    async rpc(nome: string, args: Record<string, unknown>) {
      chamadas.push({ rpc: nome, args });
      if (nome !== "fn_lead_remover_etiquetas" && nome !== "fn_contato_remover_etiquetas") {
        throw new Error(`banco de mentira: rpc inesperada ${nome}`);
      }
      if (falha) return { data: null, error: { message: "indisponível" } };
      const id = String(nome === "fn_lead_remover_etiquetas" ? args.p_lead : args.p_contato);
      if (!(id in linhas)) return { data: null, error: null };
      const pedidas = new Set(((args.p_etiquetas as string[]) ?? []).map(chave));
      const removidas = linhas[id]!.filter((t) => pedidas.has(chave(t)));
      linhas[id] = linhas[id]!.filter((t) => !pedidas.has(chave(t)));
      return { data: { tags: linhas[id], removidas }, error: null };
    },
  } as unknown as ActionCtx["admin"];
  return { admin, linhas, chamadas };
}

function ctx(admin: ActionCtx["admin"], context: Record<string, unknown>): ActionCtx {
  return {
    admin,
    organizationId: "org-1",
    ruleId: "r",
    ruleName: "r",
    event: { id: "ev-1" } as ActionCtx["event"],
    requestId: "req-1",
    context,
  } as ActionCtx;
}

const removeTag = () => getAction("remove_tag")!;

describe("remove_tag", () => {
  it("está registrada no motor (register-all)", () => {
    expect(getAction("remove_tag")).toBeTruthy();
  });

  it("⭐ card (padrão): tira do LEAD pela função atômica, sem montar a lista no app", async () => {
    const { admin, linhas, chamadas } = banco({ "lead-1": ["vip", "quente", "novo"] });
    const r = await removeTag().execute(
      ctx(admin, { lead: { id: "lead-1", contact_id: "c-1", tags: ["foto-velha"] } }),
      { tags: ["quente"] },
    );

    expect(chamadas).toEqual([
      { rpc: "fn_lead_remover_etiquetas", args: { p_org: "org-1", p_lead: "lead-1", p_etiquetas: ["quente"] } },
    ]);
    expect(linhas["lead-1"]).toEqual(["vip", "novo"]);
    expect(r).toEqual({ type: "remove_tag", status: "success", detail: { removed: ["quente"] } });
  });

  it("⭐ destino contato: tira do contato DO lead", async () => {
    const { admin, linhas, chamadas } = banco({ "c-1": ["vip", "cliente"], "lead-1": ["vip"] });
    await removeTag().execute(ctx(admin, { lead: { id: "lead-1", contact_id: "c-1", tags: ["vip"] } }), {
      tags: ["VIP"],
      destino: "contato",
    });

    expect(chamadas[0]!.rpc).toBe("fn_contato_remover_etiquetas");
    expect(chamadas[0]!.args).toMatchObject({ p_contato: "c-1" });
    expect(linhas["c-1"]).toEqual(["cliente"]);
    expect(linhas["lead-1"]).toEqual(["vip"]); // o card fica como estava
  });

  it("card sem lead no contexto: tira do contato do contexto", async () => {
    const { admin, chamadas } = banco({ "c-1": ["vip"] });
    await removeTag().execute(ctx(admin, { contact: { id: "c-1", tags: [] } }), { tags: ["vip"] });
    expect(chamadas[0]!.rpc).toBe("fn_contato_remover_etiquetas");
  });

  it("destino contato sem contato resolvível: ignora (no_contact), nunca cai no card", async () => {
    const { admin, chamadas } = banco({ "lead-1": ["vip"] });
    const r = await removeTag().execute(ctx(admin, { lead: { id: "lead-1", tags: ["vip"] } }), {
      tags: ["vip"],
      destino: "contato",
    });
    expect(r).toEqual({ type: "remove_tag", status: "skipped", detail: { reason: "no_contact" } });
    expect(chamadas).toHaveLength(0);
  });

  it("sem lead nem contato: no_target", async () => {
    const { admin } = banco({});
    const r = await removeTag().execute(ctx(admin, {}), { tags: ["vip"] });
    expect(r).toMatchObject({ status: "skipped", detail: { reason: "no_target" } });
  });

  it("sem etiqueta (ou só espaços): no_tags, sem chamar o banco", async () => {
    const { admin, chamadas } = banco({ "lead-1": ["vip"] });
    const r = await removeTag().execute(ctx(admin, { lead: { id: "lead-1" } }), { tags: ["  "] });
    expect(r).toMatchObject({ status: "skipped", detail: { reason: "no_tags" } });
    expect(chamadas).toHaveLength(0);
  });

  it("linha ausente ou de outra organização (nulo): skipped, nada anunciado", async () => {
    const { admin } = banco({});
    const r = await removeTag().execute(ctx(admin, { lead: { id: "lead-1" } }), { tags: ["vip"] });
    expect(r).toMatchObject({ status: "skipped", detail: { reason: "no_target" } });
  });

  it("erro do banco vira failed com a mensagem", async () => {
    const { admin } = banco({ "lead-1": ["vip"] }, true);
    const r = await removeTag().execute(ctx(admin, { lead: { id: "lead-1" } }), { tags: ["vip"] });
    expect(r).toEqual({ type: "remove_tag", status: "failed", error: "indisponível" });
  });

  it("não tinha a etiqueta: success com removed vazio", async () => {
    const { admin } = banco({ "lead-1": ["vip"] });
    const r = await removeTag().execute(ctx(admin, { lead: { id: "lead-1" } }), { tags: ["outra"] });
    expect(r).toEqual({ type: "remove_tag", status: "success", detail: { removed: [] } });
  });

  it("a foto do contexto passa a carregar o que ficou gravado", async () => {
    const { admin } = banco({ "lead-1": ["vip", "quente"] });
    const context = { lead: { id: "lead-1", tags: ["vip", "quente"] } };
    await removeTag().execute(ctx(admin, context), { tags: ["vip"] });
    expect(context.lead.tags).toEqual(["quente"]);
  });
});
