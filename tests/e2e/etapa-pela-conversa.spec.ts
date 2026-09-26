/**
 * MOVER O NEGÓCIO DE ETAPA SEM SAIR DA CONVERSA.
 *
 * Pedido de uma loja que vende pelo WhatsApp (26/09/2026): o cliente confirma o
 * pedido na conversa e, para passá-lo a "Pedido confirmado", quem atende tinha de
 * sair do Inbox, abrir o quadro do funil, achar o card e arrastá-lo. O painel da
 * conversa mostrava o negócio ("Funil · Etapa") e não deixava mudá-lo.
 *
 * Esta spec dirige a TELA: abre a conversa, usa o seletor "Etapa do funil" do
 * bloco "Leads recentes" e prova no banco que o negócio mudou de etapa pelo MESMO
 * caminho do quadro (atividade `stage_changed` gravada). Etapa de perda não é
 * oferecida — ela pede motivo, e esse diálogo mora no quadro.
 */
import { randomInt, randomUUID } from "node:crypto";

import { expect, test } from "./helpers/test";
import { abreConversa, admin, captura, creds, insere, login, registra, type Creds } from "./qa-l12-comum";

const SUFIXO = `${Date.now()}`.slice(-7);

let c: Creds;
let conversaId = "";
let funilId = "";
let leadId = "";
let etapaDados = "";
let etapaConfirmado = "";

test.describe("Etapa do negócio pela conversa", () => {
  test.describe.configure({ timeout: 300_000 });

  test.beforeAll(async () => {
    c = creds();
    const contatoId = await insere("contacts", {
      organization_id: c.org_id,
      name: `Cliente Etapa ${SUFIXO}`,
      phone_number: `+5511${randomInt(100000000, 1000000000)}`,
    });
    const canal = await insere("channel_sessions", {
      organization_id: c.org_id,
      waha_session_name: `qa-etapa-${randomUUID()}`,
      display_name: "Canal QA etapa",
      status: "WORKING",
      webhook_secret_encrypted: "\\x00",
    });
    conversaId = await insere("conversations", {
      organization_id: c.org_id,
      contact_id: contatoId,
      channel_session_id: canal,
      status: "open",
    });
    await insere("messages", {
      organization_id: c.org_id,
      contact_id: contatoId,
      conversation_id: conversaId,
      channel_session_id: canal,
      direction: "inbound",
      type: "text",
      status: "received",
      sent_via: "ai",
      body: "Sí, confirmado",
      sent_at: new Date().toISOString(),
    });

    funilId = await insere("crm_pipelines", {
      organization_id: c.org_id,
      name: `Pedidos ${SUFIXO}`,
      slug: `qa-etapa-${SUFIXO}`,
    });
    etapaDados = await insere("crm_stages", {
      organization_id: c.org_id,
      pipeline_id: funilId,
      name: "Datos incompletos",
      slug: `datos-${SUFIXO}`,
      position: 1000,
    });
    etapaConfirmado = await insere("crm_stages", {
      organization_id: c.org_id,
      pipeline_id: funilId,
      name: "Pedido confirmado",
      slug: `confirmado-${SUFIXO}`,
      position: 2000,
    });
    await insere("crm_stages", {
      organization_id: c.org_id,
      pipeline_id: funilId,
      name: "Cancelado",
      slug: `cancelado-${SUFIXO}`,
      position: 3000,
      is_lost: true,
    });
    leadId = await insere("crm_leads", {
      organization_id: c.org_id,
      pipeline_id: funilId,
      stage_id: etapaDados,
      contact_id: contatoId,
      title: `Pedido ${SUFIXO}`,
      position_in_stage: 1000,
      source: "manual",
    });
  });

  test.afterAll(async () => {
    if (funilId) {
      await admin.from("crm_lead_activities").delete().eq("pipeline_id", funilId);
      await admin.from("crm_leads").delete().eq("pipeline_id", funilId);
      await admin.from("crm_stages").delete().eq("pipeline_id", funilId);
      await admin.from("crm_pipelines").delete().eq("id", funilId);
    }
    await admin.from("contacts").delete().like("name", `%${SUFIXO}%`);
  });

  test("o cliente confirma na conversa e o negócio vai a «Pedido confirmado» pelo painel", async ({ page }) => {
    await login(page, c.users.manager!.email, c.password);
    await abreConversa(page, conversaId);
    await expect(page.getByText(`Cliente Etapa ${SUFIXO}`).first()).toBeVisible({ timeout: 60_000 });

    const bloco = page.locator('[data-testid="inbox-etapa-do-negocio"]');
    await expect(bloco).toBeVisible({ timeout: 30_000 });
    const seletor = bloco.getByTestId("inbox-etapa-select");
    await expect(seletor).toContainText("Datos incompletos");
    await captura(page, "etapa-01-seletor-na-conversa");

    await seletor.click();
    const opcoes = page.getByRole("option");
    await expect(opcoes.filter({ hasText: "Pedido confirmado" })).toBeVisible();
    // Perda pede motivo: fica no quadro, não aqui.
    await expect(opcoes.filter({ hasText: "Cancelado" })).toHaveCount(0);
    registra(`etapa · opções = ${JSON.stringify(await opcoes.allInnerTexts())}`);
    await captura(page, "etapa-02-opcoes");

    const resposta = page.waitForResponse((r) => r.url().includes("/api/v1/leads/bulk") && r.request().method() === "POST");
    await opcoes.filter({ hasText: "Pedido confirmado" }).click();
    const r = await resposta;
    registra(`etapa · POST /api/v1/leads/bulk = ${r.status()}`);
    expect(r.status()).toBe(200);

    await expect
      .poll(async () => {
        const { data } = await admin.from("crm_leads").select("stage_id").eq("id", leadId).single();
        return (data as { stage_id: string }).stage_id;
      })
      .toBe(etapaConfirmado);
    const { data: atividades } = await admin
      .from("crm_lead_activities")
      .select("type, payload")
      .eq("lead_id", leadId)
      .eq("type", "stage_changed");
    registra(`etapa · atividades stage_changed = ${JSON.stringify(atividades)}`);
    expect((atividades ?? []).length).toBeGreaterThan(0);

    // A tela relê o resumo: o seletor e a linha "Funil · Etapa" dizem a etapa nova.
    await expect(seletor).toContainText("Pedido confirmado", { timeout: 30_000 });
    await expect(page.locator('[data-testid="inbox-campos-lead"]')).toContainText(`Pedidos ${SUFIXO} · Pedido confirmado`);
    await captura(page, "etapa-03-movido");
  });
});
