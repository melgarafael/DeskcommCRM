/**
 * AVISO À EQUIPE PELO NÚMERO OFICIAL, COM MODELO APROVADO (migration 9094) — pela tela.
 *
 * O caso que esta spec prova é o de quem só tem o número oficial estável: antes,
 * a tela "Aviso no WhatsApp" nem oferecia esse número, e o aviso à equipe nunca
 * saía. Agora ele aparece no seletor marcado "só modelo aprovado", a tela pede o
 * modelo (e mostra o texto que vai sair), salva, e o teste passa da barreira do
 * canal — a recusa que sobra é a do ambiente (o endereço público desta bancada),
 * a mesma de qualquer conexão.
 *
 * E o modelo que deixa de servir (voltou para revisão na plataforma) trava o
 * aviso com uma frase que diz o que fazer.
 *
 * Os dados são sintéticos: uma conexão oficial semeada pelo service role, sem
 * rede nenhuma — o teste é recusado ANTES do transporte, então nenhum provedor
 * é chamado e não há dublê a subir.
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { createClient } from "@supabase/supabase-js";

import { carregarEnvLocal } from "../../scripts/lib/env-de-teste";
import { lerCreds, loginComoAdmin, type CredsE2E } from "./helpers/login-admin";
import { expect, test, type Page } from "./helpers/test";

const ESPERA = 60_000;
const EVIDENCIA = path.join(process.cwd(), "evidence", "aviso-pelo-numero-oficial");
const SUFIXO = String(Date.now()).slice(-6);
const SESSAO = randomUUID();
const MODELO = randomUUID();
const MODELO_DUAS_VARIAVEIS = randomUUID();
const NOME_DA_CONEXAO = `Número oficial E2E ${SUFIXO}`;
const NOME_DO_MODELO = `aviso_equipe_e2e_${SUFIXO}`;
const CORPO_DO_MODELO = "🔔 Aviso da equipe\n\n{{1}}\n\nAbra o CRM para ver o detalhe.";
/** Um número que não é contato nem conexão desta organização. */
const NUMERO_DA_EQUIPE = `+55319000${SUFIXO.slice(-5)}`;

type Creds = CredsE2E & { org_id: string };

const env = carregarEnvLocal();
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function captura(page: Page, nome: string): Promise<void> {
  fs.mkdirSync(EVIDENCIA, { recursive: true });
  await page.screenshot({ path: path.join(EVIDENCIA, `${nome}.png`), fullPage: true });
}

test.describe("aviso à equipe pelo número oficial", () => {
  let creds = lerCreds() as Creds;

  test.beforeAll(async () => {
    // Uma configuração deixada por outra spec mudaria o que o formulário mostra.
    await admin.from("config_aviso_de_caso").delete().eq("organization_id", creds.org_id);
    const sessao = await admin.from("channel_sessions").insert({
      id: SESSAO,
      organization_id: creds.org_id,
      provider: "meta_cloud",
      meta_phone_number_id: `e2e-aviso-${SUFIXO}`,
      meta_waba_id: `e2e-conta-${SUFIXO}`,
      display_name: NOME_DA_CONEXAO,
      webhook_secret_encrypted: "\\x00",
      status: "WORKING",
    });
    if (sessao.error) throw sessao.error;
    const modelos = await admin.from("meta_templates").insert([
      {
        id: MODELO,
        organization_id: creds.org_id,
        channel_session_id: SESSAO,
        waba_id: `e2e-conta-${SUFIXO}`,
        name: NOME_DO_MODELO,
        language: "pt_BR",
        status: "APPROVED",
        components: [{ type: "BODY", text: CORPO_DO_MODELO }],
        contract_hash: "",
      },
      {
        // Duas variáveis: o aviso não tem como ser repartido — a tela não oferece.
        id: MODELO_DUAS_VARIAVEIS,
        organization_id: creds.org_id,
        channel_session_id: SESSAO,
        waba_id: `e2e-conta-${SUFIXO}`,
        name: `aviso_duas_variaveis_${SUFIXO}`,
        language: "pt_BR",
        status: "APPROVED",
        components: [{ type: "BODY", text: "Oi {{1}}, aviso: {{2}}." }],
        contract_hash: "",
      },
    ]);
    if (modelos.error) throw modelos.error;
  });

  test.afterAll(async () => {
    await admin.from("config_aviso_de_caso").delete().eq("organization_id", creds.org_id);
    await admin.from("meta_templates").delete().in("id", [MODELO, MODELO_DUAS_VARIAVEIS]);
    await admin.from("channel_sessions").delete().eq("id", SESSAO);
  });

  test("escolhe o número oficial, o modelo, salva — e o modelo que sai de vigor trava o aviso", async ({
    page,
  }) => {
    test.setTimeout(300_000);
    creds = { ...creds, ...(await loginComoAdmin(page, creds)) };
    await page.goto("/app/ai/cases/avisos");
    await expect(page.getByRole("heading", { name: "Aviso no WhatsApp" })).toBeVisible({ timeout: ESPERA });

    // ─── 1. o número oficial aparece, marcado pelo que ele faz ──────────────
    await page.locator("#telefone").fill(NUMERO_DA_EQUIPE);
    await page.locator("#conexao").click();
    const opcao = page.getByRole("option", { name: `${NOME_DA_CONEXAO} · só modelo aprovado` });
    await expect(opcao, "o número oficial com modelo aprovado tem de ser oferecido").toBeVisible({
      timeout: ESPERA,
    });
    await opcao.click();

    // ─── 2. a tela pede o modelo e mostra o texto que vai sair ──────────────
    const bloco = page.getByTestId("bloco-do-modelo");
    await expect(bloco).toBeVisible();
    // Um só modelo serve, então ele já vem escolhido; o de duas variáveis não entra.
    await expect(page.getByTestId("previa-do-modelo")).toContainText("{{1}}");
    await page.locator("#modelo").click();
    await expect(page.getByRole("option")).toHaveCount(1);
    await expect(page.getByRole("option").first()).toContainText(NOME_DO_MODELO);
    await page.keyboard.press("Escape");
    await expect(bloco).toContainText("Cada aviso é uma mensagem cobrada");
    await captura(page, "10-oficial-com-modelo");

    // ─── 3. salva, e o banco guarda o modelo DESTA conexão ──────────────────
    await page.getByRole("button", { name: /^Salvar$/ }).click();
    await expect(page.getByText("Aviso salvo.").first()).toBeVisible({ timeout: ESPERA });
    const salvo = await admin
      .from("config_aviso_de_caso")
      .select("channel_session_id, modelo_id")
      .eq("organization_id", creds.org_id)
      .single();
    expect(salvo.data).toEqual({ channel_session_id: SESSAO, modelo_id: MODELO });

    await page.reload();
    await expect(page.getByTestId("previa-do-modelo"), "o modelo salvo volta na tela").toContainText(
      "Aviso da equipe",
      { timeout: ESPERA },
    );
    await expect(page.getByTestId("alerta-oficial_sem_modelo")).toHaveCount(0);
    await captura(page, "20-salvo");

    // ─── 4. o teste passa da barreira do canal ──────────────────────────────
    //
    // Antes, a recusa era "só envia mensagens aprovadas". Agora o modelo leva o
    // aviso, e o que recusa é o ambiente desta bancada (sem endereço público),
    // o mesmo de qualquer conexão — antes de qualquer chamada ao provedor.
    // A frase vem do TOAST da resposta, e não do bloco de alertas (que diz a
    // mesma coisa com outras palavras e está sempre na tela nesta bancada).
    await page.getByRole("button", { name: /Enviar aviso de teste/ }).click();
    const resposta = page.locator("[data-sonner-toast]").last();
    await expect(resposta).toBeVisible({ timeout: ESPERA });
    await expect(resposta).toContainText(/ainda não tem um endereço público/i);
    await expect(resposta).not.toContainText(/só envia mensagens aprovadas/i);
    await captura(page, "30-teste-passa-do-canal");

    // ─── 5. o modelo volta para revisão: o aviso trava, e diz o que fazer ───
    const revisao = await admin.from("meta_templates").update({ status: "PENDING" }).eq("id", MODELO);
    expect(revisao.error?.message ?? null).toBeNull();
    await page.reload();
    const trava = page.getByTestId("alerta-oficial_sem_modelo");
    await expect(trava).toBeVisible({ timeout: ESPERA });
    await expect(trava).toHaveAttribute("data-bloqueia", "sim");
    await expect(trava).toContainText("modelo dela com uma variável");
    // A conexão salva continua no seletor, e o bloco do modelo diz o que falta.
    await expect(page.locator("#conexao")).toContainText(NOME_DA_CONEXAO);
    await expect(page.getByTestId("conexao-sem-modelo")).toBeVisible();
    await expect(page.getByRole("button", { name: /^Salvar$/ })).toBeDisabled();
    await expect(page.getByRole("switch", { name: "Receber avisos no WhatsApp" })).toBeDisabled();
    await captura(page, "40-modelo-em-revisao-trava");

    // ─── 6. no telefone, sem rolagem para o lado ────────────────────────────
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(400);
    const rolagem = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(rolagem, "em 390px a tela do aviso não pode rolar para o lado").toBeLessThanOrEqual(0);
    await captura(page, "50-telefone");
  });
});
