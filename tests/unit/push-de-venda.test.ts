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
 *
 * E o escopo por PAPEL: as leituras são do service role, então o push reaplica
 * a régua de `fn_can_view_lead`. Fora de `visibility_mode = 'all'`, o atendente
 * não recebe valor nem soma de negócio que a tela não lhe mostra.
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
  enviarPushDaEtapaAQuemVeONegocio: vi.fn().mockResolvedValue({ sent: 1, gone: 0 }),
}));

import type { EventRow } from "@/lib/event-log/dispatcher";
import { traduzir } from "@/lib/i18n/dicionario";
import { corpoDoAvisoDeEtapa, tituloDoAvisoDeEtapa } from "@/lib/leads/aviso-de-etapa";
import { formatValorDoNegocio } from "@/lib/money";
import { webPushInboundHandler } from "@/lib/notifications/push.handler";
import {
  entradasDeHoje,
  escopoDoPapel,
  ganhosDeHoje,
  inicioDoDia,
  linhaDoDia,
  modoDeVisibilidade,
  tituloComValor,
  valorDoNegocio,
} from "@/lib/notifications/push-de-venda";
import {
  enviarPushAQuemVeAConversa,
  enviarPushAoUsuario,
  enviarPushDaEtapaAQuemVeONegocio,
  enviarPushDaOrg,
} from "@/lib/notifications/web_push";
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
 *
 * Na lista, `eq` e `or` por DONO filtram de verdade (como o PostgREST): o caso
 * do atendente mede o que chega, não só o filtro que foi pedido.
 */
function banco(unicos: Record<string, Linha | null>, listas: Record<string, Linha[]> = {}) {
  const filtros: Array<[string, string, string, unknown]> = [];
  return {
    filtros,
    from(tabela: string) {
      const q: Record<string, unknown> = {};
      const passa: Array<(l: Linha) => boolean> = [];
      const anota = (op: string) => (col: string, val: unknown) => {
        filtros.push([tabela, op, col, val]);
        return q;
      };
      Object.assign(q, {
        select: () => q,
        eq: (col: string, val: unknown) => {
          if (col === "owner_user_id") passa.push((l) => l.owner_user_id === val);
          return anota("eq")(col, val);
        },
        or: (expr: string) => {
          const ramos = expr.split(",").map((r) => r.split("."));
          passa.push((l) => ramos.some(([c, op, v]) => (op === "is" ? l[c!] == null : l[c!] === v)));
          return anota("or")(expr, undefined);
        },
        is: anota("is"),
        gte: anota("gte"),
        in: anota("in"),
        limit: () => q,
        maybeSingle: async () => ({ data: unicos[tabela] ?? null, error: null }),
        then: (ok: (v: unknown) => unknown) =>
          ok({ data: (listas[tabela] ?? []).filter((l) => passa.every((f) => f(l))), error: null }),
      });
      return q;
    },
  };
}

/** A organização em que todo atendente vê todo negócio. */
const TODOS_VEEM = { visibility_mode: "all" };

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
  vi.mocked(enviarPushDaEtapaAQuemVeONegocio).mockClear();
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
    expect(await ganhosDeHoje(db as never, ORG, "BRL", desde, null)).toEqual({ quantidade: 2, totalCents: 200_000 });
    expect(db.filtros).toContainEqual(["crm_leads", "eq", "organization_id", ORG]);
    expect(db.filtros).toContainEqual(["crm_leads", "eq", "status", "won"]);
    expect(db.filtros).toContainEqual(["crm_leads", "gte", "closed_at", desde.toISOString()]);
  });

  it("leitura que falha devolve null — o push sai sem o resumo, nunca deixa de sair", async () => {
    const quebrado = { from: () => { throw new Error("rede"); } };
    expect(await entradasDeHoje(quebrado as never, ORG, "t", "BRL", new Date())).toBeNull();
    expect(await ganhosDeHoje(quebrado as never, ORG, "BRL", new Date(), null)).toBeNull();
  });
});

describe("a régua de quem pode ver o negócio (fn_can_view_lead)", () => {
  it("o modo gravado: ausente é o padrão, e um valor estranho restringe ao próprio", () => {
    expect(modoDeVisibilidade(null)).toBe("own_and_unassigned");
    expect(modoDeVisibilidade({})).toBe("own_and_unassigned");
    expect(modoDeVisibilidade({ visibility_mode: "all" })).toBe("all");
    expect(modoDeVisibilidade({ visibility_mode: "own" })).toBe("own");
    expect(modoDeVisibilidade({ visibility_mode: "tudo" })).toBe("own");
  });

  it("gestão vê a organização; o atendente, só o dele (e o sem dono no modo padrão)", () => {
    for (const papel of ["viewer", "manager", "admin"]) expect(escopoDoPapel(papel, "own", "u")).toBeNull();
    expect(escopoDoPapel("agent", "all", "u")).toBeNull();
    expect(escopoDoPapel("agent", "own_and_unassigned", "u")).toEqual({ dono: "u", semDono: true });
    expect(escopoDoPapel("agent", "own", "u")).toEqual({ dono: "u", semDono: false });
    expect(escopoDoPapel(null, "own_and_unassigned", "u")).toEqual({ dono: "u", semDono: true });
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
          organizations: { locale: "es", timezone: "America/Mexico_City", settings: TODOS_VEEM },
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
    const payload = vi.mocked(enviarPushDaEtapaAQuemVeONegocio).mock.calls[0]![2].ampla;
    expect(payload).toEqual({
      title: "Negocio entró en «Pagado» · R$ 1.250,00",
      body: "Hoy en esta etapa: 2 (R$ 1.500,00)",
      corpoSemPrevia: corpoDoAvisoDeEtapa("es"),
      tag: "aviso:i1",
      href: "/app/pipelines/p1?lead=l1",
      tipo: "stage_alert",
    });
    expect(JSON.stringify(payload)).not.toContain("Maria");
  });

  // #3981 — a régua deixou de ser o `visibility_mode` da organização e passou a
  // ser quem VÊ aquele negócio (`fn_can_view_lead`, no banco). O texto do push
  // da etapa não é mais um só: o handler entrega três, e o funil escolhe por
  // destinatário.
  it.each([[{}], [{ visibility_mode: "own" }]])(
    "etapa que avisa em carteira fechada (%j): o gerente que VÊ o negócio recebe o valor e o «Hoje nesta etapa»",
    async (settings) => {
      const db = banco(
        {
          agent_inbox_items: {
            id: "i3", kind: "other", ref_kind: "lead", ref_id: "l1",
            title: tituloDoAvisoDeEtapa("Pago", "pt-BR"), body: corpoDoAvisoDeEtapa("pt-BR"),
          },
          organizations: { locale: "pt-BR", settings },
          crm_leads: { pipeline_id: "p1", value_cents: 125_000, currency: "BRL", owner_user_id: "u-outro" },
        },
        {
          agent_inbox_items: [{ ref_id: "l1" }, { ref_id: "l9" }],
          crm_leads: [{ value_cents: 125_000, currency: "BRL" }, { value_cents: 25_000, currency: "BRL" }],
        },
      );
      vi.mocked(createAdminClient).mockReturnValue(db as never);
      await webPushInboundHandler.handle(evento("central.aviso_criado", { item_id: "i3" }, "agent_inbox_item"));

      // O que SAI no push para quem vê o negócio, seja qual for o funil: o
      // gerente desta organização de carteira fechada. Antes da #3981 a lista
      // tinha um payload só, sem valor nenhum.
      const enviados = [
        ...vi.mocked(enviarPushDaOrg).mock.calls.map((c) => c[1]),
        ...vi.mocked(enviarPushDaEtapaAQuemVeONegocio).mock.calls.map((c) => c[2].ampla),
      ];
      expect(enviados.map((p) => plano(p.title))).toContain("Negócio entrou em «Pago» · R$ 1.250,00");

      const [, leadId, textos, papel] = vi.mocked(enviarPushDaEtapaAQuemVeONegocio).mock.calls[0]!;
      expect([leadId, papel]).toEqual(["l1", "agent"]);
      // O que a gestão recebe: o número LITERAL, na moeda do negócio.
      expect(plano(textos.ampla.title)).toBe("Negócio entrou em «Pago» · R$ 1.250,00");
      expect(plano(textos.ampla.body)).toBe("Hoje nesta etapa: 2 (R$ 1.500,00)");
      expect(textos.ampla.corpoSemPrevia).toBe(corpoDoAvisoDeEtapa("pt-BR"));
      expect(db.filtros).toContainEqual(["crm_leads", "eq", "organization_id", ORG]);
    },
  );

  it("o MESMO aviso, sem valor, para quem NÃO vê o negócio — a carteira alheia não vaza", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      banco(
        {
          agent_inbox_items: {
            id: "i5", kind: "other", ref_kind: "lead", ref_id: "l1",
            title: tituloDoAvisoDeEtapa("Pago", "pt-BR"), body: corpoDoAvisoDeEtapa("pt-BR"),
          },
          organizations: { locale: "pt-BR", settings: {} },
          crm_leads: { pipeline_id: "p1", value_cents: 125_000, currency: "BRL", owner_user_id: "u-dono" },
        },
        { agent_inbox_items: [{ ref_id: "l1" }] },
      ) as never,
    );
    await webPushInboundHandler.handle(evento("central.aviso_criado", { item_id: "i5" }, "agent_inbox_item"));
    const textos = vi.mocked(enviarPushDaEtapaAQuemVeONegocio).mock.calls[0]![2];
    expect(textos.semValor).toMatchObject({
      title: "Negócio entrou em «Pago»",
      body: corpoDoAvisoDeEtapa("pt-BR"),
      corpoSemPrevia: corpoDoAvisoDeEtapa("pt-BR"),
    });
    expect(plano(JSON.stringify(textos.semValor))).not.toContain("R$");
  });

  it("o DONO fora do 'all' leva o valor do negócio dele, mas não a soma do dia (ela é da organização)", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      banco(
        {
          agent_inbox_items: {
            id: "i6", kind: "other", ref_kind: "lead", ref_id: "l1",
            title: tituloDoAvisoDeEtapa("Pago", "pt-BR"), body: corpoDoAvisoDeEtapa("pt-BR"),
          },
          organizations: { locale: "pt-BR", settings: {} },
          crm_leads: { pipeline_id: "p1", value_cents: 125_000, currency: "BRL", owner_user_id: "u-dono" },
        },
        {
          agent_inbox_items: [{ ref_id: "l1" }, { ref_id: "l9" }],
          crm_leads: [{ value_cents: 125_000, currency: "BRL" }, { value_cents: 25_000, currency: "BRL" }],
        },
      ) as never,
    );
    await webPushInboundHandler.handle(evento("central.aviso_criado", { item_id: "i6" }, "agent_inbox_item"));
    const textos = vi.mocked(enviarPushDaEtapaAQuemVeONegocio).mock.calls[0]![2];
    expect(plano(textos.daCarteira.title)).toBe("Negócio entrou em «Pago» · R$ 1.250,00");
    expect(textos.daCarteira.body).toBe(corpoDoAvisoDeEtapa("pt-BR"));
    expect(plano(JSON.stringify(textos.daCarteira))).not.toContain("Hoje nesta etapa");
  });

  it("negócio sem valor preenchido: o título não ganha «R$ 0» e o corpo não inventa soma", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      banco({
        agent_inbox_items: {
          id: "i7", kind: "other", ref_kind: "lead", ref_id: "l1",
          title: tituloDoAvisoDeEtapa("Pago", "pt-BR"), body: corpoDoAvisoDeEtapa("pt-BR"),
        },
        organizations: { locale: "pt-BR", settings: {} },
        crm_leads: { pipeline_id: "p1", value_cents: 0, currency: "BRL", owner_user_id: "u-dono" },
      }) as never,
    );
    await webPushInboundHandler.handle(evento("central.aviso_criado", { item_id: "i7" }, "agent_inbox_item"));
    const textos = vi.mocked(enviarPushDaEtapaAQuemVeONegocio).mock.calls[0]![2];
    expect(textos.ampla.title).toBe("Negócio entrou em «Pago»");
    expect(textos.ampla.body).toBe(corpoDoAvisoDeEtapa("pt-BR"));
    expect(textos.daCarteira).toEqual(textos.semValor);
    expect(plano(JSON.stringify(textos))).not.toContain("R$ 0");
  });

  it("em 'all' o texto do dono é o da gestão: o que chega ao celular é o de hoje, sem mudança", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      banco(
        {
          agent_inbox_items: {
            id: "i8", kind: "other", ref_kind: "lead", ref_id: "l1",
            title: tituloDoAvisoDeEtapa("Pago", "pt-BR"), body: corpoDoAvisoDeEtapa("pt-BR"),
          },
          organizations: { locale: "pt-BR", settings: TODOS_VEEM },
          crm_leads: { pipeline_id: "p1", value_cents: 125_000, currency: "BRL", owner_user_id: "u-dono" },
        },
        {
          agent_inbox_items: [{ ref_id: "l1" }, { ref_id: "l9" }],
          crm_leads: [{ value_cents: 125_000, currency: "BRL" }, { value_cents: 25_000, currency: "BRL" }],
        },
      ) as never,
    );
    await webPushInboundHandler.handle(evento("central.aviso_criado", { item_id: "i8" }, "agent_inbox_item"));
    const textos = vi.mocked(enviarPushDaEtapaAQuemVeONegocio).mock.calls[0]![2];
    expect(textos.daCarteira).toEqual(textos.ampla);
    expect(plano(textos.ampla.body)).toBe("Hoje nesta etapa: 2 (R$ 1.500,00)");
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
    expect(vi.mocked(enviarPushDaEtapaAQuemVeONegocio).mock.calls[0]![2].ampla).toMatchObject({
      title: "Negócio entrou em «Pago»",
      body: corpoDoAvisoDeEtapa("pt-BR"),
    });
  });

  it("lead.won: o valor no título e o dia ao lado do negócio, no idioma da organização", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      banco(
        {
          organizations: { locale: "es", timezone: "America/Sao_Paulo", settings: TODOS_VEEM },
          crm_leads: { title: "Pedido da Ana", owner_user_id: "u-dono", pipeline_id: "p1", value_cents: 125_000, currency: "BRL" },
        },
        {
          crm_leads: [
            { value_cents: 125_000, currency: "BRL", owner_user_id: "u-dono" },
            { value_cents: 75_000, currency: "BRL", owner_user_id: "u-outro" },
          ],
        },
      ) as never,
    );
    await webPushInboundHandler.handle(evento("lead.won", { lead_id: "l1" }));
    const [org, usuario, payload] = vi.mocked(enviarPushAoUsuario).mock.calls[0]!;
    expect([org, usuario]).toEqual([ORG, "u-dono"]);
    expect(payload).toMatchObject({
      title: "Lead ganado · R$ 1.250,00",
      body: "Pedido da Ana · Ganados hoy: 2 (R$ 2.000,00)",
      corpoSemPrevia: "Pedido da Ana",
      href: "/app/pipelines/p1",
    });
  });

  it.each([
    ["agent", {}, "Ganhos hoje: 2 (R$ 1.350,00)"],
    ["agent", { visibility_mode: "own" }, "Ganhos hoje: 1 (R$ 1.250,00)"],
    ["manager", {}, "Ganhos hoje: 3 (R$ 2.100,00)"],
  ])("lead.won para um %s (%j): só soma os ganhos que ele veria na tela", async (papel, settings, linha) => {
    vi.mocked(createAdminClient).mockReturnValue(
      banco(
        {
          organizations: { locale: "pt-BR", settings },
          user_organizations: { role: papel },
          crm_leads: { title: "Pedido da Ana", owner_user_id: "u-dono", pipeline_id: "p1", value_cents: 125_000, currency: "BRL" },
        },
        {
          crm_leads: [
            { value_cents: 125_000, currency: "BRL", owner_user_id: "u-dono" },
            { value_cents: 75_000, currency: "BRL", owner_user_id: "u-outro" },
            { value_cents: 10_000, currency: "BRL", owner_user_id: null },
          ],
        },
      ) as never,
    );
    await webPushInboundHandler.handle(evento("lead.won", { lead_id: "l1" }));
    const payload = vi.mocked(enviarPushAoUsuario).mock.calls[0]![2];
    expect(plano(payload.title)).toBe("Lead ganho · R$ 1.250,00");
    expect(plano(payload.body)).toBe(`Pedido da Ana · ${linha}`);
    expect(payload.corpoSemPrevia).toBe("Pedido da Ana");
  });

  it("lead.won: a GESTÃO recebe o ganho de negócio que não é dela, com a soma do dia inteira", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      banco(
        {
          organizations: { locale: "pt-BR", settings: {} },
          crm_leads: { title: "Pedido da Ana", owner_user_id: "u-dono", pipeline_id: "p1", value_cents: 125_000, currency: "BRL" },
        },
        {
          crm_leads: [
            { value_cents: 125_000, currency: "BRL", owner_user_id: "u-dono" },
            { value_cents: 75_000, currency: "BRL", owner_user_id: "u-outro" },
            { value_cents: 10_000, currency: "BRL", owner_user_id: null },
          ],
        },
      ) as never,
    );
    await webPushInboundHandler.handle(evento("lead.won", { lead_id: "l1" }));
    const [org, payload, quem] = vi.mocked(enviarPushDaOrg).mock.calls[0]!;
    expect(org).toBe(ORG);
    expect(payload).toMatchObject({
      title: "Lead ganho · R$ 1.250,00",
      body: "Pedido da Ana · Ganhos hoje: 3 (R$ 2.100,00)",
      corpoSemPrevia: "Pedido da Ana",
    });
    // O dono recebe o texto DELE (com a soma que ele vê), então não entra aqui.
    expect(quem).toEqual({ papelMinimo: "manager", excetoUsuario: "u-dono" });
  });

  it("lead.won de negócio SEM dono: quem gerencia recebe, e ninguém fica com aviso sem destinatário", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      banco(
        {
          organizations: { locale: "pt-BR", settings: {} },
          crm_leads: { title: "Pedido da Ana", owner_user_id: null, pipeline_id: "p1", value_cents: 125_000, currency: "BRL" },
        },
        { crm_leads: [{ value_cents: 125_000, currency: "BRL", owner_user_id: null }] },
      ) as never,
    );
    await webPushInboundHandler.handle(evento("lead.won", { lead_id: "l1" }));
    expect(vi.mocked(enviarPushDaOrg)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(enviarPushDaOrg).mock.calls[0]![2]).toEqual({ papelMinimo: "manager", excetoUsuario: undefined });
    expect(vi.mocked(enviarPushAoUsuario)).not.toHaveBeenCalled();
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
