/**
 * GET /api/v1/webchat/eventos — o visitante recebe as respostas da conversa por stream
 * (spec 36, F1, Task 9).
 *
 * A entrega é pelo estado da mensagem, sem cursor: sai o que está `sent`, e vira `delivered`
 * logo depois de escrito. O banco é um dublê que aplica os filtros que a rota pede (eq, in,
 * is, order, limit, maybeSingle e update), como o cliente real. O relógio é falso: os 60 s do stream passam em
 * milissegundos. A nota interna não aparece aqui de propósito: ela mora em `conversation_notes`,
 * fora de `messages`, e a consulta de eventos nem a enxerga.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "@/app/api/v1/webchat/eventos/route";
import { assinarTokenDeVisitante } from "@/lib/channels/webchat/token";

type Linha = Record<string, unknown>;

const h = vi.hoisted(() => ({
  tabelas: {} as Record<string, Linha[]>,
  banco: null as unknown,
  moduloLigado: true,
  contador: new Map<string, number>(),
  leiturasDeMensagens: 0,
  filtros: [] as Array<{ tabela: string; coluna: string; valor: unknown }>,
  logErro: vi.fn(),
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    error: (...args: unknown[]) => h.logErro(...args),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));
vi.mock("@/lib/env", () => ({ env: { NEXT_PUBLIC_APP_URL: "https://crm.example.com" } }));
vi.mock("@/lib/webhooks/url-publica", () => ({ enderecoDaPropriaMaquina: () => false }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => h.banco }));
vi.mock("@/lib/channels/webchat/modulo", () => ({ chatNoSiteLigado: async () => h.moduloLigado }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({
  checkRateLimit: async (bucket: string, limit: number, windowSec: number) => {
    const count = (h.contador.get(bucket) ?? 0) + 1;
    h.contador.set(bucket, count);
    return { allowed: count <= limit, count, limit, window_sec: windowSec };
  },
}));

const SEGREDO = "segredo-de-teste-do-eventos-do-chat-no-site";
const AGORA = new Date("2026-11-20T12:00:00.000Z");
const ORG = "22222222-2222-4222-8222-222222222222";
const ORG_B = "66666666-6666-4666-8666-666666666666";
const CS = "11111111-1111-4111-8111-111111111111";
const OUTRA_CS = "33333333-3333-4333-8333-333333333333";
const VIS = "44444444-4444-4444-8444-444444444444";
const OUTRA_VIS = "88888888-8888-4888-8888-888888888888";
const CONV = "55555555-5555-4555-8555-555555555555";
const CONV_2 = "77777777-7777-4777-8777-777777777777";
const CONV_3 = "99999999-9999-4999-8999-999999999999";
const CHAVE = `wck_${"A".repeat(43)}`;

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

class Consulta {
  private filtrosDaConsulta: Array<(l: Linha) => boolean> = [];
  private ordem: Array<{ coluna: string; asc: boolean }> = [];
  private teto: number | null = null;
  private valores: Linha | null = null;

  constructor(private readonly tabela: string) {}

  select(): Consulta {
    return this;
  }
  update(valores: Linha): Consulta {
    this.valores = valores;
    return this;
  }
  eq(coluna: string, valor: unknown): Consulta {
    h.filtros.push({ tabela: this.tabela, coluna, valor });
    this.filtrosDaConsulta.push((l) => l[coluna] === valor);
    return this;
  }
  in(coluna: string, valores: unknown[]): Consulta {
    this.filtrosDaConsulta.push((l) => valores.includes(l[coluna]));
    return this;
  }
  is(coluna: string, valor: null): Consulta {
    this.filtrosDaConsulta.push((l) => (l[coluna] ?? null) === valor);
    return this;
  }
  order(coluna: string, opcoes?: { ascending?: boolean }): Consulta {
    this.ordem.push({ coluna, asc: opcoes?.ascending !== false });
    return this;
  }
  limit(n: number): Consulta {
    this.teto = n;
    return this;
  }
  /** Como o cliente real: a primeira linha casada, ou `null` quando não há nenhuma. */
  async maybeSingle(): Promise<{ data: unknown; error: null }> {
    const { data } = await this.executar();
    const linhas = data as Linha[];
    return { data: linhas[0] ?? null, error: null };
  }
  then<A = { data: unknown; error: null }, B = never>(
    ok?: ((valor: { data: unknown; error: null }) => A | PromiseLike<A>) | null,
    erro?: ((motivo: unknown) => B | PromiseLike<B>) | null,
  ): Promise<A | B> {
    return this.executar().then(ok, erro);
  }

  private casadas(): Linha[] {
    return (h.tabelas[this.tabela] ?? []).filter((l) => this.filtrosDaConsulta.every((f) => f(l)));
  }

  private async executar(): Promise<{ data: unknown; error: null }> {
    const linhas = this.casadas();
    if (this.valores) {
      for (const l of linhas) Object.assign(l, this.valores);
      return { data: null, error: null };
    }
    if (this.tabela === "messages") h.leiturasDeMensagens += 1;
    const ordenadas = [...linhas].sort((a, b) => {
      for (const { coluna, asc } of this.ordem) {
        const x = String(a[coluna]);
        const y = String(b[coluna]);
        if (x !== y) return (x < y ? -1 : 1) * (asc ? 1 : -1);
      }
      return 0;
    });
    const cortadas = this.teto === null ? ordenadas : ordenadas.slice(0, this.teto);
    return { data: cortadas.map((l) => ({ ...l })), error: null };
  }
}

h.banco = {
  from(tabela: string) {
    return new Consulta(tabela);
  },
};

function mensagensIniciais(): Linha[] {
  const base = (n: number, extra: Linha = {}): Linha => ({
    id: id(n),
    organization_id: ORG,
    conversation_id: CONV,
    direction: "outbound",
    type: "text",
    status: "sent",
    body: `mensagem ${n}`,
    created_at: `2026-11-20T12:00:0${n}.000+00:00`,
    ...extra,
  });
  return [
    base(1, { status: "sending", body: "Olá, em que posso ajudar?" }),
    base(2, { body: "Temos três planos." }),
    base(3, { direction: "inbound", status: "delivered", body: "oi" }),
    base(4, { type: "system", body: "Conversa encerrada pelo sistema" }),
    base(5, { status: "failed", body: "não chegou" }),
    base(6, { status: "queued", body: "na fila" }),
    base(7, { organization_id: ORG_B, body: "de outra organização" }),
    base(8, { conversation_id: CONV_2, body: "de outra conversa" }),
    base(9, { conversation_id: CONV_3, body: "da conversa mais antiga" }),
  ];
}

const CONVERSA_DO_VISITANTE = {
  id: CONV,
  organization_id: ORG,
  channel: "webchat",
  channel_session_id: CS,
  provider_conversation_id: VIS,
  created_at: "2026-11-20T12:00:00.000+00:00",
};

function preparar(
  opcao: "ok" | "inexistente" | "modulo_desligado" | "pausado" = "ok",
  conversas: Linha[] = [
    CONVERSA_DO_VISITANTE,
    {
      id: CONV_2,
      organization_id: ORG,
      channel: "webchat",
      channel_session_id: CS,
      provider_conversation_id: OUTRA_VIS,
      created_at: "2026-11-20T12:00:00.000+00:00",
    },
  ],
): void {
  h.tabelas = {
    channel_sessions:
      opcao === "inexistente"
        ? []
        : [
            {
              id: CS,
              organization_id: ORG,
              provider: "webchat",
              webchat_public_key: CHAVE,
              archived_at: null,
              metadata: opcao === "pausado" ? { webchat: { pausado: true } } : {},
            },
          ],
    organizations: [{ id: ORG, status: "active" }],
    conversations: conversas,
    messages: mensagensIniciais(),
  };
  h.moduloLigado = opcao !== "modulo_desligado";
}

function tokenDeVisitante(cs = CS, vis = VIS): string {
  return assinarTokenDeVisitante({ channelSessionId: cs, visitanteId: vis, agora: AGORA });
}

function abrir(token: string | undefined, extra = ""): Request {
  return new Request(`https://crm.example.com/api/v1/webchat/eventos${extra}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

/** Espera o stream fechar: o relógio falso avança 61 s, e a rota fecha em 60. */
async function lerAteFechar(res: Response): Promise<string> {
  const texto = res.text();
  await vi.advanceTimersByTimeAsync(61_000);
  return texto;
}

interface EventoLido {
  evento: string;
  dados: Record<string, unknown>;
}

function eventos(texto: string): EventoLido[] {
  return texto
    .split("\n\n")
    .filter((bloco) => bloco.startsWith("event: "))
    .map((bloco) => {
      const [linhaEvento, linhaDados] = bloco.split("\n");
      expect(linhaEvento).toBeDefined();
      expect(linhaDados).toBeDefined();
      return {
        evento: linhaEvento!.slice("event: ".length),
        dados: JSON.parse(linhaDados!.slice("data: ".length)) as Record<string, unknown>,
      };
    });
}

/** Ids das mensagens que saíram num stream, na ordem em que saíram. */
async function entregasDe(token: string): Promise<unknown[]> {
  const texto = await lerAteFechar(await GET(abrir(token)));
  return eventos(texto)
    .filter((e) => e.evento === "mensagem")
    .map((e) => e.dados.id);
}

function linha(n: number): Linha {
  return (h.tabelas.messages ?? []).find((l) => l.id === id(n)) as Linha;
}

function estado(n: number): unknown {
  return linha(n).status;
}

beforeEach(() => {
  process.env.INTERNAL_SECRET = SEGREDO;
  vi.useFakeTimers();
  vi.setSystemTime(AGORA);
  h.contador.clear();
  h.leiturasDeMensagens = 0;
  h.filtros = [];
  h.logErro.mockClear();
  preparar();
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.INTERNAL_SECRET;
});

describe("GET /api/v1/webchat/eventos", () => {
  it("entrega só a saída de texto `sent` desta conversa, sem entrada, sistema, falha, fila nem envio em curso", async () => {
    const res = await GET(abrir(tokenDeVisitante()));
    expect(res.status).toBe(200);

    const lidos = eventos(await lerAteFechar(res)).filter((e) => e.evento === "mensagem");
    expect(lidos.map((e) => e.dados.id)).toEqual([id(2)]);
    expect(lidos[0]).toBeDefined();
    expect(lidos[0]!.dados.texto).toBe("Temos três planos.");
    expect(lidos[0]!.dados.em).toBe("2026-11-20T12:00:02.000+00:00");
  });

  it("marca como entregue só o que saiu, e não toca no que ficou de fora", async () => {
    await lerAteFechar(await GET(abrir(tokenDeVisitante())));

    expect(estado(2)).toBe("delivered");
    expect(estado(1)).toBe("sending");
    expect(estado(4)).toBe("sent");
    expect(estado(5)).toBe("failed");
    expect(estado(6)).toBe("queued");
    expect(estado(7)).toBe("sent");
    expect(estado(3)).toBe("delivered");
  });

  it("(a) mensagem que vira `sent` depois de outra mais nova ainda é entregue na leitura seguinte", async () => {
    const token = tokenDeVisitante();
    expect(await entregasDe(token)).toEqual([id(2)]);

    // A mensagem 1 é mais antiga que a 2, e só vira `sent` agora, depois do envio da 2.
    linha(1).status = "sent";

    expect(await entregasDe(token)).toEqual([id(1)]);
    expect(estado(1)).toBe("delivered");
  });

  it("(b) `sending` e `queued` não saem e não são marcados: ficam com o worker de envio", async () => {
    const ids = await entregasDe(tokenDeVisitante());

    expect(ids).not.toContain(id(1));
    expect(ids).not.toContain(id(6));
    expect(estado(1)).toBe("sending");
    expect(estado(6)).toBe("queued");
  });

  it("(c) `delivered` não é entregue de novo", async () => {
    const token = tokenDeVisitante();
    expect(await entregasDe(token)).toEqual([id(2)]);
    expect(await entregasDe(token)).toEqual([]);
  });

  it("com duas conversas do mesmo visitante, usa a MAIS RECENTE e não quebra", async () => {
    // CONV_3 é de 11:00 e CONV (a de `CONVERSA_DO_VISITANTE`) é de 12:00: a mais recente é CONV.
    preparar("ok", [
      { ...CONVERSA_DO_VISITANTE, id: CONV_3, created_at: "2026-11-20T11:00:00.000+00:00" },
      CONVERSA_DO_VISITANTE,
    ]);

    const res = await GET(abrir(tokenDeVisitante()));
    expect(res.status).toBe(200);
    const ids = eventos(await lerAteFechar(res)).map((e) => e.dados.id);
    // Sai a saída `sent` da conversa mais recente (id 2), e não a da mais antiga (id 9).
    expect(ids).toEqual([id(2)]);
    expect(ids).not.toContain(id(9));
  });

  it("a conversa sai do token, e nem a organização nem a conversa vindas da URL entram", async () => {
    const res = await GET(
      abrir(tokenDeVisitante(), `?organization_id=${ORG_B}&conversation_id=${CONV_2}`),
    );
    await lerAteFechar(res);

    expect(h.filtros).toEqual(
      expect.arrayContaining([
        { tabela: "conversations", coluna: "organization_id", valor: ORG },
        { tabela: "conversations", coluna: "channel", valor: "webchat" },
        { tabela: "conversations", coluna: "channel_session_id", valor: CS },
        { tabela: "conversations", coluna: "provider_conversation_id", valor: VIS },
        { tabela: "messages", coluna: "organization_id", valor: ORG },
        { tabela: "messages", coluna: "conversation_id", valor: CONV },
        { tabela: "messages", coluna: "status", valor: "sent" },
      ]),
    );
    expect(h.filtros.some((f) => f.valor === ORG_B || f.valor === CONV_2)).toBe(false);
  });

  it("sem conversa ainda, o stream abre e fica vazio", async () => {
    preparar("ok", []);
    const res = await GET(abrir(tokenDeVisitante()));
    expect(res.status).toBe(200);

    const texto = await lerAteFechar(res);
    expect(eventos(texto)).toEqual([]);
    expect(h.leiturasDeMensagens).toBe(0);
  });

  it("responde text/event-stream sem buffer de proxy, e fecha em 60 s, com cerca de 30 leituras", async () => {
    const res = await GET(abrir(tokenDeVisitante()));
    expect(res.headers.get("content-type")).toMatch(/^text\/event-stream/);
    expect(res.headers.get("x-accel-buffering")).toBe("no");

    await lerAteFechar(res);
    expect(h.leiturasDeMensagens).toBeGreaterThanOrEqual(25);
    expect(h.leiturasDeMensagens).toBeLessThanOrEqual(31);
  });

  it("desconexão normal do cliente não registra erro", async () => {
    const res = await GET(abrir(tokenDeVisitante()));
    await res.body?.cancel();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(h.logErro).not.toHaveBeenCalled();
  });

  it("a 7ª abertura em um minuto, do mesmo visitante, dá 429 com Retry-After", async () => {
    const token = tokenDeVisitante();
    for (let i = 0; i < 6; i++) {
      const r = await GET(abrir(token));
      expect(r.status).toBe(200);
      await r.body?.cancel();
    }
    const recusada = await GET(abrir(token));
    expect(recusada.status).toBe(429);
    expect(recusada.headers.get("Retry-After")).toBe("60");
  });

  it("sem token, ou com token inválido, dá 401", async () => {
    expect((await GET(abrir(undefined))).status).toBe(401);
    expect((await GET(abrir("abc.def"))).status).toBe(401);
  });

  it("sem segredo no servidor, dá 500 e registra sem detalhe", async () => {
    const token = tokenDeVisitante();
    delete process.env.INTERNAL_SECRET;

    const r = await GET(abrir(token));
    expect(r.status).toBe(500);
    expect(h.logErro).toHaveBeenCalled();
  });

  it("conexão inexistente, módulo desligado ou token de outra conexão: o mesmo 404", async () => {
    preparar("inexistente");
    expect((await GET(abrir(tokenDeVisitante()))).status).toBe(404);

    preparar("modulo_desligado");
    expect((await GET(abrir(tokenDeVisitante()))).status).toBe(404);

    preparar("ok");
    expect((await GET(abrir(tokenDeVisitante(OUTRA_CS)))).status).toBe(404);
  });

  it("chat pausado dá o mesmo 404 e o mesmo corpo de conexão inexistente, mesmo com o token válido", async () => {
    preparar("inexistente");
    const inexistente = await (await GET(abrir(tokenDeVisitante()))).json();

    preparar("pausado");
    const res = await GET(abrir(tokenDeVisitante()));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(inexistente);
  });
});
