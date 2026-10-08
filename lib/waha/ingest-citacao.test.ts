import { describe, expect, it, vi } from "vitest";

// ingest.ts importa @/lib/audit (→ supabase/server → validação de env);
// o mock corta a cadeia sem tocar no que está sob teste.
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

import { dispatchWahaEvent, type WahaEnvelope, type WahaPayload } from "@/lib/waha/ingest";

/**
 * A CITAÇÃO DO CLIENTE TEM QUE ENTRAR NO FIO (issue #2474).
 *
 * O WhatsApp mostra resposta pendurada na bolha original — é como as pessoas
 * conversam ali. O caminho existia em toda parte MENOS na ingestão: o envio
 * pelo CRM grava `reply_to_message_id` (PR #305), a tela desenha o fio
 * (`ChatThread` → `MessageBubble`), e a mensagem que o cliente manda
 * "respondendo em cima" entrava solta — `reply_to_message_id` NULL e nada da
 * citação em `metadata`. O sintoma que chegou aqui: a IA tinha mandado 3 bolhas
 * (programa A, programa B, pergunta) e o cliente respondeu "explica melhor
 * isso aqui" em cima de UMA delas; sem o ponteiro, o agente não tem como saber
 * qual — e explicou os dois programas.
 *
 * ⚠️ O TESTE ENTRA PELO CAMINHO DE PRODUÇÃO (`dispatchWahaEvent`), como os
 * irmãos `ingest-celular`/`ingest-grupo`: chamar o handler privado provaria a
 * função e mentiria sobre o roteamento.
 *
 * ⚠️ O DUBLÊ APLICA TODOS OS FILTROS (eq/in/like/is/neq) na leitura. Um dublê
 * que ignorasse o filtro de `conversation_id` faria o caso "citação de outra
 * conversa não vincula" passar por acidente — e é justamente ele que impede a
 * bolha de renderizar conteúdo de OUTRO atendimento (mesma régua do envio,
 * `app/api/v1/messages/_handler.ts`).
 */

interface LinhaMessage {
  id: string;
  organization_id: string;
  conversation_id?: string | null;
  external_id: string | null;
  direction?: string;
  body?: string | null;
  sent_via?: string;
  status?: string;
  metadata?: Record<string, unknown>;
  reply_to_message_id?: string | null;
  [k: string]: unknown;
}

interface Duplo {
  admin: unknown;
  messages: LinhaMessage[];
  rpcs: Array<{ fn: string; args: Record<string, unknown> }>;
}

/** Admin de mentira com um "banco" em memória só de `messages`. */
function bancoDeMentira(preexistentes: Array<Partial<LinhaMessage>> = []): Duplo {
  const messages: LinhaMessage[] = preexistentes.map((m, i) => ({
    id: `pre-${i + 1}`,
    organization_id: "org-1",
    external_id: null,
    ...m,
  }));
  const rpcs: Array<{ fn: string; args: Record<string, unknown> }> = [];

  const consulta = (nome: string) => {
    const filtros: Array<[string, unknown]> = [];
    const diferentes: Array<[string, unknown]> = [];
    // `%\_<bare>` → casa qualquer `external_id` que TERMINE com `_<bare>`
    // (o LIKE de sufixo da resolução; ver `resolverMensagemCitada`).
    let sufixo: string | null = null;
    let externos: string[] | null = null;

    const casam = () => {
      if (nome !== "messages") return [];
      return messages.filter(
        (m) =>
          filtros.every(([c, v]) => (Array.isArray(v) ? v.includes(m[c]) : (m[c] ?? null) === v)) &&
          diferentes.every(([c, v]) => m[c] !== v) &&
          (externos === null || (m.external_id !== null && externos.includes(m.external_id))) &&
          (sufixo === null || (typeof m.external_id === "string" && m.external_id.endsWith(sufixo))),
      );
    };

    const q = {
      eq(coluna: string, valor: unknown) {
        filtros.push([coluna, valor]);
        return q;
      },
      in(coluna: string, valores: string[]) {
        if (coluna === "external_id") externos = valores;
        else filtros.push([coluna, valores]);
        return q;
      },
      is(coluna: string, valor: unknown) {
        filtros.push([coluna, valor]);
        return q;
      },
      neq(coluna: string, valor: unknown) {
        diferentes.push([coluna, valor]);
        return q;
      },
      like(coluna: string, padrao: string) {
        if (coluna === "external_id" && padrao.startsWith("%\\_")) sufixo = "_" + padrao.slice(3);
        return q;
      },
      gte() {
        return q;
      },
      order() {
        return q;
      },
      limit() {
        return q;
      },
      then(ok: (v: unknown) => unknown) {
        // `ehEcoDeEnvioNosso` lê uma LISTA (sem `.maybeSingle()`) no caminho
        // fromMe; responder no formato certo mantém o caminho inteiro exercido.
        return Promise.resolve(ok({ data: casam(), error: null }));
      },
      async maybeSingle() {
        return { data: casam()[0] ?? null, error: null };
      },
    };
    return q;
  };

  const tabela = (nome: string) => ({
    select: () => consulta(nome),
    insert: (linha: Record<string, unknown>) => ({
      select: () => ({
        async maybeSingle() {
          if (nome !== "messages") return { data: { id: "x" }, error: null };
          const externo = linha.external_id as string | null;
          const colide =
            externo !== null &&
            messages.some((m) => m.organization_id === linha.organization_id && m.external_id === externo);
          if (colide) {
            return {
              data: null,
              error: { code: "23505", message: 'duplicate key value violates "messages_org_external_id_unique"' },
            };
          }
          const nova = { id: `msg-${messages.length + 1}`, ...linha } as LinhaMessage;
          messages.push(nova);
          return { data: { id: nova.id }, error: null };
        },
      }),
    }),
    // Encadeável em qualquer profundidade/ordem — `pausarIaPorAtendimentoManual`
    // (`lib/escalacao/atendimento-manual.ts`) faz `.update(...).eq().eq()`.
    update: () => {
      const encadeavel: { error: null; eq: () => typeof encadeavel; in: () => typeof encadeavel } = {
        error: null,
        eq: () => encadeavel,
        in: () => encadeavel,
      };
      return encadeavel;
    },
  });

  const admin = {
    from: (nome: string) => tabela(nome),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcs.push({ fn, args });
      if (fn === "fn_upsert_wa_contact") return { data: "contato-1", error: null };
      if (fn === "fn_upsert_wa_conversation") return { data: "conversa-1", error: null };
      return { data: null, error: null };
    },
  };

  return { admin, messages, rpcs };
}

const SESSION = { id: "sessao-1", organization_id: "org-1" };

function envelope(payload: WahaPayload): WahaEnvelope {
  return { event: "message.any", session: "default", payload };
}

const CHAT = "595981000111@c.us";
// Ids "bare" com 20+ caracteres, como os reais do WhatsApp — o teto de 16 da
// resolução por sufixo existe justamente porque os curtos casariam por acaso.
const BOLHA_DA_IA = "3EB0B1A2C3D4E5F60718293A";
const ANTIGA_DA_CLIENTE = "3EB0C9D8E7F605142332415A";
const CLIENTE_ANTES = "3EB0D4C3B2A1908070605040";
const NAO_EXISTE = "3EB0F0E1D2C3B4A596877869";
const NOVA_DO_CELULAR = "3EB0A1B2C3D4E5F60718293B";

/** Payload NOWEB medido (issue #2474): o cliente responde em cima de uma bolha da IA. */
const RECEBIDA_CITANDO_IA: WahaPayload = {
  id: `false_${CHAT}_3EB0RESPOSTA1`,
  from: CHAT,
  fromMe: false,
  body: "explica melhor isso aqui",
  timestamp: 1_760_000_000,
  replyTo: { id: `true_${CHAT}_${BOLHA_DA_IA}`, body: "era o programa A ou B?" },
};

/** A linha que a IA gravou ao enviar — `external_id` bare, como o envio grava. */
const LINHA_DA_IA: Partial<LinhaMessage> = {
  id: "msg-ia",
  conversation_id: "conversa-1",
  external_id: BOLHA_DA_IA,
  direction: "outbound",
  body: "era o programa A ou B?",
};

const citadaGravada = (messages: LinhaMessage[], externalId: string) =>
  messages.find((m) => m.external_id === externalId);

describe("a citação do cliente vira ponteiro na linha (issue #2474)", () => {
  it("respondeu em cima de uma bolha da IA: grava `reply_to_message_id` e não copia o texto", async () => {
    const { admin, messages } = bancoDeMentira([LINHA_DA_IA]);

    await dispatchWahaEvent(admin as never, SESSION as never, envelope(RECEBIDA_CITANDO_IA), "req-1");

    const linha = citadaGravada(messages, RECEBIDA_CITANDO_IA.id!);
    expect(linha, "a mensagem do cliente nem entrou").toBeDefined();
    expect(linha!.reply_to_message_id, "a bolha entra solta no inbox — é o defeito medido").toBe("msg-ia");
    // Com a citada resolvida, o banco é a fonte da verdade: uma cópia do texto
    // ficaria velha depois de uma edição da bolha original.
    expect(Object.keys(linha!.metadata ?? {})).not.toContain("reply_to_body");
  });

  it("a forma COMPOSTA legada da citada (`true_…`) também é encontrada", async () => {
    // Linhas anteriores ao #1855 gravaram o composto; o `replyTo.id` de hoje
    // pode chegar bare. Os candidatos de `wahaEchoExternalIds` cobrem os dois.
    const { admin, messages } = bancoDeMentira([
      { ...LINHA_DA_IA, external_id: `true_${CHAT}_${BOLHA_DA_IA}` },
    ]);

    await dispatchWahaEvent(
      admin as never,
      SESSION as never,
      envelope({ ...RECEBIDA_CITANDO_IA, replyTo: { id: BOLHA_DA_IA, body: "era o programa A ou B?" } }),
      "req-1",
    );

    const linha = citadaGravada(messages, RECEBIDA_CITANDO_IA.id!);
    expect(linha!.reply_to_message_id).toBe("msg-ia");
  });

  it("a citada do PRÓPRIO cliente, com o outro formato de chat, cai no sufixo `_<bare>`", async () => {
    // O limite documentado em `wahaEchoExternalIds`: o composto que a lista
    // constrói é sempre `true_<chat>_<bare>` (eco de envio nosso); a citada do
    // cliente é `false_<chat>_<bare>` — e o chat pode vir no outro formato
    // (`@lid` de um lado, `@c.us` do outro). O sufixo alcança qualquer um.
    const { admin, messages } = bancoDeMentira([
      {
        id: "msg-cliente",
        conversation_id: "conversa-1",
        external_id: `false_${CHAT}_${ANTIGA_DA_CLIENTE}`,
        direction: "inbound",
        body: "quanto custa?",
      },
    ]);

    await dispatchWahaEvent(
      admin as never,
      SESSION as never,
      envelope({
        ...RECEBIDA_CITANDO_IA,
        replyTo: { id: `false_250302204792918@lid_${ANTIGA_DA_CLIENTE}`, body: "quanto custa?" },
      }),
      "req-1",
    );

    const linha = citadaGravada(messages, RECEBIDA_CITANDO_IA.id!);
    expect(linha!.reply_to_message_id, "a citada do cliente ficou sem o fio").toBe("msg-cliente");
  });

  it("sem `replyTo`, o id cru do `contextInfo` (`stanzaId`) resolve", async () => {
    // O NOWEB repete o id da citada no Baileys cru:
    // `_data.message.extendedTextMessage.contextInfo.stanzaId` — medido na
    // issue. É a segunda fonte quando o `replyTo` normalizado não vem.
    const { admin, messages } = bancoDeMentira([LINHA_DA_IA]);

    await dispatchWahaEvent(
      admin as never,
      SESSION as never,
      envelope({
        ...RECEBIDA_CITANDO_IA,
        replyTo: undefined,
        _data: {
          message: {
            extendedTextMessage: {
              contextInfo: {
                stanzaId: `true_${CHAT}_${BOLHA_DA_IA}`,
                quotedMessage: { conversation: "era o programa A ou B?" },
              },
            },
          },
        },
      }),
      "req-1",
    );

    const linha = citadaGravada(messages, RECEBIDA_CITANDO_IA.id!);
    expect(linha!.reply_to_message_id, "o `stanzaId` não foi lido").toBe("msg-ia");
  });

  it("citada fora do CRM: o texto do `replyTo` fica em `metadata.reply_to_body`", async () => {
    // A mensagem citada pode ser anterior à instalação (ou de outro aparelho).
    // Perder o fio é aceitável; perder o TEXTO que o cliente viu, não — ele é o
    // que a tela pode mostrar e o agente, no futuro, pode ler.
    const { admin, messages } = bancoDeMentira();

    await dispatchWahaEvent(
      admin as never,
      SESSION as never,
      envelope({
        ...RECEBIDA_CITANDO_IA,
        replyTo: { id: `true_${CHAT}_${NAO_EXISTE}`, body: "texto que só existia no aparelho" },
      }),
      "req-1",
    );

    const linha = citadaGravada(messages, RECEBIDA_CITANDO_IA.id!);
    expect(linha!.reply_to_message_id).toBeNull();
    expect(linha!.metadata?.reply_to_body).toBe("texto que só existia no aparelho");
  });

  it("citada fora do CRM sem texto no `replyTo`: o `quotedMessage` supre", async () => {
    const { admin, messages } = bancoDeMentira();

    await dispatchWahaEvent(
      admin as never,
      SESSION as never,
      envelope({
        ...RECEBIDA_CITANDO_IA,
        replyTo: undefined,
        _data: {
          message: {
            extendedTextMessage: {
              contextInfo: {
                stanzaId: `false_${CHAT}_${NAO_EXISTE}`,
                quotedMessage: { extendedTextMessage: { text: "citação rica sem linha no CRM" } },
              },
            },
          },
        },
      }),
      "req-1",
    );

    const linha = citadaGravada(messages, RECEBIDA_CITANDO_IA.id!);
    expect(linha!.reply_to_message_id).toBeNull();
    expect(linha!.metadata?.reply_to_body).toBe("citação rica sem linha no CRM");
  });
});

describe("a citação NÃO atravessa a conversa (vazamento seria pior que o defeito)", () => {
  const comTexto = { ...RECEBIDA_CITANDO_IA, replyTo: { id: `true_${CHAT}_${BOLHA_DA_IA}`, body: "era o programa A ou B?" } };

  it("citada de OUTRA conversa não vincula — e o texto fica como fallback", async () => {
    // A bolha renderiza a citada pelo texto: apontar para fora mostraria
    // conteúdo de outro atendimento. A régua é a mesma do envio.
    const { admin, messages } = bancoDeMentira([{ ...LINHA_DA_IA, conversation_id: "conversa-OUTRA" }]);

    await dispatchWahaEvent(admin as never, SESSION as never, envelope(comTexto), "req-1");

    const linha = citadaGravada(messages, RECEBIDA_CITANDO_IA.id!);
    expect(linha!.reply_to_message_id, "vinculou mensagem de outra conversa").toBeNull();
    expect(linha!.metadata?.reply_to_body).toBe("era o programa A ou B?");
  });

  it("citada de OUTRA organização não vincula (service role bypassa RLS)", async () => {
    const { admin, messages } = bancoDeMentira([{ ...LINHA_DA_IA, organization_id: "org-2" }]);

    await dispatchWahaEvent(admin as never, SESSION as never, envelope(comTexto), "req-1");

    const linha = citadaGravada(messages, RECEBIDA_CITANDO_IA.id!);
    expect(linha!.reply_to_message_id, "vazou citação entre tenants").toBeNull();
    expect(linha!.metadata?.reply_to_body).toBe("era o programa A ou B?");
  });
});

describe("a mensagem que o dono digita no celular também cita", () => {
  it("responder em cima pelo celular grava o ponteiro", async () => {
    // `handleOutboundFromUserPhone` é o irmão do inbound para `fromMe` — o
    // "responder" do aplicativo é o mesmo gesto, e a linha cai como outbound.
    const { admin, messages } = bancoDeMentira([
      {
        id: "msg-cliente",
        conversation_id: "conversa-1",
        external_id: `false_${CHAT}_${CLIENTE_ANTES}`,
        direction: "inbound",
        body: "quanto custa?",
      },
    ]);

    await dispatchWahaEvent(
      admin as never,
      SESSION as never,
      envelope({
        id: `true_${CHAT}_${NOVA_DO_CELULAR}`,
        from: CHAT,
        fromMe: true,
        body: "já te respondo por aqui",
        timestamp: 1_760_000_100,
        replyTo: { id: `false_${CHAT}_${CLIENTE_ANTES}`, body: "quanto custa?" },
      }),
      "req-1",
    );

    const linha = citadaGravada(messages, NOVA_DO_CELULAR);
    expect(linha, "a mensagem do celular nem entrou").toBeDefined();
    expect(linha!.direction).toBe("outbound");
    expect(linha!.reply_to_message_id, "resposta do celular entrou solta no fio").toBe("msg-cliente");
  });
});

describe("controle — sem citação, nada muda", () => {
  it("mensagem sem `replyTo` continua entrando com o ponteiro nulo e sem `reply_to_body`", async () => {
    const { admin, messages } = bancoDeMentira([LINHA_DA_IA]);

    await dispatchWahaEvent(
      admin as never,
      SESSION as never,
      envelope({ ...RECEBIDA_CITANDO_IA, replyTo: undefined, _data: undefined }),
      "req-1",
    );

    const linha = citadaGravada(messages, RECEBIDA_CITANDO_IA.id!);
    expect(linha).toBeDefined();
    expect(linha!.reply_to_message_id).toBeNull();
    expect(Object.keys(linha!.metadata ?? {})).not.toContain("reply_to_body");
  });
});
