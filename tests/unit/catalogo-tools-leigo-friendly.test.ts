/**
 * GATE DO PILAR 3 — o catalogo de tools fala com quem NAO programa.
 *
 * Quem configura um agente no SonghaiCRM e dono de clinica, de loja, de
 * imobiliaria. Sem este teste a regra apodrece na primeira pressa: alguem
 * adiciona a tool com `rotulo: "crm_archive_lead"` as 23h e ninguem percebe.
 *
 * O gate e MECANICO de proposito. Um bloco de comentario no topo do arquivo
 * dizendo "segui a doutrina" passa no typecheck e no lint com texto falso
 * dentro — nao e gate, e decoracao.
 *
 * Este teste tambem cobre a COERENCIA entre a categoria tecnica (que dirige
 * scope/role no servidor) e o risco mostrado ao humano: uma tool de leitura
 * anunciada como "altera dados" mente para quem configura, e uma tool de
 * escrita anunciada como "so consulta" mente pior ainda.
 */
import { describe, expect, it } from "vitest";

import { TOOL_CATALOG } from "@/lib/mcp/tools/catalog";
import { PACOTES, RISCOS, type ToolBundle } from "@/lib/mcp/tools/pacotes";

/**
 * Jargao que o publico-alvo nao entende. Word-boundary de proposito: "api"
 * solto e jargao, mas "rapidamente" contem as mesmas letras e e portugues.
 */
const JARGAO_PROIBIDO = [
  "mcp",
  "api",
  "endpoint",
  "payload",
  "uuid",
  "schema",
  "query",
  "webhook",
  "enrollment",
  "pointer",
  "handoff",
  "pipeline",
  "stage",
  "lead",
  "tag",
  "backend",
  "json",
  "crud",
];

const PACOTES_VALIDOS = new Set<string>(PACOTES.map((p) => p.id));
const RISCOS_VALIDOS = new Set<string>(RISCOS.map((r) => r.id));

function contemJargao(texto: string): string[] {
  const baixo = texto.toLowerCase();
  return JARGAO_PROIBIDO.filter((termo) =>
    new RegExp(`\\b${termo}s?\\b`, "i").test(baixo),
  );
}

describe("catalogo de tools — linguagem de quem configura", () => {
  it("tem pelo menos uma tool (guarda de vacuidade)", () => {
    // Sem isto, esvaziar o catalogo faria TODOS os testes abaixo passarem
    // vacuamente — verde por ausencia de dado, o pior falso verde que existe.
    expect(TOOL_CATALOG.length).toBeGreaterThan(0);
  });

  it.each(TOOL_CATALOG.map((t) => [t.name, t] as const))(
    "%s tem rotulo em portugues de gente",
    (_name, tool) => {
      expect(tool.rotulo.trim()).not.toBe("");
      expect(tool.rotulo.length).toBeLessThanOrEqual(60);
      // Identificador tecnico vazado no rotulo.
      expect(tool.rotulo).not.toContain("_");
      expect(tool.rotulo.toLowerCase()).not.toContain(tool.name.toLowerCase());
      expect(contemJargao(tool.rotulo)).toEqual([]);
      // Rotulo e frase, comeca com maiuscula.
      expect(tool.rotulo[0]).toBe(tool.rotulo[0]?.toUpperCase());
    },
  );

  it.each(TOOL_CATALOG.map((t) => [t.name, t] as const))(
    "%s explica o efeito, nao o codigo",
    (_name, tool) => {
      expect(tool.explicacao.trim().length).toBeGreaterThanOrEqual(40);
      expect(tool.explicacao.trim().endsWith(".")).toBe(true);
      expect(tool.explicacao).not.toContain("_");
      expect(contemJargao(tool.explicacao)).toEqual([]);
    },
  );

  it.each(TOOL_CATALOG.map((t) => [t.name, t] as const))(
    "%s declara o que toca, o risco e ao menos um pacote",
    (_name, tool) => {
      expect(tool.oQueToca.trim()).not.toBe("");
      expect(contemJargao(tool.oQueToca)).toEqual([]);
      expect(RISCOS_VALIDOS.has(tool.risco)).toBe(true);
      expect(tool.pacotes.length).toBeGreaterThanOrEqual(1);
      for (const p of tool.pacotes) {
        expect(PACOTES_VALIDOS.has(p)).toBe(true);
      }
    },
  );

  it("o risco anunciado ao humano bate com a categoria tecnica", () => {
    const mentiras: string[] = [];
    for (const tool of TOOL_CATALOG) {
      if (tool.category === "read" && tool.risco !== "seguro") {
        mentiras.push(`${tool.name}: so le, mas anuncia risco "${tool.risco}"`);
      }
      if (tool.category === "write" && tool.risco === "seguro") {
        mentiras.push(`${tool.name}: escreve, mas anuncia "so consulta"`);
      }
    }
    expect(mentiras).toEqual([]);
  });

  it("nao ha dois dominios declarando o mesmo name", () => {
    // Com times entregando capacidades em paralelo, dois arquivos de
    // lib/mcp/tools/catalogo/ podem declarar `crm_archive_lead` cada um. O
    // sintoma seria uma tool sombreando a outra em silencio — o agregador
    // acusa em dev, este teste acusa no CI.
    const vistos = new Set<string>();
    const duplicados: string[] = [];
    for (const tool of TOOL_CATALOG) {
      if (vistos.has(tool.name)) duplicados.push(tool.name);
      vistos.add(tool.name);
    }
    expect(duplicados).toEqual([]);
  });

  it("nao ha dois rotulos iguais (o humano nao consegue distinguir)", () => {
    const vistos = new Map<string, string>();
    const colisoes: string[] = [];
    for (const tool of TOOL_CATALOG) {
      const chave = tool.rotulo.toLowerCase();
      const anterior = vistos.get(chave);
      if (anterior) colisoes.push(`"${tool.rotulo}": ${anterior} e ${tool.name}`);
      else vistos.set(chave, tool.name);
    }
    expect(colisoes).toEqual([]);
  });

  /**
   * Pacote vazio e promessa quebrada: o humano liga "Nao perder o cliente" e o
   * agente nao ganha nada.
   *
   * `reter` SAIU desta lista na wave 2 do epico (pacote preenchido por
   * lib/mcp/tools/catalogo/retencao.ts): agendar, cancelar e listar retorno,
   * radar de risco, encerramento da demanda e proposta de retomada.
   *
   * `evoluir` continua vazio e a divida segue DECLARADA de proposito — nao ha
   * nenhuma capacidade de conhecimento/memoria no catalogo ainda.
   *
   * Ao entregar a wave que preenche o que resta, REMOVA-O desta lista. Deixar o
   * pacote preenchido e a divida declarada aqui e mentir para a proxima pessoa.
   */
  const PACOTES_VAZIOS_CONHECIDOS: ReadonlyArray<ToolBundle> = [];

  it("todo pacote oferecido na tela tem ao menos uma capacidade dentro", () => {
    const usados = new Set<ToolBundle>(TOOL_CATALOG.flatMap((t) => [...t.pacotes]));
    const vazios = PACOTES.filter((p) => !usados.has(p.id)).map((p) => p.id);
    expect(vazios).toEqual([...PACOTES_VAZIOS_CONHECIDOS]);
  });

  it("divida declarada nao esconde pacote ja preenchido", () => {
    // Guarda contra a lista acima envelhecer: se a wave entregou as tools mas
    // ninguem tirou o pacote da divida, este teste reprova.
    const usados = new Set<ToolBundle>(TOOL_CATALOG.flatMap((t) => [...t.pacotes]));
    const jaPreenchidos = PACOTES_VAZIOS_CONHECIDOS.filter((p) => usados.has(p));
    expect(jaPreenchidos).toEqual([]);
  });
});
