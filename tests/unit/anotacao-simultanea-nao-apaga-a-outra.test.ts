/**
 * Duas anotações ao mesmo tempo no mesmo negócio NÃO se apagam (migration 0502).
 *
 * O defeito: `updateLeadHandler` mesclava `custom_fields` no aplicativo
 * (`{ ...prev, ...novo }`, com `prev` de uma leitura anterior). Duas escritas
 * simultâneas com chaves DIFERENTES perdiam uma, em silêncio.
 *
 * Este teste REPRODUZ a corrida: uma barreira faz as duas chamadas lerem o lead
 * ANTES de qualquer uma gravar (a janela do defeito), e o banco falso modela as
 * duas formas de gravar — o `update` do PostgREST, que sobrescreve a coluna
 * inteira com o valor que recebe, e `fn_lead_anotar_campos`, que mescla sobre o
 * que existe no momento. Com o código antigo o segundo `update` pisa no primeiro.
 *
 * O que este teste NÃO prova: a espera entre transações de verdade. Isso é
 * do invariante `tests/invariants/anotacao-simultanea-nao-apaga-a-outra.test.ts`,
 * que abre duas transações num Postgres real.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { audit } from "@/lib/audit";

vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async () => undefined),
  isServiceRoleConfigured: vi.fn(() => false),
}));
vi.mock("@/lib/leads/activity-emitter", () => ({
  emitLeadActivity: vi.fn(async () => ({ ok: true })),
  stageChangeReason: () => "movido",
}));
vi.mock("@/lib/leads/activity-write-failure", () => ({
  registraFalhaDeAtividade: vi.fn(async () => undefined),
}));
vi.mock("@/lib/atendimento/origem", () => ({
  observeServiceOrigin: vi.fn(async () => null),
}));

/** O estado do banco falso, compartilhado entre o cliente da sessão e o admin. */
const banco = vi.hoisted(() => ({
  customFields: {} as Record<string, unknown>,
  /** Cada corpo que chegou a `crm_leads.update(...)`. */
  updates: [] as Record<string, unknown>[],
  /** Cada chamada a `fn_lead_anotar_campos`. */
  anotacoes: [] as { p_org: string; p_lead: string; p_campos: Record<string, unknown> }[],
  falhaNoRpc: null as string | null,
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => ({
    rpc: vi.fn(async (nome: string, args: Record<string, unknown>) => {
      if (nome !== "fn_lead_anotar_campos") return { data: null, error: null };
      const a = args as { p_org: string; p_lead: string; p_campos: Record<string, unknown> };
      banco.anotacoes.push(a);
      if (banco.falhaNoRpc) return { data: null, error: { message: banco.falhaNoRpc } };
      // A função mescla sobre o que EXISTE agora, não sobre o que alguém leu antes.
      banco.customFields = { ...banco.customFields, ...a.p_campos };
      return { data: { ...banco.customFields }, error: null };
    }),
  })),
}));

import { updateLeadHandler } from "@/app/api/v1/leads/_handler";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import { ApiError } from "@/lib/api/types";

const ORG = "22222222-2222-4222-8222-222222222222";
const LEAD = "33333333-3333-4333-8333-333333333333";

const ctx: HandlerCtx = {
  organization_id: ORG,
  actor: { type: "user", id: "11111111-1111-4111-8111-111111111111" },
  requestId: "req-1",
  idioma: "pt-BR",
};

/**
 * O cliente da sessão. `barreira` segura as N primeiras LEITURAS até que todas
 * tenham chegado — cada uma leva o retrato do banco tirado no instante em que
 * chamou, ou seja, o `existing` velho do defeito.
 */
function clienteDaSessao(barreira?: { esperar: () => Promise<void> }) {
  const lead = (customFields: Record<string, unknown>) => ({
    id: LEAD,
    organization_id: ORG,
    contact_id: null,
    title: "Carlos — Clínica",
    tags: [],
    custom_fields: customFields,
    updated_at: "2026-09-30T12:00:00.000Z",
  });
  let primeirasLeituras = 0;

  return {
    from(tabela: string) {
      if (tabela !== "crm_leads") throw new Error(`tabela inesperada: ${tabela}`);
      return {
        select: () => {
          const retrato = structuredClone(banco.customFields);
          const leitura: Record<string, unknown> = {};
          leitura.eq = () => leitura;
          leitura.maybeSingle = async () => {
            if (barreira && primeirasLeituras < 2) {
              primeirasLeituras += 1;
              await barreira.esperar();
              return { data: lead(retrato), error: null };
            }
            return { data: lead(structuredClone(banco.customFields)), error: null };
          };
          return leitura;
        },
        update: (valores: Record<string, unknown>) => {
          banco.updates.push(valores);
          // O PostgREST grava o VALOR que recebe: se o corpo trouxer
          // `custom_fields`, a coluna inteira é substituída — o defeito.
          if ("custom_fields" in valores) {
            banco.customFields = valores.custom_fields as Record<string, unknown>;
          }
          const escrita: Record<string, unknown> = {};
          escrita.eq = () => escrita;
          escrita.select = () => escrita;
          escrita.maybeSingle = async () => ({
            data: lead(structuredClone(banco.customFields)),
            error: null,
          });
          return escrita;
        },
      };
    },
    rpc: () => ({ then: (fn: (r: { error: null }) => void) => Promise.resolve(fn({ error: null })) }),
  };
}

/** Uma barreira de duas partes: só libera quando as duas leituras chegaram. */
function barreiraDeDois() {
  let chegaram = 0;
  let liberar!: () => void;
  const aberta = new Promise<void>((r) => (liberar = r));
  return {
    esperar: () => {
      chegaram += 1;
      if (chegaram === 2) liberar();
      return aberta;
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  banco.customFields = {};
  banco.updates = [];
  banco.anotacoes = [];
  banco.falhaNoRpc = null;
});

describe("updateLeadHandler — custom_fields", () => {
  it("duas anotações simultâneas com chaves diferentes ficam as DUAS", async () => {
    const barreira = barreiraDeDois();
    const sessao = clienteDaSessao(barreira);

    await Promise.all([
      updateLeadHandler(sessao as never, ctx, LEAD, { custom_fields: { orcamento: "5000" } }),
      updateLeadHandler(sessao as never, ctx, LEAD, { custom_fields: { prazo: "30 dias" } }),
    ]);

    expect(banco.customFields).toEqual({ orcamento: "5000", prazo: "30 dias" });
  });

  it("o corpo do update NUNCA carrega custom_fields — quem grava a coluna é o banco", async () => {
    await updateLeadHandler(clienteDaSessao() as never, ctx, LEAD, {
      title: "Novo título",
      custom_fields: { orcamento: "5000" },
    });

    expect(banco.updates).toHaveLength(1);
    expect(banco.updates[0]).not.toHaveProperty("custom_fields");
    expect(banco.updates[0]).toHaveProperty("title", "Novo título");
  });

  it("a organização e o lead do RPC vêm do contexto e da rota, não do corpo", async () => {
    await updateLeadHandler(clienteDaSessao() as never, ctx, LEAD, {
      custom_fields: { orcamento: "5000" },
    });

    expect(banco.anotacoes).toEqual([
      { p_org: ORG, p_lead: LEAD, p_campos: { orcamento: "5000" } },
    ]);
  });

  it("sem custom_fields no pedido, o RPC não é chamado", async () => {
    await updateLeadHandler(clienteDaSessao() as never, ctx, LEAD, { title: "Só o título" });

    expect(banco.anotacoes).toHaveLength(0);
  });

  it("a resposta devolve o que EXISTE no banco, incluindo a chave do vizinho", async () => {
    banco.customFields = { do_vizinho: "sim" };

    const devolvido = (await updateLeadHandler(clienteDaSessao() as never, ctx, LEAD, {
      custom_fields: { meu: "campo" },
    })) as { custom_fields: Record<string, unknown> };

    expect(devolvido.custom_fields).toEqual({ do_vizinho: "sim", meu: "campo" });
  });

  it("falha do RPC vira 500, e não sucesso com o dado perdido", async () => {
    banco.falhaNoRpc = "boom";

    await expect(
      updateLeadHandler(clienteDaSessao() as never, ctx, LEAD, { custom_fields: { a: "1" } }),
    ).rejects.toMatchObject({ status: 500 });
    await expect(
      updateLeadHandler(clienteDaSessao() as never, ctx, LEAD, { custom_fields: { a: "1" } }),
    ).rejects.toBeInstanceOf(ApiError);
  });

  describe("a auditoria segue nomeando o campo, e só quando ele mudou", () => {
    const camposAuditados = () => {
      const chamada = vi.mocked(audit).mock.calls.at(-1)?.[0] as
        | { metadata?: { fields?: string[] } }
        | undefined;
      return chamada?.metadata?.fields ?? [];
    };

    it("anotar um campo novo aparece como custom_fields", async () => {
      await updateLeadHandler(clienteDaSessao() as never, ctx, LEAD, {
        custom_fields: { orcamento: "5000" },
      });

      expect(camposAuditados()).toContain("custom_fields");
    });

    it("mandar o mesmo valor que já existe NÃO é uma alteração", async () => {
      banco.customFields = { orcamento: "5000" };

      await updateLeadHandler(clienteDaSessao() as never, ctx, LEAD, {
        custom_fields: { orcamento: "5000" },
      });

      expect(camposAuditados()).not.toContain("custom_fields");
    });

    it("um objeto vazio não é uma alteração", async () => {
      await updateLeadHandler(clienteDaSessao() as never, ctx, LEAD, { custom_fields: {} });

      expect(camposAuditados()).not.toContain("custom_fields");
    });
  });
});
