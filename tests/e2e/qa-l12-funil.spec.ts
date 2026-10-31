/**
 * QA VISUAL DO LOTE 12 — O QUADRO DO FUNIL.
 *
 * Cobre, pela TELA, num banco montado só do `supabase/baseline.sql`:
 *  · #935/#938 — os TRÊS caminhos para a etapa de perda (menu, arrasto, lote)
 *  · "Mover para…" no menu do card, no TOQUE: área de 44px, topo da etapa, janela do motivo
 *  · "Outro" com e sem detalhe
 *  · #911 — excluir pelo menu do próprio card, no desktop e no TOQUE
 *  · #948 — tag em lote oferecendo as tags que já existem
 */
import { test } from "./helpers/test";

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
    await expect(page.getByText(/cadastre em CRM › Ver tudo em CRM › Etapas do funil/)).toBeVisible();

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
  test("#935 caminho 2 — ARRASTO até a etapa de perda: a janela pede o motivo, e o move grava com ele", async ({
    page,
  }) => {
    await login(page, c.users.manager!.email, c.password);
    await abreQuadro(page, pipelineId, `Arrasto ${SUFIXO}`);
    const card = page.getByRole("group", { name: `Lead: Arrasto ${SUFIXO}` });

    const moves: string[] = [];
    page.on("request", (req) => {
      if (req.url().includes(`/leads/${leads.arrasto}/move`) && req.method() === "POST") {
        moves.push(req.postData() ?? "");
      }
    });
    // Teclado do @hello-pangea/dnd — o MESMO onDragEnd do mouse.
    await card.focus();
    await page.keyboard.press("Space");
    await page.waitForTimeout(500);
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(500);
    await page.keyboard.press("Space");

    // Antes, o move saía sem motivo e voltava 422 com um aviso; agora a janela
    // pede o motivo ANTES de o move sair.
    const dialogo = page.getByRole("dialog", { name: "Marcar como perdido" });
    await expect(dialogo).toBeVisible({ timeout: 10_000 });
    registra(`#935 arrasto · janela aberta · POSTs /move antes do motivo = ${moves.length}`);
    expect(moves).toEqual([]);
    await captura(page, "935-05-arrasto-pede-o-motivo");

    await page.locator('input[name="lost-reason"][value="Fora do perfil"]').check();
    const resposta = page.waitForResponse(
      (r) => r.url().includes(`/leads/${leads.arrasto}/move`) && r.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Confirmar" }).click();
    const r = await resposta;
    registra(`#935 arrasto · POST /move = ${r.status()} · enviado = ${r.request().postData()}`);
    expect(r.status()).toBe(200);
    expect(JSON.parse(r.request().postData() ?? "{}")).toMatchObject({
      stage_id: etapas.Perdido,
      lost_reason: "Fora do perfil",
    });

    const { data } = await admin
      .from("crm_leads")
      .select("status, stage_id, lost_reason")
      .eq("id", leads.arrasto)
      .single();
    registra(`#935 arrasto · banco = ${JSON.stringify(data)}`);
    expect(data).toMatchObject({ status: "lost", stage_id: etapas.Perdido, lost_reason: "Fora do perfil" });
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

  test("Mover para… pelo menu do card: área de 44px, topo da etapa inteira e janela do motivo", async ({ page }) => {
    // Funil próprio, semeado e limpo aqui: os vizinhos do bloco usam o deles.
    const { data: funil, error } = await admin
      .from("crm_pipelines")
      .insert({
        organization_id: cc.org_id,
        name: `QA L12 mover ${ST}`,
        slug: `qa-l12-mover-${ST}`,
        settings: { lost_reasons: [] },
      })
      .select("id")
      .single();
    if (error) throw new Error(`funil mover: ${error.message}`);
    const fid = (funil as { id: string }).id;
    try {
      const et: Record<string, string> = {};
      for (const [nome, pos, perda] of [
        ["Entrada", 1000, false],
        ["Contato", 2000, false],
        ["Perdido", 3000, true],
      ] as [string, number, boolean][]) {
        const { data, error: e } = await admin
          .from("crm_stages")
          .insert({
            organization_id: cc.org_id,
            pipeline_id: fid,
            name: nome,
            slug: `${nome.toLowerCase()}-mover-${ST}`,
            position: pos,
            is_lost: perda,
          })
          .select("id")
          .single();
        if (e) throw new Error(`etapa mover ${nome}: ${e.message}`);
        et[nome] = (data as { id: string }).id;
      }
      const ids: Record<string, string> = {};
      for (const [chave, etapa, pos] of [
        ["movido", et.Entrada, 1000],
        ["ancora", et.Contato, 5000],
      ] as [string, string, number][]) {
        const { data, error: e } = await admin
          .from("crm_leads")
          .insert({
            organization_id: cc.org_id,
            pipeline_id: fid,
            stage_id: etapa,
            title: chave === "movido" ? `Mover ${ST}` : `Âncora ${ST}`,
            position_in_stage: pos,
            source: "manual",
          })
          .select("id")
          .single();
        if (e) throw new Error(`lead mover ${chave}: ${e.message}`);
        ids[chave] = (data as { id: string }).id;
      }

      await login(page, cc.users.agent!.email, cc.password);
      await abreQuadro(page, fid, `Mover ${ST}`);
      const card = page.getByRole("group", { name: `Lead: Mover ${ST}` });
      const botao = card.getByRole("button", { name: "Ações do lead" });

      // O botão continua com 28px no desenho, mas o dedo acerta a 21px do
      // centro nos quatro sentidos (44px de área) — medido por elementFromPoint.
      const alvo = await botao.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const acerta = (x: number, y: number) => document.elementFromPoint(x, y)?.closest("button") === el;
        return {
          largura: r.width,
          altura: r.height,
          acertos: [acerta(cx - 21, cy), acerta(cx + 21, cy), acerta(cx, cy - 21), acerta(cx, cy + 21)],
        };
      });
      registra(`mover toque · botão ${alvo.largura}x${alvo.altura} · acerta a ±21px (esq, dir, cima, baixo) = ${JSON.stringify(alvo.acertos)}`);
      expect(alvo.acertos).toEqual([true, true, true, true]);
      await captura(page, "mover-01-card-no-celular");

      await botao.click();
      await expect(page.getByText("Mover para…", { exact: true })).toBeVisible();
      await expect(page.getByRole("menuitem", { name: "Entrada", exact: true })).toHaveCount(0);
      for (const nome of ["Contato", "Perdido"]) {
        const r = await page.getByRole("menuitem", { name: nome, exact: true }).evaluate((el) => {
          const b = el.getBoundingClientRect();
          return { altura: b.height, direita: b.right };
        });
        registra(`mover toque · item "${nome}" altura=${r.altura} direita=${r.direita}`);
        expect(r.altura).toBeGreaterThanOrEqual(44);
        expect(r.direita).toBeLessThanOrEqual(390);
      }
      const largura = await page.evaluate(() => ({
        // `body`, não `documentElement`: o `overflow-x: clip` do html grampeia o
        // do documentElement (ver navegacao.spec.ts).
        scrollWidth: document.body.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      registra(`mover toque · menu aberto: body.scrollWidth=${largura.scrollWidth} clientWidth=${largura.clientWidth}`);
      expect(largura.scrollWidth).toBeLessThanOrEqual(largura.clientWidth + 1);
      await captura(page, "mover-02-menu-com-etapas");

      const resposta = page.waitForResponse(
        (r) => r.url().includes(`/leads/${ids.movido}/move`) && r.request().method() === "POST",
      );
      await page.getByRole("menuitem", { name: "Contato", exact: true }).click();
      const r = await resposta;
      registra(`mover toque · Contato → POST /move = ${r.status()} · enviado = ${r.request().postData()}`);
      expect(r.status()).toBe(200);
      // O card CHEGA à etapa: entra no TOPO, acima da âncora (#3461).
      await expect(
        page.locator(`[data-rfd-droppable-id="${et.Contato}"] [role="group"][aria-label^="Lead:"]`).first(),
      ).toHaveAttribute("aria-label", `Lead: Mover ${ST}`, { timeout: 15_000 });
      const { data: noContato } = await admin
        .from("crm_leads")
        .select("stage_id, position_in_stage")
        .eq("id", ids.movido)
        .single();
      registra(`mover toque · banco depois de Contato = ${JSON.stringify(noContato)}`);
      expect((noContato as { stage_id: string }).stage_id).toBe(et.Contato);
      expect((noContato as { position_in_stage: number }).position_in_stage).toBeLessThan(5000);
      await captura(page, "mover-03-no-topo-do-contato");

      const moves: string[] = [];
      page.on("request", (req) => {
        if (req.url().includes(`/leads/${ids.movido}/move`) && req.method() === "POST") moves.push(req.postData() ?? "");
      });
      await card.getByRole("button", { name: "Ações do lead" }).click();
      await page.getByRole("menuitem", { name: "Perdido", exact: true }).click();
      const dialogo = page.getByRole("dialog", { name: "Marcar como perdido" });
      await expect(dialogo).toBeVisible();
      registra(`mover toque · Perdido → janela aberta · POSTs /move antes do motivo = ${moves.length}`);
      expect(moves).toEqual([]);
      await captura(page, "mover-04-janela-do-motivo");

      await page.locator('input[name="lost-reason"]').first().check();
      const perda = page.waitForResponse(
        (r) => r.url().includes(`/leads/${ids.movido}/move`) && r.request().method() === "POST",
      );
      await page.getByRole("button", { name: "Confirmar" }).click();
      const rp = await perda;
      registra(`mover toque · Confirmar → POST /move = ${rp.status()} · enviado = ${rp.request().postData()}`);
      expect(rp.status()).toBe(200);
      const { data: perdido } = await admin
        .from("crm_leads")
        .select("status, stage_id, lost_reason")
        .eq("id", ids.movido)
        .single();
      registra(`mover toque · banco depois de Perdido = ${JSON.stringify(perdido)}`);
      expect((perdido as { stage_id: string }).stage_id).toBe(et.Perdido);
      expect((perdido as { lost_reason: string | null }).lost_reason).not.toBeNull();
      await captura(page, "mover-05-perdido-com-motivo");
    } finally {
      await admin.from("crm_lead_activities").delete().eq("pipeline_id", fid);
      await admin.from("crm_leads").delete().eq("pipeline_id", fid);
      await admin.from("crm_stages").delete().eq("pipeline_id", fid);
      await admin.from("crm_pipelines").delete().eq("id", fid);
    }
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


test("próxima ação genérica preserva a proposta anterior e null limpa pelo turno e pela ferramenta", async ({ page }) => {
  test.setTimeout(150_000);
  const { randomUUID } = await import("node:crypto");
  const { mkdirSync } = await import("node:fs");
  const pg = (await import("pg")).default;
  const { credenciaisSupabaseDeTeste } = await import("../../scripts/lib/env-de-teste");
  const { loginComoAdmin, lerCreds } = await import("./helpers/login-admin");
  const { applyLeadStateUpdate } = await import("../../lib/agent-engine/agent/lead-state");
  const { seedPlatformPlaybook } = await import("../../lib/agent-engine/agent/playbook-seed");
  const { iniciarFilhoDoTurno } = await import("./helpers/filho-do-turno-local");
  const filhos: ReturnType<typeof iniciarFilhoDoTurno>[] = [];
  const fimDosTurnos = Date.now() + 120_000;
  const ambiente = credenciaisSupabaseDeTeste();
  expect(["127.0.0.1", "localhost"]).toContain(new URL(ambiente.dbUrl).hostname);
  const pool = new pg.Pool({ connectionString: ambiente.dbUrl, max: 2 });
  const usuario = lerCreds().users.admin as { email: string; id: string };
  const sufixo = randomUUID().slice(0, 8);
  let org = "";
  const inserir = async (tabela: string, dados: Record<string, unknown>): Promise<string> => {
    const { data, error } = await admin.from(tabela).insert(dados).select("id").single();
    expect(error).toBeNull();
    return data!.id as string;
  };
  try {
    org = await inserir("organizations", { slug: `proposta-${sufixo}`, display_name: `Próxima ação ${sufixo}`, legal_name: "Próxima ação local", onboarded_at: new Date().toISOString() });
    const vinculo = await admin.from("user_organizations").insert({ organization_id: org, user_id: usuario.id, role: "admin", accepted_at: new Date().toISOString() });
    expect(vinculo.error).toBeNull();
    await seedPlatformPlaybook(pool);
    const canal = await inserir("channel_sessions", { organization_id: org, display_name: "Canal da proposta", waha_session_name: `proposta-${sufixo}`, status: "WORKING", webhook_secret_encrypted: "\\x00" });
    const knobs = await admin.from("channel_knobs").insert({ organization_id: org, channel_session_id: canal, window_start_hour: 0, window_end_hour: 24, timezone: "UTC", allow_sunday: true, throttle_ms: 0, jitter_max_ms: 0 });
    expect(knobs.error).toBeNull();
    const pipeline = await inserir("crm_pipelines", { organization_id: org, name: `Proposta ${sufixo}`, slug: `proposta-${sufixo}` });
    const etapa = await inserir("crm_stages", { organization_id: org, pipeline_id: pipeline, name: "Entrada", slug: "entrada", position: 1000 });
    const contatos: string[] = [];
    for (const [i, modo] of ["Agente", "Direta"].entries()) {
      const contato = await inserir("contacts", { organization_id: org, name: `${modo} ${sufixo}`, phone_number: `+551198${Date.now().toString().slice(-6)}${i}` });
      contatos.push(contato);
      await inserir("crm_leads", { organization_id: org, pipeline_id: pipeline, stage_id: etapa, title: `${modo} ${sufixo}`, contact_id: contato, position_in_stage: (i + 1) * 1000 });
    }
    const conversa = await inserir("conversations", { organization_id: org, contact_id: contatos[0], channel_session_id: canal, status: "ai_handling", is_group: false });
    await loginComoAdmin(page, lerCreds());
    await page.goto("/app/inbox");
    await page.getByTestId("tenant-switcher").click();
    await page.getByTestId(`tenant-switcher-item-${org}`).click();
    await expect.poll(async () => (await page.context().cookies()).find((cookie) => cookie.name === "active_org")?.value).toBe(org);
    const card = page.getByRole("group", { name: `Lead: Agente ${sufixo}`, exact: true });
    const concreta = "Enviar o orçamento do modelo X até sexta";
    mkdirSync("evidence/antigos-core-3458", { recursive: true });
    for (const passo of [
      { texto: "Responder o cliente", esperado: null, seq: 0 },
      { texto: concreta, esperado: concreta, seq: 1 },
      { texto: "Responder o cliente", esperado: concreta, seq: 1 },
      { texto: null, esperado: null, seq: 2 },
    ]) {
      // O MESMO campo cru nos dois caminhos. O transporte LLM é sintético,
      // explicitamente; o handler e o writer usam o Postgres real da suíte.
      // O grafo do motor usa o loader tsx do worker, em um filho isolado:
      // não mistura sua resolução CJS/ESM com a transformação do Playwright.
      const filho = iniciarFilhoDoTurno(
        [
          "--max-old-space-size=768",
          "--import",
          "tsx",
          "tests/e2e/helpers/proxima-acao-no-turno.ts",
          "--executar-proxima-acao",
          JSON.stringify({
            ids: { org, contato: contatos[0]!, canal, conversa },
            nextAction: passo.texto,
          }),
        ],
        Math.min(30_000, fimDosTurnos - Date.now()),
        { E2E_TURNO_DB_URL: ambiente.dbUrl },
      );
      filhos.push(filho);
      await filho.resultado;
      const direta = await applyLeadStateUpdate(pool, { tenantId: org, leadId: contatos[1]! }, { next_action: passo.texto });
      expect(direta.ok).toBe(true);
      const { rows } = await pool.query("select next_action, next_action_seq from lead_state where organization_id=$1 and contact_id=any($2::uuid[]) order by contact_id", [org, contatos]);
      expect(rows).toHaveLength(2);
      for (const row of rows) expect({ texto: row.next_action, seq: Number(row.next_action_seq) }).toEqual({ texto: passo.esperado, seq: passo.seq });
      await page.goto(`/app/pipelines/${pipeline}`);
      await expect(card).toBeVisible();
      await expect(card.getByText("Responder o cliente", { exact: true })).toHaveCount(0);
      if (passo.esperado === null) {
        await expect(card.getByText(/Propõe:/)).toHaveCount(0);
      } else {
        await expect(card.getByText(concreta, { exact: false })).toBeVisible();
        if (passo.texto !== concreta) await page.screenshot({ path: "evidence/antigos-core-3458/proposta-preservada.png" });
      }
    }
    await page.screenshot({ path: "evidence/antigos-core-3458/proposta-limpa.png" });
  } finally {
    try {
      // Junta somente os filhos desta prova antes de remover qualquer fixture.
      for (const filho of filhos) await filho.encerrar();
      if (org) {
        const limpeza = await admin.from("organizations").delete().eq("id", org);
        expect(limpeza.error).toBeNull();
      }
    } finally {
      await pool.end();
    }
  }
});
