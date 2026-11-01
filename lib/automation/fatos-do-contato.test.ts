import { describe, expect, it } from "vitest";

import { STATUS_VIVOS } from "@/lib/followup/inscricao-viva";
import { createSupabaseSilenceSweepDb } from "@/lib/followup/silence-sweep";

import {
  CAMPOS_DO_CONTATO,
  CONDICOES_DO_CONTATO,
  conditionsSchema,
  DIAS_MAXIMOS_DA_AGENDA,
  lerValorDeHorario,
  montarValorDeHorario,
  usaFatosDoContato,
  valorPadraoDoCampo,
  validarCondicaoDoContato,
  RECUSAS_DA_CONDICAO_DO_CONTATO,
} from "./conditions";
import { carregarFatosDoContato, LIMITE_DE_HORARIOS, STATUS_MARCADOS } from "./fatos-do-contato";

/**
 * A LEITURA da condição do contato (#3814) — a fonte de verdade, o número de
 * consultas e o que acontece quando não há linha ou a leitura falha.
 *
 * O dublê GRAVA a cadeia de chamadas em vez de filtrar: filtrar é trabalho do
 * Postgres, e o que este teste precisa provar é o que se PERGUNTA — mesmo
 * desenho de `lib/followup/silence-sweep-inscricao-viva-query.test.ts`.
 */
type Chamada = { metodo: string; args: unknown[] };
type Consulta = { tabela: string; chamadas: Chamada[] };

function fakeAdmin(
  respostas: {
    followup_enrollments?: unknown[];
    calendar_appointments?: unknown[];
    erro?: string;
  } = {},
) {
  const consultas: Consulta[] = [];
  const from = (tabela: string) => {
    const registro: Consulta = { tabela, chamadas: [] };
    consultas.push(registro);
    const chain: Record<string, unknown> = new Proxy(
      {},
      {
        get(_alvo, prop) {
          if (prop === "then") {
            return (resolve: (valor: unknown) => unknown) =>
              resolve(
                respostas.erro
                  ? { data: null, error: { message: respostas.erro } }
                  : {
                      data: (respostas as Record<string, unknown[] | undefined>)[tabela] ?? [],
                      error: null,
                    },
              );
          }
          return (...args: unknown[]) => {
            registro.chamadas.push({ metodo: String(prop), args });
            return chain;
          };
        },
      },
    );
    return chain;
  };
  return { admin: { from } as never, consultas };
}

const agora = new Date("2026-11-02T12:00:00.000Z");

describe("carregarFatosDoContato — a leitura do contato", () => {
  it("pergunta ao follow-up EXATAMENTE o que a varredura de silêncio pergunta — e o que o índice único cobra", async () => {
    const daCondicao = fakeAdmin({ followup_enrollments: [{ contact_id: "c-1" }] });
    const daVarredura = fakeAdmin({ followup_enrollments: [{ contact_id: "c-1" }] });

    const fatos = await carregarFatosDoContato(daCondicao.admin, "org-1", "c-1", { agora });
    await createSupabaseSilenceSweepDb(daVarredura.admin).loadContatosComInscricaoViva("org-1", [
      "c-1",
    ]);

    const perguntasDaCondicao = daCondicao.consultas.filter(
      (c) => c.tabela === "followup_enrollments",
    );
    const perguntasDaVarredura = daVarredura.consultas.filter(
      (c) => c.tabela === "followup_enrollments",
    );

    // UMA pergunta — por avaliação, nunca uma por condição ou por regra.
    expect(perguntasDaCondicao).toHaveLength(1);
    expect(perguntasDaVarredura).toHaveLength(1);
    // A MESMA pergunta, argumento por argumento. Se alguém trocar a lista de
    // status de um lado só, este teste cai: a condição e a varredura passariam
    // a discordar sobre o mesmo contato.
    expect(perguntasDaCondicao[0]!.chamadas).toEqual(perguntasDaVarredura[0]!.chamadas);

    const chamadas = perguntasDaCondicao[0]!.chamadas;
    expect(perguntasDaCondicao[0]!.tabela).toBe("followup_enrollments");
    expect(chamadas[0]).toEqual({ metodo: "select", args: ["contact_id"] });
    expect(chamadas).toContainEqual({ metodo: "eq", args: ["organization_id", "org-1"] });
    // O predicado do `idx_followup_enrollments_one_live`. `paused_manual` está
    // aqui porque pausado continua ocupando a vaga do "vivo" (migration 0145).
    expect(chamadas).toContainEqual({ metodo: "in", args: ["status", [...STATUS_VIVOS]] });
    expect(chamadas).toContainEqual({ metodo: "in", args: ["contact_id", ["c-1"]] });
    // Qualquer fluxo da organização: o índice é por (organization_id, contact_id).
    expect(chamadas.some((c) => c.args[0] === "pointer_id")).toBe(false);

    expect(fatos.inscricao_viva).toBe(true);
  });

  it("tabela vazia não trava o motor: responde 'não tem' e 'nenhum horário'", async () => {
    const { admin, consultas } = fakeAdmin();

    const fatos = await carregarFatosDoContato(admin, "org-1", "c-1", { agora });

    expect(fatos).toEqual({ agora: agora.toISOString(), inscricao_viva: false, horarios: [] });
    // Duas fontes, duas consultas — e só isso, mesmo com duas condições.
    expect(consultas).toHaveLength(2);
  });

  it("a agenda pergunta só o futuro que vale: marcados, a partir de agora, com teto de linhas", async () => {
    const { admin, consultas } = fakeAdmin({
      calendar_appointments: [
        {
          starts_at: "2026-11-05T09:00:00.000Z",
          calendar_event_types: { name: "Manutenção" },
        },
      ],
    });

    const fatos = await carregarFatosDoContato(admin, "org-1", "c-1", { agora });

    const daAgenda = consultas.filter((c) => c.tabela === "calendar_appointments");
    expect(daAgenda).toHaveLength(1);
    const chamadas = daAgenda[0]!.chamadas;
    expect(chamadas).toContainEqual({ metodo: "eq", args: ["organization_id", "org-1"] });
    expect(chamadas).toContainEqual({ metodo: "eq", args: ["contact_id", "c-1"] });
    // Cancelado, concluído e falta NÃO são "horário marcado".
    expect(chamadas).toContainEqual({ metodo: "in", args: ["status", [...STATUS_MARCADOS]] });
    expect(chamadas).toContainEqual({ metodo: "gte", args: ["starts_at", agora.toISOString()] });
    expect(chamadas).toContainEqual({ metodo: "limit", args: [LIMITE_DE_HORARIOS] });

    expect(fatos.horarios).toEqual([{ starts_at: "2026-11-05T09:00:00.000Z", tipo: "Manutenção" }]);
  });

  it("leitura que falha vira fato NÃO MEDIDO (null), nunca 'não tem'", async () => {
    const { admin } = fakeAdmin({ erro: "relation does not exist" });

    const fatos = await carregarFatosDoContato(admin, "org-1", "c-1", { agora });

    expect(fatos.inscricao_viva).toBeNull();
    expect(fatos.horarios).toBeNull();
  });
});

describe("a condição do contato no vocabulário do editor e na porta da API", () => {
  it("as duas aparecem com rótulo em português e valor sim/não", () => {
    expect(CONDICOES_DO_CONTATO.map((c) => c.label)).toEqual([
      "Contato tem follow-up vivo",
      "Contato tem horário marcado",
    ]);
    expect(CONDICOES_DO_CONTATO.map((c) => c.value)).toEqual([
      CAMPOS_DO_CONTATO.followUpVivo,
      CAMPOS_DO_CONTATO.horarioMarcado,
    ]);
    expect(CONDICOES_DO_CONTATO.every((c) => c.kind === "sim_nao" && c.op === "eq")).toBe(true);
  });

  it("a porta recusa o valor que o motor não entende, com a frase do conserto", () => {
    const linha = (field: string, value: string, op = "eq") => ({ field, op, value });

    expect(conditionsSchema.safeParse([linha(CAMPOS_DO_CONTATO.followUpVivo, "sim")]).success).toBe(
      true,
    );
    expect(
      conditionsSchema.safeParse([linha(CAMPOS_DO_CONTATO.followUpVivo, "talvez")]).success,
    ).toBe(false);
    expect(
      conditionsSchema.safeParse([linha(CAMPOS_DO_CONTATO.horarioMarcado, "sim|7")]).success,
    ).toBe(true);
    expect(
      conditionsSchema.safeParse([linha(CAMPOS_DO_CONTATO.horarioMarcado, "sim|7|Manutenção")])
        .success,
    ).toBe(true);
    expect(
      conditionsSchema.safeParse([linha(CAMPOS_DO_CONTATO.horarioMarcado, "sim|999")]).success,
    ).toBe(false);

    const recusa = conditionsSchema.safeParse([linha(CAMPOS_DO_CONTATO.horarioMarcado, "sim|999")]);
    expect(recusa.success ? null : recusa.error.issues[0]?.message).toBe(
      RECUSAS_DA_CONDICAO_DO_CONTATO.diasForaDaFaixa,
    );
    const recusaDeOperador = validarCondicaoDoContato({
      field: CAMPOS_DO_CONTATO.followUpVivo,
      op: "contains",
      value: "sim",
    });
    expect(recusaDeOperador).toBe(RECUSAS_DA_CONDICAO_DO_CONTATO.operador);
  });

  it("ler e montar o valor da agenda são o mesmo caminho", () => {
    expect(lerValorDeHorario("sim|7|Manutenção")).toEqual({
      resposta: "sim",
      dias: 7,
      tipo: "Manutenção",
    });
    expect(montarValorDeHorario({ resposta: "sim", dias: 7, tipo: "Manutenção" })).toBe(
      "sim|7|Manutenção",
    );
    expect(montarValorDeHorario({ resposta: "nao", dias: null, tipo: null })).toBe("nao");
    expect(montarValorDeHorario({ resposta: "sim", dias: null, tipo: "Consulta" })).toBe(
      "sim||Consulta",
    );
  });

  it("todo valor que o editor grava volta igual ao ler — o tipo pode ter `|` (#3821)", () => {
    // Todas as combinações do controle: resposta × prazo × tipo. Os tipos com
    // `|` são o defeito medido: `nao|7|Corte|Barba` era lido como `null`, a
    // tela voltava o seletor para "Sim" e a porta recusava com a frase do prazo.
    const respostas = ["sim", "nao"] as const;
    const prazos = [null, 1, 7, DIAS_MAXIMOS_DA_AGENDA];
    const tipos = [
      null,
      "Manutenção",
      "Corte (masculino), barba - 30min",
      "Corte|Barba",
      "A | B",
      "|começa com barra",
      "termina com barra|",
      "a||b",
    ];
    let combinacoes = 0;
    for (const resposta of respostas) {
      for (const dias of prazos) {
        for (const tipo of tipos) {
          const regra = { resposta, dias, tipo };
          const gravado = montarValorDeHorario(regra);
          expect(lerValorDeHorario(gravado), gravado).toEqual(regra);
          expect(
            validarCondicaoDoContato({
              field: CAMPOS_DO_CONTATO.horarioMarcado,
              op: "eq",
              value: gravado,
            }),
            gravado,
          ).toBeNull();
          expect(
            conditionsSchema.safeParse([
              { field: CAMPOS_DO_CONTATO.horarioMarcado, op: "eq", value: gravado },
            ]).success,
            gravado,
          ).toBe(true);
          // Trocar de campo e voltar não apaga o que já estava escrito.
          expect(valorPadraoDoCampo(CAMPOS_DO_CONTATO.horarioMarcado, gravado)).toBe(gravado);
          combinacoes += 1;
        }
      }
    }
    // Controle da varredura: o laço não pode ter rodado vazio.
    expect(combinacoes).toBe(2 * 4 * 8);
  });

  it("valores gravados no formato de antes leem igual; o inválido continua recusado", () => {
    expect(lerValorDeHorario("sim")).toEqual({ resposta: "sim", dias: null, tipo: null });
    expect(lerValorDeHorario("nao")).toEqual({ resposta: "nao", dias: null, tipo: null });
    expect(lerValorDeHorario("sim|7")).toEqual({ resposta: "sim", dias: 7, tipo: null });
    expect(lerValorDeHorario("nao|7")).toEqual({ resposta: "nao", dias: 7, tipo: null });
    expect(lerValorDeHorario(" sim | 7 | Manutenção ")).toEqual({
      resposta: "sim",
      dias: 7,
      tipo: "Manutenção",
    });
    expect(lerValorDeHorario("sim||Consulta")).toEqual({
      resposta: "sim",
      dias: null,
      tipo: "Consulta",
    });
    for (const invalido of ["", "talvez", "|7", "sim|0", "sim|999", "sim|abc", "sim|7.5"]) {
      expect(lerValorDeHorario(invalido), invalido).toBeNull();
    }
  });

  it("o motor só vai ao banco quando alguma regra casada usa estas condições", () => {
    expect(
      usaFatosDoContato([{ field: CAMPOS_DO_CONTATO.followUpVivo, op: "eq", value: "sim" }]),
    ).toBe(true);
    expect(
      usaFatosDoContato({
        any: [{ field: CAMPOS_DO_CONTATO.horarioMarcado, op: "eq", value: "sim" }],
      }),
    ).toBe(true);
    expect(usaFatosDoContato([{ field: "lead.title", op: "eq", value: "Bia" }])).toBe(false);
    expect(usaFatosDoContato([])).toBe(false);
  });

  it("a linha recém-escolhida no editor já nasce com valor que a porta aceita", () => {
    expect(valorPadraoDoCampo(CAMPOS_DO_CONTATO.followUpVivo, "")).toBe("sim");
    // Trocar de campo não apaga um "não" que já estava escrito.
    expect(valorPadraoDoCampo(CAMPOS_DO_CONTATO.horarioMarcado, "nao")).toBe("nao");
    expect(valorPadraoDoCampo("lead.title", "Bia")).toBeNull();
  });
});
