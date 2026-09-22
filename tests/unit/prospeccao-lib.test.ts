import { describe, expect, it } from "vitest";

import { termosDeBusca } from "@/lib/prospeccao/categorias";
import { decidirDedup, type ProspectExistente } from "@/lib/prospeccao/dedup";
import { gerarGrade } from "@/lib/prospeccao/grade";
import {
  extrairDominio,
  normalizarNome,
  normalizarTelefone,
  partirEndereco,
  whatsappPotencial,
} from "@/lib/prospeccao/normalizacao";
import { scoreDeProspect } from "@/lib/prospeccao/score";

/**
 * A LIB DE PROSPECÇÃO — cerca do plano §§5–8, 19, 31–33.
 * Sem rede, sem banco: tudo puro.
 */
describe("normalizarNome", () => {
  it("tira acento, caixa e sufixo societário", () => {
    expect(normalizarNome("Oficina São José LTDA")).toBe("oficina sao jose");
    expect(normalizarNome("  Auto-Peças  Canoinhas ME ")).toBe("auto pecas canoinhas");
  });
});

describe("normalizarTelefone", () => {
  it("(47) 99999-9999 vira +5547999999999", () => {
    expect(normalizarTelefone("(47) 99999-9999")).toBe("+5547999999999");
  });

  it("fixo sem 9 continua comparável", () => {
    expect(normalizarTelefone("(47) 3622-1234")).toBe("+554736221234");
  });

  it("fragmento não vira telefone", () => {
    expect(normalizarTelefone("9999")).toBeNull();
    expect(normalizarTelefone(null)).toBeNull();
  });
});

describe("whatsappPotencial", () => {
  it("móvel com 9 é potencial; fixo nunca", () => {
    expect(whatsappPotencial("+5547999999999")).toBe(true);
    expect(whatsappPotencial("+554736221234")).toBe(false);
    expect(whatsappPotencial(null)).toBe(false);
  });
});

describe("extrairDominio", () => {
  it("https://www.empresa.com.br/ vira empresa.com.br", () => {
    expect(extrairDominio("https://www.empresa.com.br/")).toBe("empresa.com.br");
    expect(extrairDominio("empresa.com.br/contato")).toBe("empresa.com.br");
    expect(extrairDominio("not a url at all")).toBeNull();
  });
});

describe("partirEndereco", () => {
  it("parte o canônico e acha CEP/UF", () => {
    const p = partirEndereco("Rua Vidal Ramos, 123 - Centro, Canoinhas - SC, 89460-000");
    expect(p).toMatchObject({
      logradouro: "Rua Vidal Ramos",
      numero: "123",
      bairro: "Centro",
      cidade: "Canoinhas",
      estado: "SC",
      cep: "89460-000",
    });
  });

  it("o que não casa vira NULL, não chute", () => {
    expect(partirEndereco(null)).toMatchObject({ cidade: null, cep: null });
  });
});

describe("gerarGrade", () => {
  it("Joinville + 40km gera células com overlap e cobre o centro", () => {
    const grade = gerarGrade(-26.3045, -48.8487, 40, 5, 10);
    expect(grade.length).toBeGreaterThan(100);
    // Centro coberto: alguma célula perto do ponto pedido.
    const perto = grade.some(
      (c) => Math.abs(c.latitude - -26.3045) < 0.05 && Math.abs(c.longitude - -48.8487) < 0.05,
    );
    expect(perto).toBe(true);
    // Raio da célula cobre os cantos (passo/2 * √2 em metros).
    expect(grade[0]?.raioMetros).toBeGreaterThan(3000);
  });

  it("é determinística", () => {
    const a = gerarGrade(-26.3, -48.8, 10, 5, 10);
    const b = gerarGrade(-26.3, -48.8, 10, 5, 10);
    expect(a).toEqual(b);
  });
});

const EXISTENTE: ProspectExistente = {
  id: "e1",
  provider: "google_places",
  external_id: "place-1",
  nome_normalizado: "oficina sao jose",
  telefone_normalizado: "+5547999999999",
  dominio: "oficinasaojose.com.br",
  endereco: "Rua A, 100 - Canoinhas - SC",
  latitude: -26.17,
  longitude: -50.32,
};

describe("decidirDedup", () => {
  const base = {
    provider: "google_places",
    external_id: null as string | null,
    nome_normalizado: "outra coisa",
    telefone_normalizado: null as string | null,
    dominio: null as string | null,
    endereco: null as string | null,
    latitude: null as number | null,
    longitude: null as number | null,
  };

  it("nível 1: provider + id é identidade", () => {
    expect(
      decidirDedup({ ...base, external_id: "place-1", nome_normalizado: "qualquer" }, [EXISTENTE]),
    ).toEqual({ nivel: "provider_id", comQuem: "e1" });
  });

  it("nível 2: telefone + nome (telefone sozinho não decide)", () => {
    expect(
      decidirDedup(
        { ...base, telefone_normalizado: "+5547999999999", nome_normalizado: "oficina sao jose" },
        [EXISTENTE],
      ),
    ).toEqual({ nivel: "telefone_nome", comQuem: "e1" });
    // Mesmo telefone, nome diferente (matriz/filial?) → não funde.
    expect(
      decidirDedup(
        { ...base, telefone_normalizado: "+5547999999999", nome_normalizado: "filial norte" },
        [EXISTENTE],
      ).nivel,
    ).not.toBe("telefone_nome");
  });

  it("nível 3: domínio + nome", () => {
    expect(
      decidirDedup(
        { ...base, dominio: "oficinasaojose.com.br", nome_normalizado: "oficina sao jose" },
        [EXISTENTE],
      ),
    ).toEqual({ nivel: "dominio", comQuem: "e1" });
  });

  it("nível 5 é sugestão, não fusão", () => {
    const d = decidirDedup(
      {
        ...base,
        nome_normalizado: "oficina sao jose",
        latitude: -26.1701,
        longitude: -50.3201,
      },
      [EXISTENTE],
    );
    expect(d).toEqual({ nivel: "proximidade_sugestao", comQuem: "e1" });
  });

  it("novo quando nada casa", () => {
    expect(decidirDedup(base, [EXISTENTE])).toEqual({ nivel: "novo", comQuem: null });
  });
});

describe("scoreDeProspect", () => {
  it("completo e quente soma 100", () => {
    expect(
      scoreDeProspect({ temTelefone: true, temWebsite: true, whatsappPotencial: true, nota: 5, totalAvaliacoes: 542, bonusCategoria: 10 }),
    ).toBe(100);
  });

  it("só nome soma zero", () => {
    expect(
      scoreDeProspect({ temTelefone: false, temWebsite: false, whatsappPotencial: false, nota: null, totalAvaliacoes: 0 }),
    ).toBe(0);
  });
});

describe("termosDeBusca", () => {
  it("cobre as macros do plano, com automotivo detalhado", () => {
    const termos = termosDeBusca();
    const macros = new Set(termos.map((t) => t.macro));
    for (const m of ["Alimentação", "Automotivo", "Construção", "Saúde", "Agronegócio"]) {
      expect(macros.has(m)).toBe(true);
    }
    expect(termos.some((t) => t.busca === "Oficina mecânica")).toBe(true);
  });
});
