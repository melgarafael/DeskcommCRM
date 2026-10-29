/**
 * CAMPANHA PELO NÚMERO OFICIAL, COM MODELO APROVADO (#1330, fatia 4; migration 0710).
 *
 * Pela tela, como quem opera faria: escolhe o número oficial, o campo de texto
 * dá lugar aos modelos aprovados daquele número; escolhe o modelo, diz de onde
 * sai cada variável, vê a prévia; conta o público (quem não tem o dado fica de
 * fora, com o motivo); salva, prepara a lista e confere o detalhe.
 *
 * O ENVIO de teste só roda com o servidor apontado para um dublê do provedor
 * intermediado — é ambiente do `next start`, não da spec, e por isso esse caso
 * pula no CI (o resto roda). Para rodá-lo local:
 *
 *   ZERNIO_API_BASE_URL=http://127.0.0.1:3997 ZERNIO_ACCOUNT_ID=ACC-E2E-CAMPANHA \
 *   ZERNIO_API_KEY=sk_e2e pnpm playwright test tests/e2e/campanha-com-modelo-aprovado.spec.ts
 *
 * O dublê recebe o pedido e a spec confere o que chegou: o nome e o idioma do
 * modelo, a lista de valores na ordem do contrato e a imagem do cabeçalho.
 *
 * ENVIO RÁPIDO (migration 0711): o número oficial oferece "Rápido" no ritmo; a
 * confirmação diz em quantos minutos sai; e — com o dublê — UMA rodada do cron
 * manda a lista inteira, cada um com o próprio nome, e conclui a campanha.
 */
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";

import { expect, test, type Page } from "./helpers/test";
import { createClient } from "@supabase/supabase-js";

import { carregarEnvLocal } from "../../scripts/lib/env-de-teste";

const PORTA = 3997;
const URL_DO_DUBLE = `http://127.0.0.1:${PORTA}`;
const CONTA = "ACC-E2E-CAMPANHA";
const TEM_DUBLE = process.env.ZERNIO_API_BASE_URL === URL_DO_DUBLE && process.env.ZERNIO_ACCOUNT_ID === CONTA;

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const EVIDENCIA = process.env.E2E_EVIDENCIA ?? path.join(process.cwd(), "evidence/campanha-com-modelo-aprovado");

interface Creds {
  password: string;
  org_id: string;
  users: Record<string, { email: string }>;
}

const SUFIXO = String(Date.now()).slice(-7);
const ETIQUETA = `e2e-campanha-modelo-${SUFIXO}`;
const ETIQUETA_RAPIDA = `e2e-campanha-rapida-${SUFIXO}`;
const NOMES_DA_RAPIDA = ["Ana", "Bea", "Carla"];
const MODELO = "oferta_e2e_campanha";
const PAUSADO = "pausado_e2e_campanha";
const IMAGEM_SALVA = "https://example.com/e2e/cafeteira.jpg";
const NUMERO_DO_CANAL = `Número oficial E2E ${SUFIXO}`;
const NOME_DA_CAMPANHA = `Campanha com modelo E2E ${SUFIXO}`;
const COMPONENTES = [
  { type: "HEADER", format: "IMAGE" },
  { type: "BODY", text: "Olá {{1}}! A {{2}} sai por R$ 189,90 com frete grátis. Quer que a gente separe uma?" },
  { type: "FOOTER", text: "Loja Exemplo" },
  { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Sim, quero" }, { type: "QUICK_REPLY", text: "Não, obrigado" }] },
];

const recebidos: { metodo: string; caminho: string; corpo: Record<string, unknown> | null }[] = [];
let servidor: http.Server | null = null;

function dubleDoProvedor(): http.Server {
  return http.createServer((req, res) => {
    let bruto = "";
    req.on("data", (c) => (bruto += c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", URL_DO_DUBLE);
      recebidos.push({ metodo: req.method ?? "", caminho: url.pathname, corpo: bruto ? JSON.parse(bruto) : null });
      res.writeHead(201, { "Content-Type": "application/json" });
      // wamid único por envio: `(organization_id, external_id)` é único em messages.
      res.end(
        JSON.stringify({
          success: true,
          data: { messageId: `wamid.E2E${SUFIXO}-${recebidos.length}`, conversationId: "6a3580f68fcd5b3a5b946bf8" },
        }),
      );
    });
  });
}

async function login(page: Page, email: string, senha: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(senha);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app/, { timeout: 60_000 });
}

test.describe("Campanhas — número oficial manda modelo aprovado", () => {
  test.describe.configure({ mode: "serial", timeout: 240_000 });

  const env = carregarEnvLocal();
  const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  let creds: Creds;
  let sessaoId = "";
  let campanhaId = "";
  let campanhaRapidaId = "";

  test.beforeAll(async () => {
    creds = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
    if (TEM_DUBLE) {
      servidor = dubleDoProvedor();
      await new Promise<void>((ok) => servidor!.listen(PORTA, "127.0.0.1", ok));
    }
    const { data: sessao, error: erroSessao } = await admin
      .from("channel_sessions")
      .insert({
        organization_id: creds.org_id,
        provider: "zernio",
        zernio_account_id: CONTA,
        webhook_path_token: `e2e-campanha-modelo-${SUFIXO}`,
        webhook_secret_encrypted: "\\x00",
        display_name: NUMERO_DO_CANAL,
        phone_number: `+551197${SUFIXO}`,
        status: "WORKING",
      })
      .select("id")
      .single();
    if (erroSessao) throw new Error(`sessão oficial: ${erroSessao.message}`);
    sessaoId = (sessao as { id: string }).id;
    // A janela do número cobre o dia inteiro: a spec não pode reprovar por rodar à noite.
    const { error: erroKnobs } = await admin.from("channel_knobs").insert({
      organization_id: creds.org_id,
      channel_session_id: sessaoId,
      window_start_hour: 0,
      window_end_hour: 24,
      allow_sunday: true,
    });
    if (erroKnobs) throw new Error(`janela do número: ${erroKnobs.message}`);

    const { error: erroModelos } = await admin.from("meta_templates").insert([
      {
        organization_id: creds.org_id,
        channel_session_id: sessaoId,
        waba_id: CONTA,
        name: MODELO,
        language: "pt_BR",
        status: "APPROVED",
        category: "MARKETING",
        components: COMPONENTES,
        contract_hash: "",
        parameter_format: "POSITIONAL",
        saved_values: { "header:1": IMAGEM_SALVA },
      },
      {
        organization_id: creds.org_id,
        channel_session_id: sessaoId,
        waba_id: CONTA,
        name: PAUSADO,
        language: "pt_BR",
        status: "PAUSED",
        category: "MARKETING",
        components: [{ type: "BODY", text: "Modelo pausado" }],
        contract_hash: "",
        parameter_format: "POSITIONAL",
        // Inserção em lote: coluna ausente numa linha vira null, e esta é NOT NULL.
        saved_values: {},
      },
    ]);
    if (erroModelos) throw new Error(`modelos: ${erroModelos.message}`);

    const { error: erroContatos } = await admin.from("contacts").insert([
      {
        organization_id: creds.org_id,
        display_name: `Maria José E2E ${SUFIXO}`,
        phone_number: `+55119${SUFIXO}1`,
        tags: [ETIQUETA],
      },
      {
        // Nome que é só telefone: "Olá +55…!" é pior do que não mandar.
        organization_id: creds.org_id,
        display_name: `+55 11 9${SUFIXO}2`,
        phone_number: `+55119${SUFIXO}2`,
        tags: [ETIQUETA],
      },
    ]);
    if (erroContatos) throw new Error(`contatos: ${erroContatos.message}`);

    const { error: erroRapida } = await admin.from("contacts").insert(
      NOMES_DA_RAPIDA.map((nome, i) => ({
        organization_id: creds.org_id,
        display_name: `${nome} E2E ${SUFIXO}`,
        phone_number: `+55118${SUFIXO}${i}`,
        tags: [ETIQUETA_RAPIDA],
      })),
    );
    if (erroRapida) throw new Error(`contatos da rápida: ${erroRapida.message}`);
  });

  test.afterAll(async () => {
    for (const id of [campanhaId, campanhaRapidaId].filter(Boolean)) {
      await admin.from("campaign_recipients").delete().eq("campaign_id", id);
      await admin.from("campaigns").delete().eq("id", id);
    }
    for (const etiqueta of [ETIQUETA, ETIQUETA_RAPIDA]) {
      const { data } = await admin.from("contacts").select("id").contains("tags", [etiqueta]);
      const ids = ((data as Array<{ id: string }> | null) ?? []).map((c) => c.id);
      if (ids.length) {
        await admin.from("messages").delete().in("contact_id", ids);
        await admin.from("conversations").delete().in("contact_id", ids);
        await admin.from("contacts").delete().in("id", ids);
      }
    }
    if (sessaoId) {
      await admin.from("meta_templates").delete().eq("channel_session_id", sessaoId);
      await admin.from("channel_sessions").delete().eq("id", sessaoId);
    }
    await new Promise<void>((ok) => (servidor ? servidor.close(() => ok()) : ok()));
  });

  test("⭐ escolher o modelo, dizer de onde sai cada variável, ver a prévia e salvar", async ({ page }) => {
    fs.mkdirSync(EVIDENCIA, { recursive: true });
    await login(page, creds.users.manager!.email, creds.password);
    await page.goto("/app/campaigns/new");

    await page.locator("#nome").fill(NOME_DA_CAMPANHA);
    await page.locator("#canal").selectOption(sessaoId);

    // Número oficial: o campo de texto livre dá lugar ao seletor de modelos.
    const bloco = page.getByTestId("modelo-da-campanha");
    await expect(bloco).toBeVisible({ timeout: 30_000 });
    await expect(page.getByLabel("Texto da mensagem")).toHaveCount(0);
    const seletor = page.locator("#modelo");
    // O pausado aparece, mas não dá para escolher.
    await expect(seletor.locator(`option[value="${PAUSADO}|pt_BR"]`)).toBeDisabled();
    await seletor.selectOption(`${MODELO}|pt_BR`);

    // A imagem do cabeçalho já vem com o link salvo na aba de modelos.
    const variaveis = page.getByTestId("variaveis-do-modelo");
    await expect(variaveis).toBeVisible();
    await expect(page.getByLabel("Texto fixo: a mídia do cabeçalho")).toHaveValue(IMAGEM_SALVA);
    await expect(page.getByTestId("variaveis-incompletas")).toContainText("{{1}}");

    await page.getByLabel("Origem: {{1}}", { exact: true }).selectOption("contact_first_name");
    await page.getByLabel("Origem: {{2}}", { exact: true }).selectOption("fixed");
    await page.getByLabel("Texto fixo: {{2}}", { exact: true }).fill("Cafeteira Elétrica");
    await expect(page.getByTestId("variaveis-incompletas")).toHaveCount(0);

    const previa = page.getByTestId("previa-modelo");
    await expect(previa).toContainText("Olá [Primeiro nome do contato]! A Cafeteira Elétrica sai por R$ 189,90");
    await expect(previa).toContainText("Sim, quero");
    await expect(previa.locator("img")).toHaveAttribute("src", IMAGEM_SALVA);
    await page.screenshot({ path: path.join(EVIDENCIA, "01-modelo-escolhido-com-previa.png"), fullPage: true });

    // Público pela etiqueta: quem tem nome que é só telefone fica de fora, com o motivo.
    await page.getByLabel("Com alguma destas etiquetas").fill(ETIQUETA);
    await page.getByRole("button", { name: "Ver quantas pessoas" }).click();
    await expect(page.getByText(/1\s*podem receber/)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/Falta um dado que a mensagem usa/)).toBeVisible();
    await page.screenshot({ path: path.join(EVIDENCIA, "02-publico-com-quem-fica-de-fora.png"), fullPage: true });

    await page.getByRole("button", { name: "Salvar rascunho" }).click();
    await page.waitForURL(/\/app\/campaigns\/[0-9a-f-]{36}$/, { timeout: 60_000 });
    campanhaId = page.url().split("/").pop()!;

    const { data: gravada } = await admin
      .from("campaigns")
      .select("message_mode, message_body, provider_template_name, provider_template_language, provider_template_variables")
      .eq("id", campanhaId)
      .single();
    expect(gravada).toMatchObject({
      message_mode: "template",
      message_body: null,
      provider_template_name: MODELO,
      provider_template_language: "pt_BR",
      provider_template_variables: {
        "header:1": { kind: "fixed", value: IMAGEM_SALVA },
        "1": { kind: "contact_first_name" },
        "2": { kind: "fixed", value: "Cafeteira Elétrica" },
      },
    });

    // O detalhe mostra o modelo e a prévia, não um texto vazio.
    const noDetalhe = page.getByTestId("modelo-no-detalhe");
    await expect(noDetalhe).toContainText(MODELO);
    await expect(noDetalhe.getByTestId("previa-modelo")).toContainText("Cafeteira Elétrica");
    await page.screenshot({ path: path.join(EVIDENCIA, "03-detalhe-do-rascunho.png"), fullPage: true });
  });

  test("preparar a lista congela os valores de cada contato", async ({ page }) => {
    await login(page, creds.users.manager!.email, creds.password);
    await page.goto(`/app/campaigns/${campanhaId}`);
    await page.getByRole("button", { name: "Preparar lista" }).click();
    await expect(page.getByRole("button", { name: "Enviar teste" })).toBeVisible({ timeout: 60_000 });

    const { data: destinatarios } = await admin
      .from("campaign_recipients")
      .select("status, exclusion_reason, variables, rendered_body")
      .eq("campaign_id", campanhaId);
    const lista = (destinatarios ?? []) as Array<{
      status: string;
      exclusion_reason: string | null;
      variables: { modelo?: Record<string, string> };
      rendered_body: string | null;
    }>;
    const elegivel = lista.find((d) => d.status === "pending");
    expect(elegivel?.variables.modelo).toEqual({ "header:1": IMAGEM_SALVA, "1": "Maria", "2": "Cafeteira Elétrica" });
    // O texto que fica na conversa — o que o agente lê quando o cliente responde.
    expect(elegivel?.rendered_body).toBe("Olá Maria! A Cafeteira Elétrica sai por R$ 189,90 com frete grátis. Quer que a gente separe uma?");
    expect(lista.find((d) => d.status === "skipped")?.exclusion_reason).toBe("variavel_ausente");
    await page.screenshot({ path: path.join(EVIDENCIA, "04-lista-preparada.png"), fullPage: true });
  });

  test("o envio de teste sai como modelo, com os valores na ordem e a imagem do cabeçalho", async ({ page }) => {
    test.skip(!TEM_DUBLE, `precisa do dublê do provedor: ZERNIO_API_BASE_URL=${URL_DO_DUBLE} ZERNIO_ACCOUNT_ID=${CONTA}`);
    await login(page, creds.users.manager!.email, creds.password);
    await page.goto(`/app/campaigns/${campanhaId}`);
    await page.getByRole("button", { name: "Enviar teste" }).click();
    await page.getByLabel("Contato do teste").fill(`Maria José E2E ${SUFIXO}`);
    await page.getByRole("button", { name: "Enviar para este" }).first().click();

    await expect.poll(() => recebidos.filter((r) => r.caminho === "/v1/inbox/conversations").length, { timeout: 30_000 }).toBe(1);
    const pedido = recebidos.find((r) => r.caminho === "/v1/inbox/conversations")!.corpo!;
    expect(pedido).toMatchObject({
      accountId: CONTA,
      templateName: MODELO,
      templateLanguage: "pt_BR",
      templateParams: ["Maria", "Cafeteira Elétrica"],
      headerMedia: { type: "image", link: IMAGEM_SALVA },
    });

    // Na conversa fica o texto preenchido, como modelo.
    const { data: msg } = await admin
      .from("messages")
      .select("type, body, template_name, status")
      .eq("organization_id", creds.org_id)
      .eq("template_name", MODELO)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();
    expect(msg).toMatchObject({
      type: "template",
      template_name: MODELO,
      body: "Olá Maria! A Cafeteira Elétrica sai por R$ 189,90 com frete grátis. Quer que a gente separe uma?",
    });
    await page.screenshot({ path: path.join(EVIDENCIA, "05-teste-enviado.png"), fullPage: true });
  });

  test("o número oficial oferece o envio rápido, e a confirmação diz em quanto tempo sai", async ({ page }) => {
    await login(page, creds.users.manager!.email, creds.password);
    await page.goto(`/app/campaigns/${campanhaId}`);

    const velocidade = page.getByTestId("velocidade-da-campanha");
    await expect(velocidade).toBeVisible({ timeout: 30_000 });
    // Campanha que já existia é gradual: a rápida é escolha, nunca padrão.
    await expect(velocidade.getByRole("radio", { name: "Gradual" })).toBeChecked();
    await velocidade.getByRole("radio", { name: "Rápido" }).check();
    // Na rápida o intervalo não vale, e a tela não o oferece.
    await expect(page.locator("#r-intervalo")).toHaveCount(0);
    await page.getByRole("button", { name: "Salvar ritmo" }).click();
    await expect(page.getByText("Ritmo salvo.")).toBeVisible({ timeout: 30_000 });

    const { data: salva } = await admin.from("campaigns").select("velocidade").eq("id", campanhaId).single();
    expect((salva as { velocidade: string }).velocidade).toBe("rapida");

    await page.getByRole("button", { name: "Iniciar envio" }).click();
    await expect(page.getByText(/Envio rápido: sai tudo em cerca de 1 min\./)).toBeVisible();
    await page.screenshot({ path: path.join(EVIDENCIA, "06-envio-rapido-escolhido.png"), fullPage: true });
    await page.getByRole("button", { name: "Voltar" }).click();
  });

  test("⭐ envio rápido: uma rodada manda a lista inteira, cada um com o seu nome", async ({ page }) => {
    test.skip(!TEM_DUBLE, `precisa do dublê do provedor: ZERNIO_API_BASE_URL=${URL_DO_DUBLE} ZERNIO_ACCOUNT_ID=${CONTA}`);
    await login(page, creds.users.manager!.email, creds.password);
    await page.goto("/app/campaigns/new");

    await page.locator("#nome").fill(`Rápida E2E ${SUFIXO}`);
    await page.locator("#canal").selectOption(sessaoId);
    await expect(page.getByTestId("modelo-da-campanha")).toBeVisible({ timeout: 30_000 });
    await page.locator("#modelo").selectOption(`${MODELO}|pt_BR`);
    await page.getByLabel("Origem: {{1}}", { exact: true }).selectOption("contact_first_name");
    await page.getByLabel("Origem: {{2}}", { exact: true }).selectOption("fixed");
    await page.getByLabel("Texto fixo: {{2}}", { exact: true }).fill("Cafeteira Elétrica");
    await page.getByLabel("Com alguma destas etiquetas").fill(ETIQUETA_RAPIDA);
    await page.getByTestId("velocidade-da-campanha").getByRole("radio", { name: "Rápido" }).check();
    await page.getByRole("button", { name: "Salvar rascunho" }).click();
    await page.waitForURL(/\/app\/campaigns\/[0-9a-f-]{36}$/, { timeout: 60_000 });
    campanhaRapidaId = page.url().split("/").pop()!;

    await page.getByRole("button", { name: "Preparar lista" }).click();
    await expect(page.getByRole("button", { name: "Iniciar envio" })).toBeVisible({ timeout: 60_000 });
    await page.getByRole("button", { name: "Iniciar envio" }).click();
    await expect(page.getByText(/Envio rápido: sai tudo em cerca de 1 min\./)).toBeVisible();
    await page.getByRole("button", { name: "Confirmar" }).click();
    await expect
      .poll(async () => {
        const { data } = await admin.from("campaigns").select("status").eq("id", campanhaRapidaId).single();
        return (data as { status: string } | null)?.status;
      }, { timeout: 30_000 })
      .toBe("running");

    // UMA rodada do cron — no gradual sairia uma pessoa; na rápida, todas.
    const antes = recebidos.length;
    const tick = await page.request.post("/api/v1/cron/campaign-worker", {
      headers: { authorization: `Bearer ${process.env.INTERNAL_SECRET ?? "e2e-placeholder-nao-e-segredo"}` },
    });
    expect(tick.ok(), `rodada: ${tick.status()} ${await tick.text()}`).toBe(true);

    const enviados = recebidos.slice(antes).filter((r) => r.caminho === "/v1/inbox/conversations");
    expect(enviados).toHaveLength(NOMES_DA_RAPIDA.length);
    const primeiros = enviados.map((r) => (r.corpo!.templateParams as string[])[0]).sort();
    expect(primeiros).toEqual([...NOMES_DA_RAPIDA].sort());

    const { data: destinatarios } = await admin
      .from("campaign_recipients")
      .select("status")
      .eq("campaign_id", campanhaRapidaId);
    expect(((destinatarios ?? []) as Array<{ status: string }>).map((d) => d.status)).toEqual(
      NOMES_DA_RAPIDA.map(() => "sent"),
    );
    const { data: depois } = await admin.from("campaigns").select("status").eq("id", campanhaRapidaId).single();
    expect((depois as { status: string }).status).toBe("completed");

    // Pela tela: os contadores mostram a lista inteira enviada.
    await page.reload();
    await expect(page.getByText("Enviadas", { exact: true }).locator("xpath=following-sibling::p[1]")).toHaveText(
      String(NOMES_DA_RAPIDA.length),
      { timeout: 30_000 },
    );
    await page.screenshot({ path: path.join(EVIDENCIA, "07-rapida-lista-inteira-numa-rodada.png"), fullPage: true });
  });
});


test("campanha de texto prepara a reserva e o dado preenchido pelo mesmo fluxo da tela", async ({ page }) => {
  test.setTimeout(150_000);
  const { randomUUID } = await import("node:crypto");
  const { credenciaisSupabaseDeTeste } = await import("../../scripts/lib/env-de-teste");
  const { loginComoAdmin, lerCreds } = await import("./helpers/login-admin");
  const ambiente = credenciaisSupabaseDeTeste();
  expect(["127.0.0.1", "localhost"]).toContain(new URL(ambiente.url).hostname);
  const db = createClient(ambiente.url, ambiente.serviceRole, { auth: { persistSession: false } });
  const cc = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
  const sufixo = randomUUID().slice(0, 8);
  const nome = `Reserva campanha ${sufixo}`;
  const etiqueta = `reserva-${sufixo}`;
  let canal = "";
  let campanha = "";
  const contatos: string[] = [];
  try {
    const sessao = await db.from("channel_sessions").insert({ organization_id: cc.org_id, display_name: nome, waha_session_name: `reserva-${sufixo}`, status: "WORKING", webhook_secret_encrypted: "\\x00" }).select("id").single();
    expect(sessao.error).toBeNull();
    canal = sessao.data!.id as string;
    for (const [i, pessoa] of ["Carla Souza", null].entries()) {
      const contato = await db.from("contacts").insert({ organization_id: cc.org_id, name: pessoa, display_name: null, phone_number: `+551197${Date.now().toString().slice(-6)}${i}`, tags: [etiqueta] }).select("id").single();
      expect(contato.error).toBeNull();
      contatos.push(contato.data!.id as string);
    }
    await loginComoAdmin(page, lerCreds());
    // Uma organização no seed: o seletor é oculto por contrato. Canal,
    // público e snapshot abaixo conferem a empresa real da sessão.
    await page.goto("/app/campaigns/new");
    await page.locator("#nome").fill(nome);
    await page.locator("#canal").selectOption(canal);
    await expect(page.getByText('Para não depender do dado, ponha um texto de reserva: {{primeiro_nome|"aluno"}}.')).toBeVisible();
    await page.getByRole("textbox", { name: "Texto da mensagem" }).fill('Oi {{primeiro_nome|"aluno"}}!');
    await page.getByLabel("Com alguma destas etiquetas").fill(etiqueta);
    await page.getByRole("button", { name: "Ver quantas pessoas" }).click();
    await expect(page.getByText(/2\s*podem receber/)).toBeVisible();
    await page.getByRole("button", { name: "Salvar rascunho" }).click();
    await page.waitForURL(/\/app\/campaigns\/[0-9a-f-]{36}$/);
    campanha = page.url().split("/").pop()!;
    await page.getByRole("button", { name: "Preparar lista" }).click();
    await expect(page.getByRole("button", { name: "Enviar teste" })).toBeVisible();
    const snapshot = await db.from("campaign_recipients").select("rendered_body, status").eq("organization_id", cc.org_id).eq("campaign_id", campanha);
    expect(snapshot.error).toBeNull();
    expect(snapshot.data?.map((r) => r.rendered_body).sort()).toEqual(["Oi Carla!", "Oi aluno!"]);
    expect(snapshot.data?.map((r) => r.status)).toEqual(["pending", "pending"]);
    fs.mkdirSync("evidence/antigos-core-3405", { recursive: true });
    await page.screenshot({ path: "evidence/antigos-core-3405/campanha-preparada.png", fullPage: true });
  } finally {
    const erros: boolean[] = [];
    for (const [tabela, coluna, valor] of [
      ["campaign_recipients", "campaign_id", campanha], ["campaigns", "name", nome],
      ...contatos.map((id) => ["contacts", "id", id]), ["channel_sessions", "id", canal],
    ]) {
      if (!valor) continue;
      try {
        const { error } = await db.from(tabela!).delete().eq("organization_id", cc.org_id).eq(coluna!, valor!);
        erros.push(error !== null);
      } catch { erros.push(true); }
    }
    expect(erros.every((erro) => !erro), "limpeza da fixture da campanha").toBe(true);
  }
});
