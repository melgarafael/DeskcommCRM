/**
 * O PAREAMENTO NÃO PASSA PELO `/pair` DO UPSTREAM — e este arquivo é a cerca.
 *
 * `POST /api/sessions` do WaCalls já inicia o pareamento por dentro. O
 * `/pair` re-pareia trocando o cliente whatsmeow SEM refazer o subsistema de
 * chamadas, que fica preso ao cliente antigo, desconectado: medido na VPS em
 * 2026-09-15, a rota chamava `createSession` e `pairSession` em sequência e
 * toda ligação morria em "websocket not connected" até reiniciar o processo.
 * O racional inteiro está em `lib/wacalls/client.ts` (`wacallsSemConexao`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createSession: vi.fn(),
  deleteSession: vi.fn(),
  listSessions: vi.fn(),
  erroNaEscrita: null as { message: string } | null,
  audit: vi.fn(),
  guarda: vi.fn(),
  canal: null as {
    id: string;
    wacalls_session_id: string | null;
    wacalls_paired_at?: string | null;
  } | null,
  inseridas: [] as Record<string, unknown>[],
  atualizadas: [] as Record<string, unknown>[],
}));
const ORG = "11111111-1111-4111-8111-111111111111";
vi.mock("@/lib/auth/require-role", () => ({
  requireRole: async () => ({ ok: true, user: { id: "admin" }, org: { orgId: ORG } }),
}));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("@/lib/voice/guarda", () => ({ exigirVozLigada: mocks.guarda }));
vi.mock("@/lib/audit", () => ({ audit: mocks.audit }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn() } }));
vi.mock("@/lib/env", () => ({
  env: {
    WACALLS_API_BASE_URL: "http://voz.invalid",
    WACALLS_API_TOKEN: "credencial-sintetica",
  },
}));
vi.mock("@/lib/wacalls/client", () => ({
  getWacallsClient: () => mocks,
  wacallsFriendlyError: () => "Falha no serviço de voz.",
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: () => {
      const query = {
        select: () => query,
        eq: () => query,
        is: () => query,
        maybeSingle: async () => ({ data: mocks.canal, error: null }),
        insert: (linha: Record<string, unknown>) => {
          mocks.inseridas.push(linha);
          mocks.canal = { id: "canal", wacalls_session_id: String(linha.wacalls_session_id) };
          return query;
        },
        update: (patch: Record<string, unknown>) => {
          mocks.atualizadas.push(patch);
          return query;
        },
        single: async () => ({ data: mocks.canal, error: null }),
        // `await supabase.from(...).update(...).eq(...).eq(...)` — o fim da
        // cadeia é awaitado direto.
        then: (ok: (r: unknown) => unknown) => ok({ data: null, error: mocks.erroNaEscrita }),
      };
      return query;
    },
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.canal = null;
  mocks.inseridas = [];
  mocks.atualizadas = [];
  mocks.guarda.mockResolvedValue(null);
  mocks.createSession.mockResolvedValue({ id: "sessao-voz" });
  mocks.deleteSession.mockResolvedValue(undefined);
  mocks.listSessions.mockResolvedValue([]);
  mocks.erroNaEscrita = null;
});

const NOME = `org_${ORG}`;
function noWacalls(id: string, over: Partial<{ name: string; jid: string; paired: boolean; state: string }> = {}) {
  return { id, name: NOME, jid: "", state: "qr", paired: false, ...over };
}
afterEach(() => vi.unstubAllGlobals());

function pedido(body: unknown) {
  return new Request("http://crm.invalid/api/v1/voice/sessions/pair", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}
async function parear(body: unknown) {
  const { POST } = await import("@/app/api/v1/voice/sessions/pair/route");
  return (POST as (request: Request) => Promise<Response>)(pedido(body));
}
async function corpo(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

describe("o pareamento cria a sessão uma vez e nunca re-pareia", () => {
  it("primeiro pareamento: um POST, uma sessão, nenhum /pair", async () => {
    const res = await parear({});
    expect(res.status).toBe(200);
    expect((await corpo(res)).data).toEqual({ channelSessionId: "canal", wacallsSessionId: "sessao-voz" });
    // O nome é o vínculo que o relay usa para reconhecer a sessão antes do id
    // chegar ao banco (`lib/wacalls/nome-da-sessao.ts`).
    // O uuid inteiro: 8 caracteres colidem entre tenants e entregariam o QR
    // de um ao outro pelo relay.
    expect(mocks.createSession).toHaveBeenCalledExactlyOnceWith(NOME);
    expect(mocks.deleteSession).not.toHaveBeenCalled();
    expect(mocks.inseridas).toHaveLength(1);
    expect(mocks.inseridas[0]).toMatchObject({
      organization_id: ORG,
      provider: "wacalls",
      wacalls_session_id: "sessao-voz",
      status: "STARTING",
    });
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "voice.session_pair_started",
        metadata: { wacalls_session_id: "sessao-voz", descartadas: [] },
      }),
    );
  });

  it("sessão anterior que nunca pareou é apagada ANTES de criar a nova — nunca re-pareada", async () => {
    mocks.canal = { id: "canal", wacalls_session_id: "velha", wacalls_paired_at: null };
    // Nome legado (8 caracteres): a sessão velha é reconhecida pelo id do banco.
    mocks.listSessions.mockResolvedValue([noWacalls("velha", { name: "org_11111111" })]);
    const res = await parear({});
    expect(res.status).toBe(200);
    expect(mocks.deleteSession).toHaveBeenCalledExactlyOnceWith("velha");
    expect(mocks.createSession).toHaveBeenCalledTimes(1);
    const ordemApagar = mocks.deleteSession.mock.invocationCallOrder[0]!;
    const ordemCriar = mocks.createSession.mock.invocationCallOrder[0]!;
    expect(ordemApagar).toBeLessThan(ordemCriar);
    // A linha existente é reapontada para a sessão nova, não duplicada.
    expect(mocks.inseridas).toEqual([]);
    expect(mocks.atualizadas).toEqual([{ wacalls_session_id: "sessao-voz", status: "STARTING" }]);
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { wacalls_session_id: "sessao-voz", descartadas: ["velha"] } }),
    );
  });

  it("sessão que o WaCalls já descartou ao subir (404) não impede o pareamento", async () => {
    // `Manager.Restore` apaga toda sessão sem JID no boot: depois de um restart
    // o id do banco aponta para o nada, e isso é o caso NORMAL, não erro.
    mocks.canal = { id: "canal", wacalls_session_id: "velha", wacalls_paired_at: null };
    // Listada e já apagada entre a leitura e o DELETE: o 404 é o desfecho normal.
    mocks.listSessions.mockResolvedValue([noWacalls("velha")]);
    mocks.deleteSession.mockRejectedValueOnce(new Error("wacalls_404: no session velha"));
    const res = await parear({});
    expect(res.status).toBe(200);
    expect(mocks.createSession).toHaveBeenCalledTimes(1);
    expect(mocks.atualizadas).toEqual([{ wacalls_session_id: "sessao-voz", status: "STARTING" }]);
  });

  it("outro erro ao apagar a anterior interrompe — não cria uma segunda por cima", async () => {
    mocks.canal = { id: "canal", wacalls_session_id: "velha", wacalls_paired_at: null };
    mocks.listSessions.mockResolvedValue([noWacalls("velha")]);
    mocks.deleteSession.mockRejectedValueOnce(new Error("wacalls_500: boom"));
    const res = await parear({});
    expect(res.status).toBe(502);
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.atualizadas).toEqual([]);
  });

  it("número já pareado não é re-pareado por aqui: 409, e nada vai ao upstream", async () => {
    mocks.canal = {
      id: "canal",
      wacalls_session_id: "viva",
      wacalls_paired_at: "2026-09-15T11:09:20.000Z",
    };
    const res = await parear({});
    expect(res.status).toBe(409);
    expect((await corpo(res)).error).toMatchObject({ code: "voice_already_paired" });
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.deleteSession).not.toHaveBeenCalled();
  });

  it("parear continua exigindo que a organização tenha ligado a voz", async () => {
    mocks.guarda.mockResolvedValue(new Response(null, { status: 422 }));
    expect((await parear({})).status).toBe(422);
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it("aba antiga que ainda manda prepare_only cai no fluxo normal", async () => {
    // O campo foi embora com o passo que ele servia; a chave é descartada e o
    // POST vira o pareamento de sempre. A resposta carrega a sessão criada —
    // na versão anterior, `prepare_only` só registrava e deixava o pareamento
    // para um segundo POST.
    const res = await parear({ prepare_only: true });
    expect(res.status).toBe(200);
    expect(mocks.createSession).toHaveBeenCalledTimes(1);
    expect((await corpo(res)).data).toMatchObject({ wacallsSessionId: "sessao-voz" });
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "voice.session_pair_started" }));
  });

  it("linha do canal sem sessão no WaCalls é reapontada, não duplicada", async () => {
    mocks.canal = { id: "canal", wacalls_session_id: null, wacalls_paired_at: null };
    expect((await parear({})).status).toBe(200);
    expect(mocks.deleteSession).not.toHaveBeenCalled();
    expect(mocks.inseridas).toEqual([]);
    expect(mocks.atualizadas).toEqual([{ wacalls_session_id: "sessao-voz", status: "STARTING" }]);
  });
});

describe("o banco pode estar atrasado — o WaCalls é perguntado antes de apagar", () => {
  it("banco diz 'não pareada', WaCalls diz 'pareada': nada é apagado, o banco é corrigido, 409", async () => {
    // Worker reiniciando ou atrasado: a tela ofereceu "Parear" para um aparelho
    // que a pessoa acabou de vincular. Apagar a sessão ali DESLOGA o aparelho
    // (`Manager.Delete` chama `Logout` quando há JID).
    mocks.canal = { id: "canal", wacalls_session_id: "viva", wacalls_paired_at: null };
    mocks.listSessions.mockResolvedValue([
      noWacalls("viva", { jid: "551148633324:12@s.whatsapp.net", state: "open", paired: true }),
    ]);

    const res = await parear({});

    expect(res.status).toBe(409);
    expect((await corpo(res)).error).toMatchObject({ code: "voice_already_paired" });
    expect(mocks.deleteSession, "apagou — e deslogou — um aparelho vinculado").not.toHaveBeenCalled();
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.atualizadas).toEqual([
      expect.objectContaining({
        wacalls_session_id: "viva",
        wacalls_jid: "551148633324:12@s.whatsapp.net",
        status: "WORKING",
        wacalls_paired_at: expect.any(String),
      }),
    ]);
  });

  it("sessão pareada com o nome desta organização que o banco não conhece é adotada, não apagada", async () => {
    mocks.canal = null;
    mocks.listSessions.mockResolvedValue([noWacalls("orfa", { jid: "5511:3@s.whatsapp.net", paired: true })]);
    const res = await parear({});
    expect(res.status).toBe(409);
    expect(mocks.deleteSession).not.toHaveBeenCalled();
    expect(mocks.inseridas).toEqual([
      expect.objectContaining({ organization_id: ORG, provider: "wacalls", wacalls_session_id: "orfa" }),
    ]);
  });

  it("órfã NÃO pareada com o nome desta organização é apagada antes de criar — o relay não repassa QR dela", async () => {
    mocks.listSessions.mockResolvedValue([
      noWacalls("orfa"),
      // Nome de OUTRA organização, mesmo prefixo de 8 caracteres: intocável.
      noWacalls("alheia", { name: "org_11111111-9999-4999-8999-999999999999" }),
    ]);
    expect((await parear({})).status).toBe(200);
    expect(mocks.deleteSession).toHaveBeenCalledExactlyOnceWith("orfa");
    expect(mocks.createSession).toHaveBeenCalledTimes(1);
  });

  it("sem conseguir ler o WaCalls, nada é apagado nem criado", async () => {
    mocks.canal = { id: "canal", wacalls_session_id: "velha", wacalls_paired_at: null };
    mocks.listSessions.mockRejectedValue(new Error("wacalls_500: boom"));
    expect((await parear({})).status).toBe(502);
    expect(mocks.deleteSession).not.toHaveBeenCalled();
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it("registro no banco que falha desfaz a sessão recém-criada", async () => {
    mocks.canal = { id: "canal", wacalls_session_id: null, wacalls_paired_at: null };
    mocks.erroNaEscrita = { message: "conexão caiu" };
    expect((await parear({})).status).toBe(502);
    expect(mocks.createSession).toHaveBeenCalledTimes(1);
    expect(mocks.deleteSession, "sessão ficou órfã no WaCalls, em laço de QR").toHaveBeenCalledExactlyOnceWith(
      "sessao-voz",
    );
  });

  it("corpo malformado é 400 sem criar sessão", async () => {
    expect((await parear("{")).status).toBe(400);
    expect(mocks.createSession).not.toHaveBeenCalled();
  });
});

it("o QR chega pelo relay autenticado e só para a organização dona", async () => {
  mocks.canal = { id: "canal", wacalls_session_id: "sessao-voz" };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      if (new Headers(init.headers).get("Authorization") !== "Bearer credencial-sintetica") {
        return new Response(null, { status: 401 });
      }
      const linhas = [
        { type: "auth-state", sessionId: "outra-organizacao", paired: true },
        { type: "auth-state", sessionId: "sessao-voz", qr: "qr-sintetico" },
      ]
        .map((e) => `data: ${JSON.stringify(e)}\n\n`)
        .join("");
      return new Response(linhas, { headers: { "Content-Type": "text/event-stream" } });
    }),
  );
  const { GET } = await import("@/app/api/v1/voice/events/route");
  const resposta = await GET();
  expect(resposta.status).toBe(200);
  const texto = await resposta.text();
  expect(texto).toContain('"type":"qr"');
  expect(texto).not.toContain('"type":"paired"');
  expect(texto).not.toContain("credencial-sintetica");
});

it("fecha a conexão com o serviço quando o navegador sai do pareamento", async () => {
  mocks.canal = { id: "canal", wacalls_session_id: "sessao-voz" };
  const fechar = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({ cancel: fechar }))));
  const { GET } = await import("@/app/api/v1/voice/events/route");
  const resposta = await GET();
  const reader = resposta.body!.getReader();
  await reader.read(); // comentário inicial que libera o onopen
  await reader.cancel();
  await vi.waitFor(() => expect(fechar).toHaveBeenCalledOnce());
});

it("sem sessão no banco, o relay reconhece a sessão pelo nome que o broker anuncia — e só ela", async () => {
  // Primeiro pareamento: a stream abre ANTES de a sessão existir. A versão
  // anterior respondia 404 aqui, e a tela precisava de um passo "preparar"
  // (que chamava /pair) só para o relay ter um id — ver o cabeçalho.
  mocks.canal = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      const linhas = [
        {
          type: "session-list",
          sessions: [
            // Mesmo prefixo de 8 caracteres, outra organização: o nome inteiro
            // é o que separa os dois tenants.
            { id: "sessao-alheia", name: "org_11111111-9999-4999-8999-999999999999", state: "qr", paired: false },
            { id: "sessao-nova", name: "org_11111111-1111-4111-8111-111111111111", state: "qr", paired: false },
          ],
        },
        { type: "auth-state", sessionId: "sessao-alheia", qr: "qr-alheio", paired: false },
        { type: "auth-state", sessionId: "sessao-nova", qr: "qr-nosso", paired: false },
      ]
        .map((e) => `data: ${JSON.stringify(e)}\n\n`)
        .join("");
      return new Response(linhas, { headers: { "Content-Type": "text/event-stream" } });
    }),
  );
  const { GET } = await import("@/app/api/v1/voice/events/route");
  const resposta = await GET();
  expect(resposta.status).toBe(200);
  const texto = await resposta.text();
  // Um QR só: o nosso. O da outra organização tem de morrer no filtro.
  expect(texto.match(/"type":"qr"/g)).toHaveLength(1);
});

it("nome igual não basta quando o banco já conhece o id: as duas fontes SOMAM", async () => {
  mocks.canal = { id: "canal", wacalls_session_id: "sessao-do-banco" };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      const linhas = [
        { type: "session-list", sessions: [{ id: "sessao-nova", name: "org_11111111-1111-4111-8111-111111111111" }] },
        { type: "auth-state", sessionId: "sessao-do-banco", qr: "qr-1", paired: false },
        { type: "auth-state", sessionId: "sessao-nova", qr: "qr-2", paired: false },
      ]
        .map((e) => `data: ${JSON.stringify(e)}\n\n`)
        .join("");
      return new Response(linhas, { headers: { "Content-Type": "text/event-stream" } });
    }),
  );
  const { GET } = await import("@/app/api/v1/voice/events/route");
  const texto = await (await GET()).text();
  // O re-pareamento apaga a sessão do banco e cria outra com o mesmo nome; o
  // relay aberto antes disso precisa aceitar as duas — a velha pelo id, a nova
  // pelo nome.
  expect(texto.match(/"type":"qr"/g)).toHaveLength(2);
});

it("QR vencido encerra a espera — mas só o da sessão cujo QR está na tela", async () => {
  mocks.canal = { id: "canal", wacalls_session_id: "sessao-velha" };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      const linhas = [
        // A sessão velha sendo apagada pelo re-pareamento emite logged_out ANTES
        // do QR novo: encerrar aqui esconderia o QR que vem logo atrás.
        { type: "auth-state", sessionId: "sessao-velha", state: "logged_out", paired: false },
        { type: "session-list", sessions: [{ id: "sessao-nova", name: "org_11111111-1111-4111-8111-111111111111" }] },
        { type: "auth-state", sessionId: "sessao-nova", state: "qr", qr: "qr-novo", paired: false },
        { type: "auth-state", sessionId: "sessao-nova", state: "logged_out", paired: false },
        { type: "auth-state", sessionId: "sessao-nova", state: "qr", qr: "nao-devia-chegar", paired: false },
      ]
        .map((e) => `data: ${JSON.stringify(e)}\n\n`)
        .join("");
      return new Response(linhas, { headers: { "Content-Type": "text/event-stream" } });
    }),
  );
  const { GET } = await import("@/app/api/v1/voice/events/route");
  const texto = await (await GET()).text();
  const tipos = [...texto.matchAll(/"type":"(\w+)"/g)].map((m) => m[1]);
  expect(tipos).toEqual(["qr", "expired"]);
});
