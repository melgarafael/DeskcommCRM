/**
 * E2E [P0] — a primeira cobrança do revendedor, pela tela, com receiver real
 * (spec da cobrança §7(a)–(e), §8, §9, §12). Um caso só, porque cada passo parte
 * do estado do anterior:
 *   1. o dono liga a cobrança em /admin/sistema e acha a porta;
 *   2. conecta a Stripe em TESTE (o dublê em 127.0.0.1:3995), ajusta a régua e
 *      cria dois planos, um deles o do cadastro;
 *   3. um cliente se cadastra e nasce em teste grátis; a faixa leva ao plano;
 *      "Assinar" abre o checkout hospedado; a volta mostra a 1ª cobrança agendada;
 *   4. os avisos chegam ASSINADOS à rota real e viram só ponteiro; o forjado leva
 *      401 e deixa rastro que a Visão geral mostra;
 *   5. a 1ª cobrança paga → "Em dia"; o checklist do dono marca chave, plano,
 *      aviso e compra, e diz que falta publicar (faixa do modo de teste);
 *   6. trocar de plano depois do teste: vale na virada paga;
 *   7. atraso → aviso "venceu" com link de pagamento → aviso final → suspensão
 *      (datas RECUADAS no banco; o cron roda com o now() real);
 *   8. no hub, "Já paguei" sem pagar não reativa; pagar a fatura reativa sozinha,
 *      sem rajada, com um item de revisão.
 * Self-contida: tudo nasce pelo service role ou pela tela, e morre no `finally`.
 * As chaves da instalação voltam ao que eram.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";

import { test, expect, type BrowserContext } from "./helpers/test";
import { extractAuthConfirmLink, seguirLinkDeAcesso, uniqueEmail, waitForEmail } from "./helpers/auth";
import {
  assinaturaDe, contarAuditoria, criarPessoa, db, diasAtras, drenarAte, entrar, estadoDaOrg, fotografarChaves,
  horasAtras, inserir, recuar, restaurarChaves, rodarCronDaCobranca, saidasDe, senha, type FotoDasChaves,
} from "./helpers/cobranca";
import { portaDoDubleDaCobranca, subirProvedorDeCobranca, type ProvedorDeCobrancaFalso } from "./fixtures/provedor-de-cobranca";

const sufixo = randomUUID().slice(0, 8);
const EVIDENCIA = "evidence/cobranca-revendedor";
const CHAVE = `rk_test_${randomBytes(16).toString("hex")}`;
const ESSENCIAL = `Essencial E2E ${sufixo}`;
const PROFISSIONAL = `Profissional E2E ${sufixo}`;
const EMPRESA = `Loja-Assinante-${sufixo}`;
/** Para a limpeza achar o rastro do aviso forjado (valid_signature=false, sem external_id). */
const INICIO = new Date().toISOString();

test("[P0] primeira cobrança: conectar, assinar, atrasar, suspender e voltar sozinho ao pagar", async ({ page, browser, request }) => {
  test.setTimeout(600_000);
  page.setDefaultTimeout(20_000);
  mkdirSync(EVIDENCIA, { recursive: true });
  const pessoas: string[] = [];
  const orgs: string[] = [];
  const contextos: BrowserContext[] = [];
  let duble: ProvedorDeCobrancaFalso | null = null;
  let falhaDoCenario: unknown;
  const foto: FotoDasChaves = await fotografarChaves();

  try {
    // ── 0. Precondições medidas ─────────────────────────────────────────────
    expect(portaDoDubleDaCobranca(), "o servidor sob teste não nasceu apontado para o dublê").toBe(3995);
    const padrao = await db.from("cobranca_planos").select("id", { count: "exact", head: true }).eq("padrao_no_cadastro", true).is("arquivado_em", null);
    expect(padrao.count, "já existe plano do cadastro: outra spec vazou estado").toBe(0);
    duble = await subirProvedorDeCobranca({ porta: portaDoDubleDaCobranca() });
    const apaga = await db.from("platform_config").delete().eq("chave", "MODULO_COBRANCA");
    if (apaga.error) throw apaga.error;

    const dono = await criarPessoa("dono", sufixo);
    pessoas.push(dono.id);
    const orgDoDono = await inserir("organizations", { slug: `cob-dono-${sufixo}`, display_name: `Casa do dono ${sufixo}`, legal_name: "Casa do dono", onboarded_at: new Date().toISOString() });
    orgs.push(orgDoDono);
    const vinc = await db.from("user_organizations").insert({ organization_id: orgDoDono, user_id: dono.id, role: "admin", accepted_at: new Date().toISOString() });
    if (vinc.error) throw vinc.error;
    const pa = await db.from("platform_admins").insert({ user_id: dono.id, granted_by: dono.id, scope: "full", mfa_required: false, reason: "E2E cobrança P0" });
    if (pa.error) throw pa.error;

    // ── 1. O dono liga a cobrança e acha a porta ───────────────────────────
    await entrar(page, dono.email);
    await page.goto("/admin/sistema");
    const interruptor = page.getByRole("switch", { name: "Cobrança dos seus clientes" });
    await expect(interruptor).toHaveAttribute("aria-checked", "false");
    await interruptor.click();
    await expect(interruptor).toHaveAttribute("aria-checked", "true");
    await expect(page.getByText(/Empresas que já existem ficam isentas/)).toBeVisible();
    await page.screenshot({ path: `${EVIDENCIA}/sistema-cobranca-ligada.png`, fullPage: true });
    await page.goto("/admin/dashboard");
    await page.getByRole("link", { name: "Cobrança" }).first().click();
    await page.waitForURL("**/admin/cobranca");
    // Estado vazio que ensina: o primeiro passo do checklist é conectar.
    await expect(page.locator('[data-passo="chave"]')).toHaveAttribute("data-feito", "false");

    // ── 2. Conexão em teste, régua e planos ─────────────────────────────────
    await page.getByRole("tab", { name: "Conexão" }).click();
    await page.getByLabel("Provedor").selectOption("stripe");
    await page.getByLabel("Chave secreta").fill(CHAVE);
    await page.getByRole("button", { name: "Testar e conectar" }).click();
    await expect(page.getByText("MODO DE TESTE").first()).toBeVisible();
    await expect(page.getByText(`…${CHAVE.slice(-4)}`).first()).toBeVisible();
    expect(await page.content()).not.toContain(CHAVE);
    expect(duble.urlDoWebhook()).toBe(`${process.env.NEXT_PUBLIC_APP_URL}/api/v1/webhooks/cobranca/stripe`);
    const guardada = await db.from("platform_config").select("*").eq("chave", "STRIPE_SECRET_KEY").single();
    if (guardada.error) throw guardada.error;
    expect(guardada.data).toMatchObject({ eh_segredo: true, last4: CHAVE.slice(-4), valor: null });
    expect(JSON.stringify(guardada.data)).not.toContain(CHAVE);
    const auditConexao = await db.from("api_audit_log").select("metadata").eq("action", "cobranca.provedor_conectado").order("created_at", { ascending: false }).limit(1).single();
    expect(JSON.stringify(auditConexao.data?.metadata ?? null)).not.toContain(CHAVE);
    await page.screenshot({ path: `${EVIDENCIA}/conexao-modo-de-teste.png`, fullPage: true });

    await page.getByRole("tab", { name: "Régua" }).click();
    await page.getByLabel("Dias de tolerância").fill("5");
    await page.getByRole("button", { name: "Salvar régua" }).click();
    await expect.poll(async () => (await db.from("platform_config").select("valor").eq("chave", "COBRANCA_TOLERANCIA_DIAS").maybeSingle()).data?.valor).toBe("5");

    await page.getByRole("tab", { name: "Planos" }).click();
    for (const [nome, preco] of [[ESSENCIAL, "49,90"], [PROFISSIONAL, "99,90"]] as const) {
      await page.getByLabel("Nome do plano").fill(nome);
      await page.getByLabel("Preço (R$)").fill(preco);
      await page.getByLabel("Dias de teste grátis").fill("7");
      await page.getByRole("button", { name: "Salvar plano" }).click();
      await expect(page.getByText(nome)).toBeVisible();
    }
    await page.locator("li, tr").filter({ hasText: ESSENCIAL }).getByRole("button", { name: "Usar no cadastro" }).click();
    await expect.poll(async () => (await db.from("cobranca_planos").select("padrao_no_cadastro").eq("nome", ESSENCIAL).single()).data?.padrao_no_cadastro).toBe(true);
    const planos = await db.from("cobranca_planos").select("id, nome").in("nome", [ESSENCIAL, PROFISSIONAL]);
    if (planos.error) throw planos.error;
    const idEssencial = planos.data.find((p) => p.nome === ESSENCIAL)!.id as string;
    const idProfissional = planos.data.find((p) => p.nome === PROFISSIONAL)!.id as string;

    // ── 3. O cliente se cadastra e nasce em teste grátis ────────────────────
    const ctxB = await browser.newContext();
    contextos.push(ctxB);
    const pB = await ctxB.newPage();
    pB.setDefaultTimeout(20_000);
    const emailB = uniqueEmail("cobranca");
    await pB.goto("/login");
    await pB.getByRole("link", { name: "Criar conta" }).click();
    await pB.getByLabel("Nome da empresa").fill(EMPRESA);
    await pB.getByLabel("Email").fill(emailB);
    await pB.getByLabel("Senha", { exact: true }).fill(senha);
    await pB.getByLabel("Confirmar senha").fill(senha);
    await pB.getByRole("button", { name: "Criar conta" }).click();
    await expect(pB.getByText("Confirme seu e-mail")).toBeVisible();
    const confirmacao = extractAuthConfirmLink(await waitForEmail(emailB, "Confirme seu e-mail"), test.info().project.use.baseURL!);
    // Abrir o link não gasta o token (protege do verificador de links do e-mail): a pessoa aperta "Continuar".
    await seguirLinkDeAcesso(pB, confirmacao);
    await pB.waitForURL(/\/onboarding\//);
    const nova = await db.from("organizations").select("id, created_by").or(`display_name.eq.${EMPRESA},legal_name.eq.${EMPRESA}`).single();
    if (nova.error) throw nova.error;
    const orgB = nova.data.id as string;
    orgs.push(orgB);
    if (nova.data.created_by) pessoas.push(nova.data.created_by as string);
    expect(await assinaturaDe(orgB)).toMatchObject({ estado: "trial", plano_id: idEssencial, provedor: null });
    // O onboarding é a J1; aqui ele só sai do caminho.
    const pula = await db.from("organizations").update({ onboarded_at: new Date().toISOString() }).eq("id", orgB);
    if (pula.error) throw pula.error;
    // Uma conversa para o "sem rajada" do fim (plano sem teto de números).
    const canal = await inserir("channel_sessions", { organization_id: orgB, waha_session_name: `cob-${randomUUID()}`, display_name: "Canal B", status: "STOPPED", webhook_secret_encrypted: "\\x00" });
    const contato = await inserir("contacts", { organization_id: orgB, name: `Cliente B ${sufixo}`, display_name: `Cliente B ${sufixo}` });
    const conversa = await inserir("conversations", { organization_id: orgB, contact_id: contato, channel_session_id: canal, status: "open" });

    await pB.goto("/app");
    const faixa = pB.getByRole("status").filter({ hasText: /Seu teste grátis termina em [67] dias\./ });
    await expect(faixa).toBeVisible();
    await faixa.getByRole("link", { name: "Ver o plano" }).click();
    await pB.waitForURL("**/app/settings/billing");
    await pB.getByRole("button", { name: "Assinar", exact: true }).click();
    await pB.waitForURL((url) => url.origin === duble!.base && url.pathname.startsWith("/checkout/"));
    await expect(pB.getByRole("heading", { name: "Checkout de teste" })).toBeVisible();
    await expect(pB.getByText(ESSENCIAL)).toBeVisible();
    await pB.screenshot({ path: `${EVIDENCIA}/checkout-do-duble.png`, fullPage: true });
    await pB.getByRole("button", { name: "Pagar com cartão de teste" }).click();
    await pB.waitForURL(/\/app\/settings\/billing\?voltou=1/);
    // Estrito de propósito: só o PAINEL diz "1ª cobrança agendada"; o recado da volta usa outra frase (Task 40).
    await expect(pB.getByText(/1ª cobrança agendada/)).toBeVisible({ timeout: 60_000 });
    await pB.screenshot({ path: `${EVIDENCIA}/billing-cobranca-agendada.png`, fullPage: true });
    const cliente = duble.clienteDaOrg(orgB);
    expect(cliente).toMatch(/^cus_/);
    await expect.poll(async () => assinaturaDe(orgB)).toMatchObject({ estado: "trial", provedor: "stripe", modo: "teste", provedor_cliente_id: cliente, checkout_url: null });
    // O checkout em teste grátis já é a compra: o dono não espera 7 dias pelo passo (Divergência 48).
    await page.goto("/admin/cobranca");
    await expect(page.locator('[data-passo="compra"]')).toHaveAttribute("data-feito", "true");

    // ── 4. Os avisos chegaram assinados e viraram só ponteiro ───────────────
    const ids = duble.avisos.map((a) => a.eventoId);
    expect(duble.avisos.every((a) => a.status === 200), JSON.stringify(duble.avisos)).toBe(true);
    const linhas = await db.from("webhook_events_log").select("organization_id, headers, raw_body, status, signature_header").eq("provider", "stripe").in("external_id", ids);
    if (linhas.error) throw linhas.error;
    expect(linhas.data).toHaveLength(ids.length);
    for (const l of linhas.data) {
      expect(l.organization_id).toBeNull();
      expect(l.headers).toBeNull();
      expect(Object.keys(JSON.parse(l.raw_body as string)).sort()).toEqual(["id", "type"]);
      expect(l.status).toBe("processed");
      expect(l.signature_header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    }
    expect(await duble.enviarAvisoForjado(cliente!), "aviso com assinatura errada foi aceito").toBe(401);

    // ── 5. A 1ª cobrança paga: "Em dia" e o checklist do dono ──────────────
    await duble.cobrarAgora(cliente!);
    await drenarAte(request, "assinatura ativa", async () => (await assinaturaDe(orgB)).estado === "ativa");
    await pB.goto("/app/settings/billing");
    await expect(pB.getByText("Em dia", { exact: true })).toBeVisible();
    await pB.screenshot({ path: `${EVIDENCIA}/billing-em-dia.png`, fullPage: true });
    await page.goto("/admin/cobranca");
    for (const passo of ["chave", "plano", "aviso", "compra"]) {
      await expect(page.locator(`[data-passo="${passo}"]`)).toHaveAttribute("data-feito", "true");
    }
    // O fresco não tem envio de e-mail: o checklist aponta o próximo passo em vez de fingir.
    await expect(page.locator('[data-passo="email"]')).toHaveAttribute("data-feito", "false");
    // Em teste, o checklist NÃO termina: falta publicar, e a faixa diz que empresas reais não pagam.
    await expect(page.locator('[data-passo="publicar"]')).toHaveAttribute("data-feito", "false");
    await expect(page.getByRole("alert").filter({ hasText: "não conseguem pagar" })).toBeVisible();
    // O aviso forjado do passo 4 deixou rastro que o dono vê.
    await expect(page.getByText(/\d+ avisos? de pagamento recusados? nas últimas 24 h/)).toBeVisible();
    expect(await page.evaluate(() => document.body.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: `${EVIDENCIA}/visao-geral-checklist.png`, fullPage: true });

    // ── 6. Trocar de plano depois do teste: vale na virada paga ─────────────
    await pB.getByRole("button", { name: "Trocar de plano" }).click();
    await pB.getByLabel("Novo plano").selectOption(idProfissional);
    await pB.getByRole("button", { name: "Confirmar troca" }).click();
    await expect(pB.getByText(/O novo plano vale a partir de \d{2}\/\d{2}/)).toBeVisible();
    expect(await assinaturaDe(orgB)).toMatchObject({ plano_id: idEssencial, plano_agendado_id: idProfissional });
    expect(duble.assinaturaPrincipal(cliente!)).toMatchObject({ unit_amount: 9990, proration_behavior: "none" });
    await pB.screenshot({ path: `${EVIDENCIA}/billing-troca-agendada.png`, fullPage: true });

    // ── 7. Atraso, avisos com link de pagamento, suspensão ──────────────────
    const linkDaFatura = await duble.atrasar(cliente!);
    await drenarAte(request, "em atraso com aviso", async () => {
      const a = await assinaturaDe(orgB);
      return a.estado === "em_atraso" && a.ultimo_aviso === "venceu";
    });
    await pB.goto("/app/ai/inbox");
    const venceu = pB.getByTestId("inbox-item").filter({ hasText: "Não identificamos o pagamento" });
    await expect(venceu).toHaveCount(1);
    await expect(venceu.getByRole("link", { name: "Pagar agora" })).toHaveAttribute("href", linkDaFatura);
    await pB.screenshot({ path: `${EVIDENCIA}/central-aviso-venceu.png`, fullPage: true });
    await pB.goto("/app");
    await expect(pB.getByRole("link", { name: "Pagar agora" }).first()).toHaveAttribute("href", linkDaFatura);
    await pB.screenshot({ path: `${EVIDENCIA}/faixa-em-atraso.png`, fullPage: true });

    // Tolerância 5: vencida há 4 dias → a 2 dias do limite → aviso final.
    await recuar(orgB, { vencida_desde: diasAtras(4) });
    await rodarCronDaCobranca(request);
    expect((await assinaturaDe(orgB)).ultimo_aviso).toBe("suspende_em_breve");
    expect((await estadoDaOrg(orgB)).status).toBe("active");
    await pB.goto("/app/ai/inbox");
    await expect(pB.getByTestId("inbox-item").filter({ hasText: "será suspensa em" })).toHaveCount(1);
    await pB.screenshot({ path: `${EVIDENCIA}/central-aviso-final.png`, fullPage: true });

    // Limite vencido e aviso final dado há 49 h → suspende (releitura < 1 h).
    await recuar(orgB, { vencida_desde: diasAtras(6), ultimo_aviso_em: horasAtras(49) });
    await rodarCronDaCobranca(request);
    expect(await estadoDaOrg(orgB)).toEqual({ status: "suspended", suspended_kind: "cobranca" });
    expect(await contarAuditoria("cobranca.org_suspensa", orgB)).toBeGreaterThanOrEqual(1);
    const marca = await db.rpc("fn_mark_conversation_message", { p_conv: conversa, p_direction: "inbound", p_preview: "Oi, tem alguém aí?", p_at: new Date().toISOString() });
    if (marca.error) throw marca.error;

    // ── 8. Hub: "Já paguei" sem pagar não reativa; pagar reativa sozinho ────
    await pB.goto("/app");
    await pB.waitForURL("**/account-suspended");
    // Um link só no hub (o painel não repete o botão; a faixa não existe fora de /app): o locator é estrito.
    const pagar = pB.getByRole("link", { name: "Pagar agora" });
    await expect(pagar).toHaveAttribute("href", linkDaFatura);
    await pB.screenshot({ path: `${EVIDENCIA}/hub-pagar-agora.png`, fullPage: true });
    await pB.getByRole("button", { name: "Já paguei" }).click();
    await expect(pB.getByText(/Ainda não identificamos o pagamento/)).toBeVisible({ timeout: 30_000 });
    expect((await estadoDaOrg(orgB)).status).toBe("suspended");
    const hrefDaFatura = (await pagar.getAttribute("href")) ?? "";
    await pB.goto(hrefDaFatura);
    await pB.getByRole("button", { name: "Pagar fatura" }).click();
    await expect(pB.getByText("Fatura paga")).toBeVisible();
    await drenarAte(request, "reativada sozinha", async () => (await estadoDaOrg(orgB)).status === "active");
    expect(await assinaturaDe(orgB)).toMatchObject({ estado: "ativa", ultimo_aviso: null, plano_id: idProfissional, plano_agendado_id: null });
    expect(await saidasDe(orgB)).toEqual({ llm: 0, outbound: 0 });
    const revisao = await db.from("agent_inbox_items").select("id").eq("organization_id", orgB).eq("kind", "org_reativada");
    if (revisao.error) throw revisao.error;
    expect(revisao.data).toHaveLength(1);
    expect(await contarAuditoria("cobranca.org_reativada", orgB)).toBeGreaterThanOrEqual(1);
    await pB.goto("/app/inbox");
    await expect(pB).toHaveURL(/\/app\/inbox/);
    await pB.screenshot({ path: `${EVIDENCIA}/reativada-sem-rajada.png`, fullPage: true });

    // ── Contrato do que o app mandou ao provedor ────────────────────────────
    expect(duble.falhas).toEqual([]);
    expect(duble.chamadas.every((c) => c.autorizacao === `Bearer ${CHAVE}`)).toBe(true);
    expect(duble.chamadas.filter((c) => c.metodo === "POST").every((c) => (c.idempotencia ?? "") !== "")).toBe(true);
  } catch (erro) {
    falhaDoCenario = erro;
    throw erro;
  } finally {
    // Primeiro o que vaza para as specs seguintes do MESMO job (workers: 1, mesmo banco):
    // as chaves da instalação (cobrança ligada, provedor apontando para o dublê) e a porta
    // do dublê. Cada um no seu try: uma falha adiante não pode pular estes dois.
    const errosDaLimpeza: unknown[] = [];
    try {
      await restaurarChaves(foto);
    } catch (e) {
      errosDaLimpeza.push(e);
    }
    try {
      await duble?.fechar();
    } catch (e) {
      errosDaLimpeza.push(e);
    }
    try {
      const fechamentos = await Promise.allSettled(contextos.map((c) => c.close()));
      const falhas = fechamentos.filter((r) => r.status === "rejected");
      if (falhas.length) throw new AggregateError(falhas.map((r) => r.reason), "falha ao fechar contextos");
      const ids = duble?.avisos.map((a) => a.eventoId) ?? [];
      if (ids.length) {
        const r = await db.from("webhook_events_log").delete().eq("provider", "stripe").in("external_id", ids);
        if (r.error) throw r.error;
      }
      const rastro = await db.from("webhook_events_log").delete().eq("provider", "stripe").eq("valid_signature", false).gte("received_at", INICIO);
      if (rastro.error) throw rastro.error;
      // A trava da Task 33A recusa apagar empresa com assinatura viva no provedor
      // (o dublê não cancela nada): a assinatura sai antes, a empresa depois.
      const assinaturas = await db.from("cobranca_assinaturas").delete().in("organization_id", orgs);
      if (assinaturas.error) throw assinaturas.error;
      for (const org of orgs) {
        const r = await db.from("organizations").delete().eq("id", org);
        if (r.error) throw r.error;
      }
      const planos = await db.from("cobranca_planos").delete().in("nome", [ESSENCIAL, PROFISSIONAL]);
      if (planos.error) throw planos.error;
      const pa = await db.from("platform_admins").delete().in("user_id", pessoas);
      if (pa.error) throw pa.error;
      for (const id of pessoas) {
        const r = await db.auth.admin.deleteUser(id);
        if (r.error) throw r.error;
      }
    } catch (e) {
      errosDaLimpeza.push(e);
    }
    if (errosDaLimpeza.length) {
      const motivos = errosDaLimpeza.map((e) => (e instanceof Error ? e.message : String(e))).join(" | ");
      test.info().annotations.push({ type: "cleanup", description: `limpeza incompleta: orgs ${orgs.join(",")} — ${motivos}` });
      if (!falhaDoCenario) throw errosDaLimpeza[0];
    }
  }
});
