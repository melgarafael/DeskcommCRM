/**
 * AS ROTAS DA CHAMADA DE VOZ — quatro defeitos que só aparecem dirigindo o
 * handler de verdade, com o dublê guardando o ESTADO que ficou.
 *
 *  1. **Opt-out.** `POST /voice/calls` selecionava `id, phone_number, name` do
 *     contato: `is_blocked` e `is_anonymized` nem chegavam à rota, e o discador
 *     ligava para quem tinha mandado "PARAR". Um telefonema é MAIS intrusivo
 *     que a mensagem que `app/api/v1/messages/_handler.ts` já barra.
 *  2. **Dono da ligação.** `resolveVoiceCall` escopava só pela organização, e
 *     `created_by` era gravado e nunca lido: qualquer `agent` derrubava a
 *     ligação de qualquer colega, no meio da frase, sem rastro.
 *  3. **A corrida do atender.** 409 do upstream virava
 *     `ok({status:"connected"})`: quem PERDIA a corrida via "conectado" na tela
 *     enquanto o áudio ia para outra pessoa.
 *  4. **Erro virando lista vazia.** `/history` respondia `ok([])` quando a
 *     consulta falhava — "deu erro" indistinguível de "nunca ligou".
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { getWacallsClient } from "@/lib/wacalls/client";
import { podeEncerrar, type VoiceCallWithSession } from "@/lib/wacalls/calls";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/wacalls/client", () => ({
  getWacallsClient: vi.fn(),
  wacallsFriendlyError: (e: unknown) => String(e),
}));

const ORG = "22222222-2222-4222-8222-222222222222";
const EU = "11111111-1111-4111-8111-111111111111";
const COLEGA = "33333333-3333-4333-8333-333333333333";
const CONTATO = "44444444-4444-4444-8444-444444444444";
const CHAMADA = "55555555-5555-4555-8555-555555555555";

/** O que cada `from(<tabela>)` devolve nesta rodada, e o que foi escrito nela. */
let respostas: Record<string, { data: unknown; error: { message: string } | null }>;
let escritas: Array<{ tabela: string; patch: unknown }>;
let inseridas: Array<{ tabela: string; linha: Record<string, unknown> }>;

function dubleSupabase() {
  return {
    from(tabela: string) {
      const cadeia: Record<string, unknown> = {};
      for (const m of ["select", "eq", "is", "order", "limit"]) {
        cadeia[m] = () => cadeia;
      }
      cadeia.update = (patch: unknown) => {
        escritas.push({ tabela, patch });
        return cadeia;
      };
      cadeia.insert = (linha: Record<string, unknown>) => {
        inseridas.push({ tabela, linha });
        return cadeia;
      };
      cadeia.single = async () => respostas[tabela] ?? { data: null, error: null };
      cadeia.maybeSingle = async () => respostas[tabela] ?? { data: null, error: null };
      cadeia.then = (ok: (r: unknown) => unknown) =>
        ok(respostas[tabela] ?? { data: [], error: null });
      return cadeia;
    },
  };
}

const wacalls = {
  startCall: vi.fn(async () => ({ callId: "up-1" })),
  acceptCall: vi.fn(async () => undefined),
  rejectCall: vi.fn(async () => undefined),
  endCall: vi.fn(async () => undefined),
  exchangeWebrtc: vi.fn(async () => ({ sdpAnswer: "v=0" })),
};

function autorizadoComo(userId: string) {
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: userId, idioma: "pt-BR" },
    org: { orgId: ORG, role: "agent" },
  } as never);
}

/** A chamada como o banco a devolve para `resolveVoiceCall`. */
function chamadaNoBanco(over: Record<string, unknown> = {}) {
  return {
    data: {
      id: CHAMADA,
      wacalls_call_id: "up-1",
      status: "connected",
      contact_id: CONTATO,
      owner_user_id: EU,
      created_by: EU,
      channel_sessions: { wacalls_session_id: "sessao-up" },
      ...over,
    },
    error: null,
  };
}

async function corpo(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  respostas = {};
  escritas = [];
  inseridas = [];
  autorizadoComo(EU);
  // ⚠️ CONSENTIMENTO DA ORGANIZAÇÃO, e ele é PRÉ-CONDIÇÃO desde que
  // `exigirVozLigada` ganhou chamadores. Sem esta linha, `POST /voice/calls`
  // recusa com 422 `voice_desligada_na_organizacao` ANTES de chegar às regras
  // de contato — e os casos abaixo mediriam a recusa errada.
  //
  // A recusa em si tem caso próprio no fim deste arquivo, e a varredura que
  // garante a guarda nas rotas é
  // `tests/unit/voz-consentimento-e-portao-de-verdade.test.ts`.
  respostas["org_voice_calls"] = { data: { enabled: true, risco_aceito_em: null }, error: null };
  vi.mocked(createClient).mockResolvedValue(dubleSupabase() as never);
  vi.mocked(getWacallsClient).mockReturnValue(wacalls as never);
});

describe("o discador respeita quem pediu para não ser incomodado", () => {
  async function discar() {
    const { POST } = await import("@/app/api/v1/voice/calls/route");
    return POST(
      new Request("http://x/api/v1/voice/calls", {
        method: "POST",
        body: JSON.stringify({ contactId: CONTATO }),
      }),
    );
  }

  const SESSAO_PAREADA = {
    data: { id: "canal-de-voz", wacalls_session_id: "sessao-up" },
    error: null,
  };

  it("controle positivo: contato normal recebe a ligação", async () => {
    respostas["channel_sessions"] = SESSAO_PAREADA;
    respostas["contacts"] = {
      data: {
        id: CONTATO,
        phone_number: "5511900000000",
        name: "Fulano",
        is_blocked: false,
        is_anonymized: false,
      },
      error: null,
    };
    respostas["voice_calls"] = { data: { id: CHAMADA }, error: null };
    const res = await discar();
    expect(res.status).toBe(201);
    expect(wacalls.startCall).toHaveBeenCalledTimes(1);
    // Quem discou já está na linha: o dono nasce com a chamada.
    expect(inseridas.find((i) => i.tabela === "voice_calls")?.linha.owner_user_id).toBe(EU);
  });

  it("contato que mandou PARAR não recebe ligação", async () => {
    respostas["channel_sessions"] = SESSAO_PAREADA;
    respostas["contacts"] = {
      data: {
        id: CONTATO,
        phone_number: "5511900000000",
        name: "Fulano",
        is_blocked: true,
        is_anonymized: false,
      },
      error: null,
    };
    const res = await discar();
    expect(res.status).toBe(403);
    // O que importa não é o código: é que NADA saiu para o telefone da pessoa.
    expect(wacalls.startCall).not.toHaveBeenCalled();
    expect(inseridas).toEqual([]);
  });

  it("contato anonimizado não recebe ligação", async () => {
    respostas["channel_sessions"] = SESSAO_PAREADA;
    respostas["contacts"] = {
      data: {
        id: CONTATO,
        phone_number: "5511900000000",
        name: "Cliente Anonimizado #1",
        is_blocked: false,
        is_anonymized: true,
      },
      error: null,
    };
    const res = await discar();
    expect(res.status).toBe(422);
    expect((await corpo(res)).error).toMatchObject({ code: "contact_anonymized" });
    expect(wacalls.startCall).not.toHaveBeenCalled();
  });
});

describe("o discador exige o consentimento da organização", () => {
  const SESSAO_PAREADA = {
    data: { id: "canal-de-voz", wacalls_session_id: "sessao-up" },
    error: null,
  };

  async function discar() {
    const { POST } = await import("@/app/api/v1/voice/calls/route");
    return POST(
      new Request("http://x/api/v1/voice/calls", {
        method: "POST",
        body: JSON.stringify({ contactId: CONTATO }),
        headers: { "content-type": "application/json" },
      }),
    );
  }

  it("organização que nunca escolheu não liga, e nada sai para o telefone", async () => {
    // `escolha = null` — a linha nem existe. É o estado de TODA organização
    // antes de alguém aceitar o risco na tela de Segurança, e o mais comum.
    respostas["org_voice_calls"] = { data: null, error: null };
    respostas["channel_sessions"] = SESSAO_PAREADA;
    respostas["contacts"] = {
      data: { id: CONTATO, phone_number: "5511900000000", name: "Fulano", is_blocked: false, is_anonymized: false },
      error: null,
    };

    const res = await discar();
    expect(res.status).toBe(422);
    expect((await corpo(res)).error).toMatchObject({ code: "voice_desligada_na_organizacao" });
    expect(wacalls.startCall, "discou sem a organização ter ligado a chamada de voz").not.toHaveBeenCalled();
    expect(inseridas).toEqual([]);
  });

  it("organização que DESLIGOU não liga", async () => {
    respostas["org_voice_calls"] = { data: { enabled: false, risco_aceito_em: null }, error: null };
    respostas["channel_sessions"] = SESSAO_PAREADA;
    respostas["contacts"] = {
      data: { id: CONTATO, phone_number: "5511900000000", name: "Fulano", is_blocked: false, is_anonymized: false },
      error: null,
    };

    const res = await discar();
    expect(res.status).toBe(422);
    expect(wacalls.startCall).not.toHaveBeenCalled();
  });

  it("leitura que não volta recusa com 503, e NÃO afirma que está desligada", async () => {
    // "não sei" disfarçado de "está desligada" faz quem opera procurar um
    // interruptor quando o problema é o banco. Fechado na AÇÃO, honesto no
    // código — é o racional escrito em `lib/voice/guarda.ts`.
    respostas["org_voice_calls"] = { data: null, error: { message: "conexão caiu" } };
    respostas["channel_sessions"] = SESSAO_PAREADA;
    respostas["contacts"] = {
      data: { id: CONTATO, phone_number: "5511900000000", name: "Fulano", is_blocked: false, is_anonymized: false },
      error: null,
    };

    const res = await discar();
    expect(res.status).toBe(503);
    expect((await corpo(res)).error).toMatchObject({ code: "voice_estado_indeterminado" });
    expect(wacalls.startCall).not.toHaveBeenCalled();
  });
});

describe("só quem está na linha desliga", () => {
  async function desligar() {
    const { DELETE } = await import("@/app/api/v1/voice/calls/[id]/route");
    return DELETE(new Request("http://x", { method: "DELETE" }), {
      params: Promise.resolve({ id: CHAMADA }),
    });
  }

  it("controle positivo: quem está na linha desliga", async () => {
    respostas["voice_calls"] = chamadaNoBanco({ owner_user_id: EU });
    const res = await desligar();
    expect(res.status).toBe(204);
    expect(wacalls.endCall).toHaveBeenCalledTimes(1);
  });

  it("colega da mesma organização NÃO derruba a ligação alheia", async () => {
    respostas["voice_calls"] = chamadaNoBanco({ owner_user_id: COLEGA, created_by: COLEGA });
    const res = await desligar();
    expect(res.status).toBe(403);
    expect((await corpo(res)).error).toMatchObject({ code: "voice_call_not_yours" });
    // A prova é o áudio que NÃO foi cortado, não o código de status.
    expect(wacalls.endCall).not.toHaveBeenCalled();
  });

  it("chamada recebida que ninguém assumiu não é de ninguém para desligar", async () => {
    respostas["voice_calls"] = chamadaNoBanco({
      owner_user_id: null,
      created_by: null,
      status: "ringing",
    });
    const res = await desligar();
    expect(res.status).toBe(403);
    expect(wacalls.endCall).not.toHaveBeenCalled();
  });

  it("o áudio de uma ligação alheia não abre no navegador de um colega", async () => {
    respostas["voice_calls"] = chamadaNoBanco({ owner_user_id: COLEGA, created_by: COLEGA });
    const { POST } = await import("@/app/api/v1/voice/calls/[id]/webrtc/route");
    const res = await POST(
      new Request("http://x", { method: "POST", body: JSON.stringify({ sdpOffer: "v=0" }) }),
      { params: Promise.resolve({ id: CHAMADA }) },
    );
    expect(res.status).toBe(403);
    expect(wacalls.exchangeWebrtc).not.toHaveBeenCalled();
  });
});

describe("quem perde a corrida do atender ouve isso, não 'conectado'", () => {
  async function atender() {
    const { POST } = await import("@/app/api/v1/voice/calls/[id]/accept/route");
    return POST(new Request("http://x", { method: "POST" }), {
      params: Promise.resolve({ id: CHAMADA }),
    });
  }

  it("controle positivo: quem atende primeiro conecta e vira dono", async () => {
    respostas["voice_calls"] = chamadaNoBanco({ owner_user_id: null, status: "ringing" });
    const res = await atender();
    expect(res.status).toBe(200);
    expect(wacalls.acceptCall).toHaveBeenCalledTimes(1);
    expect(escritas.find((e) => e.tabela === "voice_calls")?.patch).toEqual({ owner_user_id: EU });
  });

  it("409 do upstream vira recusa, e não sucesso", async () => {
    respostas["voice_calls"] = chamadaNoBanco({ owner_user_id: null, status: "ringing" });
    wacalls.acceptCall.mockRejectedValueOnce(new Error("wacalls_409: call already claimed"));
    const res = await atender();
    expect(res.status).toBe(409);
    expect((await corpo(res)).error).toMatchObject({ code: "voice_call_taken" });
  });

  it("chamada que outra pessoa já atendeu nem chega ao upstream", async () => {
    respostas["voice_calls"] = chamadaNoBanco({ owner_user_id: COLEGA, status: "connected" });
    const res = await atender();
    expect(res.status).toBe(409);
    expect(wacalls.acceptCall).not.toHaveBeenCalled();
  });

  it("atender de novo a MESMA chamada que já é minha segue idempotente", async () => {
    respostas["voice_calls"] = chamadaNoBanco({ owner_user_id: EU, status: "connected" });
    const res = await atender();
    expect(res.status).toBe(200);
    expect(wacalls.acceptCall).not.toHaveBeenCalled();
  });
});

describe("erro de consulta não é 'nunca ligou'", () => {
  async function historico() {
    const { GET } = await import("@/app/api/v1/voice/calls/history/route");
    return GET(new Request("http://x/api/v1/voice/calls/history"));
  }

  it("controle positivo: sem erro, devolve a lista", async () => {
    respostas["voice_calls"] = { data: [{ id: CHAMADA }], error: null };
    const res = await historico();
    expect(res.status).toBe(200);
    expect((await corpo(res)).data).toHaveLength(1);
  });

  it("falha de consulta responde erro, e não lista vazia", async () => {
    respostas["voice_calls"] = { data: null, error: { message: "conexão caiu" } };
    const res = await historico();
    expect(res.status).toBe(500);
    // O desfecho proibido: 200 com `[]`, que a tela lê como "nunca ligou".
    expect((await corpo(res)).data).toBeUndefined();
  });
});

describe("podeEncerrar — a regra, isolada", () => {
  const base: VoiceCallWithSession = {
    id: CHAMADA,
    wacallsCallId: "up-1",
    wacallsSessionId: "s",
    status: "connected",
    contactId: CONTATO,
    ownerUserId: null,
    createdBy: null,
  };

  it("quem está na linha pode; mais ninguém", () => {
    expect(podeEncerrar({ ...base, ownerUserId: EU }, EU)).toBe(true);
    expect(podeEncerrar({ ...base, ownerUserId: EU }, COLEGA)).toBe(false);
    // O dono VENCE quem discou: se um colega assumiu, quem discou saiu da linha.
    expect(podeEncerrar({ ...base, ownerUserId: COLEGA, createdBy: EU }, EU)).toBe(false);
  });

  it("sem dono, quem discou pelo CRM ainda está na linha", () => {
    expect(podeEncerrar({ ...base, createdBy: EU }, EU)).toBe(true);
    expect(podeEncerrar({ ...base, createdBy: COLEGA }, EU)).toBe(false);
  });

  it("chamada de ninguém não é de todos", () => {
    expect(podeEncerrar(base, EU)).toBe(false);
    expect(podeEncerrar(base, COLEGA)).toBe(false);
  });
});
