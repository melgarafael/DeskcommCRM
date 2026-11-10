/**
 * O cache curto da cadeia de autorização (#3696) — o contrato dele, longe do
 * banco.
 *
 * O que este arquivo trava, em ordem de importância:
 *  1. `invalidarUsuario`/`invalidarOrg` derrubam o que É daquela pessoa/empresa
 *     e não tocam no resto (uma invalidação cega viraria "cache que não serve
 *     para nada"; uma que não acerta nada é o desastre da issue);
 *  2. o TTL é teto, não sugestão;
 *  3. erro de carga NÃO é cacheado — é incidente, não estado;
 *  4. cache quebrado devolve o caminho de hoje, nunca "autorizado".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  comCacheCurto,
  esquecerTudo,
  etiquetaDeOrg,
  etiquetaDeSessao,
  etiquetaDeUsuario,
  invalidarOrg,
  invalidarSessao,
  invalidarUsuario,
  sessaoDosCookies,
  tamanhoDoCacheCurto,
  TTL_CURTO_MS,
} from "./cache-curto";

const relogio = { agora: Date.UTC(2026, 9, 29, 12, 0, 0) };

beforeEach(() => {
  esquecerTudo();
  relogio.agora = Date.UTC(2026, 9, 29, 12, 0, 0);
  vi.spyOn(Date, "now").mockImplementation(() => relogio.agora);
});

afterEach(() => {
  vi.restoreAllMocks();
  esquecerTudo();
});

describe("comCacheCurto — reaproveitar entre requisições, com teto de tempo", () => {
  it("duas leituras na mesma janela fazem UMA carga", async () => {
    const carregar = vi.fn(async () => ({ papel: "admin" }));

    await comCacheCurto({ chave: "permissoes:u1", carregar });
    const segunda = await comCacheCurto({ chave: "permissoes:u1", carregar });

    expect(carregar).toHaveBeenCalledTimes(1);
    expect(segunda).toEqual({ papel: "admin" });
  });

  it("chaves diferentes não se misturam", async () => {
    const carregar = vi.fn(async () => ({ papel: "admin" }));
    await comCacheCurto({ chave: "permissoes:u1", carregar });
    await comCacheCurto({ chave: "permissoes:u2", carregar });
    expect(carregar).toHaveBeenCalledTimes(2);
  });

  it("depois do TTL (30 s) relê", async () => {
    const carregar = vi.fn(async () => "papel-admin");
    await comCacheCurto({ chave: "permissoes:u1", carregar });

    relogio.agora += TTL_CURTO_MS - 1;
    await comCacheCurto({ chave: "permissoes:u1", carregar });
    expect(carregar).toHaveBeenCalledTimes(1);

    relogio.agora += 2;
    await comCacheCurto({ chave: "permissoes:u1", carregar });
    expect(carregar).toHaveBeenCalledTimes(2);
  });

  it("`ate` (expiração do token) encurta o TTL — e o passado desliga o cache", async () => {
    const carregar = vi.fn(async () => "sessao");
    const tokenExpiraEm = relogio.agora + 10_000;

    // Entra com teto de token menor que o TTL: aos 6 s, a margem de 5 s já
    // esgotou o que dava para servir.
    await comCacheCurto({ chave: "sessao:abc", ate: tokenExpiraEm, carregar });
    relogio.agora += 6_000;
    await comCacheCurto({ chave: "sessao:abc", ate: tokenExpiraEm, carregar });
    expect(carregar).toHaveBeenCalledTimes(2);

    // Token já vencido: a carga roda e NADA é guardado.
    await comCacheCurto({ chave: "sessao:morta", ate: relogio.agora - 1, carregar });
    await comCacheCurto({ chave: "sessao:morta", ate: relogio.agora - 1, carregar });
    expect(carregar).toHaveBeenCalledTimes(4);
  });

  it("`guardar` decide o que entra: o poder de plataforma POSITIVO fica fora", async () => {
    const admin = vi.fn(async () => ({ plataforma: true }));
    const comum = vi.fn(async () => ({ plataforma: false }));
    const guardar = (v: { plataforma: boolean }) => !v.plataforma;

    await comCacheCurto({ chave: "permissoes:a", guardar, carregar: admin });
    await comCacheCurto({ chave: "permissoes:a", guardar, carregar: admin });
    // Grant de plataforma só morre por SQL, sem invalidação possível: não pode
    // ser servido do cache nem uma vez.
    expect(admin).toHaveBeenCalledTimes(2);

    await comCacheCurto({ chave: "permissoes:c", guardar, carregar: comum });
    await comCacheCurto({ chave: "permissoes:c", guardar, carregar: comum });
    // A AUSÊNCIA é segura por construção: obsoleta, ela só nega.
    expect(comum).toHaveBeenCalledTimes(1);
  });

  it("devolve CÓPIA: mexer no resultado não contamina a próxima requisição", async () => {
    const original = { memberships: [{ organization_id: "o1", role: "agent" }] };
    const primeiro = await comCacheCurto<{ memberships: { role: string }[] }>({
      chave: "permissoes:u1",
      carregar: async () => original,
    });
    primeiro.memberships[0]!.role = "admin";

    const segundo = await comCacheCurto<{ memberships: { role: string }[] }>({
      chave: "permissoes:u1",
      carregar: async () => original,
    });
    expect(segundo.memberships[0]!.role).toBe("agent");
  });
});

describe("invalidação — o que cai, e só o que tem de cair", () => {
  it("invalidarUsuario derruba permissões, papel e acompanhamento da pessoa", async () => {
    const perms = vi.fn(async () => "perms");
    const papel = vi.fn(async () => "papel");
    const suporte = vi.fn(async () => "suporte");
    const alheio = vi.fn(async () => "outro");

    const carregarTudo = async () => {
      await comCacheCurto({ chave: "permissoes:u1", etiquetas: [etiquetaDeUsuario("u1")], carregar: perms });
      await comCacheCurto({
        chave: "papel:u1:o1",
        etiquetas: [etiquetaDeUsuario("u1"), etiquetaDeOrg("o1")],
        carregar: papel,
      });
      await comCacheCurto({ chave: "suporte:u1:s1", etiquetas: [etiquetaDeUsuario("u1")], carregar: suporte });
      await comCacheCurto({ chave: "permissoes:u2", etiquetas: [etiquetaDeUsuario("u2")], carregar: alheio });
    };

    await carregarTudo();
    await carregarTudo();
    expect([perms, papel, suporte, alheio].map((f) => f.mock.calls.length)).toEqual([1, 1, 1, 1]);

    invalidarUsuario("u1");
    expect(tamanhoDoCacheCurto()).toBe(1);

    await carregarTudo();
    expect([perms, papel, suporte, alheio].map((f) => f.mock.calls.length)).toEqual([2, 2, 2, 1]);
  });

  it("invalidarOrg derruba o snapshot de TODOS os membros daquela empresa", async () => {
    const carregar = vi.fn(async () => "snapshot");

    const membro = (userId: string) =>
      comCacheCurto({
        chave: `permissoes:${userId}`,
        etiquetas: [etiquetaDeUsuario(userId)],
        // A org só se conhece DEPOIS da carga — é o caso de `org_status` nas
        // memberships (suspender a empresa muda o de todo mundo).
        etiquetasDoValor: () => [etiquetaDeOrg("o1")],
        carregar,
      });

    await membro("u1");
    await membro("u2");
    await membro("u2");
    expect(carregar).toHaveBeenCalledTimes(2);

    invalidarOrg("o1");
    await membro("u1");
    await membro("u2");
    expect(carregar).toHaveBeenCalledTimes(4);
  });

  it("invalidarSessao derruba só a sessão, sem tocar nas permissões", async () => {
    const sessao = vi.fn(async () => "usuario-validado");
    const perms = vi.fn(async () => "perms");

    await comCacheCurto({ chave: "sessao:abc", etiquetas: [etiquetaDeSessao("abc")], carregar: sessao });
    await comCacheCurto({ chave: "permissoes:u1", etiquetas: [etiquetaDeUsuario("u1")], carregar: perms });

    invalidarSessao("abc");

    await comCacheCurto({ chave: "sessao:abc", etiquetas: [etiquetaDeSessao("abc")], carregar: sessao });
    await comCacheCurto({ chave: "permissoes:u1", etiquetas: [etiquetaDeUsuario("u1")], carregar: perms });
    expect(sessao).toHaveBeenCalledTimes(2);
    expect(perms).toHaveBeenCalledTimes(1);
  });

  it("invalidar o que não existe não quebra nada (idempotente)", () => {
    expect(() => {
      invalidarUsuario("nunca-visto");
      invalidarOrg("nunca-vista");
      invalidarSessao("nunca-vista");
    }).not.toThrow();
  });
});

describe("falhas do cache — sempre para o caminho de hoje", () => {
  it("erro da CARGA não é cacheado e sobe para quem chamou", async () => {
    const carregar = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("auth_permissions_unavailable: boom"))
      .mockResolvedValueOnce("ok");

    await expect(comCacheCurto({ chave: "permissoes:u1", carregar })).rejects.toThrow(
      /auth_permissions_unavailable/,
    );
    // O erro NÃO pode virar resposta por 30 s: a segunda leitura vai ao banco.
    await expect(comCacheCurto({ chave: "permissoes:u1", carregar })).resolves.toBe("ok");
    expect(carregar).toHaveBeenCalledTimes(2);
    expect(tamanhoDoCacheCurto()).toBe(1);
  });

  it("cache inutilizável (clone falhando) carrega direto e não lança", async () => {
    vi.spyOn(globalThis, "structuredClone").mockImplementation(() => {
      throw new Error("DataCloneError");
    });
    const carregar = vi.fn(async () => "valor");

    await expect(
      comCacheCurto({ chave: "permissoes:u1", etiquetas: [etiquetaDeUsuario("u1")], carregar }),
    ).resolves.toBe("valor");
    await expect(comCacheCurto({ chave: "permissoes:u1", carregar })).resolves.toBe("valor");
    // Sem cache: duas cargas. E, principalmente, nenhuma exceção nova.
    expect(carregar).toHaveBeenCalledTimes(2);
  });

  it("ttlMs 0 desliga o cache sem mudar o resultado", async () => {
    const carregar = vi.fn(async () => "valor");
    await comCacheCurto({ chave: "k", ttlMs: 0, carregar });
    await comCacheCurto({ chave: "k", ttlMs: 0, carregar });
    expect(carregar).toHaveBeenCalledTimes(2);
  });
});

describe("sessaoDosCookies — identidade para o cache, nunca autorização", () => {
  const exp = Math.floor(Date.UTC(2026, 9, 29, 13, 0, 0) / 1000);

  function jwt(carga: Record<string, unknown>): string {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    return `${b64({ alg: "HS256" })}.${b64(carga)}.assinatura`;
  }

  function cookie(opcoes: { exp?: number; bruto?: string } = {}) {
    const sessao = { access_token: jwt({ sub: "u1", exp: opcoes.exp ?? exp }), expires_at: exp };
    return {
      name: "sb-exemplo-auth",
      value: opcoes.bruto ?? `base64-${Buffer.from(JSON.stringify(sessao)).toString("base64url")}`,
    };
  }

  it("lê a expiração do JWT dentro do cookie (o teto do cache de sessão)", () => {
    const sessao = sessaoDosCookies([cookie()]);
    expect(sessao).not.toBeNull();
    expect(sessao!.expiraEm).toBe(exp * 1000);
    expect(sessao!.chave).toMatch(/^[0-9a-f]{32}$/);
  });

  it("token rotacionado muda a chave", () => {
    const um = sessaoDosCookies([cookie({ exp: exp })]);
    const outro = sessaoDosCookies([cookie({ exp: exp + 1 })]);
    expect(um!.chave).not.toBe(outro!.chave);
  });

  it("sem cookie de sessão → null (caminho direto, como antes do #3696)", () => {
    expect(sessaoDosCookies([])).toBeNull();
    expect(sessaoDosCookies([{ name: "active_org", value: "o1" }])).toBeNull();
    expect(sessaoDosCookies([{ name: "sb-exemplo-auth-code-verifier", value: "x" }])).toBeNull();
  });

  it("valor ilegível → null, nunca exceção", () => {
    expect(sessaoDosCookies([{ name: "sb-exemplo-auth", value: "base64-%%%lixo" }])).toBeNull();
    expect(sessaoDosCookies([{ name: "sb-exemplo-auth", value: "{nao-e-json" }])).toBeNull();
  });

  it("sessão legível sem exp no JWT devolve chave e expiração nula (quem decide é o chamador)", () => {
    const sessao = sessaoDosCookies([
      {
        name: "sb-exemplo-auth",
        value: `base64-${Buffer.from(JSON.stringify({ access_token: jwt({ sub: "u1" }) })).toString("base64url")}`,
      },
    ]);
    expect(sessao?.chave).toMatch(/^[0-9a-f]{32}$/);
    expect(sessao?.expiraEm).toBeNull();
  });

  it("cookies fatiados são lidos na ordem dos nomes", () => {
    const inteiro = cookie();
    const texto = inteiro.value;
    const meio = Math.floor(texto.length / 2);
    const fatiado = sessaoDosCookies([
      { name: "sb-exemplo-auth.1", value: texto.slice(meio) },
      { name: "sb-exemplo-auth", value: texto.slice(0, meio) },
    ]);
    expect(fatiado).not.toBeNull();
    expect(fatiado!.expiraEm).toBe(exp * 1000);
    // A chave do fatiado é do CONJUNTO, e não do valor colado: é o que impede
    // duas sessões diferentes de caírem na mesma entrada.
    expect(fatiado!.chave).not.toBe(sessaoDosCookies([inteiro])!.chave);
  });
});

describe("a invalidação alcança o leitor de verdade", () => {
  it("invalidar pela ROTA derruba o que a PÁGINA guardou (duas instâncias do módulo)", async () => {
    // O Next carrega este módulo uma vez no runtime de rotas e outra no de
    // páginas, no mesmo processo. `resetModules` reproduz isso: dois imports,
    // duas instâncias. Quem grava o vínculo é a rota; quem lê é a página.
    vi.resetModules();
    const pagina = await import("./cache-curto");
    vi.resetModules();
    const rota = await import("./cache-curto");
    expect(rota).not.toBe(pagina); // controle: são instâncias distintas

    const carregar = vi.fn(async () => ({ interface: "velha" }));
    const ler = () =>
      pagina.comCacheCurto({ chave: "permissoes:u1", etiquetas: [pagina.etiquetaDeUsuario("u1")], carregar });

    await ler();
    rota.invalidarUsuario("u1");
    await ler();

    expect(carregar).toHaveBeenCalledTimes(2);
  });

  it("carga em voo durante a escrita não reinstala o valor velho", async () => {
    let soltar!: (v: string) => void;
    const lenta = vi.fn(() => new Promise<string>((r) => (soltar = r)));
    const emVoo = comCacheCurto({ chave: "permissoes:u1", etiquetas: [etiquetaDeUsuario("u1")], carregar: lenta });

    // A escrita invalida (antes e depois do UPDATE) enquanto a leitura ainda não voltou.
    invalidarUsuario("u1");
    invalidarUsuario("u1");
    soltar("pre-escrita");
    expect(await emVoo).toBe("pre-escrita"); // esta requisição já estava a caminho

    const fresca = vi.fn(async () => "pos-escrita");
    expect(
      await comCacheCurto({ chave: "permissoes:u1", etiquetas: [etiquetaDeUsuario("u1")], carregar: fresca }),
    ).toBe("pos-escrita");
    expect(fresca).toHaveBeenCalledTimes(1);
  });
});
