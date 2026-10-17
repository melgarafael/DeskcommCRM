"use server";

/**
 * GRAVAR A PREFERÊNCIA DE LEMBRETE DE TAREFA (#2529) — a metade que o cron lê.
 *
 * As categorias de notificação da tela (`lib/notifications/prefs.ts`) gravam no
 * `localStorage`, que é por NAVEGADOR e só decide o que a aba aberta faz. O
 * lembrete de prazo é o caso inverso: nasce num cron, com o site fechado, e
 * tem de chegar a quem não abriu nada — então a escolha precisa estar no
 * SERVIDOR, por PESSOA. O sítio é `raw_user_meta_data`, o mesmo onde o perfil
 * grava idioma e fuso (`updateProfile.ts`): sem migration nova, escrito pela
 * própria pessoa (cada uma grava a dela) e lido pelo cron via `service_role`.
 *
 * O objeto inteiro é regravado a cada chamada — a tela manda os quatro campos
 * juntos, e um campo faltando voltaria ao padrão do produto em vez de ficar
 * como estava. `updateUser` faz merge por chave de topo, então o resto do
 * metadata (nome, idioma, avatar) não é tocado.
 */
import { revalidatePath } from "next/cache";

import { audit } from "@/lib/audit";
import { loadAuthUser } from "@/lib/auth/server";
import { supportWriteError } from "@/lib/impersonate/support";
import { logger } from "@/lib/logger";
import { createClient } from "@/lib/supabase/server";
import {
  CHAVE_DA_PREFERENCIA,
  lerPreferenciaDeLembrete,
  preferenciaDeLembreteSchema,
  type PreferenciaDeLembrete,
} from "@/lib/tarefas/preferencia-de-lembrete";

/**
 * Códigos, e não frases: a tela traduz (pt-BR/es) — a mesma régua das outras
 * actions de configuração.
 */
export type ErroDaPreferenciaDeLembrete =
  | "sessao"
  | "somente_leitura"
  | "validacao"
  | "falha";

export type RespostaDaPreferenciaDeLembrete =
  | { ok: true; preferencia: PreferenciaDeLembrete }
  | { ok: false; erro: ErroDaPreferenciaDeLembrete };

export async function updateTaskReminderPrefs(
  input: PreferenciaDeLembrete,
): Promise<RespostaDaPreferenciaDeLembrete> {
  // Server Action é endpoint público: o tipo do parâmetro não chega ao
  // servidor, e o número de WhatsApp é texto que vai parar num envio.
  const parsed = preferenciaDeLembreteSchema.safeParse(input);
  if (!parsed.success) return { ok: false, erro: "validacao" };

  const authUser = await loadAuthUser();
  if (!authUser) return { ok: false, erro: "sessao" };
  if (supportWriteError(authUser.support)) return { ok: false, erro: "somente_leitura" };

  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser({
    data: { [CHAVE_DA_PREFERENCIA]: parsed.data },
  });
  if (error) {
    logger.error("[task-reminder-prefs] updateUser falhou", {
      user_id: authUser.id,
      error: error.message,
    });
    return { ok: false, erro: "falha" };
  }

  await audit({
    action: "user.task_reminder_prefs_updated",
    actorUserId: authUser.id,
    organizationId: null,
    resourceType: "user",
    resourceId: authUser.id,
    // O NÚMERO não entra no audit: é dado de contato da pessoa, e o audit é
    // histórico legível por quem administra a instalação.
    metadata: {
      task_due: parsed.data.task_due,
      task_overdue: parsed.data.task_overdue,
      antecedencia_min: parsed.data.antecedencia_min,
      whatsapp: parsed.data.whatsapp,
      whatsapp_numero_definido: Boolean(parsed.data.whatsapp_numero),
    },
  });

  revalidatePath("/app/settings/notifications");
  // `input` passou pela schema (mesmo objeto, campo a campo): devolvê-lo é o
  // que mantém o TIPO da tela e o do cron iguais — os dois falam
  // `PreferenciaDeLembrete`, e a schema é que recusa o que não é válido.
  return { ok: true, preferencia: input };
}

/**
 * O que a tela mostra ao abrir — a preferência gravada, já normalizada.
 *
 * Pura quanto a leitura: `lerPreferenciaDeLembrete` é quem decide o padrão, e
 * é o MESMO leitor do cron. Tela e cron discordando do que vale é o defeito que
 * esta única fonte existe para impedir.
 */
export async function carregarTaskReminderPrefs(): Promise<{
  ok: boolean;
  preferencia: ReturnType<typeof lerPreferenciaDeLembrete>;
}> {
  const authUser = await loadAuthUser();
  if (!authUser) return { ok: false, preferencia: lerPreferenciaDeLembrete(undefined) };
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  return {
    ok: true,
    preferencia: lerPreferenciaDeLembrete(data.user?.user_metadata ?? undefined),
  };
}
