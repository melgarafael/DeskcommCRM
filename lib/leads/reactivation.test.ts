import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { venceReativacoes } from "./reactivation";

vi.mock("@/lib/leads/activity-emitter", () => ({
  emitLeadActivity: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock("@/lib/leads/activity-write-failure", () => ({
  registraFalhaDeAtividade: vi.fn().mockResolvedValue(undefined),
}));

const ORG = "00000000-0000-4000-8000-000000000001";
const LEAD_1 = "00000000-0000-4000-8000-000000000011";
const LEAD_2 = "00000000-0000-4000-8000-000000000012";
const PROP_1 = "00000000-0000-4000-8000-000000000021";
const PROP_2 = "00000000-0000-4000-8000-000000000022";

interface PropostaMock {
  id: string;
  lead_id: string;
  organization_id: string;
  expires_at: string;
  crm_leads: {
    title: string;
    contact_id: string | null;
    crm_stages?: { name: string } | null;
  } | null;
}

function criarAdminMock(propostas: PropostaMock[], jaAberto = false) {
  const insertsInbox: Array<Record<string, unknown>> = [];
  const client = {
    from(tabela: string) {
      if (tabela === "crm_lead_reactivations") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                lt: async () => ({ data: propostas, error: null }),
              }),
            }),
          }),
          update: () => ({
            eq: () => ({
              eq: async () => ({ error: null }),
            }),
          }),
        };
      }
      if (tabela === "agent_inbox_items") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => ({ data: jaAberto ? { id: "open-1" } : null, error: null }),
                }),
              }),
            }),
          }),
          insert: (payload: Record<string, unknown>) => {
            insertsInbox.push(payload);
            return {
              select: () => ({
                maybeSingle: async () => ({ data: { id: "inbox-1" }, error: null }),
              }),
            };
          },
        };
      }
      if (tabela === "organizations") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: { locale: "pt-BR" }, error: null }),
            }),
          }),
        };
      }
      throw new Error(`Tabela inesperada no mock: ${tabela}`);
    },
  } as unknown as SupabaseClient;

  return { client, insertsInbox };
}

describe("venceReativacoes", () => {
  it("para 1 negócio parado, aponta o aviso direto para o lead com nome e etapa", async () => {
    const { client, insertsInbox } = criarAdminMock([
      {
        id: PROP_1,
        lead_id: LEAD_1,
        organization_id: ORG,
        expires_at: "2026-01-01T00:00:00Z",
        crm_leads: {
          title: "Empresa Alpha",
          contact_id: null,
          crm_stages: { name: "Proposta" },
        },
      },
    ]);

    const res = await venceReativacoes(client, ORG, new Date("2026-01-02T00:00:00Z"));
    expect(res).toEqual({ vencidas: 1, itensDeCaixa: 1, falhasDeAtividade: 0 });
    expect(insertsInbox).toHaveLength(1);
    expect(insertsInbox[0]).toMatchObject({
      organization_id: ORG,
      kind: "reactivation_expired",
      ref_kind: "lead",
      ref_id: LEAD_1,
    });
    expect(String(insertsInbox[0]?.body)).toContain("Empresa Alpha (Proposta)");
  });

  it("para vários negócios parados, agrupa na organização e lista cada um com nome e etapa", async () => {
    const { client, insertsInbox } = criarAdminMock([
      {
        id: PROP_1,
        lead_id: LEAD_1,
        organization_id: ORG,
        expires_at: "2026-01-01T00:00:00Z",
        crm_leads: {
          title: "Empresa Alpha",
          contact_id: null,
          crm_stages: { name: "Proposta" },
        },
      },
      {
        id: PROP_2,
        lead_id: LEAD_2,
        organization_id: ORG,
        expires_at: "2026-01-01T00:00:00Z",
        crm_leads: {
          title: "Empresa Beta",
          contact_id: null,
          crm_stages: { name: "Qualificação" },
        },
      },
    ]);

    const res = await venceReativacoes(client, ORG, new Date("2026-01-02T00:00:00Z"));
    expect(res).toEqual({ vencidas: 2, itensDeCaixa: 1, falhasDeAtividade: 0 });
    expect(insertsInbox).toHaveLength(1);
    expect(insertsInbox[0]).toMatchObject({
      organization_id: ORG,
      kind: "reactivation_expired",
      ref_kind: "organization",
      ref_id: ORG,
    });
    expect(String(insertsInbox[0]?.body)).toContain("Empresa Alpha (Proposta)");
    expect(String(insertsInbox[0]?.body)).toContain("Empresa Beta (Qualificação)");
  });
});
