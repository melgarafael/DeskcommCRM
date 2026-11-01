import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TemaDeExtensao } from "@/lib/extensions/tema";

const mocks = vi.hoisted(() => ({
  admin: vi.fn(),
  valorDaInstalacao: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mocks.admin }));
vi.mock("@/lib/instalacao/config", () => ({
  valorDaInstalacao: mocks.valorDaInstalacao,
  gravarPelaTela: vi.fn(),
  voltarAoAmbiente: vi.fn(),
}));

import {
  CHAVE_TEMA_DA_PLATAFORMA,
  conferirTemaDaPlataforma,
  cssDoTemaDaPlataforma,
  idDoTemaDaPlataforma,
  invalidarTemaDaPlataforma,
  temasInstaladosDaPlataforma,
} from "@/lib/extensions/tema-da-plataforma";

/**
 * A LEITURA DO TEMA DA PLATAFORMA (#3790) — do banco até o texto do `<style>`.
 *
 * ── O que este arquivo existe para provar ─────────────────────────────────
 *
 * O elo que o construtor de CSS não cobre: dado o id gravado em
 * `platform_config`, a leitura precisa (a) buscar a INSTALAÇÃO da extensão,
 * (b) recusar instalação removida, (c) validar o manifesto e (d) montar o bloco
 * no escopo da instalação, sem as chaves `--color-accent*`.
 *
 * E o contrato que o layout raiz depende: NUNCA lançar. Este módulo roda em
 * `app/layout.tsx`, ou seja, em toda tela — inclusive o login. Falha de banco
 * aqui tem de virar "sem `<style>`" (paleta de fábrica) com aviso no log, e não
 * 500 na tela onde alguém corrigiria o problema.
 *
 * ── O caso comum é a ausência ─────────────────────────────────────────────
 *
 * Instalação sem escolha não tem linha em `platform_config`; nesse caso o
 * banco de extensões NEM é consultado, e o CSS é `null`. É o que garante "nada
 * muda para quem não usa".
 */

const TEMA: TemaDeExtensao = {
  palette: "mist",
  claro: {
    "--color-bg": "#f6f6f4",
    "--color-border": "#e7e3da",
    "--color-accent": "var(--color-accent-600)",
    "--color-accent-600": "#33475b",
  },
  escuro: {
    "--color-bg": "#11151c",
    "--color-border": "#2a2f38",
    "--color-accent": "var(--color-accent-400)",
    "--color-accent-400": "#8fa8be",
  },
};

const INSTALACAO = {
  id: "11111111-1111-4111-8111-111111111111",
  publisher: "acme",
  name: "tema-do-cliente",
  version: "1.2.0",
  removed_at: null,
  extension_artifacts: { manifest: { contributions: { theme: TEMA } } },
};

type Resultado = { data: unknown; error: unknown };

/**
 * O dublê do PostgREST: encadeia os métodos do construtor e resolve no
 * terminal (`maybeSingle`) ou no `await` da cadeia (`then`), como o cliente de
 * verdade faz. `leituras` conta as consultas para provar que o caso "sem
 * escolha" não toca no banco.
 */
function clienteFalso(resultado: () => Resultado) {
  const leituras: string[] = [];
  const construtor = {
    select: () => construtor,
    eq: () => construtor,
    is: () => construtor,
    order: () => construtor,
    limit: () => construtor,
    maybeSingle: async () => resultado(),
    then: (ok: (v: Resultado) => unknown, falha?: (e: unknown) => unknown) =>
      Promise.resolve(resultado()).then(ok, falha),
  };
  return {
    leituras,
    from: (tabela: string) => {
      leituras.push(tabela);
      return construtor;
    },
  };
}

describe("leitura do tema da plataforma", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidarTemaDaPlataforma();
    mocks.valorDaInstalacao.mockResolvedValue({ valor: null, fonte: "env" });
    mocks.admin.mockReturnValue(clienteFalso(() => ({ data: null, error: null })));
  });

  it("sem escolha, não consulta extensão nenhuma e não emite CSS", async () => {
    const db = clienteFalso(() => ({ data: null, error: null }));
    mocks.admin.mockReturnValue(db);

    expect(await cssDoTemaDaPlataforma(false)).toBeNull();
    expect(mocks.valorDaInstalacao).toHaveBeenCalledWith(CHAVE_TEMA_DA_PLATAFORMA);
    expect(db.leituras).toEqual([]);
  });

  it("com tema escolhido, o CSS sai em `:root:root`, sem accent e sem o seletor da organização", async () => {
    mocks.valorDaInstalacao.mockResolvedValue({ valor: INSTALACAO.id, fonte: "banco" });
    mocks.admin.mockReturnValue(clienteFalso(() => ({ data: INSTALACAO, error: null })));

    const css = await cssDoTemaDaPlataforma(false);

    expect(css).not.toBeNull();
    expect(css).toContain(":root:root {");
    expect(css).toContain(':root:root[data-theme="dark"] {');
    expect(css).toContain("--color-bg: #f6f6f4");
    expect(css).not.toContain("--color-accent");
    expect(css).not.toContain("body:has");
  });

  it("instalação removida (sem linha vigente) não pinta nada", async () => {
    mocks.valorDaInstalacao.mockResolvedValue({ valor: INSTALACAO.id, fonte: "banco" });
    mocks.admin.mockReturnValue(clienteFalso(() => ({ data: null, error: null })));

    expect(await cssDoTemaDaPlataforma(false)).toBeNull();
  });

  it("falha do banco não lança: paleta de fábrica", async () => {
    mocks.valorDaInstalacao.mockResolvedValue({ valor: INSTALACAO.id, fonte: "banco" });
    mocks.admin.mockReturnValue(
      clienteFalso(() => ({ data: null, error: { message: "connection reset" } })),
    );

    await expect(cssDoTemaDaPlataforma(false)).resolves.toBeNull();
  });

  it("manifesto sem tema válido não pinta nada", async () => {
    mocks.valorDaInstalacao.mockResolvedValue({ valor: INSTALACAO.id, fonte: "banco" });
    mocks.admin.mockReturnValue(
      clienteFalso(() => ({
        data: { ...INSTALACAO, extension_artifacts: { manifest: { contributions: {} } } },
        error: null,
      })),
    );

    expect(await cssDoTemaDaPlataforma(false)).toBeNull();
  });

  it("`?sem_css=1` desliga a folha sem tocar no banco", async () => {
    mocks.valorDaInstalacao.mockResolvedValue({ valor: INSTALACAO.id, fonte: "banco" });
    const db = clienteFalso(() => ({ data: INSTALACAO, error: null }));
    mocks.admin.mockReturnValue(db);

    expect(await cssDoTemaDaPlataforma(true)).toBeNull();
    expect(mocks.valorDaInstalacao).not.toHaveBeenCalled();
    expect(db.leituras).toEqual([]);
  });

  it("a invalidação derruba o memo: a escolha nova é lida na tela seguinte", async () => {
    mocks.valorDaInstalacao.mockResolvedValue({ valor: INSTALACAO.id, fonte: "banco" });
    mocks.admin.mockReturnValue(clienteFalso(() => ({ data: INSTALACAO, error: null })));
    expect(await cssDoTemaDaPlataforma(false)).not.toBeNull();

    // A escolha foi apagada ("Nenhum") e a ação invalidou o memo.
    mocks.valorDaInstalacao.mockResolvedValue({ valor: null, fonte: "env" });
    invalidarTemaDaPlataforma();

    expect(await cssDoTemaDaPlataforma(false)).toBeNull();
  });
});

describe("o que a tela Marca oferece, e o que a ação confere", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidarTemaDaPlataforma();
  });

  it("a lista traz só instalações que declaram tema, com o rótulo da tela de extensões", async () => {
    mocks.admin.mockReturnValue(
      clienteFalso(() => ({
        data: [
          INSTALACAO,
          {
            id: "22222222-2222-4222-8222-222222222222",
            publisher: "acme",
            name: "sem-tema",
            version: "0.9.0",
            removed_at: null,
            extension_artifacts: { manifest: { contributions: {} } },
          },
        ],
        error: null,
      })),
    );

    const temas = await temasInstaladosDaPlataforma();

    expect(temas).toHaveLength(1);
    expect(temas[0]).toEqual({
      instalacaoId: INSTALACAO.id,
      rotulo: "acme/tema-do-cliente",
      versao: "1.2.0",
      tema: TEMA,
    });
  });

  it("a conferência da ação recusa instalação que não existe", async () => {
    mocks.admin.mockReturnValue(clienteFalso(() => ({ data: null, error: null })));

    expect(await conferirTemaDaPlataforma(INSTALACAO.id)).toEqual({
      ok: false,
      motivo: "nao_instalada",
    });
  });

  it("a conferência da ação aceita a instalação com tema válido e malha de transporte separada", async () => {
    mocks.admin.mockReturnValue(clienteFalso(() => ({ data: INSTALACAO, error: null })));
    expect(await conferirTemaDaPlataforma(INSTALACAO.id)).toEqual({ ok: true, tema: TEMA });

    mocks.admin.mockReturnValue(
      clienteFalso(() => ({ data: null, error: { message: "timeout" } })),
    );
    expect(await conferirTemaDaPlataforma(INSTALACAO.id)).toEqual({
      ok: false,
      motivo: "banco_indisponivel",
    });
  });

  it("o id gravado é lido da chave da plataforma, e vazio é ausência", async () => {
    mocks.valorDaInstalacao.mockResolvedValue({ valor: "   ", fonte: "banco" });
    expect(await idDoTemaDaPlataforma()).toBeNull();

    mocks.valorDaInstalacao.mockResolvedValue({ valor: INSTALACAO.id, fonte: "banco" });
    expect(await idDoTemaDaPlataforma()).toBe(INSTALACAO.id);
    expect(mocks.valorDaInstalacao).toHaveBeenCalledWith("APP_TEMA_DA_PLATAFORMA");
  });
});
