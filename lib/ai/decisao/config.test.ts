/**
 * O INTERRUPTOR DO JEV: ler nunca lança e falha DESLIGADO; gravar não apaga o
 * resto de `settings` e só alcança a própria organização.
 */
import { describe, expect, it } from "vitest";

import { gravarConfigDoJev, lerConfigDoJev } from "@/lib/ai/decisao/config";

const ORG = "11111111-1111-4111-8111-111111111111";
const ADMIN = "22222222-2222-4222-8222-222222222222";
const ACEITE = { em: "2026-09-23T12:00:00.000Z", por: ADMIN };

describe("lerConfigDoJev", () => {
  it("sem nada gravado, desligado em observação", () => {
    expect(lerConfigDoJev({})).toEqual({ ligado: false, modo: "observacao", aceite: null });
    expect(lerConfigDoJev(null)).toEqual({ ligado: false, modo: "observacao", aceite: null });
  });

  it("lê o que foi gravado", () => {
    const c = lerConfigDoJev({ jev: { ligado: true, modo: "decide", aceite: ACEITE } });
    expect(c.ligado).toBe(true);
    expect(c.modo).toBe("decide");
  });

  it.each([
    ["modo desconhecido", { ligado: true, modo: "turbo", aceite: ACEITE }],
    ["ligado não-booleano", { ligado: "sim", aceite: ACEITE }],
    ["aceite torto", { ligado: true, aceite: { em: "ontem", por: "eu" } }],
    ["jev não é objeto", "ligado"],
    // LGPD: ligar manda a mensagem do cliente para fora do país. Sem o aceite
    // do administrador, o JSON não liga nada — mesmo que diga `ligado: true`.
    ["ligado sem aceite", { ligado: true }],
  ])("%s → desligado, sem lançar", (_caso, jev) => {
    expect(lerConfigDoJev({ jev }).ligado).toBe(false);
  });
});

type Linha = { settings: Record<string, unknown> } | null;

function adminFalso(linha: Linha, gravaLinhas = true) {
  const filtros: Array<[string, unknown]> = [];
  const updates: Array<Record<string, unknown>> = [];
  const admin = {
    from: (tabela: string) => {
      expect(tabela).toBe("organizations");
      let op: "select" | "update" = "select";
      const chain = {
        select: () => chain,
        update: (patch: Record<string, unknown>) => {
          op = "update";
          updates.push(patch);
          return chain;
        },
        eq: (coluna: string, valor: unknown) => {
          filtros.push([coluna, valor]);
          return chain;
        },
        maybeSingle: async () =>
          op === "update"
            ? { data: gravaLinhas ? { settings: updates.at(-1)?.settings } : null, error: null }
            : { data: linha, error: null },
      };
      return chain;
    },
  };
  return { admin: admin as unknown as Parameters<typeof gravarConfigDoJev>[0]["admin"], filtros, updates };
}

describe("gravarConfigDoJev", () => {
  it("mescla sem apagar as outras chaves de settings", async () => {
    const f = adminFalso({ settings: { branding: { nome: "X" }, llm: { provider: "anthropic" } } });
    const r = await gravarConfigDoJev({
      admin: f.admin,
      orgId: ORG,
      actorUserId: ADMIN,
      mudanca: { ligado: true, aceite: ACEITE },
      agora: new Date("2026-09-23T13:00:00.000Z"),
    });

    expect(r.ok).toBe(true);
    const gravado = f.updates[0]!.settings as Record<string, unknown>;
    expect(gravado.branding).toEqual({ nome: "X" });
    expect(gravado.llm).toEqual({ provider: "anthropic" });
    expect(gravado.jev).toMatchObject({
      ligado: true,
      modo: "observacao",
      aceite: ACEITE,
      alterado_em: "2026-09-23T13:00:00.000Z",
      alterado_por: ADMIN,
    });
  });

  it("toda leitura e escrita é cercada pela organização da sessão", async () => {
    const f = adminFalso({ settings: {} });
    await gravarConfigDoJev({ admin: f.admin, orgId: ORG, actorUserId: ADMIN, mudanca: { modo: "decide" } });
    expect(f.filtros).toEqual([
      ["id", ORG],
      ["id", ORG],
    ]);
  });

  it("recusa ligar sem aceite, e não grava nada", async () => {
    const f = adminFalso({ settings: {} });
    const r = await gravarConfigDoJev({ admin: f.admin, orgId: ORG, actorUserId: ADMIN, mudanca: { ligado: true } });
    expect(r).toEqual({ ok: false, motivo: "config_invalida" });
    expect(f.updates).toEqual([]);
  });

  it("zero linha gravada não vira sucesso", async () => {
    const f = adminFalso({ settings: {} }, false);
    const r = await gravarConfigDoJev({ admin: f.admin, orgId: ORG, actorUserId: ADMIN, mudanca: { modo: "decide" } });
    expect(r).toEqual({ ok: false, motivo: "escrita_recusada" });
  });

  it("organização inexistente não é criada", async () => {
    const f = adminFalso(null);
    const r = await gravarConfigDoJev({ admin: f.admin, orgId: ORG, actorUserId: ADMIN, mudanca: { modo: "decide" } });
    expect(r).toEqual({ ok: false, motivo: "leitura_falhou" });
    expect(f.updates).toEqual([]);
  });
});
