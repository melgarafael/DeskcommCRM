/**
 * E2E: a suspensão que suspende, pela tela (PR 1 da cobrança do revendedor).
 *
 * Spec: `docs/superpowers/specs/2026-09-29-cobranca-do-revendedor-design.md`,
 * §1.3, §4, §9 ("Suspenso") e §14 (PR 1). Sem chave de cobrança e sem plano:
 * é a suspensão ADMINISTRATIVA, que já existia e só tirava a pessoa da tela.
 *
 * Um caso só, porque cada passo depende do estado do anterior:
 *   1. quem só tem leitura clica em Suspender: 403 `forbidden_scope`, o erro na
 *      tela, e a empresa segue ativa;
 *   2. o dono suspende B pela tela. Job pendente e mensagem na fila viram `failed`,
 *      e o gate de elegibilidade (pelo PostgREST real) passa a negar;
 *   3. a admin de B cai no hub, abre um pedido de LGPD ali mesmo e vê a volta para C;
 *   4. `/app/inbox` volta para o hub, o token `dsk_` de B responde 403, e a volta
 *      para C, clicada, leva ao inbox de C;
 *   5. a captação por `webhooks/in/[token]` é GRAVADA, e nada responde:
 *      nenhuma `llm_calls`, nenhuma mensagem de saída;
 *   6. a atendente de B lê "Avise o administrador", sem LGPD, e "Sair" encerra a sessão;
 *   7. o dono reativa. Nada sai em rajada, e a Central mostra o item de revisão.
 *
 * Self-contida: orgs, pessoas, token, fonte e pedido de LGPD nascem pelo
 * service role com sufixo próprio e morrem no `finally`.
 *
 * NÃO prova a IA calada com um agente publicado de verdade: B não tem agente,
 * então "zero llm_calls" também valeria sem o conserto. Quem prova o veto é
 * `lib/ai/elegibilidade/gate.test.ts`, `tests/invariants/org-suspensa.test.ts`
 * e o controle do gate pelo PostgREST no passo 2.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

import { decidirElegibilidadeDaConversaViaSupabase } from "@/lib/ai/elegibilidade/consulta-supabase";

import { test, expect, type BrowserContext, type Page } from "./helpers/test";
import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";

const credenciais = credenciaisSupabaseDeTeste();
const db = createClient(credenciais.url, credenciais.serviceRole, { auth: { persistSession: false } });
const senha = `Local-${randomUUID()}!`;
const sufixo = randomUUID().slice(0, 8);
const EVIDENCIA = "evidence/suspensao-administrativa";

async function inserir(tabela: string, valor: Record<string, unknown>): Promise<string> {
  const { data, error } = await db.from(tabela).insert(valor).select("id").single();
  if (error) throw error;
  return data.id as string;
}

async function criarPessoa(rotulo: string): Promise<{ id: string; email: string }> {
  const email = `susp-${rotulo}-${sufixo}@invariant.test`;
  const { data, error } = await db.auth.admin.createUser({ email, password: senha, email_confirm: true });
  if (error || !data.user) throw error ?? new Error(`não criou ${rotulo}`);
  return { id: data.user.id, email };
}

async function entrar(page: Page, email: string): Promise<void> {
  await page.goto("/login");
  await page.getByLabel(/e-?mail/i).fill(email);
  await page.getByLabel(/senha/i).fill(senha);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 60_000 });
}

async function estadoDaOrg(id: string): Promise<{ status: string; suspended_kind: string | null }> {
  const { data, error } = await db.from("organizations").select("status, suspended_kind").eq("id", id).single();
  if (error) throw error;
  return data as { status: string; suspended_kind: string | null };
}

async function saidasDe(org: string): Promise<{ llm: number; outbound: number }> {
  const llm = await db.from("llm_calls").select("id", { count: "exact", head: true }).eq("organization_id", org);
  if (llm.error) throw llm.error;
  const outbound = await db
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", org)
    .eq("direction", "outbound")
    .neq("status", "failed");
  if (outbound.error) throw outbound.error;
  return { llm: llm.count ?? -1, outbound: outbound.count ?? -1 };
}

function segredoInterno(): string {
  const segredo = process.env.INTERNAL_CRON_SECRET || process.env.INTERNAL_SECRET;
  if (!segredo) throw new Error("sem INTERNAL_CRON_SECRET/INTERNAL_SECRET no ambiente do e2e");
  return segredo;
}

test("suspender cala B pela tela; o hub atende quem ficou; reativar não solta rajada", async ({
  page,
  browser,
  request,
}) => {
  test.setTimeout(300_000);
  page.setDefaultTimeout(20_000);
  mkdirSync(EVIDENCIA, { recursive: true });
  const pessoas: string[] = [];
  const orgs: string[] = [];
  const contextos: BrowserContext[] = [];
  let falhaDoCenario: unknown;

  try {
    // ── Fixtures ────────────────────────────────────────────────────────────
    const dono = await criarPessoa("dono");
    const leitura = await criarPessoa("leitura");
    const adminB = await criarPessoa("admin-b");
    const atendenteB = await criarPessoa("atendente-b");
    pessoas.push(dono.id, leitura.id, adminB.id, atendenteB.id);

    const agora = new Date().toISOString();
    const orgB = await inserir("organizations", {
      slug: `susp-b-${sufixo}`, display_name: `Suspensa B ${sufixo}`, legal_name: "Suspensa B", onboarded_at: agora,
    });
    const orgC = await inserir("organizations", {
      slug: `susp-c-${sufixo}`, display_name: `Ativa C ${sufixo}`, legal_name: "Ativa C", onboarded_at: agora,
    });
    orgs.push(orgB, orgC);

    const vinculos = await db.from("user_organizations").insert([
      { organization_id: orgB, user_id: adminB.id, role: "admin", accepted_at: new Date(Date.now() - 60_000).toISOString() },
      { organization_id: orgC, user_id: adminB.id, role: "admin", accepted_at: agora },
      { organization_id: orgB, user_id: atendenteB.id, role: "agent", accepted_at: agora },
      { organization_id: orgC, user_id: dono.id, role: "admin", accepted_at: agora },
      { organization_id: orgC, user_id: leitura.id, role: "viewer", accepted_at: agora },
    ]);
    if (vinculos.error) throw vinculos.error;
    const admins = await db.from("platform_admins").insert([
      { user_id: dono.id, granted_by: dono.id, scope: "full", mfa_required: false, reason: "E2E suspensão" },
      { user_id: leitura.id, granted_by: dono.id, scope: "support_readonly", mfa_required: false, reason: "E2E suspensão leitura" },
    ]);
    if (admins.error) throw admins.error;

    const canal = await inserir("channel_sessions", {
      organization_id: orgB, waha_session_name: `susp-${randomUUID()}`, display_name: "Canal B", status: "STOPPED", webhook_secret_encrypted: "\\x00",
    });
    const contato = await inserir("contacts", {
      organization_id: orgB, name: `Cliente B ${sufixo}`, display_name: `Cliente B ${sufixo}`,
    });
    const conversa = await inserir("conversations", {
      organization_id: orgB, contact_id: contato, channel_session_id: canal, status: "open",
    });
    const funil = await inserir("crm_pipelines", { organization_id: orgB, name: "Funil B", slug: `susp-${sufixo}` });
    const etapa = await inserir("crm_stages", { organization_id: orgB, pipeline_id: funil, name: "Entrada", slug: "entrada", position: 1 });
    const pathToken = `susp_${randomBytes(16).toString("hex")}`;
    await inserir("webhook_sources", {
      organization_id: orgB, name: `Captação B ${sufixo}`, path_token: pathToken, default_pipeline_id: funil, default_stage_id: etapa,
    });
    const pedidoLgpd = await inserir("lgpd_requests", {
      organization_id: orgB, request_type: "data_request", source: "manual", contact_id: contato,
      due_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    });
    // O acúmulo que a suspensão precisa fechar: um turno agendado e uma resposta na fila.
    const jobPendente = await inserir("job_queue", {
      organization_id: orgB, contact_id: contato, kind: "inbound_turn", run_after: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const msgNaFila = await inserir("messages", {
      organization_id: orgB, conversation_id: conversa, channel_session_id: canal, contact_id: contato,
      direction: "outbound", type: "text", body: "Não deve sair", status: "queued",
    });
    const tokenPlano = `dsk_${randomBytes(4).toString("hex")}_${randomBytes(32).toString("base64url")}`;
    await inserir("api_tokens", {
      organization_id: orgB, created_by: adminB.id, name: `Token B ${sufixo}`, prefix: tokenPlano.slice(0, 12),
      token_hash: `\\x${createHash("sha256").update(tokenPlano).digest("hex")}`, scopes: ["mcp:read", "role:admin"],
    });
    const comToken = { headers: { authorization: `Bearer ${tokenPlano}` } };
    const gateDeB = () =>
      decidirElegibilidadeDaConversaViaSupabase(db, {
        organizationId: orgB, conversationId: conversa, agora: new Date(), ttlMs: 86_400_000,
      });

    // Controles positivos contra o PostgREST REAL (Review Focus 4): com B ativa,
    // o token funciona e o gate não nega por org. Sem isto, o 403 e o veto lá
    // embaixo não mediriam nada — um embed errado daria os dois sozinho.
    const antes = await request.get("/api/v1/contacts", comToken);
    expect(antes.status(), await antes.text()).toBe(200);
    expect((await gateDeB())?.motivo).not.toBe("org_nao_operante");

    // ── 1. Quem só tem leitura tenta suspender ─────────────────────────────
    const ctxLeitura = await browser.newContext();
    contextos.push(ctxLeitura);
    const pLeitura = await ctxLeitura.newPage();
    await entrar(pLeitura, leitura.email);
    await pLeitura.goto(`/admin/tenants/${orgB}`);
    await pLeitura.getByRole("button", { name: "Suspender tenant" }).click();
    await pLeitura.locator("#suspend-reason").fill("Tentativa de quem só tem leitura");
    // O toast é o mesmo para qualquer falha; a resposta diz que foi o scope.
    const [recusa] = await Promise.all([
      pLeitura.waitForResponse((r) => r.url().endsWith(`/api/v1/admin/tenants/${orgB}/suspend`) && r.request().method() === "POST"),
      pLeitura.getByRole("button", { name: "Confirmar suspensão" }).click(),
    ]);
    expect(recusa.status()).toBe(403);
    expect(((await recusa.json()) as { error: { code: string } }).error.code).toBe("forbidden_scope");
    await expect(pLeitura.getByText("Erro ao suspender tenant")).toBeVisible();
    expect((await estadoDaOrg(orgB)).status).toBe("active");
    await pLeitura.screenshot({ path: `${EVIDENCIA}/leitura-recusada.png` });

    // ── 2. O dono suspende B pela tela ─────────────────────────────────────
    await entrar(page, dono.email);
    await page.goto(`/admin/tenants/${orgB}`);
    await page.getByRole("button", { name: "Suspender tenant" }).click();
    await page.locator("#suspend-reason").fill("Suspensão administrativa de teste E2E");
    await page.getByRole("button", { name: "Confirmar suspensão" }).click();
    await expect.poll(async () => (await estadoDaOrg(orgB)).status).toBe("suspended");
    expect((await estadoDaOrg(orgB)).suspended_kind).toBe("administrativa");
    const job = await db.from("job_queue").select("status, last_error").eq("id", jobPendente).single();
    expect(job.data).toEqual({ status: "failed", last_error: "org_nao_operante" });
    const msg = await db.from("messages").select("status, error_code").eq("id", msgNaFila).single();
    expect(msg.data).toEqual({ status: "failed", error_code: "org_suspensa" });
    expect((await gateDeB())?.motivo).toBe("org_nao_operante");

    // ── 3. A admin de B, que estava trabalhando em B, cai no hub ───────────
    const ctxAdminB = await browser.newContext();
    contextos.push(ctxAdminB);
    await ctxAdminB.addCookies([{ name: "active_org", value: orgB, url: test.info().project.use.baseURL! }]);
    const pAdminB = await ctxAdminB.newPage();
    pAdminB.setDefaultTimeout(20_000);
    await entrar(pAdminB, adminB.email);
    await pAdminB.waitForURL("**/account-suspended");
    await expect(pAdminB.getByRole("heading", { name: "Conta suspensa" })).toBeVisible();
    await expect(pAdminB.getByRole("heading", { name: "Solicitações LGPD" })).toBeVisible();
    await expect(pAdminB.getByTestId("sair-do-onboarding")).toContainText(`Ativa C ${sufixo}`);
    // Medida, não olho: o hub cabe na largura, sem rolagem horizontal.
    expect(await pAdminB.evaluate(() => document.body.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
    // A tabela carrega no cliente: sem esperar o pedido, a foto sai com o esqueleto.
    await expect(pAdminB.getByRole("link", { name: "Ver" })).toBeVisible();
    await pAdminB.screenshot({ path: `${EVIDENCIA}/hub-admin.png`, fullPage: true });
    // A LGPD não para: o pedido abre no próprio hub.
    await pAdminB.getByRole("link", { name: "Ver" }).click();
    await pAdminB.waitForURL(new RegExp(`/account-suspended\\?pedido=${pedidoLgpd}$`));
    await expect(pAdminB.getByText(`#${pedidoLgpd.slice(0, 8)}`)).toBeVisible();
    await expect(pAdminB.getByRole("link", { name: "Solicitações", exact: true })).toHaveAttribute("href", "/account-suspended");
    await pAdminB.screenshot({ path: `${EVIDENCIA}/hub-pedido-lgpd.png`, fullPage: true });

    // ── 4. /app/inbox volta para o hub; o token de B é recusado ────────────
    await pAdminB.goto("/app/inbox");
    await pAdminB.waitForURL("**/account-suspended");
    const depois = await request.get("/api/v1/contacts", comToken);
    expect(depois.status(), await depois.text()).toBe(403);
    expect(((await depois.json()) as { error: { code: string } }).error.code).toBe("org_suspended");
    // A volta para C funciona, não só aparece: o clique leva ao inbox de C.
    await pAdminB.getByTestId("sair-do-onboarding").click();
    await pAdminB.waitForURL("**/app/inbox");
    expect((await ctxAdminB.cookies()).find((c) => c.name === "active_org")?.value).toBe(orgC);

    // ── 5. A entrada continua gravando; nada responde ──────────────────────
    const captura = await request.post(`/api/v1/webhooks/in/${pathToken}`, {
      data: { nome: `Lead na suspensão ${sufixo}`, telefone: "11955550000" },
    });
    expect(captura.status(), await captura.text()).toBe(200);
    const leadId = ((await captura.json()) as { data: { lead_id: string } }).data.lead_id;
    const lead = await db.from("crm_leads").select("organization_id").eq("id", leadId).single();
    expect(lead.data?.organization_id).toBe(orgB);
    // A mensagem de WhatsApp que chega enquanto B está suspensa, pelo mesmo
    // marcador que a ingestão grava (`fn_mark_conversation_message`). É ela que
    // a reativação conta para o item de revisão.
    const marca = await db.rpc("fn_mark_conversation_message", {
      p_conv: conversa, p_direction: "inbound", p_preview: "Oi, tem alguém aí?", p_at: new Date().toISOString(),
    });
    if (marca.error) throw marca.error;
    const dreno = await request.post("/api/v1/cron/event-log-drain", { headers: { authorization: `Bearer ${segredoInterno()}` } });
    expect(dreno.status(), await dreno.text()).toBe(200);
    expect(await saidasDe(orgB)).toEqual({ llm: 0, outbound: 0 });

    // ── 6. A atendente lê "Avise o administrador", sem LGPD ────────────────
    const ctxAtendente = await browser.newContext();
    contextos.push(ctxAtendente);
    const pAtendente = await ctxAtendente.newPage();
    await entrar(pAtendente, atendenteB.email);
    await pAtendente.waitForURL("**/account-suspended");
    await expect(pAtendente.getByText("Sua conta está suspensa. Avise o administrador da sua empresa.")).toBeVisible();
    await expect(pAtendente.getByRole("heading", { name: "Solicitações LGPD" })).toHaveCount(0);
    await pAtendente.screenshot({ path: `${EVIDENCIA}/hub-atendente.png`, fullPage: true });
    // 'Sair' encerra a sessão: sem ela, /app não tem para onde mandar além do login.
    await pAtendente.getByRole("button", { name: "Sair" }).click();
    await pAtendente.waitForURL(/\/login/);
    await pAtendente.goto("/app");
    await expect(pAtendente).toHaveURL(/\/login/);

    // ── 7. O dono reativa: nada em rajada, e a Central pede revisão ────────
    await page.goto(`/admin/tenants/${orgB}`);
    await page.getByRole("button", { name: "Reativar tenant" }).click();
    await page.locator("#reactivate-reason").fill("Reativação administrativa de teste E2E");
    await page.getByRole("button", { name: "Confirmar reativação" }).click();
    await expect.poll(async () => (await estadoDaOrg(orgB)).status).toBe("active");
    expect((await db.from("job_queue").select("status").eq("id", jobPendente).single()).data?.status).toBe("failed");
    expect((await db.from("messages").select("status").eq("id", msgNaFila).single()).data?.status).toBe("failed");
    expect(await saidasDe(orgB)).toEqual({ llm: 0, outbound: 0 });
    const itens = await db
      .from("agent_inbox_items")
      .select("severity, ref_kind, ref_id")
      .eq("organization_id", orgB)
      .eq("kind", "org_reativada");
    if (itens.error) throw itens.error;
    expect(itens.data).toEqual([{ severity: "warn", ref_kind: null, ref_id: null }]);

    // A admin tinha voltado para C no passo 4; volta a trabalhar em B.
    await ctxAdminB.addCookies([{ name: "active_org", value: orgB, url: test.info().project.use.baseURL! }]);
    await pAdminB.goto("/app/inbox");
    await expect(pAdminB).toHaveURL(/\/app\/inbox/);
    await pAdminB.goto("/app/ai/inbox");
    const item = pAdminB.getByTestId("inbox-item").filter({ hasText: "enquanto a conta estava suspensa" });
    await expect(item).toHaveCount(1);
    await expect(item.getByRole("link", { name: "Abrir o Inbox" })).toHaveAttribute("href", "/app/inbox");
    await pAdminB.screenshot({ path: `${EVIDENCIA}/central-apos-reativar.png`, fullPage: true });
  } catch (erro) {
    falhaDoCenario = erro;
    throw erro;
  } finally {
    try {
      const fechamentos = await Promise.allSettled(contextos.map((c) => c.close()));
      const falhas = fechamentos.filter((r) => r.status === "rejected");
      if (falhas.length) throw new AggregateError(falhas.map((r) => r.reason), "falha ao fechar contextos");
      for (const org of orgs) {
        const r = await db.from("organizations").delete().eq("id", org);
        if (r.error) throw r.error;
      }
      const pa = await db.from("platform_admins").delete().in("user_id", pessoas);
      if (pa.error) throw pa.error;
      for (const id of pessoas) {
        const r = await db.auth.admin.deleteUser(id);
        if (r.error) throw r.error;
      }
    } catch (erroDaLimpeza) {
      // Não troca a causa original por erro de teardown.
      test.info().annotations.push({ type: "cleanup", description: `limpeza incompleta: orgs ${orgs.join(",")}` });
      if (!falhaDoCenario) throw erroDaLimpeza;
    }
  }
});
