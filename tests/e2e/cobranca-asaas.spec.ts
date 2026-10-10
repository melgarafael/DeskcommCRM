/**
 * E2E [P0] — Pix e boleto recorrentes pelo Asaas, pela tela, com receiver real
 * (spec da cobrança §6.2, §7(a), §7(b), §7(f); jornada J44). Variação CURTA da
 * cobranca-revendedor.spec.ts (Stripe): régua, suspensão, hub e checklist são os
 * mesmos nos dois provedores e já são provados lá. Aqui, só o que o Asaas muda:
 *   1. o dono escolhe Asaas na Conexão (a tela diz para que serve cada provedor) e
 *      conecta a chave do sandbox — o dialeto /v3 do dublê em 127.0.0.1:3995;
 *   2. a tela pede o CPF/CNPJ de quem paga, já preenchido com o CNPJ do cadastro,
 *      e não deixa assinar com dígito verificador errado;
 *   3. a fatura do Asaas abre numa ABA NOVA e o sistema fica na original (a fatura
 *      não devolve o cliente); "Já paguei" sem pagar NÃO é assinar;
 *   3b. um aviso com o token CERTO e corpo que jura "pago" (o token vazou) não
 *      ativa nada: o app relê e a assinatura segue em teste;
 *   4. Pix pago: o aviso chega com o token (só acorda a leitura) → "Em dia";
 *   5. cancelar: "acesso até DD/MM" é o fim do período pago, lido com includeDeleted.
 * Self-contida: o que a J43 já prova pela tela (ligar, planos, cadastro) nasce
 * pelo service role; tudo morre no `finally`, e as chaves da instalação voltam ao que eram.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";

import { test, expect, type BrowserContext } from "./helpers/test";
import {
  assinaturaDe, criarPessoa, db, drenarAte, entrar, fotografarChaves, inserir, restaurarChaves, type FotoDasChaves,
} from "./helpers/cobranca";
import { portaDoDubleDaCobranca, subirProvedorDeCobranca, type ProvedorDeCobrancaFalso } from "./fixtures/provedor-de-cobranca";
import { gerarCnpj, hojeEmSaoPaulo } from "./fixtures/provedor-de-cobranca-asaas";

const sufixo = randomUUID().slice(0, 8);
const EVIDENCIA = "evidence/cobranca-asaas";
/** Montada agora, em pedaços: a varredura de segredo do GitHub barra literal com cara de chave. */
const CHAVE = ["$aact", "hmlg", `000${randomBytes(24).toString("hex")}`].join("_");
const PLANO = `Mensal Pix E2E ${sufixo}`;
const EMPRESA = `Loja-Asaas-${sufixo}`;
const CNPJ = gerarCnpj();
const CNPJ_COM_MASCARA = `${CNPJ.slice(0, 2)}.${CNPJ.slice(2, 5)}.${CNPJ.slice(5, 8)}/${CNPJ.slice(8, 12)}-${CNPJ.slice(12)}`;
/** Para a limpeza achar o rastro do aviso forjado (valid_signature=false, sem external_id). */
const INICIO = new Date().toISOString();
const diaEMes = (civil: string) => `${civil.slice(8, 10)}/${civil.slice(5, 7)}`;
const fimDoDiaEmSaoPaulo = (civil: string) => new Date(`${civil}T23:59:59-03:00`).toISOString();

async function relidaEm(org: string): Promise<string | null> {
  const r = await db.from("cobranca_assinaturas").select("relida_em").eq("organization_id", org).single();
  if (r.error) throw r.error;
  return (r.data as { relida_em: string | null }).relida_em;
}

test("[P0] Asaas: conectar, assinar com CPF/CNPJ, pagar com Pix e cancelar mantendo o período pago", async ({ page, browser, request }) => {
  test.setTimeout(360_000);
  page.setDefaultTimeout(20_000);
  mkdirSync(EVIDENCIA, { recursive: true });
  const pessoas: string[] = [];
  const orgs: string[] = [];
  const contextos: BrowserContext[] = [];
  let duble: ProvedorDeCobrancaFalso | null = null;
  let falhaDoCenario: unknown;
  const foto: FotoDasChaves = await fotografarChaves();

  try {
    // ── 0. Precondições e semente ───────────────────────────────────────────
    expect(portaDoDubleDaCobranca(), "o servidor sob teste não nasceu apontado para o dublê").toBe(3995);
    duble = await subirProvedorDeCobranca({ porta: portaDoDubleDaCobranca() });
    const ligar = await db.from("platform_config").upsert(
      { chave: "MODULO_COBRANCA", valor: "ligado", eh_segredo: false, semeado_do_env: false },
      { onConflict: "chave" },
    );
    if (ligar.error) throw ligar.error;

    const dono = await criarPessoa("dono-asaas", sufixo);
    pessoas.push(dono.id);
    const orgDoDono = await inserir("organizations", { slug: `cob-asaas-dono-${sufixo}`, display_name: `Casa do dono ${sufixo}`, legal_name: "Casa do dono", onboarded_at: new Date().toISOString() });
    orgs.push(orgDoDono);
    const vincDono = await db.from("user_organizations").insert({ organization_id: orgDoDono, user_id: dono.id, role: "admin", accepted_at: new Date().toISOString() });
    if (vincDono.error) throw vincDono.error;
    const pa = await db.from("platform_admins").insert({ user_id: dono.id, granted_by: dono.id, scope: "full", mfa_required: false, reason: "E2E cobrança Asaas" });
    if (pa.error) throw pa.error;

    const adminB = await criarPessoa("admin-asaas", sufixo);
    pessoas.push(adminB.id);
    // CNPJ com máscara, como a pessoa digita no cadastro: a tela tem de limpar antes de mandar.
    const orgB = await inserir("organizations", { slug: `cob-asaas-b-${sufixo}`, display_name: EMPRESA, legal_name: EMPRESA, cnpj: CNPJ_COM_MASCARA, onboarded_at: new Date().toISOString() });
    orgs.push(orgB);
    const vincB = await db.from("user_organizations").insert({ organization_id: orgB, user_id: adminB.id, role: "admin", accepted_at: new Date().toISOString() });
    if (vincB.error) throw vincB.error;
    const plano = await inserir("cobranca_planos", { nome: PLANO, preco_cents: 4990, intervalo: "mes", trial_dias: 7, updated_by: dono.id });
    // Teste grátis de 3 dias: no Asaas, o 1º vencimento é o fim dele (nextDueDate = max(hoje, trialAte), §6.2).
    const trialAte = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const assina = await db.from("cobranca_assinaturas").insert({ organization_id: orgB, plano_id: plano, estado: "trial", trial_ate: trialAte });
    if (assina.error) throw assina.error;

    // ── 1. O dono escolhe Asaas e conecta o sandbox ─────────────────────────
    await entrar(page, dono.email);
    await page.goto("/admin/cobranca");
    await page.getByRole("tab", { name: "Conexão" }).click();
    await expect(page.getByText(/paga por Pix, boleto ou cartão/)).toBeVisible();
    await page.getByLabel("Provedor").selectOption("asaas");
    await page.getByLabel("Chave de API do Asaas").fill(CHAVE);
    await page.getByRole("button", { name: "Testar e conectar" }).click();
    await expect(page.getByText("MODO DE TESTE").first()).toBeVisible();
    await expect(page.getByText(`…${CHAVE.slice(-4)}`).first()).toBeVisible();
    const token = duble.asaas.tokenDoWebhook() ?? "";
    expect(token.length, "o webhook não nasceu pela API do dublê").toBeGreaterThanOrEqual(32);
    expect(duble.asaas.urlDoWebhook()).toMatch(
      new RegExp(`^${`${process.env.NEXT_PUBLIC_APP_URL}/api/v1/webhooks/cobranca/asaas`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\?conexao=[0-9a-f]{8}$`),
    );
    const html = await page.content();
    // includes + toBe(false): `not.toContain` imprimiria o segredo inteiro no log justamente ao falhar.
    expect(html.includes(CHAVE), "a chave apareceu na tela").toBe(false);
    expect(html.includes(token), "no modo automático o token do webhook nunca aparece na tela").toBe(false);
    const guardadas = await db.from("platform_config").select("chave, eh_segredo, last4, valor").in("chave", ["ASAAS_API_KEY", "ASAAS_WEBHOOK_TOKEN", "COBRANCA_PROVEDOR"]);
    if (guardadas.error) throw guardadas.error;
    expect(guardadas.data.find((g) => g.chave === "ASAAS_API_KEY")).toMatchObject({ eh_segredo: true, last4: CHAVE.slice(-4), valor: null });
    expect(guardadas.data.find((g) => g.chave === "ASAAS_WEBHOOK_TOKEN")).toMatchObject({ eh_segredo: true, valor: null });
    expect(guardadas.data.find((g) => g.chave === "COBRANCA_PROVEDOR")?.valor).toBe("asaas");
    expect(JSON.stringify(guardadas.data).includes(CHAVE), "a chave ficou em claro no banco").toBe(false);
    await page.screenshot({ path: `${EVIDENCIA}/conexao-asaas-modo-de-teste.png`, fullPage: true });

    // ── 2. O documento de quem paga: preenchido, conferido, sem máscara ─────
    const ctxB = await browser.newContext();
    contextos.push(ctxB);
    const pB = await ctxB.newPage();
    pB.setDefaultTimeout(20_000);
    await entrar(pB, adminB.email);
    await pB.goto("/app/settings/billing");
    const documento = pB.getByLabel("CPF ou CNPJ de quem paga");
    expect((await documento.inputValue()).replace(/\D/g, ""), "não veio preenchido com o CNPJ do cadastro").toBe(CNPJ);
    await documento.fill(CNPJ.slice(0, 13) + String((Number(CNPJ.slice(13)) + 1) % 10));
    await expect(pB.getByText("Confira o CPF ou CNPJ: os dígitos não batem.")).toBeVisible();
    await expect(pB.getByRole("button", { name: "Assinar", exact: true })).toBeDisabled();
    expect(duble.asaas.clienteDaOrg(orgB), "documento errado chegou ao provedor").toBeNull();
    await pB.screenshot({ path: `${EVIDENCIA}/checkout-asaas-documento.png`, fullPage: true });
    await documento.fill(CNPJ_COM_MASCARA);
    await pB.getByRole("button", { name: "Assinar", exact: true }).click();
    // A fatura do Asaas não devolve o cliente: o sistema fica nesta aba, e a fatura abre noutra, pelo clique.
    const abrirFatura = pB.getByRole("link", { name: "Abrir a fatura" });
    await expect(abrirFatura).toBeVisible();
    await expect(pB, "o Assinar do Asaas tirou o cliente do sistema").toHaveURL(/\/app\/settings\/billing/);
    await expect(pB.getByText(/volte aqui e clique em Já paguei/)).toBeVisible();
    const [fatura] = await Promise.all([ctxB.waitForEvent("page"), abrirFatura.click()]);
    await fatura.waitForURL((url) => url.origin === duble?.base && url.pathname.startsWith("/i/"));
    await expect(fatura.getByRole("heading", { name: "Fatura de teste do Asaas" })).toBeVisible();
    await fatura.screenshot({ path: `${EVIDENCIA}/fatura-do-asaas.png`, fullPage: true });
    const cliente = duble.asaas.clienteDaOrg(orgB) ?? "";
    expect(cliente).toMatch(/^cus_/);
    const enviado = duble.asaas.chamadas.find((c) => c.metodo === "POST" && c.caminho === "/v3/customers")?.corpo?.cpfCnpj;
    expect(enviado, "o CNPJ não chegou ao Asaas sem máscara").toBe(CNPJ);
    const primeira = duble.asaas.cobrancasDe(cliente)[0];
    expect(primeira?.dueDate, "o 1º vencimento não é o fim do teste grátis em São Paulo").toBe(hojeEmSaoPaulo(new Date(trialAte)));
    // LGPD (§2.3): o documento vai ao provedor e não fica no nosso banco.
    const linhaB = await db.from("cobranca_assinaturas").select("*").eq("organization_id", orgB).single();
    if (linhaB.error) throw linhaB.error;
    expect(JSON.stringify(linhaB.data), "o CPF/CNPJ foi gravado na assinatura").not.toContain(CNPJ);
    const auditoria = await db.from("api_audit_log").select("metadata").eq("organization_id", orgB);
    if (auditoria.error) throw auditoria.error;
    expect(JSON.stringify(auditoria.data), "o CPF/CNPJ foi para o audit").not.toContain(CNPJ);

    // ── 3. "Já paguei" sem pagar NÃO é assinar ──────────────────────────────
    // A aba original, sem navegar: é o caminho que o leigo tem (nenhum ?voltou=1 no Asaas).
    await pB.getByRole("button", { name: "Já paguei" }).click();
    await expect(pB.getByText(/1ª cobrança agendada/)).toBeVisible({ timeout: 60_000 });
    // A fase 3 gravou a assinatura que o Asaas já criou: sem ela, a troca de plano no teste não chegaria ao Asaas.
    await expect.poll(async () => assinaturaDe(orgB)).toMatchObject({
      estado: "trial", provedor: "asaas", modo: "teste", provedor_cliente_id: cliente, provedor_assinatura_id: expect.stringMatching(/^sub_/),
    });
    await pB.screenshot({ path: `${EVIDENCIA}/billing-asaas-aguardando.png`, fullPage: true });

    // ── 3b. Aviso mentiroso com o token certo (Review Focus 1) ──────────────
    const relidaAntes = await relidaEm(orgB);
    expect(await duble.asaas.enviarAvisoMentiroso(cliente), "o aviso com o token certo foi recusado").toBe(200);
    await drenarAte(request, "o aviso mentiroso acordou uma releitura", async () => (await relidaEm(orgB)) !== relidaAntes);
    expect(await assinaturaDe(orgB), "um corpo que jura 'pago' mudou o estado sem o provedor confirmar").toMatchObject({ estado: "trial" });

    // ── 4. Pix pago: o aviso com token acorda a leitura → "Em dia" ──────────
    expect(fatura.url(), "a aba da fatura não é a da 1ª cobrança").toContain(`/i/${primeira?.id}`);
    await fatura.getByRole("button", { name: "Pagar com Pix de teste" }).click();
    await expect(fatura.getByText("Pagamento confirmado")).toBeVisible();
    await drenarAte(request, "assinatura ativa pelo Pix", async () => (await assinaturaDe(orgB)).estado === "ativa");
    const ids = duble.asaas.avisos.map((a) => a.eventoId);
    expect(duble.asaas.avisos.every((a) => a.status === 200), JSON.stringify(duble.asaas.avisos)).toBe(true);
    const linhas = await db.from("webhook_events_log").select("organization_id, headers, raw_body, status, signature_header").eq("provider", "asaas").in("external_id", ids);
    if (linhas.error) throw linhas.error;
    expect(linhas.data).toHaveLength(ids.length);
    for (const l of linhas.data) {
      expect(l.organization_id).toBeNull();
      expect(l.headers).toBeNull();
      expect(l.signature_header).toBeNull();
      expect(Object.keys(JSON.parse(l.raw_body as string)).sort()).toEqual(["id", "type"]);
      expect(JSON.stringify(l).includes(token), "o token do webhook entrou no arquivo de avisos").toBe(false);
    }
    expect(linhas.data.some((l) => l.status === "processed"), "nenhum aviso do Asaas acordou a leitura").toBe(true);
    // O SUBSCRIPTION_CREATED chega DURANTE o POST /subscriptions: com o cliente gravado depois, ele viraria
    // cliente_desconhecido e a Visão geral acusaria "aviso sem empresa" a cada checkout.
    expect(linhas.data.filter((l) => l.status === "error"), "aviso válido do Asaas sem empresa (o cliente foi gravado tarde demais)").toEqual([]);
    expect(await duble.asaas.enviarAvisoForjado(cliente), "aviso com token errado foi aceito").toBe(401);
    await pB.goto("/app/settings/billing");
    await expect(pB.getByText("Em dia", { exact: true })).toBeVisible();
    await pB.screenshot({ path: `${EVIDENCIA}/billing-asaas-em-dia.png`, fullPage: true });

    // ── 5. Cancelar: acesso até o fim do período PAGO ───────────────────────
    const fimDoPago = duble.asaas.cobrancasDe(cliente).find((c) => c.status === "PENDING")?.dueDate ?? "";
    expect(fimDoPago, "o dublê não gerou a cobrança do mês seguinte").not.toBe("");
    await pB.getByRole("button", { name: "Cancelar assinatura" }).click();
    await pB.getByRole("button", { name: "Confirmar cancelamento" }).click();
    await expect(pB.getByText(`Você mantém o acesso até ${diaEMes(fimDoPago)}.`)).toBeVisible({ timeout: 30_000 });
    await drenarAte(request, "cancelada, com o período pago", async () => (await assinaturaDe(orgB)).estado === "cancelada");
    const linha = await db.from("cobranca_assinaturas").select("proximo_vencimento").eq("organization_id", orgB).single();
    if (linha.error) throw linha.error;
    expect(new Date(linha.data.proximo_vencimento as string).toISOString(), "fim do pago ≠ vencimento pago + 1 ciclo, 23:59:59 em São Paulo").toBe(fimDoDiaEmSaoPaulo(fimDoPago));
    expect(duble.asaas.chamadas.some((c) => c.metodo === "GET" && c.caminho === "/v3/subscriptions" && c.query.includeDeleted === "true"), "a releitura não pediu includeDeleted").toBe(true);
    await pB.goto("/app/settings/billing");
    await expect(pB.getByText(new RegExp(`Cancelada, acesso até ${diaEMes(fimDoPago)}`))).toBeVisible();
    expect(await pB.evaluate(() => document.body.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
    await pB.screenshot({ path: `${EVIDENCIA}/billing-asaas-cancelada.png`, fullPage: true });

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
