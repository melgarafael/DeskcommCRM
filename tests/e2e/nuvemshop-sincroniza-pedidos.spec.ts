/**
 * NUVEMSHOP SINCRONIZA PEDIDOS — a jornada de quem conectou a loja (DoD 12, P1).
 *
 * Prova pela tela, com um receptor HTTP que IMITA a API da Nuvemshop (o app fala
 * com ele por `NUVEMSHOP_API_BASE_URL`, porta 3995 — ver `scripts/gerar-env-e2e.sh`):
 *
 * 1. "Sincronizar agora" inicia o run e a tela avisa ("Sincronização iniciada.").
 * 2. O dreno do `event_log` (o MESMO endpoint do cron) percorre as janelas até o
 *    estado voltar a `idle`; a integração passa a dizer "Em dia" e conta 2 pedidos.
 * 3. O que chegou ao receptor é o que o produto promete: token no cabeçalho
 *    `Authentication: bearer`, janela de `updated_at`, `status=any`, paginação.
 * 4. O painel do contato na inbox mostra o pedido ligado a ele (#1001, R$ 150,90).
 * 5. Cliente sem contato vira contato novo com `source = 'nuvemshop'`.
 * 6. Com um run em andamento, o botão responde "Já está sincronizando.".
 *
 * Não prova OAuth nem webhook real: as credenciais do ambiente são de mentira e
 * a integração é semeada já `healthy`. Estado compartilhado: a organização desta
 * spec é PRÓPRIA e apagada no fim (cascata), nada vaza para as vizinhas.
 */
import { randomUUID } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { mkdirSync } from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { test, expect, type Page } from "./helpers/test";
import { carregarEnvLocal, credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";

const PORTA_DO_RECEPTOR = 3995;
const LOJA = "e2e-loja";
const TOKEN_DA_LOJA = `tok-${randomUUID()}`;
const TELEFONE_DO_CONTATO = "+5511987654321";
const EMAIL_NOVO = "nova-cliente-e2e@ex.com";
const EVIDENCIA = path.join(process.cwd(), "evidence", "nuvemshop-sync-e1");
const ESPERA = 60_000;

const credentials = credenciaisSupabaseDeTeste();
const db = createClient(credentials.url, credentials.serviceRole, {
  auth: { persistSession: false },
});
const password = `Local-${randomUUID()}!`;
const orgs: string[] = [];
const users: string[] = [];

const ontem = new Date(Date.now() - 24 * 3_600_000).toISOString();
const anteontem = new Date(Date.now() - 48 * 3_600_000).toISOString();

const PEDIDO_A = {
  id: 990001,
  number: 1001,
  status: "open",
  payment_status: "paid",
  shipping_status: "unpacked",
  total: "150.90",
  currency: "BRL",
  contact_name: "Maria Pedido",
  contact_phone: TELEFONE_DO_CONTATO,
  created_at: anteontem,
  updated_at: ontem,
  products: [],
};
const PEDIDO_B = {
  id: 990002,
  number: 1002,
  status: "open",
  payment_status: "pending",
  shipping_status: "unpacked",
  total: "80.00",
  currency: "BRL",
  contact_name: "Nova Cliente",
  contact_email: EMAIL_NOVO,
  created_at: anteontem,
  updated_at: ontem,
  products: [],
};

interface RequisicaoVista {
  caminho: string;
  consulta: URLSearchParams;
  cabecalhos: IncomingHttpHeaders;
}
const vistas: RequisicaoVista[] = [];
let receptor: Server | null = null;

function responder(res: import("node:http").ServerResponse, status: number, corpo: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(corpo));
}

/** A API da Nuvemshop: 404 "Last page is N" para página/janela sem itens. */
function subirReceptor(): Promise<Server> {
  return new Promise((resolve, reject) => {
    const s = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORTA_DO_RECEPTOR}`);
      vistas.push({ caminho: url.pathname, consulta: url.searchParams, cabecalhos: req.headers });
      const lista = url.pathname.match(new RegExp(`^/v1/${LOJA}/orders$`));
      const unico = url.pathname.match(new RegExp(`^/v1/${LOJA}/orders/(\\d+)$`));
      if (req.headers.authentication !== `bearer ${TOKEN_DA_LOJA}`) {
        return responder(res, 401, { description: "Invalid access token" });
      }
      if (unico) {
        const achado = [PEDIDO_A, PEDIDO_B].find((p) => String(p.id) === unico[1]);
        return achado ? responder(res, 200, achado) : responder(res, 404, { description: "Not Found" });
      }
      if (lista) {
        const min = Date.parse(url.searchParams.get("updated_at_min") ?? "");
        const max = Date.parse(url.searchParams.get("updated_at_max") ?? "");
        const pagina = Number(url.searchParams.get("page") ?? "1");
        const dentro = [PEDIDO_A, PEDIDO_B].filter((p) => {
          const t = Date.parse(p.updated_at);
          return t >= min && t <= max;
        });
        if (pagina >= 2 || dentro.length === 0) {
          return responder(res, 404, { description: "Last page is 1" });
        }
        return responder(res, 200, dentro);
      }
      return responder(res, 404, { description: "Not Found" });
    });
    s.once("error", reject);
    s.listen(PORTA_DO_RECEPTOR, "127.0.0.1", () => resolve(s));
  });
}

async function insert(table: string, value: Record<string, unknown>) {
  const { data, error } = await db.from(table).insert(value).select("id").single();
  if (error) throw error;
  return data.id as string;
}

async function cifrar(plaintext: string): Promise<string> {
  const { data, error } = await db.rpc("fn_encrypt_oauth", { plaintext });
  if (error) throw error;
  return data as string;
}

async function fixture() {
  const email = `ns-${randomUUID()}@invariant.test`;
  const { data, error } = await db.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw error;
  const user = data.user.id;
  users.push(user);
  const org = await insert("organizations", {
    slug: `ns-${randomUUID()}`,
    display_name: "Loja Nuvemshop",
    legal_name: "Loja Nuvemshop",
    onboarded_at: new Date().toISOString(),
  });
  orgs.push(org);
  await insert("user_organizations", {
    organization_id: org,
    user_id: user,
    role: "admin",
    accepted_at: new Date().toISOString(),
  });
  const session = await insert("channel_sessions", {
    organization_id: org,
    waha_session_name: randomUUID(),
    display_name: "Atendimento local",
    status: "WORKING",
    webhook_secret_encrypted: "\\x00",
    metadata: { ai_gate: "allowlist" },
  });
  const contact = await insert("contacts", {
    organization_id: org,
    name: "Maria Pedido",
    display_name: "Maria Pedido",
    phone_number: TELEFONE_DO_CONTATO,
  });
  const conversation = await insert("conversations", {
    organization_id: org,
    contact_id: contact,
    channel_session_id: session,
    status: "open",
  });
  await insert("tenant_integrations", {
    organization_id: org,
    provider: "nuvemshop",
    status: "healthy",
    store_metadata: { store_id: LOJA },
    oauth_access_token_encrypted: await cifrar(TOKEN_DA_LOJA),
    webhook_secret_encrypted: await cifrar(randomUUID()),
  });
  return { org, email, contact, conversation };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function login(page: Page, f: Fixture) {
  await page.goto("/login");
  await page.getByLabel(/e-?mail/i).fill(f.email);
  await page.getByLabel(/senha/i).fill(password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app(?:\/|$)/, { timeout: ESPERA });
}

async function estadoDoSync(org: string) {
  const { data, error } = await db
    .from("integration_sync_state")
    .select("status, cursor_updated_at, pedidos_gravados")
    .eq("organization_id", org)
    .eq("provider", "nuvemshop")
    .eq("resource", "orders")
    .maybeSingle();
  if (error) throw error;
  return data as { status: string; cursor_updated_at: string | null; pedidos_gravados: number } | null;
}

async function captura(page: Page, nome: string) {
  mkdirSync(EVIDENCIA, { recursive: true });
  await page.screenshot({ path: path.join(EVIDENCIA, nome), fullPage: true });
}

test.use({ trace: "on", viewport: { width: 1440, height: 1000 } });
test.describe.configure({ timeout: 240_000 });

test.beforeAll(async () => {
  receptor = await subirReceptor();
});

test.afterAll(async () => {
  await new Promise<void>((ok) => (receptor ? receptor.close(() => ok()) : ok()));
  for (const org of orgs) {
    const r = await db.from("organizations").delete().eq("id", org);
    if (r.error) throw r.error;
  }
  for (const user of users) {
    const r = await db.auth.admin.deleteUser(user);
    if (r.error) throw r.error;
  }
});

test("conectar a loja: sincronizar agora traz os pedidos para a integração e para o contato", async ({
  page,
}) => {
  const f = await fixture();
  const segredo = carregarEnvLocal().INTERNAL_SECRET?.trim();
  expect(segredo, "INTERNAL_SECRET precisa estar no ambiente do e2e").toBeTruthy();

  await login(page, f);
  await page.goto("/app/integrations/nuvemshop");
  await expect(page.getByText("Conectado", { exact: true })).toBeVisible({ timeout: ESPERA });
  const botao = page.getByRole("button", { name: "Sincronizar agora" });
  await expect(botao).toBeVisible();
  await expect(page.getByTestId("nuvemshop-pedidos-total")).toContainText("0");

  // O botão cabe na tela e tem área clicável de verdade (medido, não suposto).
  const caixa = await botao.boundingBox();
  expect(caixa && caixa.width > 40 && caixa.height > 20).toBe(true);

  // ── 1. Sincronizar agora ─────────────────────────────────────────────────
  await botao.click();
  await expect(page.getByText("Sincronização iniciada.")).toBeVisible({ timeout: ESPERA });
  await expect
    .poll(async () => (await estadoDoSync(f.org))?.status, { timeout: 15_000 })
    .toBe("running");

  // ── 2. O dreno do cron, chamado à mão, até o run fechar ──────────────────
  await expect
    .poll(
      async () => {
        const dreno = await page.request.post("/api/v1/cron/event-log-drain", {
          headers: { authorization: `Bearer ${segredo}` },
        });
        expect(dreno.status(), "o dreno tem de responder 200").toBe(200);
        const e = await estadoDoSync(f.org);
        return e?.status === "idle" && e.cursor_updated_at ? "idle" : (e?.status ?? "sem-estado");
      },
      { timeout: ESPERA, intervals: [500, 1_000, 1_000] },
    )
    .toBe("idle");

  // ── 3. O que o receptor viu ──────────────────────────────────────────────
  const listagens = vistas.filter((v) => v.caminho === `/v1/${LOJA}/orders`);
  expect(listagens.length, "o produto tem de percorrer as janelas de 12 meses").toBeGreaterThanOrEqual(12);
  for (const l of listagens) {
    expect(l.cabecalhos.authentication).toBe(`bearer ${TOKEN_DA_LOJA}`);
    expect(l.consulta.get("status")).toBe("any");
    expect(Date.parse(l.consulta.get("updated_at_min") ?? "")).toBeLessThanOrEqual(
      Date.parse(l.consulta.get("updated_at_max") ?? ""),
    );
  }

  // ── 4. A integração diz a verdade ────────────────────────────────────────
  await page.reload();
  await expect(page.getByTestId("nuvemshop-pedidos-total")).toContainText("2", { timeout: ESPERA });
  await expect(page.getByTestId("nuvemshop-pedidos-situacao")).toContainText("Em dia");
  await captura(page, "01-integracao-em-dia.png");

  // ── 5. O painel do contato mostra o pedido ───────────────────────────────
  await page.goto(`/app/inbox/${f.conversation}`);
  const painel = page.locator("section", { has: page.getByRole("heading", { name: "Pedidos recentes" }) });
  await expect(painel.getByText("#1001")).toBeVisible({ timeout: ESPERA });
  await expect(painel).toContainText(/R\$\s150,90/);
  await captura(page, "02-painel-do-contato.png");

  // ── 6. Cliente novo virou contato da Nuvemshop ───────────────────────────
  const novo = await db
    .from("contacts")
    .select("id, source")
    .eq("organization_id", f.org)
    .eq("email", EMAIL_NOVO)
    .maybeSingle();
  expect(novo.error).toBeNull();
  expect(novo.data?.source).toBe("nuvemshop");

  // ── 7. Com um run em andamento, o botão recusa com a frase certa ─────────
  const trava = await db
    .from("integration_sync_state")
    .update({ status: "running", run_id: randomUUID(), trava_ate: new Date(Date.now() + 600_000).toISOString() })
    .eq("organization_id", f.org)
    .eq("provider", "nuvemshop")
    .eq("resource", "orders");
  expect(trava.error).toBeNull();
  await page.goto("/app/integrations/nuvemshop");
  await page.getByRole("button", { name: "Sincronizar agora" }).click();
  await expect(page.getByText("Já está sincronizando.")).toBeVisible({ timeout: ESPERA });
  await captura(page, "03-ja-sincronizando.png");
});
