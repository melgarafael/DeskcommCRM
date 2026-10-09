/**
 * TESTE DO FIO DE PESSOAL (spec 21, etapa 14 — critério 11).
 *
 * Prova que `handleStasisStart` (workers/voice-agent/index.ts) USA
 * `deveRecusarChamadaPessoal` — mesmo desenho do fio de bloqueado:
 * - pessoal → `hangupChannel` UMA vez, `continueDialplan` e
 *   `garantirLeadDaConversa` NUNCA, linha gravada com `contato_pessoal`;
 * - pessoal E bloqueado → vale o bloqueio (checado primeiro);
 * - não pessoal segue exatamente igual a hoje.
 *
 * SABOTAGEM DO FIO (prova no CI, sem rodar nada local): remover a chamada a
 * `deveRecusarChamadaPessoal` dentro do worker (manter a função pura existindo
 * mas sem uso) = caso "pessoal" vermelho (`hangupChannel` nunca chamado,
 * `continueDialplan` chamado — a IA atende).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => ({
  inseridas: [] as Array<Record<string, unknown>>,
  contato: null as null | { id: string; is_blocked: boolean; is_personal: boolean } | Error,
  roteamento: {
    organization_id: "org-do-fio",
    routing_mode: "ai",
    default_ai_agent_id: null,
    fallback_user_id: null,
  },
  hangup: vi.fn<(...a: Array<unknown>) => unknown>(),
  setVar: vi.fn<(...a: Array<unknown>) => unknown>(),
  continuar: vi.fn<(...a: Array<unknown>) => unknown>(),
  garantir: vi.fn<(...a: Array<unknown>) => unknown>(async () => ({ criado: false, motivo: "ja_existe" })),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (_tabela: string) => ({
      insert: (linha: Record<string, unknown>) => {
        fakes.inseridas.push(linha);
        const resultado = { data: { id: "chamada-do-fio" }, error: null };
        return {
          select: () => ({ single: async () => resultado }),
          then: (ok: (r: unknown) => unknown) => Promise.resolve(resultado).then(ok),
        };
      },
    }),
    rpc: () => ({ single: async () => ({ data: fakes.roteamento, error: null }) }),
  }),
}));

vi.mock("@/lib/voip/ariClient", () => ({
  connectAriEvents: () => undefined,
  hangupChannel: (...args: Array<unknown>) => fakes.hangup(...args),
  setChannelVariable: (...args: Array<unknown>) => fakes.setVar(...args),
  continueDialplan: (...args: Array<unknown>) => fakes.continuar(...args),
}));

vi.mock("@/lib/voip/resolve-caller", () => ({
  resolveOrCreateCallerContact: async () => {
    if (fakes.contato instanceof Error) throw fakes.contato;
    return fakes.contato;
  },
}));

vi.mock("@/lib/leads/nascimento-do-lead", () => ({
  garantirLeadDaConversa: (...args: Array<unknown>) => fakes.garantir(...args),
}));

vi.mock("@/lib/ai/agents", () => ({ getActiveVoiceAgent: async () => null }));
vi.mock("@/lib/ai/knowledge/busca", () => ({
  buscarConhecimento: async () => ({ trechos: [] }),
  resolverAcervoDoAgente: async () => [],
}));
vi.mock("@/lib/organizacao/operante", () => ({ ehOperante: () => true }));

import { handleStasisStart } from "./index";

function eventoDeEntrada(numero: string) {
  return {
    type: "StasisStart",
    channel: { id: "canal-do-fio", dialplan: { exten: "5511999999999" }, caller: { number: numero } },
  };
}

beforeEach(() => {
  fakes.inseridas = [];
  fakes.contato = null;
  vi.clearAllMocks();
  fakes.garantir.mockResolvedValue({ criado: false, motivo: "ja_existe" });
});

describe("fio da recusa de pessoal", () => {
  it("pessoal desliga UMA vez, sem negócio, sem IA, e grava escondida com motivo próprio", async () => {
    fakes.contato = { id: "contato-pessoal", is_blocked: false, is_personal: true };
    await handleStasisStart(eventoDeEntrada("+5532984793302"));
    expect(fakes.hangup).toHaveBeenCalledTimes(1);
    expect(fakes.continuar).not.toHaveBeenCalled();
    expect(fakes.garantir).not.toHaveBeenCalled();
    expect(fakes.inseridas).toHaveLength(1);
    const linha = fakes.inseridas[0]!;
    expect(linha).toMatchObject({
      status: "ended",
      end_reason: "contato_pessoal",
      answered_at: null,
      contact_id: "contato-pessoal",
    });
    expect(typeof linha.ended_at).toBe("string");
  });

  it("pessoal e bloqueado juntos valem o bloqueio (checado primeiro)", async () => {
    fakes.contato = { id: "contato-os-dois", is_blocked: true, is_personal: true };
    await handleStasisStart(eventoDeEntrada("+5532984793302"));
    expect(fakes.hangup).toHaveBeenCalledTimes(1);
    expect(fakes.inseridas).toHaveLength(1);
    expect(fakes.inseridas[0]).toMatchObject({ end_reason: "contact_blocked" });
  });

  it("não pessoal segue exatamente igual a hoje", async () => {
    fakes.contato = { id: "contato-ok", is_blocked: false, is_personal: false };
    await handleStasisStart(eventoDeEntrada("+5532984793302"));
    expect(fakes.hangup).not.toHaveBeenCalled();
    expect(fakes.continuar).toHaveBeenCalledTimes(1);
    expect(fakes.garantir).toHaveBeenCalledTimes(1);
    expect(fakes.inseridas[0]).toMatchObject({ status: "ringing", contact_id: "contato-ok" });
  });
});
