import { describe, expect, it } from "vitest";

import type { McpContext } from "@/lib/mcp/types";
import { crmFindAcademiaClasses } from "@/lib/mcp/tools/academia";

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;

class FakeQuery implements PromiseLike<{ data: Row[]; error: { message: string } | null }> {
  private filters: Array<(row: Row) => boolean> = [];
  private ordering: Array<{ column: string; ascending: boolean }> = [];
  private maximum: number | null = null;

  constructor(
    private readonly rows: Row[],
    private readonly failure: string | null,
  ) {}

  select(): this { return this; }
  eq(column: string, value: unknown): this {
    this.filters.push((row) => row[column] === value);
    return this;
  }
  in(column: string, values: readonly unknown[]): this {
    this.filters.push((row) => values.includes(row[column]));
    return this;
  }
  gte(column: string, value: string): this {
    this.filters.push((row) => String(row[column]) >= value);
    return this;
  }
  lt(column: string, value: string): this {
    this.filters.push((row) => String(row[column]) < value);
    return this;
  }
  order(column: string, options?: { ascending?: boolean }): this {
    this.ordering.push({ column, ascending: options?.ascending !== false });
    return this;
  }
  limit(value: number): this {
    this.maximum = value;
    return this;
  }
  async maybeSingle(): Promise<{ data: Row | null; error: { message: string } | null }> {
    const result = this.result();
    return { data: result.data[0] ?? null, error: result.error };
  }
  then<TResult1 = { data: Row[]; error: { message: string } | null }, TResult2 = never>(
    onfulfilled?: ((value: { data: Row[]; error: { message: string } | null }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.result()).then(onfulfilled, onrejected);
  }

  private result(): { data: Row[]; error: { message: string } | null } {
    if (this.failure) return { data: [], error: { message: this.failure } };
    let data = this.rows.filter((row) => this.filters.every((filter) => filter(row)));
    data = [...data].sort((left, right) => {
      for (const { column, ascending } of this.ordering) {
        const comparison = String(left[column]).localeCompare(String(right[column]));
        if (comparison !== 0) return ascending ? comparison : -comparison;
      }
      return 0;
    });
    if (this.maximum !== null) data = data.slice(0, this.maximum);
    return { data, error: null };
  }
}

function baseTables(academia = true): Tables {
  return {
    organizations: [
      { id: "org-1", settings: { modules: { academia } } },
      { id: "org-2", settings: { modules: { academia: true } } },
    ],
    academia_modalities: [
      { id: "m1", organization_id: "org-1", name: "CrossFit", aliases: ["Cross fit", "Cross"], active: true },
      { id: "m2", organization_id: "org-1", name: "Ciclismo", aliases: ["Spinning"], active: true },
      { id: "m-outro", organization_id: "org-2", name: "CrossFit", aliases: ["Cross fit"], active: true },
    ],
    academia_audiences: [
      { id: "p1", organization_id: "org-1", name: "Adulto", active: true },
      { id: "p2", organization_id: "org-1", name: "Infantil", active: true },
      { id: "p-outro", organization_id: "org-2", name: "Adulto", active: true },
    ],
    academia_teachers: [
      { id: "t1", organization_id: "org-1", name: "A definir", active: true },
      { id: "t2", organization_id: "org-1", name: "Maria", active: true },
      { id: "t-inativo", organization_id: "org-1", name: "Professor antigo", active: false },
      { id: "t-outro", organization_id: "org-2", name: "Outro professor", active: true },
    ],
    academia_spaces: [
      { id: "s1", organization_id: "org-1", name: "Box", active: true },
      { id: "s-outro", organization_id: "org-2", name: "Box externo", active: true },
    ],
    academia_weekly_classes: [
      {
        id: "aula-1", organization_id: "org-1", modality_id: "m1", audience_id: "p1",
        teacher_id: "t1", space_id: "s1", weekday: 1, start_time: "08:00:00",
        duration_minutes: 60, notes: "Capacidade: 50", active: true,
      },
      {
        id: "aula-noite", organization_id: "org-1", modality_id: "m1", audience_id: "p2",
        teacher_id: "t2", space_id: "s1", weekday: 1, start_time: "18:00:00",
        duration_minutes: 45, notes: "", active: true,
      },
      {
        id: "aula-vinculo-inativo", organization_id: "org-1", modality_id: "m1", audience_id: "p1",
        teacher_id: "t-inativo", space_id: "s1", weekday: 2, start_time: "09:00:00",
        duration_minutes: 30, notes: "", active: true,
      },
      {
        id: "aula-outro-tenant", organization_id: "org-2", modality_id: "m-outro", audience_id: "p-outro",
        teacher_id: "t-outro", space_id: "s-outro", weekday: 1, start_time: "09:00:00",
        duration_minutes: 90, notes: "", active: true,
      },
    ],
  };
}

function context(tables: Tables, failures: Record<string, string> = {}): McpContext {
  return {
    organizationId: "org-1",
    role: "agent",
    actor: { type: "ai_agent", id: "agent-1", role: "ai_operator" },
    apiTokenId: "token-1",
    requestId: "request-1",
    supabase: {
      from: (table: string) => new FakeQuery(tables[table] ?? [], failures[table] ?? null),
    } as never,
  };
}

describe("crm_find_academia_classes", () => {
  it("responde o CrossFit de segunda pela manhã sem ids, notas ou capacidade", async () => {
    const result = await crmFindAcademiaClasses.handler(
      { modalidade: "Cross fit", dia_semana: 1, periodo: "manha", limite: 10 },
      context(baseTables()),
    );

    expect(result).toEqual({
      tipo_grade: "semanal_regular",
      modalidade: "CrossFit",
      filtros: { dia_semana: 1, periodo: "manha" },
      aulas: [{
        dia_semana: 1,
        dia: "Segunda-feira",
        inicio: "08:00",
        fim: "09:00",
        duracao_minutos: 60,
        publico: "Adulto",
        professor: "A definir",
        ambiente: "Box",
        pendencias: ["professor"],
      }],
      total: 1,
      ha_mais: false,
    });
    expect(JSON.stringify(result)).not.toMatch(/aula-1|Capacidade|notes|observacoes/);
  });

  it("não mistura a aula homônima de outra organização", async () => {
    const result = await crmFindAcademiaClasses.handler(
      { modalidade: "CrossFit", dia_semana: 1, limite: 10 },
      context(baseTables()),
    ) as { aulas: Array<{ inicio: string }> };
    const serializado = JSON.stringify(result);
    expect(result.aulas.map((aula) => aula.inicio)).not.toContain("09:00");
    expect(serializado).not.toMatch(/Outro professor|Box externo/);
  });

  it("falha fechado quando o módulo está desligado", async () => {
    await expect(
      crmFindAcademiaClasses.handler(
        { modalidade: "CrossFit", limite: 10 },
        context(baseTables(false)),
      ),
    ).rejects.toMatchObject({ code: "module_disabled", status: 403 });
  });

  it("distingue modalidade desconhecida de grade vazia", async () => {
    const ctx = context(baseTables());
    await expect(crmFindAcademiaClasses.handler(
      { modalidade: "Natação", limite: 10 }, ctx,
    )).resolves.toMatchObject({ motivo: "modalidade_nao_encontrada", aulas: [] });
    await expect(crmFindAcademiaClasses.handler(
      { modalidade: "Ciclismo", dia_semana: 7, limite: 10 }, ctx,
    )).resolves.toMatchObject({ modalidade: "Ciclismo", aulas: [], total: 0 });
  });

  it("devolve opções quando um alias é ambíguo", async () => {
    const tables = baseTables();
    tables.academia_modalities!.push(
      { id: "m3", organization_id: "org-1", name: "Funcional", aliases: ["Treino"], active: true },
      { id: "m4", organization_id: "org-1", name: "HIIT", aliases: ["Treino"], active: true },
    );
    await expect(crmFindAcademiaClasses.handler(
      { modalidade: "Treino", limite: 10 }, context(tables),
    )).resolves.toMatchObject({
      motivo: "modalidade_ambigua",
      opcoes: ["Funcional", "HIIT"],
      aulas: [],
    });
  });

  it("não transforma público desconhecido em ausência de aula", async () => {
    await expect(crmFindAcademiaClasses.handler(
      { modalidade: "CrossFit", publico: "Sênior", limite: 10 }, context(baseTables()),
    )).resolves.toMatchObject({ motivo: "publico_nao_encontrado", aulas: [] });
  });

  it("não oferece aula cujo professor foi desativado", async () => {
    const result = await crmFindAcademiaClasses.handler(
      { modalidade: "CrossFit", dia_semana: 2, limite: 10 }, context(baseTables()),
    );
    expect(result).toMatchObject({ aulas: [], total: 0, ha_mais: false });
  });

  it("propaga falha de leitura com origem estável", async () => {
    await expect(crmFindAcademiaClasses.handler(
      { modalidade: "CrossFit", limite: 10 },
      context(baseTables(), { academia_weekly_classes: "banco indisponível" }),
    )).rejects.toThrow("consultar_grade_academia_falhou: banco indisponível");
  });
});
