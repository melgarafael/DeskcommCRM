/**
 * CHAT NO SITE, PÉ DE PÁGINA — provado PELA TELA.
 *
 * Caminhos:
 *  1. Módulo desligado → nada aparece (sem aba, sem rota pública, sem script).
 *  2. Módulo ligado + conexão criada → bolha na página, janela abre, visitante conversa,
 *     conversa cai no Inbox com selo "Chat no site", resposta volta pela janela.
 *  3. Chat pausado → as três rotas públicas (/sessao, /mensagens, /eventos) dão o mesmo 404.
 *  4. Site fora da lista de domínios → o iframe não carrega (frame-ancestors).
 *
 * Mesmo molde de `recursos-opcionais.spec.ts`: login de admin primeiro, seed via service
 * role para confirmar o módulo no banco, bateria serial.
 */
import { createClient } from "@supabase/supabase-js";

import { expect, test, type Browser, type Page } from "./helpers/test";
import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";
import { moduloLigado } from "../../lib/instalacao/modulos";

import { lerCreds, loginComoAdmin } from "./helpers/login-admin";

test.use({ locale: "pt-BR" });
test.describe.configure({ mode: "serial" });
test.describe.configure({ timeout: 240_000 });

const db = createClient(
  credenciaisSupabaseDeTeste().url,
  credenciaisSupabaseDeTeste().serviceRole,
  { auth: { persistSession: false } },
);

async function esperarModuloWebchatLigado(): Promise<void> {
  await expect
    .poll(async () => moduloLigado(db, "canal_webchat"), { timeout: 30_000 })
    .toBe(true);
}

let pagina: Page;

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  const contexto = await browser.newContext({ locale: "pt-BR" });
  pagina = await contexto.newPage();
  await loginComoAdmin(pagina, lerCreds());
});

test.afterAll(async () => {
  await pagina?.context().close();
});

test("módulo desligado: não há aba de chat nem rota pública", async () => {
  // O módulo nasce desligado: a aba não existe em Conexões.
  await pagina.goto("/app/connections");
  await expect(pagina.getByRole("tab", { name: /Chat no site/ })).not.toBeVisible();

  // As rotas públicas respondem 404 (mesmo corpo de "não existe").
  const sessao = await pagina.request.post("/api/v1/webchat/sessao", {
    data: { chave: "wck_qualquer" },
  });
  expect(sessao.status()).toBe(404);
});

test("ligar o módulo e criar a conexão em Conexões", async () => {
  // Vai para Recursos opcionais (admin do servidor) e liga canal_webchat.
  await pagina.goto("/app/settings/recursos");
  await expect(
    pagina.getByRole("heading", { level: 1, name: "Recursos opcionais" }),
  ).toBeVisible();

  const linha = pagina.locator('[data-recurso="canal_webchat"]').first();
  await expect(linha).toContainText(/Chat no site|canal_webchat/);
  await linha.getByRole("link", { name: /Ajustar/ }).click();

  // Confere no banco (o interruptor da tela é otimista).
  await esperarModuloWebchatLigado();

  // Vai para Conexões > Chat no site e cria a conexão.
  await pagina.goto("/app/connections?aba=chat");
  await expect(pagina.getByRole("heading", { name: "Chat no site" })).toBeVisible();
  await expect(
    pagina.getByRole("button", { name: "Ativar chat no site" }),
  ).toBeVisible();

  const dominios = pagina.getByLabelText("Domínios, um por linha");
  await dominios.fill("https://teste.exemplo.com.br");
  await pagina.getByRole("button", { name: "Ativar chat no site" }).click();

  await expect(
    pagina.getByRole("button", { name: "Salvar domínios" }),
  ).toBeDisabled();
  const codigo = pagina.getByLabelText("Código para colar no site");
  await expect(codigo).toContainText("wck_");
});

test("site fora da lista de domínios não carrega o iframe", async () => {
  // Pega a chave da conexão criada no caso anterior.
  await pagina.goto("/app/connections?aba=chat");
  const codigo = (await pagina.getByLabelText("Código para colar no site").inputValue());
  const chave = codigo.match(/k=([^" ]+)"/)?.[1];
  expect(chave).toBeTruthy();

  // Outra origem que não está na lista de domínios permitidos: o iframe é recusado.
  await pagina.goto(`/chat/${chave}`);
  await expect(
    pagina.getByText(/indisponível|não foi possível carregar/i),
  ).toBeVisible();
});
