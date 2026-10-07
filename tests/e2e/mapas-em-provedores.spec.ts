/**
 * A CHAVE DE MAPAS, PELA TELA (Agente de IA › Provedores, cartão "Mapas").
 *
 * Pedido de uma loja (28/09/2026): o pino de localização chegava só com
 * coordenadas e o agente não sabia a cidade. Com a chave da Geocoding API, o
 * pino ganha rua e cidade aproximadas. Esta spec dirige o que o admin
 * faz: cola a chave, grava, vê só os 4 últimos caracteres, testa, e remove —
 * e confere no banco que a chave ficou CIFRADA e que nunca voltou ao browser.
 *
 * O "Testar" chama o Google de verdade com uma chave falsa: o que se prova é
 * que a tela explica a recusa em vez de dizer "funcionou" (o caminho feliz,
 * com chave real, é provado na instalação — nenhuma chave vai para o CI).
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { expect, test } from "./helpers/test";
import { generateTotp, msUntilNextTotpWindow } from "./utils/totp";
import { corpoDaLocalizacao } from "../../lib/messaging/localizacao";
import { abreConversa, admin, captura, creds, insere, login, registra } from "./qa-l12-comum";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const CHAVE = `AIzaChaveFalsaDeTesteE2E${`${Date.now()}`.slice(-6)}`;

/** O `admin` da organização de teste tem TOTP; sem ele o login para em /login/mfa. */
async function loginComTotp(page: import("@playwright/test").Page, email: string, senha: string): Promise<void> {
  const segredo = (JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as { admin_totp?: { secret: string } }).admin_totp
    ?.secret;
  if (!segredo) throw new Error("sem admin_totp em .e2e-creds.json");

  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(senha);
  await page.getByRole("button", { name: "Entrar", exact: true }).click({ timeout: 15_000 });
  await page.waitForURL(/\/login\/mfa/, { timeout: 90_000 });

  const digito1 = page.locator('input[aria-label="Dígito 1"]');
  const recusa = page.locator("form").getByRole("alert");
  for (let i = 0; i < 3; i++) {
    if (msUntilNextTotpWindow() < 3_000) await page.waitForTimeout(msUntilNextTotpWindow() + 200);
    await digito1.click({ timeout: 15_000 });
    await page.keyboard.type(generateTotp(segredo), { delay: 40 });
    const desfecho = await Promise.race([
      page.waitForURL(/\/app\//, { timeout: 60_000 }).then(() => "entrou" as const, () => "nada" as const),
      recusa.waitFor({ state: "visible", timeout: 60_000 }).then(() => "recusado" as const, () => "nada" as const),
    ]);
    if (desfecho === "entrou") return;
    registra(`[ambiente] MFA de ${email}: tentativa ${i + 1} = ${desfecho}`);
    await page.waitForTimeout(msUntilNextTotpWindow() + 200);
  }
  throw new Error(`MFA falhou para ${email} (url=${page.url()})`);
}

test.describe("Mapas em Provedores", () => {
  test.describe.configure({ timeout: 300_000 });

  test("grava a chave cifrada, mostra só os 4 últimos, explica a recusa do Google e remove", async ({ page }) => {
    const c = creds();
    await admin.from("map_provider_credentials").delete().eq("organization_id", c.org_id);

    await loginComTotp(page, c.users.admin!.email, c.password);
    await page.goto("/app/ai/providers");
    const cartao = page.getByTestId("cartao-de-mapas");
    await cartao.scrollIntoViewIfNeeded({ timeout: 60_000 });
    await expect(cartao.getByTestId("mapas-estado")).toHaveText("Sem chave", { timeout: 30_000 });
    await expect(cartao.getByTestId("mapas-testar")).toBeDisabled();

    await cartao.getByTestId("mapas-chave").fill(CHAVE);
    await captura(page, "mapas-01-chave-colada");
    await cartao.getByTestId("mapas-salvar").click();
    await expect(cartao.getByTestId("mapas-estado")).toContainText(`Chave gravada ···${CHAVE.slice(-4)}`, {
      timeout: 30_000,
    });

    // No banco: os 4 últimos e a chave CIFRADA; na tela, o campo limpo e a chave em lugar nenhum.
    const { data } = await admin
      .from("map_provider_credentials")
      .select("api_key_last4, api_key_encrypted")
      .eq("organization_id", c.org_id)
      .single();
    const linha = data as { api_key_last4: string; api_key_encrypted: string };
    expect(linha.api_key_last4).toBe(CHAVE.slice(-4));
    expect(String(linha.api_key_encrypted)).not.toContain(CHAVE);
    await expect(cartao.getByTestId("mapas-chave")).toHaveValue("");
    expect(await page.content()).not.toContain(CHAVE);

    // Testar a gravada: o Google recusa a chave falsa, e a tela explica em vez de dizer "funcionou".
    await cartao.getByTestId("mapas-testar").click();
    const resultado = cartao.getByTestId("mapas-resultado");
    await expect(resultado).toBeVisible({ timeout: 30_000 });
    await expect(resultado).not.toContainText("Funcionou");
    registra(`mapas · teste com chave falsa = ${await resultado.innerText()}`);
    await captura(page, "mapas-02-teste-explica-a-recusa");

    await cartao.getByTestId("mapas-remover").click();
    await expect(cartao.getByTestId("mapas-estado")).toHaveText("Sem chave", { timeout: 30_000 });
    const { count } = await admin
      .from("map_provider_credentials")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", c.org_id);
    expect(count).toBe(0);
  });

  /**
   * O OUTRO LADO: o cartão do pino na conversa. O pino é gravado como a ingestão
   * grava quando a organização tem a chave (tipo `location`, `metadata.location`
   * com `aproximado`, corpo de `corpoDaLocalizacao`) — a chamada ao Google em si
   * é provada em `tests/unit/mapas-pino-com-endereco.test.ts`, com rede de mentira.
   * Aqui se prova que o endereço atravessa a rota da conversa e aparece no cartão,
   * marcado "(aprox.)", com o texto inteiro no `title` (o cartão corta com `…`).
   */
  test("o cartão do pino na conversa mostra a rua e a cidade aproximadas", async ({ page }) => {
    const c = creds();
    const PREFIXO = "Pino Aproximado E2E";
    const limpar = async () => {
      const { data } = await admin
        .from("contacts")
        .select("id")
        .eq("organization_id", c.org_id)
        .like("display_name", `${PREFIXO}%`);
      const ids = ((data as Array<{ id: string }> | null) ?? []).map((x) => x.id);
      if (ids.length === 0) return;
      await admin.from("messages").delete().in("contact_id", ids);
      await admin.from("conversations").delete().in("contact_id", ids);
      await admin.from("contacts").delete().in("id", ids);
    };
    await limpar();

    const { data: sessao } = await admin
      .from("channel_sessions")
      .select("id")
      .eq("organization_id", c.org_id)
      .limit(1)
      .maybeSingle();
    const sessaoId =
      (sessao as { id: string } | null)?.id ??
      (await insere("channel_sessions", {
        organization_id: c.org_id,
        waha_session_name: `e2e-pino-aprox-${Date.now()}`,
        webhook_secret_encrypted: "e2e",
      }));
    const contatoId = await insere("contacts", {
      organization_id: c.org_id,
      display_name: `${PREFIXO} ${Date.now()}`,
      phone_number: `+55419${String(Date.now()).slice(-8)}`,
    });
    const agora = new Date().toISOString();
    const conversaId = await insere("conversations", {
      organization_id: c.org_id,
      contact_id: contatoId,
      channel_session_id: sessaoId,
      status: "open",
      last_message_at: agora,
      last_inbound_at: agora,
    });
    const localizacao = {
      latitude: -25.4284,
      longitude: -49.2733,
      aproximado: { rua: "Rua XV de Novembro", cidade: "Curitiba", regiao: "Paraná" },
    };
    await insere("messages", {
      organization_id: c.org_id,
      conversation_id: conversaId,
      channel_session_id: sessaoId,
      contact_id: contatoId,
      direction: "inbound",
      status: "delivered",
      sent_via: "external_device",
      type: "location",
      body: corpoDaLocalizacao(localizacao),
      metadata: { location: localizacao },
      sent_at: agora,
    });

    try {
      await login(page, c.users.agent!.email, c.password);
      await abreConversa(page, conversaId);
      const detalhe = page.getByTestId("pino-detalhe");
      await expect(detalhe).toBeVisible({ timeout: 60_000 });
      const esperado = "Rua XV de Novembro, Curitiba, Paraná (aprox.)";
      await expect(detalhe).toHaveText(esperado);
      await expect(detalhe).toHaveAttribute("title", esperado);
      // O toque abre o ponto no mapa — as coordenadas, não o endereço aproximado.
      const link = page.locator("a", { has: detalhe });
      await expect(link).toHaveAttribute("href", "https://maps.google.com/?q=-25.4284,-49.2733");
      const caixa = await detalhe.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { largura: r.width, altura: r.height, rolagem: el.scrollWidth, cliente: el.clientWidth };
      });
      registra(`mapas · cartão do pino = ${JSON.stringify(caixa)}`);
      expect(caixa.altura).toBeGreaterThan(0);
      await captura(page, "mapas-03-pino-na-conversa");
    } finally {
      await limpar();
    }
  });
});
