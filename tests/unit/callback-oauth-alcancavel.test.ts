/**
 * TODO CALLBACK DE OAuth PRECISA SER ALCANÇÁVEL SEM COOKIE DE SESSÃO.
 *
 * ─── O defeito que este arquivo existe para não deixar voltar ────────────────
 *
 * O cookie de sessão do produto é `sameSite: "strict"`. Strict retém o cookie em
 * toda navegação vinda de outro site — e a volta de um consentimento OAuth é
 * exatamente isso: o provedor devolve o NAVEGADOR de `accounts.google.com` (ou
 * de `www.tiendanube.com`) para o nosso `redirect_uri`.
 *
 * Sem o caminho em `PUBLIC_PATHS`, o `proxy.ts` responde 401 antes de a rota
 * existir. Medido em produção na v1.8.0, na VPS do dono do produto:
 *
 *   GET /api/v1/agenda/google/callback → 401 {"code":"unauthenticated"}
 *
 * O fluxo NUNCA completou, em instalação nenhuma. E a varredura que achou o
 * defeito achou o irmão junto: o callback da integração de loja tinha o mesmo
 * problema, pelo mesmo motivo, sem que ninguém tivesse relatado ainda.
 *
 * ─── Por que um teste, e não um comentário ───────────────────────────────────
 *
 * Consertar os dois callbacks conserta a INSTÂNCIA. O terceiro callback OAuth
 * que este repositório ganhar nasce barrado de novo, e o sintoma volta com
 * outro parceiro no título — porque nada no caminho de quem o escreve avisa que
 * `PUBLIC_PATHS` existe.
 *
 * A descoberta é por varredura do disco, e não por lista fixa, de propósito: uma
 * lista fixa envelhece calada, e este repo já pagou por isso (a versão anterior
 * de um invariante de hardening checava 6 funções enquanto 8 de 25 estavam
 * expostas).
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { isPublicPath } from "@/lib/auth/public-paths";

/**
 * Callbacks que NÃO são retorno de navegador e por isso não precisam da
 * allowlist. Cada entrada carrega o motivo — allowlist sem motivo escrito é
 * como não ter allowlist.
 */
const NAO_E_RETORNO_DE_NAVEGADOR: Record<string, string> = {};

function rotasDeCallback(): string[] {
  // `git ls-files` em vez de varredura do disco: arquivo não rastreado não
  // existe para o CI, e um teste que o considerasse acusaria defeito que
  // ninguém consegue reproduzir a partir do repositório.
  //
  // O glob cobre `app/**`, e não só `app/api/**`: a entrada com Google (#1388)
  // trouxe `/auth/callback`, que é a MESMA coisa — o navegador voltando de
  // outro site com um `code` na mão. Deixar a descoberta presa em `app/api`
  // criaria exatamente o ponto cego que este arquivo foi escrito para fechar.
  const saida = execFileSync("git", ["ls-files", "app/**/callback/route.ts"], {
    encoding: "utf8",
  });
  return saida.split("\n").filter(Boolean);
}

/** `app/api/v1/x/callback/route.ts` → `/api/v1/x/callback` */
function caminhoDaRota(arquivo: string): string {
  return "/" + arquivo.replace(/^app\//, "").replace(/\/route\.ts$/, "");
}

describe("todo callback de OAuth é alcançável sem cookie de sessão", () => {
  const arquivos = rotasDeCallback();

  it("a varredura enxerga alguma coisa (senão ela mede o vazio e passa)", () => {
    // Sem esta guarda, um erro no glob faria a suíte ficar verde afirmando que
    // não há callback nenhum fora da allowlist — que é o desfecho que mais se
    // parece com sucesso e menos vale.
    expect(
      arquivos.length,
      "nenhum `app/api/**/callback/route.ts` encontrado — o glob quebrou, não o repositório ficou limpo",
    ).toBeGreaterThan(0);
  });

  it.each(arquivos)("%s está em PUBLIC_PATHS (ou tem motivo escrito)", (arquivo) => {
    const rota = caminhoDaRota(arquivo);
    const dispensado = NAO_E_RETORNO_DE_NAVEGADOR[rota];
    if (dispensado) {
      expect(dispensado.length, `a dispensa de ${rota} está sem motivo escrito`).toBeGreaterThan(20);
      return;
    }
    expect(
      isPublicPath(rota),
      `${rota} recebe o NAVEGADOR de volta de um provedor externo, e o cookie de sessão é ` +
        `sameSite=strict — ele não viaja nessa navegação. Sem entrada em ` +
        `lib/auth/public-paths.ts o proxy responde 401 e o fluxo nunca completa. ` +
        `Acrescente a rota lá (ancorada com $) ou declare aqui, com o motivo, por que ela ` +
        `não é retorno de navegador.`,
    ).toBe(true);
  });

  it("o vínculo do Google não usa sameSite strict — seria o mesmo defeito de novo", () => {
    // O cookie que substituiu a leitura de sessão só serve se ELE viajar na
    // volta. Trocado para "strict" por engano, o fluxo volta a falhar sempre —
    // e falharia com a mesma mensagem genérica de todo o resto.
    const fonte = readFileSync("app/api/v1/agenda/google/connect/route.ts", "utf8");
    expect(fonte).toMatch(/sameSite:\s*"lax"/);
    expect(fonte, "o cookie de vínculo não pode ser strict").not.toMatch(
      /NOME_DO_VINCULO[\s\S]{0,400}?sameSite:\s*"strict"/,
    );
  });

  it("o `secure` do vínculo é derivado, nunca `true` literal", () => {
    // `secure: true` faria o navegador descartar o cookie em toda instalação
    // servida por `http://` — e essa população existe num produto self-host.
    // Lá o conserto viraria o defeito que ele conserta.
    const fonte = readFileSync("app/api/v1/agenda/google/connect/route.ts", "utf8");
    expect(fonte).toMatch(/secure:\s*cookieSecure\(\)/);
  });

  it("o vínculo é conferido ANTES de o nonce ser queimado", () => {
    // A ordem é load-bearing e nada além deste caso a prende. Queimar antes de
    // conferir dá a quem tem um `state` vazado um botão de negação de serviço:
    // ele queima, e o dono legítimo recebe `state_reutilizado` ao voltar.
    // Os dois ramos falham com a MESMA mensagem, então um teste que olhasse só
    // o desfecho não veria a inversão.
    const fonte = readFileSync("app/api/v1/agenda/google/callback/route.ts", "utf8");
    // ⚠️ ANCORAR NA CHAMADA, `if (!vinculoConfere(`, e não no símbolo solto.
    // A primeira versão deste caso procurava `vinculoConfere` — e casava com a
    // linha de IMPORT, que está sempre no topo do arquivo. O caso passava com a
    // ordem invertida de propósito: era decorativo, e só a sabotagem mostrou.
    const confere = fonte.indexOf("if (!vinculoConfere(");
    const queima = fonte.indexOf("calendar_oauth_nonces");
    expect(confere, "a CHAMADA `if (!vinculoConfere(` sumiu do callback").toBeGreaterThan(-1);
    expect(queima, "a queima do nonce sumiu do callback").toBeGreaterThan(-1);
    expect(
      confere,
      "o vínculo passou a ser conferido DEPOIS da queima do nonce — um `state` vazado " +
        "vira negação de serviço contra o dono legítimo",
    ).toBeLessThan(queima);
  });
});
