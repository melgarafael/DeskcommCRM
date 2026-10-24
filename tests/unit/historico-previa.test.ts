import { describe, expect, it, vi } from "vitest";

// ingest.ts importa @/lib/audit (→ supabase/server → validação de env).
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

import { calcularPrevia, TETO_DE_CHAMADAS_DA_PREVIA } from "@/lib/channels/historico/previa";

/**
 * A PRÉVIA da importação do histórico (#999): quantas conversas, mensagens,
 * áudios e imagens a janela traz, com teto de custo de chamadas ao canal.
 * Quando o teto acaba antes do fim, a prévia diz `parcial: true` e a tela lê
 * "pelo menos".
 */
const AGORA = Date.UTC(2026, 9, 20, 12, 0, 0);
const DIA = 86_400;
const desde90 = Math.floor(AGORA / 1000) - 90 * DIA;

function canalDeMentira(chats: Array<{ id: string; ts: number | null }>, msgs: Record<string, Array<Record<string, unknown>>>) {
  const chamadas: string[] = [];
  return {
    chamadas,
    paginaDeConversas: vi.fn(async (_s: string, o: { limit: number; offset: number }) => {
      chamadas.push(`chats@${o.offset}`);
      const fatia = chats.slice(o.offset, o.offset + o.limit);
      return {
        conversas: fatia
          .map((c, i) => ({ chatId: c.id, ultimaEm: c.ts, posicao: o.offset + i }))
          .filter((c) => !c.chatId.endsWith("@g.us")),
        lidas: fatia.length,
      };
    }),
    paginaDeMensagens: vi.fn(async (_s: string, chatId: string, o: { limit: number; offset: number; desde: number }) => {
      chamadas.push(`msgs:${chatId}@${o.offset}`);
      const todas = (msgs[chatId] ?? []).filter((m) => (m.timestamp as number) >= o.desde);
      const fatia = todas.slice(o.offset, o.offset + o.limit);
      return { mensagens: fatia as never[], lidas: fatia.length };
    }),
  };
}

const m = (id: string, extra: Record<string, unknown> = {}) => ({ id, timestamp: desde90 + 100, from: "5511999990000@c.us", body: "oi", ...extra });

describe("prévia da importação do histórico (#999)", () => {
  it("conta conversas na janela (ou sem data), mensagens, áudios e imagens; grupo e conversa antiga ficam fora", async () => {
    const canal = canalDeMentira(
      [
        { id: "a@c.us", ts: desde90 + 10 },
        { id: "b@c.us", ts: null },
        { id: "velha@c.us", ts: desde90 - 10 },
        { id: "grupo@g.us", ts: desde90 + 10 },
      ],
      {
        "a@c.us": [
          m("1"),
          m("2", { hasMedia: true, media: { mimetype: "audio/ogg" }, type: "ptt", _data: { type: "ptt" } }),
          m("3", { hasMedia: true, media: { mimetype: "image/jpeg" }, type: "image", _data: { type: "image" } }),
        ],
        "b@c.us": [m("4")],
        "velha@c.us": [m("5")],
      },
    );
    const p = await calcularPrevia("sessao", 90, { canal, agora: AGORA });
    expect(p).toEqual({
      conversas: 2,
      mensagens: 4,
      audios: 1,
      imagens: 1,
      desde: new Date(desde90 * 1000).toISOString(),
      parcial: false,
    });
    expect(canal.chamadas.some((c) => c.startsWith("msgs:velha"))).toBe(false);
  });

  it("para no teto de chamadas e devolve o que contou com parcial: true", async () => {
    const chats = Array.from({ length: 30 }, (_, i) => ({ id: `${i}@c.us`, ts: desde90 + 10 }));
    const msgs = Object.fromEntries(chats.map((c) => [c.id, [m(`${c.id}-1`)]]));
    const canal = canalDeMentira(chats, msgs);
    const p = await calcularPrevia("sessao", 90, { canal, agora: AGORA, tetoDeChamadas: 10 });
    expect(canal.chamadas.length).toBe(10);
    expect(p.parcial).toBe(true);
    expect(p.conversas).toBe(30);
    expect(p.mensagens).toBeGreaterThan(0);
    expect(p.mensagens).toBeLessThan(30);
  });

  it("teto acabando DURANTE a lista de conversas devolve as conversas já contadas", async () => {
    // 120 conversas = 3 páginas de 50; com teto 2, a terceira página não é pedida.
    const chats = Array.from({ length: 120 }, (_, i) => ({ id: `${i}@c.us`, ts: desde90 + 10 }));
    const canal = canalDeMentira(chats, {});
    const p = await calcularPrevia("sessao", 90, { canal, agora: AGORA, tetoDeChamadas: 2 });
    expect(canal.chamadas).toEqual(["chats@0", "chats@50"]);
    expect(p.parcial).toBe(true);
    expect(p.conversas).toBe(100);
    expect(p.mensagens).toBe(0);
  });

  it("o teto padrão é de 100 chamadas", () => {
    expect(TETO_DE_CHAMADAS_DA_PREVIA).toBe(100);
  });
});
