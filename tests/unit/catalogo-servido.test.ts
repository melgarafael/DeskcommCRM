/**
 * A tela do humano só existe se as duas metades do catálogo se encontrarem.
 *
 * Metade A: os handlers (`lib/mcp/tools/index.ts`) — o que o servidor sabe
 * executar. Metade B: as entradas de `lib/mcp/tools/catalogo/` — o que o humano
 * lê para decidir. A rota `/api/v1/mcp/tools` junta as duas por `name`.
 *
 * Três waves paralelas estão acrescentando capacidades neste catálogo. O modo
 * de falhar mais provável não é o typecheck — é alguém declarar a entrada e
 * esquecer o handler (ou o contrário). Os dois lados falham em silêncio:
 *   - handler sem entrada  → a tela mostraria a capacidade sem rótulo;
 *   - entrada sem handler  → `tool_ids` aceita o id, o agente é publicado, e o
 *     runtime descarta a capacidade sem avisar ninguém (`pickToolsFromMcp` faz
 *     `if (!def) continue`). O humano vê a capacidade ligada na tela e ela
 *     nunca é oferecida ao modelo.
 */
import { describe, expect, it } from "vitest";

import { allTools } from "@/lib/mcp/tools";
import { TOOL_CATALOG } from "@/lib/mcp/tools/catalog";
import {
  juntarCatalogoComHandlers,
  type HandlerDeclarado,
} from "@/lib/mcp/tools/catalogo-servido";

const HANDLER_FAKE: HandlerDeclarado = {
  name: "crm_fazer_algo",
  description: "faz algo",
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
};

const ENTRADA_FAKE = {
  name: "crm_fazer_algo",
  category: "read" as const,
  description: "faz algo",
  rotulo: "Fazer algo",
  explicacao: "Uma explicação com tamanho suficiente para o humano entender o efeito disto.",
  oQueToca: "Atendimento",
  risco: "seguro" as const,
  pacotes: ["atender" as const],
};

describe("juntar as duas metades do catálogo", () => {
  it("serve a metade do humano em snake_case, junto com a metade do modelo", () => {
    const [servida] = juntarCatalogoComHandlers([HANDLER_FAKE], [ENTRADA_FAKE]);
    expect(servida).toEqual({
      id: "crm_fazer_algo",
      description: "faz algo",
      category: "read",
      requires_role: "agent",
      requires_scope: "mcp:read",
      rotulo: "Fazer algo",
      explicacao: ENTRADA_FAKE.explicacao,
      o_que_toca: "Atendimento",
      risco: "seguro",
      pacotes: ["atender"],
      marcavel: true,
      motivo_nao_marcavel: null,
    });
  });

  it("recusa servir handler sem entrada no catálogo, e diz qual é", () => {
    expect(() => juntarCatalogoComHandlers([HANDLER_FAKE], [])).toThrowError(
      /crm_fazer_algo/,
    );
  });

  it("não inventa capacidade que não tem handler", () => {
    const extra = { ...ENTRADA_FAKE, name: "crm_capacidade_fantasma" };
    const servidas = juntarCatalogoComHandlers([HANDLER_FAKE], [ENTRADA_FAKE, extra]);
    expect(servidas.map((s) => s.id)).toEqual(["crm_fazer_algo"]);
  });
});

describe("catálogo real ↔ handlers reais", () => {
  it("tem capacidades (guarda de vacuidade)", () => {
    expect(allTools.length).toBeGreaterThan(0);
    expect(TOOL_CATALOG.length).toBeGreaterThan(0);
  });

  it("todo handler tem entrada no catálogo — senão a tela mostra id cru", () => {
    const semEntrada = allTools
      .map((t) => t.name)
      .filter((n) => !TOOL_CATALOG.some((e) => e.name === n));
    expect(semEntrada).toEqual([]);
  });

  it("toda entrada do catálogo tem handler — senão o agente ignora a capacidade ligada", () => {
    const semHandler = TOOL_CATALOG.map((e) => e.name).filter(
      (n) => !allTools.some((t) => t.name === n),
    );
    expect(semHandler).toEqual([]);
  });

  it("a junção do catálogo real não lança e serve todas as capacidades", () => {
    const servidas = juntarCatalogoComHandlers(allTools, TOOL_CATALOG);
    expect(servidas).toHaveLength(allTools.length);
    for (const s of servidas) {
      expect(s.rotulo.length, `${s.id} sem rotulo`).toBeGreaterThan(0);
      expect(s.pacotes.length, `${s.id} sem pacote`).toBeGreaterThan(0);
    }
  });

  it("toda capacidade servida tem descrição — e ela vem do HANDLER", () => {
    // Esta guarda faltava, e a falta ficou visível em 2026-08-07: o catálogo
    // tinha uma `description` própria que NENHUM consumidor lia (a ponte do
    // turno monta `def.description`, do handler) e que divergia da real em 48
    // das 51 capacidades. Ela foi removida; o campo do catálogo não existe mais.
    //
    // Sem este caso, esvaziar a descrição de um handler passaria calado: a tela
    // mostraria a capacidade sem explicação técnica e o modelo receberia uma
    // ferramenta sem contrato — dois silêncios de uma vez.
    const servidas = juntarCatalogoComHandlers(allTools, TOOL_CATALOG);
    const porNome = new Map(allTools.map((t) => [t.name, t.description]));
    expect(servidas.length, "nada servido — guarda de vacuidade").toBeGreaterThan(0);
    for (const s of servidas) {
      expect(s.description.trim().length, `${s.id} servido sem descrição`).toBeGreaterThan(0);
      // A IDENTIDADE é o que importa: não basta ter texto, tem de ser o MESMO
      // que chega ao modelo. Se um dia reaparecer uma cópia no catálogo e a
      // junção passar a preferi-la, este caso reprova.
      expect(s.description, `${s.id}: a tela mostra texto diferente do que vai ao modelo`).toBe(
        porNome.get(s.id),
      );
    }
  });
});
