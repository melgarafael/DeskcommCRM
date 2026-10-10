// @vitest-environment node
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { POST, PATCH, DELETE } from "@/app/api/v1/leads/[id]/contatos-relacionados/route";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createClient } from "@/lib/supabase/server";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import { audit } from "@/lib/audit";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/leads/activity-emitter", () => ({ emitLeadActivity: vi.fn() }));
vi.mock("@/lib/leads/activity-write-failure", () => ({ registraFalhaDeAtividade: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OUTRA_ORG = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const LEAD = "11111111-1111-4111-8111-111111111111";
const PRINCIPAL = "22222222-2222-4222-8222-222222222222";
const OUTRO = "33333333-3333-4333-8333-333333333333";

type Row = Record<string, unknown>;

function banco(iniciais?: { contato?: Row; links?: Row[] }) {
  const tabelas: Record<string, Row[]> = {
    crm_leads: [{ id: LEAD, organization_id: ORG, contact_id: PRINCIPAL }],
    contacts: [
      {
        id: OUTRO,
        organization_id: ORG,
        kind: "person",
        is_personal: false,
        is_anonymized: false,
        is_merged_into: null,
        ...iniciais?.contato,
      },
    ],
    crm_lead_links: iniciais?.links ?? [],
  };
  const from = (tabela: string) => {
    const filtros: Array<[string, unknown]> = [];
    let modo: "read" | "update" | "delete" = "read";
    let alteracao: Row = {};
    const encontrados = () =>
      (tabelas[tabela] ?? []).filter((linha) =>
        filtros.every(([coluna, valor]) => linha[coluna] === valor),
      );
    const q = {
      select: () => q,
      eq: (coluna: string, valor: unknown) => {
        filtros.push([coluna, valor]);
        return q;
      },
      update: (dados: Row) => {
        modo = "update";
        alteracao = dados;
        return q;
      },
      delete: () => {
        modo = "delete";
        return q;
      },
      maybeSingle: async () => {
        const linha = encontrados()[0] ?? null;
        if (linha && modo === "update") Object.assign(linha, alteracao);
        if (linha && modo === "delete")
          tabelas[tabela] = tabelas[tabela]!.filter((l) => l !== linha);
        return { data: linha, error: null };
      },
      insert: async (dados: Row) => {
        if (
          tabela === "crm_lead_links" &&
          (tabelas[tabela] ?? []).some(
            (l) =>
              l.lead_id === dados.lead_id &&
              l.target_kind === dados.target_kind &&
              l.target_id === dados.target_id &&
              l.link_kind === dados.link_kind,
          )
        ) {
          return { error: { code: "23505", message: "duplicate" } };
        }
        (tabelas[tabela] ??= []).push({ id: "link-novo", ...dados });
        return { error: null };
      },
    };
    return q;
  };
  vi.mocked(createClient).mockResolvedValue({ from } as never);
  return tabelas;
}

function chamar(metodo: "POST" | "PATCH" | "DELETE", corpo: unknown) {
  const req = new NextRequest(`http://localhost/api/v1/leads/${LEAD}/contatos-relacionados`, {
    method: metodo,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(corpo),
  });
  const ctx = { params: Promise.resolve({ id: LEAD }) };
  return { POST, PATCH, DELETE }[metodo](req, ctx);
}

beforeEach(() => {
  vi.mocked(requireRole).mockReset();
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: "usuario-1", idioma: "pt-BR" },
    org: { orgId: ORG },
  } as never);
  vi.mocked(requireSupportWrite).mockResolvedValue(null);
  vi.mocked(emitLeadActivity).mockResolvedValue({ ok: true });
  vi.mocked(audit).mockResolvedValue(undefined);
});

describe("escrita de contatos relacionados", () => {
  it("vincula outro contato com função, preservando o principal e registrando a mudança", async () => {
    const tabelas = banco();
    const res = await chamar("POST", { contact_id: OUTRO, papel: " Financeiro " });
    expect(res.status).toBe(201);
    expect(tabelas.crm_leads![0]!.contact_id).toBe(PRINCIPAL);
    expect(tabelas.crm_lead_links![0]).toMatchObject({
      organization_id: ORG,
      lead_id: LEAD,
      target_kind: "contact",
      target_id: OUTRO,
      link_kind: "related",
      metadata: { papel: "Financeiro" },
    });
    expect(emitLeadActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        leadId: LEAD,
        contactId: PRINCIPAL,
        type: "lead_edited",
        payload: { fields: ["contatos_relacionados"], operation: "adicionar" },
      }),
    );
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ORG,
        action: "lead.updated",
      }),
    );
  });

  it("não aceita contato de outra organização, mesmo se o cliente do banco o devolver", async () => {
    const tabelas = banco({ contato: { organization_id: OUTRA_ORG } });
    const res = await chamar("POST", { contact_id: OUTRO });
    expect(res.status).toBe(404);
    expect(tabelas.crm_lead_links).toHaveLength(0);
  });

  it("recusa contato principal, duplicata e contato pessoal", async () => {
    banco();
    expect((await chamar("POST", { contact_id: PRINCIPAL })).status).toBe(409);
    banco({
      links: [
        {
          id: "existente",
          organization_id: ORG,
          lead_id: LEAD,
          target_kind: "contact",
          target_id: OUTRO,
          link_kind: "related",
          metadata: {},
        },
      ],
    });
    expect((await chamar("POST", { contact_id: OUTRO })).status).toBe(409);
    banco({ contato: { is_personal: true } });
    expect((await chamar("POST", { contact_id: OUTRO })).status).toBe(403);
  });

  it("edita a função e remove somente o vínculo relacionado", async () => {
    const tabelas = banco({
      links: [
        {
          id: "relacionado",
          organization_id: ORG,
          lead_id: LEAD,
          target_kind: "contact",
          target_id: OUTRO,
          link_kind: "related",
          metadata: { papel: "Compras" },
        },
        {
          id: "pedido",
          organization_id: ORG,
          lead_id: LEAD,
          target_kind: "order",
          target_id: OUTRO,
          link_kind: "related",
          metadata: {},
        },
      ],
    });
    expect((await chamar("PATCH", { contact_id: OUTRO, papel: "Aprovação" })).status).toBe(200);
    expect(tabelas.crm_lead_links![0]!.metadata).toEqual({ papel: "Aprovação" });
    expect((await chamar("DELETE", { contact_id: OUTRO })).status).toBe(200);
    expect(tabelas.crm_lead_links).toEqual([expect.objectContaining({ id: "pedido" })]);
  });

  it("permite editar e remover um vínculo antigo que aponta para lápide de fusão", async () => {
    const tabelas = banco({
      contato: { is_merged_into: PRINCIPAL },
      links: [
        {
          id: "legado",
          organization_id: ORG,
          lead_id: LEAD,
          target_kind: "contact",
          target_id: OUTRO,
          link_kind: "related",
          metadata: {},
        },
      ],
    });
    expect((await chamar("PATCH", { contact_id: OUTRO, papel: "Compras" })).status).toBe(200);
    expect(tabelas.crm_lead_links![0]!.metadata).toEqual({ papel: "Compras" });
    expect((await chamar("DELETE", { contact_id: OUTRO })).status).toBe(200);
    expect(tabelas.crm_lead_links).toHaveLength(0);
  });

  it("recusa criar novo vínculo com cadastro que já foi fundido", async () => {
    const tabelas = banco({ contato: { is_merged_into: PRINCIPAL } });
    const res = await chamar("POST", { contact_id: OUTRO });
    expect(res.status).toBe(409);
    expect(tabelas.crm_lead_links).toHaveLength(0);
  });

  it("bloqueia viewer e payload inválido antes de qualquer escrita", async () => {
    banco();
    expect((await chamar("POST", { contact_id: "invalido" })).status).toBe(422);
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: new Response(null, { status: 403 }),
    } as never);
    expect((await chamar("POST", { contact_id: OUTRO })).status).toBe(403);
  });
});
