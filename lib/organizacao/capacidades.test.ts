import { describe, expect, it, vi } from "vitest";

import { capacidadesDaOrganizacao, capacidadesLigadas } from "./capacidades";

describe("capacidadesLigadas — só o booleano true liga", () => {
  it("proposals.enabled === true liga propostas, com o módulo da instalação ligado", () => {
    expect(capacidadesLigadas({ proposals: { enabled: true } }, ["propostas"])).toEqual(["propostas"]);
  });
  it("false, ausente, string e lixo: desligado, sem lançar", () => {
    for (const s of [
      { proposals: { enabled: false } },
      { proposals: {} },
      {},
      null,
      undefined,
      "x",
      [],
      { proposals: { enabled: "true" } },
      { proposals: "ligado" },
    ]) {
      expect(capacidadesLigadas(s, ["propostas"]), JSON.stringify(s)).toEqual([]);
    }
  });
  // Doc 79: com a chave da INSTALAÇÃO desligada, a da empresa não liga nada.
  it("módulo da instalação desligado: a empresa ligada não conta", () => {
    expect(capacidadesLigadas({ proposals: { enabled: true } }, [])).toEqual([]);
    expect(capacidadesLigadas({ proposals: { enabled: true } }, ["banco_externo"])).toEqual([]);
  });
});

/**
 * Banco falso das leituras: a linha da organização, `platform_config` e — desde a
 * #1290 — a linha de `voip_trunk_settings`. Cada tabela responde o seu, porque o
 * filtro de telefonia lê a terceira e um banco que devolvesse a mesma coisa para
 * todas esconderia justamente o caso que o teste precisa distinguir.
 */
function dbQueDevolve(
  resultado: { data: unknown; error: unknown } | Error,
  chaves: Array<{ chave: string; valor: string }> = [{ chave: "MODULO_PROPOSTAS", valor: "ligado" }],
  /** `true` = esta organização salvou o tronco SIP (telefonia em uso). */
  tronco = false,
) {
  const maybeSingle = vi.fn(async () => {
    if (resultado instanceof Error) throw resultado;
    return resultado;
  });
  const eq = vi.fn(() => ({ maybeSingle }));
  const inFn = vi.fn(async () => ({ data: chaves, error: null }));
  const select = vi.fn(() => ({ eq, in: inFn }));
  const from = vi.fn((tabela: string) => {
    if (tabela === "voip_trunk_settings") {
      // O sinal lê `.eq(...).limit(1)` e espera uma LISTA (lib/telefonia/em-uso.ts).
      const eqDoTronco = vi.fn(() => ({
        limit: vi.fn(async () => ({ data: tronco ? [{ organization_id: "org-1" }] : [], error: null })),
      }));
      return { select: vi.fn(() => ({ eq: eqDoTronco })) };
    }
    return { select };
  });
  return { db: { from } as never, from, select, eq };
}

describe("capacidadesDaOrganizacao — falha fechada", () => {
  it("lê a linha da própria organização", async () => {
    const { db, from, eq } = dbQueDevolve({ data: { settings: { proposals: { enabled: true } } }, error: null });
    expect(await capacidadesDaOrganizacao(db, "org-1")).toEqual(["propostas"]);
    expect(from).toHaveBeenCalledWith("organizations");
    expect(from).toHaveBeenCalledWith("platform_config");
    expect(eq).toHaveBeenCalledWith("id", "org-1");
  });
  it("⭐ empresa ligada, instalação sem a linha MODULO_PROPOSTAS: nenhuma", async () => {
    const { db } = dbQueDevolve({ data: { settings: { proposals: { enabled: true } } }, error: null }, []);
    expect(await capacidadesDaOrganizacao(db, "org-1")).toEqual([]);
  });
  it("empresa ligada, instalação com MODULO_PROPOSTAS = desligado: nenhuma", async () => {
    const { db } = dbQueDevolve({ data: { settings: { proposals: { enabled: true } } }, error: null }, [
      { chave: "MODULO_PROPOSTAS", valor: "desligado" },
    ]);
    expect(await capacidadesDaOrganizacao(db, "org-1")).toEqual([]);
  });
  it("erro do banco = nenhuma capacidade", async () => {
    const { db } = dbQueDevolve({ data: null, error: { message: "boom" } });
    expect(await capacidadesDaOrganizacao(db, "org-1")).toEqual([]);
  });
  it("exceção = nenhuma capacidade, sem relançar", async () => {
    const { db } = dbQueDevolve(new Error("rede"));
    await expect(capacidadesDaOrganizacao(db, "org-1")).resolves.toEqual([]);
  });
  it("organização inexistente = nenhuma", async () => {
    const { db } = dbQueDevolve({ data: null, error: null });
    expect(await capacidadesDaOrganizacao(db, "org-1")).toEqual([]);
  });
});

/**
 * #1290 — a telefonia é capacidade da ORGANIZAÇÃO, e o sinal é o tronco SIP que
 * ela mesma salvou. Não há módulo de instalação equivalente: o profile
 * `telefonia` do `COMPOSE_PROFILES` é do Docker, não do aplicativo.
 */
describe("capacidadesLigadas — telefonia pelo sinal da organização (#1290)", () => {
  it("sem tronco salvo: a capacidade não existe, mesmo com as propostas ligadas", () => {
    expect(capacidadesLigadas({ proposals: { enabled: true } }, ["propostas"])).toEqual([
      "propostas",
    ]);
  });

  it("com tronco salvo: entra na MESMA lista que o menu lê, sem consultar módulo", () => {
    expect(capacidadesLigadas({}, [], true)).toEqual(["telefonia"]);
    expect(capacidadesLigadas({ proposals: { enabled: true } }, ["propostas"], true)).toEqual([
      "propostas",
      "telefonia",
    ]);
  });

  it("tronco não depende do módulo de propostas estar ligado", () => {
    expect(capacidadesLigadas({ proposals: { enabled: true } }, [], true)).toEqual(["telefonia"]);
  });
});

describe("capacidadesDaOrganizacao — o tronco entra pela mesma leitura (#1290)", () => {
  it("organização com tronco salvo: telefonia aparece", async () => {
    const { db, from } = dbQueDevolve({ data: { settings: {} }, error: null }, [], true);
    expect(await capacidadesDaOrganizacao(db, "org-1")).toEqual(["telefonia"]);
    expect(from).toHaveBeenCalledWith("voip_trunk_settings");
  });

  it("sem tronco: nenhuma capacidade (o caso que abriu a issue)", async () => {
    const { db } = dbQueDevolve({ data: { settings: {} }, error: null }, [], false);
    expect(await capacidadesDaOrganizacao(db, "org-1")).toEqual([]);
  });

  it("erro do banco na linha da organização: nenhuma, e a leitura do tronco não relança", async () => {
    const { db } = dbQueDevolve({ data: null, error: { message: "boom" } }, [], true);
    await expect(capacidadesDaOrganizacao(db, "org-1")).resolves.toEqual([]);
  });
});
