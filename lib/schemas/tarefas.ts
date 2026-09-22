import { z } from "zod";

/**
 * TAREFAS E ATIVIDADES — contratos da rotina do vendedor externo (0229).
 */

export const TIPOS_TAREFA = ["visita", "ligacao", "retorno", "outro"] as const;
export type TipoTarefa = (typeof TIPOS_TAREFA)[number];

export const STATUS_TAREFA = ["pendente", "concluida", "cancelada"] as const;
export type StatusTarefa = (typeof STATUS_TAREFA)[number];

export const TIPOS_ATIVIDADE = ["visita", "ligacao", "whatsapp", "email", "outro"] as const;

export const tarefaCreateSchema = z.object({
  titulo: z.string().trim().min(2, "título precisa de ao menos 2 letras").max(200),
  descricao: z.string().trim().max(2000).optional(),
  tipo: z.enum(TIPOS_TAREFA).default("visita"),
  contact_id: z.string().uuid().nullable().optional(),
  responsavel_user_id: z.string().uuid().nullable().optional(),
  agendada_para: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "data YYYY-MM-DD")
    .nullable()
    .optional(),
});

export type TarefaCreate = z.infer<typeof tarefaCreateSchema>;

export const tarefaPatchSchema = z
  .object({
    status: z.enum(STATUS_TAREFA).optional(),
    titulo: z.string().trim().min(2).max(200).optional(),
    descricao: z.string().trim().max(2000).nullable().optional(),
    agendada_para: z
      .string()
      .trim()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "data YYYY-MM-DD")
      .nullable()
      .optional(),
    checkin_lat: z.number().min(-90).max(90).nullable().optional(),
    checkin_lng: z.number().min(-180).max(180).nullable().optional(),
  })
  .refine((d) => Object.keys(d).length > 0, { message: "Nada para atualizar." });

export type TarefaPatch = z.infer<typeof tarefaPatchSchema>;

export const atividadeCreateSchema = z.object({
  contact_id: z.string().uuid().nullable().optional(),
  tipo: z.enum(TIPOS_ATIVIDADE).default("visita"),
  resultado: z.string().trim().max(200).optional(),
  observacao: z.string().trim().max(2000).optional(),
  ocorrida_em: z.string().datetime({ offset: true }).nullable().optional(),
});

export type AtividadeCreate = z.infer<typeof atividadeCreateSchema>;

export interface Tarefa {
  id: string;
  titulo: string;
  descricao: string | null;
  tipo: TipoTarefa;
  status: StatusTarefa;
  contact_id: string | null;
  contato_nome: string | null;
  responsavel_user_id: string | null;
  agendada_para: string | null;
  checkin_em: string | null;
  checkin_lat: number | null;
  checkin_lng: number | null;
  concluida_em: string | null;
  created_at: string;
}

export const COLUNAS_DA_TAREFA =
  "id, titulo, descricao, tipo, status, contact_id, responsavel_user_id, " +
  "agendada_para, checkin_em, checkin_lat, checkin_lng, concluida_em, created_at";

export const ROTULO_TIPO_TAREFA: Record<TipoTarefa, string> = {
  visita: "Visita",
  ligacao: "Ligação",
  retorno: "Retorno",
  outro: "Outra",
};

export const ROTULO_STATUS_TAREFA: Record<StatusTarefa, string> = {
  pendente: "Pendente",
  concluida: "Concluída",
  cancelada: "Cancelada",
};
