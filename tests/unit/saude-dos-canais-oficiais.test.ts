import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * OS CANAIS OFICIAIS ERAM CEGOS À PRÓPRIA QUEDA.
 *
 * ─── O defeito ──────────────────────────────────────────────────────────────
 *
 * Só o canal por QR implementava `checkHealth`. O cron de saúde faz
 * `if (!adapter.checkHealth || !sessionRef) continue` — então a sessão oficial
 * era PULADA, sem log e sem contador, e `channel_sessions.status` só era escrito
 * no instante de conectar. Chave revogada, número suspenso ou permissão retirada
 * viravam silêncio absoluto, para sempre, com a tela dizendo "conectado".
 *
 * O canal intermediado tinha meia visão: traduz os avisos que o provedor
 * EMPURRA (`account.disconnected`, `number.suspended`). Cego mesmo ele era para
 * a falha CALADA — que é a única que ninguém percebe sozinho, e por isso a que
 * mais importa.
 *
 * ─── Por que quase todo caso é sobre DISTINGUIR desfechos ───────────────────
 *
 * A tentação é devolver "caiu" sempre que algo dá errado. Só que oscilação de
 * rede virando "canal caído" ensina o operador a ignorar o aviso — e um aviso
 * ignorado é pior que nenhum, porque dá a sensação de cobertura. Por isso
 * "não sei" (`reachable: false`) é um desfecho de primeira classe, distinto de
 * "sei que caiu" (`status: FAILED`).
 */

const zernioCreds = vi.fn(async () => ({
  accountId: "conta-1",
  apiKey: "chave",
  baseUrl: "https://z.example",
  source: "session" as const,
}));
const metaCreds = vi.fn(async () => ({ phoneNumberId: "555", token: "tok" }));

/** A organização atravessa o seam desde a issue #236. */
const ORG = "00000000-0000-4000-8000-000000000236";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) as never }));
vi.mock("@/lib/channels/zernio/credentials", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  resolveZernioCreds: (...a: unknown[]) => zernioCreds(...(a as [])),
}));
vi.mock("@/lib/channels/meta/credentials", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  resolveMetaCreds: (...a: unknown[]) => metaCreds(...(a as [])),
}));

function respondeCom(body: unknown, init: { status?: number } = {}) {
  const status = init.status ?? 200;
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    json: async () => body,
  })) as unknown as typeof fetch;
}

const fetchOriginal = globalThis.fetch;

beforeEach(() => {
  zernioCreds.mockClear();
  metaCreds.mockClear();
});
afterEach(() => {
  globalThis.fetch = fetchOriginal;
});

describe("canal intermediado", () => {
  async function saude() {
    const { zernioAdapter } = await import("@/lib/channels/adapters/zernio");
    return zernioAdapter.checkHealth!({ organizationId: ORG, sessionRef: "conta-1" });
  }

  /**
   * A forma abaixo é a MEDIDA nesta instalação, não uma inventada para o teste:
   *
   *   status: "healthy"
   *   platformConnection: {"status":"connected","phoneStatus":"CONNECTED",...}
   */
  const ELO_VIVO = {
    status: "healthy",
    platformConnection: { status: "connected", phoneStatus: "CONNECTED", metaError: null },
  };

  it("elo com a Meta vivo → está de pé", async () => {
    globalThis.fetch = respondeCom(ELO_VIVO);
    expect(await saude()).toEqual({ reachable: true, status: "WORKING", detail: null });
  });

  it("chave recusada → FAILED, que é a falha calada que se procura", async () => {
    // Token revogado responde 401 e mais nada acontece: nenhum webhook avisa,
    // nenhuma tela muda. É exatamente o caso que motivou este método.
    globalThis.fetch = respondeCom({}, { status: 401 });
    expect(await saude()).toMatchObject({ reachable: true, status: "FAILED" });
  });

  it("conta que sumiu do lado de lá → STOPPED, não FAILED", async () => {
    // São coisas diferentes e o operador faz coisas diferentes: credencial
    // recusada se troca, conta removida se reconecta. Um status só para os dois
    // mandaria metade das pessoas para o lugar errado.
    globalThis.fetch = respondeCom({}, { status: 404 });
    expect(await saude()).toMatchObject({ reachable: true, status: "STOPPED" });
  });

  it("token VÁLIDO com o número desligado do lado do aparelho → FAILED", async () => {
    // O caso que a varredura da lista de contas NÃO enxergava, e que a própria
    // doc do provedor nomeia: a chave presta, a conta está lá, e a Meta recusa
    // servir o objeto do número. Antes disto o CRM dizia "conectado" para um
    // número que não entregava mais nada — em silêncio, para sempre.
    globalThis.fetch = respondeCom({
      status: "error",
      platformConnection: {
        status: "disconnected",
        phoneStatus: null,
        metaError: { code: 100, subcode: 33, message: "Unsupported get request" },
      },
    });
    const r = await saude();
    expect(r.status).toBe("FAILED");
    expect(r.detail, "o código da Meta é o que diz ao operador o que fazer").toBe("meta_100_33");
  });

  it("o detalhe NÃO carrega a mensagem crua da Meta", async () => {
    // Ela é longa e às vezes leva identificadores que não têm por que entrar
    // num aviso que vai para a tela.
    globalThis.fetch = respondeCom({
      platformConnection: {
        status: "disconnected",
        metaError: { code: 100, subcode: 33, message: "objeto 1234567890 do usuário fulano" },
      },
    });
    expect((await saude()).detail).not.toContain("fulano");
  });

  it("sonda inconclusiva é NÃO SEI — jamais 'caiu'", async () => {
    // `unknown` é, nas palavras da doc, "not evidence either way". Traduzi-lo
    // para queda faria um soluço da Meta abrir aviso crítico, e aviso que grita
    // à toa ensina o operador a ignorar aviso — que é pior que não ter nenhum.
    //
    // Como `reachable: false`, `julgarQueda` ainda exige DUAS observações ruins
    // seguidas antes de acreditar: um soluço isolado não escala.
    globalThis.fetch = respondeCom({
      status: "warning",
      platformConnection: { status: "unknown", phoneStatus: null, metaError: null },
    });
    const r = await saude();
    expect(r.reachable, "'não sei' virou queda de canal").toBe(false);
    expect(r.status, "inventou um status que não mediu").toBeNull();
  });

  it("sem o campo do elo, decide pelo veredito geral — e ausência não é má notícia", async () => {
    // Conta que não é WhatsApp, ou provedor que ainda não publicou a sonda.
    // Falhar aqui derrubaria canais saudáveis no dia em que a resposta mudasse.
    globalThis.fetch = respondeCom({ status: "healthy" });
    expect(await saude()).toMatchObject({ reachable: true, status: "WORKING" });
  });

  it("sem o campo do elo, mas a conta em erro → FAILED", async () => {
    globalThis.fetch = respondeCom({ status: "error", issues: ["token expiring"] });
    expect(await saude()).toMatchObject({ reachable: true, status: "FAILED" });
  });

  it("rede caída é NÃO SEI, nunca 'canal caído'", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    const r = await saude();
    expect(r.reachable, "uma oscilação de rede virou queda de canal").toBe(false);
    expect(r.status, "inventou um status que não mediu").toBeNull();
  });

  it("erro inesperado do provedor também é NÃO SEI", async () => {
    // 500 do lado deles não diz nada sobre a nossa credencial.
    globalThis.fetch = respondeCom({}, { status: 503 });
    expect(await saude()).toMatchObject({ reachable: false, status: null });
  });

  it("sessão sem credencial não vira alarme de queda", async () => {
    zernioCreds.mockResolvedValue(null as never);
    expect(await saude()).toMatchObject({ reachable: false, status: null });
  });

  it("pergunta pela CONTA, no caminho de saúde — não varre a lista", async () => {
    // A varredura de `GET /v1/accounts` respondia "a conta existe", que é outra
    // pergunta. Se alguém voltar a ela, os casos acima passam a ser encenação.
    // Restaura a credencial explicitamente: `mockClear` zera CHAMADAS, não a
    // implementação, e o caso anterior deixou `null` — sem isto o teste passaria
    // a depender da ordem de execução, que é o jeito de um teste mentir.
    zernioCreds.mockResolvedValue({
      accountId: "conta-1",
      apiKey: "chave",
      baseUrl: "https://z.example",
      source: "session",
    } as never);
    const espia = respondeCom(ELO_VIVO);
    globalThis.fetch = espia;
    await saude();
    const url = String((espia as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0]);
    expect(url).toContain("/v1/accounts/conta-1/health");
  });
});

describe("canal oficial direto", () => {
  async function saude() {
    const { metaCloudAdapter } = await import("@/lib/channels/adapters/meta-cloud");
    return metaCloudAdapter.checkHealth!({ organizationId: ORG, sessionRef: "555" });
  }

  it("número responde → está de pé", async () => {
    globalThis.fetch = respondeCom({ display_phone_number: "+595..." });
    expect(await saude()).toEqual({ reachable: true, status: "WORKING", detail: null });
  });

  it("token recusado → FAILED", async () => {
    globalThis.fetch = respondeCom({}, { status: 401 });
    expect(await saude()).toMatchObject({ reachable: true, status: "FAILED" });
  });

  it("erro no CORPO com HTTP 200 também é FAILED", async () => {
    // Comportamento real da Graph: ela devolve 200 com `error` no corpo. Olhar
    // só o status HTTP deixaria passar justamente o token vencido.
    globalThis.fetch = respondeCom({ error: { message: "Session has expired", code: 190 } });
    const r = await saude();
    expect(r.status).toBe("FAILED");
    expect(r.detail).toContain("expired");
  });

  it("rede caída é NÃO SEI", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("ETIMEDOUT");
    }) as unknown as typeof fetch;
    expect(await saude()).toMatchObject({ reachable: false, status: null });
  });

  it("sessão sem credencial não vira alarme de queda", async () => {
    metaCreds.mockResolvedValue(null as never);
    expect(await saude()).toMatchObject({ reachable: false, status: null });
  });
});

/**
 * QUEM PODE FECHAR O AVISO.
 *
 * As duas fontes medem coisas diferentes: o empurrão do provedor fala do
 * NÚMERO ("suspenso"), a varredura fala da CREDENCIAL e da conta ("a chave
 * responde, a conta está na lista"). Um número suspenso continua aparecendo na
 * lista de contas — então a varredura via WORKING e resolvia, em ≤5 minutos, o
 * crítico que o empurrão tinha aberto, com o número ainda suspenso.
 *
 * Foi uma revisão adversarial que pegou isto, depois de os testes anteriores
 * passarem: nenhum deles fazia as DUAS fontes se encontrarem.
 */
describe("a varredura não fecha o que o provedor abriu", () => {
  let episodioGravado: string | null = null;
  let resolveu = false;

  function bancoCom(escalado: string | null) {
    episodioGravado = null;
    resolveu = false;
    return {
      from(tabela: string) {
        if (tabela === "channel_session_health") {
          const cadeia: Record<string, unknown> = {
            select: () => cadeia,
            eq: () => cadeia,
            maybeSingle: async () => ({ data: { escalated_status: escalado }, error: null }),
            upsert: async (linha: Record<string, unknown>) => {
              episodioGravado = (linha.escalated_status as string | null) ?? null;
              return { error: null };
            },
          };
          return cadeia;
        }
        const itens: Record<string, unknown> = {
          insert: async () => ({ error: null }),
          update: () => {
            resolveu = true;
            return itens;
          },
          eq: () => itens,
          then: (r: (v: unknown) => void) => Promise.resolve({ error: null }).then(r),
        };
        return itens;
      },
    } as never;
  }

  const DE_PE = { reachable: true, status: "WORKING", detail: null };
  const SESSAO = { id: "s-1", organization_id: "org-1", status: "WORKING" };

  it("número suspenso pelo provedor NÃO é dado como resolvido pela varredura", async () => {
    // O caso que motivou tudo: a conta segue listada, então a varredura vê
    // "WORKING" — mas ela não mediu o número.
    const { sincronizarSaudeDaConexao, PREFIXO_EMPURRAO } = await import("@/lib/channels/health");
    const db = bancoCom(`${PREFIXO_EMPURRAO}FAILED`);
    const r = await sincronizarSaudeDaConexao(db, SESSAO, DE_PE, "Comercial", "varredura");
    expect(r).toBe("sem_mudanca");
    expect(resolveu, "a varredura fechou um aviso que não podia observar").toBe(false);
  });

  it("mas o provedor dizendo que voltou FECHA", async () => {
    // A autoridade sobre o número é quem abriu. Sem este caso, o aviso viraria
    // eterno — que é o defeito que o commit anterior existia para consertar.
    const { sincronizarSaudeDaConexao, PREFIXO_EMPURRAO } = await import("@/lib/channels/health");
    const db = bancoCom(`${PREFIXO_EMPURRAO}FAILED`);
    const r = await sincronizarSaudeDaConexao(db, SESSAO, DE_PE, "Comercial", "empurrao");
    expect(r).toBe("resolvido");
    expect(resolveu).toBe(true);
  });

  it("e a varredura segue fechando o que ela mesma abriu", async () => {
    // O canal por QR depende disto: lá a varredura É a autoridade.
    const { sincronizarSaudeDaConexao } = await import("@/lib/channels/health");
    const db = bancoCom("STOPPED");
    const r = await sincronizarSaudeDaConexao(db, SESSAO, DE_PE, "Vendas", "varredura");
    expect(r).toBe("resolvido");
  });

  it("o episódio do provedor fica MARCADO — é o que permite distinguir depois", async () => {
    const { sincronizarSaudeDaConexao, PREFIXO_EMPURRAO } = await import("@/lib/channels/health");
    const db = bancoCom(null);
    await sincronizarSaudeDaConexao(
      db,
      SESSAO,
      { reachable: true, status: "FAILED", detail: null },
      "Comercial",
      "empurrao",
    );
    expect(episodioGravado).toBe(`${PREFIXO_EMPURRAO}FAILED`);
  });
});

describe("o cron enxerga os três canais", () => {
  it("todo adapter registrado sabe responder pela própria saúde", async () => {
    // O cron pula quem não implementa, SEM log e sem contador — então um canal
    // sem este método é invisível para a Central, e a ausência não aparece em
    // lugar nenhum. Este caso existe para que o próximo canal não entre mudo.
    // A lista sai de `CHANNEL_CAPABILITIES`, que é a matriz declarada do seam:
    // canal novo entra ali por obrigação, então este caso o alcança sozinho.
    const { getAdapter, CHANNEL_CAPABILITIES } = await import("@/lib/channels");
    const mudos = Object.keys(CHANNEL_CAPABILITIES).filter(
      (p) => typeof getAdapter(p as never).checkHealth !== "function",
    );
    expect(mudos, `canais sem checkHealth: ${mudos.join(", ")}`).toEqual([]);
  });
});
