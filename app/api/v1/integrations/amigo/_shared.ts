import { fail } from "@/lib/api/wrappers";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { AmigoDomainError } from "@/lib/amigo/access";
import { AmigoError } from "@/lib/amigo/transport";
import { ZodError } from "zod";

export function amigoFailure(error: unknown, requestId: string) {
  if (error instanceof AmigoDomainError || error instanceof AmigoError)
    return fail(error.code, error.message, error.status, { requestId });
  if (error instanceof ZodError || error instanceof SyntaxError)
    return fail("amigo_invalid_input", "Confira os campos informados.", 422, { requestId });
  // Do not reflect database errors, provider response bodies or credentials.
  return fail(
    "amigo_unavailable",
    "Não foi possível concluir a operação Amigo. Confira a configuração e tente atualizar os dados.",
    503,
    { requestId },
  );
}

/** O módulo `amigo` desligado na instalação: a rota não existe para ninguém (o padrão de cadências). */
export async function amigoDesligado(): Promise<boolean> {
  return !(await moduloLigado(createAdminClient(), "amigo"));
}

export function moduloIndisponivel(requestId: string) {
  return fail("not_found", "Módulo indisponível.", 404, { requestId });
}

/**
 * O contato vindo do corpo/da query passa pela MESMA porta que o resto do
 * produto usa para mostrar uma ficha: a leitura pela sessão de quem chama, sob a
 * RLS de `contacts`. O domínio do Amigo lê com o client de serviço; sem esta
 * conferência, o id do contato seria aceito só por estar na organização certa.
 */
export async function contatoVisivelNaSessao(contactId: string, orgId: string): Promise<boolean> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("contacts")
    .select("id")
    .eq("organization_id", orgId)
    .eq("id", contactId)
    .eq("is_anonymized", false)
    .maybeSingle();
  return !error && !!data;
}

export function contatoForaDoAlcance(requestId: string) {
  return fail("forbidden", "Este contato não está disponível para você.", 403, { requestId });
}
