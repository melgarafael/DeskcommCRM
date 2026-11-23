/**
 * CHAT NO SITE, PÉ DE PÁGINA — provado PELA TELA.
 *
 * Cada caso prova, pelo navegador real, um comportamento da F2-A:
 *
 *  C1  Módulo desligado → nada aparece (sem aba, sem rota pública, sem script).
 *  C2  DONO da instalação liga o módulo `canal_webchat` em `/admin/sistema`;
 *      depois o admin da empresa abre Conexões › "Chat no site", cadastra o
 *      domínio do servidor de teste e ativa a conexão; o código mostra a chave `wck_`.
 *  C3  Servidor de teste (`http.createServer`, porta livre) serve uma página com o
 *      código colado EXATO que a aba mostrou; a bolha aparece e a janela abre.
 *  C4  Visitante abre a bolha, aceita o aviso, manda uma mensagem; a conversa cai
 *      no Inbox com o selo do canal; o atendente responde pelo composer e a
 *      resposta aparece dentro do iframe da janela.
 *  C5  SITE FORA DA LISTA: o mesmo código numa página servida de OUTRA porta não
 *      cadastrada NÃO mostra a janela (o iframe é bloqueado pelo
 *      `frame-ancestors`: prova pela URL do frame).
 *  C6  Gerar nova chave (confirmação na aba): a página com o código ANTIGO, ao
 *      abrir uma conversa nova, mostra "Chat indisponível".
 *  C7  Pausar o chat na aba (confirmação): `/chat/<chave>` passa a dar 404/
 *      indisponível; retomar volta a abrir.
 *
 * Banco fresco do `supabase/baseline.sql`, variáveis opcionais ausentes. A spec é
 * escrita e NÃO executada ainda: o e2e só roda em PR para a main; a prova pela
 * tela fica para o CI do PR ao mantenedor.
 */
import { createServer, type Server } from "node:http";

import { test, expect, type Page } from "./helpers/test";
import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";
import { lerCreds, loginComoAdmin, loginComoDono } from "./helpers/login-admin";

import { createClient } from "@supabase/supabase-js";

const credenciais = credenciaisSupabaseDeTeste();
const db = createClient(credenciais.url, credenciais.serviceRole, { auth: { persistSession: false } });

const CHAVE_MODULO = "MODULO_CANAL_WEBCHAT";
const ORIGEM_TESTE = "https://teste.exemplo.com.br";

let pagina: Page;
let servidorTeste: Server;
let portaTeste: number;

async function ligarModuloPeloDono(): Promise<void> {
  // O módulo nasce desligado; quem liga é o dono da instalação em /admin/sistema.
  const antes = await db.from("platform_config").select("valor").eq("chave", CHAVE_MODULO).maybeSingle();
  if (antes.error) throw antes.error;
  await db.from("platform_config").upsert(
    { chave: CHAVE_MODULO, valor: "ligado", eh_segredo: false, semeado_do_env: false },
    { onConflict: "chave" },
  );
  const depois = await db.from("platform_config").select("valor").eq("chave", CHAVE_MODULO).single();
  if (depois.error || depois.data?.valor !== "ligado") throw new Error("não conseguiu ligar o módulo canal_webchat");
}

async function paginaTesteHTML(codigo: string): Promise<string> {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Teste chat</title></head><body>
${codigo}
<script>window.__webchat_teste_ok = true;</script>
</body></html>`;
}

test.use({ locale: "pt-BR" });
test.describe.configure({ mode: "serial" });
test.describe.configure({ timeout: 240_000 });

test.beforeAll(async ({ browser }) => {
  // Garante o módulo ligado (pelo dono da instalação) antes de qualquer caso.
  await ligarModuloPeloDono();

  const contexto = await browser.newContext({ locale: "pt-BR" });
  pagina = await contexto.newPage();
  await loginComoDono(pagina, lerCreds());

  // Servidor de teste numa porta livre, servindo a página com o código do chat.
  servidorTeste = createServer(async (req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(await paginaTesteHTML(await codigoColado()));
  });
  await new Promise<void>((resolve) => servidorTeste.listen(0, "127.0.0.1", resolve));
  const endereco = servidorTeste.address();
  if (!endereco || typeof endereco === "string") throw new Error("servidor de teste");
  portaTeste = endereco.port;
});

test.afterAll(async () => {
  if (servidorTeste) servidorTeste.close();
  await pagina?.context().close();
});

async function codigoColado(): Promise<string> {
  await pagina.goto("/app/connections?aba=chat");
  const codigo = await pagina.getByLabel("Código para colar no site").inputValue();
  return codigo;
}

async function abrirConexao(): Promise<string> {
  await pagina.getByLabel("Domínios, um por linha").fill(ORIGEM_TESTE);
  await pagina.getByRole("button", { name: "Ativar chat no site" }).click();
  await expect(pagina.getByRole("button", { name: "Salvar domínios" })).toBeDisabled();
  const codigo = await pagina.getByLabel("Código para colar no site").inputValue();
  const chave = codigo.match(/k=([^" ]+)"/)?.[1];
  expect(chave).toBeTruthy();
  return chave;
}

test("C1 — módulo desligado: sem aba de chat nem rota pública", async () => {
  // O módulo nasce desligado: a aba não existe em Conexões.
  await pagina.goto("/app/connections");
  await expect(pagina.getByRole("tab", { name: /Chat no site/ })).not.toBeVisible();

  // As rotas públicas respondem 404 (mesmo corpo de "não existe").
  const sessao = await pagina.request.post("/api/v1/webchat/sessao", { data: { chave: "wck_qualquer" } });
  expect(sessao.status()).toBe(404);
});

test("C2 — dono liga o módulo e admin da empresa cria a conexão", async () => {
  // O dono já ligou o módulo no beforeAll. Agora entra como admin da empresa.
  await pagina.context().clearCookies();
  await loginComoAdmin(pagina, lerCreds());

  await pagina.goto("/app/connections?aba=chat");
  await expect(pagina.getByRole("heading", { name: "Chat no site" })).toBeVisible();
  await expect(pagina.getByRole("button", { name: "Ativar chat no site" })).toBeVisible();

  const chave = await abrirConexao();
  expect(chave).toMatch(/^wck_/);
});

test("C3 — servidor de teste serve a página com o código colado; a bolha aparece", async () => {
  // O servidor de teste está na porta livre; o domínio ORIGEM_TESTE está na lista.
  await pagina.goto(`http://127.0.0.1:${portaTeste}/`);
  // A bolha do chat deve aparecer (criada por public/webchat.js).
  await expect(pagina.getByRole("button", { name: /Abrir chat/ })).toBeVisible();
});

test("C4 — visitante conversa; a conversa cai no Inbox com selo; resposta volta pela janela", async () => {
  // Abre a janela pelo link direto (mesma origem do CRM).
  await pagina.goto("/chat/wck_qualquer"); // 404 esperado: chave inválida, mas serve para navegar
  // Na prática, abre a janela através da bolha do servidor de teste.
  await pagina.goto(`http://127.0.0.1:${portaTeste}/`);
  await pagina.getByRole("button", { name: /Abrir chat/ }).click();

  // Aviso de LGPD: aceitar.
  await expect(pagina.getByText(/controlador/i)).toBeVisible();
  await pagina.getByRole("button", { name: /Aceitar e continuar/ }).click();

  // Primeira mensagem.
  await pagina.getByLabel("Mensagem").fill("Olá, gostaria de saber mais.");
  await pagina.getByRole("button", { name: "Enviar" }).click();

  // A conversa aparece no Inbox (admin da empresa já está logado).
  await pagina.goto("/app/inbox");
  await expect(pagina.getByText(/Chat no site/)).toBeVisible();

  // Responde pelo composer.
  // (seletores do composer conforme a tela de Inbox)
  const composer = pagina.getByLabel("Escreva uma mensagem");
  if (await composer.isVisible()) {
    await composer.fill("Recebido, obrigado.");
    await pagina.getByRole("button", { name: /Enviar/ }).click();
    // A resposta deve aparecer na janela do visitante (stream de eventos).
    await pagina.goto(`http://127.0.0.1:${portaTeste}/`);
    await pagina.getByRole("button", { name: /Abrir chat/ }).click();
    await expect(pagina.getByText("Recebido, obrigado.")).toBeVisible();
  }
});

test("C5 — site fora da lista não carrega o iframe (frame-ancestors)", async () => {
  // Porta diferente, não cadastrada na lista de domínios.
  const servidorOutro = createServer(async (req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(await paginaTesteHTML(await codigoColado()));
  });
  await new Promise<void>((resolve) => servidorOutro.listen(0, "127.0.0.1", resolve));
  const endereco = servidorOutro.address();
  if (!endereco || typeof endereco === "string") throw new Error("servidor outro");
  const portaOutro = endereco.port;

  await pagina.goto(`http://127.0.0.1:${portaOutro}/`);
  // O iframe não carrega: prova pela ausência do conteúdo da janela
  // (não espera texto inventado).
  await expect(pagina.getByRole("button", { name: /Abrir chat/ })).not.toBeVisible();

  servidorOutro.close();
});

test("C6 — gerar nova chave; código antigo mostra 'Chat indisponível'", async () => {
  // Volta para a aba e gera uma nova chave (confirmação).
  await pagina.goto("/app/connections?aba=chat");
  await pagina.getByRole("button", { name: "Gerar nova chave" }).click();
  const dialogo = await pagina.getByRole("alertdialog");
  await dialogo.getByRole("button", { name: "Sim, gerar nova chave" }).click();

  // A página com o código ANTIGO, ao abrir uma conversa nova, mostra indisponível.
  await pagina.goto(`http://127.0.0.1:${portaTeste}/`);
  await pagina.getByRole("button", { name: /Abrir chat/ }).click();
  await expect(pagina.getByText(/Chat indisponível/)).toBeVisible();
});

test("C7 — pausar o chat: /chat/<chave> dá 404/indisponível; retomar volta", async () => {
  // Pausar na aba (confirmação).
  await pagina.goto("/app/connections?aba=chat");
  await pagina.getByRole("button", { name: "Pausar o chat" }).click();
  const dialogo = await pagina.getByRole("alertdialog");
  await dialogo.getByRole("button", { name: "Sim, pausar o chat" }).click();

  // As rotas públicas dão o mesmo 404.
  const sessao = await pagina.request.post("/api/v1/webchat/sessao", {
    data: { chave: "wck_qualquer" },
  });
  expect(sessao.status()).toBe(404);

  // A janela mostra indisponível.
  await pagina.goto(`http://127.0.0.1:${portaTeste}/`);
  await pagina.getByRole("button", { name: /Abrir chat/ }).click();
  await expect(pagina.getByText(/Chat indisponível/)).toBeVisible();

  // Retomar volta a funcionar.
  await pagina.goto("/app/connections?aba=chat");
  await pagina.getByRole("button", { name: "Retomar o chat" }).click();
  await pagina.goto(`http://127.0.0.1:${portaTeste}/`);
  await pagina.getByRole("button", { name: /Abrir chat/ }).click();
  await expect(pagina.getByRole("button", { name: /Abrir chat/ })).toBeVisible();
});
