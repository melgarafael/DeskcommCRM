/**
 * FOTOS NO CATÁLOGO — PROVA PELA TELA (PR #1502, DoD item 12).
 *
 * Os testes de unidade provam o farejador de bytes, a conferência da nova
 * ordem e o filtro de dono. Isto prova o que um gerente de loja faz de verdade
 * no `next start` real contra o Postgres e o Storage reais do job:
 *
 *   1. cadastra um produto, abre "Fotos (0)";
 *   2. tenta subir um TEXTO com nome `.png` — a tela recusa com a mensagem de
 *      tipo, e nada entra (a rota decide pela assinatura dos bytes, não pelo
 *      nome nem pelo content-type que o navegador declarou);
 *   3. sobe duas fotos, vê a capa aparecer NA LISTA — medida pelo
 *      `naturalWidth` do bitmap, porque o bucket é privado e só a URL assinada
 *      que a página monta faz a imagem baixar;
 *   4. troca a ordem e vê a capa trocar;
 *   5. remove uma e prova que o ARQUIVO saiu do bucket, não só do array: a URL
 *      assinada dela, que baixava antes (controle positivo), deixa de baixar.
 *
 * E o par de papéis: `viewer` e `agent` veem a capa, mas não a porta de editar.
 * O controle de que o gate não "sumiu com o botão para todo mundo" é o caso do
 * gerente, que clica nele.
 *
 * Pré-requisito: `.e2e-creds.json` (o helper roda o seed se faltar). Sem WAHA,
 * Resend, Nuvemshop nem Redis.
 */
import * as zlib from "node:zlib";

import { test, expect, type Locator, type Page, type TestInfo } from "@playwright/test";

import { lerCreds } from "./helpers/login-admin";

const creds = lerCreds();
const ESPERA = 30_000;
const CODIGO = `E2E-FOTO-${Date.now().toString(36)}`;
let produtoId: string | null = null;

// Três logins (gerente, viewer, agent) e seis idas ao servidor com refresh.
test.describe.configure({ mode: "serial", timeout: 120_000 });

// ── PNG de verdade, montado byte a byte (mesmo molde de `marca-logo.spec.ts`) ──

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(tipo: string, dados: Buffer): Buffer {
  const tamanho = Buffer.alloc(4);
  tamanho.writeUInt32BE(dados.length);
  const corpo = Buffer.concat([Buffer.from(tipo, "latin1"), dados]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(corpo));
  return Buffer.concat([tamanho, corpo, crc]);
}

const LADO = 48;

function pngSolido(cor: [number, number, number]): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(LADO, 0);
  ihdr.writeUInt32BE(LADO, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const linha = Buffer.alloc(1 + LADO * 3);
  for (let x = 0; x < LADO; x++) linha.set(cor, 1 + x * 3);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(Buffer.concat(Array.from({ length: LADO }, () => linha)))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ── Ajudantes ──────────────────────────────────────────────────────────────

/** Login por senha: gerente, viewer e agent do seed não têm fator TOTP. */
async function entrar(page: Page, papel: "manager" | "viewer" | "agent"): Promise<void> {
  const email = creds.users[papel]?.email;
  expect(email, `sem \`${papel}\` no .e2e-creds.json — rode seed-e2e-credentials.ts`).toBeTruthy();
  await page.goto("/login");
  await page.locator("#email").fill(email!);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app(\/|$)/, { timeout: ESPERA });
}

/** O nome do arquivo no bucket (`<uuid>.png`), tirado da URL assinada. */
function nomeNoBucket(src: string): string {
  return new URL(src).pathname.split("/").pop() ?? "";
}

/** Espera o navegador terminar com o `<img>` e mede o bitmap e a caixa pintada. */
async function medirImagem(img: Locator): Promise<{ nome: string; src: string; natural: number; w: number; h: number }> {
  await expect(img).toBeVisible();
  await img.evaluate(
    (el) =>
      new Promise<void>((resolve) => {
        const i = el as HTMLImageElement;
        if (i.complete) return resolve();
        i.addEventListener("load", () => resolve(), { once: true });
        i.addEventListener("error", () => resolve(), { once: true });
        setTimeout(() => resolve(), 10_000);
      }),
  );
  const m = await img.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { src: (el as HTMLImageElement).src, natural: (el as HTMLImageElement).naturalWidth, w: r.width, h: r.height };
  });
  return { ...m, nome: nomeNoBucket(m.src) };
}

const linha = (page: Page) => page.getByTestId(`produto-${CODIGO}`);
/** A capa é o `<img>` filho direto da faixa da linha — o painel de fotos é outro `div`. */
const capa = (page: Page) => linha(page).locator(":scope > div > img");
const painel = (page: Page) => page.getByTestId(`fotos-${CODIGO}`);

/** A ordem que a tela mostra, pelo nome do arquivo de cada miniatura. */
async function ordemNaTela(page: Page): Promise<string[]> {
  const srcs = await painel(page).getByTestId("foto-do-produto").locator("img").evaluateAll((els) =>
    els.map((e) => (e as HTMLImageElement).src),
  );
  return srcs.map(nomeNoBucket);
}

async function evidencia(page: Page, info: TestInfo, nome: string): Promise<void> {
  await info.attach(nome, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
}

async function subir(page: Page, nome: string, bytes: Buffer): Promise<number> {
  const resposta = page.waitForResponse(
    (r) => r.request().method() === "POST" && /\/api\/v1\/products\/[^/]+\/fotos$/.test(r.url()),
  );
  await painel(page).getByTestId("arquivo-foto").setInputFiles({ name: nome, mimeType: "image/png", buffer: bytes });
  const r = await resposta;
  produtoId ??= r.url().match(/\/products\/([^/]+)\/fotos$/)?.[1] ?? null;
  return r.status();
}

// ── Casos ──────────────────────────────────────────────────────────────────

test("gerente sobe, recusa não-imagem, reordena e remove fotos pela tela", async ({ page }, info) => {
  await entrar(page, "manager");
  await page.goto("/app/products");
  await expect(page.getByTestId("tela-produtos")).toBeVisible();

  await page.getByTestId("novo-produto").click();
  await expect(page.getByTestId("form-produto")).toBeVisible();
  await page.getByTestId("produto-codigo").fill(CODIGO);
  await page.getByLabel(/^Nome$/).fill("Camiseta com foto");
  await page.getByTestId("produto-preco").fill("59,90");
  await page.getByTestId("salvar-produto").click();
  await expect(page.getByText(/produto cadastrado/i)).toBeVisible({ timeout: 15_000 });
  await expect(linha(page)).toBeVisible({ timeout: 15_000 });
  await expect(capa(page)).toHaveCount(0);

  const botao = page.getByTestId(`abrir-fotos-${CODIGO}`);
  await expect(botao).toHaveText("Fotos (0)");
  // O painel é estado do cliente: um clique antes da hidratação não abre nada.
  await expect(async () => {
    if ((await botao.getAttribute("aria-expanded")) !== "true") await botao.click();
    await expect(painel(page)).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 15_000 });

  // (2) texto com nome de foto: recusado pelos BYTES, com a mensagem de tipo.
  expect(await subir(page, "nao-sou-foto.png", Buffer.from("isto é texto, não imagem\n", "utf8"))).toBe(415);
  await expect(page.getByText("A foto precisa ser JPG ou PNG.")).toBeVisible();
  await expect(painel(page).getByTestId("foto-do-produto")).toHaveCount(0);
  await expect(botao).toHaveText("Fotos (0)");
  await evidencia(page, info, "01-texto-recusado");

  // (3) duas fotos; a primeira vira a capa da linha.
  expect(await subir(page, "vermelha.png", pngSolido([0xd8, 0x1d, 0x1d]))).toBe(200);
  await expect(botao).toHaveText("Fotos (1)", { timeout: 15_000 });
  const capa1 = await medirImagem(capa(page));
  expect(capa1.natural, "a capa não baixou — URL assinada do bucket privado falhou").toBe(LADO);
  expect(Math.round(capa1.w)).toBe(40); // h-10 w-10
  expect(Math.round(capa1.h)).toBe(40);

  expect(await subir(page, "azul.png", pngSolido([0x1d, 0x4e, 0xd8]))).toBe(200);
  await expect(botao).toHaveText("Fotos (2)", { timeout: 15_000 });
  await expect(painel(page).getByTestId("foto-do-produto")).toHaveCount(2);
  const [a, b] = await ordemNaTela(page);
  expect(a).toBe(capa1.nome);
  expect(b).toMatch(/^[0-9a-f-]{36}\.png$/);
  expect(b).not.toBe(a);
  for (const img of await painel(page).getByTestId("foto-do-produto").locator("img").all()) {
    expect((await medirImagem(img)).natural).toBe(LADO);
  }
  const primeira = painel(page).getByTestId("foto-do-produto").first();
  await expect(primeira.getByRole("button", { name: "Mover a foto para a esquerda" })).toBeDisabled();
  await evidencia(page, info, "02-duas-fotos");

  // (4) reordena: a segunda vira capa.
  await primeira.getByRole("button", { name: "Mover a foto para a direita" }).click();
  await expect(page.getByText("Ordem das fotos salva")).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => ordemNaTela(page), { timeout: 15_000 }).toEqual([b, a]);
  await expect.poll(async () => (await medirImagem(capa(page))).nome, { timeout: 15_000 }).toBe(b);
  await evidencia(page, info, "03-reordenada");

  // (5) remove a capa atual; o arquivo sai do bucket, não só da lista.
  const urlDaRemovida = await painel(page).getByTestId("foto-do-produto").first().locator("img").getAttribute("src");
  expect(urlDaRemovida).toBeTruthy();
  expect((await page.request.get(urlDaRemovida!)).ok(), "controle: a URL assinada baixava antes").toBe(true);

  await painel(page).getByTestId("remover-foto").first().click();
  await expect(page.getByText("Foto removida")).toBeVisible({ timeout: 15_000 });
  await expect(botao).toHaveText("Fotos (1)", { timeout: 15_000 });
  await expect.poll(() => ordemNaTela(page), { timeout: 15_000 }).toEqual([a]);
  expect((await medirImagem(capa(page))).nome).toBe(a);
  expect((await page.request.get(urlDaRemovida!)).ok(), "a foto removida continua no bucket").toBe(false);
  await evidencia(page, info, "04-removida");
});

for (const papel of ["viewer", "agent"] as const) {
  test(`${papel} vê a capa, mas não a porta de editar as fotos`, async ({ page }, info) => {
    await entrar(page, papel);
    await page.goto("/app/products");
    await expect(linha(page)).toBeVisible({ timeout: 15_000 });

    const c = await medirImagem(capa(page));
    expect(c.natural).toBe(LADO);
    await expect(page.getByTestId(`abrir-fotos-${CODIGO}`)).toHaveCount(0);
    await expect(painel(page)).toHaveCount(0);
    await evidencia(page, info, `05-${papel}`);
  });
}

test.afterAll(async ({ browser }, info) => {
  if (!produtoId) return;
  const page = await browser.newPage({ baseURL: info.project.use.baseURL });
  await entrar(page, "manager");
  // Apaga o produto, e com ele a foto que sobrou no bucket.
  expect((await page.request.delete(`/api/v1/products/${produtoId}`)).ok()).toBe(true);
  await page.close();
});
