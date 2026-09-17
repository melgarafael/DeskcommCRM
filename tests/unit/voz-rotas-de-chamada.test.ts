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
// Só o CLIENTE é dublê. `wacallsFriendlyError`/`wacallsSemConexao` são puras e
// entram de verdade: o caso do socket caído mede a rota escolhendo 503 a partir
// do texto real do upstream, e um dublê aqui mediria o dublê.
// O número discável é perguntado ao WAHA; aqui ele é o do cadastro por padrão,
// e o caso do nono dígito troca a resposta. O resolvedor em si tem arquivo
// próprio (`tests/unit/voz-numero-discavel.test.ts`).
const numeroDiscavel = vi.hoisted(() => ({
  resolver: vi.fn(async (_db: unknown, _org: string, telefone: string) => ({
    digitos: telefone.replace(/\D/g, ""),
    fonte: "cadastro" as "cadastro" | "whatsapp",
  })),
}));
vi.mock("@/lib/voice/numero-discavel", () => ({ resolverNumeroDiscavel: numeroDiscavel.resolver }));
vi.mock("@/lib/wacalls/client", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getWacallsClient: vi.fn(),
}));

const ORG = "22222222-2222-4222-8222-222222222222";
const EU = "11111111-1111-4111-8111-111111111111";
const COLEGA = "33333333-3333-4333-8333-333333333333";
const CONTATO = "44444444-4444-4444-8444-444444444444";
const CHAMADA = "55555555-5555-4555-8555-555555555555";

/** O que cada `from(<tabela>)` devolve nesta rodada, e o que foi escrito nela. */
type Resposta = { data: unknown; error: { message: string; code?: string } | null };
let respostas: Record<string, Resposta | (() => Resposta)>;
let escritas: Array<{ tabela: string; patch: unknown; filtros: Array<[string, unknown]> }>;
let inseridas: Array<{ tabela: string; linha: Record<string, unknown> }>;
/** O que cada tabela pediu em `.select(...)` — a resposta da rota é o que ela seleciona. */
let selecionadas: Array<{ tabela: string; colunas: string }>;
/** Todo `.eq()` de leitura, por tabela — o filtro é o que decide QUAL linha volta. */
let filtrosLidos: Array<{ tabela: string; coluna: string; valor: unknown }>;

function dubleSupabase() {
  return {
    from(tabela: string) {
      const cadeia: Record<string, unknown> = {};
      // Os filtros de um UPDATE são registrados: um UPDATE sem o
      // `wacalls_call_id` reescreveria toda ligação da organização, e um dublê
      // que ignora `.eq()` deixaria isso verde.
      let filtrosDaEscrita: Array<[string, unknown]> | null = null;
      for (const m of ["is", "order", "limit"]) {
        cadeia[m] = () => cadeia;
      }
      cadeia.select = (colunas?: string) => {
        selecionadas.push({ tabela, colunas: colunas ?? "*" });
        return cadeia;
      };
      cadeia.eq = (coluna: string, valor: unknown) => {
        if (filtrosDaEscrita) filtrosDaEscrita.push([coluna, valor]);
        else filtrosLidos.push({ tabela, coluna, valor });
        return cadeia;
      };
      cadeia.update = (patch: unknown) => {
        filtrosDaEscrita = [];
        escritas.push({ tabela, patch, filtros: filtrosDaEscrita });
        return cadeia;
      };
      cadeia.insert = (linha: Record<string, unknown>) => {
        inseridas.push({ tabela, linha });
        return cadeia;
      };
      // Função = resposta que muda a cada chamada (a corrida com a ponte
      // precisa de duas respostas diferentes para a mesma tabela).
      const resposta = (): Resposta | undefined => {
        const r = respostas[tabela];
        return typeof r === "function" ? r() : r;
      };
      cadeia.single = async () => resposta() ?? { data: null, error: null };
      cadeia.maybeSingle = async () => resposta() ?? { data: null, error: null };
      cadeia.then = (ok: (r: unknown) => unknown) => ok(resposta() ?? { data: [], error: null });
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
  selecionadas = [];
  filtrosLidos = [];
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

describe("a ponte de eventos grava a ligação antes da rota — e a rota completa em vez de recusar", () => {
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

  beforeEach(() => {
    respostas["channel_sessions"] = SESSAO_PAREADA;
    respostas["contacts"] = {
      data: { id: CONTATO, phone_number: "5511900000000", name: "Fulano", is_blocked: false, is_anonymized: false },
      error: null,
    };
  });

  it("chave duplicada vira reconciliação: 201 com a linha da ponte, sentido e dono corrigidos, status intacto", async () => {
    // Medido na VPS em 2026-09-15: o `call-status` chega ao worker e vira linha
    // ~200 ms antes deste INSERT, e a rota devolvia 502 com o telefone do outro
    // lado tocando. A linha da ponte é a mesma ligação — escrita por quem não
    // sabe que foi alguém daqui que discou, para este contato.
    let vez = 0;
    respostas["voice_calls"] = () =>
      vez++ === 0
        ? {
            data: null,
            error: {
              code: "23505",
              message:
                'duplicate key value violates unique constraint "voice_calls_organization_id_wacalls_call_id_key"',
            },
          }
        : {
            data: {
              id: CHAMADA,
              status: "ringing",
              owner_user_id: EU,
              created_by: EU,
              direction: "outbound",
              contact_id: CONTATO,
            },
            error: null,
          };

    const res = await discar();
    expect(res.status).toBe(201);
    expect((await corpo(res)).data).toMatchObject({
      id: CHAMADA,
      callId: "up-1",
      status: "ringing",
      owner_user_id: EU,
      direction: "outbound",
    });
    const escrita = escritas.find((e) => e.tabela === "voice_calls");
    // A reconciliação toca UMA linha: a desta ligação, desta organização.
    expect(escrita?.filtros).toEqual([
      ["organization_id", ORG],
      ["wacalls_call_id", "up-1"],
    ]);
    const patch = escrita?.patch as Record<string, unknown>;
    expect(patch).toMatchObject({
      direction: "outbound",
      created_by: EU,
      owner_user_id: EU,
      contact_id: CONTATO,
    });
    // O status da ponte é mais novo que o "starting" daqui: não se regride.
    expect(patch).not.toHaveProperty("status");
    // A resposta é o que a rota SELECIONA, e o dublê devolve a fixture seja qual
    // for a lista: sem medir a lista, trocá-la por "id, status" ficava verde e o
    // painel de quem discou voltava a sumir.
    const doPainel = selecionadas.filter((x) => x.tabela === "voice_calls").map((x) => x.colunas);
    expect(doPainel.length).toBeGreaterThan(0);
    for (const colunas of doPainel) {
      for (const c of ["id", "status", "direction", "owner_user_id", "created_by", "contact_id"]) {
        expect(colunas.split(",").map((x) => x.trim()), `faltou ${c} em "${colunas}"`).toContain(c);
      }
    }
  });

  it("o número discado é o que o WhatsApp registrou, não o do cadastro", async () => {
    // Medido na VPS em 2026-09-15: cadastro +5531998966398, WhatsApp
    // 553198966398. Discar o do cadastro mandava a oferta para lugar nenhum.
    numeroDiscavel.resolver.mockResolvedValueOnce({ digitos: "553198966398", fonte: "whatsapp" });
    respostas["contacts"] = {
      data: { id: CONTATO, phone_number: "+5531998966398", name: "Fulano", is_blocked: false, is_anonymized: false },
      error: null,
    };
    respostas["voice_calls"] = { data: { id: CHAMADA, status: "starting" }, error: null };

    const res = await discar();
    expect(res.status).toBe(201);
    expect(numeroDiscavel.resolver).toHaveBeenCalledWith(expect.anything(), ORG, "+5531998966398");
    expect(wacalls.startCall).toHaveBeenCalledWith("sessao-up", EU, "553198966398");
    // O registro guarda o telefone do cadastro, com o nono — é como o CRM lê.
    expect(inseridas.find((i) => i.tabela === "voice_calls")?.linha.peer_phone).toBe("+5531998966398");
  });

  it("controle: outro erro de escrita continua sendo erro", async () => {
    respostas["voice_calls"] = { data: null, error: { message: "conexão caiu" } };
    const res = await discar();
    expect(res.status).toBe(502);
    expect(escritas.filter((e) => e.tabela === "voice_calls")).toEqual([]);
  });
});

describe("o número pareado cujo socket com o WhatsApp caiu", () => {
  /**
   * O corpo EXATO do log da VPS em 2026-09-15 11:10:20 UTC. Naquele dia a
   * causa era o cliente morto deixado pelo `/pair` (consertado na rota de
   * pareamento); o texto é o mesmo que o whatsmeow devolve para qualquer
   * cliente sem socket, e é essa classe que a rota trata como passageira. Ver
   * o cabeçalho de `wacallsSemConexao` em `lib/wacalls/client.ts`.
   */
  const SOCKET_CAIDO = new Error(
    'wacalls_500: {"error":"usync devices: failed to send usync query: websocket not connected"}\n',
  );
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

  beforeEach(() => {
    respostas["channel_sessions"] = SESSAO_PAREADA;
    respostas["contacts"] = {
      data: { id: CONTATO, phone_number: "5511900000000", name: "Fulano", is_blocked: false, is_anonymized: false },
      error: null,
    };
  });

  it("responde 503 com Retry-After, o código próprio e a orientação — não o 502 genérico", async () => {
    wacalls.startCall.mockRejectedValueOnce(SOCKET_CAIDO);

    const res = await discar();
    expect(res.status).toBe(503);
    // `Retry-After` é o que faz `lib/api/client.ts` repetir o POST sozinho: a
    // pessoa clica uma vez, e a janela de reconexão do whatsmeow é absorvida.
    expect(res.headers.get("Retry-After")).toBe("3");
    const erro = (await corpo(res)).error as { code: string; message: string };
    expect(erro.code).toBe("wacalls_not_connected");
    expect(erro.message).toContain("sem conexão com o WhatsApp");
    expect(erro.message).not.toBe("Não foi possível completar a chamada. Tente novamente em instantes.");
    // Nada foi discado, então repetir é seguro — é o que torna o 503 honesto.
    expect(inseridas.filter((i) => i.tabela === "voice_calls")).toEqual([]);
  });

  it("controle: outra recusa do upstream continua 502 sem Retry-After", async () => {
    wacalls.startCall.mockRejectedValueOnce(new Error("wacalls_429: max concurrent calls"));

    const res = await discar();
    expect(res.status).toBe(502);
    expect(res.headers.get("Retry-After")).toBeNull();
    expect((await corpo(res)).error).toMatchObject({ code: "wacalls_error" });
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

  it("ligação que JÁ acabou: 204 sem pedir ao serviço de voz e sem gravar encerramento falso", async () => {
    // Produção, 2026-09-15: o celular desligou, o painel ficou preso, e o clique
    // 66 s depois gravou dois `voice.call_ended` atribuindo ao atendente o fim
    // de uma ligação que o cliente tinha encerrado.
    const { audit } = await import("@/lib/audit");
    respostas["voice_calls"] = chamadaNoBanco({ owner_user_id: EU, status: "ended" });
    const res = await desligar();
    expect(res.status).toBe(204);
    expect(wacalls.endCall).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
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

  it("a troca de SDP grava a aba no audit — a pergunta 'quantas abas abriram áudio?' tem resposta", async () => {
    const { audit } = await import("@/lib/audit");
    respostas["voice_calls"] = chamadaNoBanco({ owner_user_id: EU });
    const { POST } = await import("@/app/api/v1/voice/calls/[id]/webrtc/route");
    const aba = "66666666-6666-4666-8666-666666666666";
    const res = await POST(
      new Request("http://x", { method: "POST", body: JSON.stringify({ sdpOffer: "v=0", aba }) }),
      { params: Promise.resolve({ id: CHAMADA }) },
    );
    expect(res.status).toBe(200);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "voice.call_media_attached", metadata: expect.objectContaining({ aba }) }),
    );
  });

  it("aba que não é uuid é recusada antes de falar com o serviço de voz", async () => {
    respostas["voice_calls"] = chamadaNoBanco({ owner_user_id: EU });
    const { POST } = await import("@/app/api/v1/voice/calls/[id]/webrtc/route");
    const res = await POST(
      new Request("http://x", { method: "POST", body: JSON.stringify({ sdpOffer: "v=0", aba: "<script>" }) }),
      { params: Promise.resolve({ id: CHAMADA }) },
    );
    expect(res.status).toBe(400);
    expect(wacalls.exchangeWebrtc).not.toHaveBeenCalled();
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

  it("com ?id=, filtra pela ligação — é assim que o painel confere UMA ligação", async () => {
    respostas["voice_calls"] = { data: [{ id: CHAMADA }], error: null };
    const { GET } = await import("@/app/api/v1/voice/calls/history/route");
    const res = await GET(new Request(`http://x/api/v1/voice/calls/history?id=${CHAMADA}&limit=1`));
    expect(res.status).toBe(200);
    expect(filtrosLidos).toEqual(
      expect.arrayContaining([
        { tabela: "voice_calls", coluna: "organization_id", valor: ORG },
        { tabela: "voice_calls", coluna: "id", valor: CHAMADA },
      ]),
    );
  });

  it("?id= que não é uuid é 400, sem consultar", async () => {
    const { GET } = await import("@/app/api/v1/voice/calls/history/route");
    const res = await GET(new Request("http://x/api/v1/voice/calls/history?id=1%20or%201=1"));
    expect(res.status).toBe(400);
    expect(filtrosLidos).toEqual([]);
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
