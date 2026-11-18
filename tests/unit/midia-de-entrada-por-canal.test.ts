import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/**
 * A MÍDIA QUE O CLIENTE MANDA, EM QUALQUER CANAL.
 *
 * ─── O defeito, medido em produção ──────────────────────────────────────────
 *
 *   media.persist_requested    waha 423    zernio 0
 *
 * O cliente mandava foto, áudio ou PDF pelo canal intermediado; a linha entrava
 * com `type:"image"` e SEM bytes. O atendente via "imagem" sem imagem — e como
 * ele responde à mão, era o pior defeito do canal: perda de informação do
 * cliente, irreversível quando a plataforma descarta o arquivo.
 *
 * ─── Eram TRÊS elos partidos, e um só não bastava ──────────────────────────
 *
 * 1. O ingest guardava os anexos só no `metadata` e deixava `media_url` NULO —
 *    o worker saía com "no media_url" antes de tentar.
 * 2. O ingest nunca emitia `media.persist_requested` — ninguém acordava o
 *    worker.
 * 3. O worker chamava `fetchWahaMedia` FIXO — mesmo acordado e com URL, ele
 *    baixaria pelo transporte errado.
 *
 * Consertar um dos três deixaria os outros dois calados. Por isso os casos
 * abaixo cobrem os três, e cada um tem sabote próprio.
 */

const INGEST = readFileSync("lib/channels/zernio/ingest.ts", "utf8");
const WORKER = readFileSync("workers/media-persist-worker.ts", "utf8");
const TYPES = readFileSync("lib/channels/types.ts", "utf8");

describe("elo 1 — a URL é gravada onde o worker a procura", () => {
  it("grava `media_url` do primeiro anexo", () => {
    expect(INGEST).toMatch(/media_url: primeiro\.url/);
  });

  it("e só quando HÁ anexo com url — mensagem de texto não ganha campo vazio", () => {
    expect(INGEST).toMatch(/temAnexo && primeiro\?\.url/);
  });

  it("guarda também o mime como DICA, não como verdade", () => {
    // Quem manda é o `content-type` da resposta ao baixar; esta dica serve para
    // a tela ter o que mostrar antes de os bytes chegarem.
    expect(INGEST).toMatch(/media_mime: mimeDoAnexo\(primeiro\.type\)/);
  });
});

describe("elo 2 — alguém acorda o worker", () => {
  it("emite `media.persist_requested`", () => {
    expect(INGEST).toMatch(/p_event_type: "media\.persist_requested"/);
  });

  it("com o MESMO payload do outro canal — o consumidor é um só", () => {
    // Payload diferente por canal faria o worker adivinhar de quem veio.
    expect(INGEST).toMatch(/p_payload: \{ message_id: messageId, conversation_id: conversationId \}/);
  });

  it("nos DOIS caminhos de inserção — thread conhecida e âncora", () => {
    // A ingestão resolve a conversa por dois caminhos, e o primeiro é o mais
    // comum. Emitir só no segundo deixaria a maioria das mídias sem bytes.
    // A terceira chamada é a retomada do reprocessamento: o worker pula o que já
    // está gravado (`already stored`), então repetir o pedido não baixa de novo.
    const chamadas = [...INGEST.matchAll(/await pedirPersistenciaDaMidia\(/g)];
    expect(chamadas.length, "faltou o pedido em um dos caminhos").toBe(3);
  });

  it("NÃO pede persistência para mensagem sem anexo", () => {
    // Acordar o worker à toa faria ele buscar uma URL que não existe e marcar
    // `failed` numa mensagem que está perfeita.
    expect(INGEST).toMatch(/if \(msg\.attachments\[0\]\?\.url\)/);
  });

  it("falha do emit NÃO derruba a ingestão", () => {
    // A mensagem já está gravada e visível. Devolver 500 ao provider faria ele
    // reenviar tudo — trocaria uma mídia faltando por uma tempestade.
    expect(INGEST).toMatch(/logger\.warn\("\[zernio\] emit media\.persist_requested falhou"/);
  });
});

describe("elo 3 — quem baixa é o CANAL, não uma função fixa", () => {
  it("o seam declara `fetchInboundMedia`, COM o escopo de tenant", () => {
    // O `ChannelTenantScope &` não é enfeite: sem a organização, quem baixa a
    // mídia resolve a credencial por um identificador de provider que não é
    // único, e a issue #236 mediu esse caminho terminando na conta do `.env`.
    expect(TYPES).toMatch(/fetchInboundMedia\?\(input: ChannelTenantScope & \{/);
  });

  it("o worker despacha pelo adapter", () => {
    expect(WORKER).toMatch(/await adapter\.fetchInboundMedia\(\{/);
  });

  it("e NÃO chama mais a função de um canal só", () => {
    // Era esta linha que fazia a mídia de qualquer outro canal virar linha sem
    // bytes. O guarda primário é o `lint:channels`; este caso é a rede de baixo.
    // A CHAMADA, não a menção: o comentário que explica o defeito cita o nome
    // da função, e a primeira versão deste caso ficava vermelha por causa da
    // própria documentação da correção.
    expect(WORKER, "o worker voltou a chamar o transporte fixo").not.toMatch(
      /await fetchWahaMedia\(|= fetchWahaMedia\(/,
    );
  });

  it("pede a sessão para resolver QUEM baixa", () => {
    // Sem `channel_session_id` no select, não há como pedir o adapter — e o
    // worker voltaria a depender de um canal fixo por falta de dado.
    expect(WORKER).toMatch(/channel_session_id/);
    expect(WORKER).toMatch(/CHANNEL_SESSION_REF_COLUMNS/);
  });

  it("canal que não sabe baixar é PULADO, não marcado como falho", () => {
    // É o estado normal de um canal sem mídia de entrada. Marcar `failed` faria
    // a Central acusar um defeito que não existe.
    expect(WORKER).toMatch(/status: "skipped", detail: "canal_sem_midia_de_entrada"/);
  });

  it("o worker não nomeia nenhum provider", () => {
    expect(WORKER, "o worker está decidindo por provider").not.toMatch(
      /"waha"|"zernio"|"meta_cloud"/,
    );
  });
});

describe("o que cada canal faz com a URL", () => {
  it("o intermediado assina com Bearer — a URL dele é autenticada", () => {
    // Buscá-la sem o Bearer devolve 401. `zernioMediaFetchInit` existia desde
    // que o canal entrou e ficou sem um único chamador de produção — que é
    // exatamente por que a mídia nunca virou bytes.
    const z = readFileSync("lib/channels/adapters/zernio.ts", "utf8");
    expect(z).toMatch(/zernioMediaFetchInit\(creds\.apiKey\)/);
  });

  it("e o `content-type` da resposta manda sobre a dica do webhook", () => {
    const z = readFileSync("lib/channels/adapters/zernio.ts", "utf8");
    expect(z).toMatch(/res\.headers\.get\("content-type"\)/);
  });

  it("o canal por QR delega no que já existia — comportamento idêntico", () => {
    // O risco desta mudança é mexer no canal que funciona bem. Ele chama a
    // MESMA função, com os mesmos argumentos; só mudou quem a escolhe.
    const w = readFileSync("lib/channels/adapters/waha.ts", "utf8");
    expect(w).toMatch(/return fetchWahaMedia\(input\.url, input\.hintMime \?\? null\)/);
  });

  it("os dois devolvem o MESMO tipo, reusado e não redefinido", () => {
    // Um segundo tipo com os mesmos campos diverge em silêncio na primeira vez
    // que um lado ganhar um campo — é a doutrina do topo de `types.ts`.
    expect(TYPES).toMatch(/\}\): Promise<FetchedMedia>;/);
  });
});
