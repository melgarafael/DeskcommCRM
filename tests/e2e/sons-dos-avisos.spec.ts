/**
 * OS SONS DOS AVISOS, provados pela tela (migration 0441).
 *
 * Duas pessoas da mesma organização, como numa loja que vende pelo WhatsApp:
 *
 *   - a GESTORA abre Configurações › Notificações, sobe um som para «Precisa
 *     de uma pessoa», vê que um arquivo que não é áudio é recusado, e volta ao
 *     som do sistema;
 *   - a VISUALIZADORA vê a seção e pode ouvir, mas não vê o botão de trocar
 *     (a rota recusaria: trocar é de gestor para cima).
 *
 * E o efeito: com o site aberto, um aviso NOVO que pede gente faz a campainha
 * tocar — o som escolhido para a passagem para pessoa, o bipe do produto para
 * a etapa que avisa — e abrir a página com avisos antigos não toca nada.
 *
 * ⚠️ COMO O SOM É MEDIDO. Navegador sem alto-falante não "ouve"; a spec troca,
 * antes de a página carregar, `HTMLMediaElement.prototype.play` (o arquivo da
 * organização) e `AudioContext.prototype.createOscillator` (o bipe do produto)
 * por versões que ANOTAM a chamada. É a mesma chamada que tocaria o som — a
 * decisão de tocar, qual som e quando são do produto, não da spec.
 *
 * ⚠️ O QUE É SETUP: organização, usuários e os avisos da Central são criados
 * pela service role no Supabase local. Os avisos nascem como nasceriam pelos
 * produtores (passagem para pessoa; o título do aviso de etapa é o que
 * `tituloDoAvisoDeEtapa` monta) — quem os produz de verdade tem spec própria.
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { createClient } from "@supabase/supabase-js";

import { test, expect, type Page } from "./helpers/test";
import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";

const credenciais = credenciaisSupabaseDeTeste();
const db = createClient(credenciais.url, credenciais.serviceRole, { auth: { persistSession: false } });

const EVIDENCIA = path.join(process.cwd(), "evidence", "sons-dos-avisos");
fs.mkdirSync(EVIDENCIA, { recursive: true });

const ESPERA = 60_000;
const SENHA = `Local-${randomUUID()}!`;
const SUFIXO = randomUUID().slice(0, 8);

const usuarios: Record<"manager" | "viewer", { id: string; email: string }> = {
  manager: { id: "", email: "" },
  viewer: { id: "", email: "" },
};
let orgId = "";

/** Um WAV de verdade: cabeçalho RIFF/WAVE + 0,1 s de silêncio, 8 kHz mono 8 bits. */
function wav(): Buffer {
  const amostras = 800;
  const b = Buffer.alloc(44 + amostras, 0x80);
  b.write("RIFF", 0, "ascii");
  b.writeUInt32LE(36 + amostras, 4);
  b.write("WAVE", 8, "ascii");
  b.write("fmt ", 12, "ascii");
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(8000, 24);
  b.writeUInt32LE(8000, 28);
  b.writeUInt16LE(1, 32);
  b.writeUInt16LE(8, 34);
  b.write("data", 36, "ascii");
  b.writeUInt32LE(amostras, 40);
  return b;
}

async function entrar(page: Page, quem: keyof typeof usuarios): Promise<void> {
  await page.goto("/login");
  await page.getByLabel(/e-?mail/i).fill(usuarios[quem].email);
  await page.getByLabel(/senha/i).fill(SENHA);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app(?:\/|$)/, { timeout: ESPERA });
}

async function sonsGravados(): Promise<Record<string, string>> {
  const { data, error } = await db.from("organizations").select("settings").eq("id", orgId).single();
  if (error) throw error;
  return ((data as { settings?: { sons_de_aviso?: Record<string, string> } }).settings?.sons_de_aviso ?? {});
}

async function arquivosNoBucket(): Promise<string[]> {
  const { data, error } = await db.storage.from("org-sounds").list(orgId);
  if (error) throw error;
  return (data ?? []).map((o) => `${orgId}/${o.name}`);
}

test.beforeAll(async () => {
  for (const papel of ["manager", "viewer"] as const) {
    const email = `sons-${papel}-${SUFIXO}@invariant.test`;
    const { data, error } = await db.auth.admin.createUser({ email, password: SENHA, email_confirm: true });
    if (error || !data.user) throw error ?? new Error("usuário não nasceu");
    usuarios[papel] = { id: data.user.id, email };
  }
  const { data: org, error } = await db
    .from("organizations")
    .insert({ slug: `sons-${SUFIXO}`, legal_name: `Loja ${SUFIXO}`, display_name: `Loja ${SUFIXO}`, onboarded_at: new Date().toISOString() })
    .select("id")
    .single();
  if (error) throw error;
  orgId = (org as { id: string }).id;
  for (const papel of ["manager", "viewer"] as const) {
    const { error: e } = await db.from("user_organizations").insert({
      organization_id: orgId, user_id: usuarios[papel].id, role: papel, accepted_at: new Date().toISOString(),
    });
    if (e) throw e;
  }
});

test.afterAll(async () => {
  const restantes = orgId ? await arquivosNoBucket().catch(() => []) : [];
  if (restantes.length) await db.storage.from("org-sounds").remove(restantes);
  if (orgId) await db.from("organizations").delete().eq("id", orgId);
  for (const u of Object.values(usuarios)) if (u.id) await db.auth.admin.deleteUser(u.id);
});

test.describe.configure({ mode: "serial" });

test("a gestora troca o som, o arquivo que não é áudio é recusado, e volta ao do sistema", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await entrar(page, "manager");
  await page.goto("/app/settings/notifications");

  const secao = page.getByTestId("sons-dos-avisos");
  await expect(secao).toBeVisible({ timeout: ESPERA });
  await expect(secao).toContainText("Etapa que avisa");
  await expect(secao).toContainText("Precisa de uma pessoa");
  await expect(page.getByTestId("som-pessoa-estado")).toHaveText("Som do sistema");

  // Um arquivo de texto com nome .mp3: recusado pelos bytes, nada muda.
  await page.getByTestId("som-pessoa-arquivo").setInputFiles({
    name: "nao-e-audio.mp3", mimeType: "audio/mpeg", buffer: Buffer.from("isto não é áudio nenhum, só texto"),
  });
  await expect(page.getByText("O som precisa ser MP3, OGG ou WAV.")).toBeVisible({ timeout: ESPERA });
  await expect(page.getByTestId("som-pessoa-estado")).toHaveText("Som do sistema");
  expect(await sonsGravados()).toEqual({});

  // Um WAV de verdade: entra, sob a pasta da organização.
  await page.getByTestId("som-pessoa-arquivo").setInputFiles({ name: "campainha.wav", mimeType: "audio/wav", buffer: wav() });
  await expect(page.getByTestId("som-pessoa-estado")).toHaveText("Som personalizado", { timeout: ESPERA });
  const gravado = (await sonsGravados()).pessoa;
  expect(gravado).toMatch(new RegExp(`^${orgId}/pessoa-[0-9a-f-]{36}\\.wav$`));
  expect(await arquivosNoBucket()).toEqual([gravado]);
  await page.screenshot({ path: path.join(EVIDENCIA, "01-som-personalizado.png"), fullPage: true });

  // Volta ao do sistema: a chave sai e o arquivo também.
  await page.getByTestId("som-pessoa").getByRole("button", { name: "Usar o do sistema" }).click();
  await expect(page.getByTestId("som-pessoa-estado")).toHaveText("Som do sistema", { timeout: ESPERA });
  expect(await sonsGravados()).toEqual({});
  expect(await arquivosNoBucket()).toEqual([]);

  // Deixa um som escolhido para o próximo teste medir a campainha.
  await page.getByTestId("som-pessoa-arquivo").setInputFiles({ name: "campainha.wav", mimeType: "audio/wav", buffer: wav() });
  await expect(page.getByTestId("som-pessoa-estado")).toHaveText("Som personalizado", { timeout: ESPERA });
});

test("a visualizadora ouve, mas não vê como trocar", async ({ page }) => {
  test.setTimeout(120_000);
  await entrar(page, "viewer");
  await page.goto("/app/settings/notifications");
  const linha = page.getByTestId("som-pessoa");
  await expect(linha).toBeVisible({ timeout: ESPERA });
  await expect(page.getByTestId("som-pessoa-estado")).toHaveText("Som personalizado");
  await expect(linha.getByRole("button", { name: "Ouvir" })).toBeVisible();
  await expect(linha.getByText("Trocar som")).toHaveCount(0);
  await expect(linha.getByRole("button", { name: "Usar o do sistema" })).toHaveCount(0);
  await page.screenshot({ path: path.join(EVIDENCIA, "02-visualizadora.png"), fullPage: true });
});

test("com o site aberto, o aviso NOVO que pede gente toca; o antigo não", async ({ page }) => {
  test.setTimeout(240_000);
  // Antigo: já estava lá quando a página abriu — não pode tocar.
  const { error: e0 } = await db.from("agent_inbox_items").insert({
    organization_id: orgId, kind: "handoff", severity: "warn", title: "Passagem antiga", ref_kind: "conversation", ref_id: randomUUID(),
  });
  if (e0) throw e0;

  await page.addInitScript(() => {
    const w = window as unknown as { __arquivos: string[]; __bipes: number };
    w.__arquivos = [];
    w.__bipes = 0;
    HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
      w.__arquivos.push(this.src);
      return Promise.resolve();
    };
    const Ctx = window.AudioContext;
    if (Ctx) {
      const original = Ctx.prototype.createOscillator;
      Ctx.prototype.createOscillator = function (this: AudioContext) {
        w.__bipes += 1;
        return original.call(this);
      };
    }
  });
  await entrar(page, "manager");
  await page.goto("/app/settings/notifications");
  await expect(page.getByTestId("alerts-bell")).toBeVisible({ timeout: ESPERA });
  // A primeira leitura da Central marca tudo como visto.
  await page.waitForResponse((r) => r.url().includes("/api/v1/ai/inbox") && r.ok(), { timeout: ESPERA }).catch(() => null);
  await page.waitForTimeout(2_000);
  const medir = () => page.evaluate(() => {
    const w = window as unknown as { __arquivos: string[]; __bipes: number };
    return { arquivos: [...w.__arquivos], bipes: w.__bipes };
  });
  expect(await medir(), "abrir a página com aviso antigo não toca nada").toEqual({ arquivos: [], bipes: 0 });

  // Novo: a IA passou uma conversa para uma pessoa → o som escolhido.
  const { error: e1 } = await db.from("agent_inbox_items").insert({
    organization_id: orgId, kind: "handoff", severity: "warn", title: "Passagem nova", ref_kind: "conversation", ref_id: randomUUID(),
  });
  if (e1) throw e1;
  await expect.poll(async () => (await medir()).arquivos.length, { timeout: 75_000, intervals: [2_000] }).toBe(1);
  const tocado = (await medir()).arquivos[0]!;
  expect(tocado, "toca o arquivo da organização, por URL assinada").toContain(`/org-sounds/${orgId}/pessoa-`);

  // Novo: um negócio entrou numa etapa que avisa → sem arquivo, o bipe do produto.
  const { error: e2 } = await db.from("agent_inbox_items").insert({
    organization_id: orgId, kind: "other", severity: "info", title: "Negócio entrou em «Pedido confirmado»", ref_kind: "lead", ref_id: randomUUID(),
  });
  if (e2) throw e2;
  await expect.poll(async () => (await medir()).bipes, { timeout: 75_000, intervals: [2_000] }).toBeGreaterThan(0);
  expect((await medir()).arquivos, "o som da passagem não toca de novo").toHaveLength(1);
});

// O gatilho real emite o evento e o Realtime entrega um primeiro UPDATE sem
// histórico na aba. O teste não injeta callback, payload de socket nem toast.
test("atribuição, ganho e perda sem histórico chegam do banco e aparecem no app", async ({ page }) => {
  test.setTimeout(180_000);
  const evidencia = path.join(process.cwd(), "evidence", "atendimento-cercas");
  fs.mkdirSync(evidencia, { recursive: true });
  async function inserir(tabela: string, valores: Record<string, unknown>): Promise<string> {
    const r = await db.from(tabela).insert(valores).select("id").single();
    if (r.error) throw r.error;
    return r.data.id as string;
  }
  const funil = await inserir("crm_pipelines", { organization_id: orgId, name: "Avisos sem histórico", slug: `avisos-${randomUUID().replaceAll("-", "")}` });
  const etapas = {
    open: await inserir("crm_stages", { organization_id: orgId, pipeline_id: funil, name: "Entrada", slug: "entrada", position: 1 }),
    won: await inserir("crm_stages", { organization_id: orgId, pipeline_id: funil, name: "Ganho", slug: "ganho", position: 2, is_won: true }),
    lost: await inserir("crm_stages", { organization_id: orgId, pipeline_id: funil, name: "Perda", slug: "perda", position: 3, is_lost: true }),
  };
  const criados: string[] = [];
  await entrar(page, "manager");
  try {
    for (const [status, titulo] of [["open", "Lead atribuído a você"], ["won", "Lead ganho"], ["lost", "Lead perdido"]] as const) {
      const nome = `Primeira mudança ${status} ${randomUUID().slice(0, 8)}`;
      const lead = await inserir("crm_leads", {
        organization_id: orgId, pipeline_id: funil, stage_id: etapas.open, title: nome,
        owner_user_id: null, status: "open",
      });
      criados.push(lead);
      // O socket do documento anterior não pode confirmar a nova navegação.
      await page.goto("about:blank");
      // Espera o phx_reply do canal exato; um socket aberto não prova assinatura.
      let canalAssinado = false;
      page.on("websocket", socket => {
        socket.on("framereceived", frame => {
          try {
            const msg = JSON.parse(String(frame.payload)) as unknown;
            const topico = Array.isArray(msg) ? msg[2] : (msg as { topic?: unknown }).topic;
            const evento = Array.isArray(msg) ? msg[3] : (msg as { event?: unknown }).event;
            const payload = (Array.isArray(msg) ? msg[4] : (msg as { payload?: unknown }).payload) as { status?: string } | undefined;
            if (typeof topico === "string" && topico.includes(`alerts-leads-${orgId}`) && evento === "phx_reply" && payload?.status === "ok") canalAssinado = true;
          } catch { /* frame sem JSON não é a confirmação esperada */ }
        });
      });
      await page.goto(`/app/pipelines/${funil}`);
      await expect(page.getByText(nome, { exact: true }).first()).toBeVisible({ timeout: ESPERA });
      await expect.poll(() => canalAssinado, { timeout: ESPERA }).toBe(true);
      const consulta = page.waitForResponse(r => r.url().endsWith(`/leads/${lead}/eventos`) && r.request().method() === "GET");
      const mudanca = await db.from("crm_leads").update({
        owner_user_id: usuarios.manager.id, owner_kind: "user", stage_id: etapas[status],
        ...(status === "lost" ? { lost_reason: "other" } : {}),
      }).eq("organization_id", orgId).eq("id", lead).select("updated_at,status,closed_at").single();
      expect(mudanca.error).toBeNull();
      expect(mudanca.data?.status).toBe(status);
      if (status === "open") expect(mudanca.data?.closed_at).toBeNull();
      else expect(mudanca.data?.closed_at).toEqual(expect.any(String));
      const resposta = await consulta;
      expect(resposta.status()).toBe(200);
      const corpo = await resposta.json() as { data: { eventos: { event_type: string; created_at: string }[] } };
      const esperado = status === "open" ? "lead.assigned" : `lead.${status}`;
      expect(corpo.data.eventos.some(e => e.event_type === esperado)).toBe(true);
      // A decisão aplicada pelo browser também comprova a igualdade entre os
      // carimbos reais dos dois transportes, inclusive a precisão do Postgres.
      const aviso = page.locator("[data-sonner-toast]").filter({ hasText: titulo }).filter({ hasText: nome });
      await expect(aviso).toBeVisible({ timeout: ESPERA });
      await page.screenshot({ path: path.join(evidencia, `aviso-${status}-sem-historico.png`), fullPage: true });
    }
  } finally {
    if (criados.length) expect((await db.from("crm_leads").delete().eq("organization_id", orgId).in("id", criados)).error).toBeNull();
    expect((await db.from("crm_stages").delete().eq("organization_id", orgId).eq("pipeline_id", funil)).error).toBeNull();
    expect((await db.from("crm_pipelines").delete().eq("organization_id", orgId).eq("id", funil)).error).toBeNull();
  }
});
