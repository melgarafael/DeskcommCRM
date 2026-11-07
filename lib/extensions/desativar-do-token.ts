/**
 * Revogar o token de um módulo `connected` na tela de tokens (spec 33, F2, tarefa 6) é DESATIVAR a
 * ativação daquele par naquela organização: o mesmo caminho da tela de extensões (`configureExtension`
 * com `enabled: false`). O banco revoga o token na mesma transação (`fn_extensions_configure`).
 *
 * A revisão esperada e a configuração são lidas AGORA, da linha da organização: quem clica em "Revogar"
 * não viu a revisão da ativação. Se alguém mexeu entre a leitura e a gravação, a função devolve
 * `extension_revision_conflict` e a rota responde o erro dela.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { createAdminClient } from "@/lib/supabase/admin";

import type { ExtensionConfiguration } from "./manifest";
import { configureExtension } from "./service";

const linhaSchema = z.object({
  enabled: z.boolean(),
  revision: z.number().int().min(0),
  configuration: z.object({
    density: z.enum(["comfortable", "compact"]),
    show_description: z.boolean(),
    theme: z.string().optional(),
  }).passthrough(),
});

/**
 * `true` quando esta chamada desativou a ativação; `false` quando ela já estava desligada (ou nem existe),
 * caso em que quem chamou revoga só a linha do token. Erros do serviço sobem como estão.
 */
export async function desativarAtivacaoDoModulo(
  actorId: string,
  organizationId: string,
  installationId: string,
): Promise<boolean> {
  const { data, error } = await createAdminClient()
    .from("organization_extensions")
    .select("enabled, revision, configuration")
    .eq("organization_id", organizationId)
    .eq("installation_id", installationId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return false;
  const linha = linhaSchema.parse(data);
  if (!linha.enabled) return false;
  await configureExtension(actorId, organizationId, installationId, randomUUID(), {
    expected_revision: linha.revision,
    enabled: false,
    configuration: linha.configuration as unknown as ExtensionConfiguration,
  });
  return true;
}
