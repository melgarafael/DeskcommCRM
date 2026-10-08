/**
 * Quem é avisado de mensagem recebida — a regra proposta e a
 * precedência atendente > dono de negócio aberto > todos.
 *
 * Roda com: npx vitest run lib/notifications/destinatarios-da-mensagem.test.ts
 */
import { describe, expect, it } from "vitest";

import {
  carregarDestinatariosDaMensagem,
  destinatariosDaMensagem,
  usuarioRecebeAviso,
  type LeitorDeAtribuicao,
} from "./destinatarios-da-mensagem";

const ADMIN = "u-admin";

describe("destinatariosDaMensagem (regra pura)", () => {
  it("sem atendente e sem negócio aberto com dono → todos", () => {
    expect(destinatariosDaMensagem({ atribuidoA: null, donosDeNegocioAberto: [], admins: [ADMIN] })).toEqual({
      tipo: "todos",
    });
  });

  it("negócio aberto SEM dono não é atribuição → todos", () => {
    expect(
      destinatariosDaMensagem({ atribuidoA: null, donosDeNegocioAberto: [null, ""], admins: [ADMIN] }),
    ).toEqual({ tipo: "todos" });
  });

  it("conversa atribuída → só o atendente e os admins", () => {
    expect(
      destinatariosDaMensagem({ atribuidoA: "u-ana", donosDeNegocioAberto: [], admins: [ADMIN, "u-admin2"] }),
    ).toEqual({ tipo: "restrito", userIds: ["u-ana", ADMIN, "u-admin2"] });
  });

  it("atendente da conversa VENCE o dono do negócio", () => {
    const d = destinatariosDaMensagem({ atribuidoA: "u-ana", donosDeNegocioAberto: ["u-bia"], admins: [ADMIN] });
    expect(d).toEqual({ tipo: "restrito", userIds: ["u-ana", ADMIN] });
  });

  it("sem atendente: donos dos negócios abertos (todos eles, sem repetição) + admins", () => {
    const d = destinatariosDaMensagem({
      atribuidoA: null,
      donosDeNegocioAberto: ["u-bia", null, "u-caio", "u-bia"],
      admins: [ADMIN],
    });
    expect(d).toEqual({ tipo: "restrito", userIds: ["u-bia", "u-caio", ADMIN] });
  });

  it("atendente que também é admin não aparece duas vezes", () => {
    const d = destinatariosDaMensagem({ atribuidoA: ADMIN, donosDeNegocioAberto: [], admins: [ADMIN] });
    expect(d).toEqual({ tipo: "restrito", userIds: [ADMIN] });
  });

  it("usuarioRecebeAviso: todos avisa qualquer um; restrito só a lista", () => {
    expect(usuarioRecebeAviso({ tipo: "todos" }, "u-qualquer")).toBe(true);
    const r = { tipo: "restrito" as const, userIds: ["u-ana", ADMIN] };
    expect(usuarioRecebeAviso(r, "u-ana")).toBe(true);
    expect(usuarioRecebeAviso(r, ADMIN)).toBe(true);
    expect(usuarioRecebeAviso(r, "u-outro-agente")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Leitura no banco — stub PostgREST que registra os filtros de cada consulta
// ---------------------------------------------------------------------------

type Filtro = [string, string, unknown];

function stub(tabelas: Record<string, { data: unknown; error?: { message: string } | null }>) {
  const consultas: Array<{ tabela: string; filtros: Filtro[] }> = [];
  const db: LeitorDeAtribuicao = {
    from(tabela: string) {
      const registro = { tabela, filtros: [] as Filtro[] };
      consultas.push(registro);
      const resultado = { data: tabelas[tabela]?.data ?? null, error: tabelas[tabela]?.error ?? null };
      const q = {
        select: () => q,
        eq: (c: string, v: unknown) => (registro.filtros.push(["eq", c, v]), q),
        is: (c: string, v: unknown) => (registro.filtros.push(["is", c, v]), q),
        maybeSingle: async () => resultado,
        then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(resultado).then(ok, ko),
      };
      return q;
    },
  };
  return { db, consultas };
}

describe("carregarDestinatariosDaMensagem", () => {
  it("conversa atribuída: não consulta negócio, lê admins ativos da org", async () => {
    const { db, consultas } = stub({
      conversations: { data: { assigned_to_user_id: "u-ana", contact_id: "ct-1", is_group: false } },
      user_organizations: { data: [{ user_id: ADMIN }] },
    });
    const d = await carregarDestinatariosDaMensagem(db, "org-1", "conv-1");
    expect(d).toEqual({ tipo: "restrito", userIds: ["u-ana", ADMIN] });
    expect(consultas.map((c) => c.tabela)).toEqual(["conversations", "user_organizations"]);
    const admins = consultas[1]!.filtros;
    expect(admins).toContainEqual(["eq", "organization_id", "org-1"]);
    expect(admins).toContainEqual(["eq", "role", "admin"]);
    expect(admins).toContainEqual(["is", "revoked_at", null]);
  });

  it("sem atendente: busca negócios ABERTOS do contato, filtrando a org", async () => {
    const { db, consultas } = stub({
      conversations: { data: { assigned_to_user_id: null, contact_id: "ct-1", is_group: false } },
      crm_leads: { data: [{ owner_user_id: "u-bia" }] },
      user_organizations: { data: [{ user_id: ADMIN }] },
    });
    const d = await carregarDestinatariosDaMensagem(db, "org-1", "conv-1");
    expect(d).toEqual({ tipo: "restrito", userIds: ["u-bia", ADMIN] });
    const leads = consultas.find((c) => c.tabela === "crm_leads")!.filtros;
    expect(leads).toContainEqual(["eq", "organization_id", "org-1"]);
    expect(leads).toContainEqual(["eq", "contact_id", "ct-1"]);
    expect(leads).toContainEqual(["eq", "status", "open"]);
  });

  it("contact_id do evento tem precedência sobre o da conversa", async () => {
    const { db, consultas } = stub({
      conversations: { data: { assigned_to_user_id: null, contact_id: "ct-conv", is_group: false } },
      crm_leads: { data: [] },
    });
    await carregarDestinatariosDaMensagem(db, "org-1", "conv-1", "ct-evento");
    expect(consultas.find((c) => c.tabela === "crm_leads")!.filtros).toContainEqual(["eq", "contact_id", "ct-evento"]);
  });

  it("sem atendente e sem negócio com dono → todos, e nem lê os admins", async () => {
    const { db, consultas } = stub({
      conversations: { data: { assigned_to_user_id: null, contact_id: "ct-1", is_group: false } },
      crm_leads: { data: [{ owner_user_id: null }] },
    });
    expect(await carregarDestinatariosDaMensagem(db, "org-1", "conv-1")).toEqual({ tipo: "todos" });
    expect(consultas.map((c) => c.tabela)).not.toContain("user_organizations");
  });

  it("grupo é sempre todos, mesmo com atendente", async () => {
    const { db } = stub({
      conversations: { data: { assigned_to_user_id: "u-ana", contact_id: "ct-g", is_group: true } },
    });
    expect(await carregarDestinatariosDaMensagem(db, "org-1", "conv-g")).toEqual({ tipo: "todos" });
  });

  it("conversa fora da org → null; erro de leitura → lança", async () => {
    expect(await carregarDestinatariosDaMensagem(stub({}).db, "org-1", "conv-x")).toBeNull();
    const { db } = stub({ conversations: { data: null, error: { message: "boom" } } });
    await expect(carregarDestinatariosDaMensagem(db, "org-1", "conv-1")).rejects.toThrow("boom");
  });
});
