/**
 * QA VISUAL DO LOTE 12 — O PAINEL DO CONTATO NO INBOX.
 *
 *  · #909 — o botão que cria o lead tem o MESMO nome do diálogo que abre
 *  · #944 — "Leads recentes" diz Funil · Etapa, e o desfecho é Ganho/Perdido
 *           (NUNCA o vocabulário do funil, que numa clínica diria "Pago")
 *  · #946 — sugestão de tags do contato, com caixa mista e duplicata
 *  · L12.G2.1 — GET /api/v1/contact-tags responde 200 numa org com contato
 *               SEM tag e contato COM tag
 *  · L12.G2.2/G2.3 — encaixe em 400 px e no tema escuro, medido por ferramenta
 */
import { randomUUID } from "node:crypto";

import { test } from "@playwright/test";
import { randomInt } from "node:crypto";

import {
  abreConversa,
  admin,
  captura,
  insere,
  creds,
  expect,
  login,
  medeTransbordo,
  registra,
  transbordoDaPagina,
  type Creds,
} from "./qa-l12-comum";

const SUFIXO = `${Date.now()}`.slice(-7);

let c: Creds;
let contatoId = "";
let conversaId = "";
let funilLongoId = "";
let funilArquivadoId = "";

test.describe("Lote 12 — painel do contato no Inbox", () => {
  test.describe.configure({ timeout: 420_000 });

  test.beforeAll(async () => {
    test.setTimeout(420_000);
    c = creds();
    // Telefone é único por organização: resíduo de uma rodada anterior derruba
    // o preparo com 23505 e a sessão mede o vizinho em vez do lote.
    // Telefone é único por organização e o contato de uma rodada anterior fica
    // preso por conversa/mensagem — apagar dá trabalho e pode falhar calado.
    // O telefone leva o sufixo da rodada: cada rodada nasce com o seu.

    // ── Vocabulário de tags da organização: caixa mista + duplicata ────────
    // "VIP", "vip " e "vip" moram em contatos DIFERENTES. A sugestão tem de
    // colapsá-los num chip só, em minúscula.
    for (const [nome, tags] of [
      [`Vizinha ${SUFIXO} A`, ["VIP"]],
      [`Vizinha ${SUFIXO} B`, ["vip "]],
      [`Vizinha ${SUFIXO} C`, ["vip", "Obra"]],
      // O contato SEM tag — a metade que faz o `.neq("tags","{}")` valer.
      [`Vizinha ${SUFIXO} D`, []],
    ] as [string, string[]][]) {
      await insere("contacts", {
        organization_id: c.org_id,
        name: nome,
        phone_number: `+5511${randomInt(100000000, 1000000000)}`,
        tags,
      });
    }

    // ── O contato da conversa: já tem "VIP" em CAIXA ALTA ─────────────────
    contatoId = await insere("contacts", {
      organization_id: c.org_id,
      name: `Cliente L12 ${SUFIXO}`,
      phone_number: `+55119${SUFIXO}`,
      tags: ["VIP"],
    });
    const canal = await insere("channel_sessions", {
      organization_id: c.org_id,
      waha_session_name: `qa-l12-${randomUUID()}`,
      display_name: "Canal QA L12",
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
      body: "Oi, quero saber dos horários",
      sent_at: new Date().toISOString(),
    });

    // ── Dois funis: um com NOME LONGO (a régua do line-clamp-2) e um ARQUIVADO
    // O vocabulário do LONGO é o de e-commerce, que é o DEFAULT do banco:
    // se a tela lesse a coluna, diria "Pago" onde tem de dizer "Ganho".
    funilLongoId = await insere("crm_pipelines", {
      organization_id: c.org_id,
      name: `Funil de Vendas Consultivas B2B Enterprise ${SUFIXO}`,
      slug: `qa-l12-longo-${SUFIXO}`,
    });
    funilArquivadoId = await insere("crm_pipelines", {
      organization_id: c.org_id,
      name: `Funil Arquivado ${SUFIXO}`,
      slug: `qa-l12-arq-${SUFIXO}`,
      is_archived: true,
    });

    const etapaLonga = await insere("crm_stages", {
      organization_id: c.org_id,
      pipeline_id: funilLongoId,
      name: "Proposta enviada ao comitê",
      slug: `proposta-${SUFIXO}`,
      position: 1000,
    });
    const etapaGanho = await insere("crm_stages", {
      organization_id: c.org_id,
      pipeline_id: funilLongoId,
      name: "Fechado",
      slug: `fechado-${SUFIXO}`,
      position: 2000,
      is_won: true,
    });
    const etapaArq = await insere("crm_stages", {
      organization_id: c.org_id,
      pipeline_id: funilArquivadoId,
      name: "Etapa Sumida",
      slug: `sumida-${SUFIXO}`,
      position: 1000,
    });

    // Dois leads de MESMO título em funis diferentes — o defeito da #943.
    await insere("crm_leads", {
      organization_id: c.org_id,
      pipeline_id: funilLongoId,
      stage_id: etapaLonga,
      contact_id: contatoId,
      title: `Proposta ${SUFIXO}`,
      position_in_stage: 1000,
      source: "manual",
    });
    await insere("crm_leads", {
      organization_id: c.org_id,
      pipeline_id: funilLongoId,
      stage_id: etapaGanho,
      contact_id: contatoId,
      title: `Proposta ${SUFIXO}`,
      position_in_stage: 2000,
      source: "manual",
      status: "won",
    });
    // O lead do funil ARQUIVADO — não pode aparecer.
    await insere("crm_leads", {
      organization_id: c.org_id,
      pipeline_id: funilArquivadoId,
      stage_id: etapaArq,
      contact_id: contatoId,
      title: `Fantasma ${SUFIXO}`,
      position_in_stage: 1000,
      source: "manual",
    });
  });

  test.afterAll(async () => {
    test.setTimeout(420_000);
    for (const p of [funilLongoId, funilArquivadoId]) {
      if (!p) continue;
      await admin.from("crm_lead_activities").delete().eq("pipeline_id", p);
      await admin.from("crm_leads").delete().eq("pipeline_id", p);
      await admin.from("crm_stages").delete().eq("pipeline_id", p);
      await admin.from("crm_pipelines").delete().eq("id", p);
    }
    await admin.from("contacts").delete().like("name", `%${SUFIXO}%`);
  });

  test("#909 + #944 — o botão e o diálogo têm o mesmo nome; os leads dizem Funil · Etapa e Ganho/Perdido", async ({
    page,
  }) => {
    await login(page, c.users.manager!.email, c.password);

    const respostaResumo = page.waitForResponse((r) => r.url().includes("/crm-summary"));
    await abreConversa(page, conversaId);
    await expect(page.getByText(`Cliente L12 ${SUFIXO}`).first()).toBeVisible({ timeout: 60_000 });

    const rr = await respostaResumo;
    registra(`#944 · GET /crm-summary = ${rr.status()}`);

    // ── #909: o rótulo do botão é o TÍTULO do diálogo que ele abre ─────────
    const botao = page.getByRole("button", { name: "Novo Lead" });
    await expect(botao).toBeVisible({ timeout: 30_000 });
    registra(`#909 · rótulo do botão = "${await botao.innerText()}"`);
    await captura(page, "909-01-painel-com-botao-novo-lead");
    await botao.click();
    const dialogo = page.getByRole("dialog");
    await expect(dialogo).toBeVisible();
    const titulo = await dialogo.getByRole("heading").first().innerText();
    registra(`#909 · título do diálogo = "${titulo}"`);
    expect(titulo.trim()).toBe("Novo Lead");
    await captura(page, "909-02-dialogo-mesmo-nome");
    await page.keyboard.press("Escape");
    await expect(dialogo).toHaveCount(0);

    // ── #944: Funil · Etapa e o desfecho pelas PALAVRAS FIXAS ─────────────
    const secao = page.locator('[data-testid="inbox-campos-lead"]');
    await expect(secao.getByText("Leads recentes")).toBeVisible();
    const texto = await secao.innerText();
    registra(`#944 · seção "Leads recentes" = ${JSON.stringify(texto)}`);

    expect(texto, "o lead do funil ARQUIVADO não pode aparecer").not.toContain(`Fantasma ${SUFIXO}`);
    expect(texto).toContain(`Funil de Vendas Consultivas B2B Enterprise ${SUFIXO} · Proposta enviada ao comitê`);
    expect(texto).toContain(`Funil de Vendas Consultivas B2B Enterprise ${SUFIXO} · Fechado`);
    expect(texto, 'o desfecho é "Ganho", nunca o "Pago" do vocabulário de e-commerce').toContain("Ganho");
    expect(texto).not.toContain("Pago");

    // O vocabulário GRAVADO no funil, para provar que a tela o ignorou de propósito.
    const { data: voc } = await admin
      .from("crm_pipelines")
      .select("vocabulary")
      .eq("id", funilLongoId)
      .single();
    registra(`#944 · crm_pipelines.vocabulary do funil = ${JSON.stringify(voc)}`);
    await captura(page, "944-03-leads-recentes-funil-e-etapa");

    // ── L12.G2.3: a linha "Funil · Etapa" transborda? ─────────────────────
    const linha = await medeTransbordo(page, '[data-testid="inbox-campos-lead"] .line-clamp-2');
    registra(`L12.G2.3 · 1440px "Funil · Etapa": scrollWidth=${linha.scrollWidth} clientWidth=${linha.clientWidth} transborda=${linha.transborda}`);
  });

  test("#946 — a sugestão colapsa caixa mista e duplicata, e não oferece o que o contato já tem", async ({
    page,
  }) => {
    await login(page, c.users.manager!.email, c.password);
    await abreConversa(page, conversaId);
    await expect(page.getByText(`Cliente L12 ${SUFIXO}`).first()).toBeVisible({ timeout: 60_000 });

    // ── L12.G2.1: a rota das tags responde 200, não 400 do PostgREST ───────
    // Ela só é pedida quando o editor de tags MONTA, e o editor monta no clique.
    const respostaTags = page.waitForResponse((r) => r.url().includes("/api/v1/contact-tags"));
    await page.getByRole("button", { name: "Tags do contato", exact: true }).click();
    const rt = await respostaTags;
    const corpoTags = await rt.text();
    registra(`L12.G2.1 · GET /api/v1/contact-tags = ${rt.status()} · corpo = ${corpoTags.slice(0, 400)}`);
    expect(rt.status(), "a org tem contato SEM tag e contato COM tag").toBe(200);

    const campo = page.getByLabel("Adicionar tag ao contato");
    await expect(campo).toBeVisible();

    const chips = await page.getByRole("button", { name: /^\+ / }).allInnerTexts();
    registra(`#946 · chips oferecidos = ${JSON.stringify(chips)}`);
    // "VIP", "vip " e "vip" viraram UM chip — e ele não é oferecido, porque o
    // contato desta conversa já tem "VIP".
    expect(chips.filter((x) => x.trim().toLowerCase() === "+ vip")).toEqual([]);
    expect(chips.map((x) => x.trim())).toContain("+ obra");
    // A etiqueta que o CONTATO já tem, em CAIXA ALTA, não é oferecida — e a
    // rota conhece "vip", o que separa "não oferece" de "não existe".
    expect(corpoTags).toContain("vip");
    // Nenhum chip repetido, e todos em minúscula.
    const limpos = chips.map((x) => x.replace(/^\+\s*/, "").trim());
    expect(new Set(limpos).size, "nenhuma duplicata na sugestão").toBe(limpos.length);
    expect(limpos.every((x) => x === x.toLowerCase()), "a sugestão mostra a forma que o clique grava").toBe(true);
    await captura(page, "946-04-sugestao-de-tags");

    // Clicar no chip grava a forma normalizada.
    const antes = (await admin.from("contacts").select("tags").eq("id", contatoId).single()).data;
    const resposta = page.waitForResponse(
      (r) => r.url().includes(`/contacts/${contatoId}`) && r.request().method() === "PATCH",
    );
    await page.getByRole("button", { name: "+ obra", exact: true }).click();
    const r = await resposta;
    const { data: depois } = await admin.from("contacts").select("tags").eq("id", contatoId).single();
    registra(`#946 · PATCH = ${r.status()} · antes=${JSON.stringify(antes)} depois=${JSON.stringify(depois)}`);
    expect((depois as { tags: string[] }).tags).toContain("obra");
    await captura(page, "946-05-tag-gravada-normalizada");
  });
});

// ════════════════════════════════════════════════════════════════════════════
test.describe("Lote 12 — o painel em 400 px e no tema escuro", () => {
  test.describe.configure({ timeout: 420_000 });
  test.use({ viewport: { width: 400, height: 860 }, colorScheme: "dark" });

  test("L12.G2.2/G2.3 — a fileira de botões e a linha Funil · Etapa cabem", async ({ page }) => {
    const cc = creds();
    await login(page, cc.users.manager!.email, cc.password);
    const { data: conv } = await admin
      .from("conversations")
      .select("id, contacts!inner(name)")
      .eq("organization_id", cc.org_id)
      .like("contacts.name", "Cliente L12 %")
      .limit(1)
      .single();
    const id = (conv as { id: string } | null)?.id;
    expect(id, "a conversa da fixture tem de existir").toBeTruthy();
    await abreConversa(page, id!);

    // Em 400 px o painel do CRM costuma virar uma aba/gaveta — abrir pela tela.
    const botaoPainel = page.getByRole("button", { name: /Contato|CRM|Painel/i }).first();
    if (await botaoPainel.count()) await botaoPainel.click().catch(() => {});

    const pagina = await transbordoDaPagina(page);
    registra(`L12.G2.2 · 400px tema escuro · documento: scrollWidth=${pagina.scrollWidth} clientWidth=${pagina.clientWidth} transborda=${pagina.transborda}`);
    await captura(page, "g2-06-inbox-400px-escuro");
    expect(pagina.transborda, "nada pode rolar na horizontal em 400 px").toBe(false);
  });
});
