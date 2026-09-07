import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * QUEM DIZ AO SOCKET DO REALTIME QUAL É O TOKEN — e por que este teste existe.
 *
 * ─── O defeito, relatado olhando a tela ─────────────────────────────────────
 *
 * "Recebemos mensagem e só reflete no inbox se atualizarmos a página."
 *
 * ─── O mecanismo, medido no socket (não inferido) ───────────────────────────
 *
 * O cookie de sessão é httpOnly, então o supabase-js do browser não enxerga a
 * sessão. A callback `accessToken` PADRÃO do SupabaseClient, nesse caso,
 * termina em `?? this.supabaseKey`: o socket assina com a ANON KEY. Canal
 * anônimo responde SUBSCRIBED e a RLS filtra do outro lado — ele nunca entrega
 * nada, em silêncio.
 *
 * O repo já corrigia isto com `supabase.realtime.setAuth(token)` antes de
 * assinar. ⚠️ ISSO PAROU DE FUNCIONAR NUM BUMP DE DEPENDÊNCIA, sem uma linha
 * nossa mudar: a partir do realtime-js 2.112.x a callback vence o token
 * manual. A própria biblioteca documenta:
 *
 *   "the callback is the source of truth: the client remains in callback mode
 *    and continues to refresh from it on heartbeat, even after a
 *    bootstrap/override `setAuth(token)` call"
 *
 * Medição do join, com dois canais no mesmo socket (o que o inbox faz — lista
 * e conversa aberta): o primeiro levava o JWT do usuário, o segundo levava
 * `{"iss":"supabase-demo","role":"anon"}`. Zero entregas.
 *
 * ─── Por que os testes anteriores ficaram verdes ────────────────────────────
 *
 * Eles exercitavam `authenticateRealtime` contra um cliente FAKE
 * (`{ realtime: { setAuth: vi.fn() } }`) e afirmavam `setAuth` foi CHAMADO. O
 * que quebrou foi o EFEITO de chamá-lo. Um teste que guarda a chamada em vez
 * do comportamento não vermelhece quando o comportamento morre — foi o que
 * aconteceu, e é a razão de este arquivo cobrar a CALLBACK INSTALADA, que é o
 * que o socket realmente consulta.
 */

/**
 * ⚠️ SEM COMENTÁRIOS, e não é capricho: a primeira versão deste teste procurava
 * `.setAuth(` no arquivo inteiro e casava com a PROSA que explica por que o
 * `setAuth` saiu. Ele reprovava o conserto por causa do texto que documenta o
 * conserto. Um teste que não distingue código de comentário mede a coisa
 * errada — e aqui mediria ao contrário.
 */
function soCodigo(fonte: string): string {
  return fonte.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

const FONTE = soCodigo(readFileSync("lib/supabase/browser.ts", "utf8"));

describe("o token que o socket do Realtime usa", () => {
  it("a callback permanece fonte da renovação e o bootstrap usa a mesma fonte", () => {
    // `realtime: { accessToken }` é o que sobrescreve a callback padrão (o
    // SupabaseClient faz `{...defaults, ...settings.realtime}`). Passar
    // `accessToken` no nível do CLIENT seria outra coisa — transformaria
    // `supabase.auth` num Proxy que lança, quebrando o AuthProvider.
    expect(FONTE, "a callback `accessToken` do realtime sumiu do client").toMatch(
      /realtime:\s*\{\s*accessToken:/,
    );
    expect(FONTE).toMatch(/const token = await tokenDoRealtime\(\)/);
    expect(FONTE).toMatch(/await createClient\(\)\.realtime\.setAuth\(token\)/);
  });

  it("o hook do canal NÃO autentica por conta própria — fonte única", () => {
    // Duas fontes de token foi exatamente o defeito. Se o hook voltar a chamar
    // setAuth, a que vence é a callback e a outra vira mentira no código.
    const hook = soCodigo(readFileSync("hooks/realtime/useRealtimeChannel.ts", "utf8"));
    expect(hook, "o hook voltou a chamar setAuth").not.toMatch(/\.setAuth\(/);
    expect(hook, "o hook voltou a buscar token por conta própria").not.toMatch(
      /realtime-token/,
    );
  });
});

describe("a callback do token", () => {
  // A callback é módulo-global de propósito (o cache tem de valer para todos os
  // canais do socket). O reset existe para os casos não vazarem um no outro.
  let createClient: () => unknown;
  let __resetTokenDoRealtime: () => void;

  /** Extrai a callback que foi passada ao createBrowserClient. */
  async function callbackInstalada(): Promise<() => Promise<string | null>> {
    const mod = await import("@supabase/ssr");
    const espiao = vi.mocked(mod.createBrowserClient);
    createClient();
    const opts = espiao.mock.calls.at(-1)?.[2] as
      | { realtime?: { accessToken?: () => Promise<string | null> } }
      | undefined;
    const cb = opts?.realtime?.accessToken;
    if (!cb) throw new Error("nenhuma callback `accessToken` foi instalada no realtime");
    return cb;
  }

  beforeEach(async () => {
    vi.resetModules();
    vi.doMock("@supabase/ssr", () => ({
      createBrowserClient: vi.fn(() => ({ realtime: { setAuth: vi.fn(async () => {}) } })),
    }));
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://localhost:54321");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key-de-teste");
    const browser = await import("@/lib/supabase/browser");
    createClient = browser.createClient;
    __resetTokenDoRealtime = browser.__resetTokenDoRealtime;
    __resetTokenDoRealtime();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.doUnmock("@supabase/ssr");
  });

  it("devolve o token da sessão — NUNCA a anon key", async () => {
    // O coração do defeito: a callback padrão devolvia a anon key em vez de
    // falhar, e a anon key assina com sucesso e não recebe nada.
    const cb = await callbackInstalada();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: { access_token: "jwt-do-usuario", expires_at: null } }),
      }),
    );
    await expect(cb()).resolves.toBe("jwt-do-usuario");
  });

  it("401 recusa sem token anônimo, e a PRÓXIMA tentativa refaz a requisição", async () => {
    // Falha não se guarda. Um 401 transitório (sessão estabelecendo, cookie em
    // renovação) condenaria todos os canais criados depois se a promessa
    // ficasse memoizada — foi um defeito real deste caminho, na versão anterior.
    const cb = await callbackInstalada();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401 }));
    await expect(cb()).rejects.toThrow("Token de tempo real indisponível");

    const bom = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { access_token: "jwt-depois", expires_at: null } }),
    });
    vi.stubGlobal("fetch", bom);
    await expect(cb()).resolves.toBe("jwt-depois");
    expect(bom).toHaveBeenCalledTimes(1);
  });

  it("200 sem token também não é sucesso", async () => {
    // O caminho mais traiçoeiro: `res.ok` é verdadeiro, nada falha, e mesmo
    // assim não há token. Guardar isto é guardar sucesso parcial.
    const cb = await callbackInstalada();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: {} }) }));
    await expect(cb()).rejects.toThrow("Token de tempo real indisponível");
  });

  it("N canais assinando juntos fazem UMA requisição", async () => {
    const cb = await callbackInstalada();
    const espiao = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { access_token: "jwt-1", expires_at: null } }),
    });
    vi.stubGlobal("fetch", espiao);
    await Promise.all([cb(), cb(), cb()]);
    expect(espiao).toHaveBeenCalledTimes(1);
  });

  it("token com prazo é reusado; token perto de vencer é renovado", async () => {
    // O socket chama esta callback a CADA HEARTBEAT (~30s). Sem cache seriam
    // ~2 requisições/min por aba para um token que vale uma hora. Com cache
    // eterno, o inbox aberto por mais de uma hora perderia o tempo real — que
    // é a bomba-relógio que a versão com `setAuth` tinha.
    const cb = await callbackInstalada();
    const daquiAUmaHora = Math.floor(Date.now() / 1000) + 3600;
    const primeiro = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { access_token: "jwt-longo", expires_at: daquiAUmaHora } }),
    });
    vi.stubGlobal("fetch", primeiro);
    await cb();
    await cb();
    expect(primeiro, "token válido deveria vir do cache").toHaveBeenCalledTimes(1);

    // Agora um que vence em 10s: dentro da margem de renovação.
    __resetTokenDoRealtime();
    const jaVencendo = Math.floor(Date.now() / 1000) + 10;
    const segundo = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { access_token: "jwt-curto", expires_at: jaVencendo } }),
    });
    vi.stubGlobal("fetch", segundo);
    await cb();
    await cb();
    expect(segundo, "token perto de vencer deveria ser renovado").toHaveBeenCalledTimes(2);
  });
  it("resposta de contexto anterior não alimenta cache nem bootstrap novo", async () => {
    const browser = await import("@/lib/supabase/browser");
    let resolveOld!: (value: unknown) => void;
    const fetcher = vi.fn().mockReturnValueOnce(new Promise(r => { resolveOld = r; })).mockResolvedValue({ok:true,json:async()=>({data:{access_token:"novo",expires_at:Math.floor(Date.now()/1000)+3600}})});
    vi.stubGlobal("fetch",fetcher);
    const old = browser.prepareRealtimeAuthentication();
    browser.resetRealtimeAuthentication();
    const fresh = browser.prepareRealtimeAuthentication();
    resolveOld({ok:true,json:async()=>({data:{access_token:"antigo",expires_at:Math.floor(Date.now()/1000)+3600}})});
    await expect(old).rejects.toThrow();await expect(fresh).resolves.toBeUndefined();
    const cb=await callbackInstalada();await expect(cb()).resolves.toBe("novo");
  });

});
