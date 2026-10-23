/**
 * A REGRA QUE DECIDE O AVISO DE NEGÓCIO (lead assumido / ganho / perdido).
 *
 * ⚠️ POR QUE ISTO NÃO COMPARA MAIS COM O `old` DO REALTIME (issue #3040).
 *
 * O `postgres_changes` entrega o `old` do UPDATE com APENAS a chave primária
 * enquanto a tabela não tem `REPLICA IDENTITY FULL` — e `crm_leads` não tem
 * nenhuma no baseline. Medido em produção (1.84.0): com o `#2958` cada resposta
 * do vendedor carimba `last_activity_at` no negócio aberto; o evento chega com
 * `new` completo e `old = { id }`, o `owner_user_id` anterior saía sempre
 * `null`, e o teste `owner !== ownerAntes` passava SEMPRE — o vendedor recebia
 * "Lead atribuído a você" a cada mensagem enviada, num negócio que já era dele.
 * `statusAntes` tinha o mesmo vício em `lead_won`/`lead_lost`.
 *
 * A saída escolhida é a do próprio autor da issue (alternativa b): comparar com
 * o ÚLTIMO ESTADO VISTO pelo cliente, guardado por negócio — sem coluna nova e
 * sem tocar em `REPLICA IDENTITY` (decisão do mantenedor, não desta correção).
 * O `old` só volta a valer como histórico quando ele de fato carrega os campos
 * (instalação com `REPLICA IDENTITY FULL`), e é isso que `estadoDoAntigo` mede.
 *
 * Sem histórico conhecido o aviso NÃO sai: preferir o silêncio a notificar por
 * engano, que é o defeito desta issue.
 */

/** O que o cliente precisa lembrar de um negócio para saber se algo mudou. */
export interface EstadoVisto {
  owner_user_id: string | null;
  status: string | null;
}

export type AvisoDeNegocio = "lead_assigned" | "lead_won" | "lead_lost";

function texto(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * O `old` do evento como histórico — ou `null` quando ele não é um histórico.
 *
 * Sem `REPLICA IDENTITY FULL` o `old` traz só a chave primária: nenhum dos
 * campos que a decisão usa. Devolver `null` nesse caso é o que impede o defeito
 * de voltar pela porta dos fundos (um `{}` viraria "responsável ninguém").
 */
export function estadoDoAntigo(antigo: Record<string, unknown> | null): EstadoVisto | null {
  if (!antigo) return null;
  if (!("owner_user_id" in antigo) && !("status" in antigo)) return null;
  return { owner_user_id: texto(antigo.owner_user_id), status: texto(antigo.status) };
}

/** O estado que o evento atual passa a ser o histórico do negócio. */
export function estadoDoNovo(novo: Record<string, unknown>): EstadoVisto {
  return { owner_user_id: texto(novo.owner_user_id), status: texto(novo.status) };
}

/**
 * Quais avisos este UPDATE merece — a função que decide a notificação.
 *
 * `anterior` é o último estado visto deste negócio (`null` = desconhecido).
 * Notifica só quando o responsável é `userId` E o campo mudou DE VERDADE em
 * relação ao que o cliente já tinha visto.
 */
export function avisosDoNegocio(
  anterior: EstadoVisto | null,
  novo: EstadoVisto,
  userId: string,
): AvisoDeNegocio[] {
  // Sem histórico não há como dizer que mudou: registra e fica quieto.
  if (!anterior) return [];
  if (!novo.owner_user_id || novo.owner_user_id !== userId) return [];

  const avisos: AvisoDeNegocio[] = [];
  if (novo.owner_user_id !== anterior.owner_user_id) avisos.push("lead_assigned");
  if (novo.status === "won" && anterior.status !== "won") avisos.push("lead_won");
  if (novo.status === "lost" && anterior.status !== "lost") avisos.push("lead_lost");
  return avisos;
}
