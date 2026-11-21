/**
 * CERCA ESTRUTURAL: rota de VOLTA de outro site não termina em 3xx para tela
 * que EXIGE sessão (issues #1646 e #4335).
 *
 * ─── O defeito que esta cerca existe para não deixar nascer ──────────────────
 *
 * `lib/supabase/server.ts` grava o cookie de SESSÃO com `sameSite: "strict"`.
 * Strict retém o cookie em TODA navegação cujo initiator é outro site — e a
 * volta de um consentimento OAuth, ou de um link de e-mail, é a cadeia inteira:
 * `accounts.google.com` → GoTrue → rota nossa. Responder essa navegação com um
 * 3xx para `/app`, `/get-started`, `/onboarding/welcome`, `/login/mfa` ou
 * `/login/reset` NÃO rompe a cadeia: o salto seguinte continua cross-site, o
 * cookie não viaja, e o `proxy.ts` manda a pessoa para `/login?next=%2Fapp` —
 * como se o login tivesse falhado, embora a sessão já esteja criada.
 *
 * A saída é sempre a PONTE (`lib/auth/ponte-de-volta.ts`): um documento
 * same-origin com 200 cujo `location.replace` é disparado por um documento
 * nosso. `SameSite` NÃO se afrouxa — o que era para afrouxar seria o cookie de
 * sessão do produto inteiro.
 *
 * ─── Por que varrer o CÓDIGO, e não o destino ────────────────────────────────
 *
 * Um teste que só olhasse o destino não pegaria nada disto: o destino é
 * idêntico nos dois defeitos. O que muda é QUEM inicia a navegação seguinte.
 * Foi exatamente por isso que o teste do ramo de TOTP ficou verde com o 302 de
 * volta (#4335): o helper `destino()` aceitava `Location` e ponte como se fossem
 * a mesma entrega.
 *
 * ─── O que a cerca NÃO vê (e é honesto dizer) ───────────────────────────────
 *
 * - O destino é lido do LITERAL no ponto da chamada, na mesma linha. Um
 *   `redirectTo(\`/app/${x}\`)` montado em duas linhas, ou passado por variável,
 *   escapa da varredura — a revisão humana continua sendo a segunda barreira.
 * - `app/auth/*` e `**\/callback/route.ts` são o universo. Uma rota de volta com
 *   outro nome de pasta não é descoberta; se aparecer, o caso de contagem
 *   (`a descoberta não pode vir vazia`) obriga quem a criou a vir aqui.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

const RAIZ = process.cwd();

/**
 * As rotas de VOLTA: o navegador chega nelas por um salto de outro site.
 *
 * Critério de descoberta, não lista fixa: todo `route.ts` cuja pasta é
 * `callback` (as voltas de OAuth dos provedores) e todo `route.ts` logo abaixo
 * de `app/auth/` (a volta da entrada, a do link de e-mail, as pontes de retorno).
 */
function rotasDeVolta(dir: string = join(RAIZ, "app"), achadas: string[] = []): string[] {
  for (const entrada of readdirSync(dir)) {
    const caminho = join(dir, entrada);
    if (statSync(caminho).isDirectory()) {
      rotasDeVolta(caminho, achadas);
      continue;
    }
    if (entrada !== "route.ts") continue;
    const pasta = relative(RAIZ, dir).split("/").pop();
    const rel = relative(RAIZ, caminho);
    if (pasta === "callback" || rel.startsWith("app/auth/")) achadas.push(caminho);
  }
  return achadas;
}

/** Telas que fazem `getUser()`/`requireAuth()`: com 3xx para elas, o cookie Strict não viaja. */
const TELA_COM_SESSAO = /^\/(app|get-started|onboarding)(\/|$|\?)|^\/login\/(reset|mfa)(\/|$|\?)/;

/**
 * Os destinos literais passados a um redirect, na MESMA linha da chamada.
 *
 * `NextResponse.redirect` cobre o idioma do Next; `redirectTo`/`voltar` cobrem
 * os atalhos locais de cada rota. Argumento que não começa com aspas (variável,
 * ternário) não entra — está declarado no cabeçalho como limite conhecido.
 */
function alvosDeRedirect(fonte: string): Array<{ alvo: string; linha: number }> {
  const alvos: Array<{ alvo: string; linha: number }> = [];
  fonte.split("\n").forEach((texto, indice) => {
    for (const m of texto.matchAll(/(?:redirectTo|NextResponse\.redirect)\(\s*([`"'])([^`"']*)/g)) {
      alvos.push({ alvo: m[2]!, linha: indice + 1 });
    }
  });
  return alvos;
}

const ROTAS = rotasDeVolta();

describe("rota de volta de outro site não sai por 3xx para tela que exige sessão", () => {
  it("a descoberta não pode vir vazia — caso que mede o nada passa sempre", () => {
    expect(ROTAS.length).toBeGreaterThanOrEqual(5);
    // As cinco que a #4335 mediu, nominalmente: se uma delas sair da descoberta,
    // a cerca deixou de cercar justamente o que ela existe para cercar.
    const relativas = ROTAS.map((r) => relative(RAIZ, r));
    expect(relativas).toContain("app/auth/callback/route.ts");
    expect(relativas).toContain("app/auth/confirm/route.ts");
    expect(relativas).toContain("app/api/v1/plataformas-de-anuncio/google/callback/route.ts");
    expect(relativas).toContain("app/api/v1/integrations/nuvemshop/callback/route.ts");
    expect(relativas).toContain("app/api/v1/agenda/google/callback/route.ts");
  });

  it.each(ROTAS.map((caminho) => [relative(RAIZ, caminho), caminho] as const))(
    "%s: nenhum redirect para tela com sessão",
    (rel, caminho) => {
      const fonte = readFileSync(caminho, "utf8");
      const infratores = alvosDeRedirect(fonte).filter(({ alvo }) => TELA_COM_SESSAO.test(alvo));

      expect(
        infratores,
        `${rel} responde 3xx para uma tela que exige sessão (${infratores
          .map((i) => `linha ${i.linha}: ${i.alvo}`)
          .join(", ")}). Esse salto continua a cadeia de navegação começada no ` +
          "provedor de fora, o cookie de sessão `sameSite: \"strict\"` não viaja e a " +
          "pessoa cai em `/login` com a sessão já criada. Use `respostaDePonte(...)` " +
          "(issue #1646/#4335) — e não afrouxe o `sameSite` do cookie.",
      ).toEqual([]);
    },
  );
});
