/**
 * A COMISSÃO DO ITEM VAI PARA QUEM ATENDEU, NÃO PARA QUEM APERTOU O BOTÃO.
 *
 * `fn_finalizar_comanda` gera comissão para todo `sale_items` com
 * `attendant_user_id`. Quem atendeu um agendamento está em
 * `calendar_appointments.owner_user_id` ("o ATENDENTE dono", no schema). Quem
 * fatura em lote, ou abre a comanda no balcão a partir do agendamento, costuma
 * ser outra pessoa (a recepção). Gravar o operador como atendente do item dava
 * a ele a comissão do serviço que outro prestou.
 *
 * O instrumento é a linha que a rota manda para `sale_items`.
 */
import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/instalacao/modulos", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  moduloLigado: vi.fn(async () => true),
}));

const ORG = "22222222-2222-4222-8222-222222222222";
const RECEPCAO = "11111111-1111-4111-8111-111111111111";
const PROFISSIONAL = "33333333-3333-4333-8333-333333333333";
const APPOINTMENT = "44444444-4444-4444-8444-444444444444";
const COMANDA = "55555555-5555-4555-8555-555555555555";
const PAYMENT = "66666666-6666-4666-8666-666666666666";
const SERVICO = "77777777-7777-4777-8777-777777777777";

const REGRAS = [
  { attendant_user_id: RECEPCAO, event_type_id: null, percent: 5 },
  { attendant_user_id: PROFISSIONAL, event_type_id: null, percent: 30 },
];

function montarMundo(opts: { dono: string | null; comanda?: Record<string, unknown> }) {
  const itens: Array<Record<string, unknown>> = [];

  vi.mocked(requireRole).mockImplementation(
    async () =>
      ({
        ok: true,
        user: { id: RECEPCAO, idioma: "pt-BR" },
        org: { orgId: ORG, name: "Org", role: "agent" },
      }) as never,
  );

  const lido = (tabela: string): unknown =>
    tabela === "calendar_appointments"
      ? [
          {
            id: APPOINTMENT,
            title: "Corte",
            contact_id: null,
            event_type_id: SERVICO,
            owner_user_id: opts.dono,
            status: "completed",
            calendar_event_types: { name: "Corte", default_price_cents: 10000 },
          },
        ]
      : tabela === "commission_rules"
        ? REGRAS
        : [];

  const from = (tabela: string) => {
    const cadeia: Record<string, unknown> = {};
    for (const m of ["select", "order", "limit", "eq", "in", "neq"]) cadeia[m] = () => cadeia;
    cadeia.insert = (linha: Record<string, unknown>) => {
      if (tabela === "sale_items") itens.push(linha);
      const inserido = { id: `${tabela}-1`, number: 7, status: "open" };
      const elo: Record<string, unknown> = {
        select: () => elo,
        single: async () => ({ data: inserido, error: null }),
      };
      elo.then = (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) =>
        Promise.resolve({ data: inserido, error: null }).then(ok, ko);
      return elo;
    };
    cadeia.maybeSingle = async () =>
      tabela === "sales"
        ? { data: opts.comanda ?? null, error: null }
        : tabela === "organizations"
          ? { data: { currency: "BRL" }, error: null }
          : { data: null, error: null };
    cadeia.then = (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) =>
      Promise.resolve({ data: lido(tabela), error: null }).then(ok, ko);
    return cadeia;
  };

  const rpc = async (fn: string) =>
    fn === "fn_finalizar_comanda" ? { data: null, error: null } : { data: 7, error: null };

  vi.mocked(createClient).mockResolvedValue({ from, rpc } as never);
  return itens;
}

const pedido = (url: string, corpo: Record<string, unknown>) =>
  new NextRequest(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(corpo),
  });

describe("faturar em lote", () => {
  const url = "http://localhost/api/v1/financeiro/comandas/faturar-lote";
  const corpo = { appointment_ids: [APPOINTMENT], payment_method_id: PAYMENT };

  it("o item vai para o dono do agendamento, com o percentual DELE", async () => {
    const itens = montarMundo({ dono: PROFISSIONAL });
    const { POST } = await import("@/app/api/v1/financeiro/comandas/faturar-lote/route");

    expect((await POST(pedido(url, corpo))).status).toBe(200);
    expect(itens[0]).toMatchObject({ attendant_user_id: PROFISSIONAL, commission_percent: 30 });
  });

  it("agendamento sem dono não dá a comissão a quem faturou", async () => {
    const itens = montarMundo({ dono: null });
    const { POST } = await import("@/app/api/v1/financeiro/comandas/faturar-lote/route");

    expect((await POST(pedido(url, corpo))).status).toBe(200);
    expect(itens[0]?.attendant_user_id ?? null).toBeNull();
  });
});

describe("item lançado no balcão", () => {
  const url = `http://localhost/api/v1/financeiro/comandas/${COMANDA}/itens`;
  const ctx = { params: Promise.resolve({ id: COMANDA }) };
  const corpo = { description: "Corte", unit_price_cents: 10000 };

  it("comanda do agendamento: o item vai para o dono do agendamento, não para quem abriu", async () => {
    const itens = montarMundo({
      dono: PROFISSIONAL,
      comanda: {
        id: COMANDA,
        status: "open",
        number: 7,
        attendant_user_id: RECEPCAO,
        calendar_appointments: { owner_user_id: PROFISSIONAL },
      },
    });
    const { POST } = await import("@/app/api/v1/financeiro/comandas/[id]/itens/route");

    expect((await POST(pedido(url, corpo), ctx)).status).toBe(200);
    expect(itens[0]).toMatchObject({ attendant_user_id: PROFISSIONAL, commission_percent: 30 });
  });

  it("comanda avulsa: o item vai para quem abriu a comanda", async () => {
    const itens = montarMundo({
      dono: null,
      comanda: { id: COMANDA, status: "open", number: 7, attendant_user_id: RECEPCAO, calendar_appointments: null },
    });
    const { POST } = await import("@/app/api/v1/financeiro/comandas/[id]/itens/route");

    expect((await POST(pedido(url, corpo), ctx)).status).toBe(200);
    expect(itens[0]).toMatchObject({ attendant_user_id: RECEPCAO, commission_percent: 5 });
  });

  it("atendente escolhido no corpo vence os dois", async () => {
    const itens = montarMundo({
      dono: PROFISSIONAL,
      comanda: {
        id: COMANDA,
        status: "open",
        number: 7,
        attendant_user_id: RECEPCAO,
        calendar_appointments: { owner_user_id: PROFISSIONAL },
      },
    });
    const { POST } = await import("@/app/api/v1/financeiro/comandas/[id]/itens/route");

    expect((await POST(pedido(url, { ...corpo, attendant_user_id: RECEPCAO }), ctx)).status).toBe(200);
    expect(itens[0]).toMatchObject({ attendant_user_id: RECEPCAO, commission_percent: 5 });
  });
});
