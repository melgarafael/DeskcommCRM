/**
 * OPERAÇÃO DO DIA E RELATÓRIO DIÁRIO — PELA TELA, COMO UM LEIGO USARIA.
 *
 * O que a spec prova, pelo navegador, numa organização SINTÉTICA própria
 * (criada e apagada aqui, no fuso de Beirute, sem tocar o seed comum):
 *
 *   1. O administrador chega em Operação do dia pelo hub de Análise (a porta
 *      do catálogo, não só a URL), vê os dois contadores e o "Atualizado às".
 *   2. Uma conversa com a etiqueta `projeto` e mensagem do cliente HOJE aparece
 *      em "Projetos grandes", e o link da linha abre essa conversa no Inbox.
 *   3. "Gerar relatório agora" salva o dia; em Relatórios do dia o dia de hoje
 *      está na lista, e o relatório aberto mostra a mesma linha com o link.
 *   4. Quem só lê (viewer) abre a Operação do dia, mas Relatórios do dia não:
 *      a porta não aparece no hub e a URL leva ao 403. O `agent` idem.
 *
 * O relatório guardado não tem nome de contato (LGPD, migration 9400): o nome
 * que a tela do relatório mostra é lido AO VIVO — a asserção do passo 3 prova
 * exatamente essa leitura.
 *
 * Pré-requisitos (banco local do baseline, app buildada):
 *   pnpm e2e:env && pnpm e2e:build
 *   pnpm exec playwright test tests/e2e/operacao-do-dia.spec.ts
 */
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";

import { createClient } from "@supabase/supabase-js";

import { esperarARevelacao, esperarARevelacaoNasCargas, expect, test, type BrowserContext, type Page } from "./helpers/test";

const ESPERA = 30_000;
const FUSO = "Asia/Beirut";
const EVIDENCIA = process.env.E2E_EVIDENCIA ?? "evidence/2026-11-16-operacao-do-dia";

function ambiente(appUrl: string | undefined) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!appUrl || !url || !serviceRole) throw new Error("Defina o app e o Supabase local (URL e service role) no ambiente.");
  for (const endereco of [appUrl, url]) {
    if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(endereco).hostname)) {
      throw new Error("Esta prova só aceita app e Supabase locais.");
    }
  }
  return { appUrl, url, serviceRole };
}

/** O dia de hoje no fuso da organização — o mesmo que a tela e o relatório usam. */
function hojeNoFuso(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: FUSO, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

async function captura(page: Page, arquivo: string) {
  mkdirSync(EVIDENCIA, { recursive: true });
  await page.screenshot({ path: `${EVIDENCIA}/${arquivo}.png`, fullPage: true });
}

test("o administrador acompanha o dia, salva o relatório e quem só lê não alcança os relatórios", async ({ browser, baseURL }) => {
  test.setTimeout(240_000);
  const amb = ambiente(baseURL);
  const db = createClient(amb.url, amb.serviceRole, { auth: { persistSession: false } });
  const prefixo = randomUUID().slice(0, 8);
  const senha = `Operacao-${randomUUID()}!`;
  const nomeDoCliente = `Cliente Projeto ${prefixo}`;
  const usuarios: string[] = [];
  const organizacoes: string[] = [];
  const contextos: BrowserContext[] = [];

  async function inserir(tabela: string, dados: Record<string, unknown>): Promise<string> {
    const { data, error } = await db.from(tabela).insert(dados).select("id").single();
    if (error) throw new Error(`${tabela}: ${error.message}`);
    return data.id as string;
  }

  async function conta(papel: "admin" | "agent" | "viewer", org: string): Promise<Page> {
    const email = `operacao-${papel}-${prefixo}@invariant.test`;
    const { data, error } = await db.auth.admin.createUser({
      email,
      password: senha,
      email_confirm: true,
      user_metadata: { full_name: `${papel} ${prefixo}` },
    });
    if (error || !data.user) throw new Error("Não foi possível criar a conta sintética.");
    usuarios.push(data.user.id);
    const vinculo = await db
      .from("user_organizations")
      .insert({ organization_id: org, user_id: data.user.id, role: papel, accepted_at: new Date().toISOString() });
    if (vinculo.error) throw new Error(vinculo.error.message);
    const contexto = await browser.newContext({ baseURL: amb.appUrl, viewport: { width: 1440, height: 1000 } });
    contexto.on("page", esperarARevelacaoNasCargas);
    contextos.push(contexto);
    const page = await contexto.newPage();
    await page.goto("/login");
    await esperarARevelacao(page);
    await page.locator("#email").fill(email);
    await page.locator("#password").fill(senha);
    await page.getByRole("button", { name: "Entrar", exact: true }).click();
    await page.waitForURL(/\/app/, { timeout: ESPERA });
    await esperarARevelacao(page);
    return page;
  }

  try {
    const org = await inserir("organizations", {
      slug: `operacao-${prefixo}`,
      display_name: `Operação ${prefixo}`,
      legal_name: "Organização sintética",
      timezone: FUSO,
      onboarded_at: new Date().toISOString(),
      interface_settings: { preset: "completa" },
    });
    organizacoes.push(org);

    // Uma conversa de projeto com mensagem do cliente AGORA.
    const canal = await inserir("channel_sessions", {
      organization_id: org,
      waha_session_name: `operacao-${prefixo}`,
      display_name: "Canal sintético",
      status: "WORKING",
      webhook_secret_encrypted: "\\x00",
    });
    const contato = await inserir("contacts", { organization_id: org, display_name: nomeDoCliente, phone_number: "+96170000123" });
    const agora = new Date().toISOString();
    const conversa = await inserir("conversations", {
      organization_id: org,
      contact_id: contato,
      channel_session_id: canal,
      channel: "whatsapp",
      status: "open",
      tags: ["projeto"],
      last_inbound_at: agora,
      last_message_at: agora,
    });
    await inserir("messages", {
      organization_id: org,
      conversation_id: conversa,
      channel_session_id: canal,
      contact_id: contato,
      type: "text",
      direction: "inbound",
      status: "received",
      body: "Quero orçar plantas para um projeto grande",
      sent_at: agora,
    });

    // ── 1. Pelo hub de Análise até a Operação do dia ──
    const admin = await conta("admin", org);
    await admin.goto("/app/analise");
    await esperarARevelacao(admin);
    await admin.getByRole("link", { name: /Operação do dia/ }).first().click();
    await admin.waitForURL(/\/app\/operacao$/, { timeout: ESPERA });
    await expect(admin.getByRole("heading", { name: "Operação do dia", exact: true })).toBeVisible({ timeout: ESPERA });
    await expect(admin.getByTestId("operacao-contador")).toHaveCount(2);
    await expect(admin.getByTestId("operacao-atualizado")).toContainText(/Atualizado às \d{2}:\d{2} \(Asia\/Beirut\)/);
    // A conversa de hoje conta como NOVA e como "com mensagem do cliente".
    await expect(admin.getByTestId("operacao-contador").first()).toContainText("1");

    // ── 2. A conversa de projeto, com o link que abre a conversa ──
    const projetos = admin.getByTestId("operacao-secao-projetos");
    await expect(projetos).toContainText(nomeDoCliente);
    const link = projetos.getByRole("link", { name: "Abrir conversa" });
    await expect(link).toHaveAttribute("href", `/app/inbox?id=${conversa}`);
    await captura(admin, "01-operacao-do-dia");
    await link.click();
    await admin.waitForURL(new RegExp(`/app/inbox\\?id=${conversa}`), { timeout: ESPERA });
    await admin.goBack();
    await admin.waitForURL(/\/app\/operacao$/, { timeout: ESPERA });

    // ── 3. Gerar o relatório e abri-lo em Relatórios do dia ──
    await admin.getByTestId("operacao-gerar").click();
    await expect(admin.getByRole("status")).toContainText("Relatório do dia salvo.", { timeout: ESPERA });
    await admin.getByRole("link", { name: "Relatórios salvos" }).click();
    await admin.waitForURL(/\/app\/operacao\/relatorios$/, { timeout: ESPERA });
    const hoje = hojeNoFuso();
    const lista = admin.getByTestId("relatorios-lista");
    await expect(lista.getByRole("link", { name: hoje })).toBeVisible({ timeout: ESPERA });
    await captura(admin, "02-relatorios-do-dia");
    await lista.getByRole("link", { name: hoje }).click();
    await admin.waitForURL(new RegExp(`/app/operacao/relatorios/${hoje}$`), { timeout: ESPERA });
    const projetosDoRelatorio = admin.getByTestId("operacao-secao-projetos");
    // O nome NÃO está no jsonb guardado: aparecer aqui prova a leitura ao vivo.
    await expect(projetosDoRelatorio).toContainText(nomeDoCliente);
    await expect(projetosDoRelatorio.getByRole("link", { name: "Abrir conversa" })).toHaveAttribute(
      "href",
      `/app/inbox?id=${conversa}`,
    );
    const guardado = await db.from("relatorios_operacao_diarios").select("conteudo").eq("organization_id", org).eq("dia", hoje).single();
    expect(guardado.error).toBeNull();
    expect(JSON.stringify(guardado.data?.conteudo), "o relatório guardado levou o nome do contato").not.toContain(nomeDoCliente);
    await captura(admin, "03-relatorio-de-hoje");

    // ── 4. Quem só lê: vê a operação, não alcança os relatórios ──
    for (const papel of ["viewer", "agent"] as const) {
      const pagina = await conta(papel, org);
      await pagina.goto("/app/analise");
      await esperarARevelacao(pagina);
      await expect(pagina.getByRole("link", { name: /Operação do dia/ }).first()).toBeVisible({ timeout: ESPERA });
      await expect(pagina.getByRole("link", { name: /Relatórios do dia/ }), `${papel} viu a porta dos relatórios`).toHaveCount(0);
      await pagina.goto("/app/operacao/relatorios");
      await pagina.waitForURL(/\/403/, { timeout: ESPERA });
      await pagina.goto(`/app/operacao/relatorios/${hoje}`);
      await pagina.waitForURL(/\/403/, { timeout: ESPERA });
      if (papel === "viewer") await captura(pagina, "04-viewer-sem-relatorios");
    }
  } finally {
    await Promise.all(contextos.map((c) => c.close()));
    for (const org of organizacoes.reverse()) await db.from("organizations").delete().eq("id", org);
    for (const id of usuarios) await db.auth.admin.deleteUser(id);
  }
});
