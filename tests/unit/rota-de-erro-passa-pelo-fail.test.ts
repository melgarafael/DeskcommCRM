/**
 * ROTA QUE DEVOLVE ERRO PASSA PELO `fail()` — catraca da #3971.
 *
 * ## Por que este arquivo existe
 *
 * A correção da #3971 faz o ID que aparece na tela (`X-Request-Id`) sempre
 * existir no log: `fail()` resolve o id uma vez e grava a linha dele próprio
 * quando ninguém mais gravou. Isso vale para toda resposta que passa por
 * `fail()` — e só para essas. Uma rota nova que monte o erro à mão com
 * `NextResponse.json(..., { status: 500 })` volta a produzir exatamente o
 * defeito da issue: um id (ou nenhum) que ninguém acha no log.
 *
 * Nenhuma catraca cobria isso, e a regra escrita no cabeçalho de
 * `lib/api/wrappers.ts` ("toda rota `/api/v1/*` DEVE usar `ok()`/`fail()`")
 * estava violada em 16 arquivos quando esta foi escrita.
 *
 * ## O que a catraca faz, e o que ela NÃO faz
 *
 * Ela é estática e grosseira de propósito: procura `NextResponse.json(`,
 * `new NextResponse(` e `new Response(` cujo `status:` próximo seja 4xx/5xx.
 * Não tenta decidir se aquilo é um erro legítimo (o `qr` devolve imagem com
 * 404, o `avatar` idem) — a lista abaixo é DÍVIDA DECLARADA, não anistia:
 *
 *  - rota NOVA que devolva erro fora do `fail()` reprova;
 *  - entrada da lista que deixe de ter resposta de erro à mão também reprova
 *    (a lista não pode envelhecer: no dia em que alguém migrar o arquivo, a
 *    entrada sai junto).
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const RAIZ = join(__dirname, "..", "..");

/**
 * Rotas que ainda respondem erro à mão. Quando uma delas migrar para o
 * `fail()`, apague a linha — o teste cobra isso no segundo `it`.
 */
const AINDA_A_MAO = [
  "app/api/v1/admin/platform-admins/route.ts",
  "app/api/v1/anuncios/google/[org]/route.ts",
  "app/api/v1/anuncios/meta/[org]/route.ts",
  "app/api/v1/channel-sessions/[id]/qr/route.ts",
  "app/api/v1/contacts/[id]/avatar/route.ts",
  "app/api/v1/cron/agenda-google-push/route.ts",
  "app/api/v1/cron/agenda-google-refresh/route.ts",
  "app/api/v1/cron/agenda-google-sync/route.ts",
  "app/api/v1/mcp-oauth/callback/[servidor]/route.ts",
  "app/api/v1/mcp-oauth/iniciar/[state]/route.ts",
  "app/api/v1/onboarding/whatsapp/qr/route.ts",
  "app/api/v1/rastreio/[id]/route.ts",
  "app/api/v1/voice/events/route.ts",
  "app/api/v1/voice/sessions/status/route.ts",
  "app/api/v1/webhooks/meta/[token]/route.ts",
  "app/email-templates/[modelo]/route.ts",
];

/** Todos os `route.ts` sob `app/`. */
function rotas(dir = join(RAIZ, "app")): string[] {
  const saida: string[] = [];
  for (const entrada of readdirSync(dir, { withFileTypes: true })) {
    const caminho = join(dir, entrada.name);
    if (entrada.isDirectory()) saida.push(...rotas(caminho));
    else if (entrada.name === "route.ts") saida.push(caminho);
  }
  return saida;
}

/**
 * A rota monta alguma resposta de erro sem passar pelo `fail()`?
 *
 * O `status:` é procurado nos 400 caracteres seguintes à chamada do construtor
 * — o suficiente para `NextResponse.json(body, { status: 500 })` com corpo
 * inline, e curto o bastante para não pegar o `status` de outra resposta.
 */
function respostasDeErroAMao(fonte: string): number {
  const construtor = /(NextResponse\.json|new NextResponse|new Response)\(/g;
  let total = 0;
  for (let m = construtor.exec(fonte); m; m = construtor.exec(fonte)) {
    const trecho = fonte.slice(m.index, m.index + 400);
    if (/status:\s*[45]\d\d/.test(trecho)) total++;
  }
  return total;
}

describe("resposta de erro passa pelo fail()", () => {
  it("nenhuma rota NOVA responde erro por fora do fail()", () => {
    const fora = rotas()
      .map((p) => ({
        arquivo: relative(RAIZ, p).split(sep).join("/"),
        n: respostasDeErroAMao(readFileSync(p, "utf8")),
      }))
      .filter((r) => r.n > 0)
      .map((r) => r.arquivo)
      .filter((a) => !AINDA_A_MAO.includes(a))
      .sort();

    expect(fora).toEqual([]);
  });

  it("a lista de dívida não envelhece: entrada migrada sai da lista", () => {
    const migradas = AINDA_A_MAO.filter((a) => respostasDeErroAMao(readFileSync(join(RAIZ, a), "utf8")) === 0);

    expect(migradas).toEqual([]);
  });
});
