import { z } from "zod";

/**
 * Remetente de uma mensagem de GRUPO (`messages.metadata.group_sender`): nome, telefone e
 * lid de um participante, que pode ou não ser contato do CRM.
 *
 * LGPD: `phone` e `lid` são a CHAVE com que a cascata acha o autor. Quando o participante
 * JÁ É contato do CRM, `fn_redigir_conversas_ao_anonimizar` e `lib/lgpd/export-collector.ts`
 * casam este campo com `contacts.phone_number` (grafias com e sem o nono dígito) ou
 * `contacts.wa_lid`, e redigem/exportam as mensagens de grupo dele. Mudar o formato de
 * `phone` (`+` e dígitos) ou de `lid` (só dígitos) quebra esse casamento em silêncio.
 *
 * O participante que NÃO é contato continua sem caminho: sem ficha não há titular por
 * quem buscar. Racional na spec (docs/superpowers/specs/2026-09-23-grupos-na-inbox-design.md,
 * "LGPD — mensagens de grupo").
 */
export const remetenteDeGrupoSchema = z.strictObject({
  name: z.string().min(1).max(200).nullable(),
  phone: z.string().regex(/^\+\d{8,15}$/).nullable(),
  lid: z.string().regex(/^\d{5,40}$/).nullable(),
});

export type RemetenteDeGrupo = z.infer<typeof remetenteDeGrupoSchema>;

/**
 * O que basta para ROTULAR quem falou: nome e telefone. `lid` fica de fora de
 * propósito — é identificador interno do WhatsApp, e o perfil que vai ao prompt
 * (`LeadContextMessage.sender`) não o carrega. Exigir o `lid` aqui estreitava o
 * parâmetro sem motivo e obrigava o chamador a inventar um valor que não existe
 * no contexto.
 *
 * O registro COMPLETO (com `lid`) continua aceito: quem tem o dado de produção
 * na mão passa como veio, sem recortar campo. Duas formas de chamar, um só
 * rótulo — as duas foram medidas.
 */
export type RemetenteRotulavel = Pick<RemetenteDeGrupo, "name" | "phone"> | RemetenteDeGrupo;

export function lerRemetenteDeGrupo(metadata: unknown): RemetenteDeGrupo | null {
  if (!metadata || typeof metadata !== "object") return null;
  const bruto = (metadata as Record<string, unknown>).group_sender;
  const r = remetenteDeGrupoSchema.safeParse(bruto);
  return r.success ? r.data : null;
}

export function rotuloDoRemetente(r: RemetenteRotulavel): string {
  if (r.name && r.phone) return `${r.name} · ${r.phone}`;
  return r.name ?? r.phone ?? "Participante";
}
