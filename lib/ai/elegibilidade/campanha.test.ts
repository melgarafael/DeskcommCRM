import { describe, expect, it } from "vitest";

import {
  casarCampanha,
  lerCampanhas,
  normalizarParaMatch,
  parseCampanhas,
  type CampanhaWhatsapp,
} from "./campanha";

const SESSAO = "33333333-3333-4333-8333-333333333333";
const OUTRA_SESSAO = "99999999-9999-4999-8999-999999999999";

const incorporadoras: CampanhaWhatsapp = {
  id: "incorporadoras-meta",
  match: { tipo: "contains", valor: "marketing para incorporadoras" },
  segmento: "imobiliario",
};
const videos: CampanhaWhatsapp = {
  id: "videos-google",
  match: { tipo: "starts_with", valor: "Quero orçamento para vídeos" },
};

describe("normalizarParaMatch", () => {
  it("minúsculas, sem acento, espaços colapsados", () => {
    expect(normalizarParaMatch("  Quero   ORÇAMENTO  para Vídeos ")).toBe("quero orcamento para videos");
  });
});

describe("casarCampanha", () => {
  it("teste 8: mensagem de campanha com identificador autorizado → casa", () => {
    const c = casarCampanha(
      "Olá! Quero saber mais sobre marketing para incorporadoras",
      [incorporadoras, videos],
      SESSAO,
    );
    expect(c?.id).toBe("incorporadoras-meta");
  });

  it("acento/caixa não impedem o match", () => {
    expect(
      casarCampanha("quero saber mais sobre MARKETING PARA INCORPORADORAS", [incorporadoras], SESSAO)?.id,
    ).toBe("incorporadoras-meta");
  });

  it("teste 9: 'Boa noite' não casa nenhuma campanha", () => {
    expect(casarCampanha("Boa noite", [incorporadoras, videos], SESSAO)).toBeNull();
  });

  it("mensagem vazia/null → null", () => {
    expect(casarCampanha(null, [incorporadoras], SESSAO)).toBeNull();
    expect(casarCampanha("   ", [incorporadoras], SESSAO)).toBeNull();
  });

  it("starts_with exige o prefixo no começo", () => {
    expect(casarCampanha("Quero orçamento para vídeos institucionais", [videos], SESSAO)?.id).toBe(
      "videos-google",
    );
    expect(casarCampanha("Antes disso, quero orçamento para vídeos", [videos], SESSAO)).toBeNull();
  });

  it("campanha presa a outro canal não casa neste", () => {
    const presa: CampanhaWhatsapp = { ...incorporadoras, channel_session_id: OUTRA_SESSAO };
    expect(casarCampanha("marketing para incorporadoras", [presa], SESSAO)).toBeNull();
    expect(casarCampanha("marketing para incorporadoras", [presa], OUTRA_SESSAO)?.id).toBe(
      "incorporadoras-meta",
    );
  });

  it("primeira campanha que casa vence", () => {
    const a: CampanhaWhatsapp = { id: "a", match: { tipo: "contains", valor: "orçamento" } };
    const b: CampanhaWhatsapp = { id: "b", match: { tipo: "contains", valor: "orçamento para vídeos" } };
    expect(casarCampanha("quero orçamento para vídeos", [a, b], SESSAO)?.id).toBe("a");
  });
});

describe("lerCampanhas / schema", () => {
  it("lê a lista de organizations.settings", () => {
    const campanhas = lerCampanhas({ campanhas_whatsapp: [incorporadoras] });
    expect(campanhas).toHaveLength(1);
    expect(campanhas[0]?.id).toBe("incorporadoras-meta");
  });

  it("settings ausente/malformado → lista vazia, nunca lança", () => {
    expect(lerCampanhas(null)).toEqual([]);
    expect(lerCampanhas({})).toEqual([]);
    expect(lerCampanhas({ campanhas_whatsapp: "lixo" })).toEqual([]);
  });

  it("item malformado é descartado sem derrubar os válidos", () => {
    const r = parseCampanhas([{ id: "x" }, incorporadoras, { id: "y", match: { tipo: "contains", valor: "ab" } }]);
    expect(r.map((c) => c.id)).toEqual(["incorporadoras-meta"]);
  });
});
