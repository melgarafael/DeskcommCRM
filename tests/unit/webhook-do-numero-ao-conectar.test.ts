/**
 * O webhook do NÚMERO, registrado pela instalação ao conectar (issue #850, fatia F1).
 *
 * O defeito que este arquivo tranca: conectar o canal oficial deixava o operador com
 * um canal que ENVIA e não RECEBE — a Meta só entrega no endereço que estiver no
 * painel dela, e colar essa URL era trabalho manual, por número, que quem não
 * programa não sabe que existe. Aqui o handler e o caso de uso rodam DE VERDADE
 * (dublê só no banco, no `fetch` e nas guardas), e cada caso mede um desfecho:
 *
 *   1. o módulo fala com a Meta na ORDEM certa (inscrição na WABA, depois o número)
 *      e diz QUAL etapa falhou quando falha;
 *   2. o desfecho é GRAVADO na sessão, para a tela mostrar "webhook pendente" com
 *      motivo em vez de "conectado" e silêncio;
 *   3. falhar o registro NÃO desfaz a conexão — o canal continua enviando;
 *   4. o registro acontece DEPOIS da gravação da sessão (o GET de verificação da Meta
 *      chega no instante do registro e procura a sessão pelo token do caminho);
 *   5. par trocado (número de uma WABA, id de outra) é recusado ANTES de gravar.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { createAdminClient } from "@/lib/supabase/admin";
import { CHANNEL_PROVIDER_META } from "@/lib/channels/capabilities";
import { appDaMeta } from "@/lib/channels/meta/app";
import { requireRole } from "@/lib/auth/require-role";
import { validateMetaCredentials } from "@/lib/channels/meta/validate-credentials";
import { encryptWebhookSecret, decryptWebhookSecret } from "@/lib/webhooks/secrets";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/webhooks/secrets", () => ({
  encryptWebhookSecret: vi.fn(),
  decryptWebhookSecret: vi.fn(),
}));
vi.mock("@/lib/channels/meta/validate-credentials", () => ({ validateMetaCredentials: vi.fn() }));
vi.mock("@/lib/channels/meta/app", () => ({ appDaMeta: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { POST as conectar } from "@/app/api/v1/channels/official/route";
import { POST as registrarDeNovo } from "@/app/api/v1/channels/official/webhook/route";
import { registrarWebhookDaSessao } from "@/lib/channels/meta/webhook-da-sessao";
import { registrarWebhookDoNumero } from "@/lib/channels/meta/webhook-override";

const ORG = "org-1";
const USER = "user-1";
const SESSAO = "sessao-1";
const NUMERO = "111222333444555";
const WABA = "999888777666555";
const PATH_TOKEN = "tok-do-caminho";
const BASE = "https://crm.exemplo.com";
const VERIFY = "verify-token-do-banco";
const VERSION = "v23.0";

type Linha = Record<string, unknown>;

/** Registro do que o dublê de banco viu — é por aqui que a ORDEM é medida. */
interface Registro {
  linhas: Linha[];
  escritas: Array<{ tipo: string; table: string; patch: Linha; recusada: boolean }>;
  /** O cliente falso — o caso de uso recebe ele como `admin`. */
  client: unknown;
  /** Chamadas ao `fetch` (a Graph API), na ordem em que saíram. */
  meta: Array<{ url: string; metodo: string; corpo: Linha }>;
}

function sessao(extra: Linha = {}): Linha {
  return {
    id: SESSAO,
    organization_id: ORG,
    provider: CHANNEL_PROVIDER_META,
    meta_phone_number_id: NUMERO,
    meta_waba_id: WABA,
    meta_token_encrypted: "cifrado",
    webhook_path_token: PATH_TOKEN,
    archived_at: null,
    ...extra,
  };
}

function makeDb(opts: { sessions?: Linha[]; recusaColunaDoDesfecho?: boolean } = {}): Registro {
  const linhas: Linha[] = opts.sessions ?? [sessao()];
  const registro: Registro = { linhas, escritas: [], meta: [], client: null };

  class Q implements PromiseLike<unknown> {
    private filtros: Array<[string, unknown]> = [];
    private colunas = "";
    private unica = false;

    constructor(
      private readonly table: string,
      private readonly op: "select" | "update" | "insert",
      private readonly patch: Linha | null = null,
    ) {}

    select(cols?: string): this {
      this.colunas = cols ?? "";
      return this;
    }
    eq(col: string, val: unknown): this {
      this.filtros.push([col, val]);
      return this;
    }
    is(col: string, val: unknown): this {
      this.filtros.push([col, val]);
      return this;
    }
    maybeSingle(): this {
      this.unica = true;
      return this;
    }

    /** O banco SEM a migration 0256 recusa qualquer menção às colunas do desfecho. */
    private semColuna(): { code: string; message: string } | null {
      if (opts.recusaColunaDoDesfecho !== true) return null;
      const citada =
        this.colunas.includes("meta_webhook_override") ||
        Object.keys(this.patch ?? {}).some((c) => c.startsWith("meta_webhook_override"));
      return citada
        ? {
            code: "PGRST204",
            message:
              "Could not find the 'meta_webhook_override_uri' column of 'channel_sessions' in the schema cache",
          }
        : null;
    }

    private casam(): Linha[] {
      return linhas.filter((l) =>
        this.filtros.every(([c, v]) => (l[c] ?? null) === v),
      );
    }

    private executar(): { data: unknown; error: unknown } {
      const ausente = this.semColuna();

      if (this.op === "select") {
        if (ausente) return { data: null, error: ausente };
        const achadas = this.casam();
        return { data: this.unica ? (achadas[0] ?? null) : achadas, error: null };
      }

      registro.escritas.push({
        tipo: this.op,
        table: this.table,
        patch: this.patch ?? {},
        recusada: ausente !== null,
      });
      if (ausente) return { data: null, error: ausente };

      if (this.op === "insert") {
        const nova = { id: SESSAO, webhook_path_token: PATH_TOKEN, ...(this.patch ?? {}) };
        linhas.push(nova);
        return { data: this.colunas ? nova : null, error: null };
      }
      for (const l of this.casam()) Object.assign(l, this.patch);
      return { data: this.colunas ? (this.casam()[0] ?? null) : null, error: null };
    }

    then<R1 = unknown, R2 = never>(
      onOk?: ((v: { data: unknown; error: unknown }) => R1 | PromiseLike<R1>) | null,
      onErr?: ((r: unknown) => R2 | PromiseLike<R2>) | null,
    ): PromiseLike<R1 | R2> {
      return Promise.resolve(this.executar()).then(onOk, onErr);
    }
  }

  const client = {
    from: (table: string) => ({
      select: (cols?: string) => new Q(table, "select").select(cols),
      update: (patch: Linha) => new Q(table, "update", patch),
      insert: (patch: Linha) => new Q(table, "insert", patch),
    }),
  };
  vi.mocked(createAdminClient).mockReturnValue(client as never);
  registro.client = client;
  (globalThis as unknown as { __registro: Registro }).__registro = registro;
  return registro;
}

/**
 * `fetch` dublê que responde por URL, e guarda a ORDEM.
 *
 * O `meta[0]` é a inscrição na WABA e o `meta[1]` é o número — é isso que os testes
 * de ordem leem. Resposta 200 com corpo vazio é o que a Meta devolve nos dois POSTs.
 */
function stubMeta(respostas: {
  inscricao?: { status?: number; body?: Linha } | "throw";
  numero?: { status?: number; body?: Linha } | "throw";
  waba?: { status?: number; body?: Linha } | "throw";
}): Registro["meta"] {
  const registro = (globalThis as unknown as { __registro: Registro }).__registro;
  const chamadas: Registro["meta"] = [];
  if (registro) registro.meta = chamadas;

  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const corpo = init?.body ? (JSON.parse(String(init.body)) as Linha) : {};
      chamadas.push({ url: String(url), metodo: String(init?.method ?? "GET"), corpo });
      const alvo = String(url);
      const resposta = alvo.includes("/subscribed_apps")
        ? respostas.inscricao
        : alvo.includes("/phone_numbers")
          ? respostas.waba
          : respostas.numero;
      if (resposta === "throw") throw new Error("getaddrinfo ENOTFOUND graph.facebook.com");
      const { status = 200, body = {} } = resposta ?? {};
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
      } as unknown as Response;
    }),
  );
  return chamadas;
}

function authOk(): void {
  const user = {
    id: USER,
    email: "a@example.com",
    full_name: null,
    avatar_url: null,
    is_platform_admin: false,
    idioma: "pt-BR" as const,
    organizations: [{ organization_id: ORG, organization_name: "Org", role: "admin" }],
  };
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: user as never,
    org: { orgId: ORG, name: "Org", role: "admin" },
  } as never);
}

const erroDaMeta = (detalhe: string) => ({
  error: { message: "Invalid parameter", error_data: { details: detalhe } },
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  process.env.META_GRAPH_VERSION = VERSION;
  vi.mocked(encryptWebhookSecret).mockResolvedValue("cifrado" as never);
  vi.mocked(decryptWebhookSecret).mockResolvedValue("token-da-meta" as never);
  vi.mocked(appDaMeta).mockResolvedValue({ appSecret: "segredo", verifyToken: VERIFY } as never);
  vi.mocked(validateMetaCredentials).mockResolvedValue({
    ok: true,
    displayPhoneNumber: "5541999999999",
    verifiedName: "Canal de teste",
    qualityRating: "GREEN",
  } as never);
});

describe("registrarWebhookDoNumero — a conversa com a Meta, na ordem certa", () => {
  it("inscreve o app na WABA e DEPOIS aponta o webhook do número, com o verify token", async () => {
    const chamadas = stubMeta({});

    const desfecho = await registrarWebhookDoNumero({
      phoneNumberId: NUMERO,
      wabaId: WABA,
      token: "token-da-meta",
      callbackUrl: `${BASE}/api/v1/webhooks/meta/${PATH_TOKEN}`,
      verifyToken: VERIFY,
    });

    expect(desfecho).toEqual({ ok: true, url: `${BASE}/api/v1/webhooks/meta/${PATH_TOKEN}` });
    // A ordem é a regra, não detalhe: sem a inscrição na WABA a Meta não entrega nada,
    // e o override sozinho daria a impressão de canal pronto.
    expect(chamadas).toHaveLength(2);
    expect(chamadas[0]!.url).toBe(`https://graph.facebook.com/${VERSION}/${WABA}/subscribed_apps`);
    expect(chamadas[1]!.url).toBe(`https://graph.facebook.com/${VERSION}/${NUMERO}`);
    expect(chamadas[1]!.corpo).toEqual({
      webhook_configuration: {
        override_callback_uri: `${BASE}/api/v1/webhooks/meta/${PATH_TOKEN}`,
        verify_token: VERIFY,
      },
    });
  });

  it("falhando a inscrição na WABA, NÃO vai ao número e diz qual etapa falhou", async () => {
    const chamadas = stubMeta({
      inscricao: { status: 400, body: erroDaMeta("(#200) Permissions error") },
    });

    const desfecho = await registrarWebhookDoNumero({
      phoneNumberId: NUMERO,
      wabaId: WABA,
      token: "token-da-meta",
      callbackUrl: `${BASE}/api/v1/webhooks/meta/${PATH_TOKEN}`,
      verifyToken: VERIFY,
    });

    expect(desfecho).toEqual({
      ok: false,
      etapa: "inscricao_na_waba",
      motivo: "(#200) Permissions error",
    });
    expect(chamadas).toHaveLength(1);
  });

  it("recusando o override do número, o motivo é o DETALHE da Meta (não o 'invalid parameter')", async () => {
    stubMeta({
      numero: { status: 400, body: erroDaMeta("(#100) Param webhook_configuration must be an object") },
    });

    const desfecho = await registrarWebhookDoNumero({
      phoneNumberId: NUMERO,
      wabaId: WABA,
      token: "token-da-meta",
      callbackUrl: `${BASE}/api/v1/webhooks/meta/${PATH_TOKEN}`,
      verifyToken: VERIFY,
    });

    expect(desfecho.ok).toBe(false);
    expect(desfecho).toMatchObject({ etapa: "configuracao_do_numero" });
    expect((desfecho as { ok: false; motivo: string }).motivo).toContain("must be an object");
  });

  it("rede caída vira motivo de rede, e não exceção", async () => {
    stubMeta({ inscricao: "throw" });

    const desfecho = await registrarWebhookDoNumero({
      phoneNumberId: NUMERO,
      wabaId: WABA,
      token: "token-da-meta",
      callbackUrl: `${BASE}/api/v1/webhooks/meta/${PATH_TOKEN}`,
      verifyToken: VERIFY,
    });

    expect(desfecho.ok).toBe(false);
    expect((desfecho as { ok: false; motivo: string }).motivo).toContain("rede indisponível");
  });
});

describe("registrarWebhookDaSessao — o desfecho gravado na sessão", () => {
  it("guarda URL, motivo e data na linha da sessão", async () => {
    const registro = makeDb();
    stubMeta({});

    const desfecho = await registrarWebhookDaSessao({
      admin: registro.client as never,
      channelSessionId: SESSAO,
      phoneNumberId: NUMERO,
      wabaId: WABA,
      tokenCifrado: "cifrado",
      webhookPathToken: PATH_TOKEN,
      base: BASE,
    });

    expect(desfecho).toMatchObject({
      registrado: true,
      url: `${BASE}/api/v1/webhooks/meta/${PATH_TOKEN}`,
      erro: null,
    });
    const gravado = registro.escritas.at(-1)?.patch ?? {};
    expect(gravado.meta_webhook_override_uri).toBe(`${BASE}/api/v1/webhooks/meta/${PATH_TOKEN}`);
    expect(gravado.meta_webhook_override_erro).toBeNull();
    expect(gravado.meta_webhook_override_em).toBe(desfecho.em);
  });

  it("sem verify token na instalação, NÃO chama a Meta e explica o que falta", async () => {
    const registro = makeDb();
    const chamadas = stubMeta({});
    vi.mocked(appDaMeta).mockResolvedValue({ appSecret: "segredo", verifyToken: null } as never);

    const desfecho = await registrarWebhookDaSessao({
      admin: registro.client as never,
      channelSessionId: SESSAO,
      phoneNumberId: NUMERO,
      wabaId: WABA,
      tokenCifrado: "cifrado",
      webhookPathToken: PATH_TOKEN,
      base: BASE,
    });

    expect(chamadas).toHaveLength(0);
    expect(desfecho.registrado).toBe(false);
    expect(desfecho.erro).toContain("verify token");
  });

  it("credencial ilegível não vira 'a Meta recusou' — o operador troca a credencial", async () => {
    const registro = makeDb();
    const chamadas = stubMeta({});
    vi.mocked(decryptWebhookSecret).mockResolvedValue(null as never);

    const desfecho = await registrarWebhookDaSessao({
      admin: registro.client as never,
      channelSessionId: SESSAO,
      phoneNumberId: NUMERO,
      wabaId: WABA,
      tokenCifrado: "cifrado",
      webhookPathToken: PATH_TOKEN,
      base: BASE,
    });

    expect(chamadas).toHaveLength(0);
    expect(desfecho.erro).toContain("decifrada");
  });

  it("banco SEM a migration 0256: não lança e ainda devolve o desfecho para a resposta", async () => {
    const registro = makeDb({ recusaColunaDoDesfecho: true });
    stubMeta({});

    const desfecho = await registrarWebhookDaSessao({
      admin: registro.client as never,
      channelSessionId: SESSAO,
      phoneNumberId: NUMERO,
      wabaId: WABA,
      tokenCifrado: "cifrado",
      webhookPathToken: PATH_TOKEN,
      base: BASE,
    });

    // A doutrina do repo: código NOVO sobre banco sem a migration não pode quebrar o
    // que já funcionava. O registro ACONTECEU (a Meta foi chamada); o que não pôde
    // ser feito foi guardar o estado — e a rota devolve o estado na resposta.
    expect(desfecho.registrado).toBe(true);
    expect(desfecho.url).toBe(`${BASE}/api/v1/webhooks/meta/${PATH_TOKEN}`);
  });
});

describe("validateMetaCredentials com wabaId — o par número/WABA (fonte real)", () => {
  /** A validação de verdade, sem o dublê do módulo: é ela que ganhou a segunda pergunta. */
  const real = async () =>
    (
      await vi.importActual<typeof import("@/lib/channels/meta/validate-credentials")>(
        "@/lib/channels/meta/validate-credentials",
      )
    ).validateMetaCredentials;

  const credencialOk = { display_phone_number: "5541999999999", verified_name: "Canal" };

  it("aceita quando a Meta lista o número na WABA informada", async () => {
    stubMeta({ numero: { status: 200, body: credencialOk }, waba: { body: { data: [{ id: NUMERO }] } } });

    const desfecho = await (await real())({
      phoneNumberId: NUMERO,
      token: "x".repeat(30),
      wabaId: WABA,
    });

    expect(desfecho.ok).toBe(true);
  });

  it("recusa o par trocado: o número não está na lista daquela WABA", async () => {
    // A credencial RESPONDE (é a mesma que envia) — o que não fecha é a conta: o
    // número pertence a outra WABA, e a Meta entrega o webhook lá, não aqui.
    stubMeta({
      numero: { status: 200, body: credencialOk },
      waba: { body: { data: [{ id: "outro-numero" }] } },
    });

    const desfecho = await (await real())({
      phoneNumberId: NUMERO,
      token: "x".repeat(30),
      wabaId: WABA,
    });

    expect(desfecho.ok).toBe(false);
    expect((desfecho as { ok: false; motivo: string }).motivo).toContain("não pertence à WABA");
  });

  it("lista vazia da WABA aponta a CREDENCIAL, não o operador", async () => {
    // Credencial sem permissão na WABA devolve 200 com `data: []`. Dizer "não
    // pertence" seria mandar o operador conferir o que está certo.
    stubMeta({ numero: { status: 200, body: credencialOk }, waba: { body: { data: [] } } });

    const desfecho = await (await real())({
      phoneNumberId: NUMERO,
      token: "x".repeat(30),
      wabaId: WABA,
    });

    expect(desfecho.ok).toBe(false);
    expect((desfecho as { ok: false; motivo: string }).motivo).toContain("não devolveu nenhum número");
  });

  it("sem wabaId não há segunda chamada — quem só quer saber se a credencial presta não paga por ela", async () => {
    const chamadas = stubMeta({ numero: { status: 200, body: credencialOk } });

    const desfecho = await (await real())({
      phoneNumberId: NUMERO,
      token: "x".repeat(30),
    });

    expect(desfecho.ok).toBe(true);
    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]!.url).toContain(`/${NUMERO}?fields=`);
  });
});

describe("POST /api/v1/channels/official — conectar registra o webhook", () => {
  const conectarReq = () =>
    new NextRequest("https://crm.exemplo.com/api/v1/channels/official", {
      method: "POST",
      headers: { origin: BASE, "content-type": "application/json" },
      body: JSON.stringify({ phone_number_id: NUMERO, waba_id: WABA, token: "x".repeat(30) }),
    });

  it("registra DEPOIS de gravar a sessão e devolve o estado do registro", async () => {
    const registro = makeDb({ sessions: [] });
    stubMeta({});
    authOk();

    const res = await conectar(conectarReq());
    const corpo = (await res.json()) as { data: Record<string, unknown> };

    expect(res.status).toBe(200);
    expect(corpo.data).toMatchObject({ connected: true });
    // O endereço é o da SESSÃO: o domínio é decisão de instalação
    // (`NEXT_PUBLIC_APP_URL`, com o `origin` como reserva) e o que esta fatia promete
    // é que a URL que a Meta recebeu é a MESMA que a tela mostra — divergir mandaria o
    // operador conferir um valor que não é o que está valendo.
    const registroGravado = corpo.data.webhookRegistro as {
      registrado: boolean;
      url: string;
      erro: string | null;
    };
    expect(registroGravado.registrado).toBe(true);
    expect(registroGravado.erro).toBeNull();
    expect(registroGravado.url).toContain(`/api/v1/webhooks/meta/${PATH_TOKEN}`);
    expect(registro.meta[1]!.corpo).toEqual({
      webhook_configuration: {
        override_callback_uri: registroGravado.url,
        verify_token: VERIFY,
      },
    });
    // A ordem: a linha existe ANTES de a Meta ser chamada. O GET de verificação dela
    // chega no instante do registro e procura a sessão pelo token do caminho — se o
    // registro viesse primeiro, a Meta acharia 404 e marcaria o webhook como inválido.
    expect(registro.escritas.some((e) => e.tipo === "insert")).toBe(true);
    expect(registro.meta.length).toBeGreaterThan(0);
  });

  it("a Meta recusar o registro NÃO desfaz a conexão — o canal segue enviando", async () => {
    makeDb({ sessions: [] });
    stubMeta({ numero: { status: 400, body: erroDaMeta("(#100) Invalid callback URL") } });
    authOk();

    const res = await conectar(conectarReq());
    const corpo = (await res.json()) as { data: Record<string, unknown> };

    expect(res.status).toBe(200);
    expect(corpo.data.connected).toBe(true);
    expect(corpo.data.webhookRegistro).toMatchObject({ registrado: false, url: null });
    expect(String((corpo.data.webhookRegistro as { erro: string }).erro)).toContain("Invalid callback URL");
  });

  it("par trocado (número que não é da WABA informada) é recusado ANTES de gravar", async () => {
    const registro = makeDb({ sessions: [] });
    authOk();
    vi.mocked(validateMetaCredentials).mockResolvedValue({
      ok: false,
      motivo: `o número ${NUMERO} não pertence à WABA ${WABA}`,
    } as never);

    const res = await conectar(conectarReq());
    const corpo = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(422);
    // `fail()` (lib/api/wrappers) aninha em `error`: o corpo é { error: { code, message } }.
    expect(String((corpo.error as { message: string }).message)).toContain("não pertence");
    // Nada gravado e nenhuma chamada de registro: o override aponta o webhook de um
    // número pelo id, e o id não carrega a WABA — registrar o par trocado seria
    // entregar mensagem de um canal que a instalação não controla.
    expect(registro.escritas).toHaveLength(0);
    expect(registro.meta).toHaveLength(0);
    expect(vi.mocked(validateMetaCredentials)).toHaveBeenCalledWith(
      expect.objectContaining({ wabaId: WABA }),
    );
  });
});

describe("POST /api/v1/channels/official/webhook — tentar de novo", () => {
  const req = () =>
    new NextRequest("https://crm.exemplo.com/api/v1/channels/official/webhook", {
      method: "POST",
      headers: { origin: BASE },
    });

  it("reaplica com a credencial JÁ guardada e devolve o desfecho de agora", async () => {
    const registro = makeDb();
    stubMeta({});
    authOk();

    const res = await registrarDeNovo(req());
    const corpo = (await res.json()) as { data: Record<string, unknown> };

    expect(res.status).toBe(200);
    const desfecho = corpo.data as { registrado: boolean; url: string; callbackUrl: string };
    expect(desfecho.registrado).toBe(true);
    expect(desfecho.url).toContain(`/api/v1/webhooks/meta/${PATH_TOKEN}`);
    expect(desfecho.callbackUrl).toBe(desfecho.url);
    // A credencial veio da SESSÃO (decifrada), não do corpo da requisição: pedir o
    // token de novo obrigaria o operador a ter à mão o que o CRM já guardou.
    expect(vi.mocked(decryptWebhookSecret)).toHaveBeenCalledWith(expect.anything(), "cifrado");
    expect(registro.meta[0]!.url).toContain(`/${WABA}/subscribed_apps`);
  });

  it("a Meta recusar de novo devolve 200 com o motivo — estado, não erro de requisição", async () => {
    makeDb();
    stubMeta({ inscricao: { status: 400, body: erroDaMeta("(#200) Permissions error") } });
    authOk();

    const res = await registrarDeNovo(req());
    const corpo = (await res.json()) as { data: Record<string, unknown> };

    // 4xx aqui faria o cliente tratar como falha e ESCONDER o motivo que a Meta deu —
    // o operador precisa ler "(#200) Permissions error" para ir ajustar a permissão.
    expect(res.status).toBe(200);
    expect(corpo.data.registrado).toBe(false);
    expect(String(corpo.data.erro)).toContain("Permissions error");
  });

  it("org sem canal oficial responde 422 e não chama a Meta", async () => {
    const registro = makeDb({ sessions: [] });
    const chamadas = stubMeta({});
    authOk();

    const res = await registrarDeNovo(req());

    expect(res.status).toBe(422);
    expect(chamadas).toHaveLength(0);
    expect(registro.meta).toHaveLength(0);
  });

  it("canal ARQUIVADO não é 'consertado': a URL dele já foi rotacionada", async () => {
    const chamadas = stubMeta({});
    makeDb({ sessions: [sessao({ archived_at: "2026-09-01T00:00:00.000Z" })] });
    authOk();

    const res = await registrarDeNovo(req());

    expect(res.status).toBe(422);
    expect(chamadas).toHaveLength(0);
  });
});
