import { randomBytes, randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A leitura dos eventos do módulo `connected` por cursor (spec 33, F5, tarefa 2).
 *
 * Rota e serviços REAIS; só o banco, o rate limit e o audit são dublês que anotam tudo. O banco falso
 * reproduz as três funções (`fn_extensions_events_allowed|read|ack`) com a mesma regra da migration 9120,
 * para a prova de isolamento ser do COMPORTAMENTO (o que a rota entrega a quem), e não da forma. A regra
 * do próprio SQL é provada contra Postgres real em `tests/invariants/extensoes-eventos.test.ts`.
 *
 * O que este arquivo prova:
 * - cada recusa de autenticação ou autorização devolve o MESMO status e o MESMO corpo da assinatura errada
 *   (inclusive módulo desativado há mais de 30 dias e `forbidden` vindo do banco);
 * - cursor adulterado, de outra organização ou de outra instalação é 400 `invalid_cursor` — só depois de
 *   autenticado; antes disso é a recusa genérica;
 * - pagina por cursor sem repetir nem pular; o cursor recebido reconhece o anterior (uma vez, antes de
 *   ler); sem cursor não há ack;
 * - evento de outra organização nunca aparece; `module_disabled` de outra instalação também não;
 * - falha nossa é 503, nunca disfarçada de recusa; rate limit é 429;
 * - a organização vem só do cabeçalho assinado (query e corpo são ignorados).
 */

type Linha = Record<string, unknown>;

const mocks = vi.hoisted(() => ({
  env: { AI_CRED_AES_KEY: "", INTERNAL_SECRET: "" },
  admin: null as unknown,
  audit: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  rate: vi.fn(),
}));

vi.mock("@/lib/env", () => ({ env: mocks.env }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => mocks.admin }));
vi.mock("@/lib/audit", () => ({ audit: mocks.audit, auditForOrganizations: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  logger: { warn: mocks.warn, error: mocks.error, info: mocks.info, debug: vi.fn() },
}));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: mocks.rate }));

const CHAVE = randomBytes(32).toString("base64");
const SEGREDO_DO_SERVIDOR = "segredo-interno-do-servidor-0123456789abcdef";
const SEGREDO = "segredo-da-instalacao-que-nunca-pode-vazar-0123456789";
const INSTALACAO = randomUUID();
const OUTRA_INSTALACAO = randomUUID();
const ORG_A = randomUUID();
const ORG_B = randomUUID();
const CONTATO_1 = randomUUID();
const CONTATO_2 = randomUUID();
const MENSAGEM_GENERICA = "Não foi possível autenticar o módulo.";
const DIA_MS = 24 * 60 * 60 * 1000;

type Tipo = "contact_anonymized" | "module_disabled" | "organization_suspended";

interface EventoSemente {
  org: string;
  kind: Tipo;
  subject_id?: string | null;
  installation_id?: string | null;
  /** Há quantos dias o fato ocorreu (padrão: 1). */
  haDias?: number;
}

interface Cenario {
  /** Eventos já existentes, na ordem de criação (o id é o índice + 1). */
  eventos?: EventoSemente[];
  /** O vínculo (ORG_A × INSTALACAO) está desligado. */
  vinculoDesligado?: boolean;
  /** Não existe vínculo nenhum da organização com a instalação. */
  semVinculo?: boolean;
  instalacaoDesligada?: boolean;
  semSegredo?: boolean;
  segredoGuardado?: string;
  erroNoSegredo?: boolean;
  erroNoNonce?: boolean;
  erroNoAllowed?: boolean;
  erroNoAck?: boolean;
  erroNaLeitura?: boolean;
  /** A leitura do banco recusa o par (corrida entre `allowed` e `read`). */
  bancoRecusaNaLeitura?: boolean;
  /** A leitura devolve um corpo sem `events`. */
  leituraIlegivel?: boolean;
  /** Cursor já gravado para o par ORG_A × INSTALACAO. */
  cursorGravado?: number;
}

interface EventoGravado {
  id: number;
  org: string;
  kind: Tipo;
  subject_id: string | null;
  installation_id: string | null;
  occurred_at: string;
}

function banco(cenario: Cenario, cifrar: (segredo: string) => string) {
  const gravacoes: unknown[] = [];
  const rpcs: Array<{ name: string; args: Linha }> = [];
  const nonces: Array<{ installation_id: string; nonce: string; seen_at: string }> = [];
  const cursores = new Map<string, number>();
  if (cenario.cursorGravado !== undefined) cursores.set(`${ORG_A}:${INSTALACAO}`, cenario.cursorGravado);
  const segredoGuardado = cenario.segredoGuardado ?? SEGREDO;

  const eventos: EventoGravado[] = (cenario.eventos ?? []).map((e, i) => ({
    id: i + 1,
    org: e.org,
    kind: e.kind,
    subject_id: e.subject_id ?? null,
    installation_id: e.installation_id ?? null,
    occurred_at: new Date(Date.now() - (e.haDias ?? 1) * DIA_MS).toISOString(),
  }));

  /** Regra D2 da migration 9120. */
  function permitido(org: string, instalacao: string): boolean {
    const ligado =
      !cenario.semVinculo &&
      org === ORG_A &&
      instalacao === INSTALACAO &&
      !cenario.vinculoDesligado &&
      !cenario.instalacaoDesligada;
    if (ligado) return true;
    return eventos.some(
      (e) =>
        e.org === org &&
        e.installation_id === instalacao &&
        e.kind === "module_disabled" &&
        new Date(e.occurred_at).getTime() > Date.now() - 30 * DIA_MS,
    );
  }

  function visiveis(org: string, instalacao: string): EventoGravado[] {
    return eventos.filter(
      (e) => e.org === org && (e.kind !== "module_disabled" || e.installation_id === instalacao),
    );
  }

  const forbidden = { code: "P0001", message: "extension_events_forbidden" };

  return {
    gravacoes,
    rpcs,
    nonces,
    cursores,
    from(table: string) {
      const filtros: Array<[string, unknown]> = [];
      const filtroDe = (coluna: string) => filtros.find(([c]) => c === coluna)?.[1];
      const limites: Array<[string, string]> = [];
      let apagando = false;
      const builder = {
        select: () => builder,
        eq: (coluna: string, valor: unknown) => {
          filtros.push([coluna, valor]);
          return builder;
        },
        lt: (coluna: string, valor: string) => {
          limites.push([coluna, valor]);
          return builder;
        },
        delete: () => {
          apagando = true;
          gravacoes.push({ table, delete: true });
          return builder;
        },
        insert: (row: Linha) => {
          gravacoes.push({ table, row });
          if (table === "extension_token_nonces") {
            if (cenario.erroNoNonce) {
              return Promise.resolve({ data: null, error: { code: "XX000", message: "falhou" } });
            }
            const repetido = nonces.some(
              (n) => n.installation_id === row.installation_id && n.nonce === row.nonce,
            );
            if (repetido) {
              return Promise.resolve({ data: null, error: { code: "23505", message: "duplicate key" } });
            }
            nonces.push({
              installation_id: String(row.installation_id),
              nonce: String(row.nonce),
              seen_at: new Date().toISOString(),
            });
          }
          return Promise.resolve({ data: null, error: null });
        },
        maybeSingle: () => {
          if (table === "extension_installation_secrets") {
            if (cenario.erroNoSegredo) {
              return Promise.resolve({ data: null, error: { code: "XX000", message: "falhou" } });
            }
            const id = filtroDe("installation_id");
            if (cenario.semSegredo || id !== INSTALACAO) return Promise.resolve({ data: null, error: null });
            return Promise.resolve({ data: { ciphertext: cifrar(segredoGuardado) }, error: null });
          }
          return Promise.resolve({ data: null, error: null });
        },
        then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
          if (apagando && table === "extension_token_nonces") {
            const instalacao = filtroDe("installation_id");
            const corte = limites.find(([c]) => c === "seen_at")?.[1] ?? "";
            for (let i = nonces.length - 1; i >= 0; i--) {
              if (nonces[i]!.installation_id === instalacao && nonces[i]!.seen_at < corte) nonces.splice(i, 1);
            }
          }
          return Promise.resolve({ data: null, error: null }).then(resolve, reject);
        },
      };
      return builder;
    },
    rpc(name: string, args: Linha) {
      rpcs.push({ name, args });
      const org = String(args.p_organization);
      const instalacao = String(args.p_installation);

      if (name === "fn_extensions_events_allowed") {
        if (cenario.erroNoAllowed) {
          return Promise.resolve({ data: null, error: { code: "XX000", message: "falhou" } });
        }
        return Promise.resolve({ data: permitido(org, instalacao), error: null });
      }

      if (name === "fn_extensions_events_ack") {
        if (cenario.erroNoAck) {
          return Promise.resolve({ data: null, error: { code: "XX000", message: "falhou" } });
        }
        if (!permitido(org, instalacao)) return Promise.resolve({ data: null, error: forbidden });
        const maximo = Math.max(0, ...visiveis(org, instalacao).map((e) => e.id));
        const chave = `${org}:${instalacao}`;
        const novo = Math.max(cursores.get(chave) ?? 0, Math.min(Number(args.p_event_id), maximo));
        cursores.set(chave, novo);
        return Promise.resolve({ data: { last_event_id: novo }, error: null });
      }

      if (name === "fn_extensions_events_read") {
        if (cenario.erroNaLeitura) {
          return Promise.resolve({ data: null, error: { code: "XX000", message: "falhou" } });
        }
        if (cenario.bancoRecusaNaLeitura || !permitido(org, instalacao)) {
          return Promise.resolve({ data: null, error: forbidden });
        }
        if (cenario.leituraIlegivel) return Promise.resolve({ data: { last_id: 0 }, error: null });
        const apos = Number(args.p_after);
        const limite = Math.min(Number(args.p_limit), 100);
        const todos = visiveis(org, instalacao).filter((e) => e.id > apos);
        const pagina = todos.slice(0, limite);
        return Promise.resolve({
          data: {
            events: pagina.map((e) => ({
              id: e.id,
              kind: e.kind,
              subject_id: e.subject_id,
              installation_id: e.installation_id,
              occurred_at: e.occurred_at,
            })),
            last_id: pagina.length > 0 ? pagina[pagina.length - 1]!.id : apos,
            has_more: todos.length > limite,
          },
          error: null,
        });
      }

      return Promise.resolve({ data: null, error: { code: "42883", message: "função inesperada" } });
    },
  };
}

type Rota = typeof import("./route");
type Seg = typeof import("@/lib/extensions/segredo-do-modulo");
type Eventos = typeof import("@/lib/extensions/eventos-do-modulo");

async function carregar(chave: string, segredoDoServidor = SEGREDO_DO_SERVIDOR) {
  mocks.env.AI_CRED_AES_KEY = chave;
  mocks.env.INTERNAL_SECRET = segredoDoServidor;
  vi.resetModules();
  return {
    rota: (await import("./route")) as Rota,
    seg: (await import("@/lib/extensions/segredo-do-modulo")) as Seg,
    ev: (await import("@/lib/extensions/eventos-do-modulo")) as Eventos,
  };
}

interface Pedido {
  installation?: string;
  organization?: string;
  timestamp?: string;
  nonce?: string;
  segredoDoModulo?: string;
  organizacaoAssinada?: string;
  assinatura?: string;
  omitir?: string[];
  ip?: string | null;
  /** Query string pura, sem `?`. */
  query?: string;
  corpo?: string;
}

const novoNonce = () => randomBytes(16).toString("base64url");

function montar(seg: Seg, p: Pedido = {}): Request {
  const organization = p.organization ?? ORG_A;
  const timestamp = p.timestamp ?? String(Date.now());
  const nonce = p.nonce ?? novoNonce();
  const assinatura =
    p.assinatura ??
    seg.assinar(p.segredoDoModulo ?? SEGREDO, {
      organizationId: p.organizacaoAssinada ?? organization,
      timestamp,
      nonce,
    });
  const headers: Record<string, string> = {
    "X-Module-Installation": p.installation ?? INSTALACAO,
    "X-Module-Organization": organization,
    "X-Module-Timestamp": timestamp,
    "X-Module-Nonce": nonce,
    "X-Module-Signature": assinatura,
  };
  for (const nome of p.omitir ?? []) delete headers[nome];
  if (p.ip !== null) headers["x-forwarded-for"] = p.ip ?? "203.0.113.7";
  const url = `http://localhost/api/v1/extensions/events${p.query ? `?${p.query}` : ""}`;
  return new Request(url, { method: "GET", headers });
}

interface Corpo {
  data?: {
    events: Array<{
      id: number;
      kind: Tipo;
      subject_id: string | null;
      installation_id: string | null;
      occurred_at: string;
    }>;
    next_cursor: string | null;
    has_more: boolean;
  };
  error?: { code: string; message: string };
}

async function ler(cenario: Cenario = {}, pedido: Pedido | ((c: Awaited<ReturnType<typeof carregar>>) => Pedido) = {}) {
  const ctx = await carregar(CHAVE);
  const db = banco(cenario, (s) => ctx.seg.cifrarSegredo(s));
  mocks.admin = db;
  const p = typeof pedido === "function" ? pedido(ctx) : pedido;
  const res = await ctx.rota.GET(montar(ctx.seg, p));
  const texto = await res.text();
  return { res, db, ...ctx, texto, corpo: JSON.parse(texto) as Corpo };
}

function tudoQueFoiGravado(db: ReturnType<typeof banco>): string {
  return JSON.stringify({
    gravacoes: db.gravacoes,
    rpcs: db.rpcs,
    audit: mocks.audit.mock.calls,
    warn: mocks.warn.mock.calls,
    error: mocks.error.mock.calls,
    info: mocks.info.mock.calls,
  });
}

const contatos = (n: number): EventoSemente[] =>
  Array.from({ length: n }, () => ({ org: ORG_A, kind: "contact_anonymized" as const, subject_id: randomUUID() }));

beforeEach(() => {
  mocks.audit.mockReset();
  mocks.warn.mockReset();
  mocks.error.mockReset();
  mocks.info.mockReset();
  mocks.rate.mockReset();
  mocks.rate.mockImplementation(async (_balde: string, limite: number, janela: number) => ({
    allowed: true,
    count: 1,
    limit: limite,
    window_sec: janela,
  }));
});

afterEach(() => {
  vi.useRealTimers();
});

/** A recusa de referência: assinatura errada. Todas as outras precisam ser indistinguíveis dela. */
async function recusaDeReferencia() {
  const { res, texto, corpo } = await ler({}, { assinatura: "0".repeat(64) });
  return { status: res.status, texto, corpo };
}

describe("GET /api/v1/extensions/events — caminho feliz", () => {
  it("devolve a primeira página sem cursor, sem ack, com no-store e só identificadores", async () => {
    const { res, db, corpo } = await ler({ eventos: contatos(5) });

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("X-Request-Id")).toBeTruthy();
    expect(corpo.data!.events.map((e) => e.id)).toEqual([1, 2, 3, 4, 5]);
    expect(corpo.data!.has_more).toBe(false);
    expect(corpo.data!.next_cursor).toBeTruthy();
    // Sem cursor recebido não há reconhecimento a fazer.
    expect(db.rpcs.map((r) => r.name)).toEqual(["fn_extensions_events_allowed", "fn_extensions_events_read"]);
    expect(db.cursores.size).toBe(0);
    // Só identificadores: cada evento tem exatamente estas chaves.
    for (const e of corpo.data!.events) {
      expect(Object.keys(e).sort()).toEqual(["id", "installation_id", "kind", "occurred_at", "subject_id"]);
    }
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("o limite padrão é 50 e o pedido vai ao banco com a organização e a instalação assinadas", async () => {
    const { db } = await ler({ eventos: contatos(2) });
    const leitura = db.rpcs.find((r) => r.name === "fn_extensions_events_read")!;
    expect(leitura.args).toEqual({
      p_organization: ORG_A,
      p_installation: INSTALACAO,
      p_after: 0,
      p_limit: 50,
    });
  });

  it("sem eventos: lista vazia, sem cursor de volta", async () => {
    const { res, corpo } = await ler({ eventos: [] });
    expect(res.status).toBe(200);
    expect(corpo.data).toEqual({ events: [], next_cursor: null, has_more: false });
  });

  it("pagina por cursor sem repetir nem pular, e cada cursor recebido reconhece o anterior", async () => {
    const ctx = await carregar(CHAVE);
    const db = banco({ eventos: contatos(7) }, (s) => ctx.seg.cifrarSegredo(s));
    mocks.admin = db;

    const ids: number[] = [];
    let cursor: string | null = null;
    let paginas = 0;
    for (;;) {
      const query: string = cursor ? `limit=3&cursor=${cursor}` : "limit=3";
      const res = await ctx.rota.GET(montar(ctx.seg, { query }));
      expect(res.status).toBe(200);
      const corpo = (await res.json()) as Corpo;
      ids.push(...corpo.data!.events.map((e) => e.id));
      paginas++;
      cursor = corpo.data!.next_cursor;
      if (!corpo.data!.has_more) break;
      expect(paginas).toBeLessThan(10);
    }
    expect(ids).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(paginas).toBe(3);

    // O cursor só avança quando o módulo volta com o cursor seguinte: lê a página 3 (ids 7), ainda não reconheceu o 7.
    expect(db.cursores.get(`${ORG_A}:${INSTALACAO}`)).toBe(6);
    // Uma chamada de ack por requisição com cursor (2 de 3), cada uma ANTES da leitura da sua requisição.
    const nomes = db.rpcs.map((r) => r.name);
    expect(nomes.filter((n) => n === "fn_extensions_events_ack")).toHaveLength(2);
    expect(nomes).toEqual([
      "fn_extensions_events_allowed",
      "fn_extensions_events_read",
      "fn_extensions_events_allowed",
      "fn_extensions_events_ack",
      "fn_extensions_events_read",
      "fn_extensions_events_allowed",
      "fn_extensions_events_ack",
      "fn_extensions_events_read",
    ]);

    // Voltar com o último cursor reconhece tudo e não devolve nada novo.
    const final = (await (await ctx.rota.GET(montar(ctx.seg, { query: `cursor=${cursor}` }))).json()) as Corpo;
    expect(final.data!.events).toEqual([]);
    expect(final.data!.has_more).toBe(false);
    expect(db.cursores.get(`${ORG_A}:${INSTALACAO}`)).toBe(7);
  });

  it("o ack usa a posição do cursor RECEBIDO, não a da leitura", async () => {
    const ctx = await carregar(CHAVE);
    const db = banco({ eventos: contatos(5) }, (s) => ctx.seg.cifrarSegredo(s));
    mocks.admin = db;
    const cursor = ctx.ev.emitirCursorDeEventos(ORG_A, INSTALACAO, 2);
    const res = await ctx.rota.GET(montar(ctx.seg, { query: `cursor=${cursor}` }));
    const corpo = (await res.json()) as Corpo;
    expect(corpo.data!.events.map((e) => e.id)).toEqual([3, 4, 5]);
    const ack = db.rpcs.find((r) => r.name === "fn_extensions_events_ack")!;
    expect(ack.args).toEqual({ p_organization: ORG_A, p_installation: INSTALACAO, p_event_id: 2 });
    expect(db.cursores.get(`${ORG_A}:${INSTALACAO}`)).toBe(2);
  });

  it("módulo atrasado há 40 dias que volta: lê tudo desde o cursor, sem perda", async () => {
    const eventos: EventoSemente[] = [
      { org: ORG_A, kind: "contact_anonymized", subject_id: CONTATO_1, haDias: 45 },
      { org: ORG_A, kind: "contact_anonymized", subject_id: CONTATO_2, haDias: 40 },
      { org: ORG_A, kind: "organization_suspended", haDias: 30 },
      ...contatos(3).map((e) => ({ ...e, haDias: 10 })),
    ];
    const { res, corpo } = await ler({ eventos, cursorGravado: 1 }, ({ ev }) => ({
      query: `cursor=${ev.emitirCursorDeEventos(ORG_A, INSTALACAO, 1)}`,
    }));
    expect(res.status).toBe(200);
    expect(corpo.data!.events.map((e) => e.id)).toEqual([2, 3, 4, 5, 6]);
    expect(corpo.data!.events[0]).toMatchObject({ kind: "contact_anonymized", subject_id: CONTATO_2 });
  });

  it("organização suspensa continua lendo: o evento de suspensão chega", async () => {
    const { res, corpo } = await ler({
      eventos: [{ org: ORG_A, kind: "organization_suspended" }],
    });
    expect(res.status).toBe(200);
    expect(corpo.data!.events.map((e) => e.kind)).toEqual(["organization_suspended"]);
  });

  it("ignora organização na query e no corpo: só vale a dos cabeçalhos assinados", async () => {
    const { res, corpo } = await ler(
      {
        eventos: [
          { org: ORG_A, kind: "contact_anonymized", subject_id: CONTATO_1 },
          { org: ORG_B, kind: "contact_anonymized", subject_id: CONTATO_2 },
        ],
      },
      { query: `organization_id=${ORG_B}&org=${ORG_B}` },
    );
    expect(res.status).toBe(200);
    expect(corpo.data!.events.map((e) => e.subject_id)).toEqual([CONTATO_1]);
  });

  it("o rate limit usa um balde por IP+instalação e outro só por instalação", async () => {
    await ler();
    const baldes = mocks.rate.mock.calls.map((c) => [c[0], c[1], c[2]]);
    expect(baldes).toEqual([
      [`mod-events:ip:203.0.113.7:${INSTALACAO}`, 30, 60],
      [`mod-events:inst:${INSTALACAO}`, 120, 60],
    ]);
  });
});

describe("GET /api/v1/extensions/events — isolamento entre organizações", () => {
  it("evento de outra organização nunca aparece, mesmo com o módulo instalado nas duas", async () => {
    const eventos: EventoSemente[] = [
      { org: ORG_B, kind: "contact_anonymized", subject_id: CONTATO_2 },
      { org: ORG_A, kind: "contact_anonymized", subject_id: CONTATO_1 },
      { org: ORG_B, kind: "organization_suspended" },
      { org: ORG_B, kind: "module_disabled", installation_id: INSTALACAO },
    ];
    const { res, corpo, texto } = await ler({ eventos });
    expect(res.status).toBe(200);
    expect(corpo.data!.events.map((e) => e.id)).toEqual([2]);
    expect(texto).not.toContain(CONTATO_2);
  });

  it("module_disabled de OUTRA instalação da mesma organização não aparece", async () => {
    const { corpo } = await ler({
      eventos: [
        { org: ORG_A, kind: "module_disabled", installation_id: OUTRA_INSTALACAO },
        { org: ORG_A, kind: "contact_anonymized", subject_id: CONTATO_1 },
      ],
    });
    expect(corpo.data!.events.map((e) => e.kind)).toEqual(["contact_anonymized"]);
  });

  it("assinatura correta da organização B sem vínculo da B: a mesma recusa genérica, sem evento algum", async () => {
    const ref = await recusaDeReferencia();
    const { res, texto } = await ler(
      { eventos: [{ org: ORG_B, kind: "contact_anonymized", subject_id: CONTATO_2 }] },
      { organization: ORG_B },
    );
    expect(res.status).toBe(401);
    expect(texto).toBe(ref.texto);
    expect(texto).not.toContain(CONTATO_2);
  });

  it("assinatura da org A com cabeçalho da org B: recusa genérica", async () => {
    const ref = await recusaDeReferencia();
    const { res, texto } = await ler({}, { organization: ORG_B, organizacaoAssinada: ORG_A });
    expect(res.status).toBe(401);
    expect(texto).toBe(ref.texto);
  });
});

describe("GET /api/v1/extensions/events — módulo desativado e reativado", () => {
  const desativadoHa = (dias: number): Cenario => ({
    vinculoDesligado: true,
    eventos: [
      { org: ORG_A, kind: "contact_anonymized", subject_id: CONTATO_1, haDias: dias + 1 },
      { org: ORG_A, kind: "module_disabled", installation_id: INSTALACAO, haDias: dias },
    ],
  });

  it("desativado há 29 dias: ainda lê (a LGPD não fica presa)", async () => {
    const { res, corpo } = await ler(desativadoHa(29));
    expect(res.status).toBe(200);
    expect(corpo.data!.events.map((e) => e.kind)).toEqual(["contact_anonymized", "module_disabled"]);
  });

  it("desativado há 31 dias: recusa idêntica à assinatura errada", async () => {
    const ref = await recusaDeReferencia();
    const { res, texto, db } = await ler(desativadoHa(31));
    expect(res.status).toBe(401);
    expect(texto).toBe(ref.texto);
    expect(db.rpcs.map((r) => r.name)).toEqual(["fn_extensions_events_allowed"]);
    expect(texto).not.toContain(CONTATO_1);
  });

  it("reativado depois de 31 dias desligado: volta a ler", async () => {
    const { res } = await ler({ ...desativadoHa(31), vinculoDesligado: false });
    expect(res.status).toBe(200);
  });

  it("instalação desligada há mais de 30 dias: recusa genérica", async () => {
    const ref = await recusaDeReferencia();
    const { res, texto } = await ler({ ...desativadoHa(40), instalacaoDesligada: true });
    expect(res.status).toBe(401);
    expect(texto).toBe(ref.texto);
  });
});

describe("GET /api/v1/extensions/events — cursor inválido (só depois de autenticar)", () => {
  async function comCursor(montarCursor: (ev: Eventos) => string, cenario: Cenario = { eventos: contatos(4) }) {
    const ctx = await carregar(CHAVE);
    const db = banco(cenario, (s) => ctx.seg.cifrarSegredo(s));
    mocks.admin = db;
    const cursor = montarCursor(ctx.ev);
    const res = await ctx.rota.GET(montar(ctx.seg, { query: `cursor=${cursor}` }));
    const texto = await res.text();
    return { res, db, texto, corpo: JSON.parse(texto) as Corpo, ctx };
  }

  function adulterar(cursor: string): string {
    const ponto = cursor.indexOf(".");
    const assinatura = cursor.slice(ponto + 1);
    const troca = assinatura.startsWith("0") ? "1" : "0";
    return `${cursor.slice(0, ponto + 1)}${troca}${assinatura.slice(1)}`;
  }

  const casos: Array<[string, (ev: Eventos) => string]> = [
    ["cursor adulterado (assinatura trocada)", (ev) => adulterar(ev.emitirCursorDeEventos(ORG_A, INSTALACAO, 2))],
    [
      "cursor com a carga trocada e a assinatura de outra posição",
      (ev) => {
        const outro = ev.emitirCursorDeEventos(ORG_A, INSTALACAO, 1);
        const alvo = ev.emitirCursorDeEventos(ORG_A, INSTALACAO, 3);
        return `${alvo.slice(0, alvo.indexOf("."))}${outro.slice(outro.indexOf("."))}`;
      },
    ],
    ["cursor de outra organização (válido para ela)", (ev) => ev.emitirCursorDeEventos(ORG_B, INSTALACAO, 2)],
    ["cursor de outra instalação (válido para ela)", (ev) => ev.emitirCursorDeEventos(ORG_A, OUTRA_INSTALACAO, 2)],
    ["cursor sem assinatura", () => Buffer.from(`${ORG_A}.${INSTALACAO}.2`).toString("base64url")],
    ["cursor sem formato", () => "abc"],
    ["cursor com posição escolhida pelo módulo (sem assinatura nossa)", () => `${Buffer.from(`${ORG_A}.${INSTALACAO}.0`).toString("base64url")}.${"0".repeat(64)}`],
  ];

  it.each(casos)("%s: 400 invalid_cursor, sem ack e sem leitura", async (_nome, montarCursor) => {
    const { res, corpo, db } = await comCursor(montarCursor);
    expect(res.status).toBe(400);
    expect(corpo.error?.code).toBe("invalid_cursor");
    expect(db.rpcs.map((r) => r.name)).toEqual(["fn_extensions_events_allowed"]);
    expect(db.cursores.size).toBe(0);
  });

  it("cursor assinado por OUTRO segredo do servidor também é inválido", async () => {
    const outro = await carregar(CHAVE, "outro-segredo-interno-do-servidor-9876543210");
    const cursor = outro.ev.emitirCursorDeEventos(ORG_A, INSTALACAO, 2);
    const { res, corpo } = await comCursor(() => cursor);
    expect(res.status).toBe(400);
    expect(corpo.error?.code).toBe("invalid_cursor");
  });

  it("cursor inválido sem autenticar vira a recusa genérica, nunca 400 (não revela nada antes da prova)", async () => {
    const ref = await recusaDeReferencia();
    const ctx = await carregar(CHAVE);
    mocks.admin = banco({}, (s) => ctx.seg.cifrarSegredo(s));
    const res = await ctx.rota.GET(montar(ctx.seg, { assinatura: "0".repeat(64), query: "cursor=lixo&limit=999" }));
    expect(res.status).toBe(401);
    expect(await res.text()).toBe(ref.texto);
  });

  it("cursor inválido de módulo sem autorização (desativado há 31 dias) vira a recusa genérica", async () => {
    const ref = await recusaDeReferencia();
    const { res, texto } = await comCursor((ev) => ev.emitirCursorDeEventos(ORG_A, INSTALACAO, 1), {
      vinculoDesligado: true,
      eventos: [{ org: ORG_A, kind: "module_disabled", installation_id: INSTALACAO, haDias: 31 }],
    });
    expect(res.status).toBe(401);
    expect(texto).toBe(ref.texto);
  });

  it("cursor vazio na query vale como ausente (primeira leitura)", async () => {
    const { res, corpo } = await ler({ eventos: contatos(2) }, { query: "cursor=" });
    expect(res.status).toBe(200);
    expect(corpo.data!.events).toHaveLength(2);
  });
});

describe("GET /api/v1/extensions/events — limit", () => {
  it.each(["0", "101", "-1", "abc", "1.5", "", "99999", "1e2"])("limit=%j: 400 e nada é lido", async (limite) => {
    const { res, corpo, db } = await ler({ eventos: contatos(3) }, { query: `limit=${limite}` });
    expect(res.status).toBe(400);
    expect(corpo.error?.code).toBe("validation_failed");
    expect(db.rpcs.map((r) => r.name)).toEqual(["fn_extensions_events_allowed"]);
  });

  it.each([
    ["1", 1],
    ["100", 100],
  ])("limit=%s: aceito e repassado ao banco", async (limite, esperado) => {
    const { res, db } = await ler({ eventos: contatos(3) }, { query: `limit=${limite}` });
    expect(res.status).toBe(200);
    expect(db.rpcs.find((r) => r.name === "fn_extensions_events_read")!.args.p_limit).toBe(esperado);
  });

  it("limit inválido de quem não autenticou é a recusa genérica, não 400", async () => {
    const ref = await recusaDeReferencia();
    const { res, texto } = await ler({}, { assinatura: "0".repeat(64), query: "limit=0" });
    expect(res.status).toBe(401);
    expect(texto).toBe(ref.texto);
  });
});

describe("GET /api/v1/extensions/events — recusas indistinguíveis", () => {
  it("a recusa de referência é 401 com a mensagem genérica e sem dados", async () => {
    const ref = await recusaDeReferencia();
    expect(ref.status).toBe(401);
    expect(ref.corpo.error?.message).toBe(MENSAGEM_GENERICA);
    expect(ref.corpo.data).toBeUndefined();
  });

  const casos: Array<[string, Cenario, Pedido]> = [
    ["instalação sem segredo (ou inexistente)", { semSegredo: true }, {}],
    ["organização sem vínculo", { semVinculo: true }, {}],
    ["vínculo desligado e sem evento de desativação", { vinculoDesligado: true }, {}],
    ["instalação desligada", { instalacaoDesligada: true }, {}],
    ["assinatura feita com outro segredo", {}, { segredoDoModulo: "outro-segredo" }],
    ["assinatura com o segredo antigo depois de girar", { segredoGuardado: "segredo-novo-depois-de-girar" }, {}],
    ["instalação de outro módulo", {}, { installation: OUTRA_INSTALACAO }],
    ["assinatura com tamanho errado", {}, { assinatura: "abc" }],
    ["assinatura não-hex", {}, { assinatura: "z".repeat(64) }],
    ["cabeçalho de assinatura ausente", {}, { omitir: ["X-Module-Signature"] }],
    ["cabeçalho de instalação ausente", {}, { omitir: ["X-Module-Installation"] }],
    ["cabeçalho de organização ausente", {}, { omitir: ["X-Module-Organization"] }],
    ["cabeçalho de carimbo ausente", {}, { omitir: ["X-Module-Timestamp"] }],
    ["cabeçalho de nonce ausente", {}, { omitir: ["X-Module-Nonce"] }],
    ["carimbo não numérico", {}, { timestamp: "ontem" }],
    ["nonce com ponto", {}, { nonce: "abcdefgh.ijklmnopqrs" }],
    ["banco recusa o par na leitura (forbidden)", { bancoRecusaNaLeitura: true }, {}],
  ];

  it.each(casos)("%s: mesmo status e mesmo corpo da assinatura errada, sem dado e sem audit", async (_nome, cenario, pedido) => {
    const ref = await recusaDeReferencia();
    const { res, texto, db } = await ler(
      { ...cenario, eventos: [{ org: ORG_A, kind: "contact_anonymized", subject_id: CONTATO_1 }] },
      pedido,
    );
    expect(res.status).toBe(ref.status);
    expect(texto).toBe(ref.texto);
    expect(texto).not.toContain(CONTATO_1);
    expect(db.cursores.size).toBe(0);
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it.each([
    ["velho demais (5 min + 1 ms)", -(5 * 60 * 1000 + 1)],
    ["adiantado demais (5 min + 1 ms)", 5 * 60 * 1000 + 1],
    ["muito velho (1 h)", -60 * 60 * 1000],
  ])("carimbo %s: 401 genérico e nada é lido", async (_nome, delta) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-05T12:00:00.000Z"));
    const agora = Date.now();
    const { res, texto, db } = await ler({ eventos: contatos(2) }, { timestamp: String(agora + delta) });
    vi.useRealTimers();
    const ref = await recusaDeReferencia();
    expect(res.status).toBe(401);
    expect(texto).toBe(ref.texto);
    expect(db.rpcs).toEqual([]);
  });

  it("carimbo exatamente 5 min no passado: a borda é inclusiva e passa", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-05T12:00:00.000Z"));
    const agora = Date.now();
    const { res } = await ler({ eventos: contatos(1) }, { timestamp: String(agora - 5 * 60 * 1000) });
    vi.useRealTimers();
    expect(res.status).toBe(200);
  });

  it("nonce repetido: a primeira leitura passa, a repetida é 401 genérico e não lê nada", async () => {
    const ctx = await carregar(CHAVE);
    const db = banco({ eventos: contatos(2) }, (s) => ctx.seg.cifrarSegredo(s));
    mocks.admin = db;
    const nonce = novoNonce();
    const primeira = await ctx.rota.GET(montar(ctx.seg, { nonce }));
    expect(primeira.status).toBe(200);
    const leituras = db.rpcs.length;

    const segunda = await ctx.rota.GET(montar(ctx.seg, { nonce }));
    const texto = await segunda.text();
    const ref = await recusaDeReferencia();
    expect(segunda.status).toBe(401);
    expect(texto).toBe(ref.texto);
    expect(db.rpcs).toHaveLength(leituras);
  });

  it("assinatura inválida não grava nonce e não toca as funções de eventos", async () => {
    const { db } = await ler({ eventos: contatos(2) }, { assinatura: "0".repeat(64) });
    expect(db.nonces).toEqual([]);
    expect(db.rpcs).toEqual([]);
  });

  it("o motivo real vai ao log, sem segredo, assinatura, cursor nem identificador de evento", async () => {
    const { db } = await ler({ vinculoDesligado: true, eventos: [{ org: ORG_A, kind: "contact_anonymized", subject_id: CONTATO_1 }] });
    const log = JSON.stringify(mocks.warn.mock.calls);
    expect(log).toContain("nao_autorizado");
    expect(log).not.toContain(SEGREDO);
    expect(log).not.toContain(CONTATO_1);
    expect(tudoQueFoiGravado(db)).not.toContain(SEGREDO);
  });
});

describe("GET /api/v1/extensions/events — rate limit e falhas nossas", () => {
  it("estourou o balde por IP+instalação: 429 com Retry-After, sem tocar o banco", async () => {
    mocks.rate.mockImplementation(async (balde: string, limite: number, janela: number) => ({
      allowed: !balde.startsWith("mod-events:ip:"),
      count: 99,
      limit: limite,
      window_sec: janela,
    }));
    const { res, db, corpo } = await ler({ eventos: contatos(2) });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(corpo.error?.code).toBe("rate_limited");
    expect(db.rpcs).toEqual([]);
    expect(db.gravacoes).toEqual([]);
  });

  it("estourou o balde por instalação: 429", async () => {
    mocks.rate.mockImplementation(async (balde: string, limite: number, janela: number) => ({
      allowed: !balde.startsWith("mod-events:inst:"),
      count: 99,
      limit: limite,
      window_sec: janela,
    }));
    const { res, db } = await ler();
    expect(res.status).toBe(429);
    expect(db.rpcs).toEqual([]);
  });

  it("sem IP identificável só o balde da instalação conta", async () => {
    await ler({}, { ip: null });
    expect(mocks.rate.mock.calls.map((c) => c[0])).toEqual([`mod-events:inst:${INSTALACAO}`]);
  });

  it("o formato é conferido antes do rate limit (lixo não gasta balde)", async () => {
    await ler({}, { omitir: ["X-Module-Nonce"] });
    expect(mocks.rate).not.toHaveBeenCalled();
  });

  it.each([
    ["leitura do segredo", { erroNoSegredo: true }],
    ["gravação do nonce", { erroNoNonce: true }],
    ["autorização", { erroNoAllowed: true }],
    ["leitura dos eventos", { erroNaLeitura: true }],
    ["leitura ilegível", { leituraIlegivel: true }],
  ] as Array<[string, Cenario]>)("falha do banco na %s: 503, sem evento algum", async (_nome, cenario) => {
    const { res, corpo, texto } = await ler({ ...cenario, eventos: contatos(2) });
    expect(res.status).toBe(503);
    expect(corpo.data).toBeUndefined();
    expect(texto).not.toContain("subject_id");
  });

  it("falha no ack: 503 e nada é lido (o cursor não avança sem reconhecer)", async () => {
    const { res, db } = await ler(
      { erroNoAck: true, eventos: contatos(3) },
      ({ ev }) => ({ query: `cursor=${ev.emitirCursorDeEventos(ORG_A, INSTALACAO, 1)}` }),
    );
    expect(res.status).toBe(503);
    expect(db.rpcs.map((r) => r.name)).toEqual(["fn_extensions_events_allowed", "fn_extensions_events_ack"]);
  });

  it("sem chave de cifra no servidor: 503 (falha nossa), nunca a recusa genérica", async () => {
    const { seg } = await carregar(CHAVE);
    const cifrado = seg.cifrarSegredo(SEGREDO);
    const db = banco({}, () => cifrado);
    mocks.admin = db;
    const req = montar(seg);
    const semChave = await carregar("");
    const res = await semChave.rota.GET(req);
    expect(res.status).toBe(503);
  });

  it("sem segredo interno no servidor, um cursor não pode ser conferido: 503, não 400", async () => {
    const ctx = await carregar(CHAVE);
    const cursor = ctx.ev.emitirCursorDeEventos(ORG_A, INSTALACAO, 1);
    const db = banco({ eventos: contatos(3) }, (s) => ctx.seg.cifrarSegredo(s));
    mocks.admin = db;
    const req = montar(ctx.seg, { query: `cursor=${cursor}` });
    mocks.env.INTERNAL_SECRET = "";
    const res = await ctx.rota.GET(req);
    expect(res.status).toBe(503);
  });
});

describe("GET /api/v1/extensions/events — porta no proxy", () => {
  it("a rota é pública só no caminho exato", async () => {
    const { isPublicPath } = await import("@/lib/auth/public-paths");
    expect(isPublicPath("/api/v1/extensions/events")).toBe(true);
    expect(isPublicPath("/api/v1/extensions/events/x")).toBe(false);
    expect(isPublicPath("/api/v1/extensions/event")).toBe(false);
  });
});
