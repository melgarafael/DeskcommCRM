/**
 * A PAUSA ANTES DE O FLUXO DE SILÊNCIO RECOMEÇAR, configurada pela tela.
 *
 * Pedido de uma loja que vende pelo WhatsApp (26/09/2026): o fluxo de silêncio
 * de 1 hora recomeçava do primeiro passo uma hora depois de cada "gracias" do
 * cliente. A pausa (`trigger_config.params.reentry_pause_minutes`) é o que a
 * varredura respeita — e só vale se a tela a grava e a PRESERVA: o formulário do
 * gatilho remonta os `params` a partir dos campos, então um campo que a tela não
 * conhecesse sumiria no primeiro "Salvar gatilho", com toast de sucesso.
 *
 * Esta spec dirige a tela: abre o fluxo, põe 48 horas no campo novo, salva, e
 * prova no banco que o gatilho guardou 2880 minutos; depois edita OUTRO campo e
 * prova que a pausa sobreviveu; por fim zera e prova que a chave saiu.
 */
import { expect, test } from "./helpers/test";
import { admin, captura, creds, insere, login, registra, type Creds } from "./qa-l12-comum";

const SUFIXO = `${Date.now()}`.slice(-7);

let c: Creds;
let fluxoId = "";

async function gatilhoGravado(): Promise<Record<string, unknown>> {
  const { data } = await admin.from("followup_flow_pointers").select("trigger_config").eq("id", fluxoId).single();
  return (data as { trigger_config: Record<string, unknown> }).trigger_config;
}

test.describe("Pausa de reentrada do gatilho de silêncio", () => {
  test.describe.configure({ timeout: 300_000 });

  test.beforeAll(async () => {
    c = creds();
    fluxoId = await insere("followup_flow_pointers", {
      organization_id: c.org_id,
      name: `Remarketing pausa ${SUFIXO}`,
      trigger_config: { kind: "silence", params: { threshold_minutes: 60 }, cancel_on_reply: true },
    });
  });

  test.afterAll(async () => {
    if (fluxoId) await admin.from("followup_flow_pointers").delete().eq("id", fluxoId);
  });

  test("põe 48 horas de pausa, a pausa sobrevive a outra edição, e zerar a tira", async ({ page }) => {
    await login(page, c.users.manager!.email, c.password);
    await page.goto(`/app/ai/followups/${fluxoId}`);

    const botao = page.getByTestId("trigger-config-button");
    await expect(botao).toBeVisible({ timeout: 60_000 });
    await expect(botao).toHaveText(/Silêncio \(60 min\)/);

    await botao.click();
    const painel = page.getByTestId("trigger-config-panel");
    const pausa = painel.getByTestId("trigger-reentry-pause");
    await expect(pausa).toHaveValue("0");
    await pausa.fill("48");
    await captura(page, "pausa-01-campo-preenchido");
    await painel.getByTestId("trigger-config-save").click();

    await expect(botao).toHaveText(/pausa de 48 h/, { timeout: 30_000 });
    await expect.poll(async () => (await gatilhoGravado()).params).toMatchObject({ reentry_pause_minutes: 2880 });
    registra(`pausa · gravado = ${JSON.stringify(await gatilhoGravado())}`);
    await captura(page, "pausa-02-rotulo-com-pausa");

    // Editar OUTRO campo não pode apagar a pausa.
    await botao.click();
    await expect(pausa).toHaveValue("48");
    await painel.locator("#trigger-threshold").fill("90");
    await painel.getByTestId("trigger-config-save").click();
    await expect(botao).toHaveText(/90 min · pausa de 48 h/, { timeout: 30_000 });
    await expect
      .poll(async () => (await gatilhoGravado()).params)
      .toMatchObject({ threshold_minutes: 90, reentry_pause_minutes: 2880 });

    // Zerar tira a chave: sem pausa é o comportamento de antes.
    await botao.click();
    await pausa.fill("0");
    await painel.getByTestId("trigger-config-save").click();
    await expect(botao).not.toHaveText(/pausa/, { timeout: 30_000 });
    await expect
      .poll(async () => Object.keys((await gatilhoGravado()).params as Record<string, unknown>))
      .not.toContain("reentry_pause_minutes");
    registra(`pausa · depois de zerar = ${JSON.stringify(await gatilhoGravado())}`);
  });

  test("o teto do silêncio: recusa um teto menor que o mínimo, e grava e mostra a faixa", async ({ page }) => {
    await login(page, c.users.manager!.email, c.password);
    await page.goto(`/app/ai/followups/${fluxoId}`);
    const botao = page.getByTestId("trigger-config-button");
    await expect(botao).toBeVisible({ timeout: 60_000 });

    await botao.click();
    const painel = page.getByTestId("trigger-config-panel");
    await painel.locator("#trigger-threshold").fill("10");
    const teto = painel.getByTestId("trigger-max-silence");
    await teto.fill("5");
    await expect(painel.getByText("Precisa ser maior que o mínimo e no máximo 10080 (7 dias).")).toBeVisible();
    await expect(painel.getByTestId("trigger-config-save")).toBeDisabled();

    await teto.fill("60");
    // Com 10 e 60 nada está inválido: a borda de erro some dos dois campos.
    await expect(teto).toHaveAttribute("aria-invalid", "false");
    await expect(painel.locator("#trigger-threshold")).toHaveAttribute("aria-invalid", "false");
    await expect(painel.getByTestId("trigger-config-save")).toBeEnabled();
    await captura(page, "silencio-01-teto-de-60");
    await painel.getByTestId("trigger-config-save").click();
    await expect(botao).toHaveText(/10–60 min/, { timeout: 30_000 });
    await expect
      .poll(async () => (await gatilhoGravado()).params)
      .toMatchObject({ threshold_minutes: 10, max_silence_minutes: 60 });
    registra(`teto · gravado = ${JSON.stringify(await gatilhoGravado())}`);
  });

  test("a pausa contada do último envio: liga, grava a base, e desligar a tira", async ({ page }) => {
    // Um toque curto "no máximo 1× por dia": contada da última mensagem, a pausa
    // de 24 h não se cumpriria nunca dentro de um teto de 60 min.
    await login(page, c.users.manager!.email, c.password);
    await page.goto(`/app/ai/followups/${fluxoId}`);
    const botao = page.getByTestId("trigger-config-button");
    await expect(botao).toBeVisible({ timeout: 60_000 });

    await botao.click();
    const painel = page.getByTestId("trigger-config-panel");
    const pausa = painel.getByTestId("trigger-reentry-pause");
    const base = painel.getByTestId("trigger-pause-basis");
    await pausa.fill("0");
    // Sem pausa, a escolha da base não existe.
    await expect(base).toHaveCount(0);
    await pausa.fill("24");
    await expect(base).toBeVisible();
    await expect(base).not.toBeChecked();
    await base.click();
    await expect(base).toBeChecked();
    await captura(page, "pausa-03-base-do-ultimo-envio");
    await painel.getByTestId("trigger-config-save").click();

    await expect(botao).toHaveText(/no máximo 1× a cada 24 h/, { timeout: 30_000 });
    await expect
      .poll(async () => (await gatilhoGravado()).params)
      .toMatchObject({ reentry_pause_minutes: 1440, reentry_pause_basis: "ultimo_envio" });
    registra(`base · gravado = ${JSON.stringify(await gatilhoGravado())}`);

    // Reabrir mostra a escolha gravada; desligar volta à base padrão e tira a chave.
    await botao.click();
    await expect(base).toBeChecked();
    await base.click();
    await painel.getByTestId("trigger-config-save").click();
    await expect(botao).toHaveText(/pausa de 24 h/, { timeout: 30_000 });
    await expect
      .poll(async () => Object.keys((await gatilhoGravado()).params as Record<string, unknown>))
      .not.toContain("reentry_pause_basis");
  });
});
