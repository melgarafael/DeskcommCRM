/**
 * O ciclo inteiro com IA DE VERDADE, pela tela.
 *
 * Cadastra a credencial do provedor pelo formulário, valida, cria um agente,
 * liga capacidades, dispara um turno real e confere se o USO aparece no painel
 * que a W1 entregou. É a única prova que fecha a alça: configurei → a IA usou →
 * eu vejo.
 *
 * A chave vem de `OPENAI_API_KEY` no ambiente e NUNCA é impressa nem escrita em
 * arquivo. Rode assim:
 *   OPENAI_API_KEY=... npx tsx tests/tmp-ia-real.ts
 */
import * as fs from "node:fs";
import { chromium, type Page } from "@playwright/test";

import { generateTotp, msUntilNextTotpWindow } from "./e2e/utils/totp";

const BASE = "http://localhost:3011";
const MODELO = "GPT-5.6 Terra";
const CHAVE = process.env.OPENAI_API_KEY;
if (!CHAVE) throw new Error("defina OPENAI_API_KEY no ambiente (não em arquivo)");

const C = JSON.parse(fs.readFileSync(".e2e-creds.json", "utf8")) as {
  password: string;
  users: Record<string, { email: string }>;
  admin_totp: { secret: string };
};
const DIR = "evidence/ia-360-w1";
let ultimoCodigo: string | null = null;

async function loginAdmin(p: Page): Promise<void> {
  await p.goto(`${BASE}/login`);
  await p.locator("#email").fill(C.users.admin!.email);
  await p.locator("#password").fill(C.password);
  await p.getByRole("button", { name: "Entrar", exact: true }).click();
  await p.waitForURL(/\/login\/mfa/);
  for (let i = 0; i < 3; i++) {
    if (msUntilNextTotpWindow() < 3_000 || generateTotp(C.admin_totp.secret) === ultimoCodigo) {
      await p.waitForTimeout(msUntilNextTotpWindow() + 300);
    }
    const codigo = generateTotp(C.admin_totp.secret);
    ultimoCodigo = codigo;
    const d = p.locator('input[aria-label="Dígito 1"]');
    await d.waitFor({ state: "visible", timeout: 15_000 });
    await d.click();
    await p.keyboard.type(codigo, { delay: 40 });
    try {
      await p.waitForURL(/\/app\//, { timeout: 10_000 });
      return;
    } catch {
      await p.waitForTimeout(msUntilNextTotpWindow() + 300);
    }
  }
  throw new Error("MFA falhou");
}

/** Escolhe num combobox do Radix pelo texto (não existe <option> até abrir). */
async function escolher(p: Page, idDoGatilho: string, texto: RegExp): Promise<string> {
  await p.locator(`#${idDoGatilho}`).click();
  const opcao = p.getByRole("option").filter({ hasText: texto }).first();
  const nome = (await opcao.textContent()) ?? "";
  await opcao.click();
  return nome.trim();
}

async function main(): Promise<void> {
  fs.mkdirSync(DIR, { recursive: true });
  const b = await chromium.launch();
  const p = await (await b.newContext({ viewport: { width: 1440, height: 950 }, locale: "pt-BR" })).newPage();
  await loginAdmin(p);

  // ---- 1. Cadastrar a credencial PELA TELA ----
  console.info("\n[1] cadastrando credencial do provedor pela tela");
  await p.goto(`${BASE}/app/ai/credentials`);
  await p.waitForLoadState("networkidle");
  const rotulo = `OpenAI prova real ${Date.now()}`;
  const botaoNova = p.getByRole("button", { name: /nova credencial|adicionar|cadastrar/i }).first();
  if (await botaoNova.count()) await botaoNova.click();
  await p.waitForTimeout(700);

  const campoRotulo = p.locator("#cred-label");
  await campoRotulo.waitFor({ state: "visible", timeout: 15_000 });
  await campoRotulo.fill(rotulo);
  // O gatilho do provider neste diálogo é `#cred-provider`, não `#provider`
  // (esse é o do formulário de agente). Errar o id não quebra o teste: ele
  // simplesmente não troca nada, o provider fica no default `anthropic`, e a
  // chave da OpenAI é validada contra a Anthropic — 401, que lê como "a chave
  // do usuário não presta". Foi exatamente o que aconteceu na primeira volta.
  const gatilhoProvider = p.locator("#cred-provider");
  await gatilhoProvider.waitFor({ state: "visible", timeout: 15_000 });
  await gatilhoProvider.click();
  await p.getByRole("option").filter({ hasText: /openai/i }).first().click();
  await p.waitForTimeout(300);
  const providerNaTela = (await gatilhoProvider.textContent())?.trim();
  if (!/openai/i.test(providerNaTela ?? "")) {
    throw new Error(`provider nao trocou para OpenAI (tela mostra "${providerNaTela}")`);
  }
  const campoChave = p.locator('input[type="password"], input[id*="key" i], input[name*="key" i]').first();
  await campoChave.fill(CHAVE!);
  await p.screenshot({ path: `${DIR}/w1-ia-01-credencial.png`, fullPage: true });
  await p.getByRole("button", { name: /salvar|criar|adicionar/i }).last().click();
  await p.waitForTimeout(4000);
  console.info(`    tela apos salvar: ${(await p.locator("main").innerText()).slice(0, 260).replace(/\n/g, " | ")}`);

  // ---- 2. Validar a credencial (é o que libera publicar) ----
  const validar = p.getByRole("button", { name: /validar|testar/i }).first();
  if (await validar.count()) {
    await validar.click();
    await p.waitForTimeout(9000);
    console.info(`    apos validar: ${(await p.locator("main").innerText()).slice(0, 300).replace(/\n/g, " | ")}`);
  }
  await p.screenshot({ path: `${DIR}/w1-ia-02-credencial-validada.png`, fullPage: true });

  // ---- 3. Criar o agente pela tela, com modelo REAL ----
  console.info("\n[2] criando o agente com modelo real");
  await p.goto(`${BASE}/app/ai/agents/new`);
  await p.waitForLoadState("networkidle");
  const nome = `Recepcao IA Real ${Date.now()}`;
  await p.locator("#name").fill(nome);
  await p.locator("textarea").first().fill(
    "Voce e a recepcao de uma clinica. Quando perguntarem sobre oportunidades, negocios ou clientes em aberto, USE as ferramentas disponiveis para consultar antes de responder. Responda em portugues, curto.",
  );
  await escolher(p, "provider", /openai/i);
  await p.waitForTimeout(1200);
  const modeloEscolhido = await escolher(p, "model", new RegExp(MODELO, "i"));
  const credEscolhida = await escolher(p, "credential_id", new RegExp(rotulo.slice(0, 18), "i"));
  const numeroEscolhido = await escolher(p, "channel_session_id", /./);
  console.info(`    modelo="${modeloEscolhido}" credencial="${credEscolhida}" numero="${numeroEscolhido}"`);

  await p.getByTestId("switch-pacote-vender").click();
  const ligadas = await p.getByTestId("consumo-teto").textContent();
  console.info(`    capacidades ligadas: ${ligadas}`);
  await p.screenshot({ path: `${DIR}/w1-ia-03-agente-preenchido.png`, fullPage: true });

  await p.getByRole("button", { name: /criar agent/i }).click();
  await p.waitForURL(/\/app\/ai\/agents\/[0-9a-f-]{36}/, { timeout: 40_000 });
  const idDoAgente = p.url().split("/").pop()!;
  console.info(`    agente criado: ${idDoAgente}`);

  // ---- 4. Fazer a IA RODAR: aba Teste ----
  console.info("\n[3] disparando um turno com a IA de verdade");
  await p.getByRole("tab", { name: /teste/i }).click();
  await p.waitForTimeout(1200);
  const mensagem = p.locator("textarea").first();
  await mensagem.fill("Oi! Quais oportunidades estao abertas no funil hoje?");
  await p.screenshot({ path: `${DIR}/w1-ia-04-teste-antes.png`, fullPage: true });
  await p.getByRole("button", { name: /executar|rodar|testar|enviar/i }).first().click();

  // O turno real leva segundos: modelo + tools + gates.
  for (let i = 0; i < 40; i++) {
    await p.waitForTimeout(3000);
    const texto = await p.locator("main").innerText();
    if (/resposta|tokens|custo|erro|falhou|handoff/i.test(texto) && !/executando|rodando/i.test(texto)) break;
  }
  const resultado = (await p.locator("main").innerText()).slice(0, 1200);
  console.info(`    resultado do turno:\n${resultado}`);
  await p.screenshot({ path: `${DIR}/w1-ia-05-teste-resultado.png`, fullPage: true });

  // ---- 5. O uso aparece no painel que a W1 entregou? ----
  console.info("\n[4] o painel de capacidades enxerga o que a IA fez?");
  await p.getByRole("tab", { name: /capacidades/i }).click();
  await p.waitForTimeout(3000);
  const painel = await p.getByTestId("uso-das-capacidades").innerText().catch(() => "(painel nao renderizou)");
  console.info(painel.slice(0, 900));
  await p.screenshot({ path: `${DIR}/w1-ia-06-uso-real.png`, fullPage: true });

  console.info(`\nAGENTE=${idDoAgente}`);
  await b.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
