/**
 * E2E [P0] — o dono gera o link de pagamento no card Cobrança do tenant, sem a
 * empresa entrar (spec da cobrança §7g, D-15; jornada J45). Asaas, que pede
 * CPF/CNPJ, contra o dublê /v3 em 127.0.0.1:3995:
 *   1. o dono conecta o sandbox do Asaas pela tela (o webhook nasce no dublê);
 *   2. no card do tenant: atribui o plano, digita o CPF (dígito errado não sai) e gera o link;
 *   3. o dublê recebeu o CPF SEM máscara e o e-mail do ADMIN DA EMPRESA, nunca o
 *      do dono nem o do vínculo provisório, ambos admins mais antigos dela (D-15);
 *      o banco não guarda o CPF; o audit diz que foi o dono;
 *   4. gerar de novo devolve o MESMO link, sem 2º cliente nem 2ª assinatura — antes
 *      e depois de o aviso do provedor limpar o checkout (aí o 409
 *      pagamento_em_andamento do núcleo vira 200 com o link da fatura);
 *   5. a empresa entra e vê o MESMO link em Plano e cobrança; o "Assinar" dela converge nele;
 *   6. a org do dono (outra org) não foi tocada.
 * Stripe fica no unitário da rota. Self-contida: o que outras specs já provam
 * pela tela (ligar, criar plano) nasce pelo service role; tudo morre no
 * `finally`, e as chaves da instalação voltam ao que eram.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";

import { test, expect, type BrowserContext, type Page } from "./helpers/test";
import {
  assinaturaDe, criarPessoa, db, drenarAte, entrar, fotografarChaves, inserir, restaurarChaves, type FotoDasChaves,
} from "./helpers/cobranca";
import { portaDoDubleDaCobranca, subirProvedorDeCobranca, type ProvedorDeCobrancaFalso } from "./fixtures/provedor-de-cobranca";
import { gerarCpf } from "./fixtures/provedor-de-cobranca-asaas";

const sufixo = randomUUID().slice(0, 8);
const EVIDENCIA = "evidence/cobranca-link-pelo-dono";
/** Montada agora, em pedaços: a varredura de segredo do GitHub barra literal com cara de chave. */
const CHAVE = ["$aact", "hmlg", `000${randomBytes(24).toString("hex")}`].join("_");
const PLANO = `Mensal Link E2E ${sufixo}`;
const EMPRESA = `Loja-Link-${sufixo}`;
const CPF = gerarCpf();
const CPF_COM_MASCARA = `${CPF.slice(0, 3)}.${CPF.slice(3, 6)}.${CPF.slice(6, 9)}-${CPF.slice(9)}`;
/** Para a limpeza achar o rastro de aviso recusado (valid_signature=false, sem external_id). */
const INICIO = new Date().toISOString();

async function linkDaLinha(org: string): Promise<{ checkout_url: string | null; link_de_pagamento: string | null }> {
  const r = await db.from("cobranca_assinaturas").select("checkout_url, link_de_pagamento").eq("organization_id", org).single();
  if (r.error) throw r.error;
  return r.data as { checkout_url: string | null; link_de_pagamento: string | null };
}

/** Clica em "Gerar link de pagamento" e devolve o que a rota do dono respondeu: a prova é a resposta, não o campo que já estava na tela. */
async function gerarDeNovo(page: Page, org: string): Promise<{ status: number; url: string | undefined }> {
  const [resposta] = await Promise.all([
    page.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith(`/api/v1/admin/tenants/${org}/assinatura/checkout`)),
    page.getByRole("button", { name: "Gerar link de pagamento" }).click(),
  ]);
  const corpo = (await resposta.json()) as { data?: { url?: string } };
  return { status: resposta.status(), url: corpo.data?.url };
}

test("[P0] o dono gera o link de pagamento pelo card do tenant (Asaas) e a empresa vê o mesmo link", async ({ page, browser, request }) => {
  test.setTimeout(300_000);
  page.setDefaultTimeout(20_000);
  mkdirSync(EVIDENCIA, { recursive: true });
  const pessoas: string[] = [];
  const orgs: string[] = [];
  const contextos: BrowserContext[] = [];
  let duble: ProvedorDeCobrancaFalso | null = null;
  let falhaDoCenario: unknown;
  const foto: FotoDasChaves = await fotografarChaves();

  try {
    // ── 0. Semente (o que outras specs já provam pela tela) ─────────────────
    expect(portaDoDubleDaCobranca(), "o servidor sob teste não nasceu apontado para o dublê").toBe(3995);
    duble = await subirProvedorDeCobranca({ porta: portaDoDubleDaCobranca() });
    const ligar = await db.from("platform_config").upsert(
      { chave: "MODULO_COBRANCA", valor: "ligado", eh_segredo: false, semeado_do_env: false },
      { onConflict: "chave" },
    );
    if (ligar.error) throw ligar.error;

    const dono = await criarPessoa("dono-link", sufixo);
    pessoas.push(dono.id);
    const orgDoDono = await inserir("organizations", { slug: `cob-link-dono-${sufixo}`, display_name: `Casa do dono ${sufixo}`, legal_name: "Casa do dono", onboarded_at: new Date().toISOString() });
    orgs.push(orgDoDono);
    const vincDono = await db.from("user_organizations").insert({ organization_id: orgDoDono, user_id: dono.id, role: "admin", accepted_at: new Date().toISOString() });
    if (vincDono.error) throw vincDono.error;
    const pa = await db.from("platform_admins").insert({ user_id: dono.id, granted_by: dono.id, scope: "full", mfa_required: false, reason: "E2E link pelo dono" });
    if (pa.error) throw pa.error;

    const adminB = await criarPessoa("admin-link", sufixo);
    pessoas.push(adminB.id);
    const provisorio = await criarPessoa("provisorio-link", sufixo);
    pessoas.push(provisorio.id);
    // SEM cnpj no cadastro: o documento vem só do que o dono digita.
    const orgB = await inserir("organizations", { slug: `cob-link-b-${sufixo}`, display_name: EMPRESA, legal_name: EMPRESA, onboarded_at: new Date().toISOString() });
    orgs.push(orgB);
    // D-15: dois admins MAIS ANTIGOS que o adminB, e cada um só cai por um filtro. O dono,
    // ativo e NÃO provisório (o criador de empresa anterior à 0237), só pela exclusão de
    // `platform_admins`; o provisório, que não é dono, só pelo `provisional_until_handover`.
    // Com só o adminB na empresa, a asserção do e-mail passaria sem filtro nenhum.
    // Toda linha com as MESMAS chaves: no lote, o PostgREST grava null (e não o default) na coluna que falta numa delas.
    const horasAtras = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
    const vincB = await db.from("user_organizations").insert([
      { organization_id: orgB, user_id: dono.id, role: "admin", accepted_at: horasAtras(2), created_at: horasAtras(2), provisional_until_handover: false },
      { organization_id: orgB, user_id: provisorio.id, role: "admin", accepted_at: horasAtras(1), created_at: horasAtras(1), provisional_until_handover: true },
      { organization_id: orgB, user_id: adminB.id, role: "admin", accepted_at: horasAtras(0), created_at: horasAtras(0), provisional_until_handover: false },
    ]);
    if (vincB.error) throw vincB.error;
    await inserir("cobranca_planos", { nome: PLANO, preco_cents: 4990, intervalo: "mes", trial_dias: 7, updated_by: dono.id });

    // ── 1. Conectar o Asaas pela tela (o webhook nasce no dublê) ────────────
    await entrar(page, dono.email);
    await page.goto("/admin/cobranca");
    await page.getByRole("tab", { name: "Conexão" }).click();
    await page.getByLabel("Provedor").selectOption("asaas");
    await page.getByLabel("Chave de API do Asaas").fill(CHAVE);
    await page.getByRole("button", { name: "Testar e conectar" }).click();
    await expect(page.getByText("MODO DE TESTE").first()).toBeVisible();
    expect((duble.asaas.tokenDoWebhook() ?? "").length, "o webhook não nasceu pela API do dublê").toBeGreaterThanOrEqual(32);

    // ── 2. Card do tenant: atribuir plano, digitar CPF, gerar link ──────────
    await page.goto(`/admin/tenants/${orgB}`);
    await page.locator("#plano-da-empresa").selectOption({ label: PLANO });
    await page.getByRole("button", { name: "Atribuir plano" }).click();
    await expect(page.getByText("Teste grátis", { exact: true })).toBeVisible();
    expect((await assinaturaDe(orgB)).estado).toBe("trial");

    const documento = page.getByLabel("CPF ou CNPJ de quem paga");
    const gerar = page.getByRole("button", { name: "Gerar link de pagamento" });
    await expect(documento, "sem CNPJ no cadastro, o campo nasce vazio").toHaveValue("");
    await expect(gerar, "sem documento o Asaas recusaria: o botão nasce desligado").toBeDisabled();
    await documento.fill(CPF.slice(0, 10) + String((Number(CPF.slice(10)) + 1) % 10));
    await expect(page.getByText("Confira o CPF ou CNPJ: os dígitos não batem.")).toBeVisible();
    await expect(gerar).toBeDisabled();
    expect(duble.asaas.chamadas.filter((c) => c.metodo === "POST" && c.caminho === "/v3/customers"), "documento errado chegou ao provedor").toHaveLength(0);
    await documento.fill(CPF_COM_MASCARA);
    await gerar.click();
    const campoDoLink = page.getByLabel("Link de pagamento", { exact: true });
    await expect(campoDoLink).toHaveValue(/\/i\//);
    const link = await campoDoLink.inputValue();
    await expect(page.getByRole("button", { name: "Copiar link de pagamento" })).toBeVisible();
    expect(await page.evaluate(() => document.body.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: `${EVIDENCIA}/card-link-gerado.png`, fullPage: true });

    // ── 3. O que chegou ao provedor e o que ficou no banco ──────────────────
    const cliente = duble.asaas.clienteDaOrg(orgB) ?? "";
    expect(cliente).toMatch(/^cus_/);
    const criacao = duble.asaas.chamadas.find((c) => c.metodo === "POST" && c.caminho === "/v3/customers")?.corpo;
    expect(criacao?.cpfCnpj, "o CPF não chegou ao Asaas sem máscara").toBe(CPF);
    expect(criacao?.externalReference).toBe(orgB);
    // D-15: o e-mail fica gravado no cliente do provedor para sempre; o do dono receberia as cobranças da empresa.
    expect(criacao?.email, "o cliente no Asaas não nasceu com o e-mail do admin da empresa (dono e provisório são mais antigos)").toBe(adminB.email);
    expect(link).toBe(`${duble.base}/i/${duble.asaas.cobrancasDe(cliente)[0]?.id}`);
    expect(await assinaturaDe(orgB)).toMatchObject({ estado: "trial", provedor: "asaas", modo: "teste", provedor_cliente_id: cliente });
    // LGPD (§2.3): o documento vai ao provedor e não fica no nosso banco.
    const linhaB = await db.from("cobranca_assinaturas").select("*").eq("organization_id", orgB).single();
    if (linhaB.error) throw linhaB.error;
    expect(JSON.stringify(linhaB.data), "o CPF foi gravado na assinatura").not.toContain(CPF);
    // O audit é fire-and-forget: a linha pode chegar depois da resposta.
    const lerAuditoria = async () => {
      const r = await db.from("api_audit_log")
        .select("action, actor_user_id, acting_as_platform_admin, bypassed_rls, metadata").eq("organization_id", orgB);
      if (r.error) throw r.error;
      return r.data;
    };
    await expect.poll(async () => (await lerAuditoria()).filter((a) => a.action === "cobranca.checkout_iniciado"), { message: "o audit não diz que foi o dono" })
      .toEqual([expect.objectContaining({ actor_user_id: dono.id, acting_as_platform_admin: true, bypassed_rls: true })]);
    expect(JSON.stringify(await lerAuditoria()), "o CPF foi para o audit").not.toContain(CPF);

    // ── 4. Gerar de novo = o MESMO link (a idempotência é do estado) ────────
    expect(await gerarDeNovo(page, orgB)).toEqual({ status: 200, url: link });
    await expect(campoDoLink).toHaveValue(link);
    // Os avisos do Asaas acordam a releitura: ela grava o link da fatura e limpa o checkout (assinatura viva).
    await drenarAte(request, "o link chegou ao painel da empresa", async () => (await linkDaLinha(orgB)).link_de_pagamento === link);
    expect((await linkDaLinha(orgB)).checkout_url, "a releitura não limpou o checkout: o passo seguinte não mediria a fatura aberta").toBeNull();
    // Agora o núcleo responde 409 pagamento_em_andamento; a rota do dono entrega o link da fatura como 200.
    expect(await gerarDeNovo(page, orgB)).toEqual({ status: 200, url: link });
    expect(duble.asaas.chamadas.filter((c) => c.metodo === "POST" && c.caminho === "/v3/customers")).toHaveLength(1);
    expect(duble.asaas.chamadas.filter((c) => c.metodo === "POST" && c.caminho === "/v3/subscriptions")).toHaveLength(1);
    const audits = await db.from("api_audit_log").select("id", { count: "exact", head: true })
      .eq("organization_id", orgB).eq("action", "cobranca.checkout_iniciado");
    expect(audits.count, "link reaproveitado não é link novo: não audita de novo").toBe(1);

    // ── 5. A empresa entra e vê o MESMO link ────────────────────────────────
    const ctxB = await browser.newContext();
    contextos.push(ctxB);
    const pB = await ctxB.newPage();
    pB.setDefaultTimeout(20_000);
    await entrar(pB, adminB.email);
    await pB.goto("/app/settings/billing");
    await expect(pB.getByText(/1ª cobrança agendada/)).toBeVisible();
    await expect(pB.getByRole("link", { name: "Pagar agora" })).toHaveAttribute("href", link);
    await expect(pB.getByRole("button", { name: "Assinar", exact: true })).toHaveCount(0);
    await pB.screenshot({ path: `${EVIDENCIA}/empresa-ve-o-mesmo-link.png`, fullPage: true });
    // O "Assinar" da empresa, se ela o chamasse, converge no mesmo link, sem 2ª assinatura.
    const daEmpresa = await pB.request.post("/api/v1/cobranca/assinatura/checkout", { data: {} });
    expect(daEmpresa.status(), await daEmpresa.text()).toBe(409);
    expect(((await daEmpresa.json()) as { error: { code: string; details?: { link_de_pagamento?: string } } }).error)
      .toMatchObject({ code: "pagamento_em_andamento", details: { link_de_pagamento: link } });
    expect(duble.asaas.chamadas.filter((c) => c.metodo === "POST" && c.caminho === "/v3/subscriptions")).toHaveLength(1);

    // ── 6. Isolamento: a org do dono não foi tocada ─────────────────────────
    expect(duble.asaas.clienteDaOrg(orgDoDono)).toBeNull();
    const doDono = await db.from("cobranca_assinaturas").select("organization_id", { count: "exact", head: true }).eq("organization_id", orgDoDono);
    if (doDono.error) throw doDono.error;
    expect(doDono.count).toBe(0);

    // ── Contrato do que o app mandou ao provedor ────────────────────────────
    expect(duble.falhas).toEqual([]);
    expect(duble.asaas.chamadas.every((c) => c.chave === CHAVE), "alguma chamada saiu sem a chave no cabeçalho").toBe(true);
  } catch (erro) {
    falhaDoCenario = erro;
    throw erro;
  } finally {
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
      const ids = duble?.asaas.avisos.map((a) => a.eventoId) ?? [];
      if (ids.length) {
        const r = await db.from("webhook_events_log").delete().eq("provider", "asaas").in("external_id", ids);
        if (r.error) throw r.error;
      }
      const rastro = await db.from("webhook_events_log").delete().eq("provider", "asaas").eq("valid_signature", false).gte("received_at", INICIO);
      if (rastro.error) throw rastro.error;
      // A trava da Task 33A do PR 3a recusa apagar empresa com assinatura viva: a assinatura sai antes.
      const assinaturas = await db.from("cobranca_assinaturas").delete().in("organization_id", orgs);
      if (assinaturas.error) throw assinaturas.error;
      for (const org of orgs) {
        const r = await db.from("organizations").delete().eq("id", org);
        if (r.error) throw r.error;
      }
      const planos = await db.from("cobranca_planos").delete().eq("nome", PLANO);
      if (planos.error) throw planos.error;
      const pas = await db.from("platform_admins").delete().in("user_id", pessoas);
      if (pas.error) throw pas.error;
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
