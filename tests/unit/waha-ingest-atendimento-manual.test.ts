/**
 * R8 — quando uma PESSOA responde o cliente pelo celular (mensagem `fromMe` que
 * NÃO é eco de um envio do CRM), a IA é pausada NESSA conversa. Silêncio COM
 * PRAZO (`bot_silenced_until = agora + PRAZO_DO_SILENCIO_MS` + rastro de
 * handoff), sem tocar em `contacts.ai_authorized_at` — a origem do lead é
 * estado separado. O prazo em si, e a renovação a cada fala humana, são
 * medidos em `lib/escalacao/atendimento-manual.test.ts`; aqui o que se prova é
 * que o caminho REAL da ingestão chega até ele.
 *
 * Prova pelo `dispatchWahaEvent` real (admin client mockado).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

// `lib/waha/ingest.ts` alcança `lib/env.ts` (que valida na importação) via
// `pos-entrada`/`ai-response-worker`. Mesma isca dos irmãos.
const envMock: Record<string, string> = {
  ANTHROPIC_API_KEY: "sk-ant-teste",
  AI_GATEWAY_API_KEY: "",
  AI_GATEWAY_BASE_URL: "",
  OPENROUTER_API_KEY: "",
  OPENROUTER_BASE_URL: "",
  OPENAI_API_KEY: "",
};
vi.mock("@/lib/env", () => ({
  get env() {
    return envMock;
  },
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}), isServiceRoleConfigured: () => false }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/channels/health", () => ({ sincronizarSaudeDaConexao: vi.fn(async () => {}) }));

import { dispatchWahaEvent } from "@/lib/waha/ingest";
import { PRAZO_DO_SILENCIO_MS } from "@/lib/escalacao/atendimento-manual";

const ORG = "org-1";
const SESSION = { id: "sess-1", organization_id: ORG, is_warmup_complete: true, warmup_started_at: null };

interface Captura {
  conversationUpdates: Array<Record<string, unknown>>;
  rpcs: string[];
}

function makeAdmin(cap: Captura, jaRegistrada: boolean) {
  const table = (name: string) => {
    let selectCols = "";
    let mode: "select" | "insert" | "update" = "select";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {
      select: (c?: string) => {
        selectCols = c ?? "";
        return chain;
      },
      insert: () => {
        mode = "insert";
        return chain;
      },
      update: (p: Record<string, unknown>) => {
        mode = "update";
        if (name === "conversations") cap.conversationUpdates.push(p);
        return chain;
      },
      eq: () => chain,
      in: () => chain,
      limit: () => chain,
      // `ehEcoDeEnvioNosso` (lib/waha/ingest.ts, issue #519) consulta com
      // `.is("external_id", null).in("status", …).gte("created_at", …)`. Sem
      // estes elos o dublê estoura com "is is not a function" e o caso cai por
      // um motivo que nada tem a ver com o que ele mede. O `then` do fim da
      // cadeia devolve `{ data: null }`, ou seja: NENHUM envio nosso em voo —
      // que é o cenário deste arquivo (a mensagem é digitação humana de
      // verdade). Quem cobre o eco é `eco-do-envio-nao-silencia-o-bot.test.ts`.
      is: () => chain,
      gte: () => chain,
      order: () => chain,
      maybeSingle: () => {
        if (name === "messages" && mode === "select") {
          // dedup por external_id: null = mensagem genuína do celular
          return Promise.resolve({ data: jaRegistrada ? { id: "eco" } : null, error: null });
        }
        if (name === "messages" && mode === "insert") {
          return Promise.resolve({ data: { id: "msg-nova" }, error: null });
        }
        if (name === "conversations" && selectCols.includes("bot_silenced_until")) {
          return Promise.resolve({ data: { bot_silenced_until: null }, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      },
      then: (r: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(r),
    };
    return chain;
  };
  return {
    from: (n: string) => table(n),
    rpc: (fn: string) => {
      cap.rpcs.push(fn);
      if (fn === "fn_upsert_wa_contact") return Promise.resolve({ data: "contact-1", error: null });
      if (fn === "fn_upsert_wa_conversation") return Promise.resolve({ data: "conv-1", error: null });
      return Promise.resolve({ data: null, error: null });
    },
  } as never;
}

const envelopeFromMe = {
  event: "message.any",
  payload: {
    id: "true_5511999999999@c.us_ABCD",
    fromMe: true,
    to: "5511999999999@c.us",
    body: "Oi! Já te respondo com os detalhes.",
    type: "text",
    timestamp: Math.floor(Date.now() / 1000),
  },
};

beforeEach(() => vi.clearAllMocks());

describe("R8 · resposta manual pelo celular pausa a IA", () => {
  it("mensagem fromMe GENUÍNA → grava bot_silenced_until com PRAZO + rastro, sem tocar autorização", async () => {
    const cap: Captura = { conversationUpdates: [], rpcs: [] };
    const antes = Date.now();
    await dispatchWahaEvent(makeAdmin(cap, false), SESSION, envelopeFromMe, "req-1");

    const pausa = cap.conversationUpdates.find((u) => u.last_handoff_reason !== undefined);
    expect(pausa).toBeDefined();
    // NÃO é 'infinity': o silêncio vence sozinho (decisão do dono do produto).
    expect(pausa!.bot_silenced_until).not.toBe("infinity");
    const ate = new Date(String(pausa!.bot_silenced_until)).getTime();
    expect(ate).toBeGreaterThanOrEqual(antes + PRAZO_DO_SILENCIO_MS);
    expect(ate).toBeLessThanOrEqual(Date.now() + PRAZO_DO_SILENCIO_MS);
    expect(pausa).toHaveProperty("last_handoff_at");
    expect(String(pausa!.last_handoff_reason)).toMatch(/manual/i);
    // NÃO toca a elegibilidade do lead.
    for (const u of cap.conversationUpdates) {
      expect(u).not.toHaveProperty("ai_authorized_at");
    }
  });

  it("eco do próprio envio do CRM (já registrado) → NÃO pausa nada", async () => {
    const cap: Captura = { conversationUpdates: [], rpcs: [] };
    await dispatchWahaEvent(makeAdmin(cap, true), SESSION, envelopeFromMe, "req-2");
    expect(cap.conversationUpdates.find((u) => u.last_handoff_reason !== undefined)).toBeUndefined();
  });

  /**
   * O canal Zernio tem o MESMO caminho de saída-por-fora-do-CRM (`insertMessage`
   * com `direction='outbound'`). A pausa é o mesmo helper — a guarda cobra que a
   * chamada esteja lá também, já que o fake do teste de ingestão do Zernio não
   * exercita a leitura de `bot_silenced_until`.
   */
  it("zernio: o caminho de saída manual também chama pausarIaPorAtendimentoManual", () => {
    const fonte = readFileSync(
      resolve(__dirname, "../../lib/channels/zernio/ingest.ts"),
      "utf-8",
    );
    expect(fonte).toContain("pausarIaPorAtendimentoManual");
    expect(fonte).toMatch(/direction === "outbound"[\s\S]{0,200}pausarIaPorAtendimentoManual/);
  });
});
