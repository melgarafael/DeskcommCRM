/**
 * A VOLTA DO CONSENTIMENTO CHEGA — que é o que nunca acontecia.
 *
 * ─── O que esta spec prova, e por que ela não fala com o Google ──────────────
 *
 * O defeito medido na v1.8.0, em produção, era ANTES do Google:
 *
 *   GET /api/v1/agenda/google/callback → 401 {"code":"unauthenticated"}
 *
 * O cookie de sessão é `sameSite: "strict"`, e Strict não viaja em navegação
 * vinda de outro site. O `proxy.ts` respondia 401 antes de a rota existir, e o
 * handler relia a mesma sessão com `loadAuthUser()` — as duas camadas cegas
 * pelo mesmo motivo. **A ida sempre funcionou; a volta nunca.**
 *
 * Falar com o Google de verdade aqui provaria OUTRA coisa (a troca do código por
 * token) e exigiria segredo real no CI. O que esta spec faz é o caminho do
 * navegador de ponta a ponta contra o app real: pede o consentimento pela tela,
 * captura o `state` e o cookie de vínculo que o servidor emitiu, e volta ao
 * callback **como o Google voltaria** — sem o cookie de sessão.
 *
 * O sucesso NÃO é "conectou": é a volta ser RECONHECIDA em vez de barrada. O
 * fluxo segue até a troca do código, que falha porque o código é inventado — e
 * é justamente esse ponto de falha que prova que o pedido passou do `proxy`, do
 * `state` e do vínculo. Barrado antes, o desfecho seria 401 ou
 * `retorno_nao_verificavel`.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { expect, test } from "@playwright/test";

const CALLBACK = "/api/v1/agenda/google/callback";
const RAIZ = process.cwd();

interface Creds {
  password: string;
  users: Record<string, { email: string } | undefined>;
}

function lerCreds(): Creds {
  const p = path.join(RAIZ, ".e2e-creds.json");
  if (!fs.existsSync(p)) {
    throw new Error("`.e2e-creds.json` ausente — rode `scripts/seed-e2e-credentials.ts`");
  }
  return JSON.parse(fs.readFileSync(p, "utf8")) as Creds;
}

async function entrar(page: import("@playwright/test").Page, creds: Creds) {
  // `manager`, como nas specs irmãs: o `admin` do seed tem TOTP, e a tela de 2FA
  // não é o assunto aqui.
  const usuario = creds.users.manager;
  if (!usuario) throw new Error(".e2e-creds.json sem o usuário `manager`");
  await page.goto("/login");
  await page.getByLabel(/e-?mail/i).fill(usuario.email);
  await page.getByLabel(/senha/i).fill(creds.password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app(\/|$)/, { timeout: 20_000 });
}

/**
 * O destino que a página-ponte manda o navegador seguir.
 *
 * A volta do callback é 200 + HTML com `location.replace("…")`, e não mais um
 * 307 com header `Location` — ver o comentário em `voltar()`
 * (`app/api/v1/agenda/google/callback/route.ts`). Ler o corpo é o que mantém
 * estas asserções medindo o DESTINO em vez da forma da resposta.
 */
async function destinoDaPonte(resposta: { text(): Promise<string> }): Promise<string> {
  const corpo = await resposta.text();
  const m = /location\.replace\((["'])(.*?)\1\)/.exec(corpo);
  return m?.[2] ?? corpo;
}

test.describe("a volta do consentimento do Google chega ao sistema", () => {
  test("o callback não é mais barrado pelo proxy antes de existir", async ({ request }) => {
    // Sem cookie NENHUM — é literalmente a condição da volta do Google, e era
    // aqui que o produto respondia 401 em toda instalação.
    const r = await request.get(`${CALLBACK}?error=access_denied`, { maxRedirects: 0 });

    expect(
      r.status(),
      "o proxy voltou a barrar o callback: sem entrada em PUBLIC_PATHS o fluxo do " +
        "Google não completa em instalação nenhuma",
    ).not.toBe(401);

    // Recusa do usuário no Google é um caminho legítimo: tem de levar de volta
    // para a Agenda com o motivo, nunca um erro cru de API.
    //
    // 200 e não 307: a volta é uma PÁGINA-PONTE. O 307 daqui herdava a cadeia
    // iniciada no Google, o cookie `SameSite=Strict` não viajava, e a pessoa
    // caía no `/login` achando que tinha sido deslogada. O que esta asserção
    // mede — "recusar não vira erro de API, vira volta para a Agenda com o
    // motivo" — continua igual; mudou onde o destino é lido.
    expect(r.status()).toBe(200);
    expect(await destinoDaPonte(r)).toContain("/app/agenda?erro=conexao_cancelada");
  });

  test("a ida emite o vínculo, e a volta com ele é reconhecida", async ({ page, context }) => {
    const creds = lerCreds();
    await entrar(page, creds);

    // A IDA, pela tela, como a pessoa faz.
    const ida = await page.request.get("/api/v1/agenda/google/connect", { maxRedirects: 0 });
    const destino = ida.headers()["location"] ?? "";

    // Instalação sem credencial do Google devolve para a Agenda com o aviso —
    // e aí não há consentimento a testar. Pular é honesto; fingir que passou não.
    test.skip(
      !destino.includes("accounts.google.com"),
      "esta instalação não tem credencial do Google cadastrada — nada a consentir",
    );

    const state = new URL(destino).searchParams.get("state");
    expect(state, "a ida não levou `state` — o resto da spec não mede nada sem ele").toBeTruthy();

    const vinculo = (await context.cookies()).find((c) => c.name === "crm_oauth_bind");
    expect(
      vinculo,
      "a ida não emitiu o cookie de vínculo; sem ele a volta não tem como ser reconhecida",
    ).toBeTruthy();
    expect(vinculo!.sameSite, "o vínculo precisa ser Lax — Strict não viaja na volta").toBe("Lax");
    expect(vinculo!.httpOnly).toBe(true);

    // A VOLTA, como o Google a faz: contexto novo, SEM sessão, só com o vínculo.
    const anonimo = await page.context().browser()!.newContext();
    await anonimo.addCookies([{ ...vinculo!, sameSite: "Lax" }]);
    const volta = await anonimo.request.get(`${CALLBACK}?code=codigo-de-teste&state=${state}`, {
      maxRedirects: 0,
    });

    expect(volta.status(), "a volta foi barrada — o conserto do proxy regrediu").not.toBe(401);
    // ⚠️ O DESTINO SAI DO CORPO, E NÃO DO HEADER `location`.
    //
    // A volta deixou de ser um 307: ela é uma PÁGINA-PONTE 200 que navega por
    // `location.replace`. A mudança não é de estilo — um 307 daqui herda a
    // cadeia iniciada no Google, o cookie `SameSite=Strict` não viaja, e a
    // pessoa cai no `/login` achando que foi deslogada (medido em navegador
    // em `agenda-google-volta-nao-desloga.spec.ts`).
    //
    // Esta spec continua medindo o que media — QUAL destino a volta escolhe —,
    // só que lendo onde ele agora está.
    const destinoDaVolta = await destinoDaPonte(volta);

    // O que NÃO pode aparecer: a mensagem de "não consigo verificar quem voltou".
    // Ela é o desfecho de vínculo ausente ou não-casando, e o vínculo está aqui.
    expect(
      destinoDaVolta,
      "o vínculo não foi reconhecido: ou ele não é lido, ou é conferido depois da " +
        "queima do nonce, ou a assinatura mudou de um lado só",
    ).not.toContain("retorno_nao_verificavel");

    await anonimo.close();
  });

  test("volta SEM o vínculo é recusada — a proteção não sumiu junto com o 401", async ({
    request,
  }) => {
    // O conserto abriu o caminho no proxy. Este caso existe para provar que
    // abrir não é liberar: sem o cookie que a ida emitiu, a volta continua
    // recusada — só que agora com a mensagem da Agenda, e não com 401 de API.
    const r = await request.get(`${CALLBACK}?code=x&state=forjado`, { maxRedirects: 0 });
    // 200 e não 307: página-ponte. Ver o comentário do caso acima.
    expect(r.status()).toBe(200);
    expect(await destinoDaPonte(r)).toContain("erro=retorno_nao_verificavel");
  });
});
