/**
 * O BLOCO "POR EMPRESA" DE `/admin/sistema` (#3868) — o lado da ESCRITA.
 *
 * O que esta suíte prova, e por que cada caso existe:
 *
 *  - quem NÃO é platform admin não escreve: um admin de organização chamando a
 *    ação por fora da tela é recusado (ninguém liga módulo para terceiro);
 *  - entrada inválida (NaN, módulo inexistente, estado inventado, uuid torto) é
 *    `invalid_input` — recusa nomeada, nunca 500;
 *  - a instalação é TETO: ligar para a empresa um módulo desligado no servidor é
 *    recusado com mensagem, em vez de gravar uma linha que não vale;
 *  - DESLIGAR não apaga nada: a escrita só toca `organization_modules`;
 *  - `herda` é APAGAR a linha (voltar ao padrão), nunca um upsert de "herda".
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({
  escrita: vi.fn(),
  audit: vi.fn(),
  revalidar: vi.fn(),
  tabelas: [] as string[],
  upsert: vi.fn(),
  delete: vi.fn(),
  linhaAnterior: null as { estado: string } | null,
  empresaExiste: true,
  /** Chaves de `platform_config` com valor `ligado` na instalação. */
  flagsLigadas: [] as string[],
  erroDeLeituraDaEmpresa: null as { code: string; message: string } | null,
}));

vi.mock("@/lib/auth/requirePlatformAdmin", () => ({ requirePlatformAdminEscrita: () => deps.escrita() }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/cache", () => ({ revalidatePath: deps.revalidar }));
vi.mock("@/lib/audit", () => ({ audit: deps.audit }));

/**
 * Cliente falso mínimo, mas FIEL no que importa: cada `.from()` é registrado, e
 * `organization_modules` responde à leitura da linha anterior, ao upsert e ao
 * delete. É o registro de tabelas tocadas que prova "desligar não apaga".
 */
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      deps.tabelas.push(tabela);
      const filtros: Array<[string, unknown]> = [];
      const builder = {
        select: () => builder,
        in: () => builder,
        eq: (coluna: string, valor: unknown) => {
          filtros.push([coluna, valor]);
          return builder;
        },
        maybeSingle: async () => {
          if (tabela === "organizations") {
            if (deps.erroDeLeituraDaEmpresa) return { data: null, error: deps.erroDeLeituraDaEmpresa };
            return { data: deps.empresaExiste ? { id: filtros[0]?.[1] ?? "org" } : null, error: null };
          }
          if (tabela === "organization_modules") return { data: deps.linhaAnterior, error: null };
          return { data: null, error: null };
        },
        // `modulosLigados` faz `await db.from(...).select(...).in(...)`: a cadeia é
        // aguardada direto, sem `maybeSingle`.
        then: (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
          Promise.resolve(
            tabela === "platform_config"
              ? {
                  data: deps.flagsLigadas.map((chave) => ({ chave, valor: "ligado" })),
                  error: null,
                }
              : { data: [], error: null },
          ).then(onFulfilled, onRejected),
        upsert: deps.upsert,
        delete: () => ({ eq: () => ({ eq: deps.delete }) }),
      };
      return builder;
    },
  }),
}));

import { EscritaDePlatformAdminNegada } from "@/lib/auth/recusa-de-escrita-de-admin";

import { updateModuloDaEmpresa } from "./updateModuloDaEmpresa";

const ORG = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const acoes = () => deps.audit.mock.calls.map((c) => (c[0] as { action: string }).action);

beforeEach(() => {
  vi.clearAllMocks();
  deps.tabelas.length = 0;
  deps.linhaAnterior = null;
  deps.empresaExiste = true;
  deps.flagsLigadas = ["MODULO_PROPOSTAS"];
  deps.erroDeLeituraDaEmpresa = null;
  deps.escrita.mockResolvedValue({ user: { id: "eu" }, is_platform_admin: true });
  deps.upsert.mockResolvedValue({ error: null });
  deps.delete.mockResolvedValue({ error: null });
});

describe("quem pode escrever", () => {
  it("admin de organização (fora da plataforma) é recusado e nada é gravado", async () => {
    deps.escrita.mockRejectedValue(new EscritaDePlatformAdminNegada("forbidden_scope"));

    const r = await updateModuloDaEmpresa({ organizationId: ORG, modulo: "propostas", estado: "ligado" });

    expect(r).toEqual({ ok: false, error: "forbidden_scope" });
    expect(deps.upsert).not.toHaveBeenCalled();
    expect(deps.delete).not.toHaveBeenCalled();
    expect(deps.tabelas).toEqual([]);
  });
});

describe("entrada inválida — recusa, nunca 500", () => {
  it.each([
    ["organização que não é uuid", { organizationId: "NaN", modulo: "propostas", estado: "ligado" }],
    ["módulo inexistente", { organizationId: ORG, modulo: "propostas;drop table", estado: "ligado" }],
    ["módulo fora da camada por empresa", { organizationId: ORG, modulo: "cobranca", estado: "ligado" }],
    ["estado inventado", { organizationId: ORG, modulo: "propostas", estado: "talvez" }],
    ["estado numérico", { organizationId: ORG, modulo: "propostas", estado: 10 }],
  ])("%s", async (_caso, entrada) => {
    const r = await updateModuloDaEmpresa(entrada as never);
    expect(r).toEqual({ ok: false, error: "invalid_input" });
    expect(deps.upsert).not.toHaveBeenCalled();
    expect(deps.delete).not.toHaveBeenCalled();
  });
});

describe("empresa que não existe", () => {
  it("recusa nomeada, sem upsert e sem erro de FK virando 500", async () => {
    deps.empresaExiste = false;
    const r = await updateModuloDaEmpresa({ organizationId: ORG, modulo: "propostas", estado: "ligado" });
    expect(r).toEqual({ ok: false, error: "organizacao_inexistente" });
    expect(deps.upsert).not.toHaveBeenCalled();
  });

  it("leitura da empresa que falhou também recusa (não grava no escuro)", async () => {
    deps.erroDeLeituraDaEmpresa = { code: "42P01", message: "relation does not exist" };
    const r = await updateModuloDaEmpresa({ organizationId: ORG, modulo: "propostas", estado: "ligado" });
    expect(r).toEqual({ ok: false, error: "organizacao_inexistente" });
    expect(deps.upsert).not.toHaveBeenCalled();
  });
});

describe("a instalação é TETO", () => {
  it("ligar módulo desligado na instalação é recusado com mensagem, e nada é gravado", async () => {
    deps.flagsLigadas = [];
    const r = await updateModuloDaEmpresa({ organizationId: ORG, modulo: "propostas", estado: "ligado" });
    expect(r).toEqual({ ok: false, error: "modulo_desligado_na_instalacao" });
    expect(deps.upsert).not.toHaveBeenCalled();
  });

  it("com a instalação ligada, a linha da empresa grava `ligado`", async () => {
    const r = await updateModuloDaEmpresa({ organizationId: ORG, modulo: "propostas", estado: "ligado" });
    expect(r).toEqual({ ok: true });
    expect(deps.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ organization_id: ORG, modulo: "propostas", estado: "ligado", updated_by: "eu" }),
      { onConflict: "organization_id,modulo" },
    );
    expect(acoes()).toEqual(["organization.modulo_updated"]);
  });
});

describe("desligar não apaga dado", () => {
  it("grava `desligado` tocando SÓ a tabela da decisão (organizations + organization_modules)", async () => {
    deps.linhaAnterior = { estado: "ligado" };
    const r = await updateModuloDaEmpresa({ organizationId: ORG, modulo: "propostas", estado: "desligado" });

    expect(r).toEqual({ ok: true });
    expect(deps.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ organization_id: ORG, modulo: "propostas", estado: "desligado" }),
      { onConflict: "organization_id,modulo" },
    );
    // Nenhuma tabela do módulo (proposals, crm_*, cobranca_*, ...) é tocada: a
    // decisão é uma linha, e o dado da empresa continua onde está.
    expect([...new Set(deps.tabelas)].sort()).toEqual(["organization_modules", "organizations"]);
    expect(deps.delete).not.toHaveBeenCalled();
  });

  it("`herda` apaga a linha da empresa (volta ao padrão) e não faz upsert", async () => {
    deps.linhaAnterior = { estado: "desligado" };
    const r = await updateModuloDaEmpresa({ organizationId: ORG, modulo: "propostas", estado: "herda" });

    expect(r).toEqual({ ok: true });
    expect(deps.delete).toHaveBeenCalledTimes(1);
    expect(deps.upsert).not.toHaveBeenCalled();
  });
});

describe("falha de escrita", () => {
  it("erro do banco no upsert vira write_failed, sem auditoria de sucesso", async () => {
    deps.upsert.mockResolvedValue({ error: { code: "23514", message: "check" } });
    const r = await updateModuloDaEmpresa({ organizationId: ORG, modulo: "propostas", estado: "ligado" });
    expect(r).toEqual({ ok: false, error: "write_failed" });
    expect(acoes()).toEqual([]);
  });
});
