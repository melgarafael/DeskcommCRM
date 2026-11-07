import type { StatusAvaliacao } from "@/lib/avaliacao/status";

export interface AgendamentoAvaliacao {
  id: string;
  contact_id: string;
  unit_id: string;
  consultant_user_id: string | null;
  attendant_user_id: string | null;
  scheduled_at: string;
  duration_minutes: number;
  vehicle_plate: string | null;
  vehicle_brand: string | null;
  vehicle_model: string | null;
  notes: string | null;
  status: StatusAvaliacao;
  client_email?: string | null;
  contacts?: { name: string; phone_number: string | null; email?: string | null } | { name: string; phone_number: string | null; email?: string | null }[] | null;
  avaliacao_unidades?: { name: string } | { name: string }[] | null;
}

export type VisaoAvaliacao = "lista" | "semana";

export interface FiltrosAvaliacaoState {
  de: string;
  ate: string;
  status?: StatusAvaliacao | "todos";
  unit_id?: string;
  consultant_user_id?: string;
  attendant_user_id?: string;
  q?: string;
}
