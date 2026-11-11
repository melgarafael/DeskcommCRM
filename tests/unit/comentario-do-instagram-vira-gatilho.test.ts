import { createHmac } from "node:crypto";

import { beforeEach, describe, expect, it } from "vitest";

/**
 * COMENTÁRIO no Instagram com palavra-chave vira ação (#4075).
 *
 * ─── O que este arquivo mede, e por que ele começa pela ENTRADA ─────────────
 *
 * Antes desta fatia o webhook do canal social só lia evento de MENSAGEM:
 * `comment.*` não tinha leitor, o comentário não era gravado e nenhum evento
 * nascia — então não havia gatilho a disparar, por mais que o motor soubesse
 * executar ações. O caminho inteiro é provado aqui, na ordem em que ele
 * acontece:
 *
 *   1. webhook assinado com `comment.created` → linha em `channel_comments` e
 *      UM evento `instagram.comment` no log;
 *   2. esse evento → o motor roda a regra da organização, com o contato certo;
 *   3. os lados opostos: sem a palavra, com a palavra escrita com acento/caixa
 *      diferentes, comentário do próprio perfil, post diferente do configurado,
 *      reentrega do provedor, outra organização e automação desligada.
 *
 * O dublê de banco é o mínimo que MORDE: `eq` filtra de verdade, `insert` grava,
 * o índice único de `channel_comments` recusa a segunda entrega e o
 * `emit_event` registra o que foi emitido. Um dublê que só conta chamadas
 * deixaria a idempotência passar verde sem provar nada.
 */

const ORG_A = "11111111-1111-4111-8111-1111111111a1";
const ORG_B = "11111111-1111-4111-8111-1111111111b1";
const SESSAO = "22222222-2222-4222-8222-22222222222a";
const CONTA = "conta-instagram-1";
const POST = "post-1";
const OUTRO_POST = "post-2";
const REGRA = "33333333-3333-4333-8333-3333333333a1";
const SECRET = "segredo-longo-o-suficiente-para-assinar";

type Linha = Record<string, unknown>;

const estado: Record<string, Linha[]> = {};
const eventos: Linha[] = [];
const execucoes: string[] = [];

function zerar() {
  for (const tabela of Object.keys(estado)) delete estado[tabela];
  estado.channel_sessions = [
    {
      id: SESSAO,
      organization_id: ORG_A,
      provider: "zernio_social",
      zernio_account_id: CONTA,
      metadata: { social_platform: "instagram" },
      archived_at: null,
    },
  ];
  estado.contacts = [];
  estado.channel_comments = [];
  estado.automation_rules = [];
  estado.automation_rule_runs = [];
  eventos.length = 0;
  execucoes.length = 0;
}

/** Chave do índice único de `channel_comments` (migration 9220). */
const chaveDoComentario = (l: Linha) => `${l.organization_id}|${l.provider}|${l.external_id}`;

/**
 * Construtor no estilo PostgREST: encadeia, filtra de verdade e resolve no
 * `await`. `maybeSingle`/`single` devolvem a primeira linha que casou.
 */
function tabelaDe(nome: string) {
  estado[nome] ??= [];
  return estado[nome];
}

function construtor(nome: string, op: "select" | "insert" | "update" | "upsert", corpo?: Linha) {
  const filtros: Array<[string, unknown]> = [];
  let ordenarPor: string | null = null;
  // `insert(...).select("id").maybeSingle()` chega em `maybeSingle`, e o mesmo
  // builder também é aguardado direto em outros pontos: a gravação acontece UMA
  // vez, na primeira resolução. Sem a trava, o encadeamento gravaria duas.
  let resolvido: { data: Linha[]; error: null } | null = null;

  const casam = (l: Linha) => filtros.every(([coluna, valor]) => l[coluna] === valor);

  const resolver = (): { data: Linha[]; error: null } => {
    if (resolvido) return resolvido;
    const linhas = tabelaDe(nome);
    if (op === "insert" || op === "upsert") {
      const entrada = corpo ?? {};
      if (op === "upsert") {
        const chave = chaveDoComentario(entrada);
        if (linhas.some((l) => chaveDoComentario(l) === chave)) {
          resolvido = { data: [], error: null };
          return resolvido;
        }
      }
      const linha = { id: `${nome}-${linhas.length + 1}`, ...entrada };
      linhas.push(linha);
      resolvido = { data: [linha], error: null };
      return resolvido;
    }
    if (op === "update") {
      const afetadas = linhas.filter(casam);
      for (const l of afetadas) Object.assign(l, corpo ?? {});
      resolvido = { data: afetadas, error: null };
      return resolvido;
    }
    const achadas = linhas.filter(casam);
    const ordenadas = ordenarPor
      ? [...achadas].sort((a, b) => String(a[ordenarPor!] ?? "").localeCompare(String(b[ordenarPor!] ?? "")))
      : achadas;
    resolvido = { data: ordenadas, error: null };
    return resolvido;
  };

  const q: Record<string, unknown> = {
    select: () => q,
    eq: (coluna: string, valor: unknown) => {
      filtros.push([coluna, valor]);
      return q;
    },
    is: (coluna: string, valor: unknown) => {
      filtros.push([coluna, valor]);
      return q;
    },
    not: () => q,
    order: (coluna: string) => {
      ordenarPor = coluna;
      return q;
    },
    limit: () => q,
    maybeSingle: async () => {
      const { data } = resolver();
      return { data: data[0] ?? null, error: null };
    },
    single: async () => {
      const { data } = resolver();
      return { data: data[0] ?? null, error: null };
    },
    then: (ok: (v: unknown) => unknown) => Promise.resolve(resolver()).then(ok),
  };
  return q;
}

const admin = {
  rpc: async (nome: string, args: Linha) => {
    if (nome !== "emit_event") return { data: null, error: null };
    const linha = {
      id: `evento-${eventos.length + 1}`,
      event_type: args.p_event_type,
      entity_kind: args.p_entity_kind,
      entity_id: args.p_entity_id,
      payload: args.p_payload ?? {},
      metadata: args.p_metadata ?? {},
      organization_id: args.p_organization_id,
    };
    eventos.push(linha);
    return { data: linha.id, error: null };
  },
  from: (nome: string) => ({
    select: () => construtor(nome, "select"),
    insert: (corpo: Linha) => construtor(nome, "insert", corpo),
    update: (corpo: Linha) => construtor(nome, "update", corpo),
    upsert: (corpo: Linha) => construtor(nome, "upsert", corpo),
  }),
} as never;

import { registerAction } from "@/lib/automation/actions";
import { runAutomationForEvent } from "@/lib/automation/engine";
import { handleInboundWebhook, type InboundWebhookInput } from "@/lib/channels/inbound";
import type { EventRow } from "@/lib/event-log/dispatcher";

/** A ação é uma das que o motor JÁ executa — nenhuma ação nova nesta fatia. */
registerAction({
  type: "call_webhook",
  async execute(ctx) {
    execucoes.push(ctx.ruleId);
    return { type: "call_webhook", status: "success" };
  },
});

/** Payload de comentário — a forma declarada em `lib/channels/zernio/comentario.ts`. */
function payloadDoComentario(over: Linha = {}, comentario: Linha = {}) {
  return {
    id: "evt-comentario-1",
    event: "comment.created",
    account: { id: CONTA, platform: "instagram" },
    comment: {
      id: "comentario-1",
      postId: POST,
      platform: "instagram",
      text: "QUERO o link",
      from: { id: "autor-1", username: "cliente", name: "Cliente" },
      createdAt: "2026-11-05T12:00:00.000Z",
      ...comentario,
    },
    ...over,
  };
}

const firmar = (corpo: string) => createHmac("sha256", SECRET).update(corpo, "utf8").digest("hex");

async function entregar(payload: Linha) {
  const rawBody = JSON.stringify(payload);
  const entrada: InboundWebhookInput = {
    session: {
      id: SESSAO,
      organization_id: ORG_A,
      provider: "zernio_social",
      display_name: "instagram · loja",
      phone_number: null,
    },
    rawBody,
    headers: new Headers({ "x-zernio-signature": firmar(rawBody) }),
    secret: SECRET,
  };
  return handleInboundWebhook(admin, entrada);
}

/** Roda o motor para cada evento emitido — é o que o dreno faz na vida real. */
async function drenar() {
  for (const evento of eventos) {
    const row: EventRow = {
      id: String(evento.id),
      organization_id: String(evento.organization_id),
      event_type: String(evento.event_type),
      entity_kind: String(evento.entity_kind),
      entity_id: (evento.entity_id as string | null) ?? null,
      payload: evento.payload as Record<string, unknown>,
      metadata: evento.metadata as Record<string, unknown>,
      consumed_by: [],
      attempts: 0,
    };
    await runAutomationForEvent(admin, row);
  }
}

function regraDaPalavra(over: Linha = {}) {
  return {
    id: REGRA,
    organization_id: ORG_A,
    name: "Comentou QUERO",
    trigger_event: "instagram.comment",
    is_active: true,
    conditions: [],
    actions: [{ type: "call_webhook", config: { url: "https://exemplo.test/hook" } }],
    trigger_config: { posts: [POST], palavras: ["QUERO"] },
    created_at: "2026-11-01T00:00:00.000Z",
    ...over,
  };
}

beforeEach(() => {
  zerar();
  estado.automation_rules = [regraDaPalavra()];
});

describe("RED que virou GREEN — o comentário com a palavra dispara UMA ação", () => {
  it("⭐ webhook de comentário grava a linha e emite UM evento da organização certa", async () => {
    const r = await entregar(payloadDoComentario());

    expect(r).toMatchObject({ ok: true });
    // Antes desta fatia: `{ status: "ignored", reason: "evento_de_outra_conta_ou_sem_interesse" }`
    // e NENHUMA linha — o comentário do cliente sumia com carimbo de normalidade.
    expect((r as { ok: true; body: Linha }).body).toMatchObject({ status: "ingested" });

    expect(estado.channel_comments).toHaveLength(1);
    expect(estado.channel_comments![0]).toMatchObject({
      organization_id: ORG_A,
      channel_session_id: SESSAO,
      provider: "zernio_social",
      platform: "instagram",
      external_id: "comentario-1",
      post_id: POST,
      author_id: "autor-1",
      author_username: "cliente",
      text: "QUERO o link",
      contact_id: "contacts-1",
    });

    expect(eventos).toHaveLength(1);
    expect(eventos[0]).toMatchObject({
      event_type: "instagram.comment",
      entity_kind: "contact",
      entity_id: "contacts-1",
      organization_id: ORG_A,
    });
    expect(eventos[0]!.payload).toMatchObject({
      comment_id: "comentario-1",
      post_id: POST,
      text: "QUERO o link",
      channel_session_id: SESSAO,
      contact_id: "contacts-1",
    });
  });

  it("⭐ o evento do comentário executa a regra, com a organização e o contato certos", async () => {
    await entregar(payloadDoComentario());
    await drenar();

    expect(execucoes).toEqual([REGRA]);
    expect(estado.automation_rule_runs).toHaveLength(1);
    expect(estado.automation_rule_runs![0]).toMatchObject({
      organization_id: ORG_A,
      rule_id: REGRA,
      contact_id: "contacts-1",
      status: "success",
    });
  });
});

describe("os lados opostos", () => {
  it("(a) comentário SEM a palavra não executa nada", async () => {
    await entregar(payloadDoComentario({}, { text: "que post lindo" }));
    await drenar();

    // A linha e o evento existem — o comentário chegou. O que não existe é ação.
    expect(estado.channel_comments).toHaveLength(1);
    expect(eventos).toHaveLength(1);
    expect(execucoes).toEqual([]);
    expect(estado.automation_rule_runs).toHaveLength(0);
  });

  it("(b) palavra com acento e caixa diferentes casa — a mesma régua do `contains`", async () => {
    estado.automation_rules = [regraDaPalavra({ trigger_config: { posts: [POST], palavras: ["Ação"] } })];
    await entregar(payloadDoComentario({}, { text: "quero saber da ACAO e do preço" }));
    await drenar();

    expect(execucoes).toEqual([REGRA]);
  });

  it("(c) comentário do PRÓPRIO perfil não vira evento nem dispara", async () => {
    const r = await entregar(
      payloadDoComentario({ account: { id: CONTA, platform: "instagram", selfId: "perfil-1" } }, {
        from: { id: "perfil-1", username: "loja", isSelf: true },
        text: "QUERO — resposta da própria loja",
      }),
    );

    expect((r as { ok: true; body: Linha }).body).toMatchObject({
      status: "ignored",
      reason: "comentario_do_proprio_perfil",
    });
    expect(estado.channel_comments).toHaveLength(0);
    expect(eventos).toHaveLength(0);
    expect(execucoes).toEqual([]);
  });

  it("(d) comentário em OUTRO post não executa a regra que escolheu um post", async () => {
    await entregar(payloadDoComentario({}, { id: "comentario-2", postId: OUTRO_POST, text: "QUERO" }));
    await drenar();

    expect(eventos).toHaveLength(1);
    expect(execucoes).toEqual([]);
  });

  it("(e) reentrega do MESMO comentário não dispara duas vezes", async () => {
    // O provedor reentrega quando não recebe 200 — e reentrega o MESMO evento.
    const primeira = await entregar(payloadDoComentario());
    const segunda = await entregar(payloadDoComentario());

    expect((primeira as { ok: true; body: Linha }).body).toMatchObject({ status: "ingested" });
    expect((segunda as { ok: true; body: Linha }).body).toMatchObject({ status: "duplicate" });
    expect(estado.channel_comments).toHaveLength(1);
    expect(eventos).toHaveLength(1);

    // UM evento no log é o que garante UMA execução: o motor roda por evento
    // consumido, então a segunda entrega não tem o que drenar.
    await drenar();
    expect(execucoes).toEqual([REGRA]);
  });

  it("(f) a regra de OUTRA organização não roda para este comentário", async () => {
    estado.automation_rules = [regraDaPalavra({ id: "regra-da-outra-org", organization_id: ORG_B })];
    await entregar(payloadDoComentario());
    await drenar();

    expect(execucoes).toEqual([]);
    expect(estado.automation_rule_runs).toHaveLength(0);
  });

  it("(g) automação DESLIGADA não executa nada", async () => {
    estado.automation_rules = [regraDaPalavra({ is_active: false })];
    await entregar(payloadDoComentario());
    await drenar();

    expect(eventos).toHaveLength(1);
    expect(execucoes).toEqual([]);
  });
});
