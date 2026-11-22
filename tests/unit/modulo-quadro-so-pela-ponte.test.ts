/**
 * CERCA: a tela do módulo conectado só chega pelo Quadro e pela ponte (Spec 33, F4, tarefa 6).
 *
 * O Quadro (`components/modulo/QuadroDoModulo.tsx`) é o ÚNICO lugar que desenha o iframe de um módulo
 * (sandbox, `referrerPolicy`, `allow` vazio, endereço só com identificadores) e o único que fala
 * a ponte de 6 mensagens (`lib/modulo/ponte.ts`). Esta varredura quebra quando:
 *
 *  - outro arquivo escreve `<iframe` apontando para a origem de um módulo;
 *  - algum `postMessage(` de `components/modulo/` usa "*" como segundo argumento;
 *  - outro arquivo de `components/` importa `lerMensagemDoModulo` ou `mensagemParaOModulo`;
 *  - o Quadro perde um dos atributos fechados do iframe;
 *  - o endereço do serviço ou o id da instalação aparece no `ActiveOrg` (o navegador só leva slug e título).
 *
 * A varredura ignora comentários, como a cerca `token-de-modulo-so-entra-pelo-portao.test.ts`.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const RAIZ = process.cwd();
const QUADRO = "components/modulo/QuadroDoModulo.tsx";

/** Iframes que já existiam e NÃO são de módulo (pré-visualização de anexo PDF do cartão). */
const IFRAMES_QUE_NAO_SAO_DE_MODULO = ["components/kanban/FileUploadCustomField.tsx"];

const PASTAS_IGNORADAS = new Set([
  "node_modules",
  ".next",
  ".git",
  ".claude",
  ".worktrees",
  "coverage",
  "dist",
  "build",
  "evidence",
  "playwright-report",
  "test-results",
]);

function arquivos(pasta: string, saida: string[] = []): string[] {
  for (const d of readdirSync(pasta, { withFileTypes: true })) {
    if (d.isDirectory()) {
      if (!PASTAS_IGNORADAS.has(d.name)) arquivos(join(pasta, d.name), saida);
    } else if (/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(d.name)) {
      saida.push(join(pasta, d.name));
    }
  }
  return saida;
}

const ehTeste = (rel: string) =>
  /\.(test|spec)\.[cm]?[jt]sx?$/.test(rel) || rel.startsWith("tests/") || rel.includes("/__tests__/");

/** Código sem comentário de bloco nem de linha (a menção em texto não conta). */
function codigoSemComentarios(texto: string): string {
  return texto
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/(^|\s)\/\/.*$/, ""))
    .join("\n");
}

function producao(): { rel: string; codigo: string }[] {
  return arquivos(RAIZ)
    .map((f) => relative(RAIZ, f).split(sep).join("/"))
    .filter((rel) => !ehTeste(rel))
    .map((rel) => ({ rel, codigo: codigoSemComentarios(readFileSync(join(RAIZ, rel), "utf8")) }));
}

const IFRAME = /<iframe\b/;
/** `postMessage(<qualquer coisa>, "*")` (aspas simples, duplas ou crase), mesmo em várias linhas. */
const POST_MESSAGE_COM_ASTERISCO = /postMessage\s*\([^;]*,\s*(["'`])\*\1\s*[,)]/;
const USA_A_PONTE = /\b(lerMensagemDoModulo|mensagemParaOModulo)\b/;

describe("a tela do módulo só chega pelo Quadro e pela ponte", () => {
  it("só o Quadro escreve um iframe de módulo", () => {
    const comIframe = producao()
      .filter((a) => IFRAME.test(a.codigo))
      .map((a) => a.rel)
      .sort();
    expect(comIframe).toContain(QUADRO);
    const outros = comIframe.filter((rel) => rel !== QUADRO);
    expect(outros.filter((rel) => !IFRAMES_QUE_NAO_SAO_DE_MODULO.includes(rel))).toEqual([]);
    for (const rel of outros) {
      const codigo = codigoSemComentarios(readFileSync(join(RAIZ, rel), "utf8"));
      expect(codigo, `${rel} não pode apontar para origem de módulo`).not.toMatch(
        /serviceOrigin|service_origin|ModuloNaTela|modulosNaTela/,
      );
    }
  });

  it("nenhum postMessage de components/modulo/ usa '*' como destino", () => {
    const alvos = producao().filter((a) => a.rel.startsWith("components/modulo/"));
    expect(alvos.length).toBeGreaterThan(0);
    for (const a of alvos) {
      expect(a.codigo, a.rel).not.toMatch(POST_MESSAGE_COM_ASTERISCO);
    }
    // o Quadro envia, de fato, com a origem do serviço
    const quadro = alvos.find((a) => a.rel === QUADRO);
    expect(quadro?.codigo).toMatch(/postMessage\([\s\S]*?,\s*modulo\.serviceOrigin\)/);
  });

  it("nenhum outro arquivo de components/ importa a ponte", () => {
    const usam = producao()
      .filter((a) => a.rel.startsWith("components/") && USA_A_PONTE.test(a.codigo))
      .map((a) => a.rel);
    expect(usam).toEqual([QUADRO]);
  });

  it("o Quadro mantém os atributos fechados do iframe", () => {
    const codigo = codigoSemComentarios(readFileSync(join(RAIZ, QUADRO), "utf8"));
    expect(codigo).toContain(
      '"allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-same-origin"',
    );
    expect(codigo).toMatch(/sandbox=\{SANDBOX\}/);
    expect(codigo).toContain('referrerPolicy="no-referrer"');
    expect(codigo).toContain('allow=""');
    // a URL do iframe leva só identificadores
    expect(codigo).toMatch(/searchParams\.set\("organization"/);
    expect(codigo).toMatch(/searchParams\.set\("installation"/);
    expect(codigo).not.toMatch(/searchParams\.set\("(jwt|token|secret)/);
  });

  it("o ActiveOrg leva só slug e título do módulo, nunca o endereço nem a instalação", () => {
    const texto = readFileSync(join(RAIZ, "lib/auth/types.ts"), "utf8");
    const ini = texto.indexOf("export interface ActiveOrg");
    expect(ini).toBeGreaterThan(-1);
    const resto = texto.slice(ini);
    // o corpo da interface termina na primeira chave na coluna 0
    const fim = resto.search(/\n}\s*\n/);
    const corpo = codigoSemComentarios(resto.slice(0, fim > 0 ? fim : resto.length));
    expect(corpo).toMatch(/modulos_conectados\?:\s*readonly\s*\{\s*slug:\s*string;\s*titulo:\s*string\s*\}\[\]/);
    expect(corpo).not.toMatch(/serviceOrigin|service_origin|installationId|installation_id/);
  });

  it("o varredor enxerga o que deve (a cerca não é cega)", () => {
    expect(POST_MESSAGE_COM_ASTERISCO.test('w.postMessage(msg, "*");')).toBe(true);
    expect(POST_MESSAGE_COM_ASTERISCO.test("w.postMessage(msg, '*')")).toBe(true);
    expect(POST_MESSAGE_COM_ASTERISCO.test("w.postMessage(msg, modulo.serviceOrigin);")).toBe(false);
    expect(IFRAME.test(codigoSemComentarios("// <iframe src=x>\n/* <iframe */"))).toBe(false);
    expect(IFRAME.test(codigoSemComentarios("<iframe src={u} />"))).toBe(true);
    expect(USA_A_PONTE.test("import { lerMensagemDoModulo } from 'x'")).toBe(true);
  });
});
