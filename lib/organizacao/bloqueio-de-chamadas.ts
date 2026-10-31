/**
 * "Bloquear chamadas recebidas" — a chave da empresa que recusa, sozinha, a
 * ligação de voz que chega pelo WhatsApp do canal.
 *
 * Mora em `organizations.settings.calls.block_incoming`, no mesmo desenho de
 * `lib/conversoes/venda-pelo-canal.ts`: é uma chave só, sem tabela própria, e
 * ESTE arquivo é o único que conhece o caminho dentro do jsonb. Tela, ação e
 * ingestão passam por aqui — a UI nunca lê o path direto.
 *
 * ⚠️ AUSENTE É DESLIGADO. Ninguém passa a ter ligação recusada por atualizar o
 * produto: recusar a chamada de um cliente é uma decisão da empresa.
 *
 * Só o booleano `true` liga. Valor malformado (string, número) também é
 * desligado — falha aberta para a ligação, que é o comportamento de antes.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export function bloqueioDeChamadasLigado(settings: unknown): boolean {
  if (!settings || typeof settings !== "object") return false;
  const calls = (settings as Record<string, unknown>).calls;
  if (!calls || typeof calls !== "object") return false;
  return (calls as Record<string, unknown>).block_incoming === true;
}

/** `settings` com a chave gravada, preservando tudo que não é nosso. */
export function comBloqueioDeChamadas(settings: unknown, ligar: boolean): Record<string, unknown> {
  const base =
    settings && typeof settings === "object" && !Array.isArray(settings)
      ? (settings as Record<string, unknown>)
      : {};
  const calls =
    base.calls && typeof base.calls === "object" && !Array.isArray(base.calls)
      ? (base.calls as Record<string, unknown>)
      : {};
  return { ...base, calls: { ...calls, block_incoming: ligar } };
}

/**
 * Lê a chave da organização. LANÇA quando a leitura falha: quem chama decide
 * (a ingestão registra e deixa a ligação tocar — nunca recusa por dúvida).
 */
export async function lerBloqueioDeChamadas(
  admin: SupabaseClient,
  organizationId: string,
): Promise<boolean> {
  const { data, error } = await admin
    .from("organizations")
    .select("settings")
    .eq("id", organizationId)
    .maybeSingle();
  if (error) throw new Error(`leitura do bloqueio de chamadas falhou: ${error.message}`);
  return bloqueioDeChamadasLigado((data as { settings?: unknown } | null)?.settings);
}
