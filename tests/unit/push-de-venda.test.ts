/**
 * O VALOR DO NEGÓCIO NO PUSH, e os títulos no idioma da organização.
 *
 * Antes: o push da etapa que avisa dizia só «Negócio entrou em «X»» com uma
 * frase fixa, e o do ganho, «Lead ganho» com o título do negócio — nenhum dos
 * dois com o VALOR, que o negócio já guarda. E os títulos de menção,
 * atribuição, ganho, perda e mensagem de grupo saíam em português fixo, numa
 * organização em espanhol ou inglês.
 *
 * Os casos medem o valor (na moeda do negócio, nunca uma fixa), a soma do dia
 * (só a mesma moeda, desde a meia-noite do fuso da organização, um por
 * negócio), o escopo por organização das leituras, e o idioma de cada título.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/notifications/vapid", () => ({
  vapidPronto: () => true,
  vapidPublica: () => "pub",
  vapidSubject: async () => "mailto:x@y",
}));
vi.mock("@/lib/notifications/web_push", () => ({
  enviarPushDaOrg: vi.fn().mockResolvedValue({ sent: 1, gone: 0 }),
  enviarPushAoUsuario: vi.fn().mockResolvedValue({ sent: 1, gone: 0 }),
  enviarPushAQuemVeAConversa: vi.fn().mockResolvedValue({ sent: 1, gone: 0 }),
}));

import type { EventRow } from "@/lib/event-log/dispatcher";
import { traduzir } from "@/lib/i18n/dicionario";
import { corpoDoAvisoDeEtapa, tituloDoAvisoDeEtapa } from "@/lib/leads/aviso-de-etapa";
import { formatValorDoNegocio } from "@/lib/money";
import { webPushInboundHandler } from "@/lib/notifications/push.handler";
import {
  entradasDeHoje,
  ganhosDeHoje,
  inicioDoDia,
  linhaDoDia,
  tituloComValor,
  valorDoNegocio,
} from "@/lib/notifications/push-de-venda";
import { enviarPushAQuemVeAConversa, enviarPushAoUsuario, enviarPushDaOrg } from "@/lib/notifications/web_push";
import { createAdminClient } from "@/lib/supabase/admin";

const ORG = "11111111-1111-4111-8111-111111111111";

/**
 * O `Intl` separa o símbolo do número com espaço INQUEBRÁVEL; o `truncar` do
 * payload colapsa espaços, então no push ele chega como espaço comum. Nas peças
 * puras, comparamos com o espaço normalizado.
 */
const plano = (texto: string | null) => texto?.replace(/\s/g, " ") ?? null;

type Linha = Record<string, unknown>;

/**
 * Banco de mentira que responde às duas formas de leitura: `maybeSingle()`
 * devolve `unicos[tabela]`, e o `await` direto na consulta devolve
 * `listas[tabela]`. Os filtros ficam registrados para o teste conferir o escopo.
 */
function banco(unicos: Record<string, Linha | null>, listas: Record<string, Linha[]> = {}) {
  const filtros: Array<[string, string, string, unknown]> = [];
  return {
    filtros,
    from(tabela: string) {
      const q: Record<string, unknown> = {};
      const anota = (op: string) => (col: string, val: unknown) => {
        filtros.push([tabela, op, col, val]);
        return q;
      };
      Object.assign(q, {
        select: () => q,
        eq: anota("eq"),
        gte: anota("gte"),
        in: anota("in"),
        limit: () => q,
        maybeSingle: async () => ({ data: unicos[tabela] ?? null, error: null }),
        then: (ok: (v: unknown) => unknown) => ok({ data: listas[tabela] ?? [], error: null }),
      });
      return q;
    },
  };
}

const evento = (event_type: string, payload: Record<string, unknown>, entity_kind = "lead"): EventRow => ({
  id: "evt",
  organization_id: ORG,
  event_type,
  entity_kind,
  entity_id: null,
  payload,
  metadata: {},
  consumed_by: [],
  attempts: 0,
  created_at: new Date().toISOString(),
});

beforeEach(() => {
  vi.mocked(enviarPushDaOrg).mockClear();
  vi.mocked(enviarPushAoUsuario).mockClear();
  vi.mocked(enviarPushAQuemVeAConversa).mockClear();
});

describe("as peças do texto", () => {
  it("o valor vem do negócio, e negócio sem valor ou sem moeda não tem valor", () => {
    expect(valorDoNegocio({ value_cents: 125_000, currency: "BRL" })).toEqual({ cents: 125_000, moeda: "BRL" });
    expect(valorDoNegocio({ value_cents: "125000", currency: "MXN" })).toEqual({ cents: 125_000, moeda: "MXN" });
    expect(valorDoNegocio({ value_cents: 0, currency: "BRL" })).toBeNull();
    expect(valorDoNegocio({ value_cents: 125_000, currency: null })).toBeNull();
    expect(valorDoNegocio(null)).toBeNull();
  });

  it("o título ganha o valor depois dele, na moeda do negócio — e sem valor fica como era", () => {
    expect(tituloComValor("Negócio entrou em «Pago»", { cents: 125_000, moeda: "BRL" })).toBe(
      `Negócio entrou em «Pago» · ${formatValorDoNegocio(125_000, "BRL")}`,
    );
    expect(plano(formatValorDoNegocio(125_000, "BRL"))).toBe("R$ 1.250,00");
    expect(tituloComValor("Negócio entrou em «Pago»", null)).toBe("Negócio entrou em «Pago»");
  });

  it("a linha do dia é uma frase traduzida, com a soma na moeda do negócio", () => {
    expect(plano(linhaDoDia(traduzir("Hoje nesta etapa: {quantidade}", "pt-BR"), { quantidade: 3, totalCents: 375_000 }, "BRL"))).toBe(
      "Hoje nesta etapa: 3 (R$ 3.750,00)",
    );
    expect(plano(linhaDoDia(traduzir("Hoje nesta etapa: {quantidade}", "es"), { quantidade: 3, totalCents: 375_000 }, "BRL"))).toBe(
      "Hoy en esta etapa: 3 (R$ 3.750,00)",
    );
    expect(linhaDoDia(traduzir("Ganhos hoje: {quantidade}", "es"), { quantidade: 1, totalCents: 0 }, null)).toBe("Ganados hoy: 1");
    expect(linhaDoDia("Ganhos hoje: {quantidade}", null, "BRL")).toBeNull();
    expect(linhaDoDia("Ganhos hoje: {quantidade}", { quantidade: 0, totalCents: 0 }, "BRL")).toBeNull();
  });

  it("'hoje' começa à meia-noite do fuso da organização, não da UTC", () => {
    // 02:00 UTC do dia 25 ainda é 23:00 do dia 24 em São Paulo (UTC-3).
    expect(inicioDoDia(new Date("2026-09-25T02:00:00Z"), "America/Sao_Paulo").toISOString()).toBe(
      "2026-09-24T03:00:00.000Z",
    );
    // Fuso torto não derruba o push: cai no padrão.
    expect(() => inicioDoDia(new Date(), "Lua/Crateras")).not.toThrow();
  });
});

describe("a soma do dia", () => {
  it("etapa: conta negócios únicos com o MESMO aviso e soma só a moeda deste", async () => {
    const db = banco(
      {},
      {
        agent_inbox_items: [{ ref_id: "l1" }, { ref_id: "l2" }, { ref_id: "l2" }, { ref_id: "l3" }],
        crm_leads: [
          { value_cents: 100_000, currency: "BRL" },
          { value_cents: 50_000, currency: "BRL" },
          { value_cents: 9_900, currency: "USD" },
        ],
      },
    );
    const desde = new Date("2026-09-25T03:00:00Z");
    const r = await entradasDeHoje(db as never, ORG, "Negócio entrou em «Pago»", "BRL", desde);
    expect(r).toEqual({ quantidade: 3, totalCents: 150_000 });
    // Escopo: a organização em TODA leitura (service role), o aviso e o dia.
    expect(db.filtros).toContainEqual(["agent_inbox_items", "eq", "organization_id", ORG]);
    expect(db.filtros).toContainEqual(["agent_inbox_items", "eq", "title", "Negócio entrou em «Pago»"]);
    expect(db.filtros).toContainEqual(["agent_inbox_items", "gte", "created_at", desde.toISOString()]);
    expect(db.filtros).toContainEqual(["crm_leads", "eq", "organization_id", ORG]);
    expect(db.filtros).toContainEqual(["crm_leads", "in", "id", ["l1", "l2", "l3"]]);
  });

  it("ganhos: os negócios ganhos desde a meia-noite, da organização", async () => {
    const db = banco({}, { crm_leads: [{ value_cents: 100_000, currency: "BRL" }, { value_cents: 100_000, currency: "BRL" }] });
    const desde = new Date("2026-09-25T03:00:00Z");
    expect(await ganhosDeHoje(db as never, ORG, "BRL", desde)).toEqual({ quantidade: 2, totalCents: 200_000 });
    expect(db.filtros).toContainEqual(["crm_leads", "eq", "organization_id", ORG]);
    expect(db.filtros).toContainEqual(["crm_leads", "eq", "status", "won"]);
    expect(db.filtros).toContainEqual(["crm_leads", "gte", "closed_at", desde.toISOString()]);
  });

  it("leitura que falha devolve null — o push sai sem o resumo, nunca deixa de sair", async () => {
    const quebrado = { from: () => { throw new Error("rede"); } };
    expect(await entradasDeHoje(quebrado as never, ORG, "t", "BRL", new Date())).toBeNull();
    expect(await ganhosDeHoje(quebrado as never, ORG, "BRL", new Date())).toBeNull();
  });
});

describe("o push que chega ao celular", () => {
  it("etapa que avisa: o valor no título e quantos entraram hoje no corpo, sem o nome do cliente", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      banco(
        {
          agent_inbox_items: {
            id: "i1", kind: "other", ref_kind: "lead", ref_id: "l1",
            title: tituloDoAvisoDeEtapa("Pagado", "es"), body: corpoDoAvisoDeEtapa("es"),
          },
          organizations: { locale: "es", timezone: "America/Mexico_City" },
          crm_leads: { pipeline_id: "p1", value_cents: 125_000, currency: "BRL", title: "Maria Souza +5511999990000" },
        },
        {
          agent_inbox_items: [{ ref_id: "l1" }, { ref_id: "l9" }],
          crm_leads: [{ value_cents: 125_000, currency: "BRL" }, { value_cents: 25_000, currency: "BRL" }],
        },
      ) as never,
    );
    const r = await webPushInboundHandler.handle(evento("central.aviso_criado", { item_id: "i1" }, "agent_inbox_item"));
    expect(r.status).toBe("ok");
    const payload = vi.mocked(enviarPushDaOrg).mock.calls[0]![1];
    expect(payload).toEqual({
      title: "Negocio entró en «Pagado» · R$ 1.250,00",
      body: "Hoy en esta etapa: 2 (R$ 1.500,00)",
      corpoSemPrevia: "Hoy en esta etapa: 2 (R$ 1.500,00)",
      tag: "aviso:i1",
      href: "/app/pipelines/p1?lead=l1",
    });
    expect(JSON.stringify(payload)).not.toContain("Maria");
  });

  it("etapa que avisa sem valor e sem resumo: o texto de antes, intacto", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      banco({
        agent_inbox_items: {
          id: "i2", kind: "other", ref_kind: "lead", ref_id: "l1",
          title: tituloDoAvisoDeEtapa("Pago", "pt-BR"), body: corpoDoAvisoDeEtapa("pt-BR"),
        },
        organizations: { locale: "pt-BR" },
        crm_leads: { pipeline_id: "p1", value_cents: 0, currency: "BRL" },
      }) as never,
    );
    await webPushInboundHandler.handle(evento("central.aviso_criado", { item_id: "i2" }, "agent_inbox_item"));
    expect(vi.mocked(enviarPushDaOrg).mock.calls[0]![1]).toMatchObject({
      title: "Negócio entrou em «Pago»",
      body: corpoDoAvisoDeEtapa("pt-BR"),
    });
  });

  it("lead.won: o valor no título e o dia ao lado do negócio, no idioma da organização", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      banco(
        {
          organizations: { locale: "es", timezone: "America/Sao_Paulo" },
          crm_leads: { title: "Pedido da Ana", owner_user_id: "u-dono", pipeline_id: "p1", value_cents: 125_000, currency: "BRL" },
        },
        { crm_leads: [{ value_cents: 125_000, currency: "BRL" }, { value_cents: 75_000, currency: "BRL" }] },
      ) as never,
    );
    await webPushInboundHandler.handle(evento("lead.won", { lead_id: "l1" }));
    const [org, usuario, payload] = vi.mocked(enviarPushAoUsuario).mock.calls[0]!;
    expect([org, usuario]).toEqual([ORG, "u-dono"]);
    expect(payload).toMatchObject({
      title: "Lead ganado · R$ 1.250,00",
      body: "Pedido da Ana · Ganados hoy: 2 (R$ 2.000,00)",
      corpoSemPrevia: "Pedido da Ana · Ganados hoy: 2 (R$ 2.000,00)",
      href: "/app/pipelines/p1",
    });
  });

  it.each([
    ["lead.assigned", "Lead asignado a ti"],
    ["lead.lost", "Lead perdido"],
  ])("%s: o título sai no idioma da organização", async (tipo, titulo) => {
    vi.mocked(createAdminClient).mockReturnValue(
      banco({
        organizations: { locale: "es" },
        crm_leads: { title: "Pedido da Ana", owner_user_id: "u-dono", pipeline_id: "p1" },
      }) as never,
    );
    await webPushInboundHandler.handle(evento(tipo, { lead_id: "l1", to_user_id: "u-dono" }));
    expect(vi.mocked(enviarPushAoUsuario).mock.calls[0]![2]).toMatchObject({ title: titulo, body: "Pedido da Ana" });
  });

  it("menção e mensagem de grupo: o título sai no idioma da organização", async () => {
    vi.mocked(createAdminClient).mockReturnValue(banco({ organizations: { locale: "es" } }) as never);
    await webPushInboundHandler.handle(
      evento("user.mentioned", { to_user_id: "u-1", conversation_id: "c1", body_preview: "nota" }, "conversation_note"),
    );
    await webPushInboundHandler.handle(
      evento("message.group_received", { conversation_id: "c2", body_preview: "oi", type: "text" }, "message"),
    );
    const titulos = vi.mocked(enviarPushAQuemVeAConversa).mock.calls.map((c) => c[2].title);
    expect(titulos).toEqual(["Te mencionaron", "Mensaje nuevo en el grupo"]);
  });
});
