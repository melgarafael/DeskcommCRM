/**
 * QA VISUAL DO LOTE 12 — #936, LEVAR O NEGÓCIO PARA OUTRO FUNIL.
 *
 * ⚠️ NÃO HÁ BOTÃO. O próprio fragmento do lote declara: "por enquanto pela API
 * (`POST /api/v1/leads/[id]/clone`); o botão no quadro vem na fatia seguinte".
 * O que se prova pela TELA, então, são os EFEITOS — e é o que esta spec faz:
 * o card no funil de destino, os campos personalizados nele, e as duas linhas
 * do tempo. A chamada sai do próprio navegador logado, com o cookie de sessão,
 * que é o mesmo caminho que o botão vai usar.
 */
import { test } from "@playwright/test";

import {
  admin,
  captura,
  creds,
  expect,
  insere,
  login,
  registra,
  type Creds,
} from "./qa-l12-comum";

const S = `${Date.now()}`.slice(-6);

let c: Creds;
let origemId = "";
let destinoId = "";
let etapaOrigem = "";
let etapaDestino = "";
let leadId = "";

test.describe("Lote 12 — #936 a troca de funil", () => {
  test.describe.configure({ timeout: 420_000 });

  test.beforeAll(async () => {
    test.setTimeout(420_000);
    c = creds();
    // O DESTINO declara os MESMOS campos personalizados que a origem — sem
    // isso o valor fica na linha e some da tela, e o teste mediria outra coisa.
    const campos = [
      { key: "orcamento", label: "Orçamento", type: "text" },
      { key: "bairro", label: "Bairro", type: "text" },
    ];
    origemId = await insere("crm_pipelines", {
      organization_id: c.org_id,
      name: `Troca Origem ${S}`,
      slug: `troca-origem-${S}`,
      settings: { fields: campos, lost_reasons: [] },
    });
    destinoId = await insere("crm_pipelines", {
      organization_id: c.org_id,
      name: `Troca Destino ${S}`,
      slug: `troca-destino-${S}`,
      settings: { fields: campos, lost_reasons: [] },
    });
    etapaOrigem = await insere("crm_stages", {
      organization_id: c.org_id,
      pipeline_id: origemId,
      name: "Aberto",
      slug: `aberto-o-${S}`,
      position: 1000,
    });
    // A origem PRECISA de etapa de perda — é ali que o negócio é encerrado.
    await insere("crm_stages", {
      organization_id: c.org_id,
      pipeline_id: origemId,
      name: "Perdido",
      slug: `perdido-o-${S}`,
      position: 2000,
      is_lost: true,
    });
    etapaDestino = await insere("crm_stages", {
      organization_id: c.org_id,
      pipeline_id: destinoId,
      name: "Entrada",
      slug: `entrada-d-${S}`,
      position: 1000,
    });
    await insere("crm_stages", {
      organization_id: c.org_id,
      pipeline_id: destinoId,
      name: "Perdido",
      slug: `perdido-d-${S}`,
      position: 2000,
      is_lost: true,
    });
    leadId = await insere("crm_leads", {
      organization_id: c.org_id,
      pipeline_id: origemId,
      stage_id: etapaOrigem,
      title: `Negócio ${S}`,
      position_in_stage: 1000,
      source: "manual",
      custom_fields: { orcamento: "R$ 42.000", bairro: "Savassi" },
    });
  });

  test.afterAll(async () => {
    test.setTimeout(420_000);
    for (const p of [origemId, destinoId]) {
      if (!p) continue;
      await admin.from("crm_lead_activities").delete().eq("pipeline_id", p);
      await admin.from("crm_leads").delete().eq("pipeline_id", p);
      await admin.from("crm_stages").delete().eq("pipeline_id", p);
      await admin.from("crm_pipelines").delete().eq("id", p);
    }
  });

  test("o negócio chega ao outro funil com os campos personalizados, e as DUAS linhas do tempo contam", async ({
    page,
  }) => {
    await login(page, c.users.manager!.email, c.password);

    // Estado de partida, pela tela.
    await page.goto(`/app/pipelines/${origemId}`);
    await expect(page.getByRole("group", { name: `Lead: Negócio ${S}` })).toBeVisible({
      timeout: 60_000,
    });
    await captura(page, "936-01-origem-antes");

    // A chamada sai do navegador logado — mesmo cookie que o botão usará.
    const resposta = await page.request.post(`/api/v1/leads/${leadId}/clone`, {
      data: { pipeline_id: destinoId },
    });
    const corpo = await resposta.text();
    registra(`#936 · POST /leads/${leadId}/clone = ${resposta.status()} · ${corpo.slice(0, 500)}`);
    expect(resposta.status(), "a troca de funil devolve 201").toBe(201);
    const clone = JSON.parse(corpo).data.lead as { id: string; custom_fields: Record<string, string> };

    // ── O DESTINO, pela tela ──────────────────────────────────────────────
    await page.goto(`/app/pipelines/${destinoId}`);
    const cardNovo = page.getByRole("group", { name: `Lead: Negócio ${S}` });
    await expect(cardNovo).toBeVisible({ timeout: 60_000 });
    await captura(page, "936-02-destino-com-o-card");

    registra(`#936 · custom_fields do clone = ${JSON.stringify(clone.custom_fields)}`);
    expect(clone.custom_fields).toEqual({ orcamento: "R$ 42.000", bairro: "Savassi" });

    // ── A LINHA DO TEMPO do clone ─────────────────────────────────────────
    await cardNovo.click();
    const dossie = page.getByRole("dialog");
    await expect(dossie).toBeVisible({ timeout: 30_000 });
    await page.waitForLoadState("networkidle").catch(() => {});
    const textoClone = await dossie.innerText();
    registra(`#936 · dossiê do CLONE = ${JSON.stringify(textoClone.slice(0, 900))}`);
    expect(textoClone, "o clone precisa dizer de onde veio").toContain("Veio");
    expect(textoClone).toContain(`Troca Origem ${S}`);

    // Os campos personalizados aparecem na tela do DESTINO — e eles moram em
    // <input>, cujo valor `innerText` não enxerga. A régua é `inputValue()`.
    const campos = await dossie.locator("input").evaluateAll((els) =>
      els.map((e) => ({
        nome: (e as HTMLInputElement).name || (e as HTMLInputElement).id,
        valor: (e as HTMLInputElement).value,
      })),
    );
    registra(`#936 · campos do dossiê do CLONE = ${JSON.stringify(campos)}`);
    const valores = campos.map((c) => c.valor);
    expect(valores, "o orçamento copiado tem de aparecer na tela do destino").toContain("R$ 42.000");
    expect(valores, "e o bairro também").toContain("Savassi");
    await captura(page, "936-03-linha-do-tempo-do-clone");
    await page.keyboard.press("Escape");

    // ── A LINHA DO TEMPO da ORIGEM ────────────────────────────────────────
    await page.goto(`/app/pipelines/${origemId}?status=all`);
    await page.waitForLoadState("networkidle").catch(() => {});
    const { data: atividades } = await admin
      .from("crm_lead_activities")
      .select("type, reason")
      .eq("lead_id", leadId)
      .order("created_at", { ascending: false });
    registra(`#936 · atividades da ORIGEM = ${JSON.stringify(atividades)}`);
    expect(JSON.stringify(atividades)).toContain(`Troca Destino ${S}`);

    const { data: origem } = await admin
      .from("crm_leads")
      .select("status, lost_reason, source_metadata")
      .eq("id", leadId)
      .single();
    registra(`#936 · lead de ORIGEM depois = ${JSON.stringify(origem)}`);
    expect((origem as { status: string }).status).toBe("lost");
    expect(JSON.stringify(origem)).toContain(destinoId);

    // Abrir o card da origem pela tela, para ver a linha do tempo com os olhos.
    const cardVelho = page.getByRole("group", { name: `Lead: Negócio ${S}` }).first();
    if (await cardVelho.count()) {
      await cardVelho.click();
      await page.waitForLoadState("networkidle").catch(() => {});
      const textoOrigem = await page.getByRole("dialog").innerText().catch(() => "");
      registra(`#936 · dossiê da ORIGEM = ${JSON.stringify(textoOrigem.slice(0, 900))}`);
    }
    await captura(page, "936-04-linha-do-tempo-da-origem");
  });

  test("arrastar um card para a etapa de OUTRO funil é recusado, e a recusa aponta o caminho", async ({
    page,
  }) => {
    await login(page, c.users.manager!.email, c.password);
    const outro = await insere("crm_leads", {
      organization_id: c.org_id,
      pipeline_id: origemId,
      stage_id: etapaOrigem,
      title: `Fronteira ${S}`,
      position_in_stage: 5000,
      source: "manual",
    });
    const { data: lido } = await admin
      .from("crm_leads")
      .select("updated_at")
      .eq("id", outro)
      .single();
    const r = await page.request.post(`/api/v1/leads/${outro}/move`, {
      data: {
        stage_id: etapaDestino,
        position_in_stage: 1000,
        expected_updated_at: (lido as { updated_at: string }).updated_at,
      },
    });
    const corpo = await r.text();
    registra(`#936 fronteira · POST /move para etapa de OUTRO funil = ${r.status()} · ${corpo}`);
    expect(r.status()).toBe(422);
    expect(corpo).toMatch(/pipeline_immutable_use_clone|stage_pipeline_mismatch/);
    await admin.from("crm_leads").delete().eq("id", outro);
  });
});
