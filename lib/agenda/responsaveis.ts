/**
 * RESPONSÁVEIS DA CONSULTA — o principal (owner_user_id) é único; adicionais
 * ocupam a agenda e ficam em `calendar_appointment_responsibles`.
 *
 * Teto: 10 conduzindo = 1 principal + até 9 adicionais. O agente NÃO escolhe
 * adicionais; adicional basta ser membro ativo da organização e estar livre.
 * O módulo "Reservas de lugar" segue como está.
 */
import { z } from "zod";

import { ApiError } from "@/lib/api/types";

export const TETO_RESPONSAVEIS = 10;
export const TETO_ADICIONAIS = TETO_RESPONSAVEIS - 1;

/** Array de uuid, sem repetidos, no teto de adicionais. Ausente = não mexe. */
export const responsible_user_idsSchema = z
  .array(z.string().uuid())
  .max(TETO_ADICIONAIS)
  .refine((ids) => new Set(ids.map((i) => i.toLowerCase())).size === ids.length, {
    message: "Não repita o mesmo responsável adicional.",
  });

/**
 * Mapeia o código de exceção do banco (errcode 22023 com detail nomeado) para
 * a resposta de wire. A rota e a tool MCP traduzem o ApiError; este módulo
 * nomeia os códigos de banco para não espalhar strings pelo código.
 */
export const ERRO_RESPONSAVEIS = {
  appointment_responsibles_limit: {
    status: 422,
    code: "agenda_responsaveis_teto",
    message: `Limite de ${TETO_ADICIONAIS} responsáveis adicionais por consulta (teto de ${TETO_RESPONSAVEIS} conduzindo, contando o principal).`,
  },
  appointment_responsibles_invalid: {
    status: 422,
    code: "agenda_responsaveis_invalidos",
    message: "Responsável adicional inválido: não é membro ativo da organização, é o responsável principal, está repetido ou excede o teto.",
  },
  responsible_unavailable: {
    status: 409,
    code: "responsavel_indisponivel",
    message: "Responsável adicional já tem compromisso neste horário.",
  },
  service_team_conflict: {
    status: 409,
    code: "service_team_conflict",
    message: "Esta sessão já tem outra equipe. Quem entra depois herda a equipe de quem abriu a sessão.",
  },
  // Exceções que o SQL da criação levanta para ids forjados. Não aparecem no uso normal,
  // mas não podem virar 500: cada uma vira 422 com o nome do que estava errado.
  appointment_event_type_invalid: {
    status: 422,
    code: "agenda_tipo_invalido",
    message: "Tipo de compromisso não encontrado nesta organização.",
  },
  appointment_contact_invalid: {
    status: 422,
    code: "agenda_contato_invalido",
    message: "Contato não encontrado nesta organização.",
  },
  appointment_owner_invalid: {
    status: 422,
    code: "agenda_dono_invalido",
    message: "O responsável principal precisa ser membro ativo desta organização.",
  },
  appointment_conversation_invalid: {
    status: 422,
    code: "agenda_conversa_invalida",
    message: "Conversa não encontrada nesta organização.",
  },
  appointment_team_guests_invalid: {
    status: 422,
    code: "agenda_equipe_invalida",
    message: "Convidado da equipe não pertence a esta organização.",
  },
} as const;

export type ErroResponsaveis = keyof typeof ERRO_RESPONSAVEIS;

/**
 * Traduz a exceção NOMEADA do banco (ver `ERRO_RESPONSAVEIS`) para ApiError.
 * Devolve null quando o erro não é um destes: quem chama cai no mapeamento
 * genérico dele. Procura o nome no texto, porque o PostgREST e o `googleRpc`
 * entregam a mensagem do `raise` como está.
 */
export function traduzErroResponsaveis(
  erro: { message?: string; details?: string | null },
  requestId: string,
): ApiError | null {
  const msg = erro.message ?? "";
  const nomes = Object.keys(ERRO_RESPONSAVEIS) as ErroResponsaveis[];
  const nome = nomes.find((n) => msg.includes(n));
  if (!nome) return null;
  const e = ERRO_RESPONSAVEIS[nome];
  const detalhes = nome === "responsible_unavailable" ? { user_id: erro.details ?? null } : undefined;
  return new ApiError(e.status, e.code, detalhes, requestId, e.message);
}
