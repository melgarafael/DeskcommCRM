/**
 * O NOME DA MARCA EM TEXTO NAS PÁGINAS PÚBLICAS VEM DO BANCO.
 *
 * ── O DEFEITO QUE ESTE ARQUIVO IMPEDE (issues #1944 e #2511) ─────────────────
 *
 * `branding()` (`lib/branding.ts`) lê só o `.env` (`process.env.APP_NAME`). As
 * páginas fora da árvore autenticada escreviam o nome da marca em texto a
 * partir dela, então uma marca configurada em Administração › Marca (banco)
 * não aparecia ali: o valor do `.env` (semente da instalação) continuava no
 * lugar. Divergência observável: banco com nome X e `.env` com Y ⇒ o cabeçalho
 * dessas páginas mostrava Y.
 *
 * Foi medido em duas ondas: a primeira (#1944) nas telas da primeira jornada,
 * a segunda (#2511) nas páginas `/legal` — revendedor que mudou de nome via a
 * tela continuava vendo o nome antigo na política de privacidade e nos termos.
 *
 * A regra do produto já existe em `lib/branding/saida.ts` — `marcaDaSaida`
 * resolve banco ACIMA do `.env` (o `.env` é só o piso) e NUNCA lança. As
 * páginas devem chamar ESSE resolvedor, nunca duplicar fallback, e nunca voltar
 * a `branding()` para o nome em texto.
 *
 * ── POR QUE É VARREDURA E NÃO LISTA FECHADA ─────────────────────────────────
 *
 * A primeira versão deste arquivo carregava uma constante `TELAS` com as
 * páginas do dia. Cada página nova nascia FORA da cerca: era só chamar
 * `branding()` de novo que nada reprovava — que é exatamente como `/legal`
 * ficou com defeito por tempo indeterminado depois do #2510 consertar a home.
 * A lista fechada virou a VARREDURA das páginas (`page.tsx` e `layout.tsx`)
 * sob `app/`, fora de `app/app/`: a próxima página pública já nasce coberta.
 *
 * ⚠️ Não é teste de render: renderizá-las exigiria mock da cadeia de
 * autenticação/organização inteira. O contrato aqui é de FONTE — a mesma
 * disciplina da catraca de `marca-sem-divergencia-de-hidratacao.test.tsx`,
 * que também decide por leitura do arquivo porque o erro que ele impede é
 * compilável mas sem teste.
 */
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const RAIZ = process.cwd();

/**
 * Toda página/casca server da árvore PÚBLICA: os arquivos `page.tsx` e
 * `layout.tsx` sob `app/`, sem a sub-árvore `app/app/` (aquela é autenticada e
 * tem a própria disciplina de marca, pelo contexto do layout raiz).
 */
function paginasServerForaDeApp(): string[] {
  const achados: string[] = [];

  function varrer(dir: string): void {
    for (const entrada of fs.readdirSync(dir, { withFileTypes: true })) {
      const completo = path.join(dir, entrada.name);
      if (entrada.isDirectory()) {
        if (entrada.name === "node_modules" || entrada.name.startsWith(".")) continue;
        // A árvore autenticada fica de fora — regra dela é outra (#1944).
        if (path.relative(RAIZ, completo).replace(/\\/g, "/") === "app/app") continue;
        varrer(completo);
      } else if (entrada.name === "page.tsx" || entrada.name === "layout.tsx") {
        achados.push(completo);
      }
    }
  }

  varrer(path.join(RAIZ, "app"));
  return achados.sort();
}

/** O resolvedor do banco é quem decide — banco acima, `.env` como piso. */
const RESOLVEDOR = "marcaDaSaida";

const PAGINAS = paginasServerForaDeApp();

/**
 * Comentário não conta — senão os próprios comentários que EXPLICAM a decisão
 * (neste arquivo, no cabeçalho de `lib/branding.ts`, em `app/layout.tsx`)
 * reprovariam a cerca, e o caminho de menor resistência seria apagá-los.
 *
 * O corte é por BLOCO (`/* … *\/`) e depois por linha `//`: o de prefixo de
 * linha sozinho acusa prosa de bloco em `.tsx` que começa com palavra comum.
 */
function semComentarios(fonte: string): string {
  return fonte
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((linha) => !linha.trimStart().startsWith("//"))
    .join("\n");
}

const codigo = (relativo: string) =>
  semComentarios(fs.readFileSync(path.join(RAIZ, relativo), "utf8"));

describe("o nome em texto das páginas públicas vem do BANCO", () => {
  it("a varredura acha as páginas de verdade — e as de /legal estão nelas", () => {
    // Sem esta guarda, uma varredura quebrada (caminho errado, `readdir` que
    // não desce) esvaziaria a lista e TODOS os casos abaixo passariam sem
    // medir nada — o modo nº 1 de um gate ficar verde por engano.
    const relativos = PAGINAS.map((p) => path.relative(RAIZ, p).replace(/\\/g, "/"));
    expect(relativos.length).toBeGreaterThan(50);
    expect(relativos).toContain("app/legal/layout.tsx");
    expect(relativos).toContain("app/legal/privacy/page.tsx");
    expect(relativos).toContain("app/legal/terms/page.tsx");
    expect(relativos).toContain("app/page.tsx");
    // A árvore autenticada não entra na regra (tem a própria, pelo contexto).
    expect(relativos.filter((r) => r.startsWith("app/app/"))).toEqual([]);
  });

  it("nenhuma delas escreve o nome da marca por `branding()` (só `.env`)", () => {
    const infratoras = PAGINAS.map((p) => path.relative(RAIZ, p).replace(/\\/g, "/")).filter(
      (relativo) => /\bbranding\(\)/.test(codigo(relativo)),
    );
    expect(
      infratoras,
      "página server fora de /app voltou a ler o nome de `branding()`, que só lê o\n" +
        ".env — a marca gravada pela tela não chega a ela. Use `marcaDaSaida(null)`\n" +
        "(lib/branding/saida): banco acima do .env e nunca lança.",
    ).toEqual([]);
  });

  it("as que resolvem a marca o fazem pelo resolvedor do banco, no sítio certo", () => {
    const comResolvedor = PAGINAS.filter((p) =>
      codigo(path.relative(RAIZ, p).replace(/\\/g, "/")).includes(RESOLVEDOR),
    ).map((p) => path.relative(RAIZ, p).replace(/\\/g, "/"));

    // A guarda de vacuidade do caso POSITIVO: o resolvedor não pode sumir do
    // conjunto sem que alguém perceba — sete é o piso medido hoje (home,
    // fachada de acesso, login, get-started, onboarding/welcome e o layout do
    // onboarding, mais o `/legal` do #2511).
    expect(comResolvedor.length).toBeGreaterThanOrEqual(7);
    expect(comResolvedor).toContain("app/legal/layout.tsx");
    expect(comResolvedor).toContain("app/page.tsx");

    for (const relativo of comResolvedor) {
      expect(
        codigo(relativo).includes(`import { ${RESOLVEDOR} } from "@/lib/branding/saida"`),
        `${relativo} deve importar ${RESOLVEDOR} de lib/branding/saida para o nome em texto`,
      ).toBe(true);
    }
  });

  it("o corpo de /legal (`sistema` de `lib/legal/operador.ts`) também vem do banco", () => {
    // A varredura acima só olha `page.tsx`/`layout.tsx`. O nome que aparece no
    // TEXTO da política e dos termos ("Como esta instalação do X…") vem de
    // `resolverOperador().sistema`, montado em `lib/legal/operador.ts` — fora da
    // varredura. Sem este caso, devolver `branding()` ali deixava a cerca verde
    // com o defeito do #2511 de volta no corpo do documento (medido na triagem
    // do #2534).
    const fonte = codigo("lib/legal/operador.ts");
    expect(fonte).not.toMatch(/\bbranding\(\)/);
    expect(fonte).toContain(`import { ${RESOLVEDOR} } from "@/lib/branding/saida"`);
  });

  it("o onboarding (connect-nuvemshop), que é client, lê do CONTEXTO do banco", () => {
    // O `_client.tsx` não pode chamar `marcaDaSaida` (server-only); o caminho
    // certo lá é `useMarcaDaInstalacao()` do contexto que o layout raiz monta a
    // partir da marca RESOLVIDA — banco incluído.
    const fonte = fs.readFileSync(
      path.join(RAIZ, "app/onboarding/connect-nuvemshop/_client.tsx"),
      "utf8",
    );
    expect(fonte).toContain("useMarcaDaInstalacao()");
    expect(semComentarios(fonte)).not.toContain("branding()");
  });

  it("🔴 o PDF de LGPD continua SEM marca — ele nomeia o controlador", () => {
    // Regra de CLAUDE.md › Marca própria: nomear o revendedor — que é operador,
    // não controlador — inverteria papéis num documento que responde a direito
    // legal do titular. "Completar o white-label" aqui PIORIA o defeito, e esta
    // cerca existe para que o conserto das páginas legais não contagi o
    // renderer. A prova de RENDER continua em `lgpd-pdf-controlador.test.tsx`
    // (olha o rodapé renderizado) e em `mapas-de-arquitetura.test.ts`; aqui é a
    // prova de FONTE, que roda junto com o resto da cerca.
    const fonte = codigo("lib/lgpd/pdf-renderer.tsx");
    expect(fonte).not.toMatch(/\bbranding\(\)/);
    expect(fonte).not.toContain(RESOLVEDOR);
  });
});
