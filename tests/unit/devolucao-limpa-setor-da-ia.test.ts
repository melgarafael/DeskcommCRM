/**
 * A DEVOLUÇÃO AO AUTOMÁTICO ENCERRA A CLASSIFICAÇÃO QUE A PRÓPRIA IA FEZ — E SÓ ELA.
 *
 * Medido numa instalação de teste (D6, 2026-11-20): a IA classificou a conversa como
 * "Departamento Técnico" por um defeito; no dia seguinte, depois de o técnico
 * atender e devolver, o mesmo cliente pediu orçamento e a conversa caiu na fila
 * técnica. `limparSetorDaIaNaDevolucao` prova, por efeito observável:
 *
 *   - setor da IA ou de automação ⇒ limpo, com a marca de origem junto, e auditado;
 *   - setor de PESSOA, ou sem marca (conta como pessoa) ⇒ fica;
 *   - a escrita é condicional ao setor lido (reclassificação concorrente ganha);
 *   - a organização filtra a leitura E a escrita (cliente de serviço não tem RLS);
 *   - módulo desligado ⇒ nada.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const auditar = vi.fn();
const moduloLigado = vi.fn();
vi.mock("@/lib/audit", () => ({ audit: (...a: unknown[]) => auditar(...a) }));
vi.mock("@/lib/instalacao/modulos", () => ({
  moduloLigado: (...a: unknown[]) => moduloLigado(...a),
}));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

import { limparSetorDaIaNaDevolucao } from "@/lib/atendimento/setor-da-conversa";

const ORG = "22222222-2222-4222-8222-222222222222";
const CONV = "44444444-4444-4444-8444-444444444444";
const SETOR = "523d5d92-3fe8-45c5-b4e2-357883021cfa";

interface Chamada {
  op: "select" | "update";
  filtros: Array<[string, unknown]>;
  valores?: Record<string, unknown>;
}

function fazerBanco(linha: Record<string, unknown> | null, opts: { updateCasa?: boolean } = {}) {
  const chamadas: Chamada[] = [];
  const db = {
    from: (tabela: string) => {
      expect(tabela).toBe("conversations");
      const atual: Chamada = { op: "select", filtros: [] };
      chamadas.push(atual);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chain: any = {
        select: () => chain,
        update: (valores: Record<string, unknown>) => {
          atual.op = "update";
          atual.valores = valores;
          return chain;
        },
        eq: (coluna: string, valor: unknown) => {
          atual.filtros.push([coluna, valor]);
          return chain;
        },
        maybeSingle: () =>
          Promise.resolve(
            atual.op === "select"
              ? { data: linha, error: null }
              : { data: opts.updateCasa === false ? null : { id: CONV }, error: null },
          ),
      };
      return chain;
    },
  };
  return { db, chamadas };
}

const ATOR = { tipo: "user" as const, userId: "11111111-1111-4111-8111-111111111111" };

async function limpar(linha: Record<string, unknown> | null, opts?: { updateCasa?: boolean }) {
  const banco = fazerBanco(linha, opts);
  const r = await limparSetorDaIaNaDevolucao({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db: banco.db as any,
    organizationId: ORG,
    conversationId: CONV,
    ator: ATOR,
    requestId: "req-1",
  });
  return { r, chamadas: banco.chamadas };
}

beforeEach(() => {
  auditar.mockReset();
  moduloLigado.mockReset();
  moduloLigado.mockResolvedValue(true);
});

describe("limparSetorDaIaNaDevolucao", () => {
  it.each([["ia"], ["automacao"]])(
    "⭐ setor gravado por `%s`: limpa a coluna E a marca, condicionado ao setor lido, e audita",
    async (origem) => {
      const { r, chamadas } = await limpar({
        sector_id: SETOR,
        metadata: {
          setor_origem: origem,
          ia_retomada: { em: "2026-11-20T20:30:19Z", por: "pessoa" },
        },
      });
      expect(r).toEqual({ limpou: true, de: SETOR });
      const update = chamadas.find((c) => c.op === "update");
      expect(update?.valores).toEqual({
        sector_id: null,
        // A marca de origem sai junto; as outras chaves do metadata ficam.
        metadata: { ia_retomada: { em: "2026-11-20T20:30:19Z", por: "pessoa" } },
      });
      expect(update?.filtros).toContainEqual(["sector_id", SETOR]);
      expect(update?.filtros).toContainEqual(["organization_id", ORG]);
      expect(auditar).toHaveBeenCalledTimes(1);
      expect(auditar.mock.calls[0]![0]).toMatchObject({
        action: "conversation.sector_changed",
        organizationId: ORG,
        resourceId: CONV,
        metadata: {
          de: SETOR,
          para: null,
          motivo: "devolucao_ao_automatico",
          origem_do_setor_limpo: origem,
        },
      });
    },
  );

  it("setor escolhido por PESSOA fica: só uma pessoa desfaz a fila que uma pessoa escolheu", async () => {
    const { r, chamadas } = await limpar({
      sector_id: SETOR,
      metadata: { setor_origem: "manual" },
    });
    expect(r).toEqual({ limpou: false, motivo: "setor_de_pessoa" });
    expect(chamadas.some((c) => c.op === "update")).toBe(false);
    expect(auditar).not.toHaveBeenCalled();
  });

  it("setor SEM marca de origem conta como pessoa (regra 4) e fica", async () => {
    const { r, chamadas } = await limpar({ sector_id: SETOR, metadata: {} });
    expect(r).toEqual({ limpou: false, motivo: "setor_de_pessoa" });
    expect(chamadas.some((c) => c.op === "update")).toBe(false);
  });

  it("conversa sem setor: nada a limpar", async () => {
    const { r } = await limpar({ sector_id: null, metadata: { setor_origem: "ia" } });
    expect(r).toEqual({ limpou: false, motivo: "sem_setor" });
  });

  it("reclassificação entre a leitura e a escrita: a escrita casa 0 linhas e nada é auditado", async () => {
    const { r } = await limpar(
      { sector_id: SETOR, metadata: { setor_origem: "ia" } },
      { updateCasa: false },
    );
    expect(r).toEqual({ limpou: false, motivo: "corrida" });
    expect(auditar).not.toHaveBeenCalled();
  });

  it("a leitura também filtra a organização: conversa de outra org não é encontrada", async () => {
    const { r, chamadas } = await limpar(null);
    expect(r).toEqual({ limpou: false, motivo: "sem_setor" });
    expect(chamadas[0]?.filtros).toContainEqual(["organization_id", ORG]);
  });

  it("módulo de setores desligado: nem lê a conversa", async () => {
    moduloLigado.mockResolvedValue(false);
    const { r, chamadas } = await limpar({ sector_id: SETOR, metadata: { setor_origem: "ia" } });
    expect(r).toEqual({ limpou: false, motivo: "setores_desligados" });
    expect(chamadas).toHaveLength(0);
  });
});
