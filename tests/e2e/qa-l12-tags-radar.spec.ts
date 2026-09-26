/**
 * QA VISUAL DO LOTE 12 — ETIQUETAS (#955) e RADAR (#941, #907).
 *
 * A tela de Configurações › Tags foi para o lote SEM NINGUÉM TER CLICADO nos
 * botões uma vez (J24 do mapa de jornadas). Aqui ela é clicada.
 */
import { test } from "./helpers/test";
import { randomInt } from "node:crypto";

import {
  admin,
  captura,
  insere,
  creds,
  expect,
  login,
  registra,
  transbordoDaPagina,
  type Creds,
} from "./qa-l12-comum";

const SUFIXO = `${Date.now()}`.slice(-7);
const TAG_A = `obra${SUFIXO}`;
const TAG_B = `reforma${SUFIXO}`;
const TAG_C = `orcamento${SUFIXO}`;

let c: Creds;
let regraId = "";
const contatos: string[] = [];

test.describe("Lote 12 — #955 o vocabulário de etiquetas", () => {
  test.describe.configure({ timeout: 420_000 });

  test.beforeAll(async () => {
    test.setTimeout(420_000);
    c = creds();
    for (const [nome, tags] of [
      [`Tagueado ${SUFIXO} 1`, [TAG_A]],
      [`Tagueado ${SUFIXO} 2`, [TAG_A, TAG_C]],
      [`Tagueado ${SUFIXO} 3`, [TAG_B]],
    ] as [string, string[]][]) {
      contatos.push(
        await insere("contacts", {
          organization_id: c.org_id,
          name: nome,
          phone_number: `+5511${randomInt(100000000, 1000000000)}`,
          tags,
        }),
      );
    }
    // Uma regra de automação que ESCREVE a etiqueta — é o que a tela conta na
    // coluna "Regras de agente" e o que o aviso de excluir nomeia.
    const { data, error } = await admin
      .from("automation_rules")
      .insert({
        organization_id: c.org_id,
        name: `Regra QA L12 ${SUFIXO}`,
        trigger_event: "contact.tag_added",
        conditions: [],
        actions: [{ type: "add_tag", config: { tags: [TAG_A] } }],
        is_active: false,
      })
      .select("id")
      .single();
    if (error) throw new Error(`regra: ${error.message}`);
    regraId = (data as { id: string }).id;
  });

  test.afterAll(async () => {
    test.setTimeout(420_000);
    if (regraId) await admin.from("automation_rules").delete().eq("id", regraId);
    if (contatos.length) await admin.from("contacts").delete().in("id", contatos);
  });

  test("a lista carrega com as contagens e as três ações (J24.3)", async ({ page }) => {
    await login(page, c.users.manager!.email, c.password);

    // A PORTA: chegar pela navegação, não digitando a URL.
    await page.goto("/app/settings");
    // O cartão de Configurações leva rótulo E descrição dentro do mesmo <a>, então
    // o nome acessível é a frase inteira — o discriminador honesto é o href.
    const link = page.locator('a[href="/app/settings/tags"]');
    await expect(link, "Configurações tem de ter a porta para Tags").toBeVisible({ timeout: 30_000 });
    registra(`#955 J24.3 · porta em /app/settings = "${(await link.innerText()).replace(/\n/g, " | ")}"`);
    await captura(page, "955-01-porta-em-configuracoes");
    await link.click();
    await page.waitForURL(/\/app\/settings\/tags/);

    await expect(page.getByRole("heading", { name: "Tags", level: 1 })).toBeVisible({ timeout: 30_000 });
    const linha = page.getByRole("row", { name: new RegExp(TAG_A) });
    await expect(linha).toBeVisible({ timeout: 30_000 });
    const celulas = await linha.locator("td").allInnerTexts();
    registra(`#955 J24.3 · linha de ${TAG_A} = ${JSON.stringify(celulas)}`);
    // 2 contatos, 0 leads, 0 conversas, 1 regra de agente.
    expect(celulas[1]!.trim()).toBe("2");
    expect(celulas[4]!.trim()).toBe("1");
    await captura(page, "955-02-lista-com-contagens");

    for (const acao of ["Renomear", "Juntar", "Excluir"]) {
      await expect(linha.getByRole("button", { name: acao })).toBeVisible();
    }
  });

  test("renomear muda contatos E a regra de automação, na mesma operação", async ({ page }) => {
    await login(page, c.users.manager!.email, c.password);
    await page.goto("/app/settings/tags");
    const linha = page.getByRole("row", { name: new RegExp(TAG_A) });
    await expect(linha).toBeVisible({ timeout: 60_000 });
    await linha.getByRole("button", { name: "Renomear" }).click();

    await expect(page.getByText(`Renomear ${TAG_A} para:`)).toBeVisible();
    const novo = `${TAG_A}-renomeada`;
    await page.getByLabel("Novo nome").fill(novo);
    await captura(page, "955-03-renomear-formulario");
    const resposta = page.waitForResponse(
      (r) => r.url().includes("/api/v1/tags/vocabulario") && r.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Confirmar" }).click();
    const r = await resposta;
    registra(`#955 renomear · POST = ${r.status()} · ${await r.text()}`);
    expect(r.status()).toBe(200);

    const { data: cts } = await admin.from("contacts").select("id, tags").in("id", contatos);
    const { data: regra } = await admin
      .from("automation_rules")
      .select("actions")
      .eq("id", regraId)
      .single();
    registra(`#955 renomear · contatos = ${JSON.stringify(cts)}`);
    registra(`#955 renomear · regra = ${JSON.stringify(regra)}`);
    expect(JSON.stringify(regra)).toContain(novo);
    // J24.1: a regra continua com TODAS as suas ações.
    expect((regra as { actions: unknown[] }).actions).toHaveLength(1);
    await expect(page.getByRole("row", { name: new RegExp(novo) })).toBeVisible({ timeout: 30_000 });
    await captura(page, "955-04-renomeada-na-tela");
  });

  test("juntar duas etiquetas não deixa a etiqueta repetida (J24.2)", async ({ page }) => {
    await login(page, c.users.manager!.email, c.password);
    await page.goto("/app/settings/tags");
    const linha = page.getByRole("row", { name: new RegExp(TAG_C) });
    await expect(linha).toBeVisible({ timeout: 60_000 });
    await linha.getByRole("button", { name: "Juntar" }).click();
    await expect(page.getByText(`Juntar ${TAG_C} em outra etiqueta existente:`)).toBeVisible();

    const destino = page.getByLabel("Etiqueta de destino");
    const opcoes = await destino.locator("option").allInnerTexts();
    registra(`#955 juntar · opções de destino = ${JSON.stringify(opcoes)}`);
    const alvo = `${TAG_A}-renomeada`;
    await destino.selectOption(alvo);
    await captura(page, "955-05-juntar-formulario");
    const resposta = page.waitForResponse(
      (r) => r.url().includes("/api/v1/tags/vocabulario") && r.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Confirmar" }).click();
    const r = await resposta;
    registra(`#955 juntar · POST = ${r.status()} · ${await r.text()}`);
    expect(r.status()).toBe(200);

    const { data: cts } = await admin.from("contacts").select("id, tags").in("id", contatos);
    registra(`#955 juntar · contatos = ${JSON.stringify(cts)}`);
    for (const ct of (cts ?? []) as { tags: string[] }[]) {
      const repetidas = ct.tags.filter((t) => t === alvo);
      expect(repetidas.length, `a etiqueta ${alvo} não pode aparecer 2x na mesma linha`).toBeLessThanOrEqual(1);
    }
    await captura(page, "955-06-juntadas");
  });

  test("excluir avisa quantas regras continuam escrevendo a etiqueta (J24.4)", async ({ page }) => {
    await login(page, c.users.manager!.email, c.password);
    await page.goto("/app/settings/tags");
    const alvo = `${TAG_A}-renomeada`;
    const linha = page.getByRole("row", { name: new RegExp(alvo) });
    await expect(linha).toBeVisible({ timeout: 60_000 });
    await linha.getByRole("button", { name: "Excluir" }).click();

    const painel = page.locator("form").filter({ hasText: "Excluir" }).first();
    const texto = await page.locator("body").innerText();
    registra(`#955 excluir · aviso na tela = ${JSON.stringify(texto.slice(texto.indexOf("Excluir " + alvo), texto.indexOf("Excluir " + alvo) + 400))}`);
    await expect(page.getByText("Atenção:")).toBeVisible();
    await expect(page.getByText(/regra\(s\) de agente continuam escrevendo esta etiqueta/)).toBeVisible();
    await captura(page, "955-07-excluir-aviso-de-regras");

    const resposta = page.waitForResponse(
      (r) => r.url().includes("/api/v1/tags/vocabulario") && r.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Confirmar" }).click();
    const r = await resposta;
    registra(`#955 excluir · POST = ${r.status()}`);
    expect(r.status()).toBe(200);
    const { data: regra } = await admin
      .from("automation_rules")
      .select("id, actions")
      .eq("id", regraId)
      .single();
    registra(`#955 excluir · a REGRA continua = ${JSON.stringify(regra)}`);
    expect(regra, "excluir a etiqueta NÃO apaga a regra").toBeTruthy();
    await captura(page, "955-08-excluida");
  });

  test("quem é viewer e quem é agent NÃO chega à tela", async ({ page }) => {
    for (const papel of ["viewer", "agent"] as const) {
      await page.context().clearCookies();
      await login(page, c.users[papel]!.email, c.password);
      await page.goto("/app/settings/tags");
      await page.waitForLoadState("networkidle").catch(() => {});
      const url = page.url();
      registra(`#955 J24.5 · ${papel} em /app/settings/tags → ${url}`);
      expect(url, `${papel} não pode ficar na tela de Tags`).toContain("/403");
      await captura(page, `955-09-${papel}-recusado`);
      // A porta também não aparece em Configurações.
      await page.goto("/app/settings");
      const link = page.locator('a[href="/app/settings/tags"]');
      registra(`#955 J24.5 · ${papel} vê a porta em Configurações = ${await link.count()}`);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
test.describe("Lote 12 — #941 radar sem funil arquivado e #907 o nome escolhido", () => {
  test.describe.configure({ timeout: 420_000 });

  const S = `${Date.now()}`.slice(-6);
  let cc: Creds;
  let ativoId = "";
  let arquivadoId = "";
  let contatoEditadoId = "";

  test.beforeAll(async () => {
    test.setTimeout(420_000);
    cc = creds();
    const velho = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();

    // O contato com nome do WhatsApp E nome escolhido — o par da #907.
    contatoEditadoId = await insere("contacts", {
      organization_id: cc.org_id,
      display_name: `Ze do Pix ${S}`,
      name: `Maria Escolhida ${S}`,
      phone_number: "+5511966554433",
    });

    for (const [rotulo, arquivado] of [
      ["Ativo", false],
      ["Arquivado", true],
    ] as [string, boolean][]) {
      const pid = await insere("crm_pipelines", {
        organization_id: cc.org_id,
        name: `Radar ${rotulo} ${S}`,
        slug: `radar-${rotulo.toLowerCase()}-${S}`,
        is_archived: arquivado,
      });
      if (arquivado) arquivadoId = pid;
      else ativoId = pid;
      const eid = await insere("crm_stages", {
        organization_id: cc.org_id,
        pipeline_id: pid,
        name: "Aberto",
        slug: `aberto-${rotulo.toLowerCase()}-${S}`,
        position: 1000,
      });
      await insere("crm_leads", {
        organization_id: cc.org_id,
        pipeline_id: pid,
        stage_id: eid,
        contact_id: contatoEditadoId,
        title: `Risco ${rotulo} ${S}`,
        position_in_stage: 1000,
        source: "manual",
        last_activity_at: velho,
      });
    }
  });

  test.afterAll(async () => {
    test.setTimeout(420_000);
    for (const p of [ativoId, arquivadoId]) {
      if (!p) continue;
      await admin.from("crm_lead_activities").delete().eq("pipeline_id", p);
      await admin.from("crm_leads").delete().eq("pipeline_id", p);
      await admin.from("crm_stages").delete().eq("pipeline_id", p);
      await admin.from("crm_pipelines").delete().eq("id", p);
    }
    if (contatoEditadoId) await admin.from("contacts").delete().eq("id", contatoEditadoId);
  });

  test("o radar mostra o lead do funil ativo e NÃO o do arquivado, com o nome escolhido", async ({
    page,
  }) => {
    await login(page, cc.users.manager!.email, cc.password);
    await page.goto("/app/radar");
    await expect(page.getByRole("heading", { name: "Radar de risco" })).toBeVisible({ timeout: 60_000 });
    await page.waitForLoadState("networkidle").catch(() => {});

    const corpo = await page.locator("main").innerText();
    registra(`#941 · radar contém "Risco Ativo ${S}" = ${corpo.includes(`Risco Ativo ${S}`)}`);
    registra(`#941 · radar contém "Risco Arquivado ${S}" = ${corpo.includes(`Risco Arquivado ${S}`)}`);
    expect(corpo).toContain(`Risco Ativo ${S}`);
    expect(corpo, "lead de funil ARQUIVADO não entra no radar").not.toContain(`Risco Arquivado ${S}`);

    // #907: o nome ESCOLHIDO vence o nome do perfil do WhatsApp.
    registra(`#907 radar · "Maria Escolhida" presente = ${corpo.includes(`Maria Escolhida ${S}`)} · "Ze do Pix" presente = ${corpo.includes(`Ze do Pix ${S}`)}`);
    expect(corpo).toContain(`Maria Escolhida ${S}`);
    expect(corpo, "o nome do perfil do WhatsApp não pode vencer o escolhido").not.toContain(`Ze do Pix ${S}`);
    await captura(page, "941-10-radar-sem-funil-arquivado");

    const pagina = await transbordoDaPagina(page);
    registra(`#941 · radar 1440px: scrollWidth=${pagina.scrollWidth} clientWidth=${pagina.clientWidth}`);
  });
});
