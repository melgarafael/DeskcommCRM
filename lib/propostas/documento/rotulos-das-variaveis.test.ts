import { describe, expect, it } from "vitest";

import { MODELOS_BASE } from "../modelos/catalogo-base";
import { extrairVariaveis } from "./variaveis";
import { ROTULO_DA_VARIAVEL, ondePreencher, rotuloDaVariavel, rotulosDoNegocio } from "./rotulos-das-variaveis";

describe("rótulos das variáveis", () => {
  it("toda variável usada pelos modelos da plataforma tem nome legível (varre, não lista)", () => {
    const usadas = new Set(
      Object.values(MODELOS_BASE).flatMap((m) => m.sections.flatMap((s) => extrairVariaveis(s.body))),
    );
    const semNome = [...usadas].filter((v) => !Object.hasOwn(ROTULO_DA_VARIAVEL, v));
    expect(semNome).toEqual([]);
    // guarda de vacuidade: a varredura achou alguma coisa
    expect(usadas.size).toBeGreaterThan(20);
  });

  it("variável desconhecida (modelo da empresa) vira o último pedaço, legível", () => {
    expect(rotuloDaVariavel("scope.tipo_de_imovel")).toBe("Tipo de imovel");
    expect(rotuloDaVariavel("x")).toBe("X");
  });

  it("variável conhecida devolve o nome do vocabulário", () => {
    expect(rotuloDaVariavel("scope.property_filters")).toBe("Filtros de busca de imóveis");
  });

  it("diz onde cada variável se preenche", () => {
    expect(ondePreencher("project.objective")).toBe("briefing");
    expect(ondePreencher("client.company")).toBe("briefing");
    expect(ondePreencher("included.list")).toBe("briefing");
    expect(ondePreencher("schedule.estimated_days")).toBe("campo_prazo");
    expect(ondePreencher("investment.total_formatted")).toBe("itens");
    expect(ondePreencher("client.name")).toBe("contato");
    expect(ondePreencher("client.company_or_name")).toBe("contato");
    expect(ondePreencher("commercial_terms.validity_days")).toBe("sistema");
    expect(ondePreencher("approval.date")).toBe("sistema");
    expect(ondePreencher("numero")).toBe("sistema");
  });

  it("campo do funil homônimo de variável fixa não troca o rótulo dela no editor (doc 343)", () => {
    const rotulos = rotulosDoNegocio([
      { key: "titulo", label: "Título do anúncio" },
      { key: "endereco_do_imovel", label: "Endereço do imóvel" },
    ]);
    expect(rotulos["lead.titulo"]).toBe("Título do negócio");
    expect(rotulos["lead.endereco_do_imovel"]).toBe("Endereço do imóvel");
  });
});
