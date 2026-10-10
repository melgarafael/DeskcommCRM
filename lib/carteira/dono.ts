/**
 * DONO QUALIFICADO DA CARTEIRA — quem CONTA como dono do cliente (#2591, regra
 * 5) e quem PODE mudar a carteira (regra: só `manager`+).
 *
 * A mesma régua existe no banco (`fn_definir_carteira_do_cliente` e
 * `fn_crm_lead_nasce_na_carteira` validam antes de gravar). Isto aqui é a
 * leitura do lado de fora: a rota que cria negócio e a ficha do contato precisam
 * responder "o dono conta?" num contato cujo dono pode ter SAÍDO da equipe ou
 * ter virado `viewer` depois de definido — a coluna guarda o id, o vínculo é que
 * decide, e é o vínculo que muda sem mexer em `contacts`.
 *
 * Nunca reescreva esta lista em outro arquivo: os dois gatilhos já dizem o
 * mesmo com SQL, e a divergência entre os três é invisível em tela.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/** Papéis que podem ser dono de carteira: `viewer` fica de fora (só lê). */
export const PAPEIS_DE_CARTEIRA = ["agent", "manager", "admin"] as const;
export type PapelDeCarteira = (typeof PAPEIS_DE_CARTEIRA)[number];

export function papelContaDeCarteira(papel: string | null | undefined): boolean {
  return !!papel && (PAPEIS_DE_CARTEIRA as readonly string[]).includes(papel);
}

export interface CarteiraDoContato {
  /** O id gravado em `contacts.carteira_user_id`, qualificado ou não. */
  dono: string | null;
  /** Membro ativo da MESMA organização com papel que conta? É isto que a regra usa. */
  qualificado: boolean;
}

export const SEM_CARTEIRA: CarteiraDoContato = { dono: null, qualificado: false };

/**
 * Lê a carteira do contato. `admin` é service-role: o `organization_id` do
 * chamador é obrigatório nos dois `.eq` (RLS não segura nada aqui).
 *
 * Falha de leitura devolve `SEM_CARTEIRA` de propósito: quem chama decide
 * degradar (seguir sem carteira) ou recusar, mas NUNCA é a leitura que derruba
 * a criação de um negócio que existiria sem a carteira.
 */
export async function carteiraDoContato(
  admin: SupabaseClient,
  organizationId: string,
  contactId: string | null | undefined,
): Promise<CarteiraDoContato> {
  if (!contactId) return SEM_CARTEIRA;
  const { data: contato } = await admin
    .from("contacts")
    .select("carteira_user_id")
    .eq("id", contactId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  const dono = (contato as { carteira_user_id?: string | null } | null)?.carteira_user_id ?? null;
  if (!dono) return SEM_CARTEIRA;
  return { dono, qualificado: await donoQualificado(admin, organizationId, dono) };
}

/** O vínculo de HOJE decide: membro aceito, não revogado, papel que conta. */
export async function donoQualificado(
  admin: SupabaseClient,
  organizationId: string,
  dono: string,
): Promise<boolean> {
  const { data: vinculo } = await admin
    .from("user_organizations")
    .select("role, accepted_at, revoked_at")
    .eq("user_id", dono)
    .eq("organization_id", organizationId)
    .maybeSingle();
  const linha = vinculo as { role?: string | null; accepted_at?: string | null; revoked_at?: string | null } | null;
  return papelContaDeCarteira(linha?.role) && !!linha?.accepted_at && !linha?.revoked_at;
}
