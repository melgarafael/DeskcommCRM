/**
 * A TELA DE NOTIFICAÇÕES NUM PRIMEIRO DEPLOY — provado pela tela, sem as chaves.
 *
 * ## Por que este é o estado que importa
 *
 * Nenhuma instalação nasce com o par VAPID. O `.env.hostgator.example` grava as
 * duas linhas VAZIAS, e gerar o par é um passo que ninguém é obrigado a dar.
 * Ou seja: **este spec roda no estado em que 100% das instalações começam**, e
 * é o estado da doutrina de QA Visual — "teste com os envs opcionais AUSENTES,
 * é o estado real de um primeiro deploy, e é onde moram os piores bugs de
 * primeira impressão".
 *
 * Não é preciso configurar nada para chegar nele: o `.env.e2e` do CI não define
 * `VAPID_PUBLIC_KEY` nem `VAPID_PRIVATE_KEY`. Se alguém as acrescentar lá, o
 * primeiro caso abaixo falha ALTO em vez de virar verde vazio — ele confere o
 * estado com o backend antes de afirmar qualquer coisa sobre a tela.
 *
 * ## O defeito que ele guarda
 *
 * A página afirmava «Push (Chrome) já funcionam» sem consultar nada. A pessoa
 * ligava o Push, o navegador pedia permissão, ela concedia — e
 * `syncPushSubscription()` fazia `return` em silêncio, porque
 * `GET /api/v1/notifications/push` devolvia `enabled:false`. O interruptor
 * ficava ligado prometendo o que a instalação não podia entregar, e não havia
 * em lugar nenhum do produto como descobrir que faltavam duas variáveis.
 *
 * ## O que ele NÃO tenta provar, e por quê
 *
 * Não prova a notificação chegando na bandeja do sistema com a aba fechada.
 * Isso depende do serviço de push do navegador (FCM), de rede externa e de um
 * par VAPID real — não é reproduzível num runner do CI, e fingir que sim com
 * mock seria pior que a ausência declarada. O que ele prova é o contrato entre
 * a TELA e o SERVIDOR: que a tela conta a verdade sobre a instalação em que
 * está, nos dois sentidos.
 *
 * O estado COM as chaves é guardado por
 * `tests/unit/notificacoes-tela-diz-o-que-falta.test.tsx`, que renderiza a mesma
 * página nos dois valores de `vapidPronto()` — em milissegundos, no `verify`.
 *
 * Pré-requisitos (banco local, app buildada):
 *   pnpm exec tsx scripts/seed-e2e-credentials.ts
 *   pnpm e2e:env && pnpm e2e:build
 *   E2E_PORT=3031 pnpm exec playwright test tests/e2e/notificacoes-diz-o-que-falta.spec.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { expect, test, type Page } from "./helpers/test";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const EVIDENCIA = path.join(process.cwd(), ".superpowers/evidence/notificacoes-sem-chaves");

interface Creds {
  password: string;
  users: Record<string, { id: string; email: string; role: string }>;
}

let creds: Creds;

/**
 * ⚠️ `agent`, E NÃO `admin` — e isto não é preferência.
 *
 * `scripts/seed-e2e-credentials.ts` garante um factor TOTP **verified** no
 * `admin` e no `dono`, sempre ("MFA do admin nunca é desabilitado"). Com eles o
 * login não chega em `/app`: para em `/login/mfa?factor=…`, e um
 * `waitForURL(/\/app/)` só descobre isso 60 segundos depois. Foi exatamente
 * assim que a primeira versão deste spec falhou no CI — os dois casos, mesma
 * causa, mesmo timeout.
 *
 * Passar o challenge com `tests/e2e/utils/totp` seria possível, e seria custo
 * sem contrapartida: a página é `requireAuth()` puro, **sem nenhum ramo por
 * papel**, então o que ela mostra é o mesmo para qualquer sessão. Pagar o TOTP
 * aqui só acrescentaria um segredo rotativo entre este spec e o defeito que ele
 * guarda.
 *
 * E há um detalhe de produto que este papel exercita de graça: um atendente
 * comum NÃO administra a VPS, e é ele quem mais precisa entender por que não
 * recebe aviso. O texto resolve isso dizendo *quem administra o servidor
 * precisa* — em vez de mandar o atendente rodar um comando que não é dele.
 */
const PAPEL_SEM_MFA = "agent";

async function login(page: Page, email: string, senha: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(senha);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app/, { timeout: 60_000 });
}

async function captura(page: Page, nome: string): Promise<void> {
  fs.mkdirSync(EVIDENCIA, { recursive: true });
  await page.screenshot({ path: path.join(EVIDENCIA, `${nome}.png`), fullPage: true });
}

test.describe("Notificações — a tela conta a verdade sobre esta instalação", () => {
  test.describe.configure({ timeout: 120_000 });

  test.beforeAll(() => {
    creds = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
  });

  test("sem o par VAPID, a tela diz o que falta e o que fazer — e não fica muda", async ({
    page,
  }) => {
    const quem = creds.users[PAPEL_SEM_MFA]!;
    await login(page, quem.email, creds.password);

    // ── CONTROLE POSITIVO ────────────────────────────────────────────────
    // Antes de afirmar qualquer coisa sobre a tela, confirme com o SERVIDOR em
    // que estado estamos. Sem isto, o dia em que alguém puser VAPID no
    // `.env.e2e` este teste vira verde afirmando o oposto do que mede.
    const cfg = await page.request.get("/api/v1/notifications/push");
    expect(cfg.ok(), "GET /api/v1/notifications/push respondeu").toBeTruthy();
    const corpo = (await cfg.json()) as { data?: { enabled?: boolean } };
    expect(
      corpo.data?.enabled,
      "este spec descreve a instalação SEM VAPID; se o ambiente passou a tê-lo, " +
        "mova-o para o outro estado em vez de deixá-lo verde dizendo o contrário",
    ).toBe(false);

    await page.goto("/app/settings/notifications");
    await expect(page.getByRole("heading", { name: "Notificações" })).toBeVisible();

    // 1 · O aviso do estado certo aparece, e o do outro estado NÃO.
    const aviso = page.getByTestId("push-status-faltando-chaves");
    await expect(aviso).toBeVisible();
    await expect(page.getByTestId("push-status-pronto")).toHaveCount(0);

    // 2 · Ele diz o LIMITE em português, não em jargão de variável.
    await expect(aviso).toContainText(/só aparecem com o site aberto/i);

    // 3 · E diz O QUE FAZER — o comando e as duas chaves, nominalmente.
    //     Um aviso que só informa a falta deixa o operador sem saída: ele
    //     descobre que está quebrado e continua sem saber o que fazer.
    await expect(aviso).toContainText("npx web-push generate-vapid-keys");
    await expect(aviso).toContainText("VAPID_PUBLIC_KEY");
    await expect(aviso).toContainText("VAPID_PRIVATE_KEY");
    await expect(aviso).toContainText(/\.env/);

    await captura(page, "01-aviso-sem-chaves");
  });

  test("sem VAPID a tela mantém o controle de Push e explica por que ele está travado", async ({
    page,
  }) => {
    // ⚠️ ESTE CASO JÁ AFIRMOU O QUE NÃO DAVA PARA AFIRMAR AQUI, e a correção
    // veio de uma medição, não de uma opinião.
    //
    // Ele nasceu com `toBeEnabled()`, para impedir o conserto exagerado —
    // desabilitar o interruptor por falta de VAPID tiraria capacidade que a
    // instalação TEM, porque o aviso com a aba ABERTA não depende de inscrição.
    // A intenção estava certa; o lugar, não.
    //
    // MEDIDO no Chromium do Playwright, contra um servidor HTTP local:
    //
    //     baseline headless                            -> denied
    //     grant com origin explícito                   -> denied
    //     grantPermissions(["notifications"]) sem origin-> denied
    //     headless:false + grant                       -> granted
    //
    // `Notification.permission` é **denied em headless, sempre** — e o CI roda
    // headless. Como `_client.tsx` desabilita por `denied || unsupported`, o
    // controle está travado ali por um motivo que nada tem a ver com VAPID, e
    // nenhuma permissão concedida muda isso. A primeira versão passou só porque
    // ganhava a corrida contra a hidratação; fechada a janela, ela passaria a
    // falhar sempre — e com razão.
    //
    // A propriedade "VAPID ausente não desabilita o Push" mudou para onde ela é
    // MENSURÁVEL: `tests/unit/permissao-lida-no-primeiro-render.test.tsx`
    // renderiza com `granted` e sem VAPID nenhum, e cobra o controle habilitado.
    //
    // O que sobra aqui é o que a tela de fato mostra neste ambiente, e não é
    // pouco: o controle CONTINUA NA TELA (não foi escondido), e a pessoa recebe
    // o motivo de ele estar travado em vez de um interruptor morto e mudo.
    const quem = creds.users[PAPEL_SEM_MFA]!;
    await login(page, quem.email, creds.password);
    await page.goto("/app/settings/notifications");

    const linhaMensagem = page.getByRole("row", { name: /Nova mensagem/i });
    const interruptorPush = linhaMensagem.getByRole("switch", { name: /via push/i });

    // 1 · O controle não sumiu da tela por falta de VAPID.
    await expect(interruptorPush).toBeVisible();

    // 2 · E a tela diz POR QUE ele está travado — o navegador, não a instalação.
    //     Sem esta linha o usuário encara um interruptor que não responde e não
    //     tem como saber de quem é a culpa.
    await expect(
      linhaMensagem,
      "o Push está travado pelo navegador e a tela não explica o motivo",
    ).toContainText(/navegador bloqueou as notificações/i);

    // 3 · E o aviso de VAPID continua sendo o outro assunto, na mesma tela: um
    //     não substitui o outro, e é a soma que deixa o operador saber de quem
    //     é cada metade do problema.
    await expect(page.getByTestId("push-status-faltando-chaves")).toBeVisible();

    await captura(page, "02-controle-presente-com-motivo");
  });
});
