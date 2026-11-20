"use server";

/**
 * GRAVAR E LER AS ABAS DA INBOX DE CADA PESSOA (#3313, item 2) — as duas metades.
 *
 * O mesmo desenho da lateral do contato (`app/actions/inbox/modulosDaLateral.ts`,
 * #3008): a preferência mora no `raw_user_meta_data` da própria pessoa, gravada
 * com a sessão dela (`updateUser`). Sem migration, sem RLS nova, sem GRANT novo.
 *
 * `updateUser` faz merge por chave de TOPO: o resto do metadata (nome, idioma,
 * lateral, lembretes) não é tocado. O que se regrava inteiro é o valor desta
 * chave — a lista completa, já normalizada por `normalizarAbas`.
 */

import { revalidatePath } from "next/cache";

import { audit } from "@/lib/audit";
import { invalidarUsuario } from "@/lib/auth/cache-curto";
import { loadAuthUser } from "@/lib/auth/server";
import { supportWriteError } from "@/lib/impersonate/support";
import {
  CHAVE_DAS_ABAS,
  abasDaInboxSchema,
  lerAbasDaInbox,
  normalizarAbas,
  type AbaDaPessoa,
} from "@/lib/inbox/abas-da-inbox";
import { logger } from "@/lib/logger";
import { createClient } from "@/lib/supabase/server";

/** Códigos, e não frases: a tela traduz — a mesma régua da lateral. */
export type ErroDasAbasDaInbox = "sessao" | "somente_leitura" | "validacao" | "falha";

export type RespostaDasAbasDaInbox =
  | { ok: true; abas: AbaDaPessoa[] }
  | { ok: false; erro: ErroDasAbasDaInbox };

export async function salvarAbasDaInbox(input: AbaDaPessoa[]): Promise<RespostaDasAbasDaInbox> {
  // Server Action é endpoint público: o tipo do parâmetro não chega ao servidor.
  const parsed = abasDaInboxSchema.safeParse(input);
  if (!parsed.success) return { ok: false, erro: "validacao" };

  const authUser = await loadAuthUser();
  if (!authUser) return { ok: false, erro: "sessao" };
  if (supportWriteError(authUser.support)) return { ok: false, erro: "somente_leitura" };

  // Normaliza ANTES de gravar: a mesma régua da leitura. O metadata guarda
  // sempre a lista completa, com pelo menos uma aba visível.
  const abas = normalizarAbas(parsed.data);

  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser({
    data: { [CHAVE_DAS_ABAS]: abas },
  });
  // #3696: o `getUser` vai para o cache curto; outra sessão da pessoa leria o metadata velho.
  invalidarUsuario(authUser.id);
  if (error) {
    logger.error("[inbox-abas] updateUser falhou", {
      user_id: authUser.id,
      error: error.message,
    });
    return { ok: false, erro: "falha" };
  }

  await audit({
    action: "user.inbox_tabs_updated",
    actorUserId: authUser.id,
    organizationId: null,
    resourceType: "user",
    resourceId: authUser.id,
    // A ORDEM e as OCULTAS: é o que responde "por que a Inbox desta pessoa abre
    // diferente" sem arrastar nada do resto do metadata para o histórico.
    metadata: {
      visiveis: abas.filter((a) => a.visivel).map((a) => a.id),
      ocultas: abas.filter((a) => !a.visivel).map((a) => a.id),
      ordem: abas.map((a) => a.id),
    },
  });

  revalidatePath("/app/inbox");
  // Devolve o que foi GRAVADO (normalizado), não o que chegou.
  return { ok: true, abas };
}

/**
 * O que a faixa desenha ao abrir — a preferência gravada, já normalizada.
 *
 * Lê com a sessão da pessoa (`getUser`). Sem sessão ou com falha de leitura,
 * devolve o padrão: a faixa de hoje.
 */
export async function carregarAbasDaInbox(): Promise<{ ok: boolean; abas: AbaDaPessoa[] }> {
  const authUser = await loadAuthUser();
  if (!authUser) return { ok: false, abas: lerAbasDaInbox(undefined) };

  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();
  if (error) {
    logger.warn("[inbox-abas] getUser falhou ao ler a preferência — usando o padrão", {
      user_id: authUser.id,
      error: error.message,
    });
    return { ok: false, abas: lerAbasDaInbox(undefined) };
  }
  return { ok: true, abas: lerAbasDaInbox(data.user?.user_metadata ?? undefined) };
}
