/**
 * Quatro contas reais e dois tenants sintéticos, sem leitura de .env ou dumps.
 * Requer app de produção e Supabase local com baseline aplicado. O app deve
 * apontar WAHA_API_BASE_URL para o receptor local que esta spec abre, como
 * encerramento-atendimento.spec.ts. Nenhuma chamada vai a um canal externo.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { createClient } from "@supabase/supabase-js";

import { test, expect, esperarARevelacao, type Page, type BrowserContext } from "./helpers/test";

function ambienteSintetico(appUrl: string | undefined) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const receptor = process.env.WAHA_API_BASE_URL;
  if (!appUrl || !url || !serviceRole || !receptor) throw new Error("Defina o app, Supabase e WAHA_API_BASE_URL da bancada sintética no ambiente.");
  for (const endereco of [appUrl, url, receptor]) {
    const host = new URL(endereco).hostname;
    if (!["localhost", "127.0.0.1", "[::1]"].includes(host)) {
      throw new Error("Esta prova só aceita Supabase e receptor locais.");
    }
  }
  return { appUrl, url, serviceRole, receptor: new URL(receptor) };
}

async function navegar(page: Page, url: string) {
  await page.goto(url);
  await esperarARevelacao(page);
}

test("convite chega em Minhas, permite resposta e revogação retira o acesso sem trocar o dono", async ({ browser, baseURL }) => {
  test.setTimeout(180_000);
  const ambiente = ambienteSintetico(baseURL);
  const db = createClient(ambiente.url, ambiente.serviceRole, { auth: { persistSession: false } });
  const prefixo = randomUUID().slice(0, 8);
  const senha = `Conjunto-${randomUUID()}!`;
  const nome = `Cliente Conjunto ${prefixo}`;
  const nomeConvidada = `Convidada ${prefixo}`;
  const evidencia = "evidence/atendimento-conjunto-2848";
  const usuarios: string[] = [];
  const contextos: BrowserContext[] = [];
  const organizacoes: string[] = [];
  const envios: string[] = [];
  const sessoes: string[] = [];
  const receiver = createServer((req, res) => {
    const partes: Buffer[] = [];
    req.on("data", (p: Buffer) => partes.push(p));
    req.on("end", () => {
      const corpo = Buffer.concat(partes).toString();
      if (req.url?.includes("/sendText")) envios.push(corpo);
      res.writeHead(200, { "content-type": "application/json" });
      const resposta = req.method === "GET" && req.url?.endsWith("/sessions")
        ? sessoes.map((session) => ({ name: session, status: "WORKING" }))
        : { id: `conjunto-${randomUUID()}`, status: "WORKING" };
      res.end(JSON.stringify(resposta));
    });
  });
  await new Promise<void>((resolve, reject) => {
    receiver.once("error", reject);
    receiver.listen(Number(ambiente.receptor.port), ambiente.receptor.hostname.replace(/^\[|\]$/g, ""), resolve);
  });

  async function inserir(tabela: string, dados: Record<string, unknown>): Promise<string> {
    const { data, error } = await db.from(tabela).insert(dados).select("id").single();
    if (error) throw new Error(`${tabela}: ${error.message}`);
    return data.id as string;
  }
  async function conta(papel: "manager" | "agent" | "viewer", rotulo: string, org: string) {
    const email = `conjunto-${rotulo}-${prefixo}@invariant.test`;
    const { data, error } = await db.auth.admin.createUser({ email, password: senha, email_confirm: true, user_metadata: { full_name: rotulo === "convidada" ? nomeConvidada : `${rotulo} ${prefixo}` } });
    if (error || !data.user) throw new Error("Não foi possível criar a conta sintética.");
    usuarios.push(data.user.id);
    const vinculo = await db.from("user_organizations").insert({ organization_id: org, user_id: data.user.id, role: papel, accepted_at: new Date().toISOString() });
    if (vinculo.error) throw new Error(vinculo.error.message);
    const contexto = await browser.newContext({ baseURL: ambiente.appUrl, viewport: { width: 1440, height: 1000 } });
    contextos.push(contexto);
    const page = await contexto.newPage();
    await navegar(page, "/login");
    await page.locator("#email").fill(email);
    await page.locator("#password").fill(senha);
    await page.getByRole("button", { name: "Entrar", exact: true }).click();
    await page.waitForURL(/\/app/);
    await esperarARevelacao(page);
    return { id: data.user.id, page };
  }
  async function captura(page: Page, arquivo: string) {
    mkdirSync(evidencia, { recursive: true });
    await page.screenshot({ path: `${evidencia}/${arquivo}.png`, fullPage: true });
  }

  try {
    const org = await inserir("organizations", { slug: `conjunto-${prefixo}`, display_name: `Conjunto ${prefixo}`, legal_name: "Organização sintética", onboarded_at: new Date().toISOString(), settings: { visibility_mode: "own" }, interface_settings: { preset: "completa", bloquearAteAssumir: true } });
    organizacoes.push(org);
    const vizinha = await inserir("organizations", { slug: `conjunto-vizinha-${prefixo}`, display_name: "Vizinha sintética", legal_name: "Vizinha sintética", onboarded_at: new Date().toISOString(), settings: { visibility_mode: "own" } });
    organizacoes.push(vizinha);
    const gestor = await conta("manager", "gestor", org);
    const convidada = await conta("agent", "convidada", org);
    const semConvite = await conta("agent", "sem-convite", org);
    const viewer = await conta("viewer", "viewer", org);

    async function conversa(organization: string, displayName: string) {
      const session = `conjunto-${randomUUID()}`;
      sessoes.push(session);
      const canal = await inserir("channel_sessions", { organization_id: organization, waha_session_name: session, display_name: "Canal sintético", status: "WORKING", webhook_secret_encrypted: "\\x00" });
      const contato = await inserir("contacts", { organization_id: organization, display_name: displayName, phone_number: "+5511999902542" });
      const id = await inserir("conversations", { organization_id: organization, contact_id: contato, channel_session_id: canal, assigned_to_user_id: gestor.id, assignee_kind: "user", status: "claimed", bot_silenced_until: "infinity", last_inbound_at: new Date().toISOString() });
      const mensagem = await inserir("messages", { organization_id: organization, conversation_id: id, contact_id: contato, channel_session_id: canal, direction: "inbound", type: "text", status: "received", body: `Contexto sintético ${prefixo}`, sent_via: "external_device", sent_at: new Date().toISOString() });
      return { id, mensagem };
    }
    const principal = await conversa(org, nome);
    const outra = await conversa(vizinha, "Cliente vizinho sintético");
    async function esperarContagemMinhas(quantidade: number) {
      await expect.poll(async () => {
        const resposta = await convidada.page.request.get("/api/v1/conversations/counts");
        expect(resposta.status()).toBe(200);
        const corpo = await resposta.json() as { data: { mine: number } };
        return corpo.data.mine;
      }).toBe(quantidade);
    }
    await navegar(gestor.page, `/app/inbox?id=${principal.id}`);
    await navegar(convidada.page, "/app/inbox");
    await convidada.page.getByRole("tab", { name: /Minhas/ }).click();
    // O zero vem da API real; a UX canônica omite o badge quando ele é zero.
    await esperarContagemMinhas(0);
    await expect(convidada.page.getByRole("tab", { name: /Minhas/ })).toHaveText("Minhas");
    await expect(convidada.page.getByText(nome, { exact: true })).toHaveCount(0);
    expect((await convidada.page.request.get(`/api/v1/conversations/${principal.id}`)).status()).toBe(404);

    async function convidar() {
      await gestor.page.getByTestId("convidar-participante").click();
      await gestor.page.getByTestId("select-colega").click();
      await gestor.page.getByRole("option", { name: nomeConvidada, exact: true }).click();
      const resposta = gestor.page.waitForResponse((r) => r.url().endsWith(`/conversations/${principal.id}/participants`) && r.request().method() === "POST");
      await gestor.page.getByTestId("confirmar-convite").click();
      expect((await resposta).status()).toBe(201);
    }
    await convidar();
    // Sem goto/reload/link na convidada: é a entrega em outra sessão aberta.
    const linhaConvidada = convidada.page.locator(`[data-conversation-id="${principal.id}"]`);
    await expect(linhaConvidada).toBeVisible({ timeout: 15_000 });
    await esperarContagemMinhas(1);
    await expect(convidada.page.getByRole("tab", { name: /Minhas/ })).toContainText("1");
    await linhaConvidada.click();
    await expect(convidada.page.getByText(`Contexto sintético ${prefixo}`, { exact: true })).toBeVisible();
    const caixa = convidada.page.getByPlaceholder("Escreva uma mensagem…", { exact: true });
    await expect(caixa).toBeEnabled();
    const areaDaResposta = await caixa.boundingBox();
    expect(areaDaResposta?.width).toBeGreaterThan(160);
    expect(areaDaResposta?.height).toBeGreaterThan(0);
    const respostaTexto = `Resposta conjunta ${prefixo}`;
    await caixa.fill(respostaTexto);
    await caixa.press("Enter");
    await expect.poll(() => envios.filter((e) => e.includes(respostaTexto)).length).toBe(1);
    const enviada = await db.from("messages").select("sent_by_user_id").eq("organization_id", org).eq("conversation_id", principal.id).eq("body", respostaTexto).single();
    expect(enviada.error).toBeNull();
    expect(enviada.data?.sent_by_user_id).toBe(convidada.id);
    expect((await convidada.page.request.post(`/api/v1/conversations/${principal.id}/close`, { data: {} })).status()).toBe(403);
    expect((await convidada.page.request.patch(`/api/v1/conversations/${principal.id}`, { data: { status: "closed" } })).status()).toBe(403);
    await captura(convidada.page, "01-convidada-responde-sem-assumir");

    await navegar(semConvite.page, "/app/inbox");
    await semConvite.page.getByRole("tab", { name: /Minhas/ }).click();
    await expect(semConvite.page.getByText(nome, { exact: true })).toHaveCount(0);
    expect((await semConvite.page.request.get(`/api/v1/conversations/${principal.id}`)).status()).toBe(404);
    expect((await semConvite.page.request.post("/api/v1/messages", { data: { conversation_id: principal.id, type: "text", body: "Sem convite não envia" } })).status()).toBe(404);
    await navegar(viewer.page, `/app/inbox?id=${principal.id}`);
    await expect(viewer.page.getByText(`Contexto sintético ${prefixo}`, { exact: true })).toBeVisible();
    await expect(viewer.page.getByTestId("convidar-participante")).toHaveCount(0);
    expect((await viewer.page.request.post("/api/v1/messages", { data: { conversation_id: principal.id, type: "text", body: "Viewer não envia" } })).status()).toBe(403);
    for (const pessoa of [gestor, convidada, semConvite, viewer]) {
      expect((await pessoa.page.request.get(`/api/v1/conversations/${outra.id}`)).status()).toBe(404);
    }
    await captura(viewer.page, "02-viewer-leitura");
    await captura(semConvite.page, "03-sem-convite");

    const gestaoDaParticipante = gestor.page.getByRole("button", { name: `Quem participa desta conversa: ${nomeConvidada}`, exact: true });
    const areaDoGesto = await gestaoDaParticipante.boundingBox();
    expect(areaDoGesto?.width).toBeGreaterThanOrEqual(44);
    expect(areaDoGesto?.height).toBeGreaterThanOrEqual(44);
    await gestaoDaParticipante.click();
    await gestor.page.getByRole("menuitem", { name: "Remover participante", exact: true }).click();
    await expect(linhaConvidada).toHaveCount(0, { timeout: 15_000 });
    await esperarContagemMinhas(0);
    await expect(convidada.page.getByRole("tab", { name: /Minhas/ })).toHaveText("Minhas");
    await expect(convidada.page.getByText("Conversa não encontrada ou fora do seu acesso.", { exact: true })).toBeVisible();
    expect((await convidada.page.request.get(`/api/v1/conversations/${principal.id}`)).status()).toBe(404);
    expect((await convidada.page.request.post("/api/v1/messages", { data: { conversation_id: principal.id, type: "text", body: "Convite revogado não envia" } })).status()).toBe(404);
    await convidar();
    await expect(linhaConvidada).toBeVisible({ timeout: 15_000 });
    const vinculos = await db.from("conversation_participants").select("id, left_at").eq("organization_id", org).eq("conversation_id", principal.id).eq("user_id", convidada.id);
    expect(vinculos.error).toBeNull();
    expect(vinculos.data).toHaveLength(1);
    expect(vinculos.data?.[0]?.left_at).toBeNull();
    const atual = await db.from("conversations").select("assigned_to_user_id, status").eq("organization_id", org).eq("id", principal.id).single();
    expect(atual.error).toBeNull();
    expect(atual.data?.assigned_to_user_id).toBe(gestor.id);
    expect(atual.data?.status).toBe("claimed");
    const auditoria = await db.from("api_audit_log").select("action").eq("organization_id", org).eq("resource_id", principal.id).in("action", ["conversation.invited", "conversation.participant_removed"]);
    expect(auditoria.error).toBeNull();
    expect(auditoria.data?.filter((a) => a.action === "conversation.invited")).toHaveLength(2);
    expect(auditoria.data?.filter((a) => a.action === "conversation.participant_removed")).toHaveLength(1);
    expect(envios.filter((e) => e.includes(respostaTexto))).toHaveLength(1);
    await captura(gestor.page, "04-gestor-reconvida-dono-preservado");
  } finally {
    await Promise.all(contextos.map((c) => c.close()));
    await new Promise<void>((resolve) => receiver.close(() => resolve()));
    for (const org of organizacoes.reverse()) await db.from("organizations").delete().eq("id", org);
    for (const id of usuarios) await db.auth.admin.deleteUser(id);
  }
});
