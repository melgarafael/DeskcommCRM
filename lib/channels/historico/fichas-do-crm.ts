/**
 * O casamento do escopo "só contatos do CRM" da importação do histórico (Spec 32 §1).
 *
 * Um chat do acervo entra na importação com escopo `so_crm` SÓ se casar com uma
 * FICHA VIVA da organização. Esta função nunca cria ficha: quem cria é a rodada
 * no escopo `todos` (`fn_upsert_wa_contact`), e o escopo `so_crm` existe justamente
 * para não criar ninguém.
 *
 * ─── Falha fechada ──────────────────────────────────────────────────────────
 *
 * Erro na consulta LANÇA. Não se devolve `null`: `null` quer dizer "sem ficha",
 * e a rodada pularia o chat em silêncio. Por isso não se usa
 * `encontrarContatoPorTelefone` como está: ele engole o erro da consulta
 * (C16 da Spec 32), e um erro transitório viraria "este cliente não está no CRM"
 * e a conversa dele ficaria de fora sem aviso.
 *
 * ─── Ordem do casamento ─────────────────────────────────────────────────────
 *
 *   1. `contacts.wa_lid` (o @lid que sobrevive à troca de telefone);
 *   2. cada telefone, com as grafias do nono dígito (`phoneLookupVariants`).
 *      Entre as grafias de um mesmo telefone vence a canônica
 *      (`escolherContatoCanonico`, a mesma regra do cadastro por telefone).
 *
 * Toda consulta filtra `organization_id` da importação (a organização vem da
 * linha da importação, nunca do corpo do pedido) e exclui contato fundido e
 * contato anonimizado: fundido aponta para outro cadastro; anonimizado é
 * cadastro morto pela LGPD.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { escolherContatoCanonico } from "@/lib/channels/contato-por-telefone";
import { identidadeDoChat } from "@/lib/channels/historico/mapear";
import { phoneLookupVariants } from "@/lib/channels/phone-variants";
import { parseChatId, telefoneAlternativoDe, type WahaPayload } from "@/lib/waha/ingest";

/** `todos` é a importação de hoje (cria ficha). `so_crm` só completa conversas de quem já tem ficha. */
export type EscopoDaImportacao = "todos" | "so_crm";

export type FichaDoCrm = { contactId: string };

export async function fichaDoCrmParaOChat(
  admin: SupabaseClient,
  args: { organizationId: string; telefones: string[]; lid: string | null },
): Promise<FichaDoCrm | null> {
  const { organizationId } = args;

  if (args.lid) {
    const { data, error } = await admin
      .from("contacts")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("wa_lid", args.lid)
      .is("is_merged_into", null)
      .eq("is_anonymized", false)
      .limit(1);
    // Falha fechada (C16): erro na consulta lança, não vira "sem ficha".
    if (error) throw new Error(`fichas_do_crm: ${error.message}`);
    const achado = ((data ?? []) as Array<{ id: string }>)[0];
    if (achado) return { contactId: achado.id };
  }

  const telefones = new Set(args.telefones.filter((t) => t && t.trim() !== ""));
  for (const telefone of telefones) {
    const variantes = phoneLookupVariants(telefone);
    if (variantes.length === 0) continue;
    const { data, error } = await admin
      .from("contacts")
      .select("id, phone_number")
      .eq("organization_id", organizationId)
      .in("phone_number", variantes)
      .is("is_merged_into", null)
      .eq("is_anonymized", false)
      // Quatro é folga sobre as duas grafias possíveis (mesmo limite do cadastro por telefone).
      .limit(4);
    // Falha fechada (C16): ver o cabeçalho.
    if (error) throw new Error(`fichas_do_crm: ${error.message}`);
    const escolhida = escolherContatoCanonico(
      (data ?? []) as Array<{ id: string; phone_number: string | null }>,
      telefone,
    );
    if (escolhida) return { contactId: escolhida.id };
  }
  return null;
}

/**
 * Os telefones com que se procura a ficha de UM chat: o do próprio chat, o que o
 * canal resolveu para o @lid (pode ser `null` logo após um pareamento novo, C17) e
 * os que as mensagens trazem (`remoteJidAlt`). Pura: quem chama é que consulta.
 */
export function telefonesDoChatParaFicha(
  chatId: string,
  telefoneResolvido: string | null,
  mensagens: WahaPayload[],
): string[] {
  // Cada fonte grafa o número de um jeito (`+5511…` do chat, `5511…` do canal):
  // só dígitos, para não repetir o mesmo número nem buscar duas vezes. As
  // variantes do nono dígito saem depois, na busca da ficha.
  const telefones = new Set<string>();
  const somar = (valor: string | null | undefined) => {
    const digitos = (valor ?? "").replace(/\D/g, "");
    if (digitos) telefones.add(digitos);
  };
  somar(parseChatId(chatId).phone);
  somar(telefoneResolvido);
  for (const p of mensagens) {
    somar(telefoneAlternativoDe(p));
    somar(identidadeDoChat(p).phone);
  }
  return [...telefones];
}
