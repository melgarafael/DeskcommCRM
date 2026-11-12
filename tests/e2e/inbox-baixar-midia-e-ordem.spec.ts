import { randomInt, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { deflateSync } from "node:zlib";

import { createClient } from "@supabase/supabase-js";
import { test, expect, type Page } from "./helpers/test";

import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";

/**
 * Fotos e PDFs recebidos: a ORDEM em que aparecem e o BAIXAR (relato de um
 * escritório em 09/11/2026, pela API oficial da Meta).
 *
 * Dois defeitos, provados pela tela:
 *
 *  1. ORDEM. O cliente mandou Foto 1, 2, 3 e PDF 1, 2, 3; o CRM mostrou 3-2-1.
 *     A Meta carimba o envio em SEGUNDOS, então as três ficam com o mesmo
 *     `sent_at`, e o desempate era o `id` — sorteado. Aqui os ids nascem em
 *     ordem INVERSA à da chegada (`created_at`), o pior caso do sorteio: sem o
 *     desempate pela chegada, a tela mostra 3-2-1 e o caso reprova.
 *  2. BAIXAR. A foto não tinha download em ponto nenhum — nem na miniatura, nem
 *     na foto ampliada, nem no menu da mensagem —, e o PDF só pelo ícone do
 *     cartão. O download é medido pelo EVENTO de download do navegador, com o
 *     nome do arquivo salvo e os bytes, não pela presença do botão.
 *
 * Desktop 1366x900: o relato foi no Chrome do Windows.
 */
test.use({ viewport: { width: 1366, height: 900 }, acceptDownloads: true });
test.describe.configure({ timeout: 120_000 });

interface E2ECreds {
  password: string;
  users: Record<string, { id: string; email: string; role: string }>;
}

const creds = JSON.parse(fs.readFileSync(path.join(process.cwd(), ".e2e-creds.json"), "utf8")) as E2ECreds;
const EVIDENCE = path.join(process.cwd(), "evidence", "inbox-baixar-midia-e-ordem");
fs.mkdirSync(EVIDENCE, { recursive: true });

const credenciais = credenciaisSupabaseDeTeste();
const db = createClient(credenciais.url, credenciais.serviceRole, { auth: { persistSession: false } });

const SUFIXO = randomUUID().slice(0, 8);
let orgId = "";
let canal = "";
let contato = "";
let conversa = "";
const caminhos: string[] = [];
const fotos: Array<{ id: string; bytes: Buffer }> = [];
const pdfs: Array<{ id: string; nome: string }> = [];

/** PNG de cor sólida, sem dependência: assinatura + IHDR + IDAT + IEND. */
function png(largura: number, altura: number, [r, g, b]: [number, number, number]): Buffer {
  const crcTabela = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTabela[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const bloco = (tipo: string, dados: Buffer) => {
    const tamanho = Buffer.alloc(4);
    tamanho.writeUInt32BE(dados.length);
    const corpo = Buffer.concat([Buffer.from(tipo, "ascii"), dados]);
    const soma = Buffer.alloc(4);
    soma.writeUInt32BE(crc(corpo));
    return Buffer.concat([tamanho, corpo, soma]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(largura, 0);
  ihdr.writeUInt32BE(altura, 4);
  ihdr[8] = 8; // profundidade
  ihdr[9] = 2; // RGB
  const linha = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: largura }, () => [r, g, b]).flat())]);
  const cru = Buffer.concat(Array.from({ length: altura }, () => linha));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    bloco("IHDR", ihdr),
    bloco("IDAT", deflateSync(cru)),
    bloco("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * Id que, ordenado, sai na ordem INVERSA de `n`: o sorteio no seu pior caso.
 * O prefixo do sufixo do teste mantém os ids únicos entre execuções.
 */
const idInvertido = (grupo: string, n: number) =>
  `${SUFIXO}-${grupo}000-4000-8000-${String(9 - n).padStart(12, "0")}`;

test.beforeAll(async () => {
  const { data, error } = await db
    .from("user_organizations")
    .select("organization_id")
    .eq("user_id", creds.users.agent!.id)
    .limit(1)
    .maybeSingle();
  if (error || !data) throw new Error(`organização do agente: ${error?.message ?? "não achei"}`);
  orgId = (data as { organization_id: string }).organization_id;

  const insere = async (tabela: string, valores: Record<string, unknown>) => {
    const r = await db.from(tabela).insert(valores).select("id").single();
    if (r.error) throw new Error(`${tabela}: ${r.error.message}`);
    return (r.data as { id: string }).id;
  };
  canal = await insere("channel_sessions", {
    organization_id: orgId,
    waha_session_name: `baixar-midia-${SUFIXO}`,
    display_name: `Canal mídia ${SUFIXO}`,
    status: "WORKING",
    webhook_secret_encrypted: "\\x00",
  });
  contato = await insere("contacts", {
    organization_id: orgId,
    name: `Cliente mídia ${SUFIXO}`,
    phone_number: `+5527${randomInt(100000000, 1000000000)}`,
  });
  conversa = await insere("conversations", {
    organization_id: orgId,
    contact_id: contato,
    channel_session_id: canal,
    status: "open",
    last_message_at: new Date().toISOString(),
  });

  // Mesmo segundo para as 3 fotos; mesmo segundo para os 3 PDFs, 30s depois.
  const segundoDasFotos = Math.floor(Date.now() / 1000) * 1000 - 120_000;
  const cores: Array<[number, number, number]> = [[37, 99, 235], [22, 163, 74], [234, 88, 12]];
  const pdfBytes = fs.readFileSync(path.join(process.cwd(), "tests/fixtures/sample-text.pdf"));
  const linhas: Record<string, unknown>[] = [];
  for (const n of [1, 2, 3]) {
    const id = idInvertido("f", n);
    const bytes = png(320, 240, cores[n - 1]!);
    const caminho = `${orgId}/${conversa}/${id}.png`;
    const up = await db.storage.from("whatsapp-media").upload(caminho, bytes, { contentType: "image/png" });
    if (up.error) throw new Error(`upload foto ${n}: ${up.error.message}`);
    caminhos.push(caminho);
    fotos.push({ id, bytes });
    linhas.push({
      id, organization_id: orgId, conversation_id: conversa, contact_id: contato, channel_session_id: canal,
      type: "image", direction: "inbound", status: "received", body: `Foto ${n}`,
      media_mime: "image/png", media_storage_path: caminho, media_size_bytes: bytes.length,
      sent_at: new Date(segundoDasFotos).toISOString(),
      created_at: new Date(segundoDasFotos + 900 + n * 10).toISOString(),
      external_id: `baixar-${SUFIXO}-f${n}`, metadata: {},
    });
  }
  for (const n of [1, 2, 3]) {
    const id = idInvertido("d", n);
    const nome = `documento-teste-${n}.pdf`;
    const caminho = `${orgId}/${conversa}/${id}.pdf`;
    const up = await db.storage.from("whatsapp-media").upload(caminho, pdfBytes, { contentType: "application/pdf" });
    if (up.error) throw new Error(`upload pdf ${n}: ${up.error.message}`);
    caminhos.push(caminho);
    pdfs.push({ id, nome });
    linhas.push({
      id, organization_id: orgId, conversation_id: conversa, contact_id: contato, channel_session_id: canal,
      type: "document", direction: "inbound", status: "received",
      media_mime: "application/pdf", media_storage_path: caminho, media_size_bytes: pdfBytes.length,
      sent_at: new Date(segundoDasFotos + 30_000).toISOString(),
      created_at: new Date(segundoDasFotos + 30_900 + n * 10).toISOString(),
      external_id: `baixar-${SUFIXO}-d${n}`, metadata: { media_filename: nome },
    });
  }
  // Insere na ordem INVERSA também, para nada depender da ordem física.
  const { error: e } = await db.from("messages").insert(linhas.reverse());
  if (e) throw new Error(`messages: ${e.message}`);
});

test.afterAll(async () => {
  if (caminhos.length) await db.storage.from("whatsapp-media").remove(caminhos);
  if (conversa) await db.from("conversations").delete().eq("id", conversa);
  if (contato) await db.from("contacts").delete().eq("id", contato);
  if (canal) await db.from("channel_sessions").delete().eq("id", canal);
});

async function abrirConversa(page: Page): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(creds.users.agent!.email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app\//);
  await page.goto(`/app/inbox?filter=all&id=${conversa}`);
  await expect(page.getByTestId("message-bubble").first()).toBeVisible({ timeout: 30_000 });
}

const bolha = (page: Page, texto: string) =>
  page.getByTestId("message-bubble").filter({ hasText: texto });

test("fotos e PDFs mandados no mesmo segundo aparecem na ordem em que chegaram", async ({ page }) => {
  await abrirConversa(page);
  // Espera as seis bolhas e lê a ordem pelo DOM, de cima para baixo.
  await expect(bolha(page, "documento-teste-3.pdf")).toBeVisible();
  const ordem = await page.getByTestId("message-bubble").evaluateAll((els) =>
    els
      .map((el) => {
        const t = el.textContent ?? "";
        return t.match(/Foto \d|documento-teste-\d\.pdf/)?.[0] ?? null;
      })
      .filter(Boolean),
  );
  expect(ordem).toEqual([
    "Foto 1", "Foto 2", "Foto 3",
    "documento-teste-1.pdf", "documento-teste-2.pdf", "documento-teste-3.pdf",
  ]);
  await bolha(page, "Foto 1").scrollIntoViewIfNeeded();
  // O botão de baixar só aparece com a foto carregada: é o sinal para fotografar.
  await expect(bolha(page, "Foto 1").getByRole("link", { name: "Baixar imagem" })).toBeVisible();
  await expect(bolha(page, "Foto 2").getByRole("link", { name: "Baixar imagem" })).toBeVisible();
  await page.screenshot({ path: path.join(EVIDENCE, "01-ordem-das-fotos.png") });
  await bolha(page, "documento-teste-3.pdf").scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(EVIDENCE, "02-ordem-dos-pdfs.png") });
});

test("a foto baixa pela miniatura, pela foto ampliada e pelo menu, com nome e bytes", async ({ page }) => {
  await abrirConversa(page);
  const foto1 = bolha(page, "Foto 1");
  await foto1.scrollIntoViewIfNeeded();
  const nomeEsperado = new RegExp(`^foto-\\d{4}-\\d{2}-\\d{2}-\\d{2}h\\d{2}-${fotos[0]!.id.replace(/-/g, "").slice(0, 6)}\\.png$`);

  // 1. Miniatura.
  const botao = foto1.getByRole("link", { name: "Baixar imagem" });
  await expect(botao).toBeVisible();
  const caixa = await botao.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const alvo = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { largura: r.width, altura: r.height, noCentro: !!alvo && el.contains(alvo) };
  });
  expect(caixa.noCentro, "nada cobre o botão de baixar da miniatura").toBe(true);
  expect(caixa.largura).toBeGreaterThanOrEqual(24);
  await page.screenshot({ path: path.join(EVIDENCE, "03-miniatura-com-baixar.png") });
  const [d1] = await Promise.all([page.waitForEvent("download"), botao.click()]);
  expect(d1.suggestedFilename()).toMatch(nomeEsperado);
  expect(fs.readFileSync((await d1.path())!)).toEqual(fotos[0]!.bytes);

  // 2. Foto ampliada.
  await foto1.getByRole("button", { name: "Ampliar imagem" }).click();
  const dialogo = page.getByRole("dialog");
  const baixarAmpliada = dialogo.getByRole("link", { name: "Baixar", exact: true });
  await expect(baixarAmpliada).toBeVisible();
  await page.screenshot({ path: path.join(EVIDENCE, "04-foto-ampliada-com-baixar.png") });
  const [d2] = await Promise.all([page.waitForEvent("download"), baixarAmpliada.click()]);
  expect(d2.suggestedFilename()).toMatch(nomeEsperado);
  await page.keyboard.press("Escape");
  await expect(dialogo).toBeHidden();

  // 3. Menu "Opções da mensagem".
  const foto2 = bolha(page, "Foto 2");
  await foto2.hover();
  await foto2.getByRole("button", { name: "Opções da mensagem" }).click();
  const item = page.getByRole("menuitem", { name: "Baixar", exact: true });
  await expect(item).toBeVisible();
  await page.screenshot({ path: path.join(EVIDENCE, "05-menu-da-foto-com-baixar.png") });
  const [d3] = await Promise.all([page.waitForEvent("download"), item.click()]);
  expect(d3.suggestedFilename()).toMatch(
    new RegExp(`-${fotos[1]!.id.replace(/-/g, "").slice(0, 6)}\\.png$`),
  );
  expect(fs.readFileSync((await d3.path())!)).toEqual(fotos[1]!.bytes);
});

test("o PDF também tem 'Baixar' no menu, com o nome original", async ({ page }) => {
  await abrirConversa(page);
  const pdf = bolha(page, "documento-teste-2.pdf");
  await pdf.scrollIntoViewIfNeeded();
  await pdf.hover();
  await pdf.getByRole("button", { name: "Opções da mensagem" }).click();
  const item = page.getByRole("menuitem", { name: "Baixar", exact: true });
  await expect(item).toBeVisible();
  await page.screenshot({ path: path.join(EVIDENCE, "06-menu-do-pdf-com-baixar.png") });
  const [d] = await Promise.all([page.waitForEvent("download"), item.click()]);
  expect(d.suggestedFilename()).toBe("documento-teste-2.pdf");
});
