import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A PRÉVIA DA LISTA NO CANAL OFICIAL — a MESMA régua dos outros canais (#2960).
 *
 * ─── O defeito, medido na lista ─────────────────────────────────────────────
 *
 * A prévia que a Inbox mostra (`conversations.last_message_preview`) passou a
 * sair em português nos ingests do WhatsApp por QR e de grupo, e no envio,
 * ocultar e apagar pelo CRM — todos pela MESMA função `previaDaMensagem`. O
 * canal OFICIAL ficou com uma régua própria (`previewOf` / `previewOfEcho`),
 * que devolvia "📷 Imagem" para imagem e `[tipo]` para o resto. Numa instalação
 * com os dois canais a lista misturava vocabulários: "Imagem", "📷 Imagem" e
 * "[audio]".
 *
 * ─── O efeito que dói mais ──────────────────────────────────────────────────
 *
 * As rotas de ocultar e apagar reconstroem a prévia gravada com
 * `previaDaMensagem(message.body, message.type)` e só escrevem a nova prévia se
 * ela casar com a coluna. O canal oficial gravava "📷 Imagem" (ignorando a
 * legenda), cortava o texto em 120 e gravava "👤 <nome>" no cartão — a igualdade
 * nunca fechava: a mensagem era ocultada ou apagada, mas a prévia da lista
 * continuava mostrando o conteúdo antigo.
 *
 * ─── O que estes casos prendem ──────────────────────────────────────────────
 *
 * Que imagem, áudio, documento, vídeo e figurinha gravem a MESMA prévia dos
 * outros canais (o retorno literal de `previaDaMensagem`), com e sem legenda; e
 * que, sem legenda, essa prévia seja EXATAMENTE a que as rotas de ocultar/apagar
 * reconstroem — a igualdade que faltava.
 *
 * ⚠️ Os casos entram pelo CAMINHO DE PRODUÇÃO (`ingestMetaInbound` /
 * `ingestMetaEcho`), capturando a prévia que chega ao carimbo da conversa, e não
 * chamando a régua local: quem prova o comportamento da lista é o valor
 * gravado, não o helper.
 */

const estado = vi.hoisted(() => ({
  insert: null as Record<string, unknown> | null,
  rpcs: [] as Array<{ name: string; args: Record<string, unknown> }>,
  marcacoes: [] as Array<Record<string, unknown>>,
  pausas: [] as Array<Record<string, unknown>>,
  auditorias: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/channels/contato-por-telefone", () => ({
  encontrarContatoPorTelefone: async () => null,
}));
vi.mock("@/lib/escalacao/numero-interno-de-aviso", () => ({
  ehNumeroInternoDeAviso: async () => false,
  registrarMensagemIgnorada: async () => undefined,
}));
vi.mock("@/lib/channels/marcar-conversa", () => ({
  marcarConversaComMensagem: async (_a: unknown, args: Record<string, unknown>) => {
    estado.marcacoes.push(args);
  },
}));
vi.mock("@/lib/escalacao/atendimento-manual", () => ({
  pausarIaPorAtendimentoManual: async (_a: unknown, input: Record<string, unknown>) => {
    estado.pausas.push(input);
    return true;
  },
}));
vi.mock("@/lib/channels/pos-entrada", () => ({
  aplicarEfeitosPosEntrada: async () => undefined,
}));
vi.mock("@/lib/audit", () => ({
  audit: async (entrada: Record<string, unknown>) => {
    estado.auditorias.push(entrada);
  },
}));

import { ingestMetaEcho, ingestMetaInbound } from "@/lib/channels/meta/ingest";
import type {
  InboundMessageEvent,
  OutboundEchoEvent,
} from "@/lib/channels/meta/webhook";
import { previaDaMensagem, ROTULO_DO_TIPO } from "@/lib/messaging/previa-da-mensagem";

/** Os cinco tipos de mídia do canal oficial que a issue nomeia. */
const TIPOS = ["image", "audio", "document", "video", "sticker"] as const;

/**
 * A prévia que as rotas de ocultar e apagar RECONSTROEM a partir da linha
 * gravada — elas chamam `previaDaMensagem(message.body, message.type)`.
 */
const previaQueARotaReconstroi = (body: string | null | undefined, tipo: string) =>
  previaDaMensagem(body, tipo);

function adminFalso(): SupabaseClient {
  const from = (table: string) => {
    if (table === "channel_sessions") {
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        is: () => chain,
        maybeSingle: async () => ({
          data: { id: "session-1", organization_id: "org-1" },
          error: null,
        }),
      };
      return chain;
    }
    if (table === "messages") {
      const terminal = {
        maybeSingle: async () => ({ data: { id: "message-1" }, error: null }),
      };
      return {
        insert: (payload: Record<string, unknown>) => {
          estado.insert = payload;
          return { select: () => terminal };
        },
      };
    }
    throw new Error(`tabela inesperada: ${table}`);
  };

  const rpc = async (name: string, args: Record<string, unknown>) => {
    estado.rpcs.push({ name, args });
    if (name === "fn_upsert_wa_contact") return { data: "contact-1", error: null };
    if (name === "fn_upsert_wa_conversation") return { data: "conversation-1", error: null };
    return { data: null, error: null };
  };

  return { from, rpc } as unknown as SupabaseClient;
}

function eventoRecebido(tipo: string, text: string | null): InboundMessageEvent {
  return {
    kind: "inbound_message",
    wabaId: "waba-1",
    phoneNumberId: "phone-1",
    externalId: `wamid.IN.${tipo}`,
    from: "5519999999999",
    profileName: "Cliente",
    sentAt: new Date("2026-09-15T12:00:00.000Z"),
    type: tipo,
    text,
    media: { id: "media-1", url: null, mime: "application/octet-stream", voice: false },
  };
}

function eventoEco(tipo: string, text: string | null): OutboundEchoEvent {
  return {
    kind: "outbound_echo",
    wabaId: "waba-1",
    phoneNumberId: "phone-1",
    externalId: `wamid.OUT.${tipo}`,
    to: "5519999999999",
    sentAt: new Date("2026-09-15T12:00:00.000Z"),
    type: tipo,
    text,
    media: { id: "media-9", url: null, mime: "application/octet-stream", voice: false },
  };
}

function ultimaMarcacao(): Record<string, unknown> {
  return estado.marcacoes[estado.marcacoes.length - 1]!;
}

beforeEach(() => {
  estado.insert = null;
  estado.rpcs = [];
  estado.marcacoes = [];
  estado.pausas = [];
  estado.auditorias = [];
});

describe("canal oficial — mídia recebida pela mesma régua dos outros canais (#2960)", () => {
  it.each(TIPOS)("%s COM legenda: a prévia é a legenda, como em qualquer canal", async (tipo) => {
    const legenda = `segue o ${tipo}`;
    await ingestMetaInbound(adminFalso(), eventoRecebido(tipo, legenda), { organizationId: "org-1" });

    const { preview } = ultimaMarcacao();
    expect(preview).toBe(legenda);
    expect(preview).toBe(previaDaMensagem(legenda, tipo));
    // A régua antiga do canal oficial ignorava a legenda e dizia "📷 Imagem".
    expect(preview).not.toMatch(/📷|🎵|🎤|🎬|📎|👤/);
  });

  it.each(TIPOS)("%s SEM legenda: o rótulo do tipo, e ocultar/apagar passam a reconhecer", async (tipo) => {
    await ingestMetaInbound(adminFalso(), eventoRecebido(tipo, null), { organizationId: "org-1" });

    const { preview } = ultimaMarcacao();
    expect(preview).toBe(ROTULO_DO_TIPO[tipo]);
    expect(preview).toBe(previaDaMensagem(null, tipo));
    // A IGUALDADE que faltava: a prévia gravada casa com a que as rotas de
    // ocultar e apagar reconstroem a partir do corpo NULO da mídia sem legenda.
    expect(preview).toBe(
      previaQueARotaReconstroi(estado.insert?.body as string | null, estado.insert?.type as string),
    );
  });

  it("legenda gravada também casa com a prévia reconstruída pela rota (corpo com texto)", async () => {
    const legenda = "olha essa foto";
    await ingestMetaInbound(adminFalso(), eventoRecebido("image", legenda), { organizationId: "org-1" });

    const { preview } = ultimaMarcacao();
    expect(preview).toBe(
      previaQueARotaReconstroi(estado.insert?.body as string | null, estado.insert?.type as string),
    );
  });
});

describe("canal oficial — eco da empresa (app WhatsApp Business) pela mesma régua (#2960)", () => {
  it.each(TIPOS)("%s COM legenda: a prévia é a legenda", async (tipo) => {
    const legenda = `mando o ${tipo}`;
    await ingestMetaEcho(adminFalso(), eventoEco(tipo, legenda), { organizationId: "org-1" });

    const { preview } = ultimaMarcacao();
    expect(preview).toBe(legenda);
    expect(preview).toBe(previaDaMensagem(legenda, tipo));
    expect(preview).not.toMatch(/📷|🎵|🎤|🎬|📎|👤/);
  });

  it.each(TIPOS)("%s SEM legenda: o rótulo do tipo e a igualdade da rota fecha", async (tipo) => {
    await ingestMetaEcho(adminFalso(), eventoEco(tipo, null), { organizationId: "org-1" });

    const { preview } = ultimaMarcacao();
    expect(preview).toBe(ROTULO_DO_TIPO[tipo]);
    expect(preview).toBe(previaDaMensagem(null, tipo));
    expect(preview).toBe(
      previaQueARotaReconstroi(estado.insert?.body as string | null, estado.insert?.type as string),
    );
  });
});

describe("canal oficial — texto segue a mesma régua (teto 280, não 120)", () => {
  it("texto longo é cortado em 280, como nos outros canais", async () => {
    const longo = "x".repeat(400);
    await ingestMetaInbound(adminFalso(), { ...eventoRecebido("text", longo), media: null }, {
      organizationId: "org-1",
    });

    const { preview } = ultimaMarcacao();
    expect(preview).toBe("x".repeat(280));
    expect(preview).toBe(previaDaMensagem(longo, "text"));
  });
});
