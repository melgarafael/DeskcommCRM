/**
 * O MÓDULO OPCIONAL POR EMPRESA (issue #3868).
 *
 * Até aqui o interruptor de `/admin/sistema` era da INSTALAÇÃO: ligar `propostas`
 * ligava para todas as empresas do servidor. Quem revende não tinha como dar o
 * módulo a um cliente e negar a outro.
 *
 * A regra desta camada, e a ordem importa:
 *
 *   1. a linha da EMPRESA vence (`ligado` / `desligado`);
 *   2. sem linha, a empresa HERDA a instalação — ninguém que nunca configurou
 *      sente diferença;
 *   3. instalação desligada vence a linha da empresa, sempre: o servidor é TETO
 *      (a empresa não inventa um módulo que abre porta de rede/credencial que o
 *      dono do servidor não autorizou).
 *
 * Módulo de TABELA (`honorarios`, `financeiro` — ADR-0002) fica FORA desta
 * camada de propósito: o dado já foi provisionado por organização e desligar aí
 * é outra conversa (F3 do #3868).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import { abrirAcesso } from "@/lib/external-db/acesso";

import { moduloLigado, modulosLigados } from "./modulos";

type LinhaDaEmpresa = { organization_id: string; modulo: string; estado: string };
type Resposta = { data?: unknown; error?: unknown } | Error;

/**
 * Cliente falso que HONRA o `.eq("organization_id", …)`: é o que prova que a
 * leitura é da empresa pedida, e não da instalação nem da empresa vizinha.
 * Cada tabela pode responder com dado, com erro do PostgREST, ou lançar.
 */
function banco(porTabela: Record<string, Resposta> = {}) {
  const from = vi.fn((table: string) => {
    const resposta = porTabela[table] ?? { data: [], error: null };
    let filtroDeOrg: string | null = null;
    const resolver = () => {
      if (resposta instanceof Error) return Promise.reject(resposta);
      const dados = resposta.data ?? null;
      if (filtroDeOrg !== null && Array.isArray(dados)) {
        return Promise.resolve({
          data: (dados as LinhaDaEmpresa[]).filter((l) => l.organization_id === filtroDeOrg),
          error: resposta.error ?? null,
        });
      }
      return Promise.resolve({ data: dados, error: resposta.error ?? null });
    };
    const builder = {
      select: () => builder,
      in: () => builder,
      // Só a coluna de tenant filtra; o resto da cadeia é ruído do PostgREST.
      eq: (coluna: string, valor: string) => {
        if (coluna === "organization_id") filtroDeOrg = valor;
        return builder;
      },
      maybeSingle: () => builder,
      then: (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
        resolver().then(onFulfilled, onRejected),
    };
    return builder;
  });
  return { db: { from } as unknown as SupabaseClient, from };
}

/** A instalação com `propostas` ligado — o cenário de quem revende. */
const INSTALACAO_COM_PROPOSTAS = {
  platform_config: { data: [{ chave: "MODULO_PROPOSTAS", valor: "ligado" }] },
};

describe("módulo por empresa — a linha da empresa vence a instalação", () => {
  it("RED/GREEN: A desligado e B ligado ao mesmo tempo, com a instalação ligada", async () => {
    const { db } = banco({
      ...INSTALACAO_COM_PROPOSTAS,
      organization_modules: {
        data: [
          { organization_id: "empresa-a", modulo: "propostas", estado: "desligado" },
          { organization_id: "empresa-b", modulo: "propostas", estado: "ligado" },
        ],
      },
    });

    // O pedido literal da issue: dar o módulo a um cliente e negar a outro.
    expect(await moduloLigado(db, "propostas", "empresa-b")).toBe(true);
    expect(await moduloLigado(db, "propostas", "empresa-a")).toBe(false);
  });

  it("linha `desligado` tira o módulo da lista da empresa e não da vizinha", async () => {
    const { db } = banco({
      ...INSTALACAO_COM_PROPOSTAS,
      organization_modules: {
        data: [{ organization_id: "empresa-a", modulo: "propostas", estado: "desligado" }],
      },
    });

    expect(await modulosLigados(db, "empresa-a")).toEqual([]);
    // A vizinha não tem linha: herda a instalação (item 2 da regra).
    expect(await modulosLigados(db, "empresa-b")).toEqual(["propostas"]);
  });

  it("só `ligado` liga: valor estranho na linha conta como desligado", async () => {
    // Mesma régua da `platform_config` (0341) e a CHECK do banco recusa o resto:
    // se um `LIGADO` maiúsculo entrar por SQL manual, ele NÃO liga nada.
    const { db } = banco({
      ...INSTALACAO_COM_PROPOSTAS,
      organization_modules: {
        data: [{ organization_id: "empresa-a", modulo: "propostas", estado: "LIGADO" }],
      },
    });
    expect(await moduloLigado(db, "propostas", "empresa-a")).toBe(false);
  });
});

describe("módulo por empresa — a instalação é o TETO", () => {
  it("instalação desligada vence a linha `ligado` da empresa", async () => {
    const { db } = banco({
      organization_modules: {
        data: [{ organization_id: "empresa-b", modulo: "propostas", estado: "ligado" }],
      },
    });
    expect(await moduloLigado(db, "propostas", "empresa-b")).toBe(false);
    expect(await modulosLigados(db, "empresa-b")).toEqual([]);
  });
});

describe("módulo por empresa — herança e o comportamento de hoje", () => {
  it("sem organização no parâmetro, nada muda: a instalação responde sozinha", async () => {
    const { db, from } = banco(INSTALACAO_COM_PROPOSTAS);
    expect(await modulosLigados(db)).toEqual(["propostas"]);
    // Sem empresa, `organization_modules` nem é tocada: nenhuma consulta a mais
    // no caminho de quem não passa organização (87 arquivos ainda passam sem).
    expect(from).toHaveBeenCalledTimes(2);
    expect(from).not.toHaveBeenCalledWith("organization_modules");
  });

  it("empresa sem nenhuma linha herda a instalação inteira", async () => {
    const { db } = banco({
      platform_config: {
        data: [
          { chave: "MODULO_PROPOSTAS", valor: "ligado" },
          { chave: "MODULO_SETORES", valor: "ligado" },
        ],
      },
    });
    expect(await modulosLigados(db, "empresa-nova")).toEqual(["propostas", "setores"]);
  });

  it("a resposta da empresa A nunca é a da empresa B (duas organizações, uma consulta)", async () => {
    const { db } = banco({
      ...INSTALACAO_COM_PROPOSTAS,
      organization_modules: {
        data: [
          { organization_id: "empresa-a", modulo: "propostas", estado: "desligado" },
          { organization_id: "empresa-b", modulo: "propostas", estado: "ligado" },
        ],
      },
    });
    const a = await modulosLigados(db, "empresa-a");
    const b = await modulosLigados(db, "empresa-b");
    expect(a).not.toEqual(b);
    expect([a, b]).toEqual([[], ["propostas"]]);
  });

  it("módulo de TABELA (ADR-0002) fica fora da camada por empresa", async () => {
    const { db } = banco({
      modulos_instalados: { data: [{ modulo: "honorarios", estado: "ativo" }] },
      organization_modules: {
        data: [{ organization_id: "empresa-a", modulo: "honorarios", estado: "desligado" }],
      },
    });
    // F3 do #3868: desligar honorários por empresa mexeria em dado já
    // provisionado; a linha seria ignorada — e é isto que este teste trava.
    expect(await modulosLigados(db, "empresa-a")).toEqual(["honorarios"]);
  });
});

describe("módulo por empresa — falha fechada", () => {
  it("leitura recusada da tabela por empresa = módulo desligado, sem lançar", async () => {
    const recusado = banco({
      ...INSTALACAO_COM_PROPOSTAS,
      organization_modules: { error: { code: "42P01", message: "relation does not exist" } },
    });
    expect(await moduloLigado(recusado.db, "propostas", "empresa-b")).toBe(false);

    const lancado = banco({
      ...INSTALACAO_COM_PROPOSTAS,
      organization_modules: new Error("rede"),
    });
    expect(await moduloLigado(lancado.db, "propostas", "empresa-b")).toBe(false);
  });
});

describe("runtime: a porta do banco externo nega para a empresa, não para a instalação", () => {
  it("instalação ligada + empresa `desligado` = modulo_desligado, sem ler credencial", async () => {
    const { db, from } = banco({
      platform_config: { data: [{ chave: "MODULO_BANCO_EXTERNO", valor: "ligado" }] },
      organization_modules: {
        data: [{ organization_id: "empresa-a", modulo: "banco_externo", estado: "desligado" }],
      },
    });

    const acesso = await abrirAcesso(db, "empresa-a", "conexao");
    expect(acesso).toEqual({ ok: false, motivo: "modulo_desligado" });
    // Nenhuma linha de `external_db_connections` é lida: a recusa é da PORTA.
    expect(from).not.toHaveBeenCalledWith("external_db_connections");
  });
});

describe("a tela: três estados por módulo (herda / ligado / desligado)", () => {
  it("mostra o estado da empresa, o efetivo e o bloqueio da instalação", async () => {
    const { resolverModulosDaEmpresa, MODULOS_POR_EMPRESA } = await import("./modulos-por-empresa");

    const modulos = resolverModulosDaEmpresa(["propostas", "crm_b2b"], [
      { modulo: "propostas", estado: "desligado" },
      { modulo: "crm_b2b", estado: "ligado" },
    ]);

    // A ordem é a da lista do gate, para a tela não dançar entre recarregamentos.
    expect(modulos.map((m) => m.modulo)).toEqual([...MODULOS_POR_EMPRESA]);

    const porModulo = new Map(modulos.map((m) => [m.modulo, m]));
    // Linha `desligado` com a instalação ligada: a empresa escolheu não ter.
    expect(porModulo.get("propostas")).toEqual({
      modulo: "propostas",
      estado: "desligado",
      efetivo: false,
      bloqueadoPelaInstalacao: false,
    });
    // Linha `ligado` e instalação ligada: efetivo.
    expect(porModulo.get("crm_b2b")).toEqual({
      modulo: "crm_b2b",
      estado: "ligado",
      efetivo: true,
      bloqueadoPelaInstalacao: false,
    });
    // Sem linha: herda — e herda DESLIGADO, porque a instalação não tem.
    expect(porModulo.get("setores")).toEqual({
      modulo: "setores",
      estado: "herda",
      efetivo: false,
      bloqueadoPelaInstalacao: true,
    });
  });

  it("instalação desligada bloqueia o interruptor mesmo com a empresa em `ligado`", async () => {
    const { resolverModulosDaEmpresa } = await import("./modulos-por-empresa");
    const modulos = resolverModulosDaEmpresa([], [{ modulo: "setores", estado: "ligado" }]);
    const setores = modulos.find((m) => m.modulo === "setores");
    expect(setores).toMatchObject({ estado: "ligado", efetivo: false, bloqueadoPelaInstalacao: true });
  });

  it("valor estranho na linha aparece como `desligado`, não como herança", async () => {
    const { resolverModulosDaEmpresa } = await import("./modulos-por-empresa");
    const modulos = resolverModulosDaEmpresa(["propostas"], [{ modulo: "propostas", estado: "LIGADO" }]);
    expect(modulos.find((m) => m.modulo === "propostas")).toMatchObject({ estado: "desligado", efetivo: false });
  });
});
