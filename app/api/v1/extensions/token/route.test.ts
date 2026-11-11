import { createHash, randomBytes, randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A busca do token do módulo `connected` (spec 33, F2, tarefa 5).
 *
 * O que este arquivo prova, com a rota e o serviço REAIS e só o banco, o rate limit e o audit
 * substituídos por dublês que anotam tudo:
 * - o caminho feliz devolve `dsk_<8 hex>_…`, o hash gravado é o sha256 do texto devolvido, a validade é
 *   de 1 hora e o token tem os escopos mínimos (`mcp:read`, `role:viewer`, `actor:module:<slug>`);
 * - cada recusa de autenticação (formato, carimbo, assinatura errada, outra organização, segredo
 *   antigo, repetição, instalação desligada, ativação desativada, organização sem ativação,
 *   instalação inexistente) devolve o MESMO status e o MESMO corpo, e NÃO troca o hash;
 * - o texto do token e o segredo não aparecem em audit, log nem em gravação alguma;
 * - rate limit devolve 429 com Retry-After; falha do banco é 503, nunca disfarçada de recusa.
 */

type Linha = Record<string, unknown>;

const mocks = vi.hoisted(() => ({
  env: { AI_CRED_AES_KEY: "" },
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
const SEGREDO = "segredo-da-instalacao-que-nunca-pode-vazar-0123456789";
const INSTALACAO = randomUUID();
const OUTRA_INSTALACAO = randomUUID();
const ORG_A = randomUUID();
const ORG_B = randomUUID();
const SLUG = "acme/conectado";
const HASH_ANTIGO = createHash("sha256").update("vaga-antiga").digest("hex");
const MENSAGEM_GENERICA = "Não foi possível autenticar o módulo.";

interface Cenario {
  instalacaoDesligada?: boolean;
  instalacaoRemovida?: boolean;
  ativacaoDesativada?: boolean;
  semAtivacao?: boolean;
  semInstalacao?: boolean;
  semSegredo?: boolean;
  segredoGuardado?: string;
  erroNoSegredo?: boolean;
  erroNoNonce?: boolean;
  erroNaRotacao?: boolean;
  noncesPreexistentes?: Array<{ installation_id: string; nonce: string; seen_at: string }>;
}

interface TokenGravado {
  organization_id: string;
  installation_id: string;
  prefix: string;
  hashHex: string;
  expires_at: string;
  scopes: string[];
  revoked: boolean;
}

function banco(cenario: Cenario, cifrar: (segredo: string) => string) {
  const gravacoes: unknown[] = [];
  const rpcs: Array<{ name: string; args: Linha }> = [];
  const nonces = [...(cenario.noncesPreexistentes ?? [])];
  const tokens = new Map<string, TokenGravado>();
  // A vaga reservada na ativação da ORG_A (hash de preimagem desconhecida).
  tokens.set(`${ORG_A}:${INSTALACAO}`, {
    organization_id: ORG_A,
    installation_id: INSTALACAO,
    prefix: "dsk_00000000",
    hashHex: HASH_ANTIGO,
    expires_at: "2126-01-01T00:00:00.000Z",
    scopes: ["mcp:read", "role:viewer", `actor:module:${SLUG}`],
    revoked: false,
  });
  const segredoGuardado = cenario.segredoGuardado ?? SEGREDO;

  function ativacao(org: string, instalacao: string): boolean | null {
    if (cenario.semAtivacao) return null;
    if (instalacao !== INSTALACAO) return null;
    if (org !== ORG_A) return null;
    return !cenario.ativacaoDesativada;
  }

  return {
    gravacoes,
    rpcs,
    nonces,
    tokens,
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
          if (table === "extension_installations") {
            const id = filtroDe("id");
            if (cenario.semInstalacao || id !== INSTALACAO) return Promise.resolve({ data: null, error: null });
            const [publisher, name] = SLUG.split("/");
            return Promise.resolve({ data: { publisher, name }, error: null });
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
      if (name !== "fn_extensions_module_token_rotate") {
        return Promise.resolve({ data: null, error: { code: "42883", message: "função inesperada" } });
      }
      if (cenario.erroNaRotacao) {
        return Promise.resolve({ data: null, error: { code: "XX000", message: "falhou" } });
      }
      const org = String(args.p_organization);
      const instalacao = String(args.p_installation);
      const enabled = ativacao(org, instalacao);
      if (cenario.semInstalacao || cenario.instalacaoDesligada || cenario.instalacaoRemovida || enabled !== true) {
        return Promise.resolve({
          data: null,
          error: { code: "PT409", message: "O módulo está desligado, removido ou não existe." },
        });
      }
      const chave = `${org}:${instalacao}`;
      const atual = tokens.get(chave)!;
      tokens.set(chave, {
        ...atual,
        prefix: String(args.p_prefix),
        hashHex: String(args.p_hash).replace(/^\\x/, ""),
        expires_at: String(args.p_expires_at),
        revoked: false,
      });
      return Promise.resolve({ data: "id-do-token", error: null });
    },
  };
}

type Rota = typeof import("./route");
type Modulo = typeof import("@/lib/extensions/segredo-do-modulo");

async function carregar(chave: string): Promise<{ rota: Rota; seg: Modulo }> {
  mocks.env.AI_CRED_AES_KEY = chave;
  vi.resetModules();
  return { rota: await import("./route"), seg: await import("@/lib/extensions/segredo-do-modulo") };
}

interface Pedido {
  installation?: string;
  organization?: string;
  timestamp?: string;
  nonce?: string;
  /** Segredo com que o MÓDULO assina (padrão: o guardado). */
  segredoDoModulo?: string;
  /** Organização que entra no texto assinado (padrão: a do cabeçalho). */
  organizacaoAssinada?: string;
  assinatura?: string;
  omitir?: string[];
  ip?: string | null;
}

const novoNonce = () => randomBytes(16).toString("base64url");

function montar(seg: Modulo, p: Pedido = {}): Request {
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
  return new Request("http://localhost/api/v1/extensions/token", { method: "POST", headers });
}

interface Corpo {
  data?: { token: string; expires_at: string };
  error?: { code: string; message: string };
}

async function buscar(cenario: Cenario = {}, pedido: Pedido | ((seg: Modulo) => Pedido) = {}) {
  const { rota, seg } = await carregar(CHAVE);
  const db = banco(cenario, (s) => seg.cifrarSegredo(s));
  mocks.admin = db;
  const p = typeof pedido === "function" ? pedido(seg) : pedido;
  const res = await rota.POST(montar(seg, p));
  const texto = await res.text();
  return { res, db, seg, texto, corpo: JSON.parse(texto) as Corpo };
}

/** Tudo o que o dublê viu sair do servidor, numa string só, para procurar um texto que não pode estar lá. */
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

function hashDoPar(db: ReturnType<typeof banco>, org = ORG_A): string {
  return db.tokens.get(`${org}:${INSTALACAO}`)!.hashHex;
}

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
  const { res, texto, corpo } = await buscar({}, { assinatura: "0".repeat(64) });
  return { status: res.status, texto, corpo };
}

describe("POST /api/v1/extensions/token — caminho feliz", () => {
  it("devolve dsk_<8hex>_…, grava o sha256 do texto, validade de 1 h e os escopos mínimos", async () => {
    const antes = Date.now();
    const { res, db, corpo } = await buscar();
    const depois = Date.now();

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("X-Request-Id")).toBeTruthy();
    const token = corpo.data!.token;
    expect(token).toMatch(/^dsk_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$/);

    const gravado = db.tokens.get(`${ORG_A}:${INSTALACAO}`)!;
    expect(gravado.hashHex).toBe(createHash("sha256").update(token).digest("hex"));
    expect(gravado.hashHex).not.toBe(HASH_ANTIGO);
    expect(gravado.prefix).toBe(token.slice(0, 12));
    expect(gravado.scopes).toEqual(["mcp:read", "role:viewer", `actor:module:${SLUG}`]);

    const expira = new Date(corpo.data!.expires_at).getTime();
    expect(expira).toBeGreaterThanOrEqual(antes + 60 * 60 * 1000);
    expect(expira).toBeLessThanOrEqual(depois + 60 * 60 * 1000);
    expect(gravado.expires_at).toBe(corpo.data!.expires_at);

    // A rotação foi pedida para o par certo, com o hash como bytea e nunca o texto.
    expect(db.rpcs).toHaveLength(1);
    expect(db.rpcs[0]!.args).toMatchObject({ p_organization: ORG_A, p_installation: INSTALACAO });
    expect(String(db.rpcs[0]!.args.p_hash)).toBe(`\\x${gravado.hashHex}`);
  });

  it("audita extension.token_issued na organização do par, com instalação e slug, sem token nem hash", async () => {
    const { db, corpo } = await buscar();
    expect(mocks.audit).toHaveBeenCalledTimes(1);
    expect(mocks.audit.mock.calls[0]![0]).toMatchObject({
      action: "extension.token_issued",
      organizationId: ORG_A,
      resourceType: "extension_installation",
      resourceId: INSTALACAO,
      metadata: { installation_id: INSTALACAO, module: SLUG },
    });
    expect(mocks.audit.mock.calls[0]![0].actorUserId).toBeUndefined();

    const token = corpo.data!.token;
    const sai = tudoQueFoiGravado(db);
    const hash = hashDoPar(db);
    expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain(token);
    expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain(hash);
    // O token em claro não vai a nenhuma gravação, RPC, log nem audit.
    expect(sai).not.toContain(token);
    expect(sai).not.toContain(token.slice(13));
    // E o segredo da instalação também não.
    expect(sai).not.toContain(SEGREDO);
  });

  it("duas buscas com nonces diferentes: cada uma troca o hash e a última vale", async () => {
    const { rota, seg } = await carregar(CHAVE);
    const db = banco({}, (s) => seg.cifrarSegredo(s));
    mocks.admin = db;

    const a = (await (await rota.POST(montar(seg))).json()) as Corpo;
    const hashA = hashDoPar(db);
    const b = (await (await rota.POST(montar(seg))).json()) as Corpo;
    const hashB = hashDoPar(db);

    expect(a.data!.token).not.toBe(b.data!.token);
    expect(hashA).toBe(createHash("sha256").update(a.data!.token).digest("hex"));
    expect(hashB).toBe(createHash("sha256").update(b.data!.token).digest("hex"));
    expect(hashB).not.toBe(hashA);
    // Só uma linha viva por par: a vaga foi reaproveitada, não duplicada.
    expect([...db.tokens.keys()]).toEqual([`${ORG_A}:${INSTALACAO}`]);
  });

  it("o rate limit usa um balde por IP+instalação e outro só por instalação", async () => {
    await buscar();
    const baldes = mocks.rate.mock.calls.map((c) => [c[0], c[1], c[2]]);
    expect(baldes).toEqual([
      [`mod-token:ip:203.0.113.7:${INSTALACAO}`, 20, 60],
      [`mod-token:inst:${INSTALACAO}`, 60, 60],
    ]);
  });
});

describe("POST /api/v1/extensions/token — repetição e relógio", () => {
  it("nonce repetido com carimbo válido: 401 genérico, e o hash fica no que a primeira busca gravou", async () => {
    const { rota, seg } = await carregar(CHAVE);
    const db = banco({}, (s) => seg.cifrarSegredo(s));
    mocks.admin = db;
    const nonce = novoNonce();

    const primeira = await rota.POST(montar(seg, { nonce }));
    expect(primeira.status).toBe(200);
    const hashDepois = hashDoPar(db);

    const segunda = await rota.POST(montar(seg, { nonce }));
    const texto = await segunda.text();
    const ref = await recusaDeReferencia();
    expect(segunda.status).toBe(401);
    expect(texto).toBe(ref.texto);
    expect(hashDoPar(db)).toBe(hashDepois);
    expect(db.rpcs).toHaveLength(1);
  });

  it("o mesmo nonce em OUTRA instalação não é repetição", async () => {
    const { rota, seg } = await carregar(CHAVE);
    const db = banco(
      { noncesPreexistentes: [{ installation_id: OUTRA_INSTALACAO, nonce: "nonce-de-outra-instalacao", seen_at: new Date().toISOString() }] },
      (s) => seg.cifrarSegredo(s),
    );
    mocks.admin = db;
    const res = await rota.POST(montar(seg, { nonce: "nonce-de-outra-instalacao" }));
    expect(res.status).toBe(200);
  });

  it("apaga os nonces desta instalação com mais de 10 min e preserva os recentes e os de outra instalação", async () => {
    const velho = new Date(Date.now() - 11 * 60 * 1000).toISOString();
    const recente = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    const { db } = await buscar({
      noncesPreexistentes: [
        { installation_id: INSTALACAO, nonce: "velho-desta-instalacao", seen_at: velho },
        { installation_id: INSTALACAO, nonce: "recente-desta-instalacao", seen_at: recente },
        { installation_id: OUTRA_INSTALACAO, nonce: "velho-de-outra-instalacao", seen_at: velho },
      ],
    });
    const restantes = db.nonces.map((n) => n.nonce);
    expect(restantes).not.toContain("velho-desta-instalacao");
    expect(restantes).toContain("recente-desta-instalacao");
    expect(restantes).toContain("velho-de-outra-instalacao");
  });

  it.each([
    ["velho demais (5 min + 1 ms)", -(5 * 60 * 1000 + 1)],
    ["adiantado demais (5 min + 1 ms)", 5 * 60 * 1000 + 1],
    ["muito velho (1 h)", -60 * 60 * 1000],
    ["muito futuro (1 dia)", 24 * 60 * 60 * 1000],
  ])("carimbo %s: 401 genérico e o hash não muda", async (_nome, delta) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-05T12:00:00.000Z"));
    const agora = Date.now();
    const { res, texto, db } = await buscar({}, { timestamp: String(agora + delta) });
    vi.useRealTimers();
    const ref = await recusaDeReferencia();
    expect(res.status).toBe(401);
    expect(texto).toBe(ref.texto);
    expect(hashDoPar(db)).toBe(HASH_ANTIGO);
    expect(db.rpcs).toEqual([]);
  });

  it.each([
    ["exatamente 5 min no passado", -(5 * 60 * 1000)],
    ["exatamente 5 min no futuro", 5 * 60 * 1000],
  ])("carimbo %s: a borda é inclusiva e passa", async (_nome, delta) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-05T12:00:00.000Z"));
    const agora = Date.now();
    const { res } = await buscar({}, { timestamp: String(agora + delta) });
    vi.useRealTimers();
    expect(res.status).toBe(200);
  });
});

describe("POST /api/v1/extensions/token — recusas indistinguíveis", () => {
  it("a recusa de referência é 401 com a mensagem genérica", async () => {
    const ref = await recusaDeReferencia();
    expect(ref.status).toBe(401);
    expect(ref.corpo.error?.message).toBe(MENSAGEM_GENERICA);
    expect(ref.corpo.data).toBeUndefined();
  });

  const casos: Array<[string, Cenario, Pedido | ((seg: Modulo) => Pedido)]> = [
    ["instalação inexistente", { semInstalacao: true, semSegredo: true }, {}],
    ["instalação sem segredo", { semSegredo: true }, {}],
    ["instalação desligada", { instalacaoDesligada: true }, {}],
    ["instalação removida", { instalacaoRemovida: true }, {}],
    ["ativação desativada", { ativacaoDesativada: true }, {}],
    ["organização sem ativação", { semAtivacao: true }, {}],
    ["organização que nunca ativou (outra org, assinatura correta)", {}, { organization: ORG_B }],
    [
      "assinatura de outra organização (texto assinado com a org A, cabeçalho da B)",
      {},
      { organization: ORG_B, organizacaoAssinada: ORG_A },
    ],
    ["assinatura feita com outro segredo", {}, { segredoDoModulo: "outro-segredo" }],
    [
      "assinatura com o segredo antigo depois de girar",
      { segredoGuardado: "segredo-novo-depois-de-girar" },
      { segredoDoModulo: SEGREDO },
    ],
    ["instalação de outro módulo (não é a guardada)", {}, { installation: OUTRA_INSTALACAO }],
    ["assinatura com tamanho errado", {}, { assinatura: "abc" }],
    ["assinatura não-hex", {}, { assinatura: "z".repeat(64) }],
    ["cabeçalho de assinatura ausente", {}, { omitir: ["X-Module-Signature"] }],
    ["cabeçalho de instalação ausente", {}, { omitir: ["X-Module-Installation"] }],
    ["cabeçalho de organização ausente", {}, { omitir: ["X-Module-Organization"] }],
    ["cabeçalho de carimbo ausente", {}, { omitir: ["X-Module-Timestamp"] }],
    ["cabeçalho de nonce ausente", {}, { omitir: ["X-Module-Nonce"] }],
    ["carimbo não numérico", {}, { timestamp: "ontem" }],
    ["carimbo com sinal ou ponto", {}, { timestamp: "1.7e12" }],
    ["instalação que não é uuid", {}, { installation: "nao-e-uuid" }],
    ["organização que não é uuid", {}, { organization: "nao-e-uuid" }],
    ["nonce curto demais (15)", {}, { nonce: "a".repeat(15) }],
    ["nonce longo demais (65)", {}, { nonce: "a".repeat(65) }],
    ["nonce com ponto", {}, { nonce: "abcdefgh.ijklmnopqrs" }],
    ["nonce com espaço", {}, { nonce: "abcdefgh ijklmnopqrs" }],
  ];

  it.each(casos)("%s: mesmo status e mesmo corpo da assinatura errada, e o hash não muda", async (_nome, cenario, pedido) => {
    const ref = await recusaDeReferencia();
    const { res, texto, db } = await buscar(cenario, pedido);
    expect(res.status).toBe(ref.status);
    expect(texto).toBe(ref.texto);
    expect(hashDoPar(db)).toBe(HASH_ANTIGO);
    expect(hashDoPar(db, ORG_A)).toBe(HASH_ANTIGO);
    expect(db.tokens.get(`${ORG_B}:${INSTALACAO}`)).toBeUndefined();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("recusa antes de gravar: assinatura inválida não grava nonce", async () => {
    const { db } = await buscar({}, { assinatura: "0".repeat(64) });
    expect(db.nonces).toEqual([]);
    expect(db.rpcs).toEqual([]);
  });

  it("a recusa por ativação desativada passa pelo banco (PT409) e não grava token novo", async () => {
    const { db } = await buscar({ ativacaoDesativada: true });
    expect(db.rpcs).toHaveLength(1);
    expect(hashDoPar(db)).toBe(HASH_ANTIGO);
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("o motivo real vai ao log, sem segredo, assinatura nem token", async () => {
    const { db } = await buscar({}, { assinatura: "0".repeat(64) });
    expect(mocks.warn).toHaveBeenCalled();
    const log = JSON.stringify(mocks.warn.mock.calls);
    expect(log).toContain("assinatura_invalida");
    expect(log).not.toContain(SEGREDO);
    expect(log).not.toContain("0".repeat(64));
    expect(tudoQueFoiGravado(db)).not.toContain(SEGREDO);
  });
});

describe("POST /api/v1/extensions/token — rate limit e falhas nossas", () => {
  it("estourou o balde por IP+instalação: 429 com Retry-After, sem tocar o banco", async () => {
    mocks.rate.mockImplementation(async (balde: string, limite: number, janela: number) => ({
      allowed: !balde.startsWith("mod-token:ip:"),
      count: 99,
      limit: limite,
      window_sec: janela,
    }));
    const { res, db, corpo } = await buscar();
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(corpo.error?.code).toBe("rate_limited");
    expect(db.rpcs).toEqual([]);
    expect(db.gravacoes).toEqual([]);
    expect(hashDoPar(db)).toBe(HASH_ANTIGO);
  });

  it("estourou o balde por instalação: 429", async () => {
    mocks.rate.mockImplementation(async (balde: string, limite: number, janela: number) => ({
      allowed: !balde.startsWith("mod-token:inst:"),
      count: 99,
      limit: limite,
      window_sec: janela,
    }));
    const { res, db } = await buscar();
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(db.rpcs).toEqual([]);
  });

  it("sem IP identificável só o balde da instalação conta", async () => {
    await buscar({}, { ip: null });
    expect(mocks.rate.mock.calls.map((c) => c[0])).toEqual([`mod-token:inst:${INSTALACAO}`]);
  });

  it("o formato é conferido antes do rate limit (lixo não gasta balde)", async () => {
    await buscar({}, { omitir: ["X-Module-Nonce"] });
    expect(mocks.rate).not.toHaveBeenCalled();
  });

  it.each([
    ["leitura do segredo", { erroNoSegredo: true }],
    ["gravação do nonce", { erroNoNonce: true }],
    ["rotação", { erroNaRotacao: true }],
  ] as Array<[string, Cenario]>)("falha do banco na %s: 503, sem token e sem hash trocado", async (_nome, cenario) => {
    const { res, db, corpo } = await buscar(cenario);
    expect(res.status).toBe(503);
    expect(corpo.data).toBeUndefined();
    expect(hashDoPar(db)).toBe(HASH_ANTIGO);
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("sem chave de cifra no servidor: 503 (falha nossa), nunca a recusa genérica", async () => {
    const { seg } = await carregar(CHAVE);
    // O segredo é cifrado enquanto a chave existe; depois a chave some do servidor.
    const cifrado = seg.cifrarSegredo(SEGREDO);
    const db = banco({}, () => cifrado);
    mocks.admin = db;
    const req = montar(seg);
    const semChave = await carregar("");
    const res = await semChave.rota.POST(req);
    expect(res.status).toBe(503);
    expect(hashDoPar(db)).toBe(HASH_ANTIGO);
    expect(mocks.audit).not.toHaveBeenCalled();
  });
});

describe("POST /api/v1/extensions/token — porta no proxy", () => {
  it("a rota é pública só no caminho exato", async () => {
    const { isPublicPath } = await import("@/lib/auth/public-paths");
    expect(isPublicPath("/api/v1/extensions/token")).toBe(true);
    expect(isPublicPath("/api/v1/extensions/token/x")).toBe(false);
    expect(isPublicPath("/api/v1/extensions/tokens")).toBe(false);
  });

  it("o corpo da requisição é ignorado", async () => {
    const { rota, seg } = await carregar(CHAVE);
    const db = banco({}, (s) => seg.cifrarSegredo(s));
    mocks.admin = db;
    const base = montar(seg);
    const comCorpo = new Request(base.url, {
      method: "POST",
      headers: base.headers,
      body: JSON.stringify({ organization_id: ORG_B, token: "dsk_00000000_qualquer" }),
    });
    const res = await rota.POST(comCorpo);
    expect(res.status).toBe(200);
    expect(db.tokens.get(`${ORG_B}:${INSTALACAO}`)).toBeUndefined();
  });
});
