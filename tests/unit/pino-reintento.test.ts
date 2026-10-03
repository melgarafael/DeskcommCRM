/**
 * A NOVA BUSCA DO PINO que entrou só com o marcador (29/09/2026: a API do canal
 * não respondeu a tempo e o pino de um pedido confirmado ficou sem mapa).
 *
 * O que este arquivo prende:
 * - a espera de 1 minuto antes da primeira tentativa (sem tocar o banco);
 * - a recuperação grava o que a ingestão teria gravado — tipo `location`, corpo
 *   com o link (e o endereço aproximado, com a chave de Mapas), metadata antiga
 *   preservada — e nunca rebaixa um pino que já tem coordenadas;
 * - API fora ou mensagem ainda sem coordenadas: tenta de novo em 2 minutos, e
 *   desiste (`skipped`, não `error`) aos 15 minutos.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveZernioCreds } from "@/lib/channels/zernio/credentials";
import { EVENTO_NOVA_BUSCA_DO_PINO } from "@/lib/channels/zernio/localizacao";
import {
  DESISTE_APOS_MS,
  ESPERA_INICIAL_MS,
  INTERVALO_MS,
  pinoReintentoHandler,
  tratarNovaBuscaDoPino,
} from "@/lib/channels/zernio/pino-reintento.handler";
import { getRegisteredHandlers, type EventRow } from "@/lib/event-log/dispatcher";
import { ensureHandlersRegistered } from "@/lib/event-log/register-handlers";

vi.mock("@/lib/channels/zernio/credentials", async (orig) => ({
  ...(await orig<typeof import("@/lib/channels/zernio/credentials")>()),
  resolveZernioCreds: vi.fn(),
}));

const ORG = "11111111-1111-1111-1111-111111111111";
const CRIADO = Date.parse("2026-09-29T13:03:01Z");

const evento = (payload: Record<string, unknown> = {}): EventRow => ({
  id: "evt",
  organization_id: ORG,
  event_type: "message.location_retry_requested",
  entity_kind: "message",
  entity_id: "msg-1",
  payload: { message_id: "msg-1", account_id: "acc_1", provider_conversation_id: "conv-z", external_id: "wamid.PINO", ...payload },
  metadata: {},
  consumed_by: [],
  attempts: 0,
  created_at: new Date(CRIADO).toISOString(),
});

function adminFalso(opcoes: { tipo?: string; chaveDeMapas?: boolean } = {}) {
  const updates: { payload: Record<string, unknown>; filtros: [string, string, unknown][] }[] = [];
  const admin = {
    updates,
    rpc: vi.fn(async (nome: string) => ({ data: nome === "fn_decrypt_oauth" ? "CHAVE" : null, error: null })),
    from(tabela: string) {
      const filtros: [string, string, unknown][] = [];
      let payload: Record<string, unknown> | null = null;
      const q: Record<string, unknown> = {
        select: () => q,
        update: (p: Record<string, unknown>) => {
          payload = p;
          return q;
        },
        eq: (c: string, v: unknown) => (filtros.push(["eq", c, v]), q),
        neq: (c: string, v: unknown) => (filtros.push(["neq", c, v]), q),
        maybeSingle: async () => {
          if (tabela === "messages")
            return { data: { id: "msg-1", type: opcoes.tipo ?? "text", metadata: { sentiment_score: 0.5 } }, error: null };
          if (tabela === "map_provider_credentials") return { data: opcoes.chaveDeMapas ? { api_key_encrypted: "\\xabc" } : null, error: null };
          if (tabela === "organizations") return { data: { locale: "es" }, error: null };
          return { data: null, error: null };
        },
        then: (ok: (r: unknown) => unknown) => {
          if (payload) updates.push({ payload, filtros });
          return ok({ data: null, error: null });
        },
      };
      return q;
    },
  };
  return admin;
}

const listagemComPino = () =>
  new Response(
    JSON.stringify({ status: "success", messages: [{ id: "wamid.PINO", metadata: { location: { latitude: -23.5613991, longitude: -46.6565323 } } }] }),
    { status: 200 },
  );

beforeEach(() => {
  vi.mocked(resolveZernioCreds).mockResolvedValue({ accountId: "acc_1", apiKey: "k", baseUrl: "https://z.test/api", source: "session" });
});
afterEach(() => vi.restoreAllMocks());

describe("a nova busca do pino", () => {
  it("consome o evento que a ingestão emite", () => {
    expect(pinoReintentoHandler.events).toEqual(["message.location_retry_requested"]);
  });

  // A cerca `dispatcher-org-parada` confere quem está na lista PULA, não o valor
  // do campo: é aqui que "roda" no lugar de "pula" fica vermelho.
  it("numa empresa suspensa, pula — pode chamar o Google", () => {
    expect(pinoReintentoHandler.naOrgParada).toBe("pula");
  });

  // A ingestão emite pela CONSTANTE, e `evento-comando-tem-consumidor.test.ts` só
  // enxerga `p_event_type: "<literal>"`: sem esta linha, tirar o consumidor do
  // barramento deixaria o pedido `pending` para sempre com a cerca verde.
  it("o barramento registra o consumidor do pedido", () => {
    ensureHandlersRegistered();
    const consumidores = getRegisteredHandlers().filter((h) => h.events.includes(EVENTO_NOVA_BUSCA_DO_PINO));
    expect(consumidores.map((h) => h.key)).toEqual([pinoReintentoHandler.key]);
  });

  it("espera 1 minuto antes da primeira tentativa — sem tocar o banco nem a API", async () => {
    const admin = adminFalso();
    const f = vi.spyOn(globalThis, "fetch");
    const r = await tratarNovaBuscaDoPino(evento(), { admin: admin as never, agora: () => CRIADO + 5_000 });
    expect(r).toMatchObject({ status: "retry", retry_at: new Date(CRIADO + ESPERA_INICIAL_MS).toISOString() });
    expect(f).not.toHaveBeenCalled();
    expect(admin.updates).toHaveLength(0);
  });

  it("⭐ recupera o pino: tipo location, corpo com o link, metadata antiga preservada — e só se ainda não for location", async () => {
    const admin = adminFalso();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(listagemComPino());
    const r = await tratarNovaBuscaDoPino(evento(), { admin: admin as never, agora: () => CRIADO + ESPERA_INICIAL_MS });
    expect(r.status).toBe("ok");
    expect(admin.updates).toHaveLength(1);
    const [u] = admin.updates;
    expect(u!.payload).toEqual({
      type: "location",
      body: "📍 https://maps.google.com/?q=-23.5613991,-46.6565323",
      metadata: { sentiment_score: 0.5, location: { latitude: -23.5613991, longitude: -46.6565323 } },
    });
    expect(u!.filtros).toContainEqual(["eq", "organization_id", ORG]);
    expect(u!.filtros).toContainEqual(["neq", "type", "location"]);
  });

  it("com a chave de Mapas, o pino recuperado também ganha o endereço aproximado", async () => {
    const admin = adminFalso({ chaveDeMapas: true });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) =>
      String(url).includes("maps.googleapis.com")
        ? new Response(
            JSON.stringify({
              status: "OK",
              results: [
                {
                  address_components: [
                    { long_name: "Avenida Paulista", types: ["route"] },
                    { long_name: "São Paulo", types: ["administrative_area_level_2"] },
                    { long_name: "São Paulo", types: ["administrative_area_level_1"] },
                  ],
                },
              ],
            }),
            { status: 200 },
          )
        : listagemComPino(),
    );
    await tratarNovaBuscaDoPino(evento(), { admin: admin as never, agora: () => CRIADO + ESPERA_INICIAL_MS });
    expect(admin.updates[0]!.payload.body).toBe(
      "📍 Avenida Paulista, São Paulo (aprox.) — https://maps.google.com/?q=-23.5613991,-46.6565323",
    );
  });

  it("pino que já tem coordenadas não é regravado", async () => {
    const admin = adminFalso({ tipo: "location" });
    const f = vi.spyOn(globalThis, "fetch");
    const r = await tratarNovaBuscaDoPino(evento(), { admin: admin as never, agora: () => CRIADO + ESPERA_INICIAL_MS });
    expect(r).toMatchObject({ status: "skipped", detail: "ja_tem_coordenadas" });
    expect(f).not.toHaveBeenCalled();
    expect(admin.updates).toHaveLength(0);
  });

  it("API fora do ar: tenta de novo em 2 minutos; aos 15, desiste sem virar incidente", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
    const agora = CRIADO + 3 * 60_000;
    const r = await tratarNovaBuscaDoPino(evento(), { admin: adminFalso() as never, agora: () => agora });
    expect(r).toMatchObject({ status: "retry", retry_at: new Date(agora + INTERVALO_MS).toISOString() });

    const tarde = await tratarNovaBuscaDoPino(evento(), { admin: adminFalso() as never, agora: () => CRIADO + DESISTE_APOS_MS });
    expect(tarde).toMatchObject({ status: "skipped", detail: "desistiu_api_fora" });
  });

  it("a API ainda sem coordenadas (ou não era pino): tenta de novo, e desiste aos 15 minutos", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ status: "success", messages: [] }), { status: 200 }));
    const r = await tratarNovaBuscaDoPino(evento(), { admin: adminFalso() as never, agora: () => CRIADO + ESPERA_INICIAL_MS });
    expect(r.status).toBe("retry");
    const tarde = await tratarNovaBuscaDoPino(evento(), { admin: adminFalso() as never, agora: () => CRIADO + DESISTE_APOS_MS });
    expect(tarde).toMatchObject({ status: "skipped", detail: "sem_coordenadas" });
  });

  it("payload incompleto não tenta nada", async () => {
    const f = vi.spyOn(globalThis, "fetch");
    const r = await tratarNovaBuscaDoPino(evento({ external_id: null }), { admin: adminFalso() as never, agora: () => CRIADO + ESPERA_INICIAL_MS });
    expect(r).toMatchObject({ status: "skipped", detail: "payload_incompleto" });
    expect(f).not.toHaveBeenCalled();
  });
});
