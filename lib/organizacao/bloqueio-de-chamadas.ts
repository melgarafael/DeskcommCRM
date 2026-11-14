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

/** Teto do texto avisado a quem ligou: uma frase curta, não um comunicado. */
export const MENSAGEM_DE_RECUSA_MAX = 500;

/**
 * A mensagem mandada a quem teve a chamada recusada, em
 * `organizations.settings.calls.reject_message`. `null` = não manda nada (o
 * padrão): ausente, vazia, só espaços ou malformada.
 */
export function mensagemDeRecusaDeChamadas(settings: unknown): string | null {
  if (!settings || typeof settings !== "object") return null;
  const calls = (settings as Record<string, unknown>).calls;
  if (!calls || typeof calls !== "object") return null;
  const texto = (calls as Record<string, unknown>).reject_message;
  if (typeof texto !== "string") return null;
  const limpo = texto.trim().slice(0, MENSAGEM_DE_RECUSA_MAX);
  return limpo === "" ? null : limpo;
}

/** `settings` com a mensagem gravada (vazia apaga), preservando o resto. */
export function comMensagemDeRecusaDeChamadas(
  settings: unknown,
  mensagem: string | null,
): Record<string, unknown> {
  const base = comBloqueioDeChamadas(settings, bloqueioDeChamadasLigado(settings));
  const { reject_message: _antiga, ...calls } = base.calls as Record<string, unknown>;
  const limpo = (mensagem ?? "").trim();
  return { ...base, calls: limpo === "" ? calls : { ...calls, reject_message: limpo } };
}

export interface PoliticaDeChamadas {
  bloqueio: boolean;
  mensagem: string | null;
}

/**
 * Lê a política da organização. LANÇA quando a leitura falha: quem chama decide
 * (a ingestão registra e deixa a ligação tocar — nunca recusa por dúvida).
 */
export async function lerPoliticaDeChamadas(
  admin: SupabaseClient,
  organizationId: string,
): Promise<PoliticaDeChamadas> {
  const { data, error } = await admin
    .from("organizations")
    .select("settings")
    .eq("id", organizationId)
    .maybeSingle();
  if (error) throw new Error(`leitura do bloqueio de chamadas falhou: ${error.message}`);
  const settings = (data as { settings?: unknown } | null)?.settings;
  return {
    bloqueio: bloqueioDeChamadasLigado(settings),
    mensagem: mensagemDeRecusaDeChamadas(settings),
  };
}
