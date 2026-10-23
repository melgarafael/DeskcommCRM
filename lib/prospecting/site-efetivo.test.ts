import { describe, expect, it } from "vitest";

import {
  INTERVALO_MINIMO_ENTRE_TENTATIVAS_MIN,
  LIMITE_TENTATIVAS,
  precisaDeRede,
  siteEfetivo,
} from "@/lib/prospecting/site-efetivo";
import type { Prospect } from "@/lib/prospecting/schema";
import type { SiteEnrichment } from "@/lib/prospecting/site-classify";

const AGORA = "2026-10-15T12:00:00.000Z";

function candidato(campos: Partial<Prospect> = {}): Prospect {
  return {
    key: "k",
    name: "Clínica Vitta",
    phone: null,
    website: null,
    category: null,
    address: null,
    maps_url: null,
    rating: null,
    reviews: null,
    emails: [],
    socials: [],
    site: null,
    ...campos,
  };
}

function veredito(campos: Partial<SiteEnrichment> = {}): SiteEnrichment {
  return {
    ver: 1,
    classe: "site-ok",
    problemas: [],
    checklist: { tem: [], falta: [] },
    final_url: "https://vitta.test/",
    http_status: 200,
    tempo_ms: 100,
    conteudo_resumo: null,
    pagespeed: null,
    verificado_em: AGORA,
    provisorio: false,
    tentativas: 0,
    ...campos,
  };
}

describe("siteEfetivo: o veredito que a LEITURA usa (spec 24)", () => {
  it("já tem veredito gravado: devolve o gravado, sem tocar no website", () => {
    const gravado = veredito({ classe: "site-ruim", problemas: ["sem-https"] });
    expect(siteEfetivo(candidato({ website: "https://vitta.test/", site: gravado }), AGORA)).toBe(
      gravado,
    );
  });

  it("sem website e sem veredito: deriva 'sem-site' na hora, sem rede", () => {
    const efetivo = siteEfetivo(candidato({ website: "   ", site: null }), AGORA);
    expect(efetivo).not.toBeNull();
    expect(efetivo!.classe).toBe("sem-site");
    expect(efetivo!.tempo_ms).toBe(0);
  });

  it("tem website e ainda não tem veredito: null (pendente de rede)", () => {
    expect(siteEfetivo(candidato({ website: "https://vitta.test/", site: null }), AGORA)).toBeNull();
  });
});

describe("precisaDeRede: quem o botão 'Verificar sites' ainda pode socorrer", () => {
  it("sem-site derivado NÃO conta (não há rede a fazer)", () => {
    expect(precisaDeRede(candidato({ website: null, site: null }), AGORA)).toBe(false);
  });

  it("site preenchido e sem veredito conta", () => {
    expect(precisaDeRede(candidato({ website: "https://vitta.test/", site: null }), AGORA)).toBe(
      true,
    );
  });

  it("veredito definitivo não conta", () => {
    expect(
      precisaDeRede(candidato({ website: "https://vitta.test/", site: veredito() }), AGORA),
    ).toBe(false);
  });

  it("provisório antes do intervalo não conta; depois do intervalo conta", () => {
    const referencia = Date.parse(AGORA);
    const antes = veredito({ classe: "fora-do-ar", provisorio: true, tentativas: 1 });
    const cedo = new Date(referencia + 1_000).toISOString();
    const tarde = new Date(
      referencia + (INTERVALO_MINIMO_ENTRE_TENTATIVAS_MIN + 1) * 60_000,
    ).toISOString();
    expect(precisaDeRede(candidato({ website: "https://vitta.test/", site: antes }), cedo)).toBe(
      false,
    );
    expect(precisaDeRede(candidato({ website: "https://vitta.test/", site: antes }), tarde)).toBe(
      true,
    );
  });

  it("provisório no teto de tentativas não conta mais (congelou)", () => {
    const tarde = new Date(
      Date.parse(AGORA) + (INTERVALO_MINIMO_ENTRE_TENTATIVAS_MIN + 1) * 60_000,
    ).toISOString();
    const noTeto = veredito({
      classe: "fora-do-ar",
      provisorio: true,
      tentativas: LIMITE_TENTATIVAS,
    });
    expect(precisaDeRede(candidato({ website: "https://vitta.test/", site: noTeto }), tarde)).toBe(
      false,
    );
  });
});
