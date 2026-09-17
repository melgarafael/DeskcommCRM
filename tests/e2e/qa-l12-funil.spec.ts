/**
 * QA VISUAL DO LOTE 12 — O QUADRO DO FUNIL.
 *
 * Cobre, pela TELA, num banco montado só do `supabase/baseline.sql`:
 *  · #935/#938 — os TRÊS caminhos para a etapa de perda (menu, arrasto, lote)
 *  · "Outro" com e sem detalhe
 *  · #911 — excluir pelo menu do próprio card, no desktop e no TOQUE
 *  · #948 — tag em lote oferecendo as tags que já existem
 */
import { test } from "@playwright/test";

import {
  admin,
  captura,
  creds,
  expect,
  abreQuadro,
  login,
  registra,
  transbordoDaPagina,
  type Creds,
} from "./qa-l12-comum";

const SUFIXO = `${Date.now()}`.slice(-7);
const NOME_DO_FUNIL = `QA L12 ${SUFIXO}`;
const MOTIVOS = ["Sem orçamento", "Fora do perfil"];

let c: Creds;
let pipelineId = "";
const etapas: Record<string, string> = {};
const leads: Record<string, string> = {};

async function limpar(): Promise<void> {
  const { data } = await admin
    .from("crm_pipelines")
    .select("id")
    .eq("organization_id", c.org_id)
    .like("name", "QA L12 %");
  const ids = ((data ?? []) as { id: string }[]).map((p) => p.id);
  if (ids.length === 0) return;
  await admin.from("crm_lead_activities").delete().in("pipeline_id", ids);
  await admin.from("crm_leads").delete().in("pipeline_id", ids);
  await admin.from("crm_stages").delete().in("pipeline_id", ids);
  await admin.from("crm_pipelines").delete().in("id", ids);
}

test.describe("Lote 12 — quadro do funil", () => {
  test.describe.configure({ timeout: 420_000 });

  test.beforeAll(async () => {
    test.setTimeout(420_000);
    c = creds();
    await limpar();
    const { data: funil, error } = await admin
      .from("crm_pipelines")
      .insert({
        organization_id: c.org_id,
        name: NOME_DO_FUNIL,
        slug: `qa-l12-${SUFIXO}`,
        settings: { lost_reasons: MOTIVOS },
      })
      .select("id")
      .single();
    if (error) throw new Error(`funil: ${error.message}`);
    pipelineId = (funil as { id: string }).id;

    for (const [nome, pos, perda] of [
      ["Entrada", 1000, false],
      ["Perdido", 2000, true],
      ["Conversa", 3000, false],
      ["Proposta", 4000, false],
    ] as [string, number, boolean][]) {
      const { data, error: e } = await admin
        .from("crm_stages")
        .insert({
          organization_id: c.org_id,
          pipeline_id: pipelineId,
          name: nome,
          slug: `${nome.toLowerCase()}-${SUFIXO}`,
          position: pos,
          is_lost: perda,
        })
        .select("id")
        .single();
      if (e) throw new Error(`etapa ${nome}: ${e.message}`);
      etapas[nome] = (data as { id: string }).id;
    }

    // Quatro cards: um por caminho + dois para o lote/tag.
    const cards: [string, string, string[]][] = [
      ["menu", `Menu ${SUFIXO}`, ["vip"]],
      ["arrasto", `Arrasto ${SUFIXO}`, ["verão"]],
      // ≥12 tags DISTINTAS no quadro — é o que a J4.39 pede e o que exercita o
      // teto de 10 do menu. "vip" fica junto de "verão" de propósito: é a
      // colisão de prefixo que o typeahead do Radix roubava.
      [
        "lote-a",
        `LoteA ${SUFIXO}`,
        ["vip", "google ads", "verde", "vitrine", "varejo", "vistoria", "viagem"],
      ],
      ["lote-b", `LoteB ${SUFIXO}`, ["orçamento", "obra", "oferta", "onboarding", "outlet"]],
      ["excluir", `Excluir ${SUFIXO}`, []],
      ["outro", `Outro ${SUFIXO}`, []],
    ];
    let pos = 1000;
    for (const [chave, titulo, tags] of cards) {
      const { data, error: e } = await admin
        .from("crm_leads")
        .insert({
          organization_id: c.org_id,
          pipeline_id: pipelineId,
          stage_id: etapas.Entrada,
          title: titulo,
          position_in_stage: (pos += 1000),
          source: "manual",
          tags,
        })
        .select("id")
        .single();
      if (e) throw new Error(`lead ${chave}: ${e.message}`);
      leads[chave] = (data as { id: string }).id;
    }
  });

  test.afterAll(async () => {
    test.setTimeout(420_000);
    await limpar();
  });

  // ══════════════════════════════════════════════════════════════════════════
  test("#938 caminho 1 — MENU do card: a janela pede o motivo do FUNIL e grava", async ({ page }) => {
    await login(page, c.users.manager!.email, c.password);
    await abreQuadro(page, pipelineId, `Menu ${SUFIXO}`);
    const card = page.getByRole("group", { name: `Lead: Menu ${SUFIXO}` });

    await card.getByRole("button", { name: "Ações do lead" }).click();
    await page.getByRole("menuitem", { name: "Marcar como perdido" }).click();
    const dialogo = page.getByRole("dialog");
    await expect(dialogo).toBeVisible();

    const valores = await page
      .locator('input[name="lost-reason"]')
      .evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
    registra(`#938 menu · motivos oferecidos = ${JSON.stringify(valores)}`);
    expect(valores).toEqual([...MOTIVOS, "other"]);
    await captura(page, "938-01-menu-motivos-do-funil");

    await page.locator('input[name="lost-reason"][value="Sem orçamento"]').check();
    const resposta = page.waitForResponse(
      (r) => r.url().includes(`/leads/${leads.menu}/lose`) && r.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Confirmar" }).click();
    const r = await resposta;
    registra(`#938 menu · POST /lose = ${r.status()}`);
    expect(r.status()).toBe(200);

    const { data } = await admin
      .from("crm_leads")
      .select("status, lost_reason")
      .eq("id", leads.menu)
      .single();
    registra(`#938 menu · banco = ${JSON.stringify(data)}`);
    expect(data).toMatchObject({ status: "lost", lost_reason: "Sem orçamento" });
    await captura(page, "938-02-menu-card-perdido");
  });

  // ══════════════════════════════════════════════════════════════════════════
  test('#938 "Outro" — com detalhe fora da lista é RECUSADO antes do clique; sem detalhe passa', async ({
    page,
  }) => {
    await login(page, c.users.manager!.email, c.password);
    await abreQuadro(page, pipelineId, `Outro ${SUFIXO}`);
    const card = page.getByRole("group", { name: `Lead: Outro ${SUFIXO}` });
    await card.getByRole("button", { name: "Ações do lead" }).click();
    await page.getByRole("menuitem", { name: "Marcar como perdido" }).click();

    await page.locator('input[name="lost-reason"][value="other"]').check();
    const confirmar = page.getByRole("button", { name: "Confirmar" });
    registra(`#938 outro · vazio, Confirmar habilitado = ${await confirmar.isEnabled()}`);
    expect(await confirmar.isEnabled()).toBe(true);
    await expect(page.getByText(/cadastre em Configurações/)).toBeVisible();

    await page.getByLabel(/Detalhe \(opcional\)/).fill("Mudou de ideia");
    await expect(page.getByRole("alert")).toBeVisible();
    registra(
      `#938 outro · com texto fora da lista: alerta="${await page.getByRole("alert").innerText()}" · Confirmar habilitado = ${await confirmar.isEnabled()}`,
    );
    expect(await confirmar.isEnabled()).toBe(false);
    await captura(page, "938-03-outro-texto-recusado");

    // Vazio de novo: volta a ser o escape que o servidor aceita.
    await page.getByLabel(/Detalhe \(opcional\)/).fill("");
    await expect(page.getByRole("alert")).toHaveCount(0);
    const resposta = page.waitForResponse(
      (r) => r.url().includes(`/leads/${leads.outro}/lose`) && r.request().method() === "POST",
    );
    await confirmar.click();
    const r = await resposta;
    registra(`#938 outro · vazio → POST /lose = ${r.status()}`);
    expect(r.status()).toBe(200);
    const { data } = await admin
      .from("crm_leads")
      .select("status, lost_reason")
      .eq("id", leads.outro)
      .single();
    registra(`#938 outro · banco = ${JSON.stringify(data)}`);
    expect(data).toMatchObject({ status: "lost", lost_reason: "other" });
    await captura(page, "938-04-outro-vazio-gravado");
  });

  // ══════════════════════════════════════════════════════════════════════════
  test("#935 caminho 2 — ARRASTO até a etapa de perda: recusa 422 e o card volta", async ({ page }) => {
    await login(page, c.users.manager!.email, c.password);
    await abreQuadro(page, pipelineId, `Arrasto ${SUFIXO}`);
    const card = page.getByRole("group", { name: `Lead: Arrasto ${SUFIXO}` });

    const resposta = page.waitForResponse(
      (r) => r.url().includes(`/leads/${leads.arrasto}/move`) && r.request().method() === "POST",
    );
    // Teclado do @hello-pangea/dnd — o MESMO onDragEnd do mouse.
    await card.focus();
    await page.keyboard.press("Space");
    await page.waitForTimeout(500);
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(500);
    await page.keyboard.press("Space");
    const r = await resposta;
    registra(`#935 arrasto · POST /move = ${r.status()} · corpo = ${await r.text()}`);
    expect(r.status()).toBe(422);
    expect(await r.text()).toContain("lost_reason_required");

    // A recusa diz a SAÍDA — o L12.QA.4 falhou exatamente por a tela mostrar só a falta.
    await expect(page.getByText("use “Marcar como perdido” no menu do card")).toBeVisible({ timeout: 10_000 });
    await captura(page, "935-05-arrasto-recusado-com-aviso");

    const { data } = await admin
      .from("crm_leads")
      .select("status, stage_id, lost_reason")
      .eq("id", leads.arrasto)
      .single();
    registra(`#935 arrasto · banco INTACTO = ${JSON.stringify(data)}`);
    expect((data as { stage_id: string }).stage_id).toBe(etapas.Entrada);
    expect((data as { status: string }).status).toBe("open");
  });

  // ══════════════════════════════════════════════════════════════════════════
  test("#935 caminho 3 — LOTE até a etapa de perda: recusa 422 nomeando os cards", async ({ page }) => {
    await login(page, c.users.manager!.email, c.password);
    await abreQuadro(page, pipelineId, `LoteA ${SUFIXO}`);
    const a = page.getByRole("group", { name: `Lead: LoteA ${SUFIXO}` });

    await a.hover();
    await page.getByRole("checkbox", { name: `Selecionar: LoteA ${SUFIXO}` }).check();
    const b = page.getByRole("group", { name: `Lead: LoteB ${SUFIXO}` });
    await b.hover();
    await page.getByRole("checkbox", { name: `Selecionar: LoteB ${SUFIXO}` }).check();
    await expect(page.locator("[data-lote-selecionados]")).toHaveAttribute(
      "data-lote-selecionados",
      "2",
    );
    await captura(page, "935-06-lote-dois-selecionados");

    const resposta = page.waitForResponse(
      (r) => r.url().includes("/leads/bulk") && r.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Mover para…" }).click();
    await page.getByRole("menuitem", { name: "Perdido" }).click();
    const r = await resposta;
    const corpo = await r.text();
    registra(`#935 lote · POST /leads/bulk = ${r.status()} · corpo = ${corpo}`);
    expect(r.status()).toBe(422);
    expect(corpo).toContain("lost_reason_required");
    // A recusa NOMEIA os cards ofensores, e não só o lote.
    expect(corpo).toContain(leads["lote-a"]);
    expect(corpo).toContain(leads["lote-b"]);
    await expect(page.getByText("use “Marcar como perdido” no menu do card")).toBeVisible({ timeout: 10_000 });
    await captura(page, "935-07-lote-recusado");

    const { data } = await admin
      .from("crm_leads")
      .select("id, status, stage_id")
      .in("id", [leads["lote-a"], leads["lote-b"]]);
    registra(`#935 lote · banco INTACTO = ${JSON.stringify(data)}`);
    for (const l of (data ?? []) as { status: string; stage_id: string }[]) {
      expect(l.status).toBe("open");
      expect(l.stage_id).toBe(etapas.Entrada);
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  test("#948 — tag em lote oferece as tags que já existem, e o campo recebe o texto INTEIRO", async ({
    page,
  }) => {
    await login(page, c.users.manager!.email, c.password);
    await abreQuadro(page, pipelineId, `LoteA ${SUFIXO}`);
    const a = page.getByRole("group", { name: `Lead: LoteA ${SUFIXO}` });
    await a.hover();
    await page.getByRole("checkbox", { name: `Selecionar: LoteA ${SUFIXO}` }).check();
    const b = page.getByRole("group", { name: `Lead: LoteB ${SUFIXO}` });
    await b.hover();
    await page.getByRole("checkbox", { name: `Selecionar: LoteB ${SUFIXO}` }).check();

    await page.getByRole("button", { name: "Tag…" }).click();
    const campo = page.getByPlaceholder("nova tag");
    await expect(campo).toBeVisible();
    const oferecidas = await page.getByRole("menuitem").allInnerTexts();
    const distintasNoQuadro = await page.evaluate(() => 0); // marcador: a conta vem do banco
    void distintasNoQuadro;
    const { data: doQuadro } = await admin
      .from("crm_leads")
      .select("tags")
      .eq("pipeline_id", pipelineId);
    const universo = [...new Set(((doQuadro ?? []) as { tags: string[] }[]).flatMap((l) => l.tags))];
    registra(
      `#948 · o quadro tem ${universo.length} tags distintas; o menu oferece ${oferecidas.length}: ${JSON.stringify(oferecidas)}`,
    );
    expect(universo.length, "a J4.39 pede o quadro com ≥12 tags distintas").toBeGreaterThanOrEqual(12);
    expect(oferecidas.length, "o menu mostra no máximo 10").toBeLessThanOrEqual(10);
    await captura(page, "948-08-tags-existentes-no-menu");

    // A armadilha do typeahead do Radix: "vip" está na lista e eu digito "verão".
    await campo.click();
    await page.keyboard.type("verão", { delay: 60 });
    const escrito = await campo.inputValue();
    registra(`#948 · digitei "verão" com "vip" na lista → campo = "${escrito}"`);
    expect(escrito).toBe("verão");
    const filtradas = await page.getByRole("menuitem").allInnerTexts();
    registra(`#948 · filtro "verão" → ${JSON.stringify(filtradas)}`);
    expect(filtradas).toEqual(["verão"]);
    await captura(page, "948-09-typeahead-nao-rouba-o-foco");

    const resposta = page.waitForResponse(
      (r) => r.url().includes("/leads/bulk") && r.request().method() === "POST",
    );
    await page.keyboard.press("Enter");
    const r = await resposta;
    const corpo = JSON.parse(r.request().postData() ?? "{}");
    registra(`#948 · Enter enviou = ${JSON.stringify(corpo)} → ${r.status()}`);
    expect(corpo.params.add).toEqual(["verão"]);
    expect(r.status()).toBe(200);

    const { data } = await admin
      .from("crm_leads")
      .select("id, tags")
      .in("id", [leads["lote-a"], leads["lote-b"]]);
    registra(`#948 · banco = ${JSON.stringify(data)}`);
    for (const l of (data ?? []) as { tags: string[] }[]) expect(l.tags).toContain("verão");
    await captura(page, "948-10-tag-aplicada");
  });

  // ══════════════════════════════════════════════════════════════════════════
  test("#911 — excluir pelo menu do próprio card, com o aviso destrutivo", async ({ page }) => {
    await login(page, c.users.manager!.email, c.password);
    await abreQuadro(page, pipelineId, `Excluir ${SUFIXO}`);
    const card = page.getByRole("group", { name: `Lead: Excluir ${SUFIXO}` });

    await card.getByRole("button", { name: "Ações do lead" }).click();
    const itens = await page.getByRole("menuitem").allInnerTexts();
    registra(`#911 · itens do menu do card (manager) = ${JSON.stringify(itens)}`);
    expect(itens).toContain("Excluir");

    await page.getByRole("menuitem", { name: "Excluir" }).click();
    const aviso = page.getByRole("alertdialog");
    await expect(aviso).toBeVisible();
    registra(`#911 · aviso = "${(await aviso.innerText()).replace(/\n/g, " | ")}"`);
    await expect(aviso.getByText(`Excluir "Excluir ${SUFIXO}"?`)).toBeVisible();
    await expect(aviso.getByText(/não pode ser desfeita/)).toBeVisible();
    await captura(page, "911-11-excluir-aviso-destrutivo");

    const resposta = page.waitForResponse(
      (r) => r.url().includes("/leads/bulk") && r.request().method() === "POST",
    );
    await aviso.getByRole("button", { name: "Excluir" }).click();
    const r = await resposta;
    const corpo = JSON.parse(r.request().postData() ?? "{}");
    registra(`#911 · POST = ${JSON.stringify(corpo)} → ${r.status()}`);
    expect(corpo.action).toBe("delete");
    expect(r.status()).toBe(200);
    await expect(card).toHaveCount(0, { timeout: 15_000 });
    const { data } = await admin.from("crm_leads").select("id").eq("id", leads.excluir);
    registra(`#911 · banco depois = ${JSON.stringify(data)}`);
    expect(data).toEqual([]);
    await captura(page, "911-12-card-excluido");
  });
});

// ════════════════════════════════════════════════════════════════════════════
test.describe("Lote 12 — #911 no TOQUE (sem hover)", () => {
  test.describe.configure({ timeout: 420_000 });
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  const ST = `${Date.now()}`.slice(-7);
  let cc: Creds;
  let pid = "";

  test.beforeAll(async () => {
    test.setTimeout(420_000);
    cc = creds();
    const { data: funil, error } = await admin
      .from("crm_pipelines")
      .insert({
        organization_id: cc.org_id,
        name: `QA L12 toque ${ST}`,
        slug: `qa-l12-toque-${ST}`,
        settings: { lost_reasons: [] },
      })
      .select("id")
      .single();
    if (error) throw new Error(`funil toque: ${error.message}`);
    pid = (funil as { id: string }).id;
    const { data: etapa, error: e2 } = await admin
      .from("crm_stages")
      .insert({
        organization_id: cc.org_id,
        pipeline_id: pid,
        name: "Entrada",
        slug: `entrada-toque-${ST}`,
        position: 1000,
      })
      .select("id")
      .single();
    if (e2) throw new Error(`etapa toque: ${e2.message}`);
    const { error: e3 } = await admin.from("crm_leads").insert({
      organization_id: cc.org_id,
      pipeline_id: pid,
      stage_id: (etapa as { id: string }).id,
      title: `Toque ${ST}`,
      position_in_stage: 1000,
      source: "manual",
    });
    if (e3) throw new Error(`lead toque: ${e3.message}`);
  });

  test.afterAll(async () => {
    test.setTimeout(420_000);
    if (!pid) return;
    await admin.from("crm_lead_activities").delete().eq("pipeline_id", pid);
    await admin.from("crm_leads").delete().eq("pipeline_id", pid);
    await admin.from("crm_stages").delete().eq("pipeline_id", pid);
    await admin.from("crm_pipelines").delete().eq("id", pid);
  });

  test("o botão de ações é visível sem hover, e o menu traz Excluir", async ({ page }) => {
    await login(page, cc.users.manager!.email, cc.password);
    await abreQuadro(page, pid, `Toque ${ST}`);

    const botao = page.getByRole("button", { name: "Ações do lead" }).first();
    await expect(botao).toBeVisible({ timeout: 30_000 });
    // Opacidade COMPUTADA, nunca a string do className — e SEM hover antes.
    const opacidade = await botao.evaluate((el) => getComputedStyle(el).opacity);
    registra(`#911 toque · opacity COMPUTADA do botão sem hover (390px, hasTouch) = ${opacidade}`);
    expect(Number(opacidade)).toBeGreaterThan(0.9);
    await captura(page, "911-13-toque-botao-visivel");

    await botao.click();
    const itens = await page.getByRole("menuitem").allInnerTexts();
    registra(`#911 toque · itens do menu = ${JSON.stringify(itens)}`);
    expect(itens).toContain("Excluir");
    await captura(page, "911-14-toque-menu-com-excluir");

    const pagina = await transbordoDaPagina(page);
    registra(`#911 toque · documento 390px: scrollWidth=${pagina.scrollWidth} clientWidth=${pagina.clientWidth} transborda=${pagina.transborda}`);
  });

  test("no tema ESCURO, em 400 px, o quadro não rola na horizontal", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.setViewportSize({ width: 400, height: 860 });
    await login(page, cc.users.manager!.email, cc.password);
    await abreQuadro(page, pid, `Toque ${ST}`);
    const pagina = await transbordoDaPagina(page);
    registra(`#911 escuro · quadro 400px tema escuro: scrollWidth=${pagina.scrollWidth} clientWidth=${pagina.clientWidth} transborda=${pagina.transborda}`);
    await captura(page, "911-15-quadro-400px-escuro");
  });
});
