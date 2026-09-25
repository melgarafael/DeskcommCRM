/**
 * A CREDENCIAL DO GOOGLE, CADASTRADA PELA TELA — sem SSH, sem editar `.env`.
 *
 * ═══ POR QUE ESTA SPEC EXISTE (issue #370) ═══
 *
 * `/admin/google` (PR #369) entrou sem prova pela tela: o defeito que ela
 * fecha era justamente de UX para quem não programa — o cartão da Agenda
 * mandava editar `GOOGLE_CALENDAR_CLIENT_ID`/`_SECRET` por SSH na VPS.
 * Consertar um problema de leigo sem provar que um leigo consegue usar o
 * conserto deixa o buraco no mesmo lugar, só mais fundo (DoD 12).
 *
 * `tests/invariants/credencial-do-google-e-server-side.test.ts` prova que
 * `platform_google_oauth` é ilegível pelo PostgREST; `tests/unit/agenda-
 * google-credencial-do-banco.test.ts` prova a resolução. Nenhum dos dois
 * dirige um navegador — é a metade que falta.
 *
 * ═══ A ASSERÇÃO CENTRAL, E POR QUE NÃO É DETALHE DE UI ═══
 *
 * O `client_secret` é o que permite trocar códigos e refresh tokens EM NOME
 * DESTA INSTALAÇÃO — isto é, ler a agenda de todos os atendentes que
 * conectaram. `_form.tsx` nunca recebe o valor de volta do servidor (só um
 * booleano, `temSegredoSalvo`); o caso (1) abaixo prova isso pela TELA — o
 * campo vazio depois de recarregar, e o HTML servido sem o segredo em
 * lugar nenhum — porque é a garantia que o comentário do componente promete
 * e que só um teste que TENTA ler de volta pode furar.
 *
 * ═══ QUEM É QUEM ═══
 *
 * O objeto é a INSTALAÇÃO, não a organização (mesmo argumento de `/admin/
 * marca`): só o DONO DO SERVIDOR (`platform_admins`) alcança `/admin/google`.
 * Um admin de TENANT que tentar entrar cai no gate de `requirePlatformAdmin()`
 * — `redirect("/admin/forbidden")` — antes de a página rodar (caso 2).
 *
 * ═══ O QUE ESTA SPEC NÃO PROVA ═══
 *
 *  - A instalação SEM chave mestra de cifra (`private.app_secrets` sem
 *    `nuvemshop_oauth_key`): o CI grava essa chave para o banco do e2e inteiro
 *    (`.github/workflows/e2e.yml`), e desarmá-la aqui contaminaria as outras
 *    specs de Google que compartilham o mesmo banco sem reset. Fica registrado
 *    na issue como caso adjacente, não como bloqueio deste PR.
 *  - A troca de código por token contra o Google de verdade (webjs/consentimento)
 *    — isso é `agenda-google-volta-do-consentimento.spec.ts` e irmãs.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";

import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";
import { lerCreds, loginComoAdmin, loginComoDono } from "./helpers/login-admin";
import { afirmarDonoDoServidor } from "./utils/precondicao";

const CLIENT_ID_DE_TESTE = "000000000000-e2e370testecredencial.apps.googleusercontent.com";
const CLIENT_SECRET_DE_TESTE = "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ade";

const { url, serviceRole } = credenciaisSupabaseDeTeste();
const admin = createClient(url, serviceRole, { auth: { autoRefreshToken: false, persistSession: false } });

const EVIDENCIA = path.join(process.cwd(), "evidence", "admin-credencial-google");
function evidencia(nome: string): string {
  fs.mkdirSync(EVIDENCIA, { recursive: true });
  return path.join(EVIDENCIA, nome);
}

/**
 * Apaga a linha singleton — a PRECONDIÇÃO que este arquivo monta para si
 * mesmo, e a limpeza que devolve o banco compartilhado ao estado anterior.
 * Sem isto o caso (1) reprovaria numa segunda execução ("já cadastrada" em
 * vez de "não cadastrada"), e as duas leituras (`configuracaoDoGoogle()`
 * memoizado por processo) ficariam com uma linha que nenhuma outra spec
 * escreveu.
 */
async function limparCredencial(): Promise<void> {
  const { error } = await admin.from("platform_google_oauth").delete().eq("id", 1);
  if (error) throw new Error(`limparCredencial: ${error.message}`);
}

test.describe("Credencial do Google da instalação, pela tela (#370)", () => {
  test.beforeAll(async () => {
    await afirmarDonoDoServidor(lerCreds().users.dono!.email);
  });

  test.afterAll(async () => {
    await limparCredencial();
  });

  test("(1) o dono cadastra pela tela, o segredo não volta, e o cartão da Agenda para de pedir SSH", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await limparCredencial();
    await loginComoDono(page, lerCreds());

    // ── Estado inicial: nada cadastrado, nada no .env (o CI não define
    // GOOGLE_CALENDAR_CLIENT_ID/_SECRET) ────────────────────────────────────
    await page.goto("/admin/google");
    await expect(page.getByRole("heading", { name: /google agenda desta instalação/i })).toBeVisible();
    await expect(page.locator("#client-id")).toHaveValue("");
    await expect(
      page.getByTestId("google-tem-no-ambiente"),
      "o .env não deveria ter credencial nesta instalação de teste",
    ).toHaveCount(0);
    await expect(page.getByText(/nunca configurado por aqui/i)).toBeVisible();
    await expect(page.getByTestId("google-salvar")).toBeDisabled();
    await page.screenshot({ path: evidencia("1-nao-cadastrada.png"), fullPage: true });

    // ── Cadastro pela tela ───────────────────────────────────────────────────
    await page.getByTestId("google-client-id").fill(CLIENT_ID_DE_TESTE);
    await page.getByTestId("google-client-secret").fill(CLIENT_SECRET_DE_TESTE);
    await expect(page.getByTestId("google-salvar")).toBeEnabled();
    await page.getByTestId("google-salvar").click();
    await expect(page.getByText(/credenciais do google salvas/i)).toBeVisible({ timeout: 15_000 });

    // ── A ASSERÇÃO CENTRAL: o segredo NÃO volta, nem recarregando ───────────
    await page.reload();
    await expect(page.getByText(/nunca configurado por aqui/i)).toHaveCount(0);
    await expect(page.locator("#client-id")).toHaveValue(CLIENT_ID_DE_TESTE);
    await expect(
      page.locator("#client-secret"),
      "o client_secret voltou preenchido — ele nunca deve ser devolvido pelo servidor",
    ).toHaveValue("");
    await expect(page.getByPlaceholder(/já cadastrada/i)).toBeVisible();
    await page.screenshot({ path: evidencia("2-cadastrada-segredo-nao-volta.png"), fullPage: true });

    const html = await page.content();
    expect(
      html.includes(CLIENT_SECRET_DE_TESTE),
      "o client_secret inteiro apareceu no HTML servido — ele nunca deve chegar ao navegador",
    ).toBe(false);

    // ── O efeito visível para quem atende: o cartão da Agenda para de pedir
    // SSH e passa a oferecer "Conectar Google" ──────────────────────────────
    await page.goto("/app/agenda");
    // A rota tem `loading.tsx` (Suspense do App Router): medido nesta spec,
    // `getByTestId("conectar-google")` resolve a DOIS elementos por uma janela
    // curta logo após `goto` — uma cópia com `hidden` num ancestral, da
    // hidratação do streaming ainda assentando. `networkidle` espera esse
    // assentamento antes de medir; sem ele, a asserção de visibilidade reprova
    // por "strict mode violation" pegando o instante errado.
    await page.waitForLoadState("networkidle");
    await expect(
      page.getByTestId("google-nao-configurado"),
      "o cartão da Agenda continuou dizendo que falta configurar, depois do cadastro pela tela",
    ).toHaveCount(0);
    await expect(page.getByTestId("conectar-google")).toHaveCount(1);
    await expect(page.getByTestId("conectar-google")).toBeVisible();
    await page.screenshot({ path: evidencia("3-cartao-da-agenda-oferece-conectar.png"), fullPage: true });
  });

  test("(2) administrador de ORGANIZAÇÃO não alcança /admin/google — cai no gate antes da página", async ({
    page,
  }) => {
    // Único caso com login fresco (papel outro): paga a janela do TOTP.
    test.setTimeout(90_000);
    await loginComoAdmin(page, lerCreds());

    await page.goto("/admin/google");
    // `requirePlatformAdmin()` redireciona para `/admin/forbidden` ANTES de a
    // página rodar `notFound()` — o gate do layout, não o da página, é quem
    // decide para quem não é dono do servidor.
    await expect(page).toHaveURL(/\/admin\/forbidden/);
    await expect(page.getByRole("heading", { name: /acesso negado/i })).toBeVisible();
  });
});
