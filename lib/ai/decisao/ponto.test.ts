/**
 * O SEAM DO PONTO — o que liga o System One ao resto do sistema.
 *
 * Três garantias, e todas são sobre NÃO quebrar o que já funciona:
 *
 *  1. sem credencial configurada, nada sai da máquina e ninguém espera timeout;
 *  2. o destino passa pela allowlist de egress (F4-03), com o host vindo da
 *     CONFIG — host fora dela falha fechado, como todo egress do runtime;
 *  3. o resultado nunca lança: quem chama recebe `{ ok: false, motivo }` e
 *     segue pelo caminho atual.
 *
 * O que este módulo NÃO faz, de propósito: decidir por conta própria se o
 * fornecedor deve ser usado. Isso é do call site, que conhece o seu fallback.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Dublês do banco e da decifragem, para `chaveDaOrganizacao` real ──────────
const banco = vi.hoisted(() => ({
  /** `organizations.settings` — o interruptor do Jev mora aqui. */
  settings: null as Record<string, unknown> | null,
  linha: null as Record<string, unknown> | null,
  erro: null as { name: string; message: string } | null,
  chamadas: [] as Array<[string, ...unknown[]]>,
}));
const decifragem = vi.hoisted(() => ({ falha: false }));
const avisos = vi.hoisted(() => [] as Array<[string, Record<string, unknown>]>);

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      banco.chamadas.push(["from", tabela]);
      const chain: Record<string, unknown> = {};
      for (const metodo of ["select", "eq", "not", "order", "limit"]) {
        chain[metodo] = (...args: unknown[]) => {
          banco.chamadas.push([metodo, ...args]);
          return chain;
        };
      }
      chain.maybeSingle = async () =>
        tabela === "organizations"
          ? { data: banco.settings === null ? null : { settings: banco.settings }, error: null }
          : { data: banco.linha, error: banco.erro };
      return chain;
    },
  }),
}));

vi.mock("@/lib/crypto/aes_gcm", () => ({
  byteaToBuffer: (v: unknown) => v,
  decryptKey: (c: { ciphertext: unknown }) => {
    if (decifragem.falha) throw Object.assign(new Error("apikey_segredo_que_nao_pode_vazar"), { name: "DecryptError" });
    return `decifrada:${String(c.ciphertext)}`;
  },
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    warn: (msg: string, ctx: Record<string, unknown>) => avisos.push([msg, ctx]),
    info: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  },
}));

import { chaveDaOrganizacao, decidirNoPonto } from "@/lib/ai/decisao/ponto";

/** Ligado COM aceite — o único estado em que a chave pode sair. */
const LIGADO = {
  jev: {
    ligado: true,
    modo: "observacao",
    aceite: { em: "2026-09-23T12:00:00.000Z", por: "22222222-2222-4222-8222-222222222222" },
  },
};

beforeEach(() => {
  banco.settings = LIGADO;
  banco.linha = null;
  banco.erro = null;
  banco.chamadas.length = 0;
  decifragem.falha = false;
  avisos.length = 0;
});

const PERGUNTAS = {
  clima: { tipo: "score", instrucao: "Qual o clima?", criterios: ["ruim", "neutro", "bom"] },
} as const;

const CORPO_OK = {
  model: "jev-1.13.0",
  answers: {
    clima: { type: "score", score: 2.0, legend: {}, probabilities: { "2": 1 }, confidence: 0.9 },
  },
  usage: { input_tokens: 100, output_tokens: 0 },
};

function ok(corpo: unknown): Response {
  return new Response(JSON.stringify(corpo), { status: 200, headers: { "content-type": "application/json" } });
}

describe("decidirNoPonto", () => {
  it("sem credencial, não sai byte e não espera timeout", async () => {
    const fetchImpl = vi.fn();
    const r = await decidirNoPonto(
      { ponto: "sentiment_classify", organizationId: "org-1", estado: "oi", perguntas: PERGUNTAS },
      { buscarChave: async () => null, fetchImpl },
    );

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.motivo).toBe("sem_credencial");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("com credencial, decide e devolve o uso para a telemetria", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok(CORPO_OK));
    const r = await decidirNoPonto(
      { ponto: "sentiment_classify", organizationId: "org-1", estado: "adorei!", perguntas: PERGUNTAS },
      { buscarChave: async () => "tsk_x", fetchImpl },
    );

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.respostas.clima?.tipo).toBe("score");
    expect(r.uso.tokensDeEntrada).toBe(100);
    const [, init] = fetchImpl.mock.calls[0]!;
    expect((init as RequestInit & { headers: Record<string, string> }).headers.Authorization).toBe("Bearer tsk_x");
  });

  it("a credencial é buscada POR ORGANIZAÇÃO — nunca uma chave global", async () => {
    const buscarChave = vi.fn().mockResolvedValue("tsk_x");
    await decidirNoPonto(
      { ponto: "sentiment_classify", organizationId: "org-42", estado: "x", perguntas: PERGUNTAS },
      { buscarChave, fetchImpl: vi.fn().mockResolvedValue(ok(CORPO_OK)) },
    );
    expect(buscarChave).toHaveBeenCalledWith("org-42");
  });

  it("destino fora da allowlist falha fechado, sem lançar", async () => {
    // O egress do runtime é fail-closed por desenho (F4-03). Aqui a allowlist é
    // forçada a um host que não é o do fornecedor: a chamada tem de ser barrada
    // ANTES de sair, e chegar a quem chamou como ausência de resposta — nunca
    // como exceção que derruba o turno.
    const fetchImpl = vi.fn();
    const r = await decidirNoPonto(
      { ponto: "sentiment_classify", organizationId: "org-1", estado: "x", perguntas: PERGUNTAS },
      { buscarChave: async () => "tsk_x", fetchImpl, hostsPermitidos: ["exemplo.invalido"] },
    );

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.motivo).toBe("provedor_indisponivel");
    expect(fetchImpl, "egress bloqueado não chega a fazer a requisição").not.toHaveBeenCalled();
  });

  it("falha do fornecedor não lança — o call site segue pelo caminho atual", async () => {
    const r = await decidirNoPonto(
      { ponto: "sentiment_classify", organizationId: "org-1", estado: "x", perguntas: PERGUNTAS },
      {
        buscarChave: async () => "tsk_x",
        fetchImpl: vi.fn().mockResolvedValue(new Response("{}", { status: 529 })),
      },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.motivo).toBe("provedor_sobrecarregado");
    expect(r.defeitoNosso).toBe(false);
  });
});

/**
 * O teto é UM prazo para a busca da chave e a chamada juntas. Antes ele armava
 * só em volta da chamada: com a leitura da chave lenta (o PostgREST degradado),
 * o turno esperava a leitura inteira — medido, 2,5 s de leitura davam 2,5 s de
 * turno com o roteador decidindo — e a leitura lenta nunca contava no disjuntor.
 */
describe("decidirNoPonto — o teto cobre a busca da chave", () => {
  it("chave que não volta dentro do teto: o Jev não respondeu a tempo, sem esperar a leitura", async () => {
    const fetchImpl = vi.fn();
    const inicio = Date.now();
    const r = await decidirNoPonto(
      { ponto: "sentiment_classify", organizationId: "org-1", estado: "x", perguntas: PERGUNTAS, tetoMs: 50 },
      { buscarChave: () => new Promise((resolver) => setTimeout(() => resolver("tsk_x"), 2_500)), fetchImpl },
    );
    expect(Date.now() - inicio).toBeLessThan(1_000);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    // Conta no disjuntor (`sem_credencial` não contaria), e nada saiu para a rede.
    expect(r.motivo).toBe("provedor_indisponivel");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("a chamada ganha só o que sobrou do prazo", async () => {
    const inicio = Date.now();
    const r = await decidirNoPonto(
      { ponto: "sentiment_classify", organizationId: "org-1", estado: "x", perguntas: PERGUNTAS, tetoMs: 300 },
      {
        buscarChave: () => new Promise((resolver) => setTimeout(() => resolver("tsk_x"), 200)),
        // O fornecedor que nunca responde: só o relógio o corta.
        fetchImpl: (_u, init) =>
          new Promise((_ok, falhar) => init?.signal?.addEventListener("abort", () => falhar(new Error("abortado")))),
      },
    );
    expect(Date.now() - inicio).toBeLessThan(600);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.motivo).toBe("provedor_indisponivel");
  });

  it("controle: chave rápida, fornecedor rápido — responde normalmente", async () => {
    const r = await decidirNoPonto(
      { ponto: "sentiment_classify", organizationId: "org-1", estado: "x", perguntas: PERGUNTAS, tetoMs: 300 },
      { buscarChave: async () => "tsk_x", fetchImpl: vi.fn().mockResolvedValue(ok(CORPO_OK)) },
    );
    expect(r.ok).toBe(true);
  });
});

describe("chaveDaOrganizacao — a chave do Jev daquela empresa, e só dela", () => {
  const ORG = "33333333-3333-4333-8333-333333333333";
  const PONTO_DO_CLIMA = "sentiment_classify";

  /**
   * A guarda por tarefa mora aqui, e não só no worker: um segundo chamador de
   * `decidirNoPonto` (o agent-engine, na onda 2.1) mandaria a mensagem com a
   * tarefa desligada.
   */
  describe("só com a tarefa daquele ponto rodando", () => {
    const CREDENCIAL = { api_key_encrypted: "cifra", api_key_iv: "iv", api_key_tag: "tag" };

    it("tarefa desligada: com o interruptor ligado, a chave não sai, e nem é lida", async () => {
      banco.settings = { jev: { ...LIGADO.jev, tarefas: { clima: { estado: "desligada" } } } };
      banco.linha = CREDENCIAL;
      const fetchImpl = vi.fn();
      const r = await decidirNoPonto(
        { ponto: PONTO_DO_CLIMA, organizationId: ORG, estado: "x", perguntas: PERGUNTAS },
        { fetchImpl },
      );
      expect(r.ok === false && r.motivo).toBe("sem_credencial");
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(banco.chamadas).not.toContainEqual(["from", "ai_provider_credentials"]);
    });

    it("ponto sem tarefa do Jev: nada sai, sem nem consultar o banco", async () => {
      banco.linha = CREDENCIAL;
      expect(await chaveDaOrganizacao(ORG, "stage_classifier")).toBeNull();
      expect(banco.chamadas).toEqual([]);
    });

    it("tarefa observando ou decidindo: a chave sai (controle)", async () => {
      for (const estado of ["observando", "decidindo"]) {
        banco.settings = { jev: { ...LIGADO.jev, tarefas: { clima: { estado } } } };
        banco.linha = CREDENCIAL;
        expect(await chaveDaOrganizacao(ORG, PONTO_DO_CLIMA)).toBe("decifrada:cifra");
      }
    });
  });

  it("lê a credencial typesafe ATIVA e VALIDADA mais recente, filtrando a organização", async () => {
    banco.linha = { api_key_encrypted: "cifra", api_key_iv: "iv", api_key_tag: "tag" };
    const chave = await chaveDaOrganizacao(ORG, PONTO_DO_CLIMA);

    expect(chave).toBe("decifrada:cifra");
    expect(banco.chamadas).toContainEqual(["from", "ai_provider_credentials"]);
    // Service role passa por cima da RLS: sem este filtro, a chave de outra
    // empresa pagaria a conta desta.
    expect(banco.chamadas).toContainEqual(["eq", "organization_id", ORG]);
    expect(banco.chamadas).toContainEqual(["eq", "provider", "typesafe"]);
    expect(banco.chamadas).toContainEqual(["eq", "is_active", true]);
    expect(banco.chamadas).toContainEqual(["not", "validated_at", "is", null]);
    expect(banco.chamadas).toContainEqual(["order", "created_at", { ascending: false }]);
  });

  it("sem credencial, devolve null sem barulho", async () => {
    expect(await chaveDaOrganizacao(ORG, PONTO_DO_CLIMA)).toBeNull();
    expect(avisos).toEqual([]);
  });

  it("leitura que falha devolve null e deixa rastro", async () => {
    banco.erro = { name: "PostgrestError", message: "relation does not exist" };
    expect(await chaveDaOrganizacao(ORG, PONTO_DO_CLIMA)).toBeNull();
    expect(avisos).toHaveLength(1);
  });

  it("decifragem quebrada devolve null, e o log leva só a CLASSE do erro", async () => {
    banco.linha = { api_key_encrypted: "cifra", api_key_iv: "iv", api_key_tag: "tag" };
    decifragem.falha = true;
    expect(await chaveDaOrganizacao(ORG, PONTO_DO_CLIMA)).toBeNull();
    expect(avisos).toHaveLength(1);
    expect(JSON.stringify(avisos[0])).not.toContain("apikey_segredo");
    expect(avisos[0]![1].erro).toBe("DecryptError");
  });

  it("é o caminho padrão do ponto: a chave decifrada chega ao fornecedor", async () => {
    banco.linha = { api_key_encrypted: "cifra", api_key_iv: "iv", api_key_tag: "tag" };
    const fetchImpl = vi.fn().mockResolvedValue(ok(CORPO_OK));
    const r = await decidirNoPonto(
      { ponto: "sentiment_classify", organizationId: ORG, estado: "x", perguntas: PERGUNTAS },
      { fetchImpl },
    );
    expect(r.ok).toBe(true);
    const [, init] = fetchImpl.mock.calls[0]!;
    expect((init as RequestInit & { headers: Record<string, string> }).headers.Authorization).toBe(
      "Bearer decifrada:cifra",
    );
  });

  describe("só com o interruptor ligado (LGPD): cadastrar a chave não é consentir", () => {
    const CREDENCIAL = { api_key_encrypted: "cifra", api_key_iv: "iv", api_key_tag: "tag" };

    it.each([
      ["nada gravado", {}],
      ["desligado", { jev: { ligado: false, modo: "decide", aceite: LIGADO.jev.aceite } }],
      ["ligado SEM o aceite do administrador", { jev: { ligado: true, modo: "decide", aceite: null } }],
      ["config torta", { jev: "sim" }],
    ])("%s: a chave validada não sai", async (_rotulo, settings) => {
      banco.settings = settings;
      banco.linha = CREDENCIAL;
      expect(await chaveDaOrganizacao(ORG, PONTO_DO_CLIMA)).toBeNull();
      // Desligado é configuração, não incidente: sem rastro, e sem ler a credencial.
      expect(avisos).toEqual([]);
      expect(banco.chamadas).not.toContainEqual(["from", "ai_provider_credentials"]);
    });

    it("o interruptor lido é o DESTA organização", async () => {
      banco.linha = CREDENCIAL;
      await chaveDaOrganizacao(ORG, PONTO_DO_CLIMA);
      expect(banco.chamadas).toContainEqual(["from", "organizations"]);
      expect(banco.chamadas).toContainEqual(["eq", "id", ORG]);
    });

    it("organização não encontrada vale como desligado", async () => {
      banco.settings = null;
      banco.linha = CREDENCIAL;
      expect(await chaveDaOrganizacao(ORG, PONTO_DO_CLIMA)).toBeNull();
    });

    it("com a chave validada e o Jev desligado, o caminho padrão não sai da máquina", async () => {
      // O caso do achado: a chave cadastrada pela tela, ninguém ligou o Jev, e o
      // worker de clima chama `medirClima` a cada mensagem recebida.
      banco.settings = {};
      banco.linha = CREDENCIAL;
      const fetchImpl = vi.fn();
      const r = await decidirNoPonto(
        { ponto: "sentiment_classify", organizationId: ORG, estado: "x", perguntas: PERGUNTAS },
        { fetchImpl },
      );
      expect(r.ok === false && r.motivo).toBe("sem_credencial");
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });

  it("sem a credencial no banco, o caminho padrão não sai da máquina", async () => {
    const fetchImpl = vi.fn();
    const r = await decidirNoPonto(
      { ponto: "sentiment_classify", organizationId: ORG, estado: "x", perguntas: PERGUNTAS },
      { fetchImpl },
    );
    expect(r.ok === false && r.motivo).toBe("sem_credencial");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("a allowlist de egress deriva da mesma base do cliente", () => {
  it("base configurada (o dublê do e2e) passa pela allowlist e recebe a chamada", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok(CORPO_OK));
    const r = await decidirNoPonto(
      { ponto: "sentiment_classify", organizationId: "org-1", estado: "x", perguntas: PERGUNTAS },
      { buscarChave: async () => "tsk_x", fetchImpl, baseUrl: "http://127.0.0.1:4010" },
    );
    expect(r.ok).toBe(true);
    expect(String(fetchImpl.mock.calls[0]![0])).toBe("http://127.0.0.1:4010/v1/systemone");
  });
});
