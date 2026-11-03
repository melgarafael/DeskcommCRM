/**
 * Os ids de ferramenta dos servidores MCP DO AGENTE (migration 9095):
 * `mcp_externo:<servidor_id>:<marca>:<nome>`, ao lado do formato do servidor
 * compartilhado da organização, que não muda de significado.
 */
import { describe, expect, it } from "vitest";

import {
  desmarcarRemota,
  desmarcarServidor,
  marcaDaRemota,
  marcarRemota,
  removerRemotasOrfas,
} from "./escolha-do-editor";
import { escolhasDoServidor, escolhasRemotas, lerToolIdRemoto, servidoresEscolhidos, toolIdAceito, toolIdRemoto } from "./ids";
import { nomeDaFerramentaDeAcesso, nomeParaOModelo, slugDoNome } from "./do-agente/registro";

const S1 = "11111111-0000-4000-8000-000000000001";
const S2 = "22222222-0000-4000-8000-000000000002";

describe("ids com servidor do agente", () => {
  it("ida e volta, e o formato antigo continua sendo do servidor compartilhado", () => {
    expect(lerToolIdRemoto(toolIdRemoto("buscar", "leitura", S1))).toEqual({ nome: "buscar", leitura: true, servidorId: S1 });
    expect(lerToolIdRemoto(toolIdRemoto("buscar", "escrita"))).toEqual({ nome: "buscar", leitura: false });
    expect(lerToolIdRemoto("mcp_externo:nao-uuid:leitura:x")).toBeNull();
    expect(lerToolIdRemoto("mcp_externo:a:b:c:d")).toBeNull();
    expect(toolIdAceito(toolIdRemoto("x", "leitura", S1), new Set())).toBe(true);
  });

  it("o mesmo nome em servidores diferentes são escolhas diferentes, e o compartilhado não as vê", () => {
    const ids = [toolIdRemoto("buscar", "leitura", S1), toolIdRemoto("buscar", "escrita", S2), toolIdRemoto("buscar", "leitura")];
    expect(escolhasDoServidor(ids, S1)).toEqual([{ nome: "buscar", leitura: true, servidorId: S1 }]);
    expect(escolhasDoServidor(ids, S2)).toEqual([{ nome: "buscar", leitura: false, servidorId: S2 }]);
    expect(escolhasRemotas(ids)).toEqual([{ nome: "buscar", leitura: true }]);
    expect([...servidoresEscolhidos(ids)].sort()).toEqual([S1, S2]);
  });

  it("marcar/desmarcar num servidor não toca as escolhas de outro nem do compartilhado", () => {
    const ids = [toolIdRemoto("buscar", "leitura"), toolIdRemoto("buscar", "leitura", S2), "crm_search_products"];
    const marcado = marcarRemota(ids, "buscar", "escrita", S1);
    expect(marcaDaRemota(marcado, "buscar", S1)).toBe("escrita");
    expect(marcaDaRemota(marcado, "buscar", S2)).toBe("leitura");
    expect(marcaDaRemota(marcado, "buscar")).toBe("leitura");
    expect(desmarcarRemota(marcado, "buscar", S1)).toEqual(ids);
    expect(desmarcarServidor(marcado, S2)).toEqual([toolIdRemoto("buscar", "leitura"), "crm_search_products", toolIdRemoto("buscar", "escrita", S1)]);
    // As órfãs do compartilhado nunca levam escolha de servidor do agente.
    expect(removerRemotasOrfas(marcado, [])).toEqual([toolIdRemoto("buscar", "leitura", S2), "crm_search_products", toolIdRemoto("buscar", "escrita", S1)]);
  });

  it("nomes que o modelo vê: namespaced, dentro do protocolo, e a ferramenta de acesso", () => {
    expect(slugDoNome("Minha Casa — Ação!")).toBe("minhacasaacao");
    expect(slugDoNome("!!!")).toBe("mcp");
    expect(nomeParaOModelo("casa", "ligar_luz")).toBe("casa__ligar_luz");
    expect(nomeParaOModelo("casa", "x".repeat(60))).toBeNull();
    expect(nomeDaFerramentaDeAcesso("casa")).toBe("solicitar_acesso_casa");
  });
});
