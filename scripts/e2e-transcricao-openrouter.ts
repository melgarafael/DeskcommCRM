/**
 * Prova do contrato de áudio: ingestão, eventos, Storage e workers REAIS.
 * Só os dois servidores HTTP do canal/fornecedor são sintéticos e locais.
 * Não valida a aceitação/qualidade do fornecedor público nem o agendador.
 * Executado pelo E2E da parte 6, nunca carrega arquivo de ambiente.
 */
import assert from "node:assert/strict";
import { randomInt, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { setTimeout as esperar } from "node:timers/promises";

import { createClient } from "@supabase/supabase-js";

import type { EventRow } from "@/lib/event-log/dispatcher";

let etapa = "precondicoes";
const [, , orgId, canalId, arquivoOgg, recibo] = process.argv;
const servidores: Server[] = [];

async function abrir(servidor: Server): Promise<string> {
  servidores.push(servidor);
  await new Promise<void>((resolve) => servidor.listen(0, "127.0.0.1", resolve));
  const endereco = servidor.address();
  assert(endereco && typeof endereco === "object");
  return `http://127.0.0.1:${endereco.port}`;
}

async function main(): Promise<void> {
  assert(orgId && canalId && arquivoOgg && recibo);
  const supabase = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const banco = process.env.SUPABASE_DB_URL ?? "";
  for (const destino of [supabase, banco, process.env.SUPABASE_SERVER_URL].filter(Boolean) as string[]) {
    assert(["127.0.0.1", "localhost", "[::1]"].includes(new URL(destino).hostname));
  }
  assert(process.env.SUPABASE_SERVICE_ROLE_KEY);
  const admin = createClient(supabase, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
  const { data: org, error: eOrg } = await admin.from("organizations")
    .select("slug").eq("id", orgId).single();
  assert(!eOrg && org?.slug.startsWith("e2e-stt-3408-"));
  const { data: sessao, error: eSessao } = await admin.from("channel_sessions")
    .select("*").eq("id", canalId).eq("organization_id", orgId).single();
  assert(!eSessao && sessao);

  const ogg = readFileSync(arquivoOgg);
  assert.equal(ogg.subarray(0, 4).toString("ascii"), "OggS");
  assert(ogg.includes(Buffer.from("OpusHead")));
  const chaveFalsa = "e2e-openrouter-sem-provedor-pago-3408";
  const texto = "Transcrição sintética do transporte local de áudio.";
  let downloadsDoCanal = 0;
  let chamadasStt = 0;
  let chamadasDestinoRecusado = 0;
  let multipartCorreto = false;
  let redirecionar = false;
  const fora = await abrir(createServer((_req, res) => {
    chamadasDestinoRecusado++;
    res.writeHead(500).end();
  }));
  const origem = await abrir(createServer((req, res) => {
    void (async () => {
      if (req.method === "GET" && req.url === "/audio.ogg") {
        assert.equal(req.headers["x-api-key"], "e2e-canal-sintetico-3408");
        downloadsDoCanal++;
        res.writeHead(200, { "content-type": "audio/ogg; codecs=opus", "content-length": ogg.length });
        res.end(ogg);
        return;
      }
      if (req.method !== "POST" || req.url !== "/api/v1/audio/transcriptions") {
        res.writeHead(404).end();
        return;
      }
      chamadasStt++;
      assert.equal(req.headers.authorization, `Bearer ${chaveFalsa}`);
      const partes: Buffer[] = [];
      for await (const parte of req) partes.push(Buffer.from(parte));
      const form = await new Response(Buffer.concat(partes), {
        headers: { "content-type": req.headers["content-type"] ?? "" },
      }).formData();
      const file = form.get("file");
      assert(file instanceof File);
      assert.equal(file.name, "audio.ogg");
      assert.equal(file.type, "audio/ogg");
      assert(Buffer.from(await file.arrayBuffer()).equals(ogg));
      assert.equal(form.get("model"), "openai/whisper-large-v3");
      assert.equal(form.get("language"), "pt");
      multipartCorreto = true;
      if (redirecionar) {
        res.writeHead(307, { location: `${fora}/nao-recebe-audio` }).end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ text: texto, usage: { seconds: 1, cost: 0.000508 } }));
    })().catch(() => res.writeHead(400).end());
  }));

  // Knobs EXISTENTES, antes dos imports: sem chave pública ou atalho de fetch.
  for (const key of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENROUTER_API_KEY", "AI_GATEWAY_API_KEY", "TRANSCRIPTION_API_KEY"]) {
    process.env[key] = "";
  }
  process.env.OPENROUTER_BASE_URL = `${origem}/api/v1`;
  process.env.WAHA_API_BASE_URL = origem;
  process.env.WAHA_API_KEY = "e2e-canal-sintetico-3408";
  process.env.EVENT_LOG_WORKER_DRAINS = "true";
  process.env.TRANSCRIPTION_LANGUAGES = "pt";
  const { dispatchWahaEvent } = await import("@/lib/waha/ingest");
  const { persistMessageMedia } = await import("@/workers/media-persist-worker");
  const { deriveMessageMedia } = await import("@/workers/media-derive-worker");

  // Controle causal do caminho antigo, com o SDK instalado e os MESMOS bytes.
  // Não é uma segunda execução do worker antigo nem uma chamada pública.
  etapa = "controle_do_caminho_antigo";
  const { transcricaoPeloModelo } = await import("@/lib/messaging/media/escada-de-transcricao");
  const { UnsupportedFunctionalityError } = await import("ai");
  const antigo = transcricaoPeloModelo({
    provider: "openrouter", apiKey: chaveFalsa, modelId: "google/gemini-2.5-flash",
  });
  await assert.rejects(antigo.transcribe(ogg, "audio/ogg; codecs=opus"), (err: unknown) =>
    UnsupportedFunctionalityError.isInstance(err));
  assert.equal(chamadasStt, 0);

  etapa = "ingestao";
  const externalId = `e2e-stt-3408-${randomUUID()}`;
  await dispatchWahaEvent(admin, sessao, {
    event: "message",
    session: sessao.waha_session_name,
    payload: {
      id: externalId,
      from: `5511${randomInt(100000000, 1000000000)}@c.us`,
      fromMe: false,
      body: "",
      timestamp: Math.floor(Date.now() / 1000),
      type: "ptt",
      hasMedia: true,
      media: { url: `${origem}/audio.ogg`, mimetype: "audio/ogg; codecs=opus", filename: null },
    },
  }, randomUUID());
  const { data: msg, error: eMsg } = await admin.from("messages")
    .select("id, type").eq("organization_id", orgId).eq("external_id", externalId).single();
  assert(!eMsg && msg && msg.type === "audio");
  async function evento(tipo: string): Promise<EventRow> {
    for (let i = 0; i < 50; i++) {
      const { data, error } = await admin.from("event_log").select("*")
        .eq("organization_id", orgId).eq("event_type", tipo).eq("entity_id", msg!.id).single();
      if (!error && data) return data as EventRow;
      await esperar(100);
    }
    throw new Error("evento_da_propria_mensagem_nao_emitido");
  }
  etapa = "persistencia";
  assert.equal((await persistMessageMedia(await evento("media.persist_requested"))).status, "ok");
  const { data: armazenada, error: eArmazenada } = await admin.from("messages")
    .select("media_storage_path, media_size_bytes").eq("id", msg.id).eq("organization_id", orgId).single();
  assert(!eArmazenada && armazenada);
  const { isMediaPathInOrganization } = await import("@/lib/messaging/media/upload-validation");
  assert(isMediaPathInOrganization(armazenada.media_storage_path, orgId));
  assert.equal(armazenada.media_size_bytes, ogg.length);
  const objeto = await admin.storage.from("whatsapp-media").download(armazenada.media_storage_path);
  assert(!objeto.error && objeto.data);
  assert(Buffer.from(await objeto.data.arrayBuffer()).equals(ogg));

  etapa = "derivacao";
  assert.equal((await deriveMessageMedia(await evento("media.derive_requested"))).status, "ok");
  const { data: derivada, error: eDerivada } = await admin.from("messages")
    .select("media_derived_status, media_derived_text").eq("id", msg.id).eq("organization_id", orgId).single();
  assert(!eDerivada && derivada);
  assert.equal(derivada.media_derived_status, "ready");
  assert.equal(derivada.media_derived_text, texto);
  etapa = "custo";
  let custoConfirmado = false;
  for (let i = 0; i < 50; i++) {
    const { data: custos, error } = await admin.from("llm_calls")
      .select("provider, model, cost_cents, origem_da_escolha, status")
      .eq("organization_id", orgId).eq("purpose", "transcricao_de_audio");
    if (!error && custos?.length === 1) {
      const custo = custos[0]!;
      assert.equal(custo.provider, "openrouter");
      assert.equal(custo.model, "openai/whisper-large-v3");
      assert.equal(Number(custo.cost_cents), 0.0508);
      assert.equal(custo.origem_da_escolha, "padrao_openrouter");
      assert.equal(custo.status, "ok");
      custoConfirmado = true;
      break;
    }
    await esperar(100);
  }
  assert(custoConfirmado);
  assert.equal(downloadsDoCanal, 1);
  assert.equal(chamadasStt, 1);

  etapa = "egress";
  redirecionar = true;
  const { decidirTranscricao } = await import("@/lib/messaging/media/escada-de-transcricao");
  const { EgressBlockedError } = await import("@/lib/agent-engine/edge/egress");
  const decisao = await decidirTranscricao({
    conversa: { provider: "openrouter", apiKey: chaveFalsa, modelId: "google/gemini-2.5-flash", baseUrl: null },
    chaveOpenai: async () => null,
  });
  assert(decisao.transcriber);
  await assert.rejects(decisao.transcriber.transcribe(ogg, "audio/ogg; codecs=opus"), EgressBlockedError);
  assert.equal(chamadasStt, 2);
  assert.equal(chamadasDestinoRecusado, 0);
  writeFileSync(recibo, JSON.stringify({
    ok: true, fornecedor: "HTTP local sintético", audio: "OGG/Opus válido do ffmpeg do CI",
    processadorReal: true, eventosReais: true, storageReal: true, workersReais: true,
    bytesStorageIguais: true, multipartCorreto, downloadsDoCanal, chamadasStt,
    caminhoAntigoRecusaOggAntesDoHttp: true,
    ready: true, custoCents: 0.0508, redirectRecusado: true, chamadasDestinoRecusado,
    limite: "Não mede aceitação/qualidade da OpenRouter pública nem o agendador.",
  }, null, 2));
}

main().then(async () => {
  for (const servidor of servidores) await new Promise<void>((resolve) => servidor.close(() => resolve()));
  // O worker mantém pools lazy privados; todas as escritas alvo foram aguardadas.
  process.exit(0);
}).catch(() => {
  if (recibo) writeFileSync(recibo, JSON.stringify({ ok: false, etapa }));
  console.error(`[e2e-stt-3408] falha em ${etapa}; recibo sem chave, URL ou conteúdo.`);
  process.exit(1);
});
