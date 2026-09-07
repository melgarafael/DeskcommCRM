/**
 * O REGISTRO DE PONTOS DE IA E O CÓDIGO QUE CHAMA MODELO SÃO A MESMA LISTA.
 *
 * `lib/ai/pontos/registro.ts` é o que a tela de provedores oferece para o dono
 * do negócio configurar. O código é quem de fato chama modelo. São duas listas
 * que precisam concordar, e este repo já tem cicatriz do eixo: catálogo de
 * modelo vs. tabela de preço divergindo em silêncio
 * (`tests/invariants/catalogo-de-modelos.test.ts`).
 *
 * Aqui o sintoma da divergência é pior que caro — é MUDO nos dois sentidos:
 *
 *  - Ponto no código e FORA do registro: a tela não o mostra, ninguém consegue
 *    configurá-lo, e ele segue chamando o provedor default. É exatamente o
 *    estado que motivou esta frente ("pontos ocultos que usam IA e não
 *    conseguimos determinar nem configurar").
 *  - Ponto no registro e FORA do código: a tela oferece um botão que não
 *    controla nada. O operador configura, salva, e o comportamento não muda.
 *    Pior que a ausência: gasta a confiança dele numa tela que mente.
 *
 * A varredura lê o CÓDIGO-FONTE, não uma lista paralela — uma lista paralela
 * teria o mesmo problema que ela existe para pegar.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

import { describe, expect, it } from "vitest";

import {
  PONTOS_DE_IA,
  pontosPorPapel,
  type PontoDeIa,
} from "@/lib/ai/pontos/registro";

import { arquivosDeCodigo, RAIZ_DO_REPO } from "./helpers/varrer-codigo";

/** Literal values emitted by object properties, including both branches of a conditional.
 * Type declarations, comments and string contents cannot manufacture a call site. */
function purposesDoTexto(texto: string, arquivo = "source.ts"): string[] {
  const ast = ts.createSourceFile(arquivo, texto, ts.ScriptTarget.Latest, true, arquivo.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const result: string[] = [];
  const literals = (node: ts.Expression): string[] => {
    if (ts.isStringLiteralLike(node)) return [node.text];
    if (ts.isConditionalExpression(node)) return [...literals(node.whenTrue), ...literals(node.whenFalse)];
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)) return literals(node.expression);
    return [];
  };
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAssignment(node) && node.name.getText(ast).replace(/["']/g, "") === "purpose") {
      // NodeResult do follow-up é comando para fila, não ponto de chamada LLM.
      // A distinção vem da forma discriminada retornada, nunca de uma lista
      // de purposes ignorados (que esconderia um LLM homônimo real).
      const object = node.parent;
      const enqueueResult = ts.isObjectLiteralExpression(object) && ts.isReturnStatement(object.parent) &&
        object.properties.some(p => ts.isPropertyAssignment(p) && p.name.getText(ast) === "kind" &&
          ts.isStringLiteralLike(p.initializer) && p.initializer.text === "enqueue_turn");
      if (!enqueueResult) result.push(...literals(node.initializer));
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return result;
}
function purposesEmitidosNoCodigo(): Map<string, string[]> {
  const encontrados = new Map<string, string[]>();
  for (const arquivo of arquivosDeCodigo(["lib", "workers", "app"])) {
    for (const purpose of purposesDoTexto(readFileSync(arquivo, "utf8"), arquivo)) {
      const lista = encontrados.get(purpose) ?? [];
      lista.push(path.relative(RAIZ_DO_REPO, arquivo));
      encontrados.set(purpose, lista);
    }
  }
  return encontrados;
}

/**
 * Pontos que NÃO passam pelo seam e por isso não têm `purpose:` no código —
 * cada um com o arquivo que o emite, para a varredura poder provar que ele
 * continua existindo. Sem esta prova, apagar o chamador deixaria o ponto
 * órfão no registro sem nenhum teste reclamar.
 */
const FORA_DO_SEAM: Record<string, { arquivo: string; marcador: string }> = {
  // O marcador mudou de `resolveLanguageModel` para `resolverModeloDoPonto`
  // quando estes dois passaram a honrar o painel de provedores. O teste pegou a
  // troca, que é o comportamento pretendido: o marcador existe para que apagar
  // o chamador reprove aqui, e trocá-lo obriga a confirmar que o ponto continua
  // vivo — não que ele continua sendo chamado do mesmo jeito.
  sentiment_classify: {
    arquivo: "workers/ai-sentiment-worker.ts",
    marcador: "resolverModeloDoPonto",
  },
  bot_respond: {
    arquivo: "workers/ai-response-worker.ts",
    marcador: "resolverModeloDoPonto",
  },
  embedding_indexar: { arquivo: "lib/ai/embed.ts", marcador: "embed(" },
  embedding_consultar: {
    arquivo: "lib/agent-engine/edge/llm/embed.ts",
    marcador: "/v1/embeddings",
  },
  visao_de_imagem: {
    arquivo: "workers/media-derive-worker.ts",
    marcador: "describeImage",
  },
  transcricao_de_audio: {
    arquivo: "lib/messaging/media/transcription.ts",
    marcador: "/v1/audio/transcriptions",
  },
  contagem_de_tokens: {
    arquivo: "lib/agent-engine/edge/llm/count-tokens.ts",
    marcador: "count_tokens",
  },
  teste_de_agente: {
    arquivo: "lib/ai/runtime/agent.ts",
    marcador: "buildModel",
  },
};

describe("registro de pontos de IA × código", () => {
  const emitidos = purposesEmitidosNoCodigo();
  it("instrumento lê os dois ramos e aspas distintas sem contar tipos/comentários", () => {
    expect(purposesDoTexto(`
      type Input = { purpose: 'nao_emitido' };
      // purpose: 'comentario'
      const a = { purpose: preview ? "agent_preview" : 'agent_turn' };
    `)).toEqual(["agent_preview", "agent_turn"]);
    expect(purposesDoTexto(`const a = { purpose: preview ? 'ponto_orfao' : 'agent_turn' };`)).toContain("ponto_orfao");
    expect(purposesDoTexto(`const a = { purpose: payload.purpose };`)).toEqual([]);
    expect(purposesDoTexto(`function queue() { return { kind: "enqueue_turn", purpose: "send_message" }; }`)).toEqual([]);
    expect(purposesDoTexto(`runModelCall(db, cfg, { purpose: "send_message" });`)).toEqual(["send_message"]);
  });

  it("a varredura enxerga o código (controle positivo)", () => {
    // Instrumento quebrado devolve zero, e zero é indistinguível de "tudo em
    // ordem" nos dois testes abaixo — ambos passariam com a varredura morta.
    // `agent_turn` é o ponto mais central do produto: se ele sumiu da
    // varredura, foi a varredura que quebrou, não o código.
    expect(emitidos.size).toBeGreaterThan(10);
    expect(emitidos.get("agent_turn")).toBeDefined();
    expect(arquivosDeCodigo(["lib"]).length).toBeGreaterThan(200);
  });

  it("todo purpose emitido no código está no registro", () => {
    const registrados = new Set(PONTOS_DE_IA.map((p) => p.id));

    const orfaos = [...emitidos.entries()]
      .filter(([purpose]) => !registrados.has(purpose))
      .map(([purpose, arquivos]) => `${purpose} (emitido em ${arquivos.join(", ")})`);

    expect(
      orfaos,
      "purpose que o código emite mas a tela de provedores não mostra — " +
        "ponto oculto, que é justamente o que este registro existe para acabar",
    ).toEqual([]);
  });

  it("todo ponto do registro é emitido por algum código", () => {

    const fantasmas: string[] = [];
    for (const ponto of PONTOS_DE_IA) {
      if (emitidos.has(ponto.id)) continue;

      const foraDoSeam = FORA_DO_SEAM[ponto.id];
      if (foraDoSeam === undefined) {
        fantasmas.push(`${ponto.id} (nem purpose no código, nem entrada em FORA_DO_SEAM)`);
        continue;
      }
      const fonte = readFileSync(path.join(RAIZ_DO_REPO, foraDoSeam.arquivo), "utf8");
      if (!fonte.includes(foraDoSeam.marcador)) {
        fantasmas.push(
          `${ponto.id} (${foraDoSeam.arquivo} não contém mais "${foraDoSeam.marcador}")`,
        );
      }
    }

    expect(
      fantasmas,
      "ponto que a tela oferece mas nenhum código executa — botão que não " +
        "controla nada é pior que botão ausente",
    ).toEqual([]);
  });
});

describe("forma de cada ponto", () => {
  const naoVazio = (v: string) => v.trim().length > 0;

  it("todo ponto tem rótulo, descrição e sintoma de falha preenchidos", () => {
    const incompletos = PONTOS_DE_IA.filter(
      (p) => !naoVazio(p.rotulo) || !naoVazio(p.oQueFaz) || !naoVazio(p.sintomaDeFalha),
    ).map((p) => p.id);
    expect(incompletos).toEqual([]);
  });

  it("o sintoma de falha descreve o que o USUÁRIO vê, não o erro técnico", () => {
    // A tela de logs existe para responder "por que falhou" a quem não lê
    // stack trace. Um sintoma escrito em jargão devolve o problema original.
    const jargao = /\b(401|403|404|429|500|HTTP|null|undefined|exception|stack|timeout)\b/i;
    const tecnicos = PONTOS_DE_IA.filter((p) => jargao.test(p.sintomaDeFalha)).map(
      (p) => `${p.id}: "${p.sintomaDeFalha}"`,
    );
    expect(tecnicos).toEqual([]);
  });

  it("ponto fixo por arquitetura declara a razão por escrito", () => {
    // Sem razão escrita, a tela mostra um cadeado sem explicação — e o
    // operador conclui que o produto é limitado, em vez de entender que
    // trocar o modelo de embedding quebraria o recall em silêncio.
    const semRazao = PONTOS_DE_IA.filter(
      (p) => p.fixo !== undefined && !naoVazio(p.fixo.razao),
    ).map((p) => p.id);
    expect(semRazao).toEqual([]);
  });

  it("id e rótulo são únicos", () => {
    const ids = PONTOS_DE_IA.map((p) => p.id);
    const rotulos = PONTOS_DE_IA.map((p) => p.rotulo);
    expect(new Set(ids).size, "id duplicado").toBe(ids.length);
    expect(new Set(rotulos).size, "rótulo duplicado confunde na tela").toBe(rotulos.length);
  });
});

describe("capacidade exigida", () => {
  const porId = (id: string): PontoDeIa => {
    const p = PONTOS_DE_IA.find((x) => x.id === id);
    if (p === undefined) throw new Error(`ponto ausente do registro: ${id}`);
    return p;
  };

  it("os pontos que passam ToolSet ao seam exigem tools", () => {
    // Um modelo sem tool calling escolhido para estes pontos não cria lead,
    // não move o funil e não escala para humano — e o turno morre sem erro na
    // tela. É o defeito que o painel precisa tornar impossível de configurar.
    expect(porId("agent_turn").exige.tools).toBe(true);
    expect(porId("operator_turn").exige.tools).toBe(true);
  });

  it("os pontos de embedding declaram a dimensão do contrato", () => {
    // 1536 é pin de contrato: indexador e consulta precisam do MESMO modelo,
    // senão os vetores deixam de ser comparáveis e o recall morre em silêncio.
    expect(porId("embedding_indexar").exige.embeddingDims).toBe(1536);
    expect(porId("embedding_consultar").exige.embeddingDims).toBe(1536);
  });

  it("os pontos que leem mídia declaram a modalidade", () => {
    expect(porId("visao_de_imagem").exige.imagem).toBe(true);
    expect(porId("transcricao_de_audio").exige.audio).toBe(true);
  });

  it("classificador barato não exige tools", () => {
    // O contrário do teste acima: marcar tools onde não precisa encarece a
    // conta do cliente sem motivo, porque a tela filtraria os modelos baratos.
    for (const id of ["stage_classifier", "jailbreak_detect", "promise_semantic"]) {
      expect(porId(id).exige.tools ?? false, `${id} não deveria exigir tools`).toBe(false);
    }
  });
});

describe("agrupamento por papel", () => {
  it("todo ponto configurável cai em algum papel da tela", () => {
    const agrupado = pontosPorPapel();
    const noAgrupamento = new Set(
      Object.values(agrupado).flatMap((ps) => ps.map((p) => p.id)),
    );
    const foraDaTela = PONTOS_DE_IA.filter((p) => !noAgrupamento.has(p.id)).map((p) => p.id);
    expect(foraDaTela, "ponto sem papel não aparece na tela agrupada").toEqual([]);
  });

  it("nenhum papel nasce vazio", () => {
    // Papel vazio vira uma seção em branco na tela — ruído que ensina o
    // operador a ignorar o painel.
    const vazios = Object.entries(pontosPorPapel())
      .filter(([, ps]) => ps.length === 0)
      .map(([papel]) => papel);
    expect(vazios).toEqual([]);
  });
});
