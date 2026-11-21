/**
 * GET /api/v1/webchat/eventos — o visitante recebe as respostas da conversa por stream
 * (spec 36, F1, Task 9).
 *
 * O banco é um dublê que aplica os filtros que a rota e a consulta pedem (eq, in, not, or,
 * order, limit e update), como o cliente real. O relógio é falso: os 60 s do stream passam
 * em milissegundos. A nota interna não aparece aqui de propósito: ela mora em
 * `conversation_notes`, fora de `messages`, e a consulta de eventos nem a enxerga.
 */
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "@/app/api/v1/webchat/eventos/route";
import { assinarCursor, lerCursor } from "@/lib/channels/webchat/eventos";
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
const CHAVE = `wck_${"A".repeat(43)}`;

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** Filtro `or` do cursor: `created_at.gt.T,and(created_at.eq.T,id.gt.ID)`. Só essa forma existe. */
function filtroOr(texto: string): (l: Linha) => boolean {
  const casou = /^created_at\.gt\.(.+),and\(created_at\.eq\.(.+),id\.gt\.(.+)\)$/.exec(texto);
  if (!casou) throw new Error(`filtro or inesperado: ${texto}`);
  const [, t, tIgual, idDepois] = casou;
  return (l) =>
    String(l.created_at) > t || (String(l.created_at) === tIgual && String(l.id) > idDepois);
}

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
  not(coluna: string, _operador: string, valor: string): Consulta {
    const proibidos = valor.replace(/[()]/g, "").split(",");
    this.filtrosDaConsulta.push((l) => !proibidos.includes(String(l[coluna])));
    return this;
  }
  or(texto: string): Consulta {
    this.filtrosDaConsulta.push(filtroOr(texto));
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
  async maybeSingle(): Promise<{ data: Linha | null; error: null }> {
    return { data: this.casadas()[0] ?? null, error: null };
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
  ];
}

function preparar(
  opcao: "ok" | "inexistente" | "modulo_desligado" = "ok",
  conversas: Linha[] = [
    {
      id: CONV,
      organization_id: ORG,
      channel: "webchat",
      channel_session_id: CS,
      provider_conversation_id: VIS,
    },
    {
      id: CONV_2,
      organization_id: ORG,
      channel: "webchat",
      channel_session_id: CS,
      provider_conversation_id: OUTRA_VIS,
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
              metadata: {},
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

function abrir(token: string | undefined, depois?: string, extra = ""): Request {
  const url = new URL(`https://crm.example.com/api/v1/webchat/eventos${extra}`);
  if (depois !== undefined) url.searchParams.set("depois", depois);
  return new Request(url, {
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
      return {
        evento: linhaEvento.slice("event: ".length),
        dados: JSON.parse(linhaDados.slice("data: ".length)) as Record<string, unknown>,
      };
    });
}

function estado(n: number): unknown {
  return (h.tabelas.messages ?? []).find((l) => l.id === id(n))?.status;
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
  it("entrega só a saída de texto da conversa deste visitante, sem entrada, sistema, falha nem fila", async () => {
    const res = await GET(abrir(tokenDeVisitante()));
    expect(res.status).toBe(200);

    const lidos = eventos(await lerAteFechar(res)).filter((e) => e.evento === "mensagem");
    expect(lidos.map((e) => e.dados.id)).toEqual([id(1), id(2)]);
    expect(lidos[0].dados.texto).toBe("Olá, em que posso ajudar?");
    expect(lidos[0].dados.em).toBe("2026-11-20T12:00:01.000+00:00");
  });

  it("marca como entregue só o que saiu, e não toca no que ficou de fora", async () => {
    await lerAteFechar(await GET(abrir(tokenDeVisitante())));

    expect(estado(1)).toBe("delivered");
    expect(estado(2)).toBe("delivered");
    expect(estado(4)).toBe("sent");
    expect(estado(5)).toBe("failed");
    expect(estado(6)).toBe("queued");
    expect(estado(7)).toBe("sent");
  });

  it("a conversa sai do token, e nem a organização nem a conversa vindas da URL entram", async () => {
    const res = await GET(
      abrir(tokenDeVisitante(), undefined, `?organization_id=${ORG_B}&conversation_id=${CONV_2}`),
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

  it("responde text/event-stream e fecha em 60 s, com cerca de 30 leituras", async () => {
    const res = await GET(abrir(tokenDeVisitante()));
    expect(res.headers.get("content-type")).toMatch(/^text\/event-stream/);

    await lerAteFechar(res);
    expect(h.leiturasDeMensagens).toBeGreaterThanOrEqual(25);
    expect(h.leiturasDeMensagens).toBeLessThanOrEqual(31);
  });

  it("com o cursor da última entrega, a próxima abertura não repete nada", async () => {
    const primeira = eventos(await lerAteFechar(await GET(abrir(tokenDeVisitante()))));
    const cursor = primeira.find((e) => e.evento === "cursor")?.dados.cursor;
    expect(typeof cursor).toBe("string");

    const segunda = eventos(
      await lerAteFechar(await GET(abrir(tokenDeVisitante(), cursor as string))),
    );
    expect(segunda.filter((e) => e.evento === "mensagem")).toEqual([]);
  });

  it("um cursor adulterado dá 400", async () => {
    const valido = assinarCursor({ criadoEm: "2026-11-20T12:00:01.000+00:00", id: id(1) });
    const adulterado = valido.replace(/^(.)/, (c) => (c === "x" ? "y" : "x"));

    expect((await GET(abrir(tokenDeVisitante(), adulterado))).status).toBe(400);
    expect((await GET(abrir(tokenDeVisitante(), "abc"))).status).toBe(400);
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
});

describe("cursor do stream", () => {
  it("ida e volta devolve o mesmo par; um cursor assinado por outro domínio não vale", () => {
    const criadoEm = "2026-11-20T12:00:02.000+00:00";
    expect(lerCursor(assinarCursor({ criadoEm, id: id(2) }))).toEqual({ criadoEm, id: id(2) });

    const corpo = Buffer.from(JSON.stringify({ v: 1, criadoEm, id: id(2) })).toString("base64url");
    const assinatura = createHmac("sha256", SEGREDO)
      .update(`deskcomm:webchat-visitante:v1:${corpo}`)
      .digest("base64url");
    expect(lerCursor(`${corpo}.${assinatura}`)).toBeNull();
  });
});
