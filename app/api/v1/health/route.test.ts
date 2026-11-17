import { readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { RUNBOOKS, RUNBOOK_DA_CAUSA } from "@/lib/net/causa-do-supabase";

/**
 * GET /api/v1/health — a rota é PÚBLICA e não pode publicar o endereço interno.
 *
 * O campo `target` (protocolo + host + porta) já era escondido de propósito: só
 * sai com `?verbose=1` mais o segredo interno, porque o endereço dos serviços
 * externos de uma instalação é superfície de ataque. O `error`, ao lado dele,
 * saía cru — e carrega o MESMO endereço quando o `.env` está numa das formas
 * erradas mais comuns do self-host.
 *
 * A condição de alcance existe porque, das três variáveis de endereço que a
 * rota consulta, só a do banco é validada como URL (`lib/env.ts:69`, `.url()`);
 * as outras duas (`lib/env.ts:140` e `155`) são `required()` puro. Um valor sem
 * esquema, ou com as aspas do `.env` sobrando, passa pelo Zod e explode no
 * `fetch` com o host dentro da mensagem:
 *
 *   "servico-interno.vps-do-cliente.com"
 *     -> "Failed to parse URL from servico-interno.vps-do-cliente.com"
 *
 * ESCOPO, dito em voz alta: isto vigia a SAÍDA da rota, não a validação do env.
 * Um endereço com esquema válido e host inalcançável devolve `"fetch failed"` e
 * guarda o host em `e.cause`, que a rota nunca devolveu — esse caso nunca vazou,
 * e este arquivo não o cobre porque não há o que cobrir.
 *
 * Um cuidado de forma: este arquivo exercita SÓ o caminho da fila, e não o do
 * outro serviço externo, porque nomeá-lo aqui reprovaria `lint:channels`
 * (doutrina restrição-de-canal, invariante 1 — gate obrigatório). A perda é
 * nenhuma: o vazamento é do `error` em `semAlvo()`, que é o mesmo código para os
 * três checks; um caminho basta para prová-lo, e a asserção é sobre o corpo
 * inteiro, não sobre um campo.
 *
 * Achado por @prevprocesso-maker no PR #465.
 */

/**
 * Sem esquema de propósito: é esta forma que faz o `fetch` do Node embutir o
 * endereço na mensagem, e é a forma que um `.env` mal preenchido produz.
 */
const HOST_VAZADO = "servico-interno.vps-do-cliente.com";
const SEGREDO = "segredo-interno-de-teste-com-tamanho-suficiente";

vi.mock("@/lib/env", () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: "https://projeto-do-cliente.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "chave-de-teste",
    UPSTASH_REDIS_REST_URL: "servico-interno.vps-do-cliente.com",
    UPSTASH_REDIS_REST_TOKEN: "token-de-teste",
    INTERNAL_CRON_SECRET: "segredo-interno-de-teste-com-tamanho-suficiente",
    INTERNAL_SECRET: "",
  },
}));

function pedido(query = "", headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`https://crm.exemplo.com.br/api/v1/health${query}`, { headers });
}

describe("GET /api/v1/health — o endereço interno não sai para quem não tem o segredo", () => {
  beforeEach(() => vi.resetModules());

  it("não publica o host numa resposta anônima, nem pelo error", async () => {
    const { GET } = await import("./route");
    const corpo = JSON.stringify(await (await GET(pedido())).json());

    // A asserção é sobre o CORPO INTEIRO, não sobre um campo: se amanhã alguém
    // acrescentar outro lugar por onde o endereço saia, este caso reprova.
    expect(corpo).not.toContain(HOST_VAZADO);
    expect(corpo).not.toContain("Failed to parse URL");
  });

  it("mantém o diagnóstico útil — o motivo continua saindo", async () => {
    const { GET } = await import("./route");
    const { data } = await (await GET(pedido())).json();

    // Redigir não pode virar apagar: quem monitora de fora precisa seguir
    // distinguindo "não alcancei" de "fui barrado". Sem isto, a redação seria
    // uma regressão de observabilidade disfarçada de conserto.
    expect(data.checks.redis.reason).toBeTruthy();
    expect(data.checks.redis.status).toBe("down");
  });

  it("devolve o texto original a quem tem o segredo interno", async () => {
    const { GET } = await import("./route");
    const req = pedido("?verbose=1", { authorization: `Bearer ${SEGREDO}` });
    const corpo = JSON.stringify(await (await GET(req)).json());

    // O outro lado da mesma moeda: se a redação passasse a valer também no modo
    // verboso, o operador perderia o diagnóstico e ninguém notaria — o caso
    // acima ficaria verde do mesmo jeito.
    expect(corpo).toContain(HOST_VAZADO);
  });
});

describe("GET /api/v1/health — indisponibilidade do projeto Supabase", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.unstubAllGlobals());

  it("522 vira projeto_indisponivel, não tempo_esgotado", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve(new Response("", { status: 522 })));
    const { GET } = await import("./route");
    const { NextRequest } = await import("next/server");
    const { data } = await (await GET(new NextRequest("https://crm.exemplo.com.br/api/v1/health"))).json();
    expect(data.checks.supabase.status).toBe("down");
    expect(data.checks.supabase.reason).toBe("projeto_indisponivel");
  });

  it("PGRST002 no corpo vira projeto_indisponivel", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(
        new Response(JSON.stringify({ code: "PGRST002", message: "Could not query the database for the schema cache. Retrying." }), {
          status: 503,
        }),
      ),
    );
    const { GET } = await import("./route");
    const { NextRequest } = await import("next/server");
    const { data } = await (await GET(new NextRequest("https://crm.exemplo.com.br/api/v1/health"))).json();
    expect(data.checks.supabase.status).toBe("down");
    expect(data.checks.supabase.reason).toBe("projeto_indisponivel");
  });

  it("timeout puro continua tempo_esgotado", async () => {
    vi.stubGlobal("fetch", () => new Promise(() => {}));
    const { GET } = await import("./route");
    const { NextRequest } = await import("next/server");
    const { data } = await (await GET(new NextRequest("https://crm.exemplo.com.br/api/v1/health"))).json();
    expect(data.checks.supabase.status).toBe("down");
    expect(data.checks.supabase.reason).toBe("tempo_esgotado");
  });
});

describe("GET /api/v1/health — corpo cortado no meio não vira timeout", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.unstubAllGlobals());

  function corpoCortado() {
    return new ReadableStream({
      start(c) {
        c.error(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }));
      },
    });
  }

  async function checkComResposta(res: () => Response) {
    vi.stubGlobal("fetch", () => Promise.resolve(res()));
    const { GET } = await import("./route");
    const { NextRequest } = await import("next/server");
    const { data } = await (await GET(new NextRequest("https://crm.exemplo.com.br/api/v1/health"))).json();
    return data.checks.supabase;
  }

  it("200 com o corpo cortado mantém o motivo de alcance da conexão", async () => {
    const supabase = await checkComResposta(() => new Response(corpoCortado(), { status: 200 }));
    expect(supabase.status).toBe("down");
    expect(supabase.reason).toBe("host_inalcancavel");
  });

  it("500 com o corpo cortado continua sendo a resposta que chegou", async () => {
    const supabase = await checkComResposta(() => new Response(corpoCortado(), { status: 500 }));
    expect(supabase.status).toBe("down");
    expect(supabase.reason).toBe("resposta_inesperada");
  });
});


/**
 * A CAUSA do banco, e não só o `down`.
 *
 * ─── O que estes casos guardam ───────────────────────────────────────────────
 * Uma instalação no plano free passou ~6 h com 100% de `/rest/v1` em 522 e o
 * health dizendo só `tempo_esgotado`: a resposta estava certa e não dizia para
 * onde ir. Os casos abaixo fixam a régua que separa os ramos que se PARECEM —
 * schema cache do PostgREST (o cache não carregou), banco inacessível (não
 * chegamos nele) e lentidão genérica (tentamos, o tempo acabou, não houve
 * corpo) — e conferem que o ponteiro do runbook aponta para um arquivo que
 * existe de verdade.
 */
describe("GET /api/v1/health — a causa do banco, com o runbook que cada uma pede", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.unstubAllGlobals());

  /** O `checks.supabase` de uma resposta anônima (o que quem monitora lê). */
  async function supabase() {
    const { GET } = await import("./route");
    const { NextRequest } = await import("next/server");
    const { data } = await (await GET(new NextRequest("https://crm.exemplo.com.br/api/v1/health"))).json();
    return data.checks.supabase;
  }

  function resposta(status: number, corpo: string) {
    vi.stubGlobal("fetch", () => Promise.resolve(new Response(corpo, { status })));
  }

  it("(a) schema cache estourado vira postgrest_sem_schema_cache e aponta o runbook do free", async () => {
    // O corpo é o que o PostgREST devolve medido: 503 com `PGRST002`.
    resposta(
      503,
      JSON.stringify({
        code: "PGRST002",
        message: "Could not query the database for the schema cache. Retrying.",
      }),
    );
    const check = await supabase();
    expect(check.status).toBe("down");
    expect(check.causa).toBe("postgrest_sem_schema_cache");
    expect(check.runbook).toBe(RUNBOOKS.semMemoriaNoFree);
    // `reason` NÃO muda: é o contrato de quem já consome o health.
    expect(check.reason).toBe("projeto_indisponivel");
  });

  it("(b) falha de conexão vira banco_inacessivel, com o runbook de testar o banco", async () => {
    // Medido: o undici embrulha o erro do socket em `cause`, e é lá que mora o
    // código. Mandar este caso para o runbook do compute é o defeito que o
    // mapa de runbooks existe para impedir.
    vi.stubGlobal("fetch", () =>
      Promise.reject(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } })),
    );
    const check = await supabase();
    expect(check.status).toBe("down");
    expect(check.causa).toBe("banco_inacessivel");
    expect(check.reason).toBe("conexao_recusada");
    expect(check.runbook).toBe(RUNBOOKS.testarOBancoNaVps);
    expect(check.runbook).not.toBe(RUNBOOKS.semMemoriaNoFree);
  });

  it("(c) tempo esgotado puro é lentidao_generica, e o health não finge schema cache", async () => {
    // O caso da issue: nenhuma resposta, nenhum corpo. Inventar
    // `postgrest_sem_schema_cache` aqui seria diagnóstico sem medição.
    vi.stubGlobal("fetch", () => new Promise(() => {}));
    const check = await supabase();
    expect(check.status).toBe("down");
    expect(check.causa).toBe("lentidao_generica");
    expect(check.reason).toBe("tempo_esgotado");
    expect(check.runbook).toBeTruthy();
    // E o topo continua `unhealthy`: `status` do check não virou "degraded",
    // porque `down` é o que faz o `wait_app_healthy` reverter imagem quebrada.
    const { GET } = await import("./route");
    const { NextRequest } = await import("next/server");
    const resp = await GET(new NextRequest("https://crm.exemplo.com.br/api/v1/health"));
    expect(resp.status).toBe(503);
  });

  it("(d) os campos antigos mantêm o mesmo nome e o mesmo significado", async () => {
    // 200 com JSON do PostgREST: `ok`, com latência medida.
    resposta(200, "[]");
    const ok = await supabase();
    expect(ok.status).toBe("ok");
    expect(typeof ok.latency_ms).toBe("number");
    expect(ok.reason).toBeUndefined();

    // 401/403: chegamos ao banco e fomos barrados — sempre foi `ok`.
    resposta(401, "");
    expect((await supabase()).status).toBe("ok");

    // 522: continua `projeto_indisponivel`, agora com causa própria.
    resposta(522, "");
    const origem = await supabase();
    expect(origem.status).toBe("down");
    expect(origem.reason).toBe("projeto_indisponivel");
    expect(origem.causa).toBe("projeto_sem_resposta_na_origem");

    // O `target` continua escondido de quem não tem o segredo interno.
    expect(origem.target).toBeUndefined();
  });

  it("(e) todo ponteiro de runbook aponta para arquivo que existe no repositório", async () => {
    // O `vitest` roda com a raiz do repositório como cwd (é o mesmo `process.cwd()`
    // que o gate de `.changes/` usa). `import.meta.url` NÃO serve aqui: o
    // transform do Vite entrega um esquema que não é `file:` e o `readFileSync`
    // recusa o URL — do lado de cá ele resolveria para nada.
    const raiz = process.cwd();
    for (const causa of Object.keys(RUNBOOK_DA_CAUSA) as Array<keyof typeof RUNBOOK_DA_CAUSA>) {
      const caminho = RUNBOOK_DA_CAUSA[causa];
      // Renomear o doc sem mexer no código reprova AQUI — que é o ponto.
      expect(() => readFileSync(path.join(raiz, caminho), "utf8"), `${causa} -> ${caminho}`).not.toThrow();
    }
    // O ponteiro tem de ser o doc do MECANISMO CERTO, não só um doc que existe:
    // `rodar-sql-na-vps.md` existe, e apontar o schema cache para ele mandaria
    // quem está com o projeto sem memória conferir DNS.
    expect(RUNBOOK_DA_CAUSA.postgrest_sem_schema_cache).toBe(RUNBOOKS.semMemoriaNoFree);
    expect(RUNBOOK_DA_CAUSA.banco_inacessivel).not.toBe(RUNBOOKS.semMemoriaNoFree);
    // `banco_inacessivel` inclui o nome `*.supabase.co` que deixou de resolver
    // (projeto pausado ou apagado, medido em 13/11). Quem não tem o segredo vê
    // só `reason`/`causa`/`runbook`, então o caminho até o Restore mora no doc.
    const testarOBanco = readFileSync(path.join(raiz, RUNBOOKS.testarOBancoNaVps), "utf8");
    expect(testarOBanco).toContain("endereco_nao_resolve");
    expect(testarOBanco).toContain("Restore project");
    // E o cruzamento é mútuo: cada runbook cita o outro pelo nome, porque quem
    // cai no documento errado precisa do caminho de volta.
    const semMemoria = readFileSync(path.join(raiz, RUNBOOKS.semMemoriaNoFree), "utf8");
    const replay = readFileSync(path.join(raiz, "docs/runbooks/postgrest-replay-do-gateway.md"), "utf8");
    expect(semMemoria).toContain("postgrest-replay-do-gateway.md");
    expect(replay).toContain("supabase-sem-memoria-no-free.md");
  });
});
