/**
 * A PRIMEIRA COBRANÇA CONTRA A STRIPE DE VERDADE (modo teste) — fora do CI.
 *
 * O CI prova a jornada contra o dublê (`cobranca-revendedor`). Esta prova que a
 * Stripe real ainda responde o contrato da versão fixada: checkout hospedado,
 * avisos entregues pela própria Stripe numa URL https pública, `current_period_end`
 * no item (§6.1 passo 4), fatura hospedada, portal e cancelamento no fim.
 * A chave de produção é recusada ao carregar o arquivo; sem chave, pula.
 * A chave vai pela API da tela, nunca por `fill`, e o trace fica desligado.
 *
 * Como rodar:
 *   1. cloudflared tunnel --url http://localhost:3001   (anote a https://….trycloudflare.com)
 *   2. no .env.e2e: NEXT_PUBLIC_APP_URL=<essa URL> e COBRANCA_API_BASE_URL_TESTE= (vazio)
 *   3. pnpm e2e:build
 *   4. STRIPE_TEST_SECRET_KEY="${STRIPE_TEST_SECRET_KEY:-$(cat ~/.config/deskcomm/stripe-teste.key)}" pnpm exec playwright test tests/e2e/cobranca-stripe-teste.spec.ts
 *   5. pnpm e2e:env && pnpm e2e:build   (a suíte volta ao dublê)
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";

import { STRIPE_API_BASE, STRIPE_VERSION } from "@/lib/cobranca/provedores/stripe";

import { test, expect, type BrowserContext } from "./helpers/test";
import { lerChaveStripeDeTeste } from "./helpers/chave-stripe-de-teste";
import {
  assinaturaDe, criarPessoa, db, drenarAte, entrar, estadoDaOrg, fotografarChaves, inserir, restaurarChaves, type FotoDasChaves,
} from "./helpers/cobranca";

const LEITURA = lerChaveStripeDeTeste(process.env.STRIPE_TEST_SECRET_KEY);
const CHAVE = LEITURA.tipo === "teste" ? LEITURA.chave : "";
const APP = process.env.NEXT_PUBLIC_APP_URL ?? "";
const sufixo = randomUUID().slice(0, 8);
const EVIDENCIA = "evidence/cobranca-revendedor";

test.use({ trace: "off", baseURL: APP });

function doEnvE2e(nome: string): string {
  const linha = readFileSync(".env.e2e", "utf8").split("\n").find((l) => l.startsWith(`${nome}=`));
  return (linha ?? `${nome}=`).slice(nome.length + 1).trim();
}

/**
 * Chamada crua, com a MESMA Stripe-Version do adaptador (sem ela, a Stripe
 * responderia na versão da conta, e a prova "contra a versão fixada" ficaria
 * parte em outra versão). O erro leva o `code`, nunca o `message`: ele ecoa
 * pedaço da chave, e este erro vai para o log do Playwright.
 */
async function stripe<T>(metodo: "GET" | "POST" | "DELETE", caminho: string, corpo?: Record<string, string>): Promise<T> {
  const r = await fetch(`${STRIPE_API_BASE}${caminho}`, {
    method: metodo,
    headers: {
      authorization: `Bearer ${CHAVE}`,
      "stripe-version": STRIPE_VERSION,
      ...(corpo ? { "content-type": "application/x-www-form-urlencoded" } : {}),
    },
    body: corpo ? new URLSearchParams(corpo).toString() : undefined,
  });
  const json = (await r.json()) as T & { error?: { code?: string } };
  if (!r.ok) throw new Error(`Stripe ${metodo} ${caminho.split("?")[0]} → ${r.status} ${json.error?.code ?? ""}`);
  return json;
}

test.describe("cobrança — contra a Stripe de verdade, em modo teste", () => {
  test.describe.configure({ timeout: 480_000 });
  test.skip(LEITURA.tipo === "ausente", "exige STRIPE_TEST_SECRET_KEY (chave de TESTE da Stripe) no ambiente");

  test.beforeAll(() => {
    // Falha alto em vez de pular: com a chave em mãos e o servidor no dublê, um verde provaria o dublê.
    if (doEnvE2e("COBRANCA_API_BASE_URL_TESTE") !== "") throw new Error("O .env.e2e aponta a cobrança para o dublê: esvazie COBRANCA_API_BASE_URL_TESTE e rode pnpm e2e:build.");
    if (!doEnvE2e("NEXT_PUBLIC_APP_URL").startsWith("https://")) throw new Error("NEXT_PUBLIC_APP_URL precisa ser a URL https do túnel: a Stripe só entrega aviso em https.");
  });

  test("o dono conecta; o cliente assina, atrasa, paga, abre o portal e cancela no fim", async ({ page, browser, request }) => {
    mkdirSync(EVIDENCIA, { recursive: true });
    const foto: FotoDasChaves = await fotografarChaves();
    const pessoas: string[] = [];
    const orgs: string[] = [];
    const contextos: BrowserContext[] = [];
    let cliente: string | null = null;
    let emailB: string | null = null;
    let endpointId: string | null = null;
    let planoId: string | null = null;
    let falha: unknown;
    try {
      const dono = await criarPessoa("stripe-dono", sufixo);
      const adminB = await criarPessoa("stripe-admin-b", sufixo);
      emailB = adminB.email;
      pessoas.push(dono.id, adminB.id);
      const agora = new Date().toISOString();
      const orgDono = await inserir("organizations", { slug: `stripe-dono-${sufixo}`, display_name: `Dono ${sufixo}`, legal_name: "Dono", onboarded_at: agora });
      const orgB = await inserir("organizations", { slug: `stripe-b-${sufixo}`, display_name: `Assinante ${sufixo}`, legal_name: "Assinante", onboarded_at: agora });
      orgs.push(orgDono, orgB);
      const v = await db.from("user_organizations").insert([
        { organization_id: orgDono, user_id: dono.id, role: "admin", accepted_at: agora },
        { organization_id: orgB, user_id: adminB.id, role: "admin", accepted_at: agora },
      ]);
      if (v.error) throw v.error;
      const pa = await db.from("platform_admins").insert({ user_id: dono.id, granted_by: dono.id, scope: "full", mfa_required: false, reason: "E2E Stripe real" });
      if (pa.error) throw pa.error;
      // Ligar pela tela é provado pela spec do dublê.
      const liga = await db.from("platform_config").upsert({ chave: "MODULO_COBRANCA", valor: "ligado", eh_segredo: false, semeado_do_env: false }, { onConflict: "chave" });
      if (liga.error) throw liga.error;

      await entrar(page, dono.email);
      const conexao = await page.request.post("/api/v1/admin/cobranca/conexao", { data: { provedor: "stripe", chave: CHAVE } });
      // O corpo não é impresso: um erro poderia ecoar a chave.
      expect(conexao.status(), "a conexão com a Stripe real falhou").toBe(200);
      expect(((await conexao.json()) as { data: unknown }).data).toEqual({ modo: "teste", webhook: "automatico", publicadas: 0 });
      await page.goto("/admin/cobranca");
      await expect(page.getByText("MODO DE TESTE").first()).toBeVisible();
      // includes + toBe(false): `not.toContain(CHAVE)` imprimiria a chave inteira no log justamente quando falhasse.
      expect((await page.content()).includes(CHAVE), "a chave apareceu na página").toBe(false);
      const endpoints = await stripe<{ data: Array<{ id: string; url: string; enabled_events: string[] }> }>("GET", "/webhook_endpoints?limit=100");
      const nosso = endpoints.data.find((e) => e.url === `${APP}/api/v1/webhooks/cobranca/stripe`);
      if (!nosso) throw new Error("o webhook não foi registrado na conta de teste");
      endpointId = nosso.id;
      expect(nosso.enabled_events).toContain("invoice.paid");
      expect(nosso.enabled_events).not.toContain("invoice.created");

      const plano = await page.request.post("/api/v1/admin/cobranca/planos", { data: { nome: `Stripe real ${sufixo}`, preco_cents: 4990, intervalo: "mes", trial_dias: 3 } });
      expect(plano.ok(), await plano.text()).toBe(true);
      planoId = ((await plano.json()) as { data: { id: string } }).data.id;
      const atribui = await page.request.post(`/api/v1/admin/tenants/${orgB}/assinatura`, { data: { plano_id: planoId } });
      expect(atribui.ok(), await atribui.text()).toBe(true);

      const ctxB = await browser.newContext({ baseURL: APP });
      contextos.push(ctxB);
      const pB = await ctxB.newPage();
      pB.setDefaultTimeout(30_000);
      await entrar(pB, adminB.email);
      await pB.goto("/app/settings/billing");
      await pB.getByRole("button", { name: "Assinar", exact: true }).click();
      await pB.waitForURL(/checkout\.stripe\.com/, { timeout: 60_000 });
      // 0341: a Stripe guarda o cartão (o teste grátis não cobra) e recusa toda cobrança.
      await pB.locator("#cardNumber").fill("4000000000000341");
      await pB.locator("#cardExpiry").fill("12 / 34");
      await pB.locator("#cardCvc").fill("123");
      await pB.locator("#billingName").fill("Assinante de Teste");
      // O Checkout escolhe o país pelo IP de quem abre: de uma VPS nos EUA ele pede
      // CEP americano, e o Link ("Salve minhas informações") vem marcado pedindo
      // telefone. Brasil e Link desmarcado: o formulário que o cliente daqui vê.
      await pB.locator("#billingCountry").selectOption("BR");
      const salvar = pB.getByRole("checkbox", { name: /Salve minhas informações|Save my info/i });
      if (await salvar.isChecked().catch(() => false)) await salvar.uncheck();
      await pB.getByTestId("hosted-payment-submit-button").click();
      await pB.waitForURL(/\/app\/settings\/billing\?voltou=1/, { timeout: 90_000 });
      await expect(pB.getByText(/1ª cobrança agendada/)).toBeVisible({ timeout: 60_000 });
      await pB.screenshot({ path: `${EVIDENCIA}/stripe-real-teste-gratis.png`, fullPage: true });
      const linha = await assinaturaDe(orgB);
      expect(linha).toMatchObject({ estado: "trial", provedor: "stripe", modo: "teste" });
      cliente = linha.provedor_cliente_id;
      const subs = await stripe<{ data: Array<{ id: string; status: string }> }>("GET", `/subscriptions?customer=${cliente}&status=all`);
      expect(subs.data.map((s) => s.status)).toEqual(["trialing"]);
      const assinatura = subs.data[0]!.id;

      // O teste grátis acaba agora; a cobrança do 0341 falha de verdade.
      await stripe("POST", `/subscriptions/${assinatura}`, { trial_end: "now" });
      await drenarAte(request, "em atraso pela Stripe real", async () => {
        const a = await assinaturaDe(orgB);
        return a.estado === "em_atraso" && a.ultimo_aviso === "venceu";
      }, 240_000);
      await pB.goto("/app/ai/inbox");
      const aviso = pB.getByTestId("inbox-item").filter({ hasText: "Não identificamos o pagamento" });
      await expect(aviso.getByRole("link", { name: "Pagar agora" })).toHaveAttribute("href", /^https:\/\/invoice\.stripe\.com\//);

      // Paga com 4242 pela API (a fatura hospedada usa campos em iframe).
      const sub = await stripe<{ latest_invoice: string }>("GET", `/subscriptions/${assinatura}`);
      const cartao = await stripe<{ id: string }>("POST", "/payment_methods/pm_card_visa/attach", { customer: cliente ?? "" });
      await stripe("POST", `/invoices/${sub.latest_invoice}/pay`, { payment_method: cartao.id });
      await drenarAte(request, "ativa pela Stripe real", async () => (await assinaturaDe(orgB)).estado === "ativa", 240_000);
      const venc = await db.from("cobranca_assinaturas").select("proximo_vencimento").eq("organization_id", orgB).single();
      const dias = (new Date(String(venc.data?.proximo_vencimento)).getTime() - Date.now()) / 86_400_000;
      expect(dias).toBeGreaterThan(27); // §6.1 passo 4: o fim do período vem do ITEM, na versão fixada
      expect(dias).toBeLessThan(32);
      await pB.goto("/app/settings/billing");
      await expect(pB.getByText("Em dia", { exact: true })).toBeVisible();
      await pB.screenshot({ path: `${EVIDENCIA}/stripe-real-em-dia.png`, fullPage: true });

      await pB.getByRole("button", { name: "Gerenciar pagamento" }).click();
      await pB.waitForURL(/billing\.stripe\.com/, { timeout: 60_000 });
      await pB.goto("/app/settings/billing");
      await pB.getByRole("button", { name: "Cancelar assinatura" }).click();
      await pB.getByRole("button", { name: "Confirmar cancelamento" }).click();
      await expect(pB.getByText(/Você mantém o acesso até \d{2}\/\d{2}/)).toBeVisible();
      expect((await stripe<{ cancel_at_period_end: boolean }>("GET", `/subscriptions/${assinatura}`)).cancel_at_period_end).toBe(true);
      await drenarAte(request, "cancela no fim", async () => (await assinaturaDe(orgB)).cancela_no_fim, 240_000);
      expect((await estadoDaOrg(orgB)).status).toBe("active");
    } catch (erro) {
      falha = erro;
      throw erro;
    } finally {
      // Primeiro o que vaza para fora desta spec — as chaves da instalação local —, isolado:
      // uma falha de rede na Stripe logo abaixo não pode deixá-las apontando para a conta de teste.
      try {
        await restaurarChaves(foto);
      } catch (e) {
        test.info().annotations.push({ type: "cleanup", description: `chaves não restauradas: ${e instanceof Error ? e.message : String(e)}` });
      }
      for (const [o, f] of [
        ["cliente", async () => {
          if (cliente) return stripe("DELETE", `/customers/${cliente}`);
          // Falhou antes de ler o cliente (ex.: no checkout): ele já pode existir na
          // Stripe. O e-mail do assinante é único por rodada.
          if (!emailB) return null;
          const achados = await stripe<{ data: Array<{ id: string }> }>("GET", `/customers?email=${encodeURIComponent(emailB)}&limit=10`);
          for (const c of achados.data) await stripe("DELETE", `/customers/${c.id}`);
          return null;
        }],
        ["endpoint", () => (endpointId ? stripe("DELETE", `/webhook_endpoints/${endpointId}`) : null)],
      ] as const) {
        try {
          await f();
        } catch (e) {
          test.info().annotations.push({ type: "cleanup", description: `${o} na Stripe não apagado: ${e instanceof Error ? e.message : String(e)}` });
        }
      }
      try {
        await Promise.allSettled(contextos.map((c) => c.close()));
        // A trava da Task 33A lê a última releitura gravada, não a Stripe: apague a linha antes da empresa.
        const assinaturas = await db.from("cobranca_assinaturas").delete().in("organization_id", orgs);
        if (assinaturas.error) throw assinaturas.error;
        for (const org of orgs) {
          const r = await db.from("organizations").delete().eq("id", org);
          if (r.error) throw r.error;
        }
        if (planoId) {
          const r = await db.from("cobranca_planos").delete().eq("id", planoId);
          if (r.error) throw r.error;
        }
        const pa = await db.from("platform_admins").delete().in("user_id", pessoas);
        if (pa.error) throw pa.error;
        for (const id of pessoas) {
          const r = await db.auth.admin.deleteUser(id);
          if (r.error) throw r.error;
        }
      } catch (erroDaLimpeza) {
        test.info().annotations.push({ type: "cleanup", description: "limpeza incompleta na Stripe de teste ou no banco" });
        if (!falha) throw erroDaLimpeza;
      }
    }
  });
});
