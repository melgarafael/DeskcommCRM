import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/**
 * A tela de Agentes de IA diz "agente", não "agent" (#2997).
 *
 * É a sonda da própria issue — `git grep -niE '(t|traduzir)\("[^"]*agents?[ ".,]'
 * -- app/app/ai/agents` — sobre a pasta inteira, e não uma lista de frases: a
 * próxima frase em inglês que alguém escrever reprova aqui, não só as que a
 * issue enumerou. Arquivos de teste ficam de fora (`it("mcp_agent …")` casa o
 * `t(` do `it(` e não é texto de tela).
 */
const RAIZ = resolve(__dirname, "../..");
const PASTA = join(RAIZ, "app/app/ai/agents");
const FRASE_EM_INGLES = /(t|traduzir)\("[^"]*agents?[ ".,]/i;

function arquivosDaTela(pasta: string): string[] {
  return readdirSync(pasta, { withFileTypes: true }).flatMap((e) => {
    const caminho = join(pasta, e.name);
    if (e.isDirectory()) return arquivosDaTela(caminho);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [caminho] : [];
  });
}

describe("Agentes de IA: o texto da tela diz agente", () => {
  const arquivos = arquivosDaTela(PASTA);

  it("a varredura alcança a tela (guarda contra sonda vazia)", () => {
    expect(arquivos.map((a) => relative(PASTA, a))).toEqual(
      expect.arrayContaining(["_components/AgentRowMenu.tsx", "[id]/_components/AgentForm.tsx"]),
    );
  });

  it('nenhum t("…agent…") sobra na pasta', () => {
    const sobras = arquivos.flatMap((arquivo) =>
      readFileSync(arquivo, "utf-8")
        .split("\n")
        .flatMap((linha, i) =>
          FRASE_EM_INGLES.test(linha) ? [`${relative(RAIZ, arquivo)}:${i + 1}: ${linha.trim()}`] : [],
        ),
    );
    expect(sobras).toEqual([]);
  });
});
