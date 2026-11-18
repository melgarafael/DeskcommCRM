import { describe, expect, it, vi } from "vitest";

// ingest.ts importa @/lib/audit (→ supabase/server → validação de env);
// o mock corta a cadeia sem tocar no que está sob teste.
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

import {
  bodyOf,
  dispatchWahaEvent,
  localizacaoDoPayload,
  resolveMessageType,
  type WahaEnvelope,
  type WahaPayload,
} from "@/lib/waha/ingest";

/**
 * O PINO PELO NÚMERO PAREADO.
 *
 * O dono mandou a localização pelo celular numa conversa do número pareado e
 * ela não apareceu no CRM. Medido numa instalação real em 02/11/2026: em 30
 * dias, ZERO mensagens de localização gravadas por esse transporte, contra 22
 * pelo número oficial no mesmo período. O WAHA entrega o pino
 * com `body` vazio e as coordenadas em `location` (`WALocation`) — e a guarda
 * "sem corpo nem mídia" o descartava nas duas direções, sem log.
 *
 * O que estes casos fixam:
 *   1. o pino entra como `type: "location"`, com o corpo legível de todo canal
 *      (link do mapa) e `metadata.location` — a chave que a tela desenha;
 *   2. vale para quem RECEBE (cliente mandou) e para quem ENVIA pelo celular;
 *   3. a forma do NOWEB por dentro (`_data.message.locationMessage`) também serve;
 *   4. coordenada fora da Terra não vira pino, e o resto não muda.
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

const CHAT = "5511900000111@c.us";
const PINO = { latitude: -23.55, longitude: -46.63, live: false, name: "Padaria Central", address: "Rua das Flores, 100" };

describe("o pino entra nas duas direções", () => {
  it("o cliente mandou a localização: entra como location, com link e metadata.location", async () => {
    const { admin, messages } = bancoDeMentira();
    await dispatchWahaEvent(
      admin as never,
      SESSION as never,
      envelope({ id: `false_${CHAT}_3EB0PINO0000000000000001`, from: CHAT, fromMe: false, body: "", location: PINO, timestamp: 1_760_000_000 }),
      "req-1",
    );
    const linha = messages.find((m) => m.direction === "inbound");
    expect(linha, "o pino do cliente foi descartado").toBeDefined();
    expect(linha!.type).toBe("location");
    expect(linha!.body).toBe("📍 Padaria Central — Rua das Flores, 100 — https://maps.google.com/?q=-23.55,-46.63");
    expect(linha!.metadata?.location).toEqual({
      latitude: -23.55,
      longitude: -46.63,
      nome: "Padaria Central",
      endereco: "Rua das Flores, 100",
    });
  });

  it("o dono mandou a localização pelo celular: entra como outbound location", async () => {
    const { admin, messages } = bancoDeMentira();
    await dispatchWahaEvent(
      admin as never,
      SESSION as never,
      envelope({ id: `true_${CHAT}_3EB0PINO0000000000000002`, from: CHAT, to: CHAT, fromMe: true, body: "", location: { latitude: -23.5, longitude: -46.6 }, timestamp: 1_760_000_100 }),
      "req-1",
    );
    const linha = messages.find((m) => m.direction === "outbound");
    expect(linha, "o pino do celular foi descartado").toBeDefined();
    expect(linha!.type).toBe("location");
    expect(linha!.sent_via).toBe("external_device");
    expect(linha!.body).toBe("📍 https://maps.google.com/?q=-23.5,-46.6");
    expect(linha!.metadata?.location).toEqual({ latitude: -23.5, longitude: -46.6 });
  });
});

describe("a leitura do pino", () => {
  it("a forma do NOWEB por dentro (`_data.message.locationMessage`) também serve", () => {
    const p: WahaPayload = {
      id: "x",
      body: "",
      _data: { message: { locationMessage: { degreesLatitude: -23.5, degreesLongitude: -46.6, name: "Casa" } } },
    };
    expect(localizacaoDoPayload(p)).toEqual({ latitude: -23.5, longitude: -46.6, nome: "Casa" });
    expect(resolveMessageType(p)).toBe("location");
  });

  it("no WEBJS o `body` do pino é a miniatura: o corpo gravado é o do pino, não ela", () => {
    expect(bodyOf({ id: "x", type: "location", body: "/9j/4AAQSkZJRgABAQ…", location: { latitude: 1, longitude: 2 } })).toBe(
      "📍 https://maps.google.com/?q=1,2",
    );
  });

  it("coordenada fora da Terra ou (0,0) não vira pino — e mensagem comum não muda", async () => {
    expect(localizacaoDoPayload({ id: "x", location: { latitude: 120, longitude: 10 } })).toBeNull();
    expect(localizacaoDoPayload({ id: "x", location: { latitude: 0, longitude: 0 } })).toBeNull();
    const comum: WahaPayload = { id: "x", body: "oi", location: null };
    expect(resolveMessageType(comum)).toBe("text");
    expect(bodyOf(comum)).toBe("oi");

    // Pino inválido, sem corpo nem mídia: continua não entrando (nada de linha vazia).
    const { admin, messages } = bancoDeMentira();
    await dispatchWahaEvent(
      admin as never,
      SESSION as never,
      envelope({ id: `true_${CHAT}_3EB0PINO0000000000000003`, from: CHAT, to: CHAT, fromMe: true, body: "", location: { latitude: 0, longitude: 0 } }),
      "req-1",
    );
    expect(messages).toHaveLength(0);
  });
});
