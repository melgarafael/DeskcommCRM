import { describe, expect, it } from "vitest";

import { bancoFalso, filtros } from "@/tests/helpers/banco-falso-da-cobranca";

import { anexarLinkDePagamento } from "./central";

const ORG = "16161616-0000-4000-8000-000000000001";
const aviso = (kind: string, ref_kind: string | null) => ({ id: `${kind}-${ref_kind}`, kind, ref_kind });

describe("anexarLinkDePagamento", () => {
  it("⭐ o aviso da régua ganha o link ATUAL, lido com o filtro da empresa; os outros avisos ficam como estavam", async () => {
    const banco = bancoFalso(() => ({ data: { link_de_pagamento: "https://invoice.stripe.com/i/agora" } }));
    const itens = await anexarLinkDePagamento(banco.cliente as never, ORG, "admin", [aviso("cobranca", null), aviso("cobranca", "plano"), aviso("handoff", "conversation")]);
    expect(itens.map((i) => ("link_de_pagamento" in i ? i.link_de_pagamento : "sem"))).toEqual(["https://invoice.stripe.com/i/agora", "sem", "sem"]);
    expect(filtros(banco.cadeias[0]!)).toEqual([["eq", "organization_id", ORG]]);
  });

  it("quem não administra não recebe o link, e nada é lido", async () => {
    const banco = bancoFalso(() => ({ data: { link_de_pagamento: "x" } }));
    const itens = await anexarLinkDePagamento(banco.cliente as never, ORG, "manager", [aviso("cobranca", null)]);
    expect("link_de_pagamento" in itens[0]!).toBe(false);
    expect(banco.cadeias).toEqual([]);
  });

  it("sem aviso da régua na lista, nada é lido", async () => {
    const banco = bancoFalso(() => ({ data: null }));
    await anexarLinkDePagamento(banco.cliente as never, ORG, "admin", [aviso("handoff", "conversation")]);
    expect(banco.cadeias).toEqual([]);
  });
});
