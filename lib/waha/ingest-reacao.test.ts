import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

// ingest.ts importa @/lib/audit (→ supabase/server → validação de env);
// o mock corta a cadeia sem tocar no que está sob teste.
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

/**
 * A REAÇÃO NÃO É MENSAGEM (#2797, fatias 1 e 2).
 *
 * Dois defeitos medidos na issue: (1) o evento `message.reaction` nem entra em
 * `WHATSAPP_HOOK_EVENTS`, então o WAHA nunca entrega; (2) quando a reação chega
 * por outro caminho ela vira linha SEM emoji e SEM alvo, e ainda carimba a
 * conversa como mensagem nova — última mensagem, janela de 24h, prévia vazia e
 * contador de não lidas por um gesto que não é fala.
 *
 * O que estas provas cobrem:
 *   - a reação vira linha `type='reaction'` LIGADA à mensagem alvo;
 *   - a direção sai do `fromMe`;
 *   - emoji vazio = remoção: apaga a anterior do MESMO autor sobre o MESMO alvo;
 *   - sem alvo no CRM: descartada, NUNCA linha cega;
 *   - a reação NÃO carimba a conversa (o carimbo é `fn_mark_conversation_message`)
 *     e NÃO roda a pós-entrada (que é o que acorda o agente);
 *   - o `message.any` que repetir o payload de reação não grava a linha cega.
 *
 * ⚠️ O teste entra pelo caminho de produção (`dispatchWahaEvent`), como os
 * irmãos `ingest-citacao`/`ingest-grupo`: chamar o handler privado provaria a
 * função e mentiria sobre o roteamento.
 */

/** O que a conversa tem de carimbar — e que a reação NÃO pode chamar. */
const carimbos = vi.hoisted(() => ({
  marcadas: [] as unknown[],
  efeitos: [] as unknown[],
  avisos: [] as Array<[string, unknown]>,
}));

vi.mock("@/lib/channels/marcar-conversa", () => ({
  marcarConversaComMensagem: async (_admin: unknown, args: unknown) => {
    carimbos.marcadas.push(args);
  },
}));

vi.mock("@/lib/channels/pos-entrada", () => ({
  aplicarEfeitosPosEntrada: async (_admin: unknown, args: unknown) => {
    carimbos.efeitos.push(args);
  },
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    warn: (mensagem: string, detalhes?: unknown) => carimbos.avisos.push([mensagem, detalhes]),
    error: () => {},
    info: () => {},
    debug: () => {},
  },
}));

import { dispatchWahaEvent, type WahaEnvelope, type WahaPayload } from "@/lib/waha/ingest";

interface LinhaMessage {
  id: string;
  organization_id: string;
  conversation_id?: string | null;
  contact_id?: string | null;
  external_id: string | null;
  direction?: string;
  type?: string;
  body?: string | null;
  status?: string;
  sent_via?: string;
  metadata?: Record<string, unknown>;
  reply_to_message_id?: string | null;
  [k: string]: unknown;
}

interface Duplo {
  admin: unknown;
  messages: LinhaMessage[];
  rpcs: Array<{ fn: string; args: Record<string, unknown> }>;
}

/** Lê `metadata->reaction->>author` (o filtro que a remoção usa) e coluna simples. */
function porCaminho(linha: Record<string, unknown>, caminho: string): unknown {
  let atual: unknown = linha;
  for (const pedaco of caminho.split("->")) {
    if (typeof atual !== "object" || atual === null) return undefined;
    atual = (atual as Record<string, unknown>)[pedaco.replace(/^>/, "")];
  }
  return atual;
}

/** Admin de mentira com um "banco" em memória só de `messages`. */
function bancoDeMentira(preexistentes: Array<Partial<LinhaMessage>> = []): Duplo {
  const messages: LinhaMessage[] = preexistentes.map((m, i) => ({
    id: `pre-${i + 1}`,
    organization_id: "org-1",
    conversation_id: "conversa-1",
    contact_id: "contato-1",
    external_id: null,
    ...m,
  }));
  const rpcs: Array<{ fn: string; args: Record<string, unknown> }> = [];

  /**
   * Uma cadeia de filtros POR OPERAÇÃO.
   *
   * Um único estado compartilhado faria os filtros do SELECT do alvo contaminar
   * o DELETE da remoção — medido: o apagão casava zero linhas e o teste apontava
   * o código, não o dublê.
   */
  const cadeiaDeFiltros = () => {
    const filtros: Array<[string, unknown]> = [];
    const diferentes: Array<[string, unknown]> = [];
    let externos: string[] | null = null;
    // `%\_<cauda>` → casa qualquer `external_id` que TERMINE com `_<cauda>`.
    let sufixo: string | null = null;

    const casam = () =>
      messages.filter(
        (m) =>
          filtros.every(([c, v]) => {
            const valor = porCaminho(m as Record<string, unknown>, c);
            return Array.isArray(v) ? v.includes(valor) : (valor ?? null) === v;
          }) &&
          diferentes.every(([c, v]) => porCaminho(m as Record<string, unknown>, c) !== v) &&
          (externos === null || (m.external_id !== null && externos.includes(m.external_id))) &&
          (sufixo === null || (typeof m.external_id === "string" && m.external_id.endsWith(sufixo))),
      );

    const cadeia = {
      casam,
      eq(coluna: string, valor: unknown) {
        filtros.push([coluna, valor]);
        return cadeia;
      },
      is(coluna: string, valor: unknown) {
        filtros.push([coluna, valor]);
        return cadeia;
      },
      neq(coluna: string, valor: unknown) {
        diferentes.push([coluna, valor]);
        return cadeia;
      },
      in(coluna: string, valores: string[]) {
        if (coluna === "external_id") externos = valores;
        else filtros.push([coluna, valores]);
        return cadeia;
      },
      like(coluna: string, padrao: string) {
        if (coluna === "external_id" && padrao.startsWith("%\\_")) sufixo = "_" + padrao.slice(3);
        return cadeia;
      },
      limit: () => cadeia,
      gte: () => cadeia,
      order: () => cadeia,
      async maybeSingle() {
        return { data: casam()[0] ?? null, error: null };
      },
      // `ehEcoDeEnvioNosso` lê LISTA (sem `.maybeSingle()`).
      then(ok: (v: unknown) => unknown) {
        return Promise.resolve(ok({ data: casam(), error: null }));
      },
    };
    return cadeia;
  };

  const tabela = (nome: string) => {
    if (nome !== "messages") {
      return {
        select: () => cadeiaDeFiltros(),
        insert: () => ({ select: () => ({ maybeSingle: async () => ({ data: { id: "x" }, error: null }) }) }),
        update: () => {
          const encadeavel: { error: null; eq: () => typeof encadeavel; in: () => typeof encadeavel } = {
            error: null,
            eq: () => encadeavel,
            in: () => encadeavel,
          };
          return encadeavel;
        },
        delete: () => {
          const encadeavel: { eq: () => typeof encadeavel; select: () => Promise<unknown> } = {
            eq: () => encadeavel,
            select: async () => ({ data: [], error: null }),
          };
          return encadeavel;
        },
      };
    }
    return {
      select: () => cadeiaDeFiltros(),
      insert: (linha: Record<string, unknown>) => ({
        select: () => ({
          async maybeSingle() {
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
      update: () => {
        const encadeavel: { error: null; eq: () => typeof encadeavel; in: () => typeof encadeavel } = {
          error: null,
          eq: () => encadeavel,
          in: () => encadeavel,
        };
        return encadeavel;
      },
      // `await ....delete().eq(...)` sem `.select()` (é como a remoção roda):
      // o dublê executa no `then`, quando todos os filtros já foram empilhados.
      delete: () => {
        const cadeia = cadeiaDeFiltros();
        const encadeavel = {
          eq(coluna: string, valor: unknown) {
            cadeia.eq(coluna, valor);
            return encadeavel;
          },
          then(ok: (v: unknown) => unknown) {
            const alvos = cadeia.casam();
            for (const linha of alvos) messages.splice(messages.indexOf(linha), 1);
            return Promise.resolve(ok({ data: alvos.map((l) => ({ id: l.id })), error: null }));
          },
        };
        return encadeavel;
      },
    };
  };

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
const CHAT = "595981000111@c.us";
// Id "bare" com 20+ caracteres, como os reais do WhatsApp — o teto de 16 da
// resolução por sufixo existe justamente porque os curtos casariam por acaso.
const ALVO_BARE = "3EB0B1A2C3D4E5F60718293A";
const ALVO_FORMADO = `true_${CHAT}_${ALVO_BARE}`;

/** Payload `message.reaction` medido (WAHA, "Receive messages" > message.reaction). */
function reacao(p: Partial<WahaPayload>): WahaEnvelope {
  return {
    event: "message.reaction",
    session: "default",
    payload: {
      from: CHAT,
      fromMe: false,
      timestamp: 1_760_000_200,
      ...p,
    } as WahaPayload,
  };
}

/** A linha da bolha que o CRM gravou ao enviar — `external_id` bare. */
const BOLHA_DA_IA: Partial<LinhaMessage> = {
  id: "msg-ia",
  conversation_id: "conversa-1",
  contact_id: "contato-1",
  external_id: ALVO_BARE,
  direction: "outbound",
  body: "era o programa A ou B?",
};

const porExternalId = (messages: LinhaMessage[], externalId: string) =>
  messages.find((m) => m.external_id === externalId);

function reset() {
  carimbos.marcadas.length = 0;
  carimbos.efeitos.length = 0;
  carimbos.avisos.length = 0;
}

describe("a reação do cliente vira linha LIGADA à mensagem alvo (#2797)", () => {
  it("grava type='reaction' com o ponteiro e o emoji em metadata.reaction", async () => {
    reset();
    const { admin, messages } = bancoDeMentira([BOLHA_DA_IA]);

    await dispatchWahaEvent(
      admin as never,
      SESSION as never,
      reacao({ id: `false_${CHAT}_3EB0REACAO01`, reaction: { text: "👍", messageId: ALVO_FORMADO } }),
      "req-1",
    );

    const linha = porExternalId(messages, `false_${CHAT}_3EB0REACAO01`);
    expect(linha, "a reação não virou linha nenhuma").toBeDefined();
    expect(linha!.type).toBe("reaction");
    expect(linha!.direction, "quem reagiu é o cliente (fromMe=false)").toBe("inbound");
    expect(linha!.reply_to_message_id, "a reação entrou solta — é a linha cega da issue").toBe("msg-ia");
    expect(linha!.metadata?.reaction).toEqual({
      emoji: "👍",
      target_external_id: ALVO_FORMADO,
      author: CHAT,
    });
  });

  it("a reação do VENDEDOR (fromMe) grava outbound — a direção sai do fromMe", async () => {
    reset();
    const { admin, messages } = bancoDeMentira([BOLHA_DA_IA]);

    await dispatchWahaEvent(
      admin as never,
      SESSION as never,
      reacao({
        id: `true_${CHAT}_3EB0REACAO02`,
        fromMe: true,
        reaction: { text: "🎉", messageId: ALVO_FORMADO },
      }),
      "req-1",
    );

    const linha = porExternalId(messages, `true_${CHAT}_3EB0REACAO02`);
    expect(linha, "a reação do vendedor nem entrou").toBeDefined();
    expect(linha!.direction).toBe("outbound");
    expect(linha!.reply_to_message_id).toBe("msg-ia");
  });

  it("alvo gravado COMPLETO (`false_<chat>_<bare>`) também é encontrado pelo sufixo", async () => {
    reset();
    // O alvo gravado na forma COMPLETA — o `false_` que o webhook traz. Ele
    // não está na lista de candidatos (que leva o `true_` do evento), então só
    // o sufixo `_<cauda>` o alcança.
    const { admin, messages } = bancoDeMentira([
      { ...BOLHA_DA_IA, id: "bolha-composta", external_id: `false_${CHAT}_${ALVO_BARE}` },
    ]);

    await dispatchWahaEvent(
      admin as never,
      SESSION as never,
      reacao({ id: `false_${CHAT}_3EB0REACAO03`, reaction: { text: "👍", messageId: ALVO_FORMADO } }),
      "req-1",
    );

    const linha = porExternalId(messages, `false_${CHAT}_3EB0REACAO03`);
    expect(linha?.reply_to_message_id).toBe("bolha-composta");
  });

  it("a reentrega da MESMA reação é dedup pela chave externa (uma linha só)", async () => {
    reset();
    const { admin, messages } = bancoDeMentira([BOLHA_DA_IA]);
    const evento = reacao({ id: `false_${CHAT}_3EB0REACAO04`, reaction: { text: "👍", messageId: ALVO_FORMADO } });

    await dispatchWahaEvent(admin as never, SESSION as never, evento, "req-1");
    await dispatchWahaEvent(admin as never, SESSION as never, evento, "req-2");

    expect(messages.filter((m) => m.type === "reaction")).toHaveLength(1);
  });
});

describe("o transporte assina o gesto — sem a lista, nada chega (#2797)", () => {
  it("`message.reaction` está em WHATSAPP_HOOK_EVENTS (nos TRÊS composes)", () => {
    // O elo mais silencioso de todos: o código trata o evento perfeitamente e o
    // transporte nunca o envia. Era o defeito 1 da issue — e a mesma armadilha
    // de `mensagem-editada-e-apagada.test.ts`, que já vigia `message.edited`.
    //
    // Os TRÊS composes, e não só o de desenvolvimento: foi assinar só nele que
    // deixou a instalação real (que sobe o `.prod.yml` pelo kit) sem a reação.
    for (const arquivo of ["docker-compose.prod.yml", "docker-compose.yml", "docker-compose.local.yml"]) {
      const compose = readFileSync(arquivo, "utf8");
      const linha = compose.split("\n").find((l) => l.includes("WHATSAPP_HOOK_EVENTS")) ?? "";
      expect(linha, `${arquivo}: o WAHA nunca entrega a reação: o evento não está na lista`).toContain(
        "message.reaction",
      );
      // E o corte não pode ter custado o resto.
      const restantes = [
        "message.any",
        "message.ack",
        "message.edited",
        "message.revoked",
        "session.status",
        "state.change",
      ];
      for (const e of restantes) {
        expect(linha, `${arquivo}: sumiu ${e}`).toContain(e);
      }
    }
  });
});

describe("reação sem alvo é descartada com log — nunca linha cega (#2797)", () => {
  it("alvo desconhecido do CRM: nenhuma linha nova e o descarte fica contável", async () => {
    reset();
    const { admin, messages } = bancoDeMentira([BOLHA_DA_IA]);
    const antes = messages.length;

    await dispatchWahaEvent(
      admin as never,
      SESSION as never,
      reacao({
        id: `false_${CHAT}_3EB0REACAO05`,
        reaction: { text: "👍", messageId: `true_${CHAT}_3EB0F0E1D2C3B4A596877869` },
      }),
      "req-1",
    );

    expect(messages.length, "nasceu linha sem alvo — é a linha cega da issue").toBe(antes);
    expect(carimbos.avisos.length, "o descarte não deixou rastro no log").toBeGreaterThan(0);
  });

  it("payload sem `reaction.messageId`: descartada, sem linha e sem crash", async () => {
    reset();
    const { admin, messages } = bancoDeMentira([BOLHA_DA_IA]);
    const antes = messages.length;

    await dispatchWahaEvent(admin as never, SESSION as never, reacao({ id: `false_${CHAT}_3EB0REACAO06` }), "req-1");

    expect(messages).toHaveLength(antes);
  });

  it("o `message.any` que repetir o payload de reação NÃO grava a linha cega", async () => {
    reset();
    const { admin, messages } = bancoDeMentira([BOLHA_DA_IA]);
    const antes = messages.length;

    await dispatchWahaEvent(
      admin as never,
      SESSION as never,
      {
        event: "message.any",
        session: "default",
        payload: {
          id: `false_${CHAT}_3EB0REACAO07`,
          from: CHAT,
          fromMe: false,
          body: "👍",
          type: "reaction",
          reaction: { text: "👍", messageId: ALVO_FORMADO },
        } as WahaPayload,
      },
      "req-1",
    );

    expect(messages.length, "o `message.any` gravou uma reação sem o vínculo").toBe(antes);
  });
});

describe("emoji vazio = reação REMOVIDA: apaga a anterior do MESMO autor (#2797)", () => {
  const reacaoDe = (autor: string, alvo: string, id: string): Partial<LinhaMessage> => ({
    id,
    organization_id: "org-1",
    conversation_id: "conversa-1",
    contact_id: "contato-1",
    type: "reaction",
    direction: "inbound",
    external_id: null,
    reply_to_message_id: alvo,
    metadata: { reaction: { emoji: "👍", target_external_id: ALVO_FORMADO, author: autor } },
  });

  it("remove SÓ a linha do mesmo autor sobre o mesmo alvo, e não insere nada", async () => {
    reset();
    const { admin, messages } = bancoDeMentira([
      BOLHA_DA_IA,
      reacaoDe(CHAT, "msg-ia", "rea-1"),
      reacaoDe("outra-pessoa", "msg-ia", "rea-2"),
      reacaoDe(CHAT, "outra-bolha", "rea-3"),
    ]);

    await dispatchWahaEvent(
      admin as never,
      SESSION as never,
      reacao({ id: `false_${CHAT}_3EB0REACAO08`, reaction: { text: "", messageId: ALVO_FORMADO } }),
      "req-1",
    );

    expect(messages.some((m) => m.id === "rea-1"), "a reação anterior do autor ficou para trás").toBe(false);
    expect(messages.some((m) => m.id === "rea-2"), "apagou a reação de OUTRO autor").toBe(true);
    expect(messages.some((m) => m.id === "rea-3"), "apagou a reação do mesmo autor sobre OUTRO alvo").toBe(true);
    expect(messages.some((m) => m.type === "reaction" && m.id.startsWith("msg-")), "a remoção virou linha nova").toBe(
      false,
    );
  });
});

describe("a reação NÃO carimba a conversa como mensagem (#2797, fatia 2)", () => {
  it("não chama o carimbo (last_message_at/janela/previa/contador) nem a pós-entrada", async () => {
    reset();
    const { admin, messages, rpcs } = bancoDeMentira([BOLHA_DA_IA]);

    await dispatchWahaEvent(
      admin as never,
      SESSION as never,
      reacao({ id: `false_${CHAT}_3EB0REACAO09`, reaction: { text: "👍", messageId: ALVO_FORMADO } }),
      "req-1",
    );

    expect(messages.some((m) => m.type === "reaction")).toBe(true);
    expect(carimbos.marcadas, "a reação moveu last_message_at/previa/contador").toEqual([]);
    expect(carimbos.efeitos, "a reação passou pela pós-entrada (opt-out, lead, agente)").toEqual([]);
    expect(rpcs.filter((r) => r.fn === "fn_mark_conversation_message")).toEqual([]);
  });

  it("controle: a mensagem normal AINDA carima — o mock não mente sobre o caminho", async () => {
    reset();
    const { admin } = bancoDeMentira([BOLHA_DA_IA]);

    await dispatchWahaEvent(
      admin as never,
      SESSION as never,
      {
        event: "message.any",
        session: "default",
        payload: {
          id: `false_${CHAT}_3EB0NORMAL01`,
          from: CHAT,
          fromMe: false,
          body: "quanto custa?",
        } as WahaPayload,
      },
      "req-1",
    );

    expect(carimbos.marcadas, "o carimbo sumiu do caminho normal").toHaveLength(1);
    expect(carimbos.efeitos, "a pós-entrada sumiu do caminho normal").toHaveLength(1);
  });
});
