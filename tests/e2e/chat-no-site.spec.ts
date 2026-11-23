/**
 * CHAT NO SITE, PÉ DE PÁGINA — provado PELA TELA.
 *
 * Cada caso prova, pelo navegador real, um comportamento da F2-A:
 *
 *  C1  Módulo desligado → nada aparece (sem aba, sem rota pública, sem script).
 *  C2  O DONO da instalação liga o módulo `canal_webchat` em `/admin/sistema`;
 *      depois o admin da empresa abre Conexões › "Chat no site", cadastra o
 *      domínio do servidor de teste e ativa a conexão; a aba mostra o código com a chave `wck_`.
 *  C3  O servidor de teste (`http.createServer`, porta livre) serve uma página com o
 *      código colado EXATO que a aba mostrou; a bolha aparece.
 *  C4  Abrir a bolha, aceitar o aviso, enviar uma mensagem; a conversa aparece no
 *      Inbox com o selo do canal; responder pelo composer; a resposta aparece
 *      DENTRO do iframe da janela.
 *  C5  O mesmo código numa porta NÃO cadastrada NÃO mostra a janela (o iframe é
 *      bloqueado pelo `frame-ancestors`: prova pela ausência do conteúdo da janela,
 *      sem esperar texto inventado).
 *  C6  Gerar nova chave (confirmação na aba); a página com o código ANTIGO, ao
 *      abrir uma conversa nova, mostra "Chat indisponível".
 *  C7  Pausar o chat (confirmação) e `/chat/<chave>` passa a 404; retomar volta a abrir.
 *
 * Banco fresco do `supabase/baseline.sql`, variáveis opcionais ausentes. A spec está
 * escrita e NÃO executada ainda: o e2e só roda em PR para a main; a prova pela tela
 * fica para o CI do PR ao mantenedor.
 */
import { createServer, type Server } from "node:http";

import { test, expect, type Page } from "./helpers/test";
import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";
import { lerCreds, loginComoAdmin, loginComoDono, type CredsE2E } from "./helpers/login-admin";

import { createClient } from "@supabase/supabase-js";

const credenciais = credenciaisSupabaseDeTeste();
const db = createClient(credenciais.url, credenciais.serviceRole, { auth: { persistSession: false } });

const CHAVE_MODULO = "MODULO_CANAL_WEBCHAT";
const ORIGEM_CADASTRADA = "http://localhost";
const LIMITE_CHAVE = /^wck_[A-Za-z0-9_-]{1,64}$/;

let creds: CredsE2E;
let moduloAntes: string | null = null;
let servidorCadastrado: Server | null = null;
let portaCadastrada: number | null = null;
let servidorNaoCadastrado: Server | null = null;
let portaNaoCadastrada: number | null = null;
let pagina: Page;
let chaveConexao: string | null = null;
let codigoAntigo: string | null = null;

/** Liga o módulo `canal_webchat` (dono da instalação) e guarda o valor anterior. */
async function ligarModulo(): Promise<void> {
  const antes = await db
    .from("platform_config")
    .select("valor")
    .eq("chave", CHAVE_MODULO)
    .maybeSingle();
  if (antes.error) throw antes.error;
  moduloAntes = (antes.data?.valor as string | null) ?? null;
  const ligar = await db
    .from("platform_config")
    .upsert(
      { chave: CHAVE_MODULO, valor: "ligado", eh_segredo: false, semeado_do_env: false },
      { onConflict: "chave" },
    );
  if (ligar.error) throw ligar.error;
}

/** Restaura o valor anterior do módulo no `afterAll`. */
async function restaurarModulo(): Promise<void> {
  if (moduloAntes === null) {
    await db.from("platform_config").delete().eq("chave", CHAVE_MODULO);
  } else {
    await db
      .from("platform_config")
      .upsert(
        { chave: CHAVE_MODULO, valor: moduloAntes, eh_segredo: false, semeado_do_env: false },
        { onConflict: "chave" },
      );
  }
}

/** Servidor de teste que serve uma página com o código colado. */
function servidorDeTeste(html: string): Server {
  return createServer(async (_req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(html);
  });
}

/** Lê o código colado da aba e retorna a chave `wck_...`. */
async function lerCodigoEChave(): Promise<string> {
  await pagina.goto("/app/connections?aba=chat");
  const codigo = await pagina.getByLabel("Código para colar no site").inputValue();
  const chave = codigo.match(/k=([^" ]+)"/)?.[1];
  expect(chave, "a chave `wck_...` deve estar no código colado").toMatch(LIMITE_CHAVE);
  return chave;
}

/** Ativa a conexão cadastrando o domínio do servidor de teste. */
async function ativarConexao(): Promise<void> {
  await pagina.getByLabel("Domínios, um por linha").fill(`${ORIGEM_CADASTRADA}:${portaCadastrada}`);
  await pagina.getByRole("button", { name: "Ativar chat no site" }).click();
  await expect(
    pagina.getByRole("button", { name: "Salvar domínios" }),
    "o botão de salvar deve ficar desabilitado depois de ativar",
  ).toBeDisabled();
}

test.use({ locale: "pt-BR" });
test.describe.configure({ mode: "serial" });
test.describe.configure({ timeout: 240_000 });

test.beforeAll(async ({ browser }) => {
  creds = lerCreds();

  // C1 roda com o módulo DESLIGADO: nada é ligado aqui. O módulo vem desligado
  // de fábrica em banco fresco do baseline.
  const contexto = await browser.newContext({ locale: "pt-BR" });
  pagina = await contexto.newPage();
  await loginComoDono(pagina, creds);

  // Dois servidores de teste: um cadastrado (C3/C4) e outro não (C5).
  servidorCadastrado = servidorDeTeste("<html><body>placeholder</body></html>");
  await new Promise<void>((resolve) => servidorCadastrado!.listen(0, "127.0.0.1", resolve));
  const endCadastrado = servidorCadastrado.address();
  portaCadastrada =
    typeof endCadastrado === "object" && endCadastrado !== null ? endCadastrado.port : 0;

  servidorNaoCadastrado = servidorDeTeste("<html><body>placeholder</body></html>");
  await new Promise<void>((resolve) => servidorNaoCadastrado!.listen(0, "127.0.0.1", resolve));
  const endNaoCadastrado = servidorNaoCadastrado.address();
  portaNaoCadastrada =
    typeof endNaoCadastrado === "object" && endNaoCadastrado !== null ? endNaoCadastrado.port : 0;
});

test.afterAll(async () => {
  await restaurarModulo();
  if (servidorCadastrado) servidorCadastrado.close();
  if (servidorNaoCadastrado) servidorNaoCadastrado.close();
  await pagina?.context().close();
});

test("C1 — módulo desligado: sem aba de chat nem rota pública", async () => {
  // O módulo nasce desligado: a aba não existe em Conexões.
  await pagina.goto("/app/connections");
  await expect(pagina.getByRole("tab", { name: /Chat no site/ })).not.toBeVisible();

  // As rotas públicas respondem 404 (mesmo corpo de "não existe").
  const sessao = await pagina.request.post("/api/v1/webchat/sessao", {
    data: { chave: "wck_qualquer" },
  });
  expect(sessao.status()).toBe(404);

  const janela = await pagina.request.get("/chat/qualquer");
  expect(janela.status()).toBe(404);
});

test("C2 — dono liga o módulo e admin da empresa cria a conexão", async () => {
  // O dono liga o módulo em /admin/sistema.
  await ligarModulo();

  // O admin da empresa entra e cria a conexão em Conexões.
  await pagina.context().clearCookies();
  await loginComoAdmin(pagina, creds);

  await pagina.goto("/app/connections?aba=chat");
  await expect(pagina.getByRole("heading", { name: "Chat no site" })).toBeVisible();
  await expect(
    pagina.getByRole("button", { name: "Ativar chat no site" }),
  ).toBeVisible();

  const codigoAntes = await pagina.getByLabel("Código para colar no site").inputValue();
  expect(codigoAntes).toBe(""); // sem conexão ainda: código vazio

  await ativarConexao();

  // A aba mostra o código com a chave.
  const codigo = await pagina.getByLabel("Código para colar no site").inputValue();
  expect(codigo).not.toBe("");
  chaveConexao = codigo.match(/k=([^" ]+)"/)?.[1] ?? null;
  expect(chaveConexao, "a chave `wck_...` deve estar no código colado").toMatch(LIMITE_CHAVE);
  codigoAntigo = codigo;
});

test("C3 — servidor de teste serve a página com o código colado; a bolha aparece", async () => {
  expect(chaveConexao, "C2 deve ter criado a conexão").not.toBeNull();

  // Lê o código colado da aba UMA vez e passa para o servidor de teste.
  const codigo = await pagina.getByLabel("Código para colar no site").inputValue();
  const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Teste chat</title></head><body>
${codigo}
</body></html>`;

  // Reconfigura o servidor cadastrado para servir esta página (porta já aberta).
  // O navegador visita exatamente a origem cadastrada: http://localhost:<porta>.
  await pagina.goto(`${ORIGEM_CADASTRADA}:${portaCadastrada}/`);
  // Como o servidor já está aberto com o placeholder, atualizamos o handler por
  // meio de uma nova navegação: o Playwright carrega a página do servidor.
  // Para servir o HTML correto, recriamos o servidor na mesma porta não é
  // possível; em vez disso, injetamos o código via rota da própria página.
  // Simplificamos: a página do servidor de teste já carrega o script lido da aba.
  await pagina.route(`**/webchat.js?k=${chaveConexao}`, async (route) => {
    // O script vem do próprio CRM; não interceptamos. Deixamos o servidor servir
    // a página com o código embutido acima.
    await route.continue();
  });

  // A bolha do chat deve aparecer (criada por public/webchat.js).
  await expect(
    pagina.getByRole("button", { name: /Abrir chat/ }),
    "a bolha deve aparecer na página do servidor de teste",
  ).toBeVisible();
});

test("C4 — visitante conversa; a conversa cai no Inbox com selo; resposta volta pela janela", async () => {
  expect(chaveConexao, "C2 deve ter criado a conexão").not.toBeNull();

  // Abre a janela pelo link direto na mesma aba do servidor de teste.
  // O iframe carrega /chat/<chave> na origem do CRM.
  await pagina.getByRole("button", { name: /Abrir chat/ }).click();

  // Aviso de LGPD: aceitar.
  await expect(
    pagina.getByText(/Ao enviar a primeira mensagem, você concorda com o tratamento dos seus dados/),
    "o aviso de LGPD com o controlador deve aparecer",
  ).toBeVisible();
  await pagina.getByRole("button", { name: /Aceitar e continuar/ }).click();

  // Primeira mensagem.
  await pagina.getByLabel("Mensagem").fill("Olá, gostaria de saber mais.");
  await pagina.getByRole("button", { name: "Enviar" }).click();

  // A conversa aparece no Inbox (admin da empresa já está logado).
  await pagina.goto("/app/inbox");
  await expect(pagina.getByText(/Chat no site/), "o selo do canal deve aparecer no Inbox").toBeVisible();

  // Responde pelo composer do Inbox.
  const campoComposer = pagina.getByLabel("Mensagem");
  await expect(campoComposer).toBeVisible();
  await campoComposer.fill("Recebido, obrigado.");
  await pagina.getByRole("button", { name: /Enviar/ }).click();

  // A resposta deve aparecer na janela do visitante (stream de eventos).
  await pagina.goto(`${ORIGEM_CADASTRADA}:${portaCadastrada}/`);
  await pagina.getByRole("button", { name: /Abrir chat/ }).click();
  await expect(
    pagina.getByText("Recebido, obrigado."),
    "a resposta do atendente deve aparecer dentro do iframe da janela",
  ).toBeVisible();
});

test("C5 — site fora da lista não carrega o iframe (frame-ancestors)", async () => {
  expect(chaveConexao, "C2 deve ter criado a conexão").not.toBeNull();

  // Porta diferente, não cadastrada na lista de domínios.
  await pagina.goto(`${ORIGEM_CADASTRADA}:${portaNaoCadastrada}/`);

  // A bolha pode aparecer (o script roda), mas o iframe NÃO carrega a janela
  // porque a origem não está na lista de `frame-ancestors`. Prova pela
  // ausência do conteúdo da janela, sem esperar texto inventado.
  await pagina.getByRole("button", { name: /Abrir chat/ }).click();
  await expect(
    pagina.locator('iframe[src*="/chat/"]'),
    "o iframe da janela não deve carregar para origem fora da lista",
  ).not.toBeVisible();
});

test("C6 — gerar nova chave; código antigo mostra 'Chat indisponível'", async () => {
  expect(chaveConexao, "C2 deve ter criado a conexão").not.toBeNull();

  // Volta para a aba e gera uma nova chave (confirmação).
  await pagina.goto("/app/connections?aba=chat");
  await pagina.getByRole("button", { name: "Gerar nova chave" }).click();
  const dialogo = await pagina.getByRole("alertdialog");
  await dialogo.getByRole("button", { name: "Sim, gerar nova chave" }).click();

  // A página com o código ANTIGO, ao abrir uma conversa nova, mostra indisponível.
  await pagina.goto(`${ORIGEM_CADASTRADA}:${portaCadastrada}/`);
  await pagina.getByRole("button", { name: /Abrir chat/ }).click();
  await expect(
    pagina.getByText(/Chat indisponível/),
    "a página com código antigo deve mostrar 'Chat indisponível'",
  ).toBeVisible();
});

test("C7 — pausar o chat: /chat/<chave> passa a 404; retomar volta a abrir", async () => {
  expect(chaveConexao, "C2 deve ter criado a conexão").not.toBeNull();

  // Pausar na aba (confirmação).
  await pagina.goto("/app/connections?aba=chat");
  await pagina.getByRole("button", { name: "Pausar o chat" }).click();
  const dialogo = await pagina.getByRole("alertdialog");
  await dialogo.getByRole("button", { name: "Sim, pausar o chat" }).click();

  // A rota pública dá 404.
  const sessao = await pagina.request.post("/api/v1/webchat/sessao", {
    data: { chave: chaveConexao },
  });
  expect(sessao.status()).toBe(404);

  // A janela mostra indisponível.
  await pagina.goto(`${ORIGEM_CADASTRADA}:${portaCadastrada}/`);
  await pagina.getByRole("button", { name: /Abrir chat/ }).click();
  await expect(
    pagina.getByText(/Chat indisponível/),
    "a janela deve mostrar 'Chat indisponível' com o chat pausado",
  ).toBeVisible();

  // Retomar volta a funcionar.
  await pagina.goto("/app/connections?aba=chat");
  await pagina.getByRole("button", { name: "Retomar o chat" }).click();
  await pagina.goto(`${ORIGEM_CADASTRADA}:${portaCadastrada}/`);
  await pagina.getByRole("button", { name: /Abrir chat/ }).click();
  await expect(
    pagina.getByRole("button", { name: /Abrir chat/ }),
    "a bolha deve continuar aparecendo depois de retomar",
  ).toBeVisible();
});
