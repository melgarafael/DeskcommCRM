import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #3315 — a INGESTÃO do canal emite `contact.phone_added` quando a ficha que
 * estava SEM número ganha um.
 *
 * Dois caminhos deste arquivo preenchem o telefone de uma ficha vazia, os dois
 * com `.is("phone_number", null)` no UPDATE, e nenhum dos dois avisava:
 *
 *   A. a conversa JÁ EXISTE (a thread identifica a pessoa) e o payload traz o
 *      número — `ingestZernioInbound`, ramo de `conversaPelaThread`;
 *   B. o contato é resolvido pelo upsert (`fn_upsert_wa_contact`) e o UPDATE em
 *      TypeScript completa o que a RPC não preencheu.
 *
 * O que este arquivo prende, e por quê:
 *
 *   1. EMITE UMA VEZ por caminho, com o contato certo e o número canônico.
 *   2. NÃO emite quando a ficha JÁ tinha número — é o outro lado da transição, e
 *      sem ele um evento disparado a cada mensagem passaria no teste do lado A.
 *      O dublê precisa MORDER o filtro para medir isso: um fake que trata
 *      `.is()` como no-op devolve linha afetada nos dois casos (a lição que o
 *      arquivo vizinho `channel-ingest-zernio.test.ts` registra).
 *   3. Emite DEPOIS da gravação — a regra que o gatilho dispara lê a ficha para
 *      decidir, e `checarGuardasDeContato` mata com `no_phone` quem chega vazio.
 */

const ops: { tabela: string; op: string; payload?: unknown }[] = [];
/** A ORDEM global das escritas: o UPDATE de contacts e o emit caem aqui. */
let ordem: string[];
/** Os `emit_event` que a ingestão mandou — o que este arquivo afirma. */
let emitidos: Array<Record<string, unknown>>;
/** A FICHA como ela está no banco: é o ESTADO que faz `.is(…)` morder. */
let ficha: { id: string; phone_number: string | null };
let conversaExistente: { id: string; contact_id: string } | null;
let contatoDoUpsert: string;

/** Número SINTÉTICO do teste — nunca copiado de log (a saída das ferramentas redige). */
const TELEFONE = "+5541991234567";

/** Imita o builder do PostgREST: encadeável, resolve no `then`/`maybeSingle`. */
function chain(tabela: string, op: string, payload?: unknown): Record<string, unknown> {
  const filtros: [string, unknown][] = [];
  const proxy: Record<string, unknown> = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "maybeSingle" || prop === "single") {
          if (tabela === "conversations" && op === "select") {
            return async () => ({ data: conversaExistente, error: null });
          }
          if (tabela === "contacts" && op === "select") {
            return async () => ({ data: null, error: null });
          }
          return async () => ({ data: { id: "msg-1" }, error: null });
        }
        if (prop === "then") {
          return (ok: (v: unknown) => unknown) => {
            if (tabela === "contacts" && op === "update") {
              // Aplica os filtros contra a FICHA: `is("phone_number", null)` só
              // casa linha se ela estiver VAZIA. Sem isto o dublê diria "emitiu"
              // também para a ficha que já tinha número.
              const casou = filtros.every(([chave, valor]) => {
                const [tipo, coluna] = chave.split(":");
                if (coluna === "phone_number") {
                  return tipo === "is" ? ficha.phone_number === null : ficha.phone_number === valor;
                }
                if (coluna === "id") return ficha.id === valor;
                return true;
              });
              ordem.push("update:contacts");
              if (!casou) return ok({ data: [], error: null });
              Object.assign(ficha, payload as Record<string, unknown>);
              return ok({ data: [{ id: ficha.id }], error: null });
            }
            return ok({ data: [{ id: "row-1" }], error: null });
          };
        }
        return (...args: unknown[]) => {
          if (["eq", "is", "neq", "not"].includes(String(prop))) {
            filtros.push([`${String(prop)}:${String(args[0])}`, args[1]]);
          }
          if (["update", "insert", "eq", "is", "neq", "not", "select"].includes(String(prop))) {
            ops.push({ tabela, op: `${op}.${String(prop)}`, payload: args[0] });
          }
          return proxy;
        };
      },
    },
  ) as Record<string, unknown>;
  ops.push({ tabela, op, payload });
  return proxy;
}

const admin = {
  rpc: async (nome: string, args: Record<string, unknown>) => {
    if (nome === "emit_event") {
      if (args.p_event_type === "contact.phone_added") ordem.push("emit:contact.phone_added");
      emitidos.push(args);
      return { data: "evt-1", error: null };
    }
    if (nome === "fn_upsert_wa_contact") return { data: contatoDoUpsert, error: null };
    if (nome === "fn_upsert_wa_conversation") return { data: "conv-1", error: null };
    return { data: null, error: null };
  },
  from: (tabela: string) => ({
    select: () => chain(tabela, "select"),
    insert: (payload: unknown) => chain(tabela, "insert", payload),
    update: (payload: unknown) => chain(tabela, "update", payload),
  }),
} as never;

vi.mock("@/lib/channels/zernio/credentials", async (orig) => ({
  ...(await orig<typeof import("@/lib/channels/zernio/credentials")>()),
  // Sem retorno configurado = sem credencial: a busca do pino nem começa.
  resolveZernioCreds: vi.fn(),
}));

import { canonicalPhoneBR } from "@/lib/channels/phone-variants";
import { ingestZernioInbound } from "@/lib/channels/zernio/ingest";

const evento = (msg: Record<string, unknown> = {}) => ({
  id: "evt_1",
  event: "message.received",
  account: { id: "acc_1" },
  message: {
    id: "m_1",
    conversationId: "6a76a2dc4b8fe115e5f6c300",
    platform: "whatsapp",
    platformMessageId: "wamid.ABC",
    direction: "incoming",
    text: "hola",
    attachments: [],
    sender: { phoneNumber: TELEFONE, name: "Marcelo" },
    sentAt: "2026-08-08T01:00:00.000Z",
    ...msg,
  },
});

const ENTRADA = { organizationId: "org-1", channelSessionId: "sess-1" };

const ganhos = () => emitidos.filter((e) => e.p_event_type === "contact.phone_added");

beforeEach(() => {
  ops.length = 0;
  ordem = [];
  emitidos = [];
  ficha = { id: "contact-1", phone_number: null };
  conversaExistente = null;
  contatoDoUpsert = "contact-1";
});

describe("ingestão — a conversa JÁ EXISTE (a thread identifica a pessoa)", () => {
  beforeEach(() => {
    conversaExistente = { id: "conv-1", contact_id: "contact-1" };
  });

  it("ficha VAZIA que ganha o número emite `contact.phone_added` UMA vez", async () => {
    const r = await ingestZernioInbound(admin, { ...ENTRADA, payload: evento() });
    expect(r.status).toBe("ingested");
    expect(ganhos()).toHaveLength(1);
    expect(ganhos()[0]).toMatchObject({
      p_event_type: "contact.phone_added",
      p_entity_kind: "contact",
      p_entity_id: "contact-1",
      p_organization_id: "org-1",
      p_payload: { phone_number: canonicalPhoneBR(TELEFONE) },
    });
    // E a ficha ficou com o número: o evento descreve uma gravação que aconteceu.
    expect(ficha.phone_number).toBe(canonicalPhoneBR(TELEFONE));
  });

  it("emite DEPOIS da gravação — a regra lê a ficha para decidir", async () => {
    await ingestZernioInbound(admin, { ...ENTRADA, payload: evento() });
    expect(ordem.indexOf("update:contacts")).toBeGreaterThanOrEqual(0);
    expect(ordem.indexOf("update:contacts")).toBeLessThan(ordem.indexOf("emit:contact.phone_added"));
  });

  it("ficha que JÁ tinha número NÃO emite — não é ganho, é o mesmo dado", async () => {
    ficha = { id: "contact-1", phone_number: "+5541999990000" };
    const r = await ingestZernioInbound(admin, { ...ENTRADA, payload: evento() });
    expect(r.status).toBe("ingested");
    expect(ganhos()).toHaveLength(0);
  });

  it("CONTROLE: o evento sem telefone no payload não ganha número nem evento", async () => {
    const semNumero = evento({ sender: { phoneNumber: null, name: "Marcelo" } });
    await ingestZernioInbound(admin, { ...ENTRADA, payload: semNumero });
    expect(ganhos()).toHaveLength(0);
  });
});

describe("ingestão — contato resolvido pelo upsert (`fn_upsert_wa_contact`)", () => {
  beforeEach(() => {
    contatoDoUpsert = "contact-2";
    ficha = { id: "contact-2", phone_number: null };
  });

  it("a RPC não preencheu e o UPDATE completa: emite com o contato do upsert", async () => {
    const r = await ingestZernioInbound(admin, { ...ENTRADA, payload: evento() });
    expect(r.status).toBe("ingested");
    expect(ganhos()).toHaveLength(1);
    expect(ganhos()[0]).toMatchObject({
      p_entity_id: "contact-2",
      p_organization_id: "org-1",
      p_payload: { phone_number: canonicalPhoneBR(TELEFONE) },
    });
  });

  it("ficha que já tem número NÃO emite — é o caso da RPC que preencheu (SQL)", async () => {
    // Quando quem preenche é o `emit_event` de dentro da RPC, este UPDATE não
    // casa linha nenhuma (`is("phone_number", null)`) e o evento NÃO sai em
    // dobro: cada caminho emite só na transição.
    ficha = { id: "contact-2", phone_number: canonicalPhoneBR(TELEFONE) };
    await ingestZernioInbound(admin, { ...ENTRADA, payload: evento() });
    expect(ganhos()).toHaveLength(0);
  });
});
