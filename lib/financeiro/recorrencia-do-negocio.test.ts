/**
 * A RECORRÊNCIA DO NEGÓCIO (#3602, fatias 3 e 4) — o que este teste prende.
 *
 * Ganhar um negócio com `recurring_value_cents` declarado tem de virar UM molde
 * ativo em `recurring_entries`, ligado ao negócio, com o valor mensal e o dia
 * do `created_at`; perder tem de desativar o molde DAQUELE negócio. As
 * promessas, uma por `it`:
 *
 *   1. ganho com recorrência → um molde ativo, com valor, dia e vínculo;
 *   2. ganho de novo → `ja_existia`, nada é escrito;
 *   3. corrida (23505 no índice único) → `ja_existia`, nunca exceção;
 *   4. sem valor, sem conta, ou sem o módulo financeiro → `ignorado`, sem escrita;
 *   5. perda → `is_active = false` só no molde daquele negócio.
 */
import { describe, expect, it } from "vitest";

import {
  desativaRecorrenciaDoNegocio,
  diaDoMesDoNegocio,
  recorrenciaDoNegocio,
} from "./recorrencia-do-negocio";

const ORG = "22222222-2222-4222-8222-222222222222";
const LEAD = "33333333-3333-4333-8333-333333333333";
const FUNIL = "77777777-7777-4777-8777-777777777777";
const CONTA = "88888888-8888-4888-8888-888888888888";
const MOLDE = "99999999-9999-4999-8999-999999999999";

type Registro = Record<string, unknown>;

/** Resposta com forma de promise: `await` resolve como no supabase-js. */
function resposta(data: unknown, error: { message: string; code?: string } | null = null) {
  return {
    then(ok: (v: unknown) => unknown, erro?: (e: unknown) => unknown) {
      return Promise.resolve({ data, error }).then(ok, erro);
    },
  };
}

/**
 * Banco falso só com o que as funções tocam. Qualquer OUTRA tabela derruba o
 * teste na hora — um mock que aceita tudo também aprova uma consulta que não
 * deveria existir (mesmo desenho de `comanda-do-ganho.test.ts`).
 */
function bancoFalso(
  opcoes: {
    moduloLigado?: boolean;
    moldeExistente?: Registro | null;
    contas?: Registro[];
    nomeDoFunil?: string | null;
    falhaInsert?: { message: string; code?: string } | null;
    falhaLeitura?: { message: string } | null;
    /** O que o UPDATE devolve: os moldes atingidos. */
    desativados?: Registro[];
    falhaUpdate?: { message: string } | null;
  } = {},
) {
  const escritas: { tabela: string; dados: Registro }[] = [];
  const atualizacoes: { tabela: string; dados: Registro; filtros: Registro }[] = [];
  const filtrosPorAtualizacao: Registro[] = [];

  const cadeia = (tabela: string) => {
    const estado: { filtros: Registro; inserido: Registro | null } = { filtros: {}, inserido: null };

    const resolver = () => {
      if (estado.inserido) {
        if (tabela === "recurring_entries" && opcoes.falhaInsert) {
          return resposta(null, opcoes.falhaInsert);
        }
        return resposta({ id: MOLDE });
      }
      switch (tabela) {
        case "platform_config":
          return resposta([]);
        case "modulos_instalados":
          return resposta(opcoes.moduloLigado === false ? [] : [{ modulo: "financeiro" }]);
        case "recurring_entries":
          if (opcoes.falhaLeitura) return resposta(null, opcoes.falhaLeitura);
          return resposta(opcoes.moldeExistente ?? null);
        case "financial_accounts":
          return resposta((opcoes.contas ?? [{ id: CONTA }])[0] ?? null);
        case "crm_pipelines":
          return resposta(
            opcoes.nomeDoFunil === null ? null : { name: opcoes.nomeDoFunil ?? "Vendas" },
          );
        case "organizations":
          return resposta({ currency: "BRL" });
        default:
          throw new Error(`consulta inesperada no teste: ${tabela}`);
      }
    };

    const c: Record<string, unknown> = {};
    Object.assign(c, {
      select: () => c,
      eq: (coluna: string, valor: unknown) => {
        estado.filtros[coluna] = valor;
        return c;
      },
      in: () => c,
      order: () => c,
      limit: () => c,
      insert: (dados: Registro) => {
        estado.inserido = dados;
        escritas.push({ tabela, dados });
        return c;
      },
      update: (dados: Registro) => {
        atualizacoes.push({ tabela, dados, filtros: estado.filtros });
        filtrosPorAtualizacao.push(estado.filtros);
        return c;
      },
      maybeSingle: async () => resolver(),
      single: async () => resolver(),
      then: (ok: (v: unknown) => unknown, erro?: (e: unknown) => unknown) => {
        // O UPDATE devolve linhas; o resto, o que o resolver mandar.
        if (atualizacoes.length > 0) {
          return Promise.resolve({
            data: opcoes.falhaUpdate ? null : (opcoes.desativados ?? [{ id: MOLDE }]),
            error: opcoes.falhaUpdate ?? null,
          }).then(ok, erro);
        }
        return Promise.resolve(resolver()).then(ok, erro);
      },
    });
    return c;
  };

  const supabase = { from: (tabela: string) => cadeia(tabela) };

  return {
    supabase: supabase as never,
    escritas,
    atualizacoes,
    filtrosPorAtualizacao,
  };
}

const entrada = (sobrescrita: Partial<Parameters<typeof recorrenciaDoNegocio>[1]> = {}) => ({
  organizationId: ORG,
  leadId: LEAD,
  pipelineId: FUNIL,
  valorCents: 50_000,
  criadoEm: "2026-03-05T23:30:00.000Z",
  userId: "55555555-5555-4555-8555-555555555555",
  ...sobrescrita,
});

describe("diaDoMesDoNegocio", () => {
  it("sai do created_at em UTC — o mesmo negócio tem o mesmo dia em qualquer servidor", () => {
    // 23:30 UTC do dia 5 é dia 6 em São Paulo: o dia civil do DADO é o 5.
    expect(diaDoMesDoNegocio("2026-03-05T23:30:00.000Z")).toBe(5);
    expect(diaDoMesDoNegocio("2026-01-31T12:00:00.000Z")).toBe(31);
  });

  it("data ausente ou ilegível cai no dia 1, nunca derruba o ganho", () => {
    expect(diaDoMesDoNegocio(null)).toBe(1);
    expect(diaDoMesDoNegocio("não é data")).toBe(1);
  });
});

describe("recorrenciaDoNegocio", () => {
  it("ganho com recorrência: UM molde ativo, com o valor, o dia e o vínculo do negócio", async () => {
    const falso = bancoFalso();

    const desfecho = await recorrenciaDoNegocio(falso.supabase, entrada());

    expect(desfecho).toEqual({
      estado: "criado",
      recorrenciaId: MOLDE,
      valorCents: 50_000,
      diaDoMes: 5,
    });
    expect(falso.escritas).toHaveLength(1);
    const [escrita] = falso.escritas;
    expect(escrita).toMatchObject({
      tabela: "recurring_entries",
      dados: {
        organization_id: ORG,
        crm_lead_id: LEAD,
        account_id: CONTA,
        direction: "in",
        amount_cents: 50_000,
        currency: "BRL",
        day_of_month: 5,
        is_active: true,
      },
    });
    // A descrição vem do FUNIL: o título do negócio costuma ser nome ou
    // telefone do contato e ficaria fora da cascata de redact da LGPD.
    expect((escrita?.dados as { name?: string } | undefined)?.name).toBe("Recorrência · Vendas");
  });

  it("ganho de novo NÃO duplica: o molde existente é devolvido e nada é escrito", async () => {
    const falso = bancoFalso({ moldeExistente: { id: MOLDE } });

    const desfecho = await recorrenciaDoNegocio(falso.supabase, entrada());

    expect(desfecho).toEqual({ estado: "ja_existia", recorrenciaId: MOLDE });
    expect(falso.escritas).toHaveLength(0);
  });

  it("a corrida de dois ganhos é resolvida pelo índice único: 23505 é ja_existia", async () => {
    const falso = bancoFalso({
      falhaInsert: { message: "duplicate key value violates unique constraint", code: "23505" },
    });

    await expect(recorrenciaDoNegocio(falso.supabase, entrada())).resolves.toEqual({
      estado: "ja_existia",
      recorrenciaId: null,
    });
  });

  it("sem valor declarado não há molde — e nem consulta ao banco", async () => {
    for (const valorCents of [null, 0, -100, 1.5, "50.000"]) {
      const falso = bancoFalso();
      const desfecho = await recorrenciaDoNegocio(falso.supabase, entrada({ valorCents }));
      expect(desfecho).toEqual({ estado: "ignorado", motivo: "sem_valor_valido" });
      expect(falso.escritas).toHaveLength(0);
    }
  });

  it("sem o módulo financeiro instalado, não grava receita que ninguém veria", async () => {
    const falso = bancoFalso({ moduloLigado: false });

    const desfecho = await recorrenciaDoNegocio(falso.supabase, entrada());

    expect(desfecho).toEqual({
      estado: "ignorado",
      motivo: "modulo_financeiro_nao_instalado",
    });
    expect(falso.escritas).toHaveLength(0);
  });

  it("sem conta ativa na organização não há onde o dinheiro cair: ignorado, sem inventar conta", async () => {
    const falso = bancoFalso({ contas: [] });

    const desfecho = await recorrenciaDoNegocio(falso.supabase, entrada());

    expect(desfecho).toEqual({ estado: "ignorado", motivo: "sem_conta_financeira" });
    expect(falso.escritas).toHaveLength(0);
  });

  it("falha de escrita vira `falhou`, nunca exceção para a rota", async () => {
    const falso = bancoFalso({ falhaInsert: { message: "permissão negada" } });

    const desfecho = await recorrenciaDoNegocio(falso.supabase, entrada());

    expect(desfecho).toMatchObject({ estado: "falhou" });
  });
});

describe("desativaRecorrenciaDoNegocio", () => {
  it("desativa o molde DAQUELE negócio — e o filtro carrega a organização", async () => {
    const falso = bancoFalso({ desativados: [{ id: MOLDE }] });

    const desfecho = await desativaRecorrenciaDoNegocio(falso.supabase, {
      organizationId: ORG,
      leadId: LEAD,
    });

    expect(desfecho).toEqual({ estado: "desativado", recorrenciaId: MOLDE });
    expect(falso.atualizacoes).toHaveLength(1);
    const [atualizacao] = falso.atualizacoes;
    expect(atualizacao).toMatchObject({
      tabela: "recurring_entries",
      dados: { is_active: false },
      filtros: { organization_id: ORG, crm_lead_id: LEAD, is_active: true },
    });
  });

  it("negócio sem molde (ou perdido de novo) é no-op, não erro", async () => {
    const falso = bancoFalso({ desativados: [] });

    const desfecho = await desativaRecorrenciaDoNegocio(falso.supabase, {
      organizationId: ORG,
      leadId: LEAD,
    });

    expect(desfecho).toEqual({ estado: "nada_a_desativar" });
  });

  it("falha no UPDATE vira `falhou`, nunca exceção", async () => {
    const falso = bancoFalso({ falhaUpdate: { message: "conexão caiu" } });

    const desfecho = await desativaRecorrenciaDoNegocio(falso.supabase, {
      organizationId: ORG,
      leadId: LEAD,
    });

    expect(desfecho).toMatchObject({ estado: "falhou" });
  });
});
