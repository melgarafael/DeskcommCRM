import { createClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ingest.ts importa @/lib/audit (→ supabase/server → validação de env).
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

/**
 * C1 da revisão final (#999): a deduplicação da rodada vai na query string do
 * PostgREST, e o Kong 2.8.1 devolve 414 acima de 8.192 B. Aqui o cliente é o
 * supabase-js DE VERDADE, com o `fetch` interceptado, para medir a URL que ele
 * monta no pior caso: chat `@s.whatsapp.net` (3 candidatos por mensagem de
 * entrada) com id longo, 100 mensagens numa página, todas com mídia pendente
 * (a consulta de mídia usa os mesmos candidatos).
 */
const TEL = "5511900000001@s.whatsapp.net";
const agora = Math.floor(Date.now() / 1000);
const ID_LONGO = (n: number) => `3A${String(n).padStart(4, "0")}${"F".repeat(34)}`; // 40 caracteres

const canal = vi.hoisted(() => ({ mensagens: [] as Array<Record<string, unknown>> }));
vi.mock("@/lib/waha/client", () => ({
  getWahaClient: () => ({
    async paginaDeConversas(_s: string, opts: { offset: number }) {
      if (opts.offset > 0) return { conversas: [], lidas: 0 };
      return { conversas: [{ chatId: TEL, ultimaEm: agora - 60, posicao: 0 }], lidas: 1 };
    },
    async paginaDeMensagens(_s: string, _c: string, opts: { offset: number; limit: number }) {
      const fatia = canal.mensagens.slice(opts.offset, opts.offset + opts.limit);
      return { mensagens: fatia, lidas: fatia.length };
    },
    async baixarMidiaDaMensagem() {
      return { url: null, erro: false };
    },
  }),
}));

import { candidatosDeExternalId } from "@/lib/channels/historico/mapear";
import { rodarUmaRodada } from "@/lib/channels/historico/rodada";
import type { WahaPayload } from "@/lib/waha/ingest";

/** Limite que a rodada tem que respeitar, com folga sob os 8.192 B do Kong. */
const LIMITE_DE_URL = 6 * 1024;

const urls: string[] = [];

function resposta(corpo: unknown, req: Request | RequestInit | undefined, status = 200) {
  const headers = new Headers((req as RequestInit | undefined)?.headers);
  const objeto = headers.get("accept")?.includes("vnd.pgrst.object") ?? false;
  const dado = objeto && Array.isArray(corpo) ? (corpo[0] ?? null) : corpo;
  return new Response(JSON.stringify(dado), { status, headers: { "content-type": "application/json" } });
}

const fetchFalso = async (entrada: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof entrada === "string" ? entrada : entrada instanceof URL ? entrada.href : entrada.url;
  urls.push(url);
  const metodo = (init?.method ?? "GET").toUpperCase();
  const { pathname } = new URL(url);
  if (pathname.endsWith("/importacoes_de_historico")) {
    if (metodo === "GET") {
      return resposta(
        [{ id: "imp-1", organization_id: "org-1", channel_session_id: "sess-1", status: "rodando", dias: 30, cursor: {} }],
        init,
      );
    }
    return resposta([{ id: "imp-1" }], init);
  }
  if (pathname.endsWith("/channel_sessions")) return resposta([{ waha_session_name: "nome" }], init);
  if (pathname.endsWith("/rpc/fn_titular_apagado_a_pedido")) return resposta(false, init);
  if (pathname.endsWith("/rpc/fn_upsert_wa_contact")) return resposta("ct-1", init);
  if (pathname.endsWith("/rpc/fn_upsert_wa_conversation_importada")) return resposta("cv-1", init);
  if (pathname.endsWith("/messages")) return metodo === "GET" ? resposta([], init) : resposta(null, init, 201);
  return resposta({ message: `inesperado: ${metodo} ${pathname}` }, init, 500);
};

beforeEach(() => {
  urls.length = 0;
  canal.mensagens = Array.from({ length: 100 }, (_, i) => ({
    id: `false_${TEL}_${ID_LONGO(i)}`,
    from: TEL,
    fromMe: false,
    type: "image",
    hasMedia: true,
    media: { url: null, mimetype: "image/jpeg", filename: null },
    timestamp: agora - 3600 + i,
    _data: { message: { imageMessage: { mimetype: "image/jpeg" } } },
  }));
});

describe("rodada: deduplicação cabe na URL do gateway", () => {
  it("100 mensagens @s.whatsapp.net com id longo: toda URL abaixo de 6 KB e todos os candidatos consultados", async () => {
    const admin = createClient("http://kong:8000", "chave-de-servico", {
      global: { fetch: fetchFalso },
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const r = await rodarUmaRodada(admin, "imp-1", { conversas: 10, mensagens: 1000, chamadas: 100 });
    expect(r.status).toBe("concluida");

    const consultas = urls.filter((u) => new URL(u).pathname.endsWith("/messages") && u.includes("external_id=in."));
    // As duas consultas (deduplicação e mídia) aconteceram.
    expect(consultas.length).toBeGreaterThanOrEqual(2);
    const maior = Math.max(...urls.map((u) => Buffer.byteLength(u)));
    expect(maior).toBeLessThan(LIMITE_DE_URL);

    // Fatiar não pode perder candidato: cada um aparece em alguma consulta.
    const consultados = new Set<string>();
    for (const u of consultas) {
      const valor = new URL(u).searchParams.get("external_id") ?? "";
      for (const c of valor.replace(/^in\.\(/, "").replace(/\)$/, "").split(",")) consultados.add(c.replace(/^"|"$/g, ""));
    }
    const esperados = canal.mensagens.flatMap((p) => candidatosDeExternalId(p as WahaPayload));
    expect(esperados.length).toBe(300);
    for (const c of esperados) expect(consultados.has(c)).toBe(true);
  });
});
