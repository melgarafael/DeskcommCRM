/**
 * O ANÚNCIO QUE TROUXE A PESSOA — provado pela tela, como quem atende lê a conversa.
 *
 * ## O pedido
 *
 * De uma operação real: "quando um cliente vem de um anúncio, que esse anúncio
 * apareça na conversa e ao lado, para saber por qual anúncio da Meta ele veio".
 * O contato já guardava o anúncio de primeiro toque (`source_metadata.ad_*`),
 * que só a ficha do contato mostrava; a mensagem nascida do clique passa a
 * guardar o SEU (`metadata.anuncio`).
 *
 * ## O que esta spec mede que o teste de componente não mede
 *
 * - que `metadata.anuncio` sobrevive à rota de mensagens até a bolha certa;
 * - que o `crm-summary` devolve o anúncio de origem e o mais recente ao painel;
 * - que a imagem CARREGA (`naturalWidth > 0`), e não só que o `<img>` existe;
 * - que os cartões cabem na coluna do painel (`boundingBox`).
 *
 * A miniatura da Meta é https e externa; a spec a serve por `page.route`, para
 * provar o carregamento sem depender da rede.
 *
 * Pré-requisitos (banco local, app buildada):
 *   pnpm exec tsx scripts/seed-e2e-credentials.ts
 *   pnpm e2e:env && pnpm e2e:build
 *   E2E_PORT=3021 pnpm exec playwright test tests/e2e/inbox-anuncio-de-origem.spec.ts
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { expect, test, type Page } from "./helpers/test";
import { createClient } from "@supabase/supabase-js";

import { carregarEnvLocal } from "../../scripts/lib/env-de-teste";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const EVIDENCIA = path.join(process.cwd(), "evidence/inbox-anuncio-de-origem");

interface Creds {
  password: string;
  org_id: string;
  users: Record<string, { id: string; email: string; role: string }>;
}

const env = carregarEnvLocal();
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const PREFIXO = "Anuncio de Origem E2E";
const NOME_DO_CONTATO = `${PREFIXO} ${Date.now()}`;
const MINIATURA_A = "https://scontent.e2e-anuncio.test/lavadora.svg";
const MINIATURA_B = "https://scontent.e2e-anuncio.test/protetor.svg";
const ANUNCIO_A = {
  titulo: "FRETE GRÁTIS",
  texto: "Lavadora de alta pressão: lave o carro com a sua mangueira. Pague na entrega.",
  ad_id: "120200000000000001",
  url: "https://fb.me/lavadora-e2e",
  miniatura: MINIATURA_A,
};
const ANUNCIO_B = {
  titulo: "ENTREGA RÁPIDA",
  texto: "Protetor solar para carro: proteja o painel do sol.",
  ad_id: "120200000000000002",
  url: "https://fb.me/protetor-e2e",
  miniatura: MINIATURA_B,
};
const PRIMEIRA = "Oi, qual é o preço?";
const SEGUNDA = "E o protetor, quanto custa?";

let creds: Creds;
let conversaId = "";

const svg = (cor: string, rotulo: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect width="120" height="120" fill="${cor}"/>` +
  `<text x="60" y="68" font-size="22" text-anchor="middle" fill="#fff" font-family="sans-serif">${rotulo}</text></svg>`;

async function servirMiniaturas(page: Page): Promise<void> {
  await page.route("https://scontent.e2e-anuncio.test/**", (rota) =>
    rota.fulfill({
      contentType: "image/svg+xml",
      body: rota.request().url().includes("protetor") ? svg("#c2410c", "PROTETOR") : svg("#1d4ed8", "LAVADORA"),
    }),
  );
}

async function login(page: Page, email: string, senha: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(senha);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app/, { timeout: 60_000 });
}

async function limpar(): Promise<void> {
  const { data } = await admin
    .from("contacts")
    .select("id")
    .eq("organization_id", creds.org_id)
    .like("display_name", `${PREFIXO}%`);
  const ids = ((data as Array<{ id: string }> | null) ?? []).map((c) => c.id);
  if (ids.length === 0) return;
  await admin.from("messages").delete().in("contact_id", ids);
  await admin.from("conversations").delete().in("contact_id", ids);
  await admin.from("contacts").delete().in("id", ids);
}

test.describe("Inbox — o anúncio que trouxe a pessoa aparece na conversa e no painel", () => {
  test.describe.configure({ timeout: 180_000 });

  test.beforeAll(async () => {
    if (!fs.existsSync(CREDS_PATH)) {
      execFileSync("npx", ["tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
    }
    creds = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
    await limpar();

    const { data: sessaoExistente } = await admin
      .from("channel_sessions")
      .select("id")
      .eq("organization_id", creds.org_id)
      .limit(1)
      .maybeSingle();
    let sessaoId = (sessaoExistente as { id: string } | null)?.id ?? null;
    if (!sessaoId) {
      const { data, error } = await admin
        .from("channel_sessions")
        .insert({
          organization_id: creds.org_id,
          waha_session_name: `e2e-anuncio-de-origem-${Date.now()}`,
          webhook_secret_encrypted: "e2e",
        })
        .select("id")
        .single();
      if (error) throw new Error(`channel_sessions: ${error.message}`);
      sessaoId = (data as { id: string }).id;
    }

    const t0 = Date.now() - 60_000;
    // O contato como `estamparAtribuicaoDoContato` o carimba no primeiro clique.
    const { data: contato, error: erroContato } = await admin
      .from("contacts")
      .insert({
        organization_id: creds.org_id,
        display_name: NOME_DO_CONTATO,
        phone_number: `+55119${String(Date.now()).slice(-8)}`,
        source: "meta_ads",
        source_metadata: {
          ad_platform: "meta_ads",
          ad_source_id: "clique-e2e",
          ad_id: ANUNCIO_A.ad_id,
          ad_title: ANUNCIO_A.titulo,
          ad_body: ANUNCIO_A.texto,
          ad_source_url: ANUNCIO_A.url,
          ad_thumbnail_url: MINIATURA_A,
          ad_raw: { source_type: "ad" },
          ad_captured_at: new Date(t0).toISOString(),
        },
      })
      .select("id")
      .single();
    if (erroContato) throw new Error(`contacts: ${erroContato.message}`);
    const contatoId = (contato as { id: string }).id;

    const { data: conversa, error: erroConversa } = await admin
      .from("conversations")
      .insert({
        organization_id: creds.org_id,
        contact_id: contatoId,
        channel_session_id: sessaoId,
        status: "open",
        last_message_at: new Date(t0 + 2000).toISOString(),
        last_inbound_at: new Date(t0 + 2000).toISOString(),
      })
      .select("id")
      .single();
    if (erroConversa) throw new Error(`conversations: ${erroConversa.message}`);
    conversaId = (conversa as { id: string }).id;

    const base = {
      organization_id: creds.org_id,
      conversation_id: conversaId,
      channel_session_id: sessaoId,
      contact_id: contatoId,
      direction: "inbound",
      status: "received",
      sent_via: "external_device",
      type: "text",
    };
    const linhas = [
      { ...base, body: PRIMEIRA, metadata: { anuncio: ANUNCIO_A }, sent_at: new Date(t0).toISOString(), created_at: new Date(t0).toISOString() },
      // Voltou dias depois por OUTRO anúncio: é o que o painel chama de mais recente.
      { ...base, body: SEGUNDA, metadata: { anuncio: ANUNCIO_B }, sent_at: new Date(t0 + 2000).toISOString(), created_at: new Date(t0 + 2000).toISOString() },
    ];
    for (const linha of linhas) {
      const { error } = await admin.from("messages").insert(linha);
      if (error) throw new Error(`messages (${linha.body}): ${error.message}`);
    }
  });

  test.afterAll(async () => {
    await limpar();
  });

  test("a bolha do clique mostra o anúncio, e o painel diz o de origem e o mais recente", async ({ page }) => {
    await servirMiniaturas(page);
    await login(page, creds.users.agent!.email, creds.password);
    await page.goto(`/app/inbox/${conversaId}`);
    await expect(page.getByText(PRIMEIRA, { exact: true })).toBeVisible({ timeout: 60_000 });

    // Na bolha: o cartão do anúncio daquela mensagem, acima do texto do cliente.
    const bolha = (texto: string) => page.getByTestId("message-bubble").filter({ hasText: texto });
    const cartaoA = bolha(PRIMEIRA).getByTestId("anuncio-card");
    await expect(cartaoA).toContainText(ANUNCIO_A.titulo);
    await expect(cartaoA.getByRole("link", { name: /Ver an[uú]ncio/ })).toHaveAttribute("href", ANUNCIO_A.url);
    await expect
      .poll(() => cartaoA.locator("img").evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0))
      .toBe(true);
    await expect(bolha(SEGUNDA).getByTestId("anuncio-card")).toContainText(ANUNCIO_B.titulo);

    // No painel: o de origem (primeiro toque) e o mais recente, que é outro.
    const painel = page.getByTestId("inbox-anuncio");
    await expect(painel).toContainText(/Anúncio de origem|Anuncio de origen/);
    const cartoes = painel.getByTestId("anuncio-card");
    await expect(cartoes).toHaveCount(2);
    await expect(cartoes.nth(0)).toContainText(ANUNCIO_A.texto);
    await expect(painel).toContainText(/Voltou por outro anúncio|Volvió por otro anuncio/);
    await expect(cartoes.nth(1)).toContainText(ANUNCIO_B.texto);

    // O cartão cabe na coluna do painel: nada sai pela lateral (medido).
    const caixaDoPainel = await painel.boundingBox();
    for (const c of await cartoes.all()) {
      const caixa = await c.boundingBox();
      expect(caixa && caixaDoPainel && caixa.x + caixa.width <= caixaDoPainel.x + caixaDoPainel.width + 1).toBeTruthy();
    }

    fs.mkdirSync(EVIDENCIA, { recursive: true });
    await page.screenshot({ path: path.join(EVIDENCIA, "01-anuncio-na-bolha-e-no-painel.png"), animations: "disabled" });
  });
});
