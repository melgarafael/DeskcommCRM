// Prova da Fase 5 (formulário e cofre). O membro de teste gera o link (função
// temporária com clientes.gerenciar + cofre.ver_senhas); o "cliente" preenche
// num navegador SEM sessão, no celular.
import { chromium } from "/app/node_modules/@playwright/test/index.mjs";
import { mkdirSync, writeFileSync } from "node:fs";

const BASE = "https://teste.emmovimento.tech";
const OUT = "/prova/evidencias-f5";
const CLIENTE = "8a49b809-3320-40d0-8e18-c3be9b53f0c8";
mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const fase = process.env.FASE ?? "tudo";

const browser = await chromium.launch();
const membro = await browser.newContext({ viewport: { width: 1280, height: 900 }, storageState: "/prova/sessao-membro.json" });
const page = await membro.newPage();
page.on("dialog", (d) => d.accept());

if (fase === "tudo") {
  // 1. Gerar o link.
  await page.goto(`${BASE}/agencia/clientes/${CLIENTE}?aba=acessos`);
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Mandar no WhatsApp do cliente").uncheck();
  await page.getByRole("button", { name: /Gerar (outro )?link/ }).click();
  await page.getByTestId("link-do-formulario").waitFor({ timeout: 20000 });
  const link = await page.getByTestId("link-do-formulario").inputValue();
  log("link gerado:", link.replace(/[A-Za-z0-9_-]{43}$/, "<token>"));
  writeFileSync("/prova/link-f5.txt", link);
  await page.screenshot({ path: `${OUT}/01-link-gerado-1280.png`, fullPage: true });

  // 2. O cliente, sem conta, no celular.
  const cliente = await browser.newContext({ viewport: { width: 375, height: 812 } });
  const c = await cliente.newPage();
  await c.goto(link);
  await c.waitForLoadState("networkidle");
  await c.screenshot({ path: `${OUT}/02-boas-vindas-375.png`, fullPage: true });
  await c.getByRole("button", { name: "Começar" }).click();
  await c.locator("#empresa-nome-0").fill("Empresa Modelo Ltda");
  await c.locator("#empresa-cnpj-0").fill("11222333000181");
  await c.locator("#empresa-whatsapp-0").fill("(11) 98888-7777");
  await c.locator("#empresa-email-0").fill("contato@empresamodelo.test");
  await c.getByLabel("Endereço 1").fill("Rua das Flores, 100 — Centro, São Paulo");
  log("CNPJ com máscara:", await c.locator("#empresa-cnpj-0").inputValue());
  await c.screenshot({ path: `${OUT}/03-empresa-375.png`, fullPage: true });
  await c.getByRole("button", { name: "Continuar" }).click();
  await c.getByLabel("Horários de atendimento").fill("Segunda a sexta: 8h às 18h\nSábado: 8h às 12h");
  await c.getByRole("button", { name: "Continuar" }).click();
  await c.getByLabel("Nome do responsável 1").fill("Ana Souza");
  await c.getByLabel("Cargo / setor do responsável 1").fill("Marketing");

  // Recarrega no meio: o rascunho volta (salvo a cada etapa).
  await c.getByRole("button", { name: "Continuar" }).click();
  await c.waitForTimeout(1200);
  await c.reload();
  await c.waitForLoadState("networkidle");
  await c.getByRole("button", { name: "Começar" }).click();
  log("rascunho voltou:", await c.locator("#empresa-nome-0").inputValue(), "|", await c.locator("#empresa-cnpj-0").inputValue());
  for (let i = 0; i < 3; i++) await c.getByRole("button", { name: "Continuar" }).click();
  await c.getByLabel("Produtos ou serviços").fill("Uniformes escolares e acessórios.");
  await c.getByRole("button", { name: "Continuar" }).click();

  await c.getByLabel("Login do Instagram").fill("@empresamodelo");
  await c.getByLabel("Senha do Instagram").fill("SenhaDeTeste-Insta-123");
  await c.getByLabel("Nome da página no Facebook").fill("Empresa Modelo");
  await c.getByLabel("Login do Facebook").fill("empresamodelo@example.com");
  await c.getByLabel("Senha do Facebook").fill("SenhaDeTeste-Face-456");
  await c.getByTestId("acesso-google").getByLabel("Não tem").check();
  await c.getByTestId("acesso-tiktok").getByLabel("Não tem").check();
  await c.screenshot({ path: `${OUT}/04-acessos-375.png`, fullPage: true });
  await c.getByRole("button", { name: "Continuar" }).click();
  await c.getByRole("heading", { name: "Arquivos" }).waitFor({ timeout: 15000 });
  log("arquivos:", (await c.getByRole("heading", { name: "Arquivos" }).locator("..").innerText()).replace(/\s+/g, " ").slice(0, 160));
  await c.getByRole("button", { name: "Continuar" }).click();
  await c.getByLabel("Observações gerais").fill("Preferimos gravar às terças.");
  const rola = await c.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  log("celular rola de lado:", rola);
  await c.getByRole("button", { name: "Enviar formulário" }).click();
  await c.getByTestId("formulario-recebido").waitFor({ timeout: 30000 });
  await c.screenshot({ path: `${OUT}/05-recebido-375.png`, fullPage: true });

  await c.goto(link);
  await c.waitForLoadState("networkidle");
  log("link depois de enviado:", await c.getByTestId("formulario-indisponivel").innerText());
  await cliente.close();

  // 3. A agência vê as respostas e o cofre.
  await page.goto(`${BASE}/agencia/clientes/${CLIENTE}?aba=acessos`);
  await page.waitForLoadState("networkidle");
  log("formulário:", (await page.getByTestId("formulario-da-ficha").innerText()).replace(/\s+/g, " ").slice(0, 160));
  log("itens no cofre:", await page.getByTestId("item-do-cofre").count());
  const insta = page.getByTestId("item-do-cofre").filter({ hasText: "Instagram" });
  log("senha antes:", await insta.getByTestId("senha-do-item").innerText());
  await insta.getByRole("button", { name: "Ver senha" }).click();
  await page.waitForTimeout(2000);
  log("senha depois:", (await insta.getByTestId("senha-do-item").innerText()) === "SenhaDeTeste-Insta-123" ? "a do formulário" : "OUTRA");
  await page.getByTestId("respostas-do-formulario").locator("summary").click();
  await page.screenshot({ path: `${OUT}/06-acessos-na-ficha-1280.png`, fullPage: true });
  const pdf = await page.request.get(`${BASE}/api/v1/agencia/cofre/${CLIENTE}/relatorio`);
  log("relatório:", pdf.status(), pdf.headers()["content-type"], (await pdf.body()).length, "bytes");
  writeFileSync(`${OUT}/07-relatorio-de-acessos.pdf`, await pdf.body());
}

if (fase === "sem-permissao") {
  await page.goto(`${BASE}/agencia/clientes/${CLIENTE}?aba=acessos`);
  await page.waitForLoadState("networkidle");
  const insta = page.getByTestId("item-do-cofre").filter({ hasText: "Instagram" });
  log("sem permissão — senha:", await insta.getByTestId("senha-do-item").innerText(), "| botão Ver senha:", await insta.getByRole("button", { name: "Ver senha" }).count());
  const pdf = await page.request.get(`${BASE}/api/v1/agencia/cofre/${CLIENTE}/relatorio`);
  log("sem permissão — relatório:", pdf.status());
  await page.screenshot({ path: `${OUT}/08-sem-permissao-1280.png`, fullPage: true });
}

await browser.close();
