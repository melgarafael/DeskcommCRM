import { createAdminClient } from "@/lib/supabase/admin";
import { auditForOrganizations } from "@/lib/audit";
import { logger } from "@/lib/logger";

/**
 * Apaga TODAS as inscrições de push da pessoa, em todas as organizações. É o
 * passo que acompanha toda saída que encerra a sessão em todos os aparelhos —
 * "Sair" (o `signOut()` do auth-js é `global` por padrão) e "Sair de todos os
 * dispositivos": aparelho desconectado não pode seguir recebendo aviso da empresa.
 *
 * O `userId` vem de `getUser()` de quem chama; o admin client é preciso porque
 * as inscrições de outras organizações não são alcançáveis pela sessão. Nunca
 * lança: falha aqui não impede a saída.
 *
 * Fica em `lib/` e não na action de propósito: exportada de um arquivo
 * `"use server"`, ela viraria uma action que apaga as inscrições de QUALQUER
 * `userId` recebido do navegador.
 */
export async function encerrarPushDeTodosOsAparelhos(userId: string, requestId: string | null): Promise<void> {
  const { data, error } = await createAdminClient()
    .from("push_subscriptions")
    .delete()
    .eq("user_id", userId)
    .select("organization_id");
  if (error) {
    logger.warn("push_subscriptions_signout_global_failed", { detail: error.message });
    return;
  }
  const linhas = data ?? [];
  if (linhas.length === 0) return;
  await auditForOrganizations(
    {
      action: "notification_prefs.push_subscription_removed",
      actorUserId: userId,
      requestId,
      resourceType: "push_subscription",
      bypassedRls: true,
      metadata: { channel: "web_push", escopo: "todos_os_aparelhos", removidas: linhas.length },
    },
    [...new Set(linhas.map((l) => l.organization_id))],
  );
}
