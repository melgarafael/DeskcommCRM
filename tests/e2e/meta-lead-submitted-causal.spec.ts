/**
 * Prova de fio a fio: WAHA assinado -> mensagem -> clique atomico ->
 * message.received -> dreno -> Graph local -> ledger por clique.
 * O receptor confirma somente o comportamento do CRM;
 * HTTP 200 sintético não é aceite nem atribuição pela Meta.
 *
 * Precondições do runner: baseline aplicado, seeds de credenciais e nascimento,
 * META_ADS_GRAPH_BASE_URL=http://127.0.0.1:3995 e
 * WAHA_WEBHOOK_REQUIRE_SIGNATURE=true no processo do Playwright/next start.
 * O gerador de .env.e2e não define essas duas chaves. playwright.config.ts
 * publica o arquivo em process.env e passa webServer.env; uma chave presente
 * no arquivo venceria a variável do runner só no servidor. O workflow deve
 * recusar essa colisão antes de iniciar Playwright.
 */
import { createHmac, randomInt, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";

import { createClient } from "@supabase/supabase-js";
import { phoneLookupVariants } from "@/lib/channels/phone-variants";
import type { Database } from "@/lib/database.types";
import { VERSAO_PADRAO_DA_GRAPH } from "@/lib/graph-version";

import { credenciaisSupabaseDeTeste, destinoEhLocal } from "../../scripts/lib/env-de-teste";
import { lerCreds, loginComoAdmin } from "./helpers/login-admin";
import { expect, test, type APIRequestContext } from "./helpers/test";

const GRAPH_BASE = "http://127.0.0.1:3995";
const DATASET_ID = `qa-dataset-${randomUUID()}`;
const BEARER_SINTETICO = `qa-token-${randomUUID()}`;
const SEGREDO_WAHA = `qa-hmac-${randomUUID()}-${randomUUID()}`;
const TOKEN_WEBHOOK = `qa-causal-${randomUUID()}`;
const NOME_SESSAO = `qa-causal-${randomUUID()}`;
const CONSUMIDOR = "conversoes.clique_meta";

// Executa antes do beforeAll e antes de qualquer webhook/evento da spec.
if (process.env.META_ADS_GRAPH_BASE_URL !== GRAPH_BASE)
  throw new Error("E2E causal recusado: destino Graph não é o receptor 127.0.0.1:3995");
if (process.env.META_GRAPH_BASE_URL !== "http://127.0.0.1:9")
  throw new Error("E2E causal recusado: Graph do canal não está bloqueada em loopback");
if (process.env.WAHA_WEBHOOK_REQUIRE_SIGNATURE !== "true")
  throw new Error("E2E causal exige assinatura WAHA no processo next start");
const ambienteE2E = readFileSync(".env.e2e", "utf8");
if (
  /^\s*(META_ADS_GRAPH_BASE_URL|META_GRAPH_BASE_URL|WAHA_WEBHOOK_REQUIRE_SIGNATURE)\s*=/m.test(
    ambienteE2E,
  )
)
  throw new Error(".env.e2e sobrescreveria a guarda Graph ou a assinatura no webServer");
if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !destinoEhLocal(process.env.NEXT_PUBLIC_SUPABASE_URL))
  throw new Error("E2E causal recusado: Supabase não é local");
if (process.env.WAHA_API_BASE_URL !== "http://127.0.0.1:3999")
  throw new Error("E2E causal recusado: transporte WAHA não é local");
if (!process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.INTERNAL_SECRET)
  throw new Error("E2E causal exige credenciais sintéticas e cron secret locais");

const { url, serviceRole } = credenciaisSupabaseDeTeste();
const db = createClient<Database>(url, serviceRole, {
  auth: { autoRefreshToken: false, persistSession: false },
});

let ativacaoAlterada = false;

interface Creds {
  org_id: string;
  nascimento?: { pipeline_default_id: string };
}

interface Captura {
  method: string | undefined;
  path: string;
  bearerValido: boolean;
  body: unknown;
  status: number;
}

interface Mensagem {
  id: string;
  contact_id: string;
  conversation_id: string;
  created_at: string;
  metadata: Record<string, unknown>;
}

interface Lead {
  id: string;
  contact_id: string | null;
  created_at: string;
  source_metadata: Record<string, unknown>;
}

const capturas: Captura[] = [];
const respostasPlanejadas: number[] = [];
let inicioCapturas = 0;
let receptor: Server | undefined;
let sessaoId: string | undefined;
let conexaoId: string | undefined;
let creds: Creds;
const telefones = new Set<string>();

async function telefoneUnico(): Promise<string> {
  for (let tentativa = 0; tentativa < 20; tentativa++) {
    const numero = `55319${randomInt(60_000_000, 100_000_000)}`;
    if (telefones.has(numero)) continue;
    const { data, error } = await db
      .from("contacts")
      .select("id")
      .eq("organization_id", creds.org_id)
      .in("phone_number", phoneLookupVariants(numero))
      .limit(1);
    if (error) throw new Error(`verificar telefone sintético: ${error.message}`);
    if (data?.length) continue;
    telefones.add(numero);
    return numero;
  }
  throw new Error("não foi possível gerar telefone sintético livre no tenant E2E");
}

function mensagemWaha(
  telefone: string,
  externalId: string,
  adReply?: Record<string, unknown>,
  extra?: Record<string, unknown>,
) {
  return {
    event: "message",
    session: NOME_SESSAO,
    payload: {
      id: externalId,
      from: `${telefone}@c.us`,
      fromMe: false,
      body: `Olá, gostaria de informações (${externalId})`,
      timestamp: Math.floor(Date.now() / 1000),
      _data: {
        notifyName: `Cliente causal ${telefone}`,
        ...(adReply
          ? { message: { extendedTextMessage: { contextInfo: { externalAdReply: adReply } } } }
          : {}),
      },
      ...extra,
    },
  };
}

async function enviarWebhook(
  request: APIRequestContext,
  envelope: ReturnType<typeof mensagemWaha>,
  assinatura: "valida" | "ausente" | "errada" = "valida",
): Promise<number> {
  const body = JSON.stringify(envelope);
  const hmac = createHmac("sha512", SEGREDO_WAHA).update(body, "utf8").digest("hex");
  const response = await request.post(`/api/v1/webhooks/waha/${TOKEN_WEBHOOK}`, {
    data: body,
    headers: {
      "content-type": "application/json",
      ...(assinatura === "ausente"
        ? {}
        : { "x-webhook-hmac": `sha512=${assinatura === "errada" ? "0".repeat(128) : hmac}` }),
    },
  });
  return response.status();
}

async function mensagens(externalId: string): Promise<Mensagem[]> {
  const { data, error } = await db
    .from("messages")
    .select("id,contact_id,conversation_id,created_at,metadata")
    .eq("organization_id", creds.org_id)
    .eq("external_id", externalId);
  if (error) throw new Error(`messages ${externalId}: ${error.message}`);
  return (data ?? []) as Mensagem[];
}

async function leads(contactId: string): Promise<Lead[]> {
  const { data, error } = await db
    .from("crm_leads")
    .select("id,contact_id,created_at,source_metadata")
    .eq("organization_id", creds.org_id)
    .eq("contact_id", contactId);
  if (error) throw new Error(`crm_leads ${contactId}: ${error.message}`);
  return (data ?? []) as Lead[];
}

async function ledger(leadId: string, eventName = "LeadSubmitted") {
  const { data, error } = await db
    .from("ad_conversion_dispatches")
    .select("id,platform,event_name,status,event_id,reason,event_occurred_at")
    .eq("organization_id", creds.org_id)
    .eq("lead_id", leadId)
    .eq("event_name", eventName);
  if (error) throw new Error(`ledger ${leadId}: ${error.message}`);
  return data ?? [];
}

interface CliqueRegistrado {
  id: string;
  contact_id: string;
  first_message_id: string;
  ctwa_clid: string;
  captured_at: string;
  status: string;
  reason: string | null;
  event_id: string;
}

async function cliquesDaMensagem(messageId: string): Promise<CliqueRegistrado[]> {
  const { data, error } = await db
    .from("meta_ctwa_click_dispatches" as never)
    .select("id,contact_id,first_message_id,ctwa_clid,captured_at,status,reason,event_id")
    .eq("organization_id", creds.org_id)
    .eq("first_message_id", messageId);
  if (error) throw new Error(`cliques ${messageId}: ${error.message}`);
  return (data ?? []) as unknown as CliqueRegistrado[];
}

async function cliquesDoContato(contactId: string): Promise<CliqueRegistrado[]> {
  const { data, error } = await db
    .from("meta_ctwa_click_dispatches" as never)
    .select("id,contact_id,first_message_id,ctwa_clid,captured_at,status,reason,event_id")
    .eq("organization_id", creds.org_id)
    .eq("contact_id", contactId);
  if (error) throw new Error(`cliques do contato ${contactId}: ${error.message}`);
  return (data ?? []) as unknown as CliqueRegistrado[];
}

async function eventos(leadId: string, eventType = "lead.created") {
  const { data, error } = await db
    .from("event_log")
    .select("id,event_type,entity_kind,entity_id,organization_id,payload,consumed_by,status")
    .eq("organization_id", creds.org_id)
    .eq("entity_id", leadId)
    .eq("event_type", eventType);
  if (error) throw new Error(`event_log ${leadId}: ${error.message}`);
  return data ?? [];
}

async function drenar(request: APIRequestContext): Promise<void> {
  const response = await request.post("/api/v1/cron/event-log-drain", {
    headers: { authorization: `Bearer ${process.env.INTERNAL_SECRET}` },
  });
  expect(response.status(), "cron local event-log-drain deve aceitar o secret sintético").toBe(200);
}

async function aguardarConsumo(
  request: APIRequestContext,
  leadId: string,
  eventType = "lead.created",
) {
  await expect
    .poll(
      async () => {
        const rows = await eventos(leadId, eventType);
        if (rows.some((row) => row.consumed_by.includes(CONSUMIDOR))) return true;
        await drenar(request); // rota real; jamais invoca diretamente o handler
        return false;
      },
      {
        message: `${eventType} de ${leadId} não foi consumido por ${CONSUMIDOR}`,
        timeout: 30_000,
        intervals: [250, 500, 1_000],
      },
    )
    .toBe(true);
}

async function nascer(
  request: APIRequestContext,
  adReply?: Record<string, unknown>,
  extra?: Record<string, unknown>,
  options: { aguardarConsumo?: boolean } = {},
) {
  const externalId = `qa-causal-${randomUUID()}`;
  const envelope = mensagemWaha(await telefoneUnico(), externalId, adReply, extra);
  expect(await enviarWebhook(request, envelope), `webhook ${externalId}`).toBe(200);
  await expect
    .poll(async () => (await mensagens(externalId)).length, {
      message: `mensagem ${externalId} não persistida`,
      timeout: 20_000,
    })
    .toBe(1);
  const [message] = await mensagens(externalId);
  expect(message).toBeDefined();
  await expect
    .poll(async () => (await leads(message!.contact_id)).length, {
      message: `lead não nasceu da mensagem ${externalId}`,
      timeout: 20_000,
    })
    .toBe(1);
  const [lead] = await leads(message!.contact_id);
  expect(lead).toBeDefined();
  if (options.aguardarConsumo !== false)
    await aguardarConsumo(request, message!.id, "message.received");
  return { envelope, externalId, message: message!, lead: lead! };
}

async function aguardarTentativaTransitoria(
  request: APIRequestContext,
  messageId: string,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const row = (await cliquesDaMensagem(messageId))[0];
        if (row?.status === "skipped" && row.reason === "nova_tentativa_agendada") return true;
        await drenar(request);
        return false;
      },
      {
        message: `a primeira tentativa de ${messageId} não terminou com retry transitório`,
        timeout: 30_000,
        intervals: [250, 500, 1_000],
      },
    )
    .toBe(true);
}

function posts(eventId: string): Captura[] {
  return capturas.filter((c) => {
    if (!c.body || typeof c.body !== "object") return false;
    const data = (c.body as { data?: Array<{ event_id?: string }> }).data;
    return data?.[0]?.event_id === eventId;
  });
}

async function fecharReceptor(): Promise<void> {
  if (!receptor?.listening) return;
  await new Promise<void>((resolve, reject) =>
    receptor!.close((error) => (error ? reject(error) : resolve())),
  );
}

async function limparFixtures(): Promise<void> {
  if (!creds?.org_id || !sessaoId) return;
  const org = creds.org_id;
  const { data: convs, error: convError } = await db
    .from("conversations")
    .select("id,contact_id")
    .eq("organization_id", org)
    .eq("channel_session_id", sessaoId);
  if (convError) throw convError;
  const contactIds = [...new Set((convs ?? []).map((c) => c.contact_id))];
  const convIds = (convs ?? []).map((c) => c.id);
  const { data: leadRows, error: leadError } = contactIds.length
    ? await db
        .from("crm_leads")
        .select("id")
        .eq("organization_id", org)
        .in("contact_id", contactIds)
    : { data: [], error: null };
  if (leadError) throw leadError;
  const leadIds = (leadRows ?? []).map((l) => l.id);
  const { data: clickRows, error: clickError } = contactIds.length
    ? await db
        .from("meta_ctwa_click_dispatches" as never)
        .select("id")
        .eq("organization_id", org)
        .in("contact_id", contactIds)
    : { data: [], error: null };
  if (clickError) throw clickError;
  const clickIds = (clickRows ?? []).map((c: { id: string }) => c.id);
  const { data: messageRows, error: msgError } = await db
    .from("messages")
    .select("id")
    .eq("organization_id", org)
    .eq("channel_session_id", sessaoId);
  if (msgError) throw msgError;
  const eventIds = [
    ...leadIds,
    ...clickIds,
    ...contactIds,
    ...convIds,
    ...(messageRows ?? []).map((m) => m.id),
  ];
  const changes = [
    () =>
      db
        .from("webhook_events_log")
        .delete()
        .eq("organization_id", org)
        .eq("webhook_path_token", TOKEN_WEBHOOK),
    ...(eventIds.length
      ? [() => db.from("event_log").delete().eq("organization_id", org).in("entity_id", eventIds)]
      : []),
    ...(leadIds.length
      ? [
          () =>
            db
              .from("ad_conversion_dispatches")
              .delete()
              .eq("organization_id", org)
              .in("lead_id", leadIds),
        ]
      : []),
    ...(leadIds.length
      ? [() => db.from("crm_leads").delete().eq("organization_id", org).in("id", leadIds)]
      : []),
    () =>
      db
        .from("conversations")
        .delete()
        .eq("organization_id", org)
        .eq("channel_session_id", sessaoId!),
    ...(contactIds.length
      ? [() => db.from("contacts").delete().eq("organization_id", org).in("id", contactIds)]
      : []),
    () =>
      db
        .from("channel_session_health")
        .delete()
        .eq("organization_id", org)
        .eq("channel_session_id", sessaoId!),
    () => db.from("channel_sessions").delete().eq("organization_id", org).eq("id", sessaoId!),
    ...(conexaoId
      ? [
          () =>
            db
              .from("ad_platform_connections")
              .delete()
              .eq("organization_id", org)
              .eq("id", conexaoId!),
        ]
      : []),
  ];
  for (const change of changes) {
    const { error } = await change();
    if (error) throw new Error(`limpeza E2E causal: ${error.message}`);
  }
}

test.describe("LeadSubmitted causal pelo webhook WAHA", () => {
  test.describe.configure({ timeout: 90_000 });

  test.beforeEach(() => {
    inicioCapturas = capturas.length;
  });

  test.beforeAll(async () => {
    creds = lerCreds() as unknown as Creds;
    if (!creds.org_id || !creds.nascimento?.pipeline_default_id)
      throw new Error("Rode os seeds E2E de credenciais e nascimento antes da spec causal");

    // Uma conexão preexistente pode ser de outra suíte. Nunca a substituímos.
    const { data: existente, error: existingError } = await db
      .from("ad_platform_connections")
      .select("id")
      .eq("organization_id", creds.org_id)
      .eq("platform", "meta_ads")
      .maybeSingle();
    if (existingError) throw existingError;
    if (existente)
      throw new Error("A organização E2E já tem conexão Meta; use banco descartável limpo");

    receptor = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks);
      const path = new URL(req.url ?? "/", GRAPH_BASE).pathname;
      const expectedPath = `/${VERSAO_PADRAO_DA_GRAPH}/${DATASET_ID}/events`;
      const valid = req.method === "POST" && path === expectedPath && raw.length <= 1_000_000;
      let body: unknown = null;
      try {
        body = JSON.parse(raw.toString("utf8"));
      } catch {
        /* capturado como erro de contrato */
      }
      const status = valid && body !== null ? (respostasPlanejadas.shift() ?? 200) : 400;
      capturas.push({
        method: req.method,
        path,
        bearerValido: req.headers.authorization === `Bearer ${BEARER_SINTETICO}`,
        body,
        status,
      });
      res.writeHead(status, { "content-type": "application/json" });
      res.end(
        status === 200
          ? '{"events_received":1}'
          : '{"error":{"message":"falha sintética","code":2}}',
      );
    });
    await new Promise<void>((resolve, reject) => {
      receptor!.once("error", reject);
      receptor!.listen(3995, "127.0.0.1", resolve);
    });
    const address = receptor.address();
    if (
      !address ||
      typeof address === "string" ||
      address.address !== "127.0.0.1" ||
      address.port !== 3995
    )
      throw new Error("Receptor Graph não escuta no loopback autorizado");

    const { data: sessionSecret, error: secretError } = await db.rpc("fn_encrypt_oauth", {
      plaintext: SEGREDO_WAHA,
    });
    if (secretError || !sessionSecret)
      throw new Error(`cifra local WAHA indisponível: ${secretError?.message ?? "vazia"}`);
    const { data: session, error: sessionError } = await db
      .from("channel_sessions")
      .insert({
        organization_id: creds.org_id,
        waha_session_name: NOME_SESSAO,
        display_name: "Canal causal E2E",
        webhook_path_token: TOKEN_WEBHOOK,
        webhook_secret_encrypted: sessionSecret,
      } as never)
      .select("id")
      .single();
    if (sessionError || !session)
      throw new Error(`sessão WAHA E2E: ${sessionError?.message ?? "vazia"}`);
    sessaoId = session.id;

    const { data: encryptedToken, error: tokenError } = await db.rpc("fn_encrypt_oauth", {
      plaintext: BEARER_SINTETICO,
    });
    if (tokenError || !encryptedToken)
      throw new Error(`cifra local Graph indisponível: ${tokenError?.message ?? "vazia"}`);
    const { data: connection, error: connectionError } = await db
      .from("ad_platform_connections")
      .insert({
        organization_id: creds.org_id,
        platform: "meta_ads",
        dataset_id: DATASET_ID,
        access_token_encrypted: encryptedToken,
        test_event_code: null, // o receptor é sintético; o ledger deve chegar a sent
        enabled: true,
      } as never)
      .select("id")
      .single();
    if (connectionError || !connection)
      throw new Error(`conexão Graph E2E: ${connectionError?.message ?? "vazia"}`);
    conexaoId = connection.id;

    const { data: org, error: orgError } = await db
      .from("organizations")
      .select("meta_lead_birth_enabled_at")
      .eq("id", creds.org_id)
      .single();
    if (orgError || !org)
      throw new Error(`configuração da organização E2E: ${orgError?.message ?? "vazia"}`);
    if (
      (org as unknown as { meta_lead_birth_enabled_at: string | null })
        .meta_lead_birth_enabled_at !== null
    )
      throw new Error(
        "Organização E2E já tem LeadSubmitted causal ativo; use banco descartável limpo",
      );
    const { error: ativacaoError } = await db.rpc(
      "fn_definir_meta_lead_birth" as never,
      {
        p_org: creds.org_id,
        p_enabled: true,
      } as never,
    );
    if (ativacaoError) throw new Error(`ativação causal E2E: ${ativacaoError.message}`);
    ativacaoAlterada = true;
  });

  test.afterAll(async () => {
    try {
      await limparFixtures();
    } finally {
      try {
        if (ativacaoAlterada) {
          const { error } = await db.rpc(
            "fn_definir_meta_lead_birth" as never,
            {
              p_org: creds.org_id,
              p_enabled: false,
            } as never,
          );
          if (error) throw new Error(`desativação causal E2E: ${error.message}`);
        }
      } finally {
        await fecharReceptor();
      }
    }
  });

  test.afterEach(async ({}, testInfo) => {
    const recentes = capturas.slice(inicioCapturas);
    respostasPlanejadas.length = 0;
    await testInfo.attach("graph-local-sem-credencial.json", {
      body: Buffer.from(JSON.stringify(recentes, null, 2)),
      contentType: "application/json",
    });
    for (const captura of recentes) {
      expect(captura.method).toBe("POST");
      expect(captura.path).toBe(`/${VERSAO_PADRAO_DA_GRAPH}/${DATASET_ID}/events`);
      expect(captura.bearerValido, "somente o bearer sintético chega ao receptor").toBe(true);
      expect(captura.status === 200 || captura.status === 503).toBe(true);
      const body = captura.body as {
        data?: Array<Record<string, unknown>>;
        test_event_code?: string;
      };
      expect(body?.data).toHaveLength(1);
      expect(body.data?.[0]?.event_name).toBe("LeadSubmitted");
      expect(body.data?.[0]?.event_id).toMatch(/^[\da-f-]{36}:LeadSubmitted$/i);
      expect((body.data?.[0]?.user_data as Record<string, unknown>)?.ctwa_clid).toEqual(
        expect.any(String),
      );
      expect(body).not.toHaveProperty("test_event_code");
    }
  });

  test("CTWA assinado nasce e envia uma conversão com prova vinculada à mensagem", async ({
    request,
  }) => {
    const click = `ctwa-${randomUUID()}`;
    const adId = `ad-${randomUUID()}`;
    const { externalId, message, lead } = await nascer(request, {
      sourceType: "ad",
      ctwaClid: click,
      sourceId: adId,
    });
    const [clique] = await cliquesDaMensagem(message.id);
    expect(clique).toBeDefined();
    const eventId = clique!.event_id;
    const proof = lead.source_metadata.meta_capi_lead_birth_v1 as Record<string, unknown>;
    expect(await mensagens(externalId)).toHaveLength(1);
    expect(proof).toMatchObject({
      platform: "meta_ads",
      source_type: "ad",
      ctwa_clid: click,
      message_id: message.id,
      conversation_id: message.conversation_id,
    });
    expect(Date.parse(String(proof.captured_at))).toBe(Date.parse(message.created_at));
    expect((message.metadata.meta_ctwa_message_v1 as Record<string, unknown>).ctwa_clid).toBe(
      click,
    );
    const eventRows = await eventos(lead.id);
    expect(eventRows).toHaveLength(1);
    const [event] = eventRows;
    expect(event).toMatchObject({
      event_type: "lead.created",
      entity_kind: "crm_lead",
      entity_id: lead.id,
      organization_id: creds.org_id,
      payload: expect.objectContaining({ conversation_id: message.conversation_id }),
    });
    const { data: arquivos, error: arquivoErro } = await db
      .from("webhook_events_log")
      .select("id,valid_signature")
      .eq("organization_id", creds.org_id)
      .eq("webhook_path_token", TOKEN_WEBHOOK)
      .eq("external_id", externalId);
    if (arquivoErro) throw arquivoErro;
    expect(arquivos).toHaveLength(1);
    expect(arquivos?.[0]?.valid_signature).toBe(true);
    await expect
      .poll(async () => (await cliquesDaMensagem(message.id))[0]?.status, {
        message: `LeadSubmitted ${eventId} não chegou a sent`,
        timeout: 20_000,
      })
      .toBe("sent");
    const rows = await cliquesDaMensagem(message.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      event_id: eventId,
      ctwa_clid: click,
      first_message_id: message.id,
    });
    expect(Date.parse(rows[0]!.captured_at)).toBeGreaterThanOrEqual(Date.parse(message.created_at));
    expect(posts(eventId)).toHaveLength(1);
    const [post] = posts(eventId);
    expect(post).toMatchObject({
      method: "POST",
      path: `/${VERSAO_PADRAO_DA_GRAPH}/${DATASET_ID}/events`,
      bearerValido: true,
      status: 200,
    });
    const body = post!.body as { data: Array<Record<string, unknown>>; test_event_code?: string };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({
      event_name: "LeadSubmitted",
      event_id: eventId,
      event_time: Math.floor(Date.parse(clique!.captured_at) / 1000),
      action_source: "business_messaging",
      messaging_channel: "whatsapp",
      user_data: expect.objectContaining({ ctwa_clid: click }),
    });
    expect(JSON.stringify(body)).not.toContain(adId);
    expect(body.data[0]).not.toHaveProperty("custom_data");
    expect(body).not.toHaveProperty("test_event_code");
  });

  test("mensagem comum cria lead, mas nenhuma conversão", async ({ request }) => {
    const before = capturas.length;
    const { lead } = await nascer(request);
    expect(lead.source_metadata).not.toHaveProperty("meta_capi_lead_birth_v1");
    expect(await eventos(lead.id)).toHaveLength(1);
    expect(await cliquesDoContato(lead.contact_id!)).toHaveLength(0);
    expect(await ledger(lead.id)).toHaveLength(0);
    expect(capturas).toHaveLength(before);
  });

  test("cliques A, B e C do mesmo contato e lead aberto enviam tres eventos sem novo card", async ({
    request,
  }) => {
    const first = await nascer(request, { sourceType: "ad", ctwaClid: `ctwa-${randomUUID()}` });
    const phone = first.envelope.payload.from.replace("@c.us", "");
    const mensagensNovas: Mensagem[] = [];
    for (const _ of [2, 3]) {
      const externalId = `qa-causal-${randomUUID()}`;
      const envelope = mensagemWaha(phone, externalId, {
        sourceType: "ad",
        ctwaClid: `ctwa-${randomUUID()}`,
      });
      expect(await enviarWebhook(request, envelope)).toBe(200);
      await expect
        .poll(async () => (await mensagens(externalId)).length, {
          message: `mensagem ${externalId} não persistida`,
          timeout: 20_000,
        })
        .toBe(1);
      const [message] = await mensagens(externalId);
      expect(message).toBeDefined();
      mensagensNovas.push(message!);
      await aguardarConsumo(request, message!.id, "message.received");
    }
    expect(await leads(first.message.contact_id)).toHaveLength(1);
    expect(await eventos(first.lead.id)).toHaveLength(1);
    expect(await ledger(first.lead.id)).toHaveLength(0);
    const cliques = await cliquesDoContato(first.message.contact_id);
    expect(cliques).toHaveLength(3);
    expect(new Set(cliques.map((c) => c.event_id)).size).toBe(3);
    expect(cliques.every((c) => c.status === "sent")).toBe(true);
    expect(new Set(cliques.map((c) => c.first_message_id))).toEqual(
      new Set([first.message.id, ...mensagensNovas.map((m) => m.id)]),
    );
    for (const c of cliques) expect(posts(c.event_id)).toHaveLength(1);
  });

  test("reentrega e drenagem repetida não duplicam mensagem nem POST", async ({ request }) => {
    const click = `ctwa-${randomUUID()}`;
    const { envelope, externalId, message, lead } = await nascer(request, {
      sourceType: "ad",
      ctwaClid: click,
    });
    const [clique] = await cliquesDaMensagem(message.id);
    expect(clique).toBeDefined();
    const eventId = clique!.event_id;
    expect(posts(eventId)).toHaveLength(1);
    expect(await enviarWebhook(request, envelope)).toBe(200);
    const secondExternalId = `qa-causal-${randomUUID()}`;
    const sameClickAnotherMessage = mensagemWaha(
      envelope.payload.from.replace("@c.us", ""),
      secondExternalId,
      { sourceType: "ad", ctwaClid: click },
    );
    expect(await enviarWebhook(request, sameClickAnotherMessage)).toBe(200);
    await expect
      .poll(async () => (await mensagens(secondExternalId)).length, {
        message: `segunda mensagem do clique ${click} não persistida`,
        timeout: 20_000,
      })
      .toBe(1);
    const [secondMessage] = await mensagens(secondExternalId);
    expect(secondMessage).toBeDefined();
    await aguardarConsumo(request, secondMessage!.id, "message.received");
    await drenar(request);
    await drenar(request);
    expect(await mensagens(externalId)).toHaveLength(1);
    expect(await mensagens(secondExternalId)).toHaveLength(1);
    expect(await leads(message.contact_id)).toHaveLength(1);
    expect(await eventos(lead.id)).toHaveLength(1);
    expect(await cliquesDoContato(message.contact_id)).toHaveLength(1);
    expect(posts(eventId)).toHaveLength(1);
  });

  test("503, retry autorizado e regressão conservam ledger, event_id e outros eventos", async ({
    page,
    request,
  }) => {
    respostasPlanejadas.push(503);
    const { lead, message } = await nascer(
      request,
      { sourceType: "ad", ctwaClid: `ctwa-${randomUUID()}` },
      undefined,
      { aguardarConsumo: false },
    );
    await aguardarTentativaTransitoria(request, message.id);
    const [firstRow] = await cliquesDaMensagem(message.id);
    expect(firstRow).toBeDefined();
    const eventId = firstRow!.event_id;
    expect(posts(eventId)).toHaveLength(1);
    expect(posts(eventId)[0]?.status).toBe(503);
    expect(firstRow).toMatchObject({
      status: "skipped",
      reason: "nova_tentativa_agendada",
      event_id: eventId,
    });

    // O retry por clique e independente dos consumidores por lead.
    // As sentinelas ja existem ANTES do retry real.
    const outrosEventos = ["Purchase", "QualifiedLead", `MetaEtapa:${randomUUID()}`];
    for (const event_name of outrosEventos) {
      const { error } = await db.from("ad_conversion_dispatches").insert({
        organization_id: creds.org_id,
        lead_id: lead.id,
        platform: event_name === "QualifiedLead" ? "google_ads" : "meta_ads",
        event_name,
        status: "error",
        reason: "sentinela_qa",
        event_id: `${lead.id}:${event_name}`,
      });
      if (error) throw error;
    }
    const outrosAntes = await Promise.all(outrosEventos.map((name) => ledger(lead.id, name)));

    await loginComoAdmin(page, lerCreds());
    const retry = await page.request.post(`/api/v1/conversions/meta-clicks/${firstRow!.id}/retry`);
    expect(retry.status(), "retry exige admin autenticado e deve ser aceito").toBe(200);
    expect((await retry.json()).data?.queued).toBe(true);
    await aguardarConsumo(request, firstRow!.id, "ad_conversion.click_retry_requested");
    await expect
      .poll(async () => (await cliquesDaMensagem(message.id))[0]?.status, {
        message: `LeadSubmitted ${eventId} não chegou a sent após retry autorizado`,
        timeout: 20_000,
      })
      .toBe("sent");
    const [lastRow] = await cliquesDaMensagem(message.id);
    expect(lastRow?.id).toBe(firstRow?.id);
    expect(lastRow?.event_id).toBe(eventId);
    expect(await cliquesDaMensagem(message.id)).toHaveLength(1);
    expect(posts(eventId).map((p) => p.status)).toEqual([503, 200]);
    expect(await Promise.all(outrosEventos.map((name) => ledger(lead.id, name)))).toEqual(
      outrosAntes,
    );
    const repeatRetry = await page.request.post(
      `/api/v1/conversions/meta-clicks/${firstRow!.id}/retry`,
    );
    expect(repeatRetry.status()).toBe(200);
    expect((await repeatRetry.json()).data?.queued).toBe(false);
    await drenar(request);
    expect(posts(eventId)).toHaveLength(2);
  });

  test("assinatura ausente ou errada é rejeitada antes da mensagem", async ({ request }) => {
    const before = capturas.length;
    const phone = await telefoneUnico();
    const unsignedId = `qa-causal-${randomUUID()}`;
    const wrongId = `qa-causal-${randomUUID()}`;
    expect(
      await enviarWebhook(
        request,
        mensagemWaha(phone, unsignedId, { sourceType: "ad", ctwaClid: `ctwa-${randomUUID()}` }),
        "ausente",
      ),
    ).toBe(401);
    expect(
      await enviarWebhook(
        request,
        mensagemWaha(phone, wrongId, { sourceType: "ad", ctwaClid: `ctwa-${randomUUID()}` }),
        "errada",
      ),
    ).toBe(401);
    expect(await mensagens(unsignedId)).toHaveLength(0);
    expect(await mensagens(wrongId)).toHaveLength(0);
    expect(capturas).toHaveLength(before);
  });

  for (const invalid of [
    { name: "só ID do anúncio", ad: { sourceType: "ad", sourceId: `ad-${randomUUID()}` } },
    { name: "post orgânico", ad: { sourceType: "post", ctwaClid: `ctwa-${randomUUID()}` } },
    {
      name: "prova em campos do cliente",
      ad: undefined,
      extra: {
        metadata: {
          meta_ctwa_message_v1: { platform: "meta_ads", source_type: "ad", ctwa_clid: "forjado" },
        },
        source_metadata: { meta_capi_lead_birth_v1: { ctwa_clid: "forjado" } },
      },
    },
  ]) {
    test(`${invalid.name} não cria conversão`, async ({ request }) => {
      const before = capturas.length;
      const { message, lead } = await nascer(request, invalid.ad, invalid.extra);
      expect(message.metadata).not.toHaveProperty("meta_ctwa_message_v1");
      expect(lead.source_metadata).not.toHaveProperty("meta_capi_lead_birth_v1");
      expect(await cliquesDaMensagem(message.id)).toHaveLength(0);
      expect(await ledger(lead.id)).toHaveLength(0);
      expect(capturas).toHaveLength(before);
    });
  }

  test("ctwaClid sem sourceType: extrator atual aceita e reporta (limitação conhecida)", async ({
    request,
  }) => {
    // Não transforma esta observação em uma regra nova: o extrator só rejeita
    // sourceType explícito diferente de ad. Decisão de endurecer fica fora da spec.
    const click = `ctwa-${randomUUID()}`;
    const { lead, message } = await nascer(request, { ctwaClid: click });
    expect(lead.source_metadata.meta_capi_lead_birth_v1).toMatchObject({
      ctwa_clid: click,
      source_type: "ad",
    });
    const [clique] = await cliquesDaMensagem(message.id);
    expect(clique?.ctwa_clid).toBe(click);
    expect(posts(clique!.event_id)).toHaveLength(1);
    expect(clique?.status).toBe("sent");
  });
});
