import { format } from "date-fns";
import { ptBR } from "date-fns/locale";

export interface DadosConfirmacao {
  client_name: string;
  scheduled_at: string;
  unit_name: string;
  vehicle_plate?: string | null;
  vehicle_brand?: string | null;
  vehicle_model?: string | null;
}

export function montarTextoConfirmacaoWhatsApp(dados: DadosConfirmacao): string {
  const quando = format(new Date(dados.scheduled_at), "EEEE, dd/MM 'às' HH:mm", { locale: ptBR });
  const veiculo = [dados.vehicle_brand, dados.vehicle_model, dados.vehicle_plate]
    .filter(Boolean)
    .join(" — ");
  const linhas = [
    `Olá, ${dados.client_name}!`,
    "",
    "Confirmamos seu agendamento de avaliação:",
    `📅 ${quando}`,
    `📍 Unidade: ${dados.unit_name}`,
  ];
  if (veiculo) linhas.push(`🚗 Veículo: ${veiculo}`);
  linhas.push("", "Qualquer dúvida, responda por aqui.");
  return linhas.join("\n");
}
