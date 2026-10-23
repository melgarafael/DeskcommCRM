import { describe, expect, it } from "vitest";

import { ROTULOS_DO_TIPO, rotuloDoTipo } from "@/lib/schemas/rotulos-do-campo";
import { customFieldSchema } from "@/lib/schemas/settings";

/**
 * O RÓTULO DE CADA TIPO É UM SÓ (issue #3095).
 *
 * A captação por webhook dizia "Texto", "Link" e "Sim/Não"; os Funis diziam
 * "Texto curto", "Link (URL)" e "Sim ou não". Quem cadastrava pela captação e
 * abria o campo nos Funis via dois nomes para o mesmo tipo. As duas telas leem
 * este mapa — e os testes de componente de cada uma exigem a mesma grafia.
 */
describe("rótulos dos tipos de campo", () => {
  it("o mapa cobre TODO tipo do schema, e nenhum rótulo é o nome técnico", () => {
    const doSchema = [...customFieldSchema.shape.type.options].sort();
    expect(Object.keys(ROTULOS_DO_TIPO).sort()).toEqual(doSchema);

    for (const tipo of doSchema) {
      const rotulo = ROTULOS_DO_TIPO[tipo];
      expect(rotulo.trim().length, `rótulo vazio para ${tipo}`).toBeGreaterThan(0);
      expect(rotulo, `${tipo} continua com nome técnico`).not.toBe(tipo);
    }
  });

  it("cada tipo tem um rótulo distinto — dois tipos não podem parecer o mesmo", () => {
    const rotulos = Object.values(ROTULOS_DO_TIPO);
    expect(new Set(rotulos).size).toBe(rotulos.length);
  });

  it("a função entrega ao `t()` a MESMA chave do mapa", () => {
    for (const [tipo, rotulo] of Object.entries(ROTULOS_DO_TIPO)) {
      const visto: string[] = [];
      const traduzido = rotuloDoTipo(tipo as keyof typeof ROTULOS_DO_TIPO, (texto) => {
        visto.push(texto);
        return `es:${texto}`;
      });
      expect(visto).toEqual([rotulo]);
      expect(traduzido).toBe(`es:${rotulo}`);
    }
  });
});
