/**
 * Prova curta da #3519: processador e Supabase reais, acervo HTTP sintético.
 * Usa o Supabase descartável já preparado pelo CI de E2E; não sobe serviços.
 * --validar-acervo confere somente o cliente HTTP, sem conexão de banco.
 * --executar-banco-local exige credenciais explícitas no ambiente.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { rodarUmaRodada } from "../../lib/channels/historico/rodada";
import { WahaClient } from "../../lib/waha/client";
import { credenciaisSupabaseDeTeste, destinoEhLocal } from "../lib/env-de-teste";

const AVISO = "0@s.whatsapp.net";
const TELEFONE = "5511900000001@s.whatsapp.net";
const LID = "111111111111111@lid";
const AGORA = Math.floor(Date.now() / 1000) - 60;
const CHAVE_SINTETICA = "acervo-sintetico-3519";
const chats = [AVISO, TELEFONE, LID].sort();
const mensagens = new Map(
  chats.map((chat, i) => [
    chat,
    [
      {
        id: `false_${chat}_PROVA3519${i}`,
        from: chat,
        fromMe: false,
        timestamp: AGORA,
        body: `Mensagem sintética ${i}`,
        hasMedia: false,
        ...(chat === LID
          ? { _data: { key: { remoteJidAlt: "5511900000002@s.whatsapp.net" } } }
          : {}),
      },
    ],
  ]),
);

async function main() {
  const somenteAcervo = process.argv.includes("--validar-acervo");
  assert(
    somenteAcervo || process.argv.includes("--executar-banco-local"),
    "Escolha explicitamente o modo da prova.",
  );
  const chamadas: string[] = [];
  let falharMensagens = false;
  const servidor = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const partes = url.pathname.split("/").map(decodeURIComponent);
    res.setHeader("content-type", "application/json");
    if (
      req.method !== "GET" ||
      req.headers["x-api-key"] !== CHAVE_SINTETICA ||
      partes[1] !== "api" ||
      partes[2] !== "prova-3519"
    ) {
      res.writeHead(403).end("{}");
      return;
    }
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const limit = Number(url.searchParams.get("limit") ?? 50);
    if (partes[3] === "chats" && partes.length === 4) {
      chamadas.push("chats");
      if (url.searchParams.get("sortBy") !== "id" || url.searchParams.get("sortOrder") !== "asc") {
        res.writeHead(400).end("{}");
        return;
      }
      res.end(
        JSON.stringify(
          chats.slice(offset, offset + limit).map((id) => ({ id, conversationTimestamp: AGORA })),
        ),
      );
    } else if (partes[3] === "chats" && partes[5] === "messages") {
      chamadas.push("messages");
      if (falharMensagens) {
        res.writeHead(500).end("{}");
        return;
      }
      const desde = Number(url.searchParams.get("filter.timestamp.gte") ?? 0);
      res.end(
        JSON.stringify(
          (mensagens.get(partes[4] ?? "") ?? [])
            .filter((m) => m.timestamp >= desde)
            .slice(offset, offset + limit),
        ),
      );
    } else if (partes[3] === "lids" && partes[4] === LID.split("@")[0]) {
      chamadas.push("lids");
      res.end(JSON.stringify({ pn: "5511900000002@s.whatsapp.net" }));
    } else {
      res.writeHead(404).end("{}");
    }
  });
  await new Promise<void>((resolve) => servidor.listen(0, "127.0.0.1", resolve));
  const endereco = servidor.address();
  assert(endereco && typeof endereco === "object");
  process.env.WAHA_API_BASE_URL = `http://127.0.0.1:${endereco.port}`;
  process.env.WAHA_API_KEY = CHAVE_SINTETICA;
  const criadas: string[] = [];
  let db: SupabaseClient | undefined;
  try {
    if (somenteAcervo) {
      const cliente = new WahaClient(process.env.WAHA_API_BASE_URL, CHAVE_SINTETICA);
      const pagina = await cliente.paginaDeConversas("prova-3519", { limit: 50, offset: 0 });
      assert.deepEqual(
        pagina.conversas.map((c) => c.chatId),
        chats,
      );
      assert.equal(
        (
          await cliente.paginaDeMensagens("prova-3519", AVISO, {
            limit: 100,
            offset: 0,
            desde: AGORA - 1,
          })
        ).mensagens.length,
        1,
      );
      assert.equal(
        await cliente.resolvePhoneForLid("prova-3519", LID.split("@")[0]!, { falhaLanca: true }),
        "+5511900000002",
      );
      falharMensagens = true;
      await assert.rejects(
        cliente.paginaDeMensagens("prova-3519", AVISO, { limit: 100, offset: 0, desde: AGORA - 1 }),
        /waha_messages_500/,
      );
      falharMensagens = false;
      process.stdout.write(
        `${JSON.stringify({ modo: "somente_acervo_http", chamadas, falha_http_500_propagada: true, banco_executado: false })}\n`,
      );
      return;
    }

    // Evita o fallback do helper a arquivos .env: todas as fontes são explícitas.
    for (const chave of [
      "NEXT_PUBLIC_SUPABASE_URL",
      "SUPABASE_SERVICE_ROLE_KEY",
      "SUPABASE_DB_URL",
    ]) {
      assert(process.env[chave], `Falta ${chave} no ambiente do banco descartável.`);
    }
    const credenciais = credenciaisSupabaseDeTeste();
    assert(
      destinoEhLocal(credenciais.url) && destinoEhLocal(credenciais.dbUrl),
      "Prova restrita ao banco local descartável.",
    );
    db = createClient(credenciais.url, credenciais.serviceRole, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const cliente = db;
    const orgA = randomUUID(),
      orgB = randomUUID(),
      sessao = randomUUID(),
      sessaoB = randomUUID(),
      importacao = randomUUID();
    for (const id of [orgA, orgB]) {
      const { error } = await cliente.from("organizations").insert({
        id,
        slug: `h3519-${id.replaceAll("-", "")}`,
        legal_name: "Prova sintética 3519",
        display_name: "Prova sintética 3519",
      });
      assert.ifError(error);
      criadas.push(id);
    }
    const { error: erroSessao } = await cliente.from("channel_sessions").insert([
      {
        id: sessao,
        organization_id: orgA,
        waha_session_name: "prova-3519",
        status: "WORKING",
        webhook_secret_encrypted: "\\x00",
      },
      {
        id: sessaoB,
        organization_id: orgB,
        waha_session_name: "prova-3519-controle",
        status: "WORKING",
        webhook_secret_encrypted: "\\x00",
      },
    ]);
    assert.ifError(erroSessao);

    // Sobreposição deliberada: mesmo LID, telefone e external_id em B.
    // Isto mede o escopo do processador com service_role; não mede RLS.
    const { data: contatoB, error: erroContatoB } = await cliente.rpc("fn_upsert_wa_contact", {
      p_org: orgB,
      p_kind: "lid",
      p_phone: "+5511900000002",
      p_lid: LID.split("@")[0],
      p_chat_id: LID,
      p_notify: "Controle sintético B",
    });
    assert.ifError(erroContatoB);
    assert(typeof contatoB === "string");
    const { data: conversaB, error: erroConversaB } = await cliente.rpc(
      "fn_upsert_wa_conversation_importada",
      {
        p_org: orgB,
        p_contact: contatoB,
        p_session: sessaoB,
        p_last_message_at: new Date(AGORA * 1000).toISOString(),
      },
    );
    assert.ifError(erroConversaB);
    assert(typeof conversaB === "string");
    const mensagemSobreposta = mensagens.get(LID)?.[0];
    assert(mensagemSobreposta);
    const { error: erroMensagemB } = await cliente.from("messages").insert({
      organization_id: orgB,
      conversation_id: conversaB,
      channel_session_id: sessaoB,
      contact_id: contatoB,
      external_id: mensagemSobreposta.id,
      type: "text",
      direction: "inbound",
      status: "delivered",
      sent_via: "external_device",
      body: "Controle sintético preservado",
      sent_at: new Date(AGORA * 1000).toISOString(),
      metadata: { historico_importado: "true" },
    });
    assert.ifError(erroMensagemB);
    const lerControleB = async () => {
      const retrato: Record<string, unknown[]> = {};
      for (const tabela of ["contacts", "conversations", "messages", "channel_sessions"]) {
        const { data, error } = await cliente
          .from(tabela)
          .select("*")
          .eq("organization_id", orgB)
          .order("id");
        assert.ifError(error);
        assert(data);
        retrato[tabela] = data;
      }
      return retrato;
    };
    const controleB = await lerControleB();
    assert(Object.values(controleB).every((linhas) => linhas.length === 1));
    const { error: erroImportacao } = await cliente.from("importacoes_de_historico").insert({
      id: importacao,
      organization_id: orgA,
      channel_session_id: sessao,
      status: "rodando",
      dias: 30,
      cursor: { indiceConversa: 0, offsetMensagens: 0, desde: AGORA - 86_400 },
    });
    assert.ifError(erroImportacao);

    const { error: controle } = await cliente.rpc("fn_upsert_wa_contact", {
      p_org: orgA,
      p_kind: "phone",
      p_phone: "+0",
      p_lid: null,
      p_chat_id: AVISO,
      p_notify: "Aviso sintético",
    });
    assert.equal(controle?.code, "23514", "controle: o banco real precisa recusar +0");
    const ler = async () => {
      const { data, error } = await cliente
        .from("importacoes_de_historico")
        .select("status,cursor,mensagens_gravadas,mensagens_ignoradas,erro")
        .eq("id", importacao)
        .eq("organization_id", orgA)
        .single();
      assert.ifError(error);
      assert(data);
      return data;
    };
    const contar = async (tabela: string, org: string) => {
      const { count, error } = await cliente
        .from(tabela)
        .select("id", { count: "exact", head: true })
        .eq("organization_id", org);
      assert.ifError(error);
      return count;
    };
    const primeira = await rodarUmaRodada(cliente, importacao, {
      conversas: 1,
      mensagens: 300,
      chamadas: 100,
    });
    const depoisDoAviso = await ler();
    assert.equal(primeira.status, "rodando");
    assert.equal(primeira.gravadas, 0);
    assert.equal(depoisDoAviso.cursor.indiceConversa, 1);
    assert.equal(depoisDoAviso.cursor.offsetMensagens, 0);
    assert.equal(depoisDoAviso.mensagens_gravadas, 0);
    assert.equal(depoisDoAviso.mensagens_ignoradas, 1);
    assert.equal(depoisDoAviso.erro, null);
    assert.equal(await contar("contacts", orgA), 0);

    const retomada = await rodarUmaRodada(cliente, importacao, {
      conversas: 10,
      mensagens: 300,
      chamadas: 100,
    });
    const final = await ler();
    assert.equal(retomada.status, "concluida");
    assert.equal(final.mensagens_gravadas, 2);
    assert.equal(final.erro, null);
    assert.equal(await contar("contacts", orgA), 2);
    assert.equal(await contar("messages", orgA), 2);
    const { data: conversas, error: erroConversas } = await cliente
      .from("conversations")
      .select("status,unread_count_for_assignee")
      .eq("organization_id", orgA);
    assert.ifError(erroConversas);
    assert(conversas);
    assert.equal(conversas.length, 2);
    assert(conversas.every((c) => c.status === "closed" && c.unread_count_for_assignee === 0));
    const { data: contatos, error: erroContatos } = await cliente
      .from("contacts")
      .select("phone_number,wa_lid")
      .eq("organization_id", orgA);
    assert.ifError(erroContatos);
    assert(contatos?.some((c) => c.phone_number === "+5511900000001"));
    assert(
      contatos?.some((c) => c.phone_number === "+5511900000002" && c.wa_lid === LID.split("@")[0]),
    );

    const { error: erroRepetir } = await cliente
      .from("importacoes_de_historico")
      .update({
        status: "rodando",
        cursor: { indiceConversa: 0, offsetMensagens: 0, desde: AGORA - 86_400 },
      })
      .eq("id", importacao)
      .eq("organization_id", orgA);
    assert.ifError(erroRepetir);
    assert.equal(
      (await rodarUmaRodada(cliente, importacao, { conversas: 10, mensagens: 300, chamadas: 100 }))
        .status,
      "concluida",
    );
    assert.equal(await contar("messages", orgA), 2);
    const { error: erroPrepararFalha } = await cliente
      .from("importacoes_de_historico")
      .update({
        status: "rodando",
        cursor: { indiceConversa: 1, offsetMensagens: 0, desde: AGORA - 86_400 },
      })
      .eq("id", importacao)
      .eq("organization_id", orgA);
    assert.ifError(erroPrepararFalha);
    falharMensagens = true;
    assert.equal((await rodarUmaRodada(cliente, importacao)).status, "erro");
    const falha = await ler();
    assert.match(falha.erro, /waha_messages_500/);
    assert.equal(falha.cursor.indiceConversa, 1, "a falha HTTP preserva o último cursor firme");
    falharMensagens = false;
    const { error: erroRetomarFalha } = await cliente
      .from("importacoes_de_historico")
      .update({ status: "rodando" })
      .eq("id", importacao)
      .eq("organization_id", orgA);
    assert.ifError(erroRetomarFalha);
    assert.equal((await rodarUmaRodada(cliente, importacao)).status, "concluida");
    assert.equal((await ler()).erro, null);
    assert.equal(await contar("messages", orgA), 2);
    assert.deepEqual(
      await lerControleB(),
      controleB,
      "as linhas positivas da outra organização ficam intactas",
    );
    process.stdout.write(
      `${JSON.stringify({ modo: "processador_http_banco_reais", source_head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), baseline_sha256: createHash("sha256").update(readFileSync("supabase/baseline.sql")).digest("hex"), controle_23514: true, depois_do_aviso: depoisDoAviso, final, mensagens_apos_repetir: 2, falha_http_500_e_retomada: true, outra_organizacao_com_sobreposicao_preservada: true, rls_medida: false, chamadas_http: chamadas.length, transporte: "acervo_sintetico", pareamento_real: false })}\n`,
    );
  } finally {
    try {
      if (db && criadas.length) {
        const { error } = await db
          .from("organizations")
          .delete()
          .in("id", criadas)
          .eq("legal_name", "Prova sintética 3519");
        assert.ifError(error);
      }
    } finally {
      await new Promise<void>((resolve, reject) =>
        servidor.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Prova integrada recusada"}\n`);
  process.exitCode = 1;
});
