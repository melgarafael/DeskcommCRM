import "server-only";

import { z } from "zod";

import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

import { ehPermissaoDeArea } from "./areas";
import { EXTENSION_PERMISSIONS, type ExtensionPermission } from "./capacidades";
import { SQL_ERRORS } from "./erros-do-banco";
import { ExtensionServiceError } from "./http";

/**
 * O consentimento por área de um módulo `connected` (spec 33, F3, tarefa 5).
 *
 * A organização diz quais das áreas que o pacote DECLAROU o módulo pode alcançar. Quem confere tudo
 * é `fn_extensions_set_consent` (ator administra a organização, instalação `connected` e ativada,
 * área declarada, `configuracao`/`agentes_ia`/`financeiro` só por `admin`, revisão otimista). Esta camada só traduz
 * o erro do banco, audita e devolve o estado novo.
 *
 * Sem recibo e sem `Idempotency-Key`, de propósito: a função não tem livro de operações. O que protege
 * a repetição é a revisão esperada: o mesmo pedido repetido depois de aplicado encontra a revisão
 * seguinte e recusa com `extension_revision_conflict`, sem gravar duas vezes.
 */

const PERMISSOES_DE_AREA = EXTENSION_PERMISSIONS.filter(ehPermissaoDeArea) as ExtensionPermission[];

export const consentRequestSchema = z
  .object({
    expected_revision: z.number().int().min(0).max(2_147_483_646),
    // Lista FECHADA: só permissões `area.*` do vocabulário. Duplicata e vazio são decididos pelo banco
    // (vazio = retirar tudo, é válido).
    areas: z
      .array(z.enum(PERMISSOES_DE_AREA as [ExtensionPermission, ...ExtensionPermission[]]))
      .max(PERMISSOES_DE_AREA.length),
  })
  .strict();
export type ConsentRequest = z.infer<typeof consentRequestSchema>;

const resultadoSchema = z.object({
  organization_extension: z.object({
    installation_id: z.string().uuid(),
    revision: z.number().int(),
    consented_areas: z.array(z.string()),
  }),
});

export interface ConsentimentoSalvo {
  installation_id: string;
  revision: number;
  consented_areas: string[];
}

/**
 * `fn_extensions_set_consent` levanta `P0001` (entrada, ator, revisão, estado) e `PT409` (área não
 * declarada, área que exige administrador). Os dois chegam com o código na `message`.
 */
function falhaDoBanco(error: { code?: string; message?: string }): never {
  const conhecido =
    (error.code === "P0001" || error.code === "PT409") && error.message
      ? SQL_ERRORS[error.message]
      : undefined;
  if (conhecido && error.message) {
    throw new ExtensionServiceError(error.message, conhecido.message, conhecido.status);
  }
  logger.warn("[extensions] consentimento: falha do banco sem código conhecido", {
    db_code: error.code ?? null,
    detail: (error.message ?? "").slice(0, 200),
  });
  throw new ExtensionServiceError(
    "upstream_unavailable",
    "Não foi possível confirmar o resultado. Consulte o histórico antes de repetir o pedido.",
    503,
  );
}

export async function definirConsentimento(
  actorId: string,
  organizationId: string,
  installationId: string,
  input: ConsentRequest,
): Promise<ConsentimentoSalvo> {
  const resultado = await createAdminClient().rpc("fn_extensions_set_consent", {
    p_actor: actorId,
    p_organization: organizationId,
    p_installation: installationId,
    p_expected_revision: input.expected_revision,
    p_areas: input.areas,
  });
  if (resultado.error) falhaDoBanco(resultado.error);
  const salvo = resultadoSchema.safeParse(resultado.data);
  if (!salvo.success) {
    logger.warn("[extensions] consentimento: resposta do banco ilegível", {
      installation_id: installationId,
    });
    throw new ExtensionServiceError(
      "upstream_unavailable",
      "Não foi possível confirmar o resultado. Consulte o histórico antes de repetir o pedido.",
      503,
    );
  }
  const linha = salvo.data.organization_extension;
  await audit({
    action: "extension.consent_changed",
    actorUserId: actorId,
    organizationId,
    resourceType: "extension_installation",
    resourceId: installationId,
    // Lista fechada de permissões `area.*` e a revisão. Nada de pessoa, segredo ou token.
    metadata: { areas: linha.consented_areas, revision: linha.revision },
  });
  return {
    installation_id: linha.installation_id,
    revision: linha.revision,
    consented_areas: linha.consented_areas,
  };
}
