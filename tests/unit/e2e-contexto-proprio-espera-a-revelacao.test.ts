/**
 * Toda spec que cria contexto PRÓPRIO de navegador (`browser.newContext()`, e
 * não o `context` do fixture) registra a espera da revelação nesse contexto —
 * ou diz, no ponto, por que não precisa.
 *
 * ═══ Por que só o fixture não basta ═══════════════════════════════════════════
 *
 * `tests/e2e/helpers/test.ts` registra `esperarARevelacaoNasCargas` no `context`
 * e na `page` do fixture. Quem abre contexto por fora — outra sessão, outro
 * papel, uma aba antiga, um visitante sem sessão — passa longe desse registro e
 * volta a ler o documento no meio da revelação do streaming SSR: por algumas
 * centenas de milissegundos existem as DUAS cópias do boundary e o
 * `getByTestId` reprova por strict mode ("resolved to 2 elements"). É a família
 * de vermelho intermitente da #1374, da #4130 e do PR #4136 — reprova em PR que
 * nem toca a tela da spec.
 *
 * O remédio é uma linha por contexto:
 *
 *     const ctxB = await browser.newContext();
 *     ctxB.on("page", esperarARevelacaoNasCargas);
 *
 * ═══ A dispensa ══════════════════════════════════════════════════════════════
 *
 * Contexto que nunca abre página do app (`anonimo.request.get(...)`, só API) não
 * tem evento `page` para esperar; contexto criado com `javaScriptEnabled: false`
 * nunca revela a caixa, porque quem revela é o JS — esperar ali estouraria o
 * teto de 15 s. Nesses dois casos o registro seria ruído (ou mentira), e o
 * combinado é declarar no ponto, numa linha:
 *
 *     // dispensa-da-espera: <por quê>
 *
 * ═══ O limite desta varredura ════════════════════════════════════════════════
 *
 * Ela lê TEXTO, não executa a spec. Cobre `newContext` de contexto de
 * navegador; não cobre `browser.newPage()` (que cria contexto implícito), nem
 * contexto criado dentro de helper de outro arquivo — o registro ali é do
 * helper, e é o helper que a leitura teria de seguir.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const RAIZ_E2E = join(__dirname, "../e2e");
const CRIACAO = /\bnewContext\s*\(/;
/** `playwright.request.newContext()` devolve APIRequestContext, que não tem evento `page`. */
const DA_API = /\brequest\s*\.\s*newContext\s*\(/;
const DISPENSA = "dispensa-da-espera:";
const REGISTRO = "esperarARevelacaoNasCargas";
/** Uma chamada multi-linha ocupa poucas linhas; o registro cai logo depois dela. */
const JANELA_DE_BUSCA = 6;

type ContextoProprio = {
  /** Linha (1-based) do `newContext(`. */
  linha: number;
  nome: string;
  registrado: boolean;
  dispensado: boolean;
};

/** Nome da variável que recebe o contexto; `null` quando a criação não é atribuída. */
function nomeDoContexto(prefixo: string): string | null {
  const achado = /([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?[^=;]*$/.exec(prefixo);
  if (!achado) return null;
  return achado[1]!;
}

function escapar(nome: string): string {
  return nome.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Os contextos próprios de uma spec. Função pura sobre o TEXTO do arquivo:
 * é o que o caso de sonda exercita com fontes sintéticas, e o que a varredura
 * roda contra `tests/e2e/*.spec.ts`.
 */
export function contextosProprios(fonte: string): ContextoProprio[] {
  const linhas = fonte.split("\n");
  const achados: ContextoProprio[] = [];

  linhas.forEach((linha, indice) => {
    if (!CRIACAO.test(linha) || DA_API.test(linha)) return;
    const nome = nomeDoContexto(linha.split("newContext(", 1)[0]!);
    if (nome === null) return;

    const janela = linhas.slice(Math.max(0, indice - 1), indice + JANELA_DE_BUSCA + 1).join("\n");
    const registro = new RegExp(
      `${escapar(nome)}\\s*\\.on\\(\\s*["']page["']\\s*,\\s*${REGISTRO}\\s*\\)`,
    );
    const dispensadoEm = janela.split("\n").find((l) => l.includes(DISPENSA));
    const motivo = dispensadoEm?.split(DISPENSA)[1]?.trim() ?? "";

    achados.push({
      linha: indice + 1,
      nome,
      registrado: registro.test(janela),
      dispensado: motivo.length >= 10,
    });
  });

  return achados;
}

function specs(): string[] {
  return readdirSync(RAIZ_E2E, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".spec.ts"));
}

describe("contexto próprio das specs e2e espera a revelação (issue #4137)", () => {
  it("a sonda enxerga a criação, o registro e a dispensa", () => {
    const comRegistro = contextosProprios(
      [
        'import { esperarARevelacaoNasCargas, test } from "./helpers/test";',
        "const ctxB = await browser.newContext();",
        'ctxB.on("page", esperarARevelacaoNasCargas);',
        "const pB = await ctxB.newPage();",
      ].join("\n"),
    );
    expect(comRegistro).toEqual([{ linha: 2, nome: "ctxB", registrado: true, dispensado: false }]);

    // Sem o registro e sem dispensa: é o que a varredura tem de reprovar.
    const semNada = contextosProprios("const outro = await browser.newContext();\nawait outro.newPage();\n");
    expect(semNada).toEqual([{ linha: 1, nome: "outro", registrado: false, dispensado: false }]);

    // Multi-linha + registro depois do fecho da chamada.
    const multiLinha = contextosProprios(
      [
        "const contexto = await browser.newContext({",
        '  javaScriptEnabled: true,',
        "});",
        'contexto.on("page", esperarARevelacaoNasCargas);',
      ].join("\n"),
    );
    expect(multiLinha[0]).toMatchObject({ linha: 1, nome: "contexto", registrado: true });

    // APIRequestContext não tem evento `page`: nem entra na conta.
    expect(contextosProprios('const anon = await playwright.request.newContext({ baseURL });\n')).toEqual([]);

    // Dispensa com motivo declarado.
    const dispensado = contextosProprios(
      [
        "// dispensa-da-espera: só faz request de API, nunca abre página.",
        "const anonimo = await browser.newContext();",
      ].join("\n"),
    );
    expect(dispensado).toEqual([{ linha: 2, nome: "anonimo", registrado: false, dispensado: true }]);

    // Marcador sem motivo não vale como dispensa.
    const vazia = contextosProprios(
      ["// dispensa-da-espera:", "const anonimo = await browser.newContext();"].join("\n"),
    );
    expect(vazia[0]!.dispensado).toBe(false);
  });

  it("nenhuma spec cria contexto próprio sem registrar a espera nem declarar dispensa", () => {
    const lista = specs();
    expect(lista.length).toBeGreaterThan(0);

    const pendentes: string[] = [];
    for (const arquivo of lista) {
      const fonte = readFileSync(join(RAIZ_E2E, arquivo), "utf8");
      for (const contexto of contextosProprios(fonte)) {
        if (contexto.registrado || contexto.dispensado) continue;
        pendentes.push(
          `tests/e2e/${arquivo}:${contexto.linha} — '${contexto.nome}' sem \`${contexto.nome}.on("page", ${REGISTRO})\` ` +
            `e sem \`// ${DISPENSA} <motivo>\``,
        );
      }
    }

    expect(
      pendentes,
      "todo contexto próprio é um documento que pode ser lido no meio da revelação do streaming SSR " +
        "(duas cópias do boundary, strict mode): registre a espera nele ou declare a dispensa",
    ).toEqual([]);
  });
});
