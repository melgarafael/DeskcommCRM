import { describe, expect, it } from "vitest";

import { mapearExportMaps, MAX_LINHAS_ARQUIVO } from "./importacao-maps";

function linhaBase() {
  return {
    name: "Oficina do Zé",
    fullAddress: "Rua das Flores, 123 - Centro, Canoinhas - SC, 89460-000",
    phones: "+55 47 99999-0000, +55 47 3622-0000",
    website: "https://oficinadoze.com.br",
    averageRating: 4.5,
    reviewCount: 37,
    categories: "Oficina mecânica, Troca de óleo",
    emails: "contato@oficinadoze.com.br",
    plusCode: "5864+2X Canoinhas",
    placeId: "ChIJabc123",
    latitude: -26.1765,
    longitude: -50.39,
    googleMapsURL: "https://www.google.com/maps?cid=123",
    municipality: "Canoinhas",
  };
}

describe("importacao-maps (ponte do Google Maps Scraper)", () => {
  it("mapeia a linha completa para o contrato", () => {
    const r = mapearExportMaps([linhaBase()]);
    expect(r.recusadas).toEqual([]);
    expect(r.negocios.length).toBe(1);
    const n = r.negocios[0]!;
    expect(n.nome).toBe("Oficina do Zé");
    expect(n.idExterno).toBe("maps:ChIJabc123");
    expect(n.categoriaPrincipal).toBe("Oficina mecânica");
    expect(n.categoriasSecundarias).toEqual(["Troca de óleo"]);
    expect(n.telefone).toBe("+55 47 99999-0000");
    expect(n.email).toBe("contato@oficinadoze.com.br");
    expect(n.endereco).toContain("Rua das Flores");
    expect(n.cidade).toBe("Canoinhas");
    expect(n.nota).toBe(4.5);
    expect(n.totalAvaliacoes).toBe(37);
    expect(n.urlExterna).toContain("google.com/maps");
  });

  it("sem nome vira recusada nomeando o motivo, sem exceção", () => {
    const r = mapearExportMaps([{ ...linhaBase(), name: "  " }, null, 42]);
    expect(r.negocios.length).toBe(0);
    expect(r.recusadas.length).toBe(3);
    expect(r.recusadas[0]!.motivo).toMatch(/sem nome/);
  });

  it("email inválido cai, o válido fica; nota fora de 0–5 zera", () => {
    const r = mapearExportMaps([
      { ...linhaBase(), emails: "nao-email, bom@site.com.br", averageRating: 9, reviewCount: "dez" },
    ]);
    const n = r.negocios[0]!;
    expect(n.email).toBe("bom@site.com.br");
    expect(n.nota).toBeNull();
    expect(n.totalAvaliacoes).toBe(0);
  });

  it("sem placeId o idExterno é null (dedup cai para fone/domínio)", () => {
    const { placeId: _, ...semId } = linhaBase();
    const r = mapearExportMaps([semId]);
    expect(r.negocios[0]!.idExterno).toBeNull();
  });

  it("entrada que não é lista vira recusada única", () => {
    const r = mapearExportMaps({ name: "x" });
    expect(r.negocios).toEqual([]);
    expect(r.recusadas.length).toBe(1);
  });

  it("respeita o teto de linhas e avisa o corte", () => {
    const muitas = Array.from({ length: MAX_LINHAS_ARQUIVO + 5 }, (_, i) => ({ ...linhaBase(), name: `Loja ${i}` }));
    const r = mapearExportMaps(muitas);
    expect(r.negocios.length).toBe(MAX_LINHAS_ARQUIVO);
    expect(r.recusadas.some((x) => x.motivo.includes("teto"))).toBe(true);
  });
});
