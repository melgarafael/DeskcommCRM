/**
 * A VERSÃO DA GRAPH API TEM UM LUGAR SÓ — e esta é a catraca que cobra isso.
 *
 * O defeito que ela guarda não é o literal solto: é o segundo literal. A versão
 * estava escrita à mão em dez arquivos de produção, todos com o mesmo `"v22.0"`.
 * No dia do bump, quem sobe a versão edita nove e esquece um — e o esquecido
 * responde com a versão antiga. A instalação passa a falar duas versões da mesma
 * plataforma, e o sintoma aparece longe da causa ("o template aprovado não
 * envia" numa tela, o modelo sumindo em outra).
 *
 * A catraca é do tipo que o repositório já usa (`fila-tem-uma-definicao-so`,
 * `schema` do fluxo): nenhuma infraestrutura nova, só leitura de arquivo e uma
 * varredura. Ela olha CÓDIGO, não texto:
 *
 * - comentário que cita a versão **medida** não reprova. `template-sync.ts`
 *   registra que a Meta reescreveu o `next` para `v25.0` ao ser chamada em
 *   `v22.0`; isso é história medida, e história não se conserta movendo para
 *   dentro de uma constante.
 * - fixture de teste não reprova — o alvo é código de produção, que é o que
 *   chama a Graph valendo. O preço é um teste que esconda o literal; o preço do
 *   contrário (docs e changelog reprovando) é a catraca virar ruído e alguém
 *   desligá-la.
 *
 * Ver `lib/graph-version.ts` — inclusive sobre a versão NÃO ter subido aqui.
 */
import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { VERSAO_PADRAO_DA_GRAPH, graphVersion } from "@/lib/graph-version";

const RAIZ = path.join(__dirname, "..", "..");

/** O único arquivo de produção que pode escrever a versão à mão. */
const MODULO_UNICO = path.join("lib", "graph-version.ts");

/** Onde mora código que chama a Graph valendo. */
const ONDE_PROCURAR = ["app", "lib", "components", "hooks", "workers", "scripts"];

const PASTAS_IGNORADAS = new Set([
  "node_modules",
  ".git",
  ".next",
  "test-results",
  "playwright-report",
]);

const CODIGO = /\.(ts|tsx|mjs|js)$/;

/** Literal de versão da Graph: `"v22.0"`, `'v26.0'`, `` `v23.0` ``. */
const LITERAL_DE_VERSAO = /["'`]v\d+\.\d+["'`]/;

/**
 * Tira comentário antes de varrer. Sem isto, a catraca reprovaria o próprio
 * arquivo que documenta a versão medida — e uma catraca que reprova documentação
 * é uma catraca que ensina a apagar documentação.
 */
function semComentarios(fonte: string): string {
  return fonte
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/([^:"'`\\])\/\/.*$/gm, "$1");
}

function varrer(diretorio: string, achados: string[] = []): string[] {
  for (const entrada of fs.readdirSync(diretorio, { withFileTypes: true })) {
    const caminho = path.join(diretorio, entrada.name);
    if (entrada.isDirectory()) {
      if (PASTAS_IGNORADAS.has(entrada.name)) continue;
      varrer(caminho, achados);
      continue;
    }
    if (!CODIGO.test(entrada.name)) continue;
    // Fixture de teste não reprova: o alvo é código de produção.
    if (/\.(test|spec)\./.test(entrada.name)) continue;
    achados.push(caminho);
  }
  return achados;
}

const ARQUIVOS = ONDE_PROCURAR.flatMap((pasta) => varrer(path.join(RAIZ, pasta)));

function culpados(): string[] {
  return ARQUIVOS.filter((caminho) => {
    const relativo = path.relative(RAIZ, caminho);
    if (relativo === MODULO_UNICO) return false;
    const fonte = semComentarios(fs.readFileSync(caminho, "utf8"));
    return fonte.split("\n").some((linha) => LITERAL_DE_VERSAO.test(linha));
  }).map((caminho) => path.relative(RAIZ, caminho));
}

describe("a versão da Graph tem um lugar só", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("nenhum arquivo de produção escreve a versão da Graph à mão", () => {
    // Controle da própria catraca: se a varredura quebrar (pasta renomeada,
    // sufixo novo), a lista volta vazia e o teste passaria medindo nada. É a
    // falha-em-verde que este repositório trata como o pior defeito.
    expect(ARQUIVOS.length).toBeGreaterThan(1000);
    expect(ARQUIVOS.map((c) => path.relative(RAIZ, c))).toContain(MODULO_UNICO);

    expect(culpados()).toEqual([]);
  });

  it("o módulo único declara a versão — a catraca não passa com o arquivo apagado", () => {
    const fonte = semComentarios(fs.readFileSync(path.join(RAIZ, MODULO_UNICO), "utf8"));
    const literais = fonte
      .split("\n")
      .filter((linha) => LITERAL_DE_VERSAO.test(linha))
      .map((linha) => linha.trim().match(LITERAL_DE_VERSAO)![0].slice(1, -1));

    expect(literais).toEqual([VERSAO_PADRAO_DA_GRAPH]);
  });

  it("o .env.example não anuncia versão diferente da que o código usa", () => {
    // O default é documentado em dois lugares: aqui e no `.env.example`. Se o
    // número subir num só, quem instala lê uma versão e o código fala outra.
    // Ausente ou vazio passa (o default do código vale); número diferente, não.
    const exemplo = fs.readFileSync(path.join(RAIZ, ".env.example"), "utf8");
    const linha = exemplo.split("\n").find((l) => /^META_GRAPH_VERSION=/.test(l));

    expect(linha).toBeDefined();
    const valor = linha!.slice("META_GRAPH_VERSION=".length).trim();
    if (valor !== "") expect(valor).toBe(VERSAO_PADRAO_DA_GRAPH);
  });

  it("graphVersion() honra META_GRAPH_VERSION e cai no default sem ela", () => {
    vi.stubEnv("META_GRAPH_VERSION", "v23.0");
    expect(graphVersion()).toBe("v23.0");

    vi.stubEnv("META_GRAPH_VERSION", "");
    expect(graphVersion()).toBe(VERSAO_PADRAO_DA_GRAPH);
  });
});
