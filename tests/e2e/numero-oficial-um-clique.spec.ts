import { createHmac } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";

import type { Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

import { carregarEnvLocal } from "../../scripts/lib/env-de-teste";
import { loginComoAdmin, type CredsE2E } from "./helpers/login-admin";
import { expect, test } from "./helpers/test";

/**
 * O número oficial conectado com UM CLIQUE, pela conta do provedor da instalação.
 *
 * O caminho que a pessoa faz de verdade, pela tela: Conexões › Provedor parceiro
 * › «Conectar meu WhatsApp» → página de cadastro do provedor → volta ao CRM por
 * outro site (o cookie Strict não vem) → a tela conclui → conectado.
 *
 * Os eventos chegam pelo webhook ÚNICO da instalação (um para todas as
 * conexões de um clique, filtrado aos PERFIS delas). Para provar o roteamento,
 * uma SEGUNDA organização já está conectada por um clique antes do caso: a
 * conexão da primeira entra no mesmo webhook (o filtro passa a ter os dois
 * perfis), e a mensagem de cada conta cai na organização DELA. Excluir a
 * primeira desconecta o número dela e deixa o webhook entregando à segunda.
 *
 * O provedor é um dublê HTTP de verdade (porta 3996), que guarda perfis, contas
 * e assinaturas como o provedor guarda. O servidor do CRM precisa nascer com
 * `ZERNIO_API_BASE_URL` apontando para ele e com a chave da instalação
 * (`ZERNIO_PLATFORM_API_KEY`); sem isso a spec se declara pulada.
 */
const PORTA = 3996;
const URL_DO_DUBLE = `http://127.0.0.1:${PORTA}`;
const CHAVE = "sk_e2e_um_clique";
const TEM_DUBLE =
  process.env.ZERNIO_API_BASE_URL === URL_DO_DUBLE && process.env.ZERNIO_PLATFORM_API_KEY === CHAVE;

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const EVIDENCIA =
  process.env.E2E_EVIDENCIA ?? path.join(process.cwd(), "evidence/numero-oficial-um-clique");

const SUFIXO = String(Date.now()).slice(-7);
const PERFIL = "6e2e0000000000000000ab01";
const CONTA = "6e2e0000000000000000cd01";
const TELEFONE = `+55119811${SUFIXO.slice(-5)}`;
// A outra organização, conectada por um clique antes do caso.
const PERFIL_B = "6e2e0000000000000000ab02";
const CONTA_B = "6e2e0000000000000000cd02";
const TELEFONE_B = `+55119813${SUFIXO.slice(-5)}`;
const ENTRADA = "/api/v1/webhooks/canal-da-instalacao";
const CHAVES_DO_WEBHOOK = ["ZERNIO_PLATFORM_WEBHOOK_SECRET", "ZERNIO_PLATFORM_WEBHOOK_ID"];

type Creds = CredsE2E & { org_id: string };

interface Pedido {
  metodo: string;
  caminho: string;
  query: Record<string, string>;
  corpo: Record<string, unknown> | null;
  autorizacao: string | undefined;
}

const pedidos: Pedido[] = [];
const provedor = {
  perfis: [] as { _id: string; name: string }[],
  contas: [] as Record<string, unknown>[],
  webhooks: [] as {
    _id: string;
    url: string;
    secret: string;
    events: string[];
    profileIds: string[];
    accountIds: string[];
    isActive: boolean;
  }[],
};

/** A conta da organização B, no perfil dela. */
const contaB = () => ({
  _id: CONTA_B,
  platform: "whatsapp",
  username: TELEFONE_B,
  displayName: "Loja B",
  isActive: true,
  profileId: { _id: PERFIL_B },
});
let servidor: http.Server | null = null;

function responder(res: http.ServerResponse, status: number, corpo: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(corpo));
}

function dubleDoProvedor(): http.Server {
  return http.createServer((req, res) => {
    let bruto = "";
    req.on("data", (c) => (bruto += c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", URL_DO_DUBLE);
      const metodo = req.method ?? "GET";
      const corpo = bruto ? (JSON.parse(bruto) as Record<string, unknown>) : null;
      pedidos.push({
        metodo,
        caminho: url.pathname,
        query: Object.fromEntries(url.searchParams),
        corpo,
        autorizacao: req.headers.authorization,
      });
      const r = url.pathname;
      if (metodo === "GET" && r === "/v1/profiles")
        return responder(res, 200, { profiles: provedor.perfis });
      if (metodo === "POST" && r === "/v1/profiles") {
        provedor.perfis.push({ _id: PERFIL, name: String(corpo?.name) });
        return responder(res, 201, {
          message: "Profile created successfully",
          profile: { _id: PERFIL },
        });
      }
      if (metodo === "GET" && r === "/v1/connect/whatsapp") {
        const volta = url.searchParams.get("redirect_url") ?? "";
        const perfil = url.searchParams.get("profileId") ?? "";
        return responder(res, 200, {
          authUrl: `${URL_DO_DUBLE}/cadastro?volta=${encodeURIComponent(volta)}&perfil=${perfil}`,
          state: "estado-do-provedor",
        });
      }
      // A página de cadastro hospedada: a pessoa conclui na Meta e o provedor
      // devolve o navegador com a conta acrescentada à URL de volta.
      if (metodo === "GET" && r === "/cadastro") {
        const perfil = url.searchParams.get("perfil") ?? "";
        provedor.contas = [
          ...provedor.contas.filter((c) => c._id !== CONTA),
          {
            _id: CONTA,
            platform: "whatsapp",
            username: TELEFONE,
            displayName: "Loja E2E",
            isActive: true,
            profileId: { _id: perfil },
          },
        ];
        const volta = new URL(url.searchParams.get("volta") ?? "");
        for (const [k, v] of Object.entries({
          connected: "whatsapp",
          profileId: perfil,
          accountId: CONTA,
          username: TELEFONE,
          connect_token: "TOKEN-DE-UMA-VEZ",
        }))
          volta.searchParams.set(k, v);
        res.writeHead(302, { Location: volta.toString() });
        return res.end();
      }
      if (metodo === "GET" && r === "/v1/accounts") {
        const perfil = url.searchParams.get("profileId");
        return responder(res, 200, {
          accounts: provedor.contas.filter((c) => (c.profileId as { _id: string })._id === perfil),
        });
      }
      if (metodo === "GET" && r === "/v1/webhooks/settings")
        return responder(res, 200, { webhooks: provedor.webhooks });
      if (metodo === "POST" && r === "/v1/webhooks/settings") {
        const w = {
          _id: `wh-e2e-${provedor.webhooks.length + 1}`,
          url: String(corpo?.url),
          secret: String(corpo?.secret),
          events: (corpo?.events as string[]) ?? [],
          profileIds: (corpo?.profileIds as string[]) ?? [],
          accountIds: (corpo?.accountIds as string[]) ?? [],
          isActive: true,
        };
        provedor.webhooks.push(w);
        return responder(res, 200, { success: true, webhook: { _id: w._id } });
      }
      if (metodo === "PUT" && r === "/v1/webhooks/settings") {
        const w = provedor.webhooks.find((x) => x._id === corpo?.webhookId);
        if (!w) return responder(res, 404, { error: "Webhook not found" });
        if (Array.isArray(corpo?.profileIds)) w.profileIds = corpo.profileIds as string[];
        if (Array.isArray(corpo?.accountIds)) w.accountIds = corpo.accountIds as string[];
        if (typeof corpo?.isActive === "boolean") w.isActive = corpo.isActive;
        if (typeof corpo?.url === "string") w.url = corpo.url;
        return responder(res, 200, { success: true, webhook: w });
      }
      if (metodo === "DELETE" && r === "/v1/webhooks/settings") {
        const id = url.searchParams.get("webhookId");
        provedor.webhooks = provedor.webhooks.filter((w) => w._id !== id);
        return responder(res, 200, { success: true });
      }
      if (metodo === "DELETE" && r.startsWith("/v1/accounts/")) {
        provedor.contas = provedor.contas.filter((c) => c._id !== r.split("/").pop());
        return responder(res, 200, { message: "Account disconnected successfully" });
      }
      return responder(res, 404, { error: "não dublado" });
    });
  });
}

test.describe("Conexões — número oficial com um clique, pela conta do provedor da instalação", () => {
  test.describe.configure({ mode: "serial", timeout: 180_000 });
  test.skip(
    !TEM_DUBLE,
    "precisa do servidor com ZERNIO_API_BASE_URL e ZERNIO_PLATFORM_API_KEY do dublê",
  );

  const env = carregarEnvLocal();
  const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  let creds: Creds;
  let sessaoId = "";
  let orgB = "";

  test.beforeAll(async () => {
    creds = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
    servidor = dubleDoProvedor();
    await new Promise<void>((ok) => servidor!.listen(PORTA, "127.0.0.1", ok));
    // Uma conexão por chave própria deixada por outra spec recusaria o um clique
    // (de propósito). Banco de teste: arquiva, não apaga.
    await admin
      .from("channel_sessions")
      .update({ archived_at: new Date().toISOString(), status: "STOPPED" })
      .eq("organization_id", creds.org_id)
      .eq("provider", "zernio")
      .is("archived_at", null);
    // O webhook da instalação nasce nesta rodada: um segredo de rodada anterior
    // não estaria no dublê, que começa vazio.
    await admin.from("platform_config").delete().in("chave", CHAVES_DO_WEBHOOK);

    // A organização B, já conectada por um clique (o que a tela gravaria).
    const o = await admin
      .from("organizations")
      .insert({
        slug: `um-clique-b-${SUFIXO}`,
        legal_name: "Loja B",
        display_name: "Loja B",
        onboarded_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    if (o.error) throw o.error;
    orgB = (o.data as { id: string }).id;
    const sB = await admin.from("channel_sessions").insert({
      organization_id: orgB,
      provider: "zernio",
      zernio_account_id: CONTA_B,
      zernio_credencial_da_instalacao: true,
      zernio_profile_id: PERFIL_B,
      webhook_path_token: `um-clique-b-${SUFIXO}`,
      webhook_secret_encrypted: "\\x00",
      phone_number: TELEFONE_B,
      display_name: "Loja B",
      status: "WORKING",
    });
    if (sB.error) throw sB.error;
    provedor.perfis.push({ _id: PERFIL_B, name: `Loja B · ${orgB}` });
    provedor.contas.push(contaB());
  });

  test.afterAll(async () => {
    await new Promise<void>((ok) => (servidor ? servidor.close(() => ok()) : ok()));
    if (orgB) await admin.from("organizations").delete().eq("id", orgB);
    await admin.from("platform_config").delete().in("chave", CHAVES_DO_WEBHOOK);
  });

  /** Um evento de mensagem recebida da conta, assinado com o segredo do webhook. */
  async function entregar(
    page: Page,
    conta: string,
    wamid: string,
    segredo: string,
  ) {
    const evento = JSON.stringify({
      id: `evt_${wamid}`,
      event: "message.received",
      account: { id: conta },
      message: {
        id: `m_${wamid}`,
        conversationId: conta === CONTA ? "6e2e0000000000000000ef01" : "6e2e0000000000000000ef02",
        platform: "whatsapp",
        platformMessageId: wamid,
        direction: "incoming",
        text: "hola, quiero info",
        attachments: [],
        sender: { phoneNumber: `+55119822${SUFIXO.slice(-5)}`, name: "Cliente E2E" },
        sentAt: new Date().toISOString(),
        isRead: false,
      },
    });
    return page.request.post(ENTRADA, {
      data: evento,
      headers: {
        "Content-Type": "application/json",
        "X-Zernio-Signature": createHmac("sha256", segredo).update(evento, "utf8").digest("hex"),
      },
    });
  }

  const mensagensEm = async (org: string, wamid: string) =>
    (
      await admin
        .from("messages")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", org)
        .eq("external_id", wamid)
    ).count;

  test("conecta pela tela, entra no webhook ÚNICO da instalação, e cada mensagem cai na sua organização", async ({
    page,
  }) => {
    fs.mkdirSync(EVIDENCIA, { recursive: true });
    // O dono da organização tem o fator TOTP: a rota de conexão exige a sessão verificada.
    creds = { ...creds, ...(await loginComoAdmin(page, creds)) };
    await page.goto("/app/connections?aba=parceiro");

    const botao = page.getByRole("button", { name: /^Conectar (meu|mi) WhatsApp$/ });
    await expect(botao).toBeVisible({ timeout: 30_000 });
    await expect(page.getByLabel(/Chave de API|Clave de API/)).toHaveCount(0);
    await page.screenshot({
      path: path.join(EVIDENCIA, "01-botao-de-um-clique.png"),
      fullPage: true,
    });

    await page.getByLabel(/Número (novo|nuevo)/).check();
    const origem = new URL(page.url()).origin;
    await botao.click();

    // A volta: dublê → /auth/partner-return/<estado> → ponte → Conexões.
    await page.waitForURL(/\/app\/connections\?aba=parceiro$/, { timeout: 60_000 });
    await expect(page.getByText(/^(Conectado)$/).first()).toBeVisible({ timeout: 30_000 });
    await expect(
      page.getByText(/Configurado automaticamente|Configurado automáticamente/),
    ).toBeVisible();
    await expect(page.getByText(new RegExp(TELEFONE.replace("+", "\\+")))).toBeVisible();
    await page.screenshot({
      path: path.join(EVIDENCIA, "02-conectado-webhook-automatico.png"),
      fullPage: true,
    });

    // O que o provedor recebeu: sempre com a chave da INSTALAÇÃO.
    expect(
      pedidos.every((p) => p.caminho === "/cadastro" || p.autorizacao === `Bearer ${CHAVE}`),
    ).toBe(true);
    const perfil = pedidos.find((p) => p.metodo === "POST" && p.caminho === "/v1/profiles");
    expect(String(perfil?.corpo?.name).endsWith(` · ${creds.org_id}`)).toBe(true);
    const conexao = pedidos.find((p) => p.caminho === "/v1/connect/whatsapp");
    expect(conexao?.query).toMatchObject({
      profileId: PERFIL,
      onboarding: "api",
      signup: "hosted",
    });
    expect(conexao?.query.redirect_url?.startsWith(`${origem}/auth/partner-return/`)).toBe(true);

    // O que o CRM gravou: ponteiro para a chave da instalação, nenhuma cópia dela.
    const { data: linha } = await admin
      .from("channel_sessions")
      .select(
        "id, zernio_account_id, zernio_token_encrypted, zernio_credencial_da_instalacao, zernio_profile_id, zernio_webhook_id, webhook_path_token, phone_number, status",
      )
      .eq("organization_id", creds.org_id)
      .eq("provider", "zernio")
      .is("archived_at", null)
      .single();
    expect(linha).toMatchObject({
      zernio_account_id: CONTA,
      zernio_token_encrypted: null,
      zernio_credencial_da_instalacao: true,
      zernio_profile_id: PERFIL,
      zernio_webhook_id: "wh-e2e-1",
      phone_number: TELEFONE,
      status: "WORKING",
    });
    sessaoId = (linha as { id: string }).id;

    // UMA assinatura para a instalação, na entrada da instalação, filtrada aos
    // PERFIS das duas conexões — nunca à conta, nunca uma por número.
    expect(provedor.webhooks).toHaveLength(1);
    const assinatura = provedor.webhooks[0]!;
    expect(assinatura.url).toBe(`${origem}${ENTRADA}`);
    expect([...assinatura.profileIds].sort()).toEqual([PERFIL, PERFIL_B].sort());
    expect(assinatura.accountIds).toEqual([]);
    expect(assinatura.isActive).toBe(true);
    expect(assinatura.events).toContain("message.received");

    // A mensagem de cada conta cai na organização DELA.
    const wamidA = `wamid.E2E-UM-CLIQUE-A-${SUFIXO}`;
    const wamidB = `wamid.E2E-UM-CLIQUE-B-${SUFIXO}`;
    expect((await entregar(page, CONTA, wamidA, assinatura.secret)).status()).toBe(200);
    expect((await entregar(page, CONTA_B, wamidB, assinatura.secret)).status()).toBe(200);
    await expect.poll(() => mensagensEm(creds.org_id, wamidA), { timeout: 20_000 }).toBe(1);
    await expect.poll(() => mensagensEm(orgB, wamidB), { timeout: 20_000 }).toBe(1);
    expect(await mensagensEm(orgB, wamidA)).toBe(0);
    expect(await mensagensEm(creds.org_id, wamidB)).toBe(0);

    // Conta de ninguém: 200 e nada gravado. Segredo errado: 401.
    const wamidX = `wamid.E2E-UM-CLIQUE-X-${SUFIXO}`;
    const ninguem = await entregar(page, "6e2e0000000000000000cd99", wamidX, assinatura.secret);
    expect(ninguem.status()).toBe(200);
    expect(((await ninguem.json()) as { data: { reason: string } }).data.reason).toBe(
      "conta_desconhecida",
    );
    expect(
      (await entregar(page, CONTA, `${wamidA}-forjada`, "segredo-de-outra-pessoa-123")).status(),
    ).toBe(401);
  });

  test("excluir a conexão desconecta o número e deixa o webhook entregando à outra organização", async ({
    page,
  }) => {
    test.skip(!sessaoId, "depende do caso anterior");
    // O dono da organização tem o fator TOTP: a rota de conexão exige a sessão verificada.
    creds = { ...creds, ...(await loginComoAdmin(page, creds)) };
    const r = await page.request.delete(`/api/v1/channel-sessions/${sessaoId}`);
    expect(r.status()).toBe(200);
    expect(
      pedidos.some((p) => p.metodo === "DELETE" && p.caminho === "/v1/webhooks/settings"),
    ).toBe(false);
    expect(
      pedidos.some((p) => p.metodo === "DELETE" && p.caminho === `/v1/accounts/${CONTA}`),
    ).toBe(true);
    expect(provedor.webhooks).toHaveLength(1);
    expect(provedor.webhooks[0]).toMatchObject({ profileIds: [PERFIL_B], isActive: true });
    expect(provedor.contas.map((c) => c._id)).toEqual([CONTA_B]);

    // A outra organização segue recebendo pelo mesmo webhook.
    const wamidB2 = `wamid.E2E-UM-CLIQUE-B2-${SUFIXO}`;
    expect((await entregar(page, CONTA_B, wamidB2, provedor.webhooks[0]!.secret)).status()).toBe(
      200,
    );
    await expect.poll(() => mensagensEm(orgB, wamidB2), { timeout: 20_000 }).toBe(1);
  });
});
