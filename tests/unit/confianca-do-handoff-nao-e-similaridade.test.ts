/**
 * AUSÊNCIA DE CITAÇÃO NÃO É CONFIANÇA ZERO.
 *
 * O gate G3 escala a conversa para um humano quando "o bot está inseguro". O número
 * que ele lia como confiança era `response.citations[0]?.similarity ?? 0` — a
 * similaridade de cosseno do primeiro trecho de RAG recuperado.
 *
 * Duas coisas diferentes estavam coladas nesse `?? 0`:
 *
 *   1. similaridade BAIXA  → "achei material, e ele é ruim"      → sinal legítimo
 *   2. similaridade AUSENTE → "não houve busca / nada recuperado" → NÃO é sinal
 *
 * O `?? 0` transformava (2) em (1), e como qualquer limiar plausível é maior que
 * zero, TODA resposta sem citação escalava para humano. Um "bom dia, tudo bem?"
 * respondido perfeitamente, sem consultar base nenhuma, acionava o gate.
 *
 * É o mesmo raciocínio que `lib/leads/score-writer.ts` já aplica ao score do lead —
 * "zero é uma afirmação" — e que `lib/leads/classificacao-inicial.ts` encarna com o
 * valor `nao_avaliado`: o honesto, quando não se mediu, é dizer que não se mediu.
 *
 * O primeiro caso mede o PREDICADO; o último varre o FONTE do worker, porque o
 * predicado pode ficar verde para sempre enquanto o chamador volta a injetar zero.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { checkG3 } from "@/lib/ai/handoff/triggers";

const TEXTO_SEGURO = "Bom dia! Nosso horário de atendimento é das 9h às 18h.";
const TEXTO_INSEGURO = "Não tenho certeza, preciso verificar isso com a equipe.";

describe("G3 — confiança ausente não é confiança baixa", () => {
  it("resposta SEM citação e sem marcador de incerteza NÃO escala", () => {
    expect(
      checkG3({ confidence: null, outputText: TEXTO_SEGURO, threshold: 0.5 }),
      "sem citação não há medição de similaridade — escalar aqui é o defeito",
    ).toBe(false);
  });

  it("resposta SEM citação MAS com marcador de incerteza escala", () => {
    expect(
      checkG3({ confidence: null, outputText: TEXTO_INSEGURO, threshold: 0.5 }),
      "o outro braço do gate continua vivo: o texto ainda denuncia insegurança",
    ).toBe(true);
  });

  it("citação de similaridade BAIXA continua escalando", () => {
    expect(
      checkG3({ confidence: 0.2, outputText: TEXTO_SEGURO, threshold: 0.5 }),
      "quando HÁ medição e ela é ruim, o sinal é legítimo e não pode ter sido desligado",
    ).toBe(true);
  });

  it("citação de similaridade ALTA não escala", () => {
    expect(checkG3({ confidence: 0.9, outputText: TEXTO_SEGURO, threshold: 0.5 })).toBe(false);
  });

  it("texto hesitante escala MESMO com similaridade alta", () => {
    // Este caso não existe por simetria: ele é o que defende o `||` do gate.
    // Quem trocar por `&&` — o que o cabeçalho do arquivo prometia até 2026-09-20 —
    // deixa passar exatamente isto: o agente se declarando inseguro apoiado em
    // material de boa similaridade. Sem este teste, o refactor não encontra
    // resistência nenhuma.
    expect(checkG3({ confidence: 0.95, outputText: TEXTO_INSEGURO, threshold: 0.5 })).toBe(true);
  });

  it("o worker não converte citação ausente em zero", () => {
    const fonte = readFileSync(
      path.join(process.cwd(), "workers/ai-response-worker.ts"),
      "utf8",
    );
    const atribuicao = fonte
      .split("\n")
      .find((l) => l.includes("citations[0]") && l.includes("similarity"));

    expect(atribuicao, "a atribuição da confiança sumiu — este teste perdeu o alvo").toBeDefined();
    expect(
      atribuicao,
      "`?? 0` aqui reintroduz o defeito: ausência de medição vira a pior nota possível",
    ).not.toMatch(/\?\?\s*0/);
  });
});

describe("a classe inteira: ausência de medição não vira zero nos caminhos de IA", () => {
  /**
   * A doutrina já existia e tinha cerca — só não alcançava a IA.
   * `lib/kanban/card-state.ts`: "null é 'sinal insuficiente' e 0 é 'calculei e
   * deu zero' (…) quem usar `?? 0` inventa score onde não há", guardada por
   * `tests/unit/card-score.test.ts`. Esta varredura estende a mesma regra aos
   * diretórios de IA, para que o PRÓXIMO sítio reprove sozinho em vez de
   * esperar alguém tropeçar nele.
   */
  // `app/app/ai` entrou depois do resto, e entrou por mérito: sem ele, a cerca
  // não alcançava as TELAS de IA — e a primeira ocorrência nova do padrão no
  // repo apareceu exatamente ali, escrita dentro do PR que existe para extingui-lo
  // (um `(result.confidence ?? 0)` num render inalcançável). Cerca que não cobre
  // onde o código de fato é escrito reprova só o que já foi consertado.
  const DIRETORIOS = ["lib/ai", "lib/agent-engine", "workers", "app/api/v1/ai", "hooks/ai", "app/app/ai"];
  const VOCABULARIO = /(confidence|confianca|confiança|similarity|similaridade|probability|probabilidade|score)/i;
  const INVENTA_ZERO = /\?\?\s*0(?![0-9.])/;

  /**
   * Linha de COMENTÁRIO não é código — e ignorá-la não é conveniência, é
   * correção: a primeira execução desta cerca reprovou no comentário que
   * explica por que o `?? 0` saiu dali ("`?? null`, nunca `?? 0`"). A frase que
   * documenta a ausência contém o literal procurado, e uma sonda que conta o
   * próprio aviso mede a palavra em vez do comportamento.
   *
   * Código comentado também é ignorado, e está certo: código que não executa
   * não inventa score nenhum.
   */
  const ehComentario = (linha: string): boolean => /^\s*(\/\/|\*|\/\*)/.test(linha);

  function arquivosDe(dir: string): string[] {
    const raiz = path.join(process.cwd(), dir);
    if (!existsSync(raiz)) return [];
    const achados: string[] = [];
    for (const entrada of readdirSync(raiz, { withFileTypes: true, recursive: true })) {
      if (!entrada.isFile()) continue;
      if (!/\.(ts|tsx)$/.test(entrada.name) || /\.test\.tsx?$/.test(entrada.name)) continue;
      achados.push(path.join(entrada.parentPath ?? raiz, entrada.name));
    }
    return achados;
  }

  const arquivos = DIRETORIOS.flatMap(arquivosDe);

  it("a varredura enxerga os arquivos (controle positivo)", () => {
    // Sem este caso, um `readdir` que devolvesse vazio faria a cerca passar
    // para sempre — e o zero seria indistinguível de "nada a reprovar".
    expect(arquivos.length, "a varredura não encontrou arquivo nenhum — sonda morta").toBeGreaterThan(50);
    expect(
      arquivos.some((f) => f.endsWith("workers/ai-response-worker.ts")),
      "o arquivo que originou esta cerca precisa estar no conjunto varrido",
    ).toBe(true);
  });

  it("nenhum caminho de IA converte confiança ausente em zero", () => {
    const infratores: string[] = [];
    for (const arquivo of arquivos) {
      const linhas = readFileSync(arquivo, "utf8").split("\n");
      linhas.forEach((linha, i) => {
        if (!ehComentario(linha) && VOCABULARIO.test(linha) && INVENTA_ZERO.test(linha)) {
          infratores.push(`${path.relative(process.cwd(), arquivo)}:${i + 1}  ${linha.trim()}`);
        }
      });
    }
    expect(
      infratores,
      "`?? 0` sobre confiança/score inventa medição onde não houve — use `?? null` " +
        "(doutrina em lib/kanban/card-state.ts). Se o zero for legítimo aqui, " +
        "escreva o porquê na linha e ajuste esta cerca conscientemente.",
    ).toEqual([]);
  });
});
