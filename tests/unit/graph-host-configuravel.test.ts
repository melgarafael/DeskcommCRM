// @vitest-environment node
/**
 * O HOST DA GRAPH É CONFIGURÁVEL — E NADA VAZA PARA `graph.facebook.com` (#817).
 *
 * ─── O que este arquivo mede que o irmão não mede ────────────────────────────
 *
 * `tests/unit/host-da-graph-e-um-knob.test.ts` sobe um receptor REAL em
 * `127.0.0.1` e prova que a requisição CHEGA nele. Falta a asserção negativa, e
 * ela é a que fecha o defeito da issue: com a base apontada para um host FALSO,
 * **nenhuma** chamada pode sair para `graph.facebook.com`. Sem isso, um ponto
 * esquecido — os oito do levantamento eram oito arquivos — passaria verde no
 * receptor e continuaria falando com a Meta em produção.
 *
 * Aqui o `fetch` é substituído por um gravador: ele guarda a URL de cada
 * chamada e responde o mínimo que cada caminho consome. A prova é sobre a LISTA
 * de URLs, não sobre a resposta — é o único jeito de afirmar ausência.
 *
 * ─── Os dois lados da régua ─────────────────────────────────────────────────
 *
 * 1. Com `META_GRAPH_BASE_URL` (e `META_ADS_GRAPH_BASE_URL`) apontando para um
 *    host de mentira, TODA chamada — validação de credencial, `send` do adapter,
 *    conversão e insights de anúncio — vai para o host falso.
 * 2. SEM configuração, tudo sai idêntico ao de antes: `https://graph.facebook.com`
 *    com a versão da instalação. Quem não configurou nada não percebe mudança.
 *
 * A catraca do fim é o que impede este arquivo de envelhecer: qualquer literal
 * de URL da Graph fora dos dois módulos de base reprova a suíte, inclusive em
 * `scripts/` — que é onde o último tinha ficado.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A credencial da sessão, resolvida pelo mesmo caminho do dublê do arquivo irmão:
 * sem ela o `send` LANÇA `meta_not_configured` antes de qualquer rede, e o teste
 * mediria um caminho que ele mesmo desligou.
 */
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      const linha = tabela === "channel_sessions"
        ? { meta_phone_number_id: "1103328999528818", meta_token_encrypted: "\\xprova" }
        : [];
      const alvo: Record<string, unknown> = {
        maybeSingle: async () => ({ data: linha, error: null }),
        limit: async () => ({ data: linha, error: null }),
        upsert: async () => ({ data: null, error: null }),
        update: async () => ({ data: null, error: null }),
      };
      alvo.select = () => alvo;
      alvo.eq = () => alvo;
      alvo.is = () => alvo;
      alvo.order = () => alvo;
      return alvo;
    },
    rpc: async (nome: string) =>
      nome === "fn_decrypt_oauth"
        ? { data: "token-da-sessao", error: null }
        : { data: null, error: null },
  }),
}));

const NUMERO = "1103328999528818";
const WABA = "waba-de-prova";
const ORG = "00000000-0000-4000-8000-000000000817";

/** Host de MENTIRA: não resolve, não existe. Se algo for para lá, o teste falha. */
const HOST_FALSO = "https://graph-de-mentira.example.test";
const VERSAO = "v19.0";

let chamadas: string[] = [];

/** O mínimo que cada caminho consome — por PADRÃO de URL, não por ordem. */
function corpoDaResposta(url: string): unknown {
  if (url.includes("/phone_numbers")) return { data: [{ id: NUMERO }] };
  if (url.includes("/messages")) return { messages: [{ id: "wamid.FALSO" }] };
  if (url.includes("/events")) return { events_received: 1 };
  if (url.includes("message_templates")) return { data: [] };
  if (url.includes("/subscribed_apps")) return { success: true };
  return { display_phone_number: "5541999999999", verified_name: "Canal", quality_rating: "GREEN" };
}

beforeEach(() => {
  chamadas = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (entrada: unknown) => {
      const url = String(entrada);
      chamadas.push(url);
      return {
        ok: true,
        status: 200,
        json: async () => corpoDaResposta(url),
      };
    }),
  );
  process.env.META_GRAPH_VERSION = VERSAO;
});

afterEach(() => {
  delete process.env.META_GRAPH_BASE_URL;
  delete process.env.META_ADS_GRAPH_BASE_URL;
  delete process.env.META_GRAPH_VERSION;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

/**
 * Nenhuma chamada pode SAIR para o host real: é a asserção que a issue pede.
 * Compara o host de cada URL gravada, e não um trecho do texto — o que se mede
 * é o destino da requisição.
 */
function assertNadaVazou(): void {
  expect(chamadas.length).toBeGreaterThan(0);
  expect(chamadas.filter((u) => new URL(u).hostname === "graph.facebook.com")).toEqual([]);
}

describe("com host FALSO apontado, nada sai para graph.facebook.com", () => {
  it("a VALIDAÇÃO DE CREDENCIAL usa só o host falso", async () => {
    process.env.META_GRAPH_BASE_URL = HOST_FALSO;
    const { validateMetaCredentials } = await import("@/lib/channels/meta/validate-credentials");

    const r = await validateMetaCredentials({ phoneNumberId: NUMERO, token: "tok", wabaId: WABA });

    expect(r.ok).toBe(true);
    // Duas chamadas: o número e a lista da WABA. As duas no host falso.
    expect(chamadas).toHaveLength(2);
    for (const url of chamadas) expect(url.startsWith(`${HOST_FALSO}/${VERSAO}/`)).toBe(true);
    assertNadaVazou();
  });

  it("o `send` do ADAPTER usa só o host falso", async () => {
    process.env.META_GRAPH_BASE_URL = HOST_FALSO;
    const { getAdapter } = await import("@/lib/channels");

    const enviado = await getAdapter("meta_cloud").send({
      organizationId: ORG,
      sessionRef: NUMERO,
      to: "5531999998888",
      kind: "text",
      body: "oi",
    });

    expect(enviado).toEqual({ externalId: "wamid.FALSO" });
    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]!.startsWith(`${HOST_FALSO}/${VERSAO}/${NUMERO}/messages`)).toBe(true);
    assertNadaVazou();
  });

  it("o eixo de ANÚNCIO obedece ao knob próprio e não herda o do canal", async () => {
    // Só o knob do anúncio aponta para o falso; o do canal fica no default.
    process.env.META_ADS_GRAPH_BASE_URL = HOST_FALSO;
    const { transporteMeta } = await import("@/lib/plataformas-de-anuncio/meta/conversions");
    const { montarUrl } = await import("@/lib/plataformas-de-anuncio/meta/insights");

    const desfecho = await transporteMeta.enviar(
      { datasetId: "dataset-de-prova", accessToken: "token-de-anuncio", testEventCode: null } as never,
      {
        organizationId: "org",
        leadId: "lead-1",
        evento: "Purchase",
        eventoId: "lead-1:Purchase",
        ocorridoEm: new Date(),
        cliqueDeOrigem: "clid-1",
        telefone: null,
        valorCentavos: 1000,
        moeda: "BRL",
      } as never,
    );

    expect(desfecho).toEqual({ tipo: "ok" });
    expect(chamadas.every((u) => u.startsWith(`${HOST_FALSO}/v22.0/`))).toBe(true);
    // `montarUrl` não faz rede, mas monta a URL que iria para a rede.
    expect(montarUrl("act_123/insights", { fields: "cpm" }).startsWith(`${HOST_FALSO}/v22.0/`)).toBe(true);
    assertNadaVazou();
  });
});

describe("sem configuração, o comportamento é o de antes — a régua", () => {
  it("validação e adapter continuam falando com o host real, com a versão da instalação", async () => {
    // Nenhuma variável de base: é a instalação que nunca configurou nada.
    delete process.env.META_GRAPH_BASE_URL;
    const { validateMetaCredentials } = await import("@/lib/channels/meta/validate-credentials");
    const { getAdapter } = await import("@/lib/channels");

    const r = await validateMetaCredentials({ phoneNumberId: NUMERO, token: "tok" });
    expect(r.ok).toBe(true);
    await getAdapter("meta_cloud").send({
      organizationId: ORG,
      sessionRef: NUMERO,
      to: "5531999998888",
      kind: "text",
      body: "oi",
    });

    expect(chamadas).toHaveLength(2);
    for (const url of chamadas) expect(url.startsWith(`https://graph.facebook.com/${VERSAO}/`)).toBe(true);
  });

  it("o eixo de anúncio, sem a variável, fala com o host real na versão DELE", async () => {
    delete process.env.META_ADS_GRAPH_BASE_URL;
    const { montarUrl } = await import("@/lib/plataformas-de-anuncio/meta/insights");
    expect(montarUrl("act_123/insights", { fields: "cpm" }).startsWith("https://graph.facebook.com/v22.0/")).toBe(true);
  });
});

describe("CATRACA: o literal só existe nos dois módulos de base", () => {
  /**
   * O padrão exige o host DENTRO de string de URL (`"https://…`, `'https://…`,
   * `` `https://… ``). Comentário que cita o domínio não entra — a doutrina fala
   * dele em prosa, e prosa não é chamada de rede.
   */
  const LITERAL = /["'`]https:\/\/graph\.facebook\.com/;
  const PERMITIDOS = new Set([
    "lib/channels/meta/graph-base.ts",
    "lib/plataformas-de-anuncio/meta/graph-base.ts",
  ]);
  const RAIZES = ["lib", "app", "scripts"];

  function arquivos(dir: string, achados: string[] = []): string[] {
    for (const entrada of readdirSync(dir, { withFileTypes: true })) {
      const caminho = join(dir, entrada.name);
      if (entrada.isDirectory()) arquivos(caminho, achados);
      else if (/\.(ts|tsx)$/.test(entrada.name) && !/\.test\./.test(entrada.name)) achados.push(caminho);
    }
    return achados;
  }

  it("nenhum arquivo de produção fora dos dois graph-base carrega o host em URL", () => {
    const comLiteral = RAIZES.flatMap((raiz) => arquivos(join(process.cwd(), raiz)))
      .filter((caminho) => LITERAL.test(readFileSync(caminho, "utf8")))
      .map((caminho) => caminho.slice(process.cwd().length + 1).replace(/\\/g, "/"));

    expect(comLiteral.filter((c) => !PERMITIDOS.has(c)).sort()).toEqual([]);
    // Controle de vacuidade: os dois módulos de base PRECISAM aparecer, senão a
    // catraca estaria medindo o conjunto vazio.
    expect(comLiteral.sort()).toEqual([...PERMITIDOS].sort());
  });
});
