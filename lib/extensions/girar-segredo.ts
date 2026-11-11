/**
 * Girar o segredo de uma instalação `connected` (spec 33, F2, tarefa 4 e emenda 3).
 *
 * O segredo novo é gerado, cifrado e gravado em `extension_installation_secrets` (UPSERT: substitui o
 * anterior ou cria o primeiro, quando a instalação nasceu com `secret_pending`). Em seguida os tokens
 * vivos da instalação são revogados, um `fn_extensions_module_token_revoke` por organização que tem
 * token vivo dela: o módulo precisa buscar de novo, agora com o segredo novo.
 *
 * Regras que não mudam:
 * - O segredo em claro sai SÓ no retorno desta função (a rota o devolve uma vez). Não vai a log, a
 *   auditoria, a recibo (não há recibo: emenda 3) nem a mensagem de erro.
 * - Sem `Idempotency-Key`: repetir o pedido gera OUTRO segredo. Um recibo reproduziria o segredo em claro.
 * - Gravar primeiro e revogar depois: a partir da gravação nenhuma busca com o segredo velho passa; se a
 *   revogação falhar, a resposta é erro (o segredo novo não é mostrado) e repetir o pedido gira de novo e revoga.
 */
import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

import { ExtensionServiceError } from "./http";
import {
  cifrarSegredo,
  CODIGO_CHAVE_DE_CIFRA_AUSENTE,
  ehChaveDeCifraAusente,
  gerarSegredo,
} from "./segredo-do-modulo";

export const CODIGO_SEGREDO_NAO_SE_APLICA = "extension_secret_not_applicable";

const NAO_CONFIRMADO =
  "Não foi possível confirmar o resultado. Consulte o histórico antes de repetir o pedido.";

export interface SegredoGirado {
  /** O segredo em claro. Aparece só aqui. */
  secret: string;
  rotated_at: string;
}

function indisponivel(): ExtensionServiceError {
  return new ExtensionServiceError("upstream_unavailable", NAO_CONFIRMADO, 503);
}

export async function girarSegredoDaInstalacao(
  actorId: string,
  installationId: string,
): Promise<SegredoGirado> {
  const admin = createAdminClient();

  const instalacao = await admin
    .from("extension_installations")
    .select("id,artifact_id,removed_at")
    .eq("id", installationId)
    .maybeSingle();
  if (instalacao.error) {
    logger.warn("[extensions] girar segredo: instalação não lida", {
      installation_id: installationId,
      db_code: instalacao.error.code ?? null,
    });
    throw indisponivel();
  }
  const linha = instalacao.data as { artifact_id: string; removed_at: string | null } | null;
  if (!linha) {
    throw new ExtensionServiceError("extension_installation_not_found", "Extensão não encontrada.", 404);
  }
  if (linha.removed_at) {
    throw new ExtensionServiceError(
      "extension_removed",
      "O responsável pela instalação removeu esta extensão de todas as organizações.",
      410,
    );
  }

  // O perfil vem do artefato admitido, como em `fn_extensions_set_switch`.
  const artefato = await admin
    .from("extension_artifacts")
    .select("manifest")
    .eq("id", linha.artifact_id)
    .maybeSingle();
  if (artefato.error) {
    logger.warn("[extensions] girar segredo: artefato não lido", { installation_id: installationId });
    throw indisponivel();
  }
  const manifesto = (artefato.data as { manifest?: { profile?: unknown } } | null)?.manifest;
  if (!manifesto || manifesto.profile !== "connected") {
    throw new ExtensionServiceError(
      CODIGO_SEGREDO_NAO_SE_APLICA,
      "Só um módulo conectado tem segredo nesta instalação.",
      409,
    );
  }

  // Cifrar ANTES de qualquer escrita: chave ausente não grava nada.
  const segredo = gerarSegredo();
  let ciphertext: string;
  try {
    ciphertext = cifrarSegredo(segredo);
  } catch (error) {
    if (ehChaveDeCifraAusente(error)) {
      throw new ExtensionServiceError(CODIGO_CHAVE_DE_CIFRA_AUSENTE, error.message, 503);
    }
    throw error;
  }

  const rotatedAt = new Date().toISOString();
  const gravado = await admin.from("extension_installation_secrets").upsert(
    {
      installation_id: installationId,
      ciphertext,
      rotated_by: actorId,
      rotated_at: rotatedAt,
    },
    { onConflict: "installation_id" },
  );
  if (gravado.error) {
    logger.warn("[extensions] segredo do módulo não gravado", {
      installation_id: installationId,
      db_code: gravado.error.code ?? null,
    });
    throw indisponivel();
  }

  // Quem tem token vivo desta instalação: uma revogação por organização, nenhuma outra.
  const vivos = await admin
    .from("api_tokens")
    .select("organization_id")
    .eq("extension_installation_id", installationId)
    .is("revoked_at", null);
  if (vivos.error) {
    logger.warn("[extensions] tokens do módulo não listados", { installation_id: installationId });
    throw indisponivel();
  }
  const organizacoes = [
    ...new Set(
      ((vivos.data ?? []) as Array<{ organization_id: string }>).map((token) => token.organization_id),
    ),
  ];
  for (const organizationId of organizacoes) {
    const revogado = await admin.rpc("fn_extensions_module_token_revoke", {
      p_organization: organizationId,
      p_installation: installationId,
      p_by: actorId,
    });
    if (revogado.error) {
      logger.warn("[extensions] token do módulo não revogado", {
        installation_id: installationId,
        db_code: revogado.error.code ?? null,
      });
      throw indisponivel();
    }
  }

  await audit({
    action: "extension.secret_rotated",
    actorUserId: actorId,
    actingAsPlatformAdmin: true,
    resourceType: "extension_installation",
    resourceId: installationId,
    // Nunca o segredo, nem o cifrado: só a contagem do que deixou de valer.
    metadata: { organizations_revoked_count: organizacoes.length },
  });

  return { secret: segredo, rotated_at: rotatedAt };
}
