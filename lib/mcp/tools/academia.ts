/**
 * Consulta da grade semanal da Academia para o agente.
 *
 * O client de `McpContext` usa service role. Por isso toda consulta abaixo
 * recebe `organization_id` de `ctx`, inclusive as quatro tabelas vinculadas.
 */
import { z } from "zod";

import {
  projetarAulaSemanal,
  resolverModalidade,
  resolverPublico,
  type ItemModalidadeAcademia,
  type ItemNomeAcademia,
  type PeriodoAcademia,
} from "@/lib/academia/consulta-grade";
import { ApiError } from "@/lib/api/types";
import { lerModulos } from "@/lib/modules/config";
import type { McpContext, McpToolDefinition } from "../types";

const inputShape = {
  modalidade: z.string().trim().min(1).max(120),
  dia_semana: z.number().int().min(1).max(7).optional(),
  periodo: z.enum(["manha", "tarde", "noite"]).optional(),
  publico: z.string().trim().min(1).max(120).optional(),
  limite: z.number().int().min(1).max(20).optional().default(10),
};

type Input = z.infer<z.ZodObject<typeof inputShape>>;

interface AulaRow {
  id: string;
  modality_id: string;
  audience_id: string;
  teacher_id: string;
  space_id: string;
  weekday: number;
  start_time: string;
  duration_minutes: number;
}

interface AulaPublica {
  dia_semana: number;
  dia: string;
  inicio: string;
  fim: string;
  duracao_minutos: number;
  publico: string;
  professor: string;
  ambiente: string;
  pendencias?: string[];
}

interface ResultadoConsultaGrade {
  tipo_grade: "semanal_regular";
  modalidade: string;
  filtros: {
    dia_semana?: number;
    periodo?: PeriodoAcademia;
    publico?: string;
  };
  aulas: AulaPublica[];
  total: number;
  ha_mais: boolean;
  motivo?: "modalidade_nao_encontrada" | "modalidade_ambigua" | "publico_nao_encontrado";
  opcoes?: string[];
  mensagem?: string;
}

const FAIXAS: Record<PeriodoAcademia, { inicio: string; fimExclusivo: string | null }> = {
  manha: { inicio: "00:00", fimExclusivo: "12:00" },
  tarde: { inicio: "12:00", fimExclusivo: "18:00" },
  noite: { inicio: "18:00", fimExclusivo: null },
};

function filtrosDaConsulta(input: Input, publico?: string) {
  return {
    ...(input.dia_semana !== undefined ? { dia_semana: input.dia_semana } : {}),
    ...(input.periodo !== undefined ? { periodo: input.periodo } : {}),
    ...(publico !== undefined ? { publico } : input.publico !== undefined ? { publico: input.publico } : {}),
  };
}

function respostaVazia(
  modalidade: string,
  input: Input,
  extra: Pick<ResultadoConsultaGrade, "motivo" | "opcoes" | "mensagem">,
): ResultadoConsultaGrade {
  return {
    tipo_grade: "semanal_regular",
    modalidade,
    filtros: filtrosDaConsulta(input),
    aulas: [],
    total: 0,
    ha_mais: false,
    ...extra,
  };
}

async function lerNomesAtivos(
  ctx: McpContext,
  table: "academia_teachers" | "academia_spaces",
  ids: readonly string[],
  errorCode: string,
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const { data, error } = await ctx.supabase
    .from(table)
    .select("id,name")
    .eq("organization_id", ctx.organizationId)
    .eq("active", true)
    .in("id", [...new Set(ids)]);
  if (error) throw new Error(`${errorCode}: ${error.message}`);
  return new Map(((data ?? []) as ItemNomeAcademia[]).map((item) => [item.id, item.name]));
}

export const crmFindAcademiaClasses: McpToolDefinition<typeof inputShape> = {
  name: "crm_find_academia_classes",
  description:
    "Consulta a grade semanal regular da academia. Use antes de informar qualquer horário de aula. " +
    "Passe modalidade, dia ISO e período já ditos pela pessoa; não use a grade para afirmar vaga, " +
    "reserva, feriado ou ocorrência em uma data específica.",
  inputSchema: inputShape,
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  handler: async (input, ctx): Promise<ResultadoConsultaGrade> => {
    const { data: organizacao, error: organizacaoError } = await ctx.supabase
      .from("organizations")
      .select("settings")
      .eq("id", ctx.organizationId)
      .maybeSingle();
    if (organizacaoError) {
      throw new Error(`consultar_modulo_academia_falhou: ${organizacaoError.message}`);
    }
    if (!lerModulos(organizacao?.settings).academia) {
      throw new ApiError(
        403,
        "module_disabled",
        undefined,
        ctx.requestId,
        "O módulo Academia está desativado nesta empresa.",
      );
    }

    const { data: modalidadesData, error: modalidadesError } = await ctx.supabase
      .from("academia_modalities")
      .select("id,name,aliases")
      .eq("organization_id", ctx.organizationId)
      .eq("active", true)
      .order("name");
    if (modalidadesError) {
      throw new Error(`consultar_modalidades_falhou: ${modalidadesError.message}`);
    }
    const resolucao = resolverModalidade(
      (modalidadesData ?? []) as ItemModalidadeAcademia[],
      input.modalidade,
    );
    if (resolucao.tipo === "nao_encontrada") {
      return respostaVazia(input.modalidade, input, {
        motivo: "modalidade_nao_encontrada",
        mensagem:
          "Não encontrei essa modalidade no cadastro. Pergunte qual nome a academia usa para a aula.",
      });
    }
    if (resolucao.tipo === "ambigua") {
      return respostaVazia(input.modalidade, input, {
        motivo: "modalidade_ambigua",
        opcoes: resolucao.nomes,
        mensagem:
          "Mais de uma modalidade usa esse nome alternativo. Pergunte qual das opções a pessoa quis.",
      });
    }

    const { data: publicosData, error: publicosError } = await ctx.supabase
      .from("academia_audiences")
      .select("id,name")
      .eq("organization_id", ctx.organizationId)
      .eq("active", true)
      .order("name");
    if (publicosError) throw new Error(`consultar_publicos_falhou: ${publicosError.message}`);
    const publicos = (publicosData ?? []) as ItemNomeAcademia[];
    const publico = input.publico ? resolverPublico(publicos, input.publico) : null;
    if (input.publico && !publico) {
      return respostaVazia(resolucao.nome, input, {
        motivo: "publico_nao_encontrado",
        mensagem:
          "Não encontrei esse público no cadastro. Pergunte qual nome a academia usa para esse grupo.",
      });
    }

    let grade = ctx.supabase
      .from("academia_weekly_classes")
      .select(
        "id,modality_id,audience_id,teacher_id,space_id,weekday,start_time,duration_minutes",
      )
      .eq("organization_id", ctx.organizationId)
      .eq("active", true)
      .eq("modality_id", resolucao.id)
      .order("weekday")
      .order("start_time")
      .limit(1000);
    if (input.dia_semana !== undefined) grade = grade.eq("weekday", input.dia_semana);
    if (publico) grade = grade.eq("audience_id", publico.id);
    if (input.periodo) {
      const faixa = FAIXAS[input.periodo];
      grade = grade.gte("start_time", faixa.inicio);
      if (faixa.fimExclusivo) grade = grade.lt("start_time", faixa.fimExclusivo);
    }
    const { data: aulasData, error: aulasError } = await grade;
    if (aulasError) {
      throw new Error(`consultar_grade_academia_falhou: ${aulasError.message}`);
    }
    const linhas = (aulasData ?? []) as AulaRow[];
    if (linhas.length === 0) {
      return {
        tipo_grade: "semanal_regular",
        modalidade: resolucao.nome,
        filtros: filtrosDaConsulta(input, publico?.name),
        aulas: [],
        total: 0,
        ha_mais: false,
        mensagem: "Não há aula correspondente na grade semanal regular.",
      };
    }

    const [professores, ambientes] = await Promise.all([
      lerNomesAtivos(
        ctx,
        "academia_teachers",
        linhas.map((aula) => aula.teacher_id),
        "consultar_professores_falhou",
      ),
      lerNomesAtivos(
        ctx,
        "academia_spaces",
        linhas.map((aula) => aula.space_id),
        "consultar_ambientes_falhou",
      ),
    ]);
    const nomesPublicos = new Map(publicos.map((item) => [item.id, item.name]));
    const candidatas = linhas
      .flatMap((aula) => {
        const nomePublico = nomesPublicos.get(aula.audience_id);
        const professor = professores.get(aula.teacher_id);
        const ambiente = ambientes.get(aula.space_id);
        if (!nomePublico || !professor || !ambiente) return [];
        return [{
          id: aula.id,
          projetada: projetarAulaSemanal(aula, {
            modalidade: resolucao.nome,
            publico: nomePublico,
            professor,
            ambiente,
          }),
        }];
      })
      .sort((a, b) =>
        a.projetada.dia_semana - b.projetada.dia_semana ||
        a.projetada.inicio.localeCompare(b.projetada.inicio) ||
        a.projetada.publico.localeCompare(b.projetada.publico, "pt-BR") ||
        a.projetada.professor.localeCompare(b.projetada.professor, "pt-BR") ||
        a.id.localeCompare(b.id),
      );
    const aulas = candidatas.slice(0, input.limite).map((item) => item.projetada);
    return {
      tipo_grade: "semanal_regular",
      modalidade: resolucao.nome,
      filtros: filtrosDaConsulta(input, publico?.name),
      aulas,
      total: aulas.length,
      ha_mais: candidatas.length > input.limite,
      ...(aulas.length === 0
        ? { mensagem: "Não há aula correspondente na grade semanal regular." }
        : {}),
    };
  },
};
