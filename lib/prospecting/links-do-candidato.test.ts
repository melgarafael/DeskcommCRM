import { describe, expect, it } from "vitest";

import { linksDoCandidato } from "@/lib/prospecting/links-do-candidato";

describe("linksDoCandidato (Spec 26 §3.1)", () => {
  it("website que é Instagram vira `instagram`, e NÃO `site`", () => {
    const links = linksDoCandidato({
      website: "https://www.instagram.com/clinica1/",
      socials: [],
      maps_url: null,
    });
    expect(links).toEqual({ instagram: "https://www.instagram.com/clinica1/" });
    expect(links).not.toHaveProperty("site");
  });

  it("site próprio vira `site`", () => {
    const links = linksDoCandidato({ website: "https://www.clinica1.com.br/", socials: [] });
    expect(links).toEqual({ site: "https://www.clinica1.com.br/" });
  });

  it("agregador que não é rede (linktr.ee) vira `outro`", () => {
    const links = linksDoCandidato({ website: "https://linktr.ee/clinica1", socials: [] });
    expect(links).toEqual({ outro: "https://linktr.ee/clinica1" });
  });

  it("socials vence o website da MESMA rede", () => {
    const links = linksDoCandidato({
      website: "https://www.instagram.com/outra",
      socials: ["https://www.instagram.com/oficial"],
    });
    expect(links).toEqual({ instagram: "https://www.instagram.com/oficial" });
  });

  it("LinkedIn em socials vira `linkedin`", () => {
    const links = linksDoCandidato({
      socials: ["https://br.linkedin.com/company/clinica1"],
    });
    expect(links).toEqual({ linkedin: "https://br.linkedin.com/company/clinica1" });
  });

  it("socials pega só o PRIMEIRO endereço de cada rede", () => {
    const links = linksDoCandidato({
      socials: [
        "https://www.facebook.com/primeira",
        "https://www.facebook.com/segunda",
      ],
    });
    expect(links).toEqual({ facebook: "https://www.facebook.com/primeira" });
  });

  it("`javascript:` é descartado, em website e em socials", () => {
    expect(linksDoCandidato({ website: "javascript:alert(1)", socials: [] })).toEqual({});
    expect(linksDoCandidato({ socials: ["javascript:alert(1)"] })).toEqual({});
  });

  it("endereço com mais de 1000 caracteres é descartado", () => {
    const longo = `https://www.clinica1.com.br/${"a".repeat(1000)}`;
    expect(linksDoCandidato({ website: longo, socials: [] })).toEqual({});
  });

  it("endereço sem host não vira nada (nem `site`, nem `outro`)", () => {
    expect(linksDoCandidato({ website: "not-a-url", socials: [] })).toEqual({});
    expect(linksDoCandidato({ website: "loja", socials: [] })).toEqual({});
    expect(linksDoCandidato({ website: "@clinica1", socials: [] })).toEqual({});
  });

  it("`data` vazio ou nulo devolve {} e não lança", () => {
    expect(linksDoCandidato({})).toEqual({});
    expect(linksDoCandidato(null)).toEqual({});
    expect(linksDoCandidato(undefined)).toEqual({});
  });

  it("maps_url vira `google_meu_negocio`", () => {
    const links = linksDoCandidato({ maps_url: "https://maps.app.goo.gl/clinica1" });
    expect(links).toEqual({ google_meu_negocio: "https://maps.app.goo.gl/clinica1" });
  });
});
