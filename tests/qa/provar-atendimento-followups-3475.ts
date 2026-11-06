/**
 * Aceite dirigido do lote #3475 contra uma bancada já compilada e semeada.
 * Não inicia app/banco, não lê .env e não semeia atores ou eventos de passo.
 * Fontes: followup-dossie.spec.ts, encerramento-atendimento.spec.ts,
 * e2e-followup-journey-helpers.ts e hooks/notifications/useInboundMessageAlerts.ts.
 * O contrato de fixtures e os limites estão no .md ao lado.
 */
import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";

import { chromium, expect, request, type APIRequestContext, type Browser, type BrowserContext, type Page } from "@playwright/test";
import pg from "pg";
import { z } from "zod";

import { esperarARevelacao } from "../e2e/helpers/test";
import { ehServicoDePushConhecido } from "../../lib/notifications/servicos-de-push";

const NOMES = ["dossie", "inbox", "pausa", "assinatura", "avisos", "ack"] as const;
type Nome = (typeof NOMES)[number];
const uuid = z.uuid();
const ator = z.object({ id: uuid, email: z.email().regex(/\.(test|invalid)$/), password_env: z.string().regex(/^[A-Z][A-Z0-9_]+$/) });
const acompanhamento = z.object({ id: uuid, contact_id: uuid, contact_name: z.string().min(1), conversation_id: uuid });
const manifestoSchema = z.object({
  schema: z.literal(1),
  synthetic: z.literal(true),
  environment_id: z.string().min(8),
  build: z.object({ sha: z.string().regex(/^[0-9a-f]{40}$/), id: z.string().min(5) }),
  organization: z.object({ id: uuid, slug: z.string().regex(/^qa-3475-[a-z0-9-]+$/) }),
  users: z.object({ admin: ator.optional(), manager: ator, viewer: ator, other_tenant: ator.extend({ organization_id: uuid }) }),
  enrollments: z.object({ dossie_dormente: acompanhamento, dossie_coletando: acompanhamento, inbox_dormente: acompanhamento }),
  human: z.object({ conversation_id: uuid, pure_conversation_id: uuid, user_id: uuid, token_env: z.string().min(1), no_scope_token_env: z.string().min(1) }),
  signatures: z.object({
    agent_id: uuid,
    agent_name: z.string().min(1),
    llm_mode: z.enum(["byok", "platform"]),
    automation: z.object({ rule_id: uuid, conversation_id: uuid, event_type: z.string().min(1), entity_type: z.string().min(1), entity_id: uuid, payload: z.record(z.string(), z.unknown()) }),
    prospecting: z.object({ campaign_id: uuid, candidate_id: uuid, config: z.record(z.string(), z.unknown()) }),
  }),
  notices: z.object({
    agent_id: uuid,
    version_id: uuid,
    keyword_regex: z.string().min(1),
    cases: z.array(z.object({
      name: z.enum(["recusada", "aceita", "midia_sem_texto", "ja_engajado"]),
      conversation_id: uuid,
      contact_id: uuid,
      channel_session_id: uuid,
      body: z.string().nullable(),
      type: z.enum(["text", "audio"]),
      expected_notice: z.boolean(),
    })).length(4),
    push_transport: z.object({ subscription_id: uuid, receipts_url: z.url(), token_env: z.string().min(1) }).nullable(),
  }),
  ack: z.object({
    conversation_id: uuid,
    channel_session_id: uuid,
    session_name: z.string().min(1),
    webhook_token_env: z.string().min(1),
    hmac_secret_env: z.string().min(1),
    other_tenant_message_id: uuid,
  }),
});
type Manifesto = z.infer<typeof manifestoSchema>;
type Acompanhamento = z.infer<typeof acompanhamento>;
type Ator = z.infer<typeof ator>;
interface Recebido { id: string; text: string; session: string | null }
interface ReciboPush { id: string; conversation_id: string; user_id: string }
interface Resultado { scenario: Nome; state: "passed" | "failed" | "not_run"; checks: string[]; error?: string }
interface LinhaAck extends pg.QueryResultRow { id: string; external_id: string; status: string; ack: number | null; delivered_at: string | null; read_at: string | null; error_code: string | null }

const AJUDA = `Uso: pnpm exec tsx tests/qa/provar-atendimento-followups-3475.ts --manifest <json> [--only ${NOMES.join(",")}] [--evidence <pasta>]

Lê apenas process.env e o manifesto explícito. --help não abre arquivo, conexão ou browser.
Requer bancada sintética existente, app de produção já compilado, PG e receiver exclusivos.
A pausa humana é medida por cinco minutos reais; não altera o relógio nem o carimbo salvo.
Sem LLM/transporte de envio real, o cenário correspondente falha.
Push entregue e a tool de bolha invisível são subprovas separadas; RC 0 pode ser parcial.
Consulte complete, core_complete e subproofs em relatorio.json antes de declarar aceite.
Veja tests/qa/provar-atendimento-followups-3475.md para o contrato completo.
`;

function ambiente(nome: string): string {
  const valor = process.env[nome]?.trim();
  if (!valor) throw new Error(`precondition:env:${nome}`);
  return valor;
}

function conferirDestino(valor: string, nome: string): URL {
  const url = new URL(valor);
  assert(["http:", "https:", "postgres:", "postgresql:"].includes(url.protocol), `precondition:protocol:${nome}`);
  if (url.protocol === "http:" || url.protocol === "https:") assert(!url.search && !url.hash, `precondition:query_or_fragment:${nome}`);
  return url;
}

function argumentos() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) return null;
  const opcoes = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const chave = args[i]!;
    const valor = args[i + 1];
    assert(["--manifest", "--only", "--evidence"].includes(chave) && valor && !valor.startsWith("--"), "argumento inválido; use --help");
    assert(!opcoes.has(chave), "argumento repetido");
    opcoes.set(chave, valor);
  }
  assert(opcoes.has("--manifest"), "--manifest é obrigatório");
  const nomes = opcoes.get("--only")?.split(",") ?? [...NOMES];
  assert(nomes.length > 0 && new Set(nomes).size === nomes.length && nomes.every((n) => NOMES.includes(n as Nome)), "--only inválido");
  const pasta = path.resolve(opcoes.get("--evidence") ?? `evidence/atendimento-followups-3475/${Date.now()}`);
  assert(pasta.startsWith(path.resolve("evidence") + path.sep), "evidence precisa ficar sob evidence/");
  return { manifesto: opcoes.get("--manifest")!, nomes: nomes as Nome[], pasta };
}

class Prova {
  readonly resultados: Resultado[] = NOMES.map((scenario) => ({ scenario, state: "not_run", checks: [] }));
  readonly subprovas = {
    pushTransport: { state: "not_run" as "not_run" | "passed", reason: "Envelope criptográfico não recebido; UI/decisão/job são medidos separadamente." },
    invisibleAgentTool: { state: "not_run" as "not_run" | "passed", reason: "A guarda requer observar um inbound_turn real chamando send_message com Cf e recebendo corpo_vazio; API comum e ausência no sandbox não provam isso." },
  };
  readonly recebidos: Recebido[] = [];
  readonly contextos: BrowserContext[] = [];
  readonly paginas: Page[] = [];
  private receiver: Server | undefined;
  private browser: Browser | undefined;
  private api: APIRequestContext | undefined;
  private atual: Resultado | undefined;
  readonly pool: pg.Pool;
  readonly base: URL;
  readonly inicio = new Date().toISOString();

  constructor(readonly fixture: Manifesto, readonly nomes: Nome[], readonly pasta: string) {
    this.base = conferirDestino(ambiente("QA_3475_BASE_URL"), "app");
    const banco = conferirDestino(ambiente("SUPABASE_DB_URL"), "postgres");
    assert(this.base.protocol === "http:" || this.base.protocol === "https:", "precondition:app_protocol");
    assert(banco.protocol === "postgres:" || banco.protocol === "postgresql:", "precondition:db_protocol");
    assert.equal(ambiente("QA_3475_DESTINO_ID"), fixture.environment_id, "precondition:environment_id");
    assert.equal(ambiente("QA_3475_BUILD_SHA"), fixture.build.sha, "precondition:build_sha");
    assert.equal(ambiente("QA_3475_BUILD_ID"), fixture.build.id, "precondition:build_id");
    ambiente("QA_3475_CRON_SECRET");
    this.pool = new pg.Pool({ connectionString: banco.toString(), max: 1, connectionTimeoutMillis: 10_000, statement_timeout: 15_000 });
  }

  check(descricao: string): void { this.atual?.checks.push(descricao); }

  async query<T extends pg.QueryResultRow>(sql: string, values: unknown[] = []): Promise<T[]> {
    return (await this.pool.query<T>(sql, values)).rows;
  }

  /** Só SELECT antes de mkdir, receiver, browser ou qualquer mutação. */
  async preflight(): Promise<void> {
    const f = this.fixture;
    const org = await this.query<{ slug: string; settings: Record<string, unknown>; status: string }>("select slug,settings,status from organizations where id=$1", [f.organization.id]);
    assert.equal(org[0]?.slug, f.organization.slug, "precondition:synthetic_org");
    assert.equal(org[0]?.status, "active", "precondition:org_operante");
    const atores: Array<[string, Ator | undefined]> = this.nomes.includes("dossie") ? Object.entries(f.users).filter(([, user]) => user !== undefined) : [["manager", f.users.manager]];
    if (this.nomes.includes("assinatura")) {
      assert(f.users.admin, "precondition:admin_fixture_required_for_prospecting");
      if (!atores.some(([papel]) => papel === "admin")) atores.push(["admin", f.users.admin]);
    }
    for (const [papel, user] of atores) {
      assert(user, "precondition:actor_required");
      ambiente(user.password_env);
      const orgId = papel === "other_tenant" ? f.users.other_tenant.organization_id : f.organization.id;
      const membros = await this.query<{ role: string }>("select role from user_organizations where organization_id=$1 and user_id=$2 and revoked_at is null", [orgId, user.id]);
      assert.equal(membros.length, 1, `precondition:membership:${papel}`);
      if (papel === "manager") assert(["manager", "admin"].includes(membros[0]!.role), "precondition:manager_role");
      if (papel === "admin") assert.equal(membros[0]!.role, "admin", "precondition:admin_role");
      if (papel === "viewer") assert.equal(membros[0]!.role, "viewer", "precondition:viewer_role");
    }
    if (this.nomes.includes("dossie")) assert.notEqual(f.users.other_tenant.organization_id, f.organization.id, "precondition:two_tenants");
    const esperados: Array<[Acompanhamento, string]> = [];
    if (this.nomes.includes("dossie")) esperados.push([f.enrollments.dossie_dormente, "dormente"], [f.enrollments.dossie_coletando, "coletando"]);
    if (this.nomes.includes("inbox")) esperados.push([f.enrollments.inbox_dormente, "dormente"]);
    for (const [e, status] of esperados) {
      const linhas = await this.query<{ status: string; name: string; contact_id: string }>("select e.status,e.contact_id,coalesce(c.display_name,c.name) as name from followup_enrollments e join contacts c on c.organization_id=e.organization_id and c.id=e.contact_id where e.organization_id=$1 and e.id=$2", [f.organization.id, e.id]);
      assert.equal(linhas[0]?.status, status, `precondition:enrollment:${status}`);
      assert.equal(linhas[0]?.contact_id, e.contact_id, "precondition:contact_id");
      assert.equal(linhas[0]?.name, e.contact_name, "precondition:synthetic_contact_name");
    }
    const conversas = esperados.map(([e]) => e.conversation_id);
    if (this.nomes.includes("pausa")) conversas.push(f.human.conversation_id, f.human.pure_conversation_id);
    if (this.nomes.includes("assinatura")) conversas.push(f.signatures.automation.conversation_id);
    if (this.nomes.includes("avisos")) conversas.push(...f.notices.cases.map((c) => c.conversation_id));
    if (this.nomes.includes("ack")) conversas.push(f.ack.conversation_id);
    for (const id of new Set(conversas)) {
      const r = await this.query("select id from conversations where organization_id=$1 and id=$2", [f.organization.id, id]);
      assert.equal(r.length, 1, "precondition:conversation_tenant");
    }
    if (this.nomes.includes("pausa")) {
      for (const env of [f.human.token_env, f.human.no_scope_token_env]) {
        const token = ambiente(env);
        assert(token.startsWith("dsk_"), "precondition:synthetic_bearer_format");
        const hash = createHash("sha256").update(token).digest();
        const rows = await this.query<{ scopes: string[] }>("select scopes from api_tokens where organization_id=$1 and token_hash=$2 and revoked_at is null and (expires_at is null or expires_at>now())", [f.organization.id, hash]);
        assert.equal(rows.length, 1, "precondition:token_current_tenant");
        assert.equal(rows[0]!.scopes.includes("messages:on_behalf"), env === f.human.token_env, "precondition:on_behalf_scope");
      }
      const sil = await this.query<{ bot_silenced_until: string | null }>("select bot_silenced_until::text from conversations where organization_id=$1 and id=any($2::uuid[])", [f.organization.id, [f.human.conversation_id, f.human.pure_conversation_id]]);
      assert(sil.every((r) => r.bot_silenced_until === null), "precondition:human_conversations_not_silenced");
    }
    if (this.nomes.includes("assinatura")) {
      const settings = org[0]!.settings.assinatura_mensagens as Record<string, unknown> | undefined;
      assert(settings?.ia === true && settings.por_agente === true, "precondition:signature_enabled");
      assert.notEqual(settings.nome_ia, f.signatures.agent_name, "precondition:signature_fallback_distinct");
      const agentes = await this.query<{ name: string; credential_id: string | null; validated_at: Date | null; is_active: boolean | null }>("select a.name,v.credential_id,c.validated_at,c.is_active from ai_agents a join ai_agent_versions v on v.organization_id=a.organization_id and v.id=a.published_version_id left join ai_provider_credentials c on c.organization_id=a.organization_id and c.id=v.credential_id where a.organization_id=$1 and a.id=$2 and a.paused_at is null and v.status='published'", [f.organization.id, f.signatures.agent_id]);
      assert.equal(agentes[0]?.name, f.signatures.agent_name, "precondition:published_signature_agent");
      if (f.signatures.llm_mode === "byok") assert(agentes[0]?.credential_id && agentes[0].is_active && agentes[0].validated_at, "precondition:real_validated_llm_credential_required");
      else assert.equal(ambiente("QA_3475_APP_PLATFORM_LLM_READY_FOR_SHA"), f.build.sha, "precondition:app_platform_llm_attestation");
      const regras = await this.query<{ actions: Array<{ type: string; config?: Record<string, unknown> }>; trigger_event: string }>("select actions,trigger_event from automation_rules where organization_id=$1 and id=$2 and is_active=true", [f.organization.id, f.signatures.automation.rule_id]);
      assert.equal(regras[0]?.trigger_event, f.signatures.automation.event_type, "precondition:real_automation_trigger");
      assert(regras[0]!.actions.some((a) => a.type === "send_ai_message" && a.config?.agent_id === f.signatures.agent_id), "precondition:real_send_ai_message_action");
      const candidatos = await this.query("select p.id from prospecting_candidates p join prospecting_campaigns c on c.organization_id=p.organization_id and c.id=p.campaign_id where p.organization_id=$1 and p.id=$2 and p.campaign_id=$3 and p.selected=true and p.status='new' and not exists (select 1 from messages m where m.organization_id=p.organization_id and m.id=p.message_id)", [f.organization.id, f.signatures.prospecting.candidate_id, f.signatures.prospecting.campaign_id]);
      assert.equal(candidatos.length, 1, "precondition:unsent_prospecting_candidate");
    }
    if (this.nomes.includes("avisos")) {
      const n = f.notices;
      assert.equal(new Set(n.cases.map((c) => c.name)).size, 4, "precondition:four_distinct_notice_cases");
      assert.equal(new Set(n.cases.map((c) => c.conversation_id)).size, 4, "precondition:four_distinct_notice_conversations");
      assert.equal(new Set(n.cases.map((c) => c.contact_id)).size, 4, "precondition:four_distinct_notice_contacts");
      assert.deepEqual(Object.fromEntries(n.cases.map((c) => [c.name, c.expected_notice])), { recusada: true, aceita: false, midia_sem_texto: true, ja_engajado: false }, "precondition:notice_expectations");
      const v = await this.query<{ trigger_config: { filters?: { keyword_regex?: string } } }>("select trigger_config from ai_agent_versions where organization_id=$1 and id=$2 and agent_id=$3 and status='published'", [f.organization.id, n.version_id, n.agent_id]);
      assert.equal(v[0]?.trigger_config.filters?.keyword_regex, n.keyword_regex, "precondition:real_keyword_filter");
      if (n.push_transport) {
        const sub = await this.query<{ endpoint: string }>("select endpoint from push_subscriptions where organization_id=$1 and id=$2 and user_id=$3", [f.organization.id, n.push_transport.subscription_id, f.users.manager.id]);
        assert.equal(sub.length, 1, "precondition:real_push_subscription");
        assert(ehServicoDePushConhecido(sub[0]!.endpoint), "precondition:push_endpoint_not_admitted_by_product_guard");
        conferirDestino(n.push_transport.receipts_url, "push_receipts");
        ambiente(n.push_transport.token_env);
        await this.recibosPush();
      }
    }
    if (this.nomes.includes("ack")) {
      const a = f.ack;
      const token = ambiente(a.webhook_token_env);
      assert(token.length >= 8, "precondition:waha_path_token");
      assert(ambiente(a.hmac_secret_env).length >= 16, "precondition:waha_hmac_secret_minimum");
      const sessao = await this.query<{ waha_session_name: string }>("select waha_session_name from channel_sessions where organization_id=$1 and id=$2 and webhook_path_token=$3 and archived_at is null", [f.organization.id, a.channel_session_id, token]);
      assert.equal(sessao[0]?.waha_session_name, a.session_name, "precondition:waha_session_token_matches_tenant");
      const conversa = await this.query<{ channel_session_id: string }>("select channel_session_id from conversations where organization_id=$1 and id=$2", [f.organization.id, a.conversation_id]);
      assert.equal(conversa[0]?.channel_session_id, a.channel_session_id, "precondition:ack_conversation_channel");
      const outra = await this.query<{ external_id: string; slug: string; status: string }>("select m.external_id,o.slug,m.status from messages m join organizations o on o.id=m.organization_id where m.organization_id=$1 and m.id=$2 and m.direction='outbound'", [f.users.other_tenant.organization_id, a.other_tenant_message_id]);
      assert(outra[0]?.external_id && outra[0].slug.startsWith("qa-3475-") && outra[0].status === "sent", "precondition:synthetic_other_tenant_sent_message");
    }
    if (this.nomes.some((n) => n === "pausa" || n === "assinatura" || n === "ack")) {
      const receiver = conferirDestino(ambiente("WAHA_API_BASE_URL"), "receiver");
      assert(["127.0.0.1", "localhost", "[::1]"].includes(receiver.hostname), "precondition:exclusive_loopback_receiver");
      assert(receiver.port, "precondition:receiver_port_required");
    }
  }

  async abrirRecursos(): Promise<void> {
    await mkdir(this.pasta, { recursive: true });
    this.api = await request.newContext({ baseURL: this.base.toString(), timeout: 320_000 });
    this.browser = await chromium.launch({ headless: true });
    if (!this.nomes.some((n) => n === "pausa" || n === "assinatura" || n === "ack")) return;
    const url = new URL(ambiente("WAHA_API_BASE_URL"));
    this.receiver = createServer(async (req, res) => {
      const reply = (status: number, body: object) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
      if (req.method !== "POST" || new URL(req.url ?? "/", url).pathname !== "/api/sendText") return reply(404, { error: "unexpected_receiver_operation" });
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const parsed = z.object({ text: z.string(), session: z.string().optional() }).parse(body);
        const id = `qa-3475-${randomUUID()}`;
        this.recebidos.push({ id, text: parsed.text, session: parsed.session ?? null });
        return reply(200, { id });
      } catch { return reply(400, { error: "invalid_synthetic_receiver_request" }); }
    });
    await new Promise<void>((resolve, reject) => { this.receiver!.once("error", reject); this.receiver!.listen(Number(url.port), url.hostname === "[::1]" ? "::1" : url.hostname, resolve); });
  }

  async pagina(user: Ator = this.fixture.users.manager): Promise<Page> {
    assert(this.browser, "browser_not_started");
    const ctx = await this.browser.newContext({ baseURL: this.base.toString(), viewport: { width: 1440, height: 1000 }, locale: "pt-BR" });
    this.contextos.push(ctx);
    const page = await ctx.newPage();
    this.paginas.push(page);
    page.setDefaultTimeout(30_000);
    await page.goto("/login");
    await esperarARevelacao(page);
    await page.locator("#email").fill(user.email);
    await page.locator("#password").fill(ambiente(user.password_env));
    await page.getByRole("button", { name: "Entrar", exact: true }).click();
    await page.waitForURL(/\/app(?:\/|$|\?)/);
    await esperarARevelacao(page);
    return page;
  }

  async goto(page: Page, url: string): Promise<void> { await page.goto(url); await esperarARevelacao(page); }
  async captura(page: Page, nome: string): Promise<void> { await page.screenshot({ path: path.join(this.pasta, `${nome}.png`), fullPage: true }); }
  async cron(nome: "followup-flow-worker" | "event-log-drain" | "prospecting"): Promise<void> {
    const resposta = await this.api!.post(`/api/v1/cron/${nome}`, { headers: { authorization: `Bearer ${ambiente("QA_3475_CRON_SECRET")}` } });
    assert.equal(resposta.status(), 200, `cron_failed:${nome}:${resposta.status()}`);
  }

  async cancelado(e: Acompanhamento): Promise<void> {
    const org = this.fixture.organization.id;
    await expect.poll(async () => (await this.query<{ status: string }>("select status from followup_enrollments where organization_id=$1 and id=$2", [org, e.id]))[0]?.status).toBe("cancelled");
    const eventos = await this.query("select id from followup_enrollment_events where organization_id=$1 and enrollment_id=$2 and event_type='cancelled_manual'", [org, e.id]);
    assert.equal(eventos.length, 1, "cancel_event_missing_or_duplicated");
    await this.cron("followup-flow-worker");
    const depois = await this.query<{ status: string; next_eval_at: unknown }>("select status,next_eval_at from followup_enrollments where organization_id=$1 and id=$2", [org, e.id]);
    assert.equal(depois[0]?.status, "cancelled", "cancelled_enrollment_woke_up");
    assert.equal(depois[0]?.next_eval_at, null, "cancelled_enrollment_kept_clock");
  }

  async dossie(): Promise<void> {
    const f = this.fixture;
    const e = f.enrollments.dossie_dormente;
    const viewer = await this.pagina(f.users.viewer);
    await this.goto(viewer, `/app/ai/followups/enrollments/${e.id}`);
    await expect(viewer.getByTestId("dossie-status")).toBeVisible();
    await expect(viewer.getByTestId("dossie-cancelar")).toHaveCount(0);
    assert.equal((await viewer.request.post(`/api/v1/ai/followups/enrollments/${e.id}/cancel`, { data: {} })).status(), 403, "viewer_wrote_cancel");
    const outro = await this.pagina(f.users.other_tenant);
    assert.equal((await outro.request.get(`/api/v1/ai/followups/enrollments/${e.id}`)).status(), 404, "other_tenant_read_enrollment");
    this.check("viewer sem escrita; outra organização recebe 404");
    const page = await this.pagina();
    for (const [tipo, alvo] of Object.entries({ dormente: e, coletando: f.enrollments.dossie_coletando })) {
      await this.goto(page, "/app/ai/followups");
      await page.getByRole("tab", { name: "Fila", exact: true }).click();
      await page.getByLabel("Buscar contato").fill(alvo.contact_name);
      await page.getByRole("link", { name: alvo.contact_name, exact: true }).click();
      await page.waitForURL(`**/enrollments/${alvo.id}`);
      await esperarARevelacao(page);
      await page.getByTestId("dossie-cancelar").click();
      await page.getByTestId("dossie-cancelar-confirmar").click();
      await expect(page.getByTestId("dossie-status")).toHaveText("Cancelado");
      await expect(page.getByTestId("dossie-timeline")).toContainText(/cancelad/i);
      await this.captura(page, `dossie-${tipo}-cancelado-sem-reload`);
      await this.cancelado(alvo);
      await page.reload(); await esperarARevelacao(page);
      await expect(page.getByTestId("dossie-status")).toHaveText("Cancelado");
      this.check(`${tipo}: clique pela fila, estado/timeline imediatos, PG e reload, tick sem despertar`);
    }
  }

  async inbox(): Promise<void> {
    const e = this.fixture.enrollments.inbox_dormente;
    const page = await this.pagina();
    await this.goto(page, `/app/inbox?id=${e.conversation_id}`);
    const expandir = page.getByRole("button", { name: "Expandir painel do contato", exact: true });
    if (await expandir.isVisible()) await expandir.click();
    const secao = page.getByTestId("inbox-followup");
    await expect(secao).toBeVisible();
    await this.captura(page, "inbox-dormente-com-parar");
    await secao.getByTestId("parar-followup").click();
    await expect(secao.getByTestId("parar-followup")).toHaveCount(0);
    await this.cancelado(e);
    await page.reload(); await esperarARevelacao(page);
    await expect(page.getByTestId("comando-da-conversa")).toBeVisible();
    await expect(page.getByTestId("inbox-followup")).toBeVisible();
    await expect(page.getByTestId("escolher-fluxo-followup")).toBeVisible();
    await expect(page.getByTestId("parar-followup")).toHaveCount(0);
    await this.captura(page, "inbox-dormente-parado");
    this.check("Parar no Inbox: cancelled/evento persistidos; reload e tick não devolvem a espera");
  }

  async enviarToken(conversa: string, env: string, body: string, emNomeDe?: string): Promise<number> {
    const res = await this.api!.post("/api/v1/messages", {
      headers: { authorization: `Bearer ${ambiente(env)}`, "Idempotency-Key": randomUUID() },
      data: { conversation_id: conversa, type: "text", body, ...(emNomeDe ? { on_behalf_of_user_id: emNomeDe } : {}) },
    });
    return res.status();
  }

  async pausa(): Promise<void> {
    const f = this.fixture;
    const h = f.human;
    const page = await this.pagina();
    await this.goto(page, `/app/inbox?id=${h.conversation_id}`);
    await expect(page.getByTestId("badge-atendimento-humano")).toHaveCount(0);
    const semEscopo = await this.enviarToken(h.conversation_id, h.no_scope_token_env, `QA3475 recusado ${randomUUID()}`, h.user_id);
    assert.equal(semEscopo, 403, "on_behalf_without_scope_was_accepted");
    const puro = `QA3475 integração pura ${randomUUID()}`;
    assert.equal(await this.enviarToken(h.pure_conversation_id, h.token_env, puro), 201, "pure_token_send_failed");
    const antes = Date.now();
    const texto = `QA3475 resposta humana ${randomUUID()}`;
    assert.equal(await this.enviarToken(h.conversation_id, h.token_env, texto, h.user_id), 201, "on_behalf_send_failed");
    const depois = Date.now();
    const rows = await this.query<{ id: string; bot_silenced_until: Date | null }>("select id,bot_silenced_until from conversations where organization_id=$1 and id=any($2::uuid[])", [f.organization.id, [h.conversation_id, h.pure_conversation_id]]);
    assert.equal(rows.find((r) => r.id === h.pure_conversation_id)?.bot_silenced_until, null, "pure_token_paused_ai");
    const fim = rows.find((r) => r.id === h.conversation_id)?.bot_silenced_until;
    assert(fim instanceof Date && fim.getTime() >= antes + 299_000 && fim.getTime() <= depois + 301_000, "on_behalf_pause_not_five_minutes");
    assert(this.recebidos.some((r) => r.text.includes(texto)) && this.recebidos.some((r) => r.text.includes(puro)), "real_receiver_did_not_receive_human_and_control");
    await page.reload(); await esperarARevelacao(page);
    await expect(page.getByTestId("badge-atendimento-humano")).toBeVisible();
    await this.captura(page, "pausa-humana-de-cinco-minutos");
    this.check("transporte real e banco: em nome de pausa por cinco minutos, token puro não pausa, sem escopo recusa");
    // Espera o prazo real. Não atualiza bot_silenced_until para fabricar a volta.
    while (Date.now() <= fim.getTime() + 1_000) await new Promise((resolve) => setTimeout(resolve, Math.min(1_000, fim.getTime() + 1_001 - Date.now())));
    await page.reload(); await esperarARevelacao(page);
    await expect(page.getByTestId("badge-atendimento-humano")).toHaveCount(0);
    await expect(page.getByTestId("comando-da-conversa")).toContainText(/autom/i);
    await this.captura(page, "pausa-vencida-automatico-de-volta");
    this.check("prazo real expirou e a tela voltou ao automático sem alterar o carimbo");
  }

  async ultimaSaida(conversa: string, inicio: string): Promise<{ id: string; body: string; external_id: string; status: string } | undefined> {
    return (await this.query<{ id: string; body: string; external_id: string; status: string }>("select id,body,external_id,status from messages where organization_id=$1 and conversation_id=$2 and direction='outbound' and sent_via='ai' and created_at>=$3 order by created_at desc limit 1", [this.fixture.organization.id, conversa, inicio]))[0];
  }

  async assinatura(): Promise<void> {
    const f = this.fixture;
    assert(f.users.admin, "precondition:admin_fixture_required_for_prospecting");
    const page = await this.pagina(f.users.admin);
    const inicio = new Date().toISOString();
    const a = f.signatures.automation;
    await this.query("select emit_event($1,$2,$3,$4::jsonb,'{}'::jsonb,$5)", [a.event_type, a.entity_type, a.entity_id, JSON.stringify(a.payload), f.organization.id]);
    await this.cron("event-log-drain");
    await expect.poll(async () => (await this.ultimaSaida(a.conversation_id, inicio))?.status, { timeout: 180_000, message: "automation_no_real_send: conferir execução, LLM, consentimento, janela e cap" }).toMatch(/^(sent|delivered|read)$/);
    const p = f.signatures.prospecting;
    const inicioProspec = new Date().toISOString();
    assert.equal((await page.request.post("/api/v1/prospecting", { data: { action: "start", id: p.campaign_id, config: p.config } })).status(), 200, "prospecting_start_failed");
    const criado = await this.query<{ conversation_id: string }>("select conversation_id from prospecting_candidates where organization_id=$1 and campaign_id=$2 and id=$3", [f.organization.id, p.campaign_id, p.candidate_id]);
    const conversaProspec = criado[0]?.conversation_id;
    assert(conversaProspec, "prospecting_real_producer_did_not_create_conversation; use funnel_entry=on_start");
    // Aceleração do horário de fixture; o candidato continua passando pelo produtor real.
    await this.query("update prospecting_campaigns set next_send_at=now() where organization_id=$1 and id=$2 and status='running'", [f.organization.id, p.campaign_id]);
    await this.cron("prospecting");
    await expect.poll(async () => (await this.ultimaSaida(conversaProspec, inicioProspec))?.status, { timeout: 180_000, message: "prospecting_no_real_send: conferir LLM, candidato, janela, cap e pré-go-live" }).toMatch(/^(sent|delivered|read)$/);
    for (const [nome, conversa, desde] of [["automacao", a.conversation_id, inicio], ["prospeccao", conversaProspec, inicioProspec]]) {
      const saida = await this.ultimaSaida(conversa!, desde!);
      assert(saida, "signature_message_missing");
      const recebido = this.recebidos.find((r) => r.id === saida.external_id);
      assert(recebido, "signature_transport_receipt_missing");
      assert.equal(recebido.text, `*${f.signatures.agent_name}*\n${saida.body}`, "wrong_agent_signature_at_real_receiver");
      await this.goto(page, `/app/inbox?id=${conversa}`);
      await expect(page.getByText(saida.body, { exact: true }).first()).toBeVisible();
      await this.captura(page, `assinatura-${nome}-mensagem-na-conversa`);
      this.check(`${nome}: produtor real, mensagem persistida, assinatura exata no receiver e corpo visível no Inbox`);
    }
  }

  async recibosPush(): Promise<ReciboPush[]> {
    const n = this.fixture.notices.push_transport;
    assert(n, "precondition:push_transport_not_configured");
    const res = await fetch(n.receipts_url, { headers: { authorization: `Bearer ${ambiente(n.token_env)}` }, signal: AbortSignal.timeout(10_000) });
    assert.equal(res.status, 200, "precondition:push_receiver_unavailable");
    const schema = z.object({ deliveries: z.array(z.object({ id: z.string().min(1), conversation_id: uuid, user_id: uuid })) });
    return schema.parse(await res.json()).deliveries;
  }

  /** Aguarda o JOIN confirmado pelo servidor, antes de produzir o INSERT medido. */
  async abrirQuadroComAvisos(page: Page): Promise<void> {
    let temporizador: ReturnType<typeof setTimeout> | undefined;
    const inscrito = new Promise<void>((resolve, reject) => {
      temporizador = setTimeout(() => reject(new Error("precondition:alerts_realtime_subscription_timeout")), 30_000);
      page.on("websocket", (socket) => {
        socket.on("framereceived", ({ payload }) => {
          try {
            const frame = JSON.parse(String(payload)) as { topic?: string; event?: string; payload?: { status?: string } } | unknown[];
            const topic = Array.isArray(frame) ? frame[2] : frame.topic;
            const event = Array.isArray(frame) ? frame[3] : frame.event;
            const status = (Array.isArray(frame) ? frame[4] as { status?: string } : frame.payload)?.status;
            if (event === "phx_reply" && status === "ok" && typeof topic === "string" && topic.startsWith(`realtime:alerts-messages-${this.fixture.organization.id}:`)) resolve();
          } catch { /* Heartbeat ou frame não JSON não confirma a inscrição. */ }
        });
      });
    });
    try { await Promise.all([inscrito, this.goto(page, "/app/kanban")]); }
    finally { clearTimeout(temporizador); }
    await page.bringToFront();
  }

  async avisos(): Promise<void> {
    const f = this.fixture;
    const page = await this.pagina();
    await this.abrirQuadroComAvisos(page);
    for (const c of f.notices.cases) {
      const contatos = await this.query<{ name: string }>("select coalesce(display_name,name) as name from contacts where organization_id=$1 and id=$2", [f.organization.id, c.contact_id]);
      assert(contatos[0]?.name, "precondition:notice_contact_name");
      const anteriores = new Set(f.notices.push_transport ? (await this.recibosPush()).map((r) => r.id) : []);
      const outbound = await this.query<{ id: string }>("select m.id from messages m join conversations v on v.organization_id=m.organization_id and v.id=m.conversation_id where m.organization_id=$1 and m.conversation_id=$2 and m.direction='outbound' and m.sent_via='ai' and m.metadata->>'ai_actor_id'=$3 and m.status<>'failed' and (v.service_started_at is null or m.sent_at>=v.service_started_at)", [f.organization.id, c.conversation_id, f.notices.agent_id]);
      assert.equal(outbound.length > 0, c.name === "ja_engajado", "precondition:real_current_service_anchor");
      const inserida = await this.query<{ id: string }>("insert into messages (organization_id,conversation_id,channel_session_id,contact_id,type,direction,status,body,sent_at) values ($1,$2,$3,$4,$5,'inbound','received',$6,now()) returning id", [f.organization.id, c.conversation_id, c.channel_session_id, c.contact_id, c.type, c.body]);
      // A trigger de messages emite message.received. Não duplica emit_event.
      const mensagem = inserida[0]!.id;
      const eventos = await this.query<{ id: string }>("select id from event_log where organization_id=$1 and event_type='message.received' and entity_id=$2", [f.organization.id, mensagem]);
      assert.equal(eventos.length, 1, "canonical_message_received_event_missing_or_duplicated");
      const resposta = await page.request.get(`/api/v1/conversations/${c.conversation_id}/aviso-de-mensagem`);
      assert.equal(resposta.status(), 200, "notice_decision_route_failed");
      const json = z.object({ data: z.object({ avisar: z.boolean() }) }).parse(await resposta.json());
      assert.equal(json.data.avisar, c.expected_notice, "notice_route_wrong_keyword_decision");
      const toast = page.locator("[data-sonner-toast]").filter({ hasText: contatos[0]!.name }).filter({ has: page.getByRole("button", { name: "Abrir conversa", exact: true }) });
      if (c.expected_notice) { await expect(toast).toBeVisible(); await this.captura(page, `avisos-${c.name}-toast`); }
      await this.cron("event-log-drain");
      await expect.poll(async () => (await this.query<{ consumed_by: string[] }>("select consumed_by from event_log where organization_id=$1 and id=$2", [f.organization.id, eventos[0]!.id]))[0]?.consumed_by ?? [], { timeout: 60_000 }).toContain("web-push-inbound.v1");
      const decidido = await this.query<{ last_error: string | null }>("select last_error from event_log where organization_id=$1 and id=$2", [f.organization.id, eventos[0]!.id]);
      const erro = decidido[0]?.last_error ?? "";
      assert(!erro.includes("web-push-inbound.v1: vapid_ausente"), "precondition:app_vapid_missing_before_keyword_policy");
      if (c.expected_notice) assert(!erro.includes("web-push-inbound.v1:"), "web_push_consumer_skipped_expected_human_notice");
      else assert(erro.includes("web-push-inbound.v1: ia_conduz"), "web_push_consumer_did_not_apply_ai_suppression");
      if (c.expected_notice && f.notices.push_transport) {
        await expect.poll(async () => (await this.recibosPush()).some((r) => !anteriores.has(r.id) && r.conversation_id === c.conversation_id && r.user_id === f.users.manager.id), { timeout: 60_000, message: "real_push_receipt_missing: VAPID ausente não é prova de push" }).toBe(true);
      } else if (!c.expected_notice) {
        // Janela de observação curta depois do consumer terminar, com controle positivo anterior.
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        if (f.notices.push_transport) assert(!(await this.recibosPush()).some((r) => !anteriores.has(r.id) && r.conversation_id === c.conversation_id && r.user_id === f.users.manager.id), "unexpected_push_while_ai_handles");
        await expect(toast).toHaveCount(0);
      }
      await this.captura(page, `avisos-${c.name}`);
      this.check(`${c.name}: realtime/toast, decisão autenticada e branch do consumidor Web Push concordam; transporte registrado em subprova separada`);
      // Navega para remover o toast anterior antes do próximo caso, sem editar o sistema de avisos.
      await this.abrirQuadroComAvisos(page);
    }
    if (f.notices.push_transport) this.subprovas.pushTransport = { state: "passed", reason: "Envelope Web Push real recebido/decifrado e correlacionado nos controles positivos e negativos." };
  }

  async linhaAck(id: string, org = this.fixture.organization.id): Promise<LinhaAck> {
    const linhas = await this.query<LinhaAck>("select id,external_id,status,ack,delivered_at::text,read_at::text,error_code from messages where organization_id=$1 and id=$2", [org, id]);
    assert.equal(linhas.length, 1, "ack_message_missing");
    return linhas[0]!;
  }

  async webhookAck(externalId: string, ack: number, assinaturaValida = true): Promise<void> {
    const a = this.fixture.ack;
    const raw = JSON.stringify({ event: "message.ack", session: a.session_name, payload: { id: externalId, ack } });
    const segredo = assinaturaValida ? ambiente(a.hmac_secret_env) : `qa-3475-incorreto-${randomUUID()}`;
    const signature = `sha512=${createHmac("sha512", segredo).update(raw).digest("hex")}`;
    const res = await this.api!.post(`/api/v1/webhooks/waha/${encodeURIComponent(ambiente(a.webhook_token_env))}`, { headers: { "content-type": "application/json", "x-webhook-hmac": signature }, data: raw });
    assert.equal(res.status(), assinaturaValida ? 200 : 401, "waha_ack_hmac_contract_failed");
    if (assinaturaValida) {
      const logs = await this.query<{ valid_signature: boolean }>("select valid_signature from webhook_events_log where organization_id=$1 and channel_session_id=$2 and event_type='message.ack' and external_id=$3 order by received_at desc limit 1", [this.fixture.organization.id, a.channel_session_id, externalId]);
      assert.equal(logs[0]?.valid_signature, true, "waha_ack_was_not_signature_verified");
    }
  }

  async ack(): Promise<void> {
    const f = this.fixture;
    const page = await this.pagina();
    await this.goto(page, `/app/inbox?id=${f.ack.conversation_id}`);
    const enviarPelaTela = async (tag: string): Promise<{ linha: LinhaAck; texto: string }> => {
      const texto = `QA3475 ACK ${tag} ${randomUUID()}`;
      await page.getByRole("textbox", { name: "Mensagem", exact: true }).fill(texto);
      await page.getByRole("button", { name: "Enviar", exact: true }).click();
      await expect.poll(async () => this.recebidos.some((r) => r.text.includes(texto))).toBe(true);
      const linhas = await this.query<{ id: string }>("select id from messages where organization_id=$1 and conversation_id=$2 and body=$3 and direction='outbound'", [f.organization.id, f.ack.conversation_id, texto]);
      assert.equal(linhas.length, 1, "real_ui_send_not_persisted_once");
      const linha = await this.linhaAck(linhas[0]!.id);
      assert.equal(linha.status, "sent", "real_ui_send_not_accepted");
      assert(this.recebidos.some((r) => r.id === linha.external_id), "ui_message_external_id_not_from_receiver");
      return { linha, texto };
    };
    const bolha = (texto: string) => page.getByTestId("message-bubble").filter({ hasText: texto });
    const leitura = await enviarPelaTela("leitura");
    await this.webhookAck(leitura.linha.external_id, 3, false);
    assert.deepEqual(await this.linhaAck(leitura.linha.id), leitura.linha, "bad_hmac_mutated_message");
    await this.webhookAck(leitura.linha.external_id, 3);
    await expect(bolha(leitura.texto).getByLabel("Lida", { exact: true })).toBeVisible();
    const lida = await this.linhaAck(leitura.linha.id);
    assert(lida.read_at && lida.delivered_at, "read_ack_missing_timestamps");
    for (const antigo of [2, 1, -1]) {
      await this.webhookAck(lida.external_id, antigo);
      assert.deepEqual(await this.linhaAck(lida.id), lida, "late_ack_regressed_read_or_timestamps");
    }
    await page.reload(); await esperarARevelacao(page);
    await expect(bolha(leitura.texto).getByLabel("Lida", { exact: true })).toBeVisible();
    await this.captura(page, "ack-lida-preservada-apos-2-1-erro-e-reload");
    this.check("envio real UI/receiver; HMAC inválido recusa; read→ACK2/1/-1 preserva estado e horas em PG/Inbox/reload");

    for (const confirma of [2, 3]) {
      const envio = await enviarPelaTela(`recupera-${confirma}`);
      await this.webhookAck(envio.linha.external_id, -1);
      const falha = await this.linhaAck(envio.linha.id);
      assert.equal(falha.status, "failed", "ack_error_not_failed");
      assert.equal(falha.error_code, "ack_error", "ack_error_reason_missing");
      await expect(bolha(envio.texto).getByTestId("motivo-da-falha")).toContainText("Pode ser que ela tenha chegado");
      await this.webhookAck(envio.linha.external_id, 1);
      assert.equal((await this.linhaAck(envio.linha.id)).status, "failed", "server_ack_recovered_failure_without_device_confirmation");
      await this.webhookAck(envio.linha.external_id, confirma);
      const recuperada = await this.linhaAck(envio.linha.id);
      assert.equal(recuperada.status, confirma === 2 ? "delivered" : "read", "device_ack_did_not_recover_failure");
      assert(recuperada.delivered_at, "device_confirmation_missing_delivered_at");
      await this.webhookAck(envio.linha.external_id, -1);
      assert.deepEqual(await this.linhaAck(envio.linha.id), recuperada, "late_error_regressed_recovered_delivery");
      await page.reload(); await esperarARevelacao(page);
      await expect(bolha(envio.texto).getByLabel(confirma === 2 ? "Entregue" : "Lida", { exact: true })).toBeVisible();
      await expect(bolha(envio.texto).getByTestId("motivo-da-falha")).toHaveCount(0);
      await this.captura(page, `ack-falha-recuperada-por-${confirma}`);
      this.check(`sent→erro→ACK1 continua failed; ACK${confirma} confirma entrega/leitura, erro atrasado não rebaixa, Inbox/reload concordam`);
    }
    const outra = await this.linhaAck(f.ack.other_tenant_message_id, f.users.other_tenant.organization_id);
    await this.webhookAck(outra.external_id, 3);
    assert.deepEqual(await this.linhaAck(outra.id, f.users.other_tenant.organization_id), outra, "ack_crossed_tenant_boundary");
    this.check("ACK autenticado da org A para id externo existente só na org B não altera a outra organização");
    this.bolhaInvisivel();
  }

  /**
   * Porta pendente de bancada: API comum/MCP não atravessa esta guarda.
   * É necessário observar um inbound_turn real chamando send_message com Cf
   * e recebendo corpo_vazio. Não substitua por ausência de outbound no sandbox.
   */
  bolhaInvisivel(): void {
    this.check("Bolha invisível não medida: subprova invisibleAgentTool permanece not_run; ACKs não implicam aceite dessa guarda.");
  }

  async executar(): Promise<void> {
    const acoes: Record<Nome, () => Promise<void>> = { dossie: () => this.dossie(), inbox: () => this.inbox(), pausa: () => this.pausa(), assinatura: () => this.assinatura(), avisos: () => this.avisos(), ack: () => this.ack() };
    for (const nome of this.nomes) {
      this.atual = this.resultados.find((r) => r.scenario === nome)!;
      process.stdout.write(`Início: ${nome}\n`);
      try { await acoes[nome](); this.atual.state = "passed"; }
      catch (erro) {
        this.atual.state = "failed";
        // Erros de driver/HTTP não são serializados: podem carregar DSN ou headers.
        this.atual.error = erro instanceof assert.AssertionError ? String(erro.message).split("\n")[0] : erro instanceof Error && erro.message.startsWith("precondition:") ? erro.message : "scenario_failed; inspect synthetic screenshot and bench logs";
        const page = this.paginas.at(-1);
        if (page) await this.captura(page, `falha-${nome}`).catch(() => undefined);
      }
      process.stdout.write(`Fim: ${nome}: ${this.atual.state}\n`);
      await this.relatorio();
    }
  }

  async relatorio(): Promise<void> {
    const coreComplete = this.resultados.every((r) => r.state === "passed");
    const acceptanceComplete = coreComplete && Object.values(this.subprovas).every((s) => s.state === "passed");
    await writeFile(path.join(this.pasta, "relatorio.json"), JSON.stringify({ schema: 1, synthetic: true, environment_id: this.fixture.environment_id, build: this.fixture.build, started_at: this.inicio, updated_at: new Date().toISOString(), complete: acceptanceComplete, core_complete: coreComplete, scenarios: this.resultados, subproofs: this.subprovas, transport_receipts: this.recebidos.map((r) => ({ id: r.id, session: r.session, text_sha256: createHash("sha256").update(r.text).digest("hex") })), limits: ["Nenhuma prova de instalação/build: a bancada é fornecida pelo coordenador.", "Somente os cenários passed foram executados e medidos; subprovas not_run continuam explícitas mesmo com RC 0.", "Sem trace/HAR, para não persistir bearer, senha ou cabeçalhos de sessão."] }, null, 2));
  }

  async fechar(): Promise<void> {
    for (const ctx of this.contextos) await ctx.close().catch(() => undefined);
    await this.browser?.close();
    await this.api?.dispose();
    if (this.receiver) await new Promise<void>((resolve) => this.receiver!.close(() => resolve()));
    await this.pool.end();
  }
}

async function main(): Promise<void> {
  const args = argumentos();
  if (!args) { process.stdout.write(AJUDA); return; }
  const fixture = manifestoSchema.parse(JSON.parse(await readFile(args.manifesto, "utf8")));
  const prova = new Prova(fixture, args.nomes, args.pasta);
  try {
    await prova.preflight();
    await prova.abrirRecursos();
    await prova.executar();
    if (prova.resultados.some((r) => r.state === "failed")) process.exitCode = 1;
  } finally { await prova.fechar(); }
}

void main().catch((erro: unknown) => {
  const detalhe = erro instanceof assert.AssertionError ? String(erro.message).split("\n")[0] : erro instanceof z.ZodError ? `manifest_invalid:${erro.issues[0]?.path.join(".") ?? "root"}` : erro instanceof Error && erro.message.startsWith("precondition:") ? erro.message : "setup_failed; check explicit manifest, dependencies and isolated bench";
  process.stderr.write(`${detalhe}\n`);
  process.exitCode = 1;
});
