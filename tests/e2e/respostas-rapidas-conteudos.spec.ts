/** Cadastro/edição/envio reais; somente o fornecedor do canal é HTTP sintético. */
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { Pool, type PoolClient } from "pg";

import { test, expect, esperarARevelacao } from "./helpers/test";
import { finalizarProvaComEvidencia } from "./helpers/finalizar-prova-com-evidencia";
import { destinoEhLocal } from "../../scripts/lib/env-de-teste";
import { midiaPertenceAoTemplate, type MidiaDeTemplate } from "../../lib/templates/midias";
import { isMediaPathInOrganization, isMediaPathOwnedBy } from "../../lib/messaging/media/upload-validation";

// Preview de mensagens busca URLs assinadas. Só esta spec desliga os arquivos
// que poderiam arquivá-las; PNG e recibo sanitizado permanecem antes da limpeza.
test.use({ trace: "off", video: "off", viewport: { width: 1280, height: 960 } });

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64");

/** WAV/PCM mono válido e sintético, sem depender de serviço ou arquivo externo. */
function audioSintetico(frequencia = 440): Buffer {
  const amostras = 2000;
  const wav = Buffer.alloc(44 + amostras * 2);
  wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write("data", 36); wav.writeUInt32LE(amostras * 2, 40);
  for (let i = 0; i < amostras; i++) wav.writeInt16LE(Math.round(1200 * Math.sin(i * Math.PI * 2 * frequencia / 8000)), 44 + i * 2);
  return wav;
}

interface Modelo {
  id: string; organization_id: string; title: string; body: string;
  midias: MidiaDeTemplate[]; updated_at: string;
}
const COMBINACOES = [
  { tipo: "texto", texto: true, imagem: false, audio: false },
  { tipo: "imagem", texto: false, imagem: true, audio: false },
  { tipo: "audio", texto: false, imagem: false, audio: true },
  { tipo: "texto+imagem", texto: true, imagem: true, audio: false },
  { tipo: "texto+audio", texto: true, imagem: false, audio: true },
  { tipo: "imagem+audio", texto: false, imagem: true, audio: true },
  { tipo: "texto+imagem+audio", texto: true, imagem: true, audio: true },
] as const;

test("sete combinações e edição de áudio no teto5 conservam bytes e snapshot", async ({ page, baseURL }, testInfo) => {
  test.setTimeout(300_000);
  page.setDefaultTimeout(10_000);
  page.setDefaultNavigationTimeout(20_000);
  const inicio = performance.now();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  const receptorUrl = process.env.WAHA_API_BASE_URL ?? "";
  const dbUrl = process.env.SUPABASE_DB_URL ?? "";
  expect(Boolean(baseURL && url && anon && serviceRole && receptorUrl && dbUrl), "ambiente explícito incompleto").toBe(true);
  for (const alvo of [baseURL!, url, receptorUrl, dbUrl, process.env.SUPABASE_SERVER_URL || url]) {
    expect(destinoEhLocal(alvo), "a prova exige destinos locais").toBe(true);
  }
  let sinalDaLimpeza: AbortSignal | undefined;
  const fetchComPrazo: typeof fetch = (alvo, opcoes) => fetch(alvo, {
    ...opcoes,
    signal: AbortSignal.any([AbortSignal.timeout(10_000),
      ...(opcoes?.signal ? [opcoes.signal] : []), ...(sinalDaLimpeza ? [sinalDaLimpeza] : [])]),
  });
  // Só os clientes desta bancada: prazo inclui Auth/Storage e não repete uma
  // falha transitória durante a limpeza. O transporte do app continua real.
  const opcoes = { auth: { persistSession: false, autoRefreshToken: false },
    db: { timeout: 10_000, retry: false }, global: { fetch: fetchComPrazo } };
  const admin = createClient(url, serviceRole, opcoes);
  const sessao = createClient(url, anon, opcoes);
  const sufixo = randomUUID().slice(0, 8);
  const nomeDaSessao = `rr-3538-${sufixo}`;
  const email = `rr-3538-${sufixo}@invariant.test`;
  const senha = `Sintetica-${randomUUID()}!`;
  const wav = audioSintetico();
  const pasta = path.join(process.cwd(), "evidence", "respostas-rapidas-3538");
  mkdirSync(pasta, { recursive: true });
  const modelos = new Map<string, string>();
  const envios: Array<{ tipo: string; texto: string }> = [];
  const origensStorage = new Set([new URL(url).origin, new URL(process.env.SUPABASE_SERVER_URL || url).origin]);
  let org = "", outraOrg = "", usuario = "", canal = "", contato = "", conversa = "";
  let falhaDoReceptor = false;
  const recibo = { fase: "fixtures", postgrestReal: false, seteCadastros: false, seteEnvios: false,
    bytesReais: false, trocaNoTeto: false, trocaComImagemRemovida: false, recusaConservaAnterior: false,
    remocaoReversivel: false, snapshotObsoletoRecusado: false, outroTenantRecusado: false,
    limpezaRestritaAoRecurso: false, jsonbMalformadoRecusado: false,
    limpeza: false, falhasDeLimpeza: 0, limpezaInterrompida: false,
    estadoDaLimpeza: "pendente", falhaNaCaptura: false,
    preparoMs: 0, execucaoMs: 0, limpezaMs: 0,
    fornecedor: "HTTP local sintético; não mede conversão/entrega do WhatsApp público" };

  async function capturar(nome: string) {
    const arquivo = path.join(pasta, nome);
    await page.screenshot({ path: arquivo, fullPage: true, timeout: 5_000 });
    // O artefato de falha do workflow já recolhe os anexos Playwright. O anexo
    // via path é copiado para test-results mesmo com reporter=list; nenhuma
    // URL assinada entra como texto nem depende de um reporter HTML.
    await testInfo.attach(nome, { path: arquivo, contentType: "image/png" });
  }
  async function guardarRecibo(nome: string) {
    const body = Buffer.from(JSON.stringify(recibo, null, 2));
    const arquivo = path.join(pasta, nome);
    writeFileSync(arquivo, body);
    await testInfo.attach(nome, { path: arquivo, contentType: "application/json" });
  }

  const receptor = createServer((req, res) => {
    void (async () => {
      const partes: Buffer[] = [];
      for await (const parte of req) partes.push(Buffer.isBuffer(parte) ? parte : Buffer.from(parte));
      const corpo = JSON.parse(Buffer.concat(partes).toString() || "{}") as {
        session?: string; text?: string; caption?: string; convert?: boolean;
        file?: { url?: string };
      };
      const rota = new URL(req.url || "/", receptorUrl).pathname;
      if (["/api/sendText", "/api/sendImage", "/api/sendVoice"].includes(rota)) {
        if (corpo.session !== nomeDaSessao) throw new Error("sessao_sintetica_incorreta");
        const tipo = rota === "/api/sendText" ? "text" : rota === "/api/sendImage" ? "image" : "audio";
        if (tipo !== "text") {
          if (!corpo.file?.url) throw new Error("arquivo_ausente");
          const objeto = new URL(corpo.file.url);
          if (!origensStorage.has(objeto.origin) || !objeto.pathname.startsWith("/storage/v1/object/sign/whatsapp-media/")) throw new Error("storage_nao_local");
          const baixado = await fetch(objeto, { signal: AbortSignal.timeout(10_000) });
          if (!baixado.ok) throw new Error("bytes_indisponiveis");
          const bytes = Buffer.from(await baixado.arrayBuffer());
          if (!bytes.equals(tipo === "image" ? PNG : wav)) throw new Error("bytes_divergentes");
          if (tipo === "audio" && (corpo.caption !== undefined || corpo.convert !== true)) throw new Error("contrato_audio_divergente");
        }
        envios.push({ tipo, texto: tipo === "text" ? corpo.text || "" : corpo.caption || "" });
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(rota.endsWith("/sessions")
        ? [{ name: nomeDaSessao, status: "WORKING" }]
        : rota.includes("check-exists")
          ? { numberExists: true, chatId: "5511999903538@c.us" }
          : { id: `rr-${randomUUID()}`, name: nomeDaSessao, status: "WORKING" }));
    })().catch(() => {
      falhaDoReceptor = true;
      if (!res.destroyed && !res.writableEnded) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end('{"error":"contrato_sintetico_recusado"}');
      }
    });
  });
  receptor.requestTimeout = 10_000;
  receptor.headersTimeout = 5_000;
  receptor.setTimeout(10_000);

  async function inserir(tabela: string, dados: Record<string, unknown>): Promise<string> {
    const r = await admin.from(tabela).insert(dados).select("id").single();
    expect(r.error === null && Boolean(r.data), `fixture ${tabela} recusada`).toBe(true);
    return r.data!.id as string;
  }
  async function ler(id: string): Promise<Modelo> {
    const r = await sessao.from("message_templates").select("*").eq("id", id).eq("organization_id", org).single();
    expect(r.error === null, "leitura própria recusada").toBe(true);
    return r.data as Modelo;
  }
  async function navegar(destino: string) { await page.goto(destino); await esperarARevelacao(page); }
  const linha = (titulo: string) => page.getByRole("listitem").filter({ has: page.getByText(titulo, { exact: true }) });
  async function editar(modelo: Modelo) {
    await navegar("/app/templates");
    await linha(modelo.title).getByRole("button", { name: "Editar resposta rápida" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
  }
  async function salvar() {
    const resposta = page.waitForResponse((r) => r.url().includes("/api/v1/message-templates/") && r.request().method() === "PATCH");
    await page.getByRole("dialog").getByRole("button", { name: "Salvar", exact: true }).click();
    expect((await resposta).status()).toBe(200);
    await expect(page.getByRole("dialog")).toHaveCount(0);
  }
  async function cadastrar(titulo: string, texto: string, imagens: number, audio: boolean): Promise<Modelo> {
    await navegar("/app/templates");
    await page.getByRole("button", { name: "Nova resposta rápida", exact: true }).click();
    const dialogo = page.getByRole("dialog");
    await dialogo.getByLabel("Título", { exact: true }).fill(titulo);
    await dialogo.getByLabel("Mensagem", { exact: true }).fill(texto);
    if (imagens) await dialogo.locator("#tpl-midias").setInputFiles(Array.from({ length: imagens }, (_, i) => ({ name: `Imagem sintética ${i + 1}.png`, mimeType: "image/png", buffer: PNG })));
    if (audio) await dialogo.locator("#tpl-audio").setInputFiles({ name: "Áudio sintético.wav", mimeType: "audio/wav", buffer: wav });
    const criacao = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/v1/message-templates" && r.request().method() === "POST");
    await dialogo.getByRole("button", { name: "Criar resposta rápida", exact: true }).click();
    const resposta = await criacao;
    expect(resposta.status()).toBe(201);
    const criado = await resposta.json() as { data: Modelo };
    modelos.set(criado.data.id, org);
    await expect(dialogo).toHaveCount(0);
    const modelo = await ler(criado.data.id);
    expect(modelo.midias).toHaveLength(imagens + Number(audio));
    await expect(linha(titulo)).toBeVisible();
    return modelo;
  }

  try {
    const destino = new URL(receptorUrl);
    await new Promise<void>((resolve, reject) => {
      const abertura = new AbortController();
      const timer = setTimeout(() => { abertura.abort(); reject(new Error("receiver_listen_timeout")); }, 5_000);
      receptor.once("error", (error) => { clearTimeout(timer); reject(error); });
      receptor.listen({ port: Number(destino.port), host: destino.hostname.replace(/^\[|\]$/g, ""), signal: abertura.signal }, () => {
        clearTimeout(timer); resolve();
      });
    });
    const conta = await admin.auth.admin.createUser({ email, password: senha, email_confirm: true });
    expect(conta.error === null && Boolean(conta.data.user), "conta sintética recusada").toBe(true);
    usuario = conta.data.user!.id;
    org = await inserir("organizations", { slug: `e2e-rr-3538-${sufixo}`, display_name: "Respostas sintéticas",
      legal_name: "Empresa sintética", created_by: usuario, status: "active", locale: "pt-BR",
      onboarded_at: new Date().toISOString(), settings: { visibility_mode: "own", ai_dispatch_mode: "external" },
      interface_settings: { preset: "completa" } });
    await inserir("user_organizations", { organization_id: org, user_id: usuario, role: "manager", accepted_at: new Date().toISOString() });
    const acesso = await sessao.auth.signInWithPassword({ email, password: senha });
    expect(acesso.error === null, "login JWT sintético recusado").toBe(true);
    expect((await sessao.auth.getUser()).data.user?.id).toBe(usuario);
    canal = await inserir("channel_sessions", { organization_id: org, waha_session_name: nomeDaSessao,
      display_name: "Canal sintético de respostas", status: "WORKING", webhook_secret_encrypted: "\\x00" });
    const knobs = await admin.from("channel_knobs").upsert({ organization_id: org, channel_session_id: canal,
      window_start_hour: 0, window_end_hour: 24, resposta_start_hour: 0, resposta_end_hour: 24, allow_sunday: true });
    expect(knobs.error === null, "janela explícita da fixture recusada").toBe(true);
    contato = await inserir("contacts", { organization_id: org, name: "Pessoa sintética", phone_number: "+5511999903538" });
    conversa = await inserir("conversations", { organization_id: org, contact_id: contato, channel_session_id: canal,
      assigned_to_user_id: usuario, assignee_kind: "user", status: "claimed", bot_silenced_until: "infinity", last_inbound_at: new Date().toISOString() });
    await inserir("messages", { organization_id: org, contact_id: contato, conversation_id: conversa, channel_session_id: canal,
      direction: "inbound", type: "text", status: "received", body: "Contexto sintético de respostas", sent_via: "external_device" });
    await navegar("/login");
    await page.getByLabel(/e-?mail/i).fill(email);
    await page.getByLabel(/senha/i).fill(senha);
    await page.getByRole("button", { name: "Entrar", exact: true }).click();
    await page.waitForURL(/\/app(\/|$)/);
    recibo.preparoMs = Math.round(performance.now() - inicio);

    // As três etapas abaixo usam serviços reais; o recibo distingue cada uma.
    // Nenhum page.route, dublê de Storage ou fetch global é instalado.
    const cadastrados: Modelo[] = [];
    for (const [i, c] of COMBINACOES.entries()) cadastrados.push(await cadastrar(`RR ${i + 1} ${sufixo}`, c.texto ? `Texto sintético ${i + 1}` : "", Number(c.imagem), c.audio));
    recibo.seteCadastros = true;
    await capturar("biblioteca-sete-conteudos.png");

    recibo.fase = "isolamento-das-fixtures";
    outraOrg = await inserir("organizations", { slug: `e2e-rr-b-${sufixo}`, display_name: "Outra organização sintética",
      legal_name: "Outra empresa sintética", created_by: usuario, status: "active" });
    const outroId = randomUUID();
    const outroPath = `${outraOrg}/templates/${outroId}/${randomUUID()}.wav`;
    expect(midiaPertenceAoTemplate(outroPath, outraOrg, outroId)).toBe(true);
    const outraMidia = { storage_path: outroPath, media_mime: "audio/wav", media_size_bytes: wav.length };
    await inserir("message_templates", { id: outroId, organization_id: outraOrg, owner_user_id: null,
      title: "Resposta sintética isolada", body: "", midias: [outraMidia], created_by_user_id: usuario });
    modelos.set(outroId, outraOrg);
    expect((await admin.storage.from("whatsapp-media").upload(outroPath, wav, { contentType: "audio/wav", upsert: false })).error === null).toBe(true);
    const invisivel = await sessao.from("message_templates").select("id").eq("id", outroId);
    expect(invisivel.error === null).toBe(true);
    expect(invisivel.data).toEqual([]);
    const outroUpload = await page.request.post(`/api/v1/message-templates/${outroId}/midias`, {
      timeout: 10_000,
      multipart: { file: { name: "Outro.wav", mimeType: "audio/wav", buffer: wav }, substituir_audio: outroPath },
    });
    expect(outroUpload.status()).toBe(404);
    const alvoAlheio = await page.request.post(`/api/v1/message-templates/${cadastrados[2]!.id}/midias`, {
      timeout: 10_000,
      multipart: { file: { name: "Outro.wav", mimeType: "audio/wav", buffer: wav }, substituir_audio: outroPath },
    });
    expect(alvoAlheio.status()).toBe(409);
    const outrosBytes = await admin.storage.from("whatsapp-media").download(outroPath);
    expect(outrosBytes.error === null).toBe(true);
    expect(Buffer.from(await outrosBytes.data!.arrayBuffer())).toEqual(wav);
    recibo.outroTenantRecusado = true;

    // A coluna é mutável pelo JWT sob RLS. A limpeza privilegiada confirma o
    // namespace do recurso mesmo quando o snapshot veio dessa mesma linha.
    const paraReparar = await cadastrar(`Conferência ${sufixo}`, "Texto conservado", 1, false);
    const propria = paraReparar.midias[0]!;
    const deOutroModelo = cadastrados[1]!.midias[0]!;
    const alteradas = [propria, deOutroModelo, outraMidia];
    const escritaJwt = await sessao.from("message_templates").update({ midias: alteradas }, { count: "exact" })
      .eq("id", paraReparar.id).eq("organization_id", org).select("midias").single();
    expect(escritaJwt.error === null && escritaJwt.count === 1).toBe(true);
    expect(escritaJwt.data?.midias).toEqual(alteradas);
    const reparo = await page.request.patch(`/api/v1/message-templates/${paraReparar.id}`, {
      timeout: 10_000,
      data: { midias: [], midias_esperadas: alteradas },
    });
    expect(reparo.status()).toBe(200);
    expect((await ler(paraReparar.id)).midias).toEqual([]);
    expect(Boolean((await admin.storage.from("whatsapp-media").download(propria.storage_path)).error)).toBe(true);
    for (const [entrada, esperado] of [[deOutroModelo, PNG], [outraMidia, wav]] as const) {
      const r = await admin.storage.from("whatsapp-media").download(entrada.storage_path);
      expect(r.error === null).toBe(true);
      expect(Buffer.from(await r.data!.arrayBuffer())).toEqual(esperado);
    }
    recibo.limpezaRestritaAoRecurso = true;
    for (const entrada of [null, {}, { storage_path: 7 }, "arquivo", ["arquivo"]]) {
      const malformada = [entrada];
      const escrita = await sessao.from("message_templates").update({ midias: malformada }, { count: "exact" })
        .eq("id", paraReparar.id).eq("organization_id", org).select("midias").single();
      expect(escrita.error === null && escrita.count === 1).toBe(true);
      expect(escrita.data?.midias).toEqual(malformada);
      expect((await page.request.patch(`/api/v1/message-templates/${paraReparar.id}`, { timeout: 10_000, data: { midias: [] } })).status()).toBe(409);
      expect((await page.request.post(`/api/v1/message-templates/${paraReparar.id}/midias`, {
        timeout: 10_000,
        multipart: { file: { name: "Imagem.png", mimeType: "image/png", buffer: PNG } },
      })).status()).toBe(409);
      const depois = await sessao.from("message_templates").select("midias").eq("id", paraReparar.id).single();
      expect(depois.error === null).toBe(true);
      expect(depois.data?.midias).toEqual(malformada);
    }
    expect((await sessao.from("message_templates").update({ midias: [] }).eq("id", paraReparar.id).eq("organization_id", org)).error === null).toBe(true);
    recibo.jsonbMalformadoRecusado = true;

    recibo.fase = "postgrest-e-cas-real";
    let cheio = await cadastrar(`Teto5 ${sufixo}`, "Texto da edição", 4, true);
    const vazio = cadastrados[0]!;
    const vazioExato = await sessao.from("message_templates").update({ body: vazio.body,
      updated_at: "2026-10-27T11:00:00.123456+00:00" }, { count: "exact" })
      .eq("id", vazio.id).eq("organization_id", org).eq("midias", JSON.stringify([])).select("id").maybeSingle();
    expect(vazioExato.error === null).toBe(true);
    expect(vazioExato.count).toBe(1);
    const bruto = await ler(vazio.id);
    const micros = await sessao.from("message_templates").select("id").eq("id", vazio.id)
      .eq("organization_id", org).eq("updated_at", bruto.updated_at).single();
    expect(micros.error === null && micros.data?.id === vazio.id).toBe(true);
    for (const filtro of [sessao.from("message_templates").select("id").eq("midias", "null"),
      sessao.from("message_templates").select("id").is("midias", null)]) {
      const r = await filtro.eq("id", vazio.id).eq("organization_id", org);
      expect(r.error === null).toBe(true);
      expect(r.data).toEqual([]);
    }
    const nulo = await page.request.post(`/api/v1/message-templates/${vazio.id}/midias`, {
      timeout: 10_000,
      multipart: { file: { name: "Imagem.png", mimeType: "image/png", buffer: PNG }, midias_esperadas: "null" },
    });
    expect(nulo.status()).toBe(422);
    expect((await ler(vazio.id)).midias).toEqual([]);

    // Dois escritores reais concorrem pelo mesmo snapshot. Nomes são apenas
    // metadado JSONB; todos os storage_path continuam UUID no prefixo próprio.
    const snapshot = cheio.midias;
    const comNome = (nome: string) => snapshot.map((m, i) => i ? m : { ...m, nome_original: nome });
    const candidatos = ['Imagem "sintética" + 10% \\ reserva.png', "Outra imagem áéç.png"];
    const disputas = await Promise.all(candidatos.map((nome) => sessao.from("message_templates")
      .update({ midias: comNome(nome) }, { count: "exact" }).eq("id", cheio.id).eq("organization_id", org)
      .eq("midias", JSON.stringify(snapshot)).select("id").maybeSingle()));
    expect(disputas.every((r) => r.error === null)).toBe(true);
    expect(disputas.map((r) => r.count).sort()).toEqual([0, 1]);
    cheio = await ler(cheio.id);
    const igualdade = await sessao.from("message_templates").select("midias").eq("id", cheio.id)
      .eq("organization_id", org).eq("midias", JSON.stringify(cheio.midias)).single();
    expect(igualdade.error === null).toBe(true);
    expect(igualdade.data?.midias).toEqual(cheio.midias);
    const obsoleto = await page.request.patch(`/api/v1/message-templates/${cheio.id}`, {
      timeout: 10_000,
      data: { midias: snapshot.slice(1), midias_esperadas: snapshot },
    });
    expect(obsoleto.status()).toBe(409);
    expect((await ler(cheio.id)).midias).toEqual(cheio.midias);
    recibo.snapshotObsoletoRecusado = true;

    // Lock da bancada, não do produto: observa upload real antes de liberar o
    // UPDATE condicional. Assim o409 mede CAS no banco, e não a pré-validação.
    const prefixo = `${org}/templates/${cheio.id}`;
    const quantidadeDeObjetos = async () => {
      const r = await admin.storage.from("whatsapp-media").list(prefixo);
      expect(r.error === null, "listagem sintética recusada").toBe(true);
      return r.data?.length ?? 0;
    };
    expect(await quantidadeDeObjetos()).toBe(5);
    const pool = new Pool({ connectionString: dbUrl, max: 1, connectionTimeoutMillis: 5_000,
      query_timeout: 10_000, statement_timeout: 10_000, lock_timeout: 5_000,
      idle_in_transaction_session_timeout: 45_000 });
    let lock: PoolClient | undefined;
    let transacao = false;
    let pedido: ReturnType<typeof page.request.post> | undefined;
    try {
      lock = await pool.connect();
      await lock.query("begin"); transacao = true;
      await lock.query("select id from public.message_templates where id=$1 and organization_id=$2 for update", [cheio.id, org]);
      const audioAnterior = cheio.midias.find((m) => m.storage_path.endsWith(".wav"))!;
      pedido = page.request.post(`/api/v1/message-templates/${cheio.id}/midias`, {
        timeout: 45_000,
        multipart: { file: { name: "Concorrente.wav", mimeType: "audio/wav", buffer: wav },
          substituir_audio: audioAnterior.storage_path, midias_esperadas: JSON.stringify(cheio.midias) },
      });
      await expect.poll(quantidadeDeObjetos, { timeout: 30_000 }).toBe(6);
      const concorrente = cheio.midias.map((m, i) => i ? m : { ...m, nome_original: "Concorrente áéç.png" });
      await lock.query("update public.message_templates set midias=$1::jsonb where id=$2 and organization_id=$3", [JSON.stringify(concorrente), cheio.id, org]);
      await lock.query("commit"); transacao = false;
      expect((await pedido).status()).toBe(409);
      expect(await quantidadeDeObjetos()).toBe(5);
      expect((await ler(cheio.id)).midias).toEqual(concorrente);
      cheio = await ler(cheio.id);
    } finally {
      try {
        if (transacao && lock) await lock.query("rollback");
      } finally {
        // Destrói só a conexão exclusiva da bancada, inclusive se rollback
        // falhou. Um connect recusado também alcança o fechamento do pool.
        lock?.release(true);
        try {
          await Promise.race([pool.end(), new Promise<never>((_, reject) => {
            const timer = setTimeout(() => reject(new Error("pool_close_timeout")), 3_000);
            timer.unref();
          })]);
        } finally {
          if (pedido) await pedido.catch(() => undefined); // POST já tem teto45s.
        }
      }
    }
    recibo.postgrestReal = true;

    recibo.fase = "edicao-no-teto";
    await editar(cheio);
    await capturar("edicao-teto5-antes.png");
    const anterior = cheio.midias.find((m) => m.storage_path.endsWith(".wav"))!;
    await page.locator("#tpl-audio").setInputFiles({ name: "Recusado.wav", mimeType: "audio/wav", buffer: Buffer.from("nao e audio") });
    const recusado = page.waitForResponse((r) => r.url().endsWith(`/message-templates/${cheio.id}/midias`) && r.request().method() === "POST");
    await page.getByRole("dialog").getByRole("button", { name: "Salvar", exact: true }).click();
    expect((await recusado).status()).toBe(415);
    expect((await ler(cheio.id)).midias).toEqual(cheio.midias);
    const bytesAntigos = await admin.storage.from("whatsapp-media").download(anterior.storage_path);
    expect(bytesAntigos.error === null).toBe(true);
    expect(Buffer.from(await bytesAntigos.data!.arrayBuffer())).toEqual(wav);
    recibo.recusaConservaAnterior = true;
    await expect(page.getByRole("dialog").getByRole("button", { name: "Salvar", exact: true })).toBeEnabled();
    const wavNovo = audioSintetico(660);
    await page.locator("#tpl-audio").setInputFiles({ name: "Substituto áéç.wav", mimeType: "audio/wav", buffer: wavNovo });
    await salvar();
    cheio = await ler(cheio.id);
    expect(cheio.midias).toHaveLength(5);
    let substituto = cheio.midias.find((m) => m.storage_path.endsWith(".wav"))!;
    expect(substituto.storage_path === anterior.storage_path).toBe(false);
    const bytesNovos = await admin.storage.from("whatsapp-media").download(substituto.storage_path);
    expect(bytesNovos.error === null).toBe(true);
    expect(Buffer.from(await bytesNovos.data!.arrayBuffer())).toEqual(wavNovo);
    expect(Boolean((await admin.storage.from("whatsapp-media").download(anterior.storage_path)).error)).toBe(true);
    recibo.trocaNoTeto = true;

    await editar(cheio);
    await page.getByRole("dialog").getByRole("button", { name: "Remover imagem" }).first().click();
    const segundoAudio = audioSintetico(880);
    await page.locator("#tpl-audio").setInputFiles({ name: "Segundo áudio.wav", mimeType: "audio/wav", buffer: segundoAudio });
    await salvar();
    cheio = await ler(cheio.id);
    expect(cheio.midias).toHaveLength(4);
    expect(cheio.midias.filter((m) => m.storage_path.endsWith(".wav"))).toHaveLength(1);
    substituto = cheio.midias.find((m) => m.storage_path.endsWith(".wav"))!;
    const segundoByte = await admin.storage.from("whatsapp-media").download(substituto.storage_path);
    expect(segundoByte.error === null).toBe(true);
    expect(Buffer.from(await segundoByte.data!.arrayBuffer())).toEqual(segundoAudio);
    recibo.trocaComImagemRemovida = true;

    await editar(cheio);
    await page.getByRole("dialog").getByRole("button", { name: "Remover áudio", exact: true }).click();
    await expect(page.getByRole("button", { name: "Desfazer remoção do áudio" })).toBeVisible();
    await capturar("remocao-pendente.png");
    expect((await ler(cheio.id)).midias).toEqual(cheio.midias);
    await page.getByRole("button", { name: "Desfazer remoção do áudio" }).click();
    await expect(page.getByLabel("Áudio da resposta rápida")).toBeVisible();
    await page.getByRole("dialog").getByRole("button", { name: "Remover áudio", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Cancelar", exact: true }).click();
    expect((await ler(cheio.id)).midias).toEqual(cheio.midias);
    await editar(cheio);
    await expect(page.getByLabel("Áudio da resposta rápida")).toBeVisible();
    await page.getByRole("dialog").getByRole("button", { name: "Remover áudio", exact: true }).click();
    await salvar();
    expect((await ler(cheio.id)).midias).toHaveLength(3);
    expect(Boolean((await admin.storage.from("whatsapp-media").download(substituto.storage_path)).error)).toBe(true);
    recibo.remocaoReversivel = true;

    recibo.fase = "sete-envios-pela-interface";
    await navegar(`/app/inbox?id=${conversa}`);
    await expect(page.getByText("Pessoa sintética", { exact: true }).first()).toBeVisible();
    const barra = page.getByRole("toolbar", { name: "Respostas rápidas" });
    await expect(barra).toBeVisible();
    const mais = barra.getByRole("button", { name: /^mais \(/ });
    if (await mais.count()) await mais.click();
    const esperados: Array<{ tipo: string; texto: string }> = [];
    for (const [i, c] of COMBINACOES.entries()) {
      const modelo = cadastrados[i]!;
      const botao = barra.locator(`[data-recurso-id="${modelo.id}"]`);
      await expect(botao).toHaveAttribute("data-recurso-tipo", c.tipo);
      await expect(botao).toBeEnabled();
      await botao.click();
      const anexos = Number(c.imagem) + Number(c.audio);
      const campo = page.getByLabel("Mensagem", { exact: true });
      if (anexos) {
        const previa = page.getByRole("dialog");
        await expect(previa.getByRole("heading", { name: "Enviar anexo" })).toBeVisible();
        await expect(previa.getByRole("button", { name: "Remover imagem" })).toHaveCount(anexos);
        if (c.imagem) {
          await expect(previa.getByLabel("Legenda", { exact: true })).toHaveValue(modelo.body);
          await expect(campo).toHaveValue("");
        } else {
          await expect(previa.getByLabel("Legenda", { exact: true })).toHaveCount(0);
          await expect(campo).toHaveValue(modelo.body);
        }
        if (i === 6) await capturar("preparar-texto-imagem-audio.png");
        await previa.getByRole("button", { name: "Enviar", exact: true }).click();
        if (c.imagem) esperados.push({ tipo: "image", texto: modelo.body });
        if (c.audio) esperados.push({ tipo: "audio", texto: "" });
        await expect(previa).toHaveCount(0);
        await expect.poll(() => envios.length).toBe(esperados.length);
      }
      // Sem imagem, o texto é uma mensagem separada; áudio nunca leva legenda.
      if (c.texto && !c.imagem) {
        await expect(campo).toHaveValue(modelo.body);
        await page.getByRole("button", { name: "Enviar", exact: true }).click();
        esperados.push({ tipo: "text", texto: modelo.body });
        await expect(campo).toHaveValue("");
        await expect.poll(() => envios.length).toBe(esperados.length);
      }
      expect(envios).toEqual(esperados);
    }
    expect(envios).toHaveLength(10);
    const persistidos = await admin.from("messages").select("type,body,status,external_id,media_storage_path")
      .eq("organization_id", org).eq("conversation_id", conversa).eq("direction", "outbound").order("created_at");
    expect(persistidos.error === null).toBe(true);
    expect(persistidos.data).toHaveLength(10);
    expect(persistidos.data!.map((m) => ({ tipo: m.type, texto: m.body || "" }))).toEqual(esperados);
    expect(persistidos.data!.every((m) => m.status === "sent" && Boolean(m.external_id))).toBe(true);
    for (const m of persistidos.data!) {
      if (m.type === "text") continue;
      expect(typeof m.media_storage_path === "string" && m.media_storage_path.startsWith(`${org}/${conversa}/`)).toBe(true);
      const r = await admin.storage.from("whatsapp-media").download(m.media_storage_path!);
      expect(r.error === null).toBe(true);
      expect(Buffer.from(await r.data!.arrayBuffer())).toEqual(m.type === "image" ? PNG : wav);
    }
    recibo.seteEnvios = true;
    recibo.bytesReais = true;

    // A transformação de texto+áudio em só texto também é feita pela tela.
    const textoAudio = cadastrados[4]!;
    await editar(textoAudio);
    await page.getByRole("dialog").getByRole("button", { name: "Remover áudio", exact: true }).click();
    await salvar();
    expect((await ler(textoAudio.id)).midias).toEqual([]);
    await expect(linha(textoAudio.title).getByText("Áudio", { exact: true })).toHaveCount(0);
    await capturar("edicao-final.png");
    recibo.fase = "concluido";
  } finally {
    const concluido = recibo.fase === "concluido";
    if (!concluido) await capturar("falha-antes-da-limpeza.png").catch(() => { recibo.falhaNaCaptura = true; });
    const inicioLimpeza = performance.now();
    recibo.execucaoMs = Math.round(inicioLimpeza - inicio - recibo.preparoMs);
    // Falha ao gravar/anexar não pode impedir a limpeza nem virar verde.
    await finalizarProvaComEvidencia(
      () => guardarRecibo("recibo-antes-da-limpeza.json"),
      async () => {
        sinalDaLimpeza = AbortSignal.timeout(20_000);
        const limpar = async (tarefa: () => PromiseLike<{ error: unknown }>) => {
          if (sinalDaLimpeza!.aborted) { recibo.limpezaInterrompida = true; return; }
          try { if ((await tarefa()).error) recibo.falhasDeLimpeza++; }
          catch { recibo.falhasDeLimpeza++; }
        };
        // Só prefixos de UUIDs criados nesta execução. A lista inclui eventuais
        // objetos sem referência que uma confirmação incerta tenha conservado.
        const limparObjetos = async (prefixo: string, pertence: (caminho: string) => boolean) => {
          if (sinalDaLimpeza!.aborted) { recibo.limpezaInterrompida = true; return; }
          try {
            const r = await admin.storage.from("whatsapp-media").list(prefixo, { limit: 100 });
            if (r.error) { recibo.falhasDeLimpeza++; return; }
            const caminhos = (r.data ?? []).map((m) => `${prefixo}/${m.name}`);
            if (!caminhos.every(pertence)) { recibo.falhasDeLimpeza++; return; }
            if (caminhos.length) await limpar(() => admin.storage.from("whatsapp-media").remove(caminhos));
          } catch { recibo.falhasDeLimpeza++; }
        };
        for (const [id, dona] of modelos) {
          if (sinalDaLimpeza.aborted) { recibo.limpezaInterrompida = true; break; }
          if (dona === org) {
            const restante = Math.max(1, 20_000 - (performance.now() - inicioLimpeza));
            const r = await page.request.delete(`/api/v1/message-templates/${id}`, { timeout: Math.min(5_000, restante) }).catch(() => null);
            if (!r || r.status() !== 204) recibo.falhasDeLimpeza++;
          }
          // Também cobre criação parcial anterior ao login; a rota DELETE manual
          // continua sendo exercitada acima para todos os modelos da sessão A.
          await limpar(() => admin.from("message_templates").delete().eq("id", id).eq("organization_id", dona));
          await limparObjetos(`${dona}/templates/${id}`, (c) => midiaPertenceAoTemplate(c, dona, id));
        }
        if (conversa) {
          await limpar(() => admin.from("conversations").delete().eq("id", conversa).eq("organization_id", org));
          await limparObjetos(`${org}/${conversa}`, (c) => isMediaPathInOrganization(c, org) && isMediaPathOwnedBy(c, org, conversa));
        }
        if (contato) await limpar(() => admin.from("contacts").delete().eq("id", contato).eq("organization_id", org));
        if (canal) await limpar(() => admin.from("channel_sessions").delete().eq("id", canal).eq("organization_id", org));
        for (const id of [org, outraOrg].filter(Boolean)) await limpar(() => admin.from("organizations").delete().eq("id", id));
        if (usuario) await limpar(() => admin.auth.admin.deleteUser(usuario));
        if (receptor.listening) await new Promise<void>((resolve) => {
          const timer = setTimeout(() => { recibo.falhasDeLimpeza++; resolve(); }, 3_000);
          receptor.closeAllConnections();
          receptor.close(() => { clearTimeout(timer); resolve(); });
        });
        recibo.limpezaMs = Math.round(performance.now() - inicioLimpeza);
        recibo.limpeza = recibo.falhasDeLimpeza === 0 && !recibo.limpezaInterrompida;
        recibo.estadoDaLimpeza = recibo.limpeza ? "concluida" : "incompleta";
      },
      async () => {
        recibo.limpezaMs = Math.round(performance.now() - inicioLimpeza);
        if (recibo.estadoDaLimpeza === "pendente") recibo.estadoDaLimpeza = "incompleta";
        await guardarRecibo("recibo.json");
      },
    );
    if (concluido) {
      expect(falhaDoReceptor, "receptor sintético recusou o contrato").toBe(false);
      expect(recibo.limpeza, "limpeza das fixtures incompleta").toBe(true);
    }
  }
});
