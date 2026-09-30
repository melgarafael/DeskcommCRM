import { describe, expect, it } from "vitest";

import { respostaDeOrgSuspensa } from "@/lib/api/org-nao-operante";
import { ehOperante } from "@/lib/organizacao/operante";

/**
 * A guarda de ROTA que converte o 307 de `resolveActiveOrg` em 403 JSON
 * (issue #2001).
 *
 * `resolveActiveOrg` redireciona a org NÃO operante para `/account-suspended` —
 * em rota de API isso responde 307 para uma página HTML. Rotas de API resolvem
 * a org por `orgAtivaSemPortao` (sem o portão do redirect) e passam o resultado
 * por `respostaDeOrgSuspensa`, que devolve um 403 `org_suspended` em JSON — o
 * mesmo código/status que `requireRole` já usa e que a tela reconhece para
 * levar o usuário ao hub.
 */
describe("respostaDeOrgSuspensa — org não operante responde 403 org_suspended em JSON", () => {
  it("org suspensa → 403 com o código org_suspended em JSON", async () => {
    const r = respostaDeOrgSuspensa({ orgId: "o1", name: "Org", role: "admin", org_status: "suspended" }, "rid-1");
    expect(r).not.toBeNull();
    expect(r!.status).toBe(403);
    const corpo = await r!.json();
    expect(corpo).toEqual({ error: { code: "org_suspended", message: "A conta desta empresa está suspensa." } });
  });

  it.each(["redacted", "archived", null])("org com status %s (não operante) → 403", (status) => {
    const r = respostaDeOrgSuspensa({ orgId: "o1", name: "Org", role: "admin", org_status: status }, "rid-1");
    expect(r?.status).toBe(403);
  });

  it("org operante (status active) → null, segue o fluxo", () => {
    const r = respostaDeOrgSuspensa({ orgId: "o1", name: "Org", role: "admin", org_status: "active" }, "rid-1");
    expect(r).toBeNull();
  });

  it("sem org (null/undefined) → null, o fail de 'sem organização ativa' decide", () => {
    expect(respostaDeOrgSuspensa(null, "rid-1")).toBeNull();
    expect(respostaDeOrgSuspensa(undefined, "rid-1")).toBeNull();
  });

  it("a régua é ehOperante, não comparação com literal", () => {
    expect(ehOperante("active")).toBe(true);
    expect(ehOperante("suspended")).toBe(false);
  });
});