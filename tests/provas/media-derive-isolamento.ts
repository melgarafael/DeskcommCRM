/** Prova do handler real com PostgREST, PostgreSQL e Storage locais, sem IA paga. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { createClient } from "@supabase/supabase-js";

import type { EventRow } from "@/lib/event-log/dispatcher";
import { destinoEhLocal } from "../../scripts/lib/env-de-teste";

/** PDF sintético mínimo; a extração abaixo usa a engine de produção. */
function pdfComTexto(texto: string): Buffer {
  const stream = `BT /F1 12 Tf 72 720 Td (${texto}) Tj ET`;
  const objetos = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [i, objeto] of objetos.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${objeto}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  return Buffer.from(`${pdf}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}

const textoA = "PDF SINTETICO DA ORGANIZACAO A";
const textoB = "PDF SINTETICO DA ORGANIZACAO B";
const bytesA = pdfComTexto(textoA);
const bytesB = pdfComTexto(textoB);
let fase = "precondicoes";

async function main(): Promise<void> {
  if (process.argv.includes("--validar-fixtures")) {
    const { extractPdfText } = await import("@/lib/ai/rag/extractors/pdf");
    assert.equal((await extractPdfText(bytesA)).trim(), textoA);
    assert.equal((await extractPdfText(bytesB)).trim(), textoB);
    process.stdout.write("PDFs sintéticos validados pelo extrator real; nenhum banco acessado.\n");
    return;
  }

  // Só ambiente explícito. Nunca consulta .env.local nem aceita destino remoto.
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const dbUrl = process.env.SUPABASE_DB_URL ?? "";
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  assert(url && dbUrl && anon && serviceRole, "faltam credenciais locais explícitas");
  assert(destinoEhLocal(url) && destinoEhLocal(dbUrl), "a prova exige destinos locais");
  const servidor = process.env.SUPABASE_SERVER_URL || url;
  assert(destinoEhLocal(servidor), "o transporte Supabase precisa ser local");

  // O PDF não usa visão/ASR. O resolvedor real ainda exige uma credencial:
  // apenas este processo recebe chave sintética, e HTTP fora do Supabase é negado.
  process.env.OPENAI_API_KEY = "sk-sintetica-prova-sem-provedor";
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  const origens = new Set([new URL(url).origin, new URL(servidor).origin]);
  const fetchReal = globalThis.fetch;
  const chamadas: Array<{ metodo: string; caminho: string; filtros?: { id: string | null; organization_id: string | null } }> = [];
  let observando = false;
  let redeExterna = 0;
  globalThis.fetch = async (input, init) => {
    const destino = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (!origens.has(destino.origin)) {
      redeExterna++;
      throw new Error("rede externa proibida nesta prova");
    }
    const metodo = init?.method ?? (input instanceof Request ? input.method : "GET");
    if (observando) chamadas.push({ metodo, caminho: destino.pathname,
      ...(metodo === "PATCH" && destino.pathname === "/rest/v1/messages" ? {
        filtros: { id: destino.searchParams.get("id"), organization_id: destino.searchParams.get("organization_id") },
      } : {}),
    });
    // Instrumentação observacional: a resposta continua sendo do serviço real.
    return fetchReal(input, init);
  };
  const admin = createClient(url, serviceRole, { auth: { persistSession: false, autoRefreshToken: false } });
  const sessao = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } });
  const organizacoes: string[] = [];
  const objetos: string[] = [];
  let usuario = "";
  const marcador = randomUUID().replaceAll("-", "");
  const senha = `Prova-${randomUUID()}!`;
  const inserir = async (tabela: string, valores: Record<string, unknown>): Promise<string> => {
    fase = `fixture-${tabela}`;
    const { data, error } = await admin.from(tabela).insert(valores).select("id").single();
    assert.equal(error, null, `fixture recusada: ${tabela}`);
    return (data as { id: string }).id;
  };
  const lerMensagem = async (id: string, org: string) => {
    const { data, error } = await admin.from("messages").select("*").eq("id", id).eq("organization_id", org).single();
    assert.equal(error, null, "leitura de controle recusada");
    return data as Record<string, unknown>;
  };

  try {
    fase = "fixtures-reais";
    for (const lado of ["a", "b"]) organizacoes.push(await inserir("organizations", {
      slug: `md-${lado}-${marcador}`,
      legal_name: `Prova de derivacao ${lado}`,
      display_name: `Prova de derivacao ${lado}`,
      settings: { visibility_mode: "own", llm: { provider: "openai", default_model: "gpt-4.1-mini" } },
    }));
    const orgA = organizacoes[0]!;
    const orgB = organizacoes[1]!;
    const email = `media-derive-${marcador}@invariant.test`;
    fase = "fixture-usuario-auth";
    const criado = await admin.auth.admin.createUser({ email, password: senha, email_confirm: true });
    assert.equal(criado.error, null, "usuário sintético recusado");
    usuario = criado.data.user!.id;
    await inserir("user_organizations", { user_id: usuario, organization_id: orgA, role: "agent", accepted_at: new Date().toISOString() });
    const mensagens: string[] = [];
    for (const [indice, org] of organizacoes.entries()) {
      const canal = await inserir("channel_sessions", {
        organization_id: org, waha_session_name: `derivacao-${marcador}-${indice}`,
        status: "WORKING", webhook_secret_encrypted: "\\x00",
      });
      const contato = await inserir("contacts", { organization_id: org, name: "Contato sintético da derivação" });
      const conversa = await inserir("conversations", {
        organization_id: org, contact_id: contato, channel_session_id: canal,
        ...(indice === 0 ? { assigned_to_user_id: usuario, assignee_kind: "user", bot_silenced_until: "infinity" } : {}),
        status: "open",
      });
      const objeto = `${org}/${conversa}/prova.pdf`;
      fase = "fixture-upload";
      const upload = await admin.storage.from("whatsapp-media").upload(objeto, indice === 0 ? bytesA : bytesB, { contentType: "application/pdf" });
      assert.equal(upload.error, null, "upload sintético recusado");
      objetos.push(objeto);
      mensagens.push(await inserir("messages", {
        organization_id: org, contact_id: contato, conversation_id: conversa,
        channel_session_id: canal, direction: "outbound", type: "document", status: "sent",
        sent_via: "user", media_mime: "application/pdf", media_storage_path: objeto,
      }));
    }
    const msgA = mensagens[0]!;
    const msgB = mensagens[1]!;
    const controleB = await lerMensagem(msgB, orgB);
    fase = "autenticacao-jwt";
    const acesso = await sessao.auth.signInWithPassword({ email, password: senha });
    assert.equal(acesso.error, null, "login sintético recusado");
    assert.equal(acesso.data.user?.id, usuario);
    fase = "leituras-jwt";
    const propria = await sessao.from("messages").select("id,organization_id")
      .eq("id", msgA).eq("organization_id", orgA).single();
    assert.equal(propria.error, null, "JWT próprio precisa ler a mensagem própria");
    assert.deepEqual(propria.data, { id: msgA, organization_id: orgA });
    const alheia = await sessao.from("messages").select("id").eq("id", msgB).eq("organization_id", orgB);
    assert.equal(alheia.error, null);
    assert.deepEqual(alheia.data, [], "JWT próprio não pode ler a mensagem B");
    // Spec 08: whatsapp-media é privado, lido só por signed URL/service role.
    // Nem o objeto próprio é download direto do JWT; a autorização positiva
    // dele é na mensagem, e o handler privilegiado é medido abaixo.
    fase = "storage-direto-jwt";
    for (const objeto of objetos) {
      const proibido = await sessao.storage.from("whatsapp-media").download(objeto);
      assert(proibido.error && !proibido.data, "JWT não baixa objeto diretamente do bucket privado");
    }
    fase = "storage-controle-admin";
    const controleObjetoA = await admin.storage.from("whatsapp-media").download(objetos[0]!);
    assert.equal(controleObjetoA.error, null);
    assert.deepEqual(Buffer.from(await controleObjetoA.data!.arrayBuffer()), bytesA);
    const controleObjetoB = await admin.storage.from("whatsapp-media").download(objetos[1]!);
    assert.equal(controleObjetoB.error, null);
    assert.deepEqual(Buffer.from(await controleObjetoB.data!.arrayBuffer()), bytesB);
    const eventoId = await inserir("event_log", {
      organization_id: orgA, event_type: "media.derive_requested", entity_kind: "message",
      entity_id: msgA, payload: { message_id: msgA, organization_id: orgB }, status: "done",
    });
    const evento = await admin.from("event_log").select("*").eq("id", eventoId).eq("organization_id", orgA).single();
    assert.equal(evento.error, null);
    const { deriveMessageMedia } = await import("@/workers/media-derive-worker");
    const trocarCaminho = async (caminho: string) => {
      const alteracao = await sessao.from("messages").update({ media_storage_path: caminho, media_derived_status: null })
        .eq("id", msgA).eq("organization_id", orgA).select("id").single();
      assert.equal(alteracao.error, null, "JWT próprio precisa alterar só a linha própria");
      assert.equal(alteracao.data?.id, msgA);
    };
    fase = "negativos-sem-efeitos";
    for (const caminho of [objetos[1]!, `${orgA}/../${objetos[1]}`, `${orgA}/%2e%2e/${objetos[1]}`]) {
      await trocarCaminho(caminho);
      const antes = await lerMensagem(msgA, orgA);
      chamadas.length = 0;
      observando = true;
      const resultado = await deriveMessageMedia(evento.data as EventRow);
      observando = false;
      assert.deepEqual(resultado, { consumer_key: "media_derive_v1", status: "skipped", detail: "invalid_media_path" });
      assert.deepEqual(chamadas, [
        { metodo: "GET", caminho: "/rest/v1/messages" },
        { metodo: "PATCH", caminho: "/rest/v1/messages", filtros: { id: `eq.${msgA}`, organization_id: `eq.${orgA}` } },
      ], "o negativo só pode ler e marcar a mensagem própria, sem Storage ou conversão");
      const depois = await lerMensagem(msgA, orgA);
      assert.equal(depois.media_derived_status, "skipped", "a recusa precisa liberar a espera por derivação");
      // updated_at muda pelo trigger canônico; todos os demais campos ficam iguais.
      assert(Date.parse(String(depois.updated_at)) >= Date.parse(String(antes.updated_at)));
      assert.deepEqual({ ...depois, media_derived_status: antes.media_derived_status, updated_at: antes.updated_at }, antes, "negativo alterou outro campo da linha própria");
      assert.deepEqual(await lerMensagem(msgB, orgB), controleB, "negativo alterou a outra organização");
    }
    fase = "positivo-real";
    await trocarCaminho(objetos[0]!);
    chamadas.length = 0;
    observando = true;
    const positivo = await deriveMessageMedia(evento.data as EventRow);
    observando = false;
    assert.equal(positivo.status, "ok", "PDF próprio precisa derivar com o handler real");
    const downloads = chamadas.filter((chamada) => chamada.caminho.startsWith("/storage/v1/object/") && chamada.metodo === "GET");
    assert.equal(downloads.length, 1, "o positivo precisa baixar exatamente um objeto real");
    const derivada = await lerMensagem(msgA, orgA);
    assert.equal(derivada.media_derived_status, "ready");
    assert.equal(String(derivada.media_derived_text).trim(), textoA);
    assert.deepEqual(await lerMensagem(msgB, orgB), controleB);
    assert.equal(redeExterna, 0, "nenhum provedor externo pode ter sido acionado");
    const pasta = path.join(process.cwd(), "evidence/media-derive-isolamento");
    mkdirSync(pasta, { recursive: true });
    writeFileSync(path.join(pasta, "recibo.json"), JSON.stringify({
      head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      run_id: process.env.GITHUB_RUN_ID ?? null,
      banco_e_storage: "reais locais", handler: "deriveMessageMedia real sobre EventRow persistido",
      jwt_proprio: { mensagem_a: "permitida", mensagem_b: "negada", storage_direto_a: "negado", storage_direto_b: "negado", alteracao_linha_a: "permitida" },
      negativos: 3, downloads_negativos: 0, marcas_skipped_negativas: 3, outras_escritas_negativas: 0,
      positivo: { downloads: 1, status: "ready", texto: textoA, extrator: "PDF real" },
      controle_b_inalterado: true, chamadas_provedor_externo: redeExterna,
      limite: "não mede navegador, cron ou fila; mede o handler e serviços reais sem dublê de SQL",
    }, null, 2));
  } finally {
    observando = false;
    const faseAnterior = fase;
    fase = "limpeza";
    const falhas: string[] = [];
    if (objetos.length && (await admin.storage.from("whatsapp-media").remove(objetos)).error) falhas.push("objetos");
    for (const id of organizacoes) if ((await admin.from("organizations").delete().eq("id", id)).error) falhas.push("organização");
    if (usuario && (await admin.auth.admin.deleteUser(usuario)).error) falhas.push("usuário");
    globalThis.fetch = fetchReal;
    assert.deepEqual(falhas, [], "a prova precisa limpar seus recursos sintéticos");
    fase = faseAnterior;
  }
}

main().then(() => process.exit(0), () => {
  process.stderr.write(`Falhou a prova real de isolamento da derivação (fase: ${fase}).\n`);
  process.exit(1);
});
