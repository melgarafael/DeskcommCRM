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
  } | null;
}

interface AvisoAbertoMock {
  id: string;
  ref_kind: string;
  ref_id: string;
}

function criarAdminMock(propostas: PropostaMock[], jaAberto: AvisoAbertoMock | null = null) {
  const insertsInbox: Array<Record<string, unknown>> = [];
  const updatesInbox: Array<{ id: string; payload: Record<string, unknown> }> = [];
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
                  maybeSingle: async () => ({ data: jaAberto, error: null }),
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
          update: (payload: Record<string, unknown>) => ({
            eq: async (_col: string, id: string) => {
              updatesInbox.push({ id, payload });
              return { error: null };
            },
          }),
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

  return { client, insertsInbox, updatesInbox };
}

describe("venceReativacoes", () => {
  it("para 1 negócio parado, aponta o aviso direto para o lead sem gravar o título no corpo", async () => {
    const { client, insertsInbox } = criarAdminMock([
      {
        id: PROP_1,
        lead_id: LEAD_1,
        organization_id: ORG,
        expires_at: "2026-01-01T00:00:00Z",
        crm_leads: {
          title: "Empresa Alpha",
          contact_id: null,
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
    expect(String(insertsInbox[0]?.body)).not.toContain("Empresa Alpha");
  });

  it("para vários negócios parados, agrupa na organização mantendo apenas a contagem", async () => {
    const { client, insertsInbox } = criarAdminMock([
      {
        id: PROP_1,
        lead_id: LEAD_1,
        organization_id: ORG,
        expires_at: "2026-01-01T00:00:00Z",
        crm_leads: {
          title: "Empresa Alpha",
          contact_id: null,
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
    expect(String(insertsInbox[0]?.title)).toContain("2 negócios");
    expect(String(insertsInbox[0]?.body)).toContain("2 negócios");
    expect(String(insertsInbox[0]?.body)).not.toContain("Empresa Alpha");
    expect(String(insertsInbox[0]?.body)).not.toContain("Empresa Beta");
  });

  it("quando já existe aviso aberto apontando para 1 negócio e outro vence, passa para organization e atualiza a contagem", async () => {
    const { client, insertsInbox, updatesInbox } = criarAdminMock(
      [
        {
          id: PROP_2,
          lead_id: LEAD_2,
          organization_id: ORG,
          expires_at: "2026-01-01T00:00:00Z",
          crm_leads: {
            title: "Empresa Beta",
            contact_id: null,
          },
        },
      ],
      { id: "open-1", ref_kind: "lead", ref_id: LEAD_1 },
    );

    const res = await venceReativacoes(client, ORG, new Date("2026-01-02T00:00:00Z"));
    expect(res).toEqual({ vencidas: 1, itensDeCaixa: 0, falhasDeAtividade: 0 });
    expect(insertsInbox).toHaveLength(0);
    expect(updatesInbox).toHaveLength(1);
    expect(updatesInbox[0]).toMatchObject({
      id: "open-1",
      payload: {
        ref_kind: "organization",
        ref_id: ORG,
      },
    });
    expect(String(updatesInbox[0]?.payload.title)).toContain("2 negócios");
    expect(String(updatesInbox[0]?.payload.body)).toContain("2 negócios");
    expect(String(updatesInbox[0]?.payload.body)).not.toContain("Empresa Beta");
  });
});
