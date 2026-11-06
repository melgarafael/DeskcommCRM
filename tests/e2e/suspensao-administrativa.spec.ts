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
import { mkdirSync, writeFileSync } from "node:fs";
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

// Opções que criam worker próprio ficam na instância, não em um describe.
// O cenário usa sessões e links assinados reais, mantidos só em memória.
const testDoPacote = test.extend({ trace: "off", video: "off" });
testDoPacote.describe(
  "o pacote manual do titular sai do Storage pelo navegador",
  () => {
    testDoPacote(
      "dois downloads reais, isolamento, legado sem JSON e falha parcial",
      async ({ page, browser, request }, testInfo) => {
        testDoPacote.setTimeout(180_000);
        expect(["127.0.0.1", "localhost"]).toContain(
          new URL(credenciais.url).hostname,
        );
        const { iniciarFilhoDoPacote } = await import("./helpers/filho-do-pacote-lgpd");
        const { z } = await import("zod");
        const filhos: ReturnType<typeof iniciarFilhoDoPacote>[] = [];
        const fimDaPreparacao = Date.now() + 90_000;
        const pessoas: string[] = [],
          orgs: string[] = [],
          objetos: string[] = [];
        const contextos: BrowserContext[] = [];
        const bucket = db.storage.from("lgpd-exports");
        const stamp = randomUUID().slice(0, 8);
        const hash = (bytes: Buffer) =>
          createHash("sha256").update(bytes).digest("hex");
        let captura: Buffer | undefined;
        const provas: Record<string, unknown>[] = [];
        let falhou = false;

        const criar = async (letra: string, usuario: string) => {
          const org = await inserir("organizations", {
            slug: `pacote-${letra.toLowerCase()}-${stamp}`,
            legal_name: `Empresa sintética ${letra}`,
            display_name: `Pacote ${letra} ${stamp}`,
            onboarded_at: new Date().toISOString(),
            country: "BR",
            timezone: "America/Sao_Paulo",
          });
          orgs.push(org);
          const vinculo = await db.from("user_organizations").insert({
            organization_id: org,
            user_id: usuario,
            role: "admin",
            accepted_at: new Date().toISOString(),
          });
          expect(vinculo.error).toBeNull();
          const nome = `Titular sintético ${letra} ${stamp}`;
          const contato = await inserir("contacts", {
            organization_id: org,
            name: nome,
            display_name: nome,
            email: null,
          });
          const pedido = await inserir("lgpd_requests", {
            organization_id: org,
            request_type: "data_request",
            source: "manual",
            contact_id: contato,
            status: "received",
            due_at: "2030-01-31",
            request_payload: { customer: { name: nome } },
          });
          objetos.push(
            `${org}/${pedido}/report.pdf`,
            `${org}/${pedido}/data.json`,
          );
          // A aprovação é fixture explícita. Coleta, PDF, projeção, persistência e
          // Storage são os do worker; sem destinatário, nenhum transporte é usado.
          const prazoMs = Math.min(30_000, fimDaPreparacao - Date.now());
          const filho = iniciarFilhoDoPacote(
            [
              "--max-old-space-size=768",
              "--import",
              "tsx",
              "tests/e2e/helpers/gerar-pacote-lgpd-manual.ts",
              "--gerar-pacote-manual",
              JSON.stringify({ org, pedido, aprovador: usuario }),
            ],
            prazoMs,
          );
          filhos.push(filho);
          const stdout = await filho.resultado;
          const marcador = stdout.match(/^LGPD_MANUAL_PROOF=(.+)$/m);
          if (!marcador?.[1])
            throw new Error("A preparação não devolveu seu recibo técnico.");
          expect(JSON.parse(marcador[1])).toEqual({
            status: "ok",
            detail: "pending_review_no_email",
          });
          const gerado = await db
            .from("lgpd_requests")
            .select("status, result")
            .eq("organization_id", org)
            .eq("id", pedido)
            .single();
          expect(gerado.error).toBeNull();
          expect(gerado.data?.status).toBe("pending_review");
          const result = z
            .object({
              pdf_path: z.string(),
              json_path: z.string(),
              sha256: z.string().regex(/^[a-f0-9]{64}$/),
            })
            .passthrough()
            .parse(gerado.data?.result);
          expect(result.pdf_path).toBe(`${org}/${pedido}/report.pdf`);
          expect(result.json_path).toBe(`${org}/${pedido}/data.json`);
          return { org, pedido, nome, result };
        };
        const contexto = async (email: string) => {
          const ctx = await browser.newContext();
          contextos.push(ctx);
          const p = await ctx.newPage();
          await entrar(p, email);
          return p;
        };
        const bytesDaLigacao = async (url: string) => {
          try {
            return await request.get(url, { failOnStatusCode: false });
          } catch {
            throw new Error(
              "Não foi possível ler o objeto assinado do Storage local.",
            );
          }
        };
        const baixar = async (rotulo: string, esperado: Buffer, nome: string) => {
          const [download] = await Promise.all([
            page.waitForEvent("download", { timeout: 15_000 }),
            page.getByRole("link", { name: rotulo, exact: true }).click(),
          ]);
          expect(download.suggestedFilename()).toBe(nome);
          const fluxo = await download.createReadStream();
          if (!fluxo)
            throw new Error("O navegador não entregou os bytes do download.");
          const partes: Buffer[] = [];
          for await (const parte of fluxo) partes.push(Buffer.from(parte));
          const bytes = Buffer.concat(partes);
          expect(hash(bytes)).toBe(hash(esperado));
          expect(bytes.byteLength).toBe(esperado.byteLength);
        };

        try {
          const adminA = await criarPessoa(`pacote-admin-a-${stamp}`);
          pessoas.push(adminA.id);
          const adminB = await criarPessoa(`pacote-admin-b-${stamp}`);
          pessoas.push(adminB.id);
          const viewer = await criarPessoa(`pacote-viewer-${stamp}`);
          pessoas.push(viewer.id);
          const a = await criar("A", adminA.id),
            b = await criar("B", adminB.id);
          const vinculo = await db.from("user_organizations").insert({
            organization_id: a.org,
            user_id: viewer.id,
            role: "viewer",
            accepted_at: new Date().toISOString(),
          });
          expect(vinculo.error).toBeNull();
          const metadados = await db.storage.getBucket("lgpd-exports");
          expect(metadados.error).toBeNull();
          expect(metadados.data?.public).toBe(false);

          await entrar(page, adminA.email);
          const detalhe = `/api/v1/lgpd/requests/${a.pedido}`;
          const positivo = await page.request.get(detalhe);
          expect(positivo.status()).toBe(200);
          const data = (await positivo.json()).data;
          const pdfUrl = data.signed_pdf_url,
            jsonUrl = data.signed_json_url;
          if (typeof pdfUrl !== "string" || typeof jsonUrl !== "string")
            throw new Error("O pacote não trouxe as duas ligações.");
          if (pdfUrl === jsonUrl)
            throw new Error(
              "As ligações do pacote apontam para o mesmo arquivo.",
            );
          const pdf = await bytesDaLigacao(pdfUrl),
            json = await bytesDaLigacao(jsonUrl);
          expect(pdf.status()).toBe(200);
          expect(json.status()).toBe(200);
          expect(pdf.headers()["content-type"]).toContain("application/pdf");
          expect(json.headers()["content-type"]).toContain("application/json");
          const pdfBytes = await pdf.body(),
            jsonBytes = await json.body();
          expect(pdfBytes.subarray(0, 5).toString()).toBe("%PDF-");
          expect(hash(pdfBytes)).toBe(a.result.sha256);
          const arquivo = JSON.parse(jsonBytes.toString("utf8"));
          expect(arquivo.contact.name).toBe(a.nome);
          expect(arquivo.organization_id).toBe(a.org);
          expect(jsonBytes.toString("utf8")).not.toContain(b.nome);

          for (const [tipo, url, caminho, bytes] of [
            ["pdf", pdfUrl, a.result.pdf_path, pdfBytes],
            ["json", jsonUrl, a.result.json_path, jsonBytes],
          ] as const) {
            const nome = tipo === "pdf" ? "report.pdf" : "data.json";
            const resposta = tipo === "pdf" ? pdf : json;
            const disposicao = resposta.headers()["content-disposition"];
            expect(disposicao).toMatch(/^attachment(?:;|$)/i);
            expect(disposicao).toContain(nome);
            const uri = new URL(url),
              token = uri.searchParams.get("token");
            expect(uri.searchParams.get("download")).toBe(nome);
            const partes = token?.split(".");
            if (!partes || partes.length !== 3 || !partes[1] || !partes[2])
              throw new Error("A ligação não contém o JWT esperado.");
            const claims = JSON.parse(
              Buffer.from(partes[1], "base64url").toString("utf8"),
            );
            expect(claims.url).toBe(`lgpd-exports/${caminho}`);
            expect(claims.exp - claims.iat).toBe(72 * 60 * 60);
            const assinatura = partes[2];
            uri.searchParams.set(
              "token",
              `${partes[0]}.${partes[1]}.${assinatura.startsWith("a") ? "b" : "a"}${assinatura.slice(1)}`,
            );
            const adulterada = await bytesDaLigacao(uri.toString());
            expect(adulterada.status()).toBeGreaterThanOrEqual(400);
            expect(adulterada.status()).toBeLessThan(500);
            const publica = await request.get(
              `${credenciais.url}/storage/v1/object/public/lgpd-exports/${caminho}`,
            );
            expect(publica.status()).toBeGreaterThanOrEqual(400);
            expect(publica.status()).toBeLessThan(500);
            provas.push({
              tipo,
              bytes: bytes.byteLength,
              sha256: hash(bytes),
              jwt_validade_segundos: claims.exp - claims.iat,
              anexo: nome,
              jwt_adulterado: adulterada.status(),
              sem_assinatura: publica.status(),
            });
          }
          expect(
            (
              await page.request.get(`/api/v1/lgpd/requests/${b.pedido}`)
            ).status(),
          ).toBe(404);
          const pB = await contexto(adminB.email);
          expect(
            (
              await pB.request.get(`/api/v1/lgpd/requests/${b.pedido}`)
            ).status(),
          ).toBe(200);
          expect((await pB.request.get(detalhe)).status()).toBe(404);
          const pViewer = await contexto(viewer.email);
          expect((await pViewer.request.get(detalhe)).status()).toBe(403);
          const anonimo = await browser.newContext();
          contextos.push(anonimo);
          expect(
            (
              await anonimo.request.get(new URL(detalhe, page.url()).href)
            ).status(),
          ).toBe(401);

          await page.goto(`/app/lgpd/requests/${a.pedido}`);
          const cabecalho = page
            .getByRole("heading", {
              name: `#${a.pedido.slice(0, 8)}`,
              exact: true,
            })
            .locator("..");
          await expect(
            cabecalho.getByText("Revisão pendente", { exact: true }),
          ).toBeVisible();
          await expect(
            page.getByRole("link", { name: "Baixar PDF", exact: true }),
          ).toBeVisible();
          await expect(
            page.getByRole("link", {
              name: "Baixar arquivo de dados (data.json)",
              exact: true,
            }),
          ).toBeVisible();
          await baixar("Baixar PDF", pdfBytes, "report.pdf");
          await baixar("Baixar arquivo de dados (data.json)", jsonBytes, "data.json");
          captura = await page.screenshot({ fullPage: true });

          const atualizar = async (result: Record<string, unknown>) => {
            const r = await db
              .from("lgpd_requests")
              .update({ result })
              .eq("organization_id", a.org)
              .eq("id", a.pedido);
            expect(r.error).toBeNull();
          };
          // Registro inválido é fixture de contenção, não entrada disponível por HTTP.
          await atualizar({ ...a.result, json_path: b.result.json_path });
          const contido = await page.request.get(detalhe);
          expect(contido.status()).toBe(200);
          expect((await contido.json()).data.signed_json_url).toBeNull();
          const { json_path: _semJson, ...legado } = a.result;
          await atualizar(legado);
          await page.reload();
          await expect(
            page.getByRole("link", { name: "Baixar PDF", exact: true }),
          ).toBeVisible();
          await expect(
            page.getByRole("link", {
              name: "Baixar arquivo de dados (data.json)",
              exact: true,
            }),
          ).toHaveCount(0);
          await atualizar(a.result);
          expect((await bucket.remove([a.result.json_path])).error).toBeNull();
          await page.reload();
          await expect(
            page.getByRole("link", { name: "Baixar PDF", exact: true }),
          ).toBeVisible();
          await expect(
            page.getByRole("link", {
              name: "Baixar arquivo de dados (data.json)",
              exact: true,
            }),
          ).toHaveCount(0);
          await baixar("Baixar PDF", pdfBytes, "report.pdf");
        } catch (erro) {
          falhou = true;
          throw erro;
        } finally {
          // Junta os filhos próprios antes de iniciar a limpeza das fixtures.
          for (const filho of filhos) await filho.encerrar();
          const erros: string[] = [];
          for (const ctx of contextos)
            try {
              await ctx.close();
            } catch {
              erros.push("contexto");
            }
          const limpar = async (
            rotulo: string,
            tarefa: () => PromiseLike<{ error: unknown }>,
          ) => {
            try {
              if ((await tarefa()).error) erros.push(rotulo);
            } catch {
              erros.push(rotulo);
            }
          };
          if (objetos.length)
            await limpar("objetos próprios", () => bucket.remove(objetos));
          for (const id of orgs)
            await limpar("organização própria", () =>
              db.from("organizations").delete().eq("id", id),
            );
          for (const id of pessoas)
            await limpar("usuário próprio", () => db.auth.admin.deleteUser(id));
          if (erros.length) {
            if (falhou)
              testInfo.annotations.push({
                type: "cleanup",
                description: erros.join(", "),
              });
            else throw new Error("A limpeza da prova não foi concluída.");
          }
        }
        if (!captura)
          throw new Error("A prova não produziu captura após os downloads.");
        mkdirSync("evidence/lgpd-pacote-manual", { recursive: true });
        writeFileSync(
          "evidence/lgpd-pacote-manual/pacote-disponivel.png",
          captura,
        );
        writeFileSync(
          "evidence/lgpd-pacote-manual/recibo.json",
          JSON.stringify(
            {
              escopo:
                "worker, DB, Storage, JWT e downloads reais; aprovação é fixture; sem SMTP",
              isolamento_http: "PASS",
              viewer_http: 403,
              anonimo_http: 401,
              legado: "PASS",
              falha_parcial: "PASS",
              artefatos: provas,
            },
            null,
            2,
          ) + "\n",
        );
      },
    );
  },
);
