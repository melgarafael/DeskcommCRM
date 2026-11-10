"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";

import { invalidarUsuario } from "@/lib/auth/cache-curto";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { audit } from "@/lib/audit";
import { respostaParaOperador } from "@/lib/erros/para-operador";
import { ipDoCliente } from "@/lib/http/ip-do-cliente";
import { IDIOMAS, type Idioma } from "@/lib/i18n/idiomas";
import { createClient } from "@/lib/supabase/server";

/**
 * Troca o idioma da interface pelo seletor do topo.
 *
 * ─── Por que uma ação PRÓPRIA, e não `updateProfile` ───────────────────────
 *
 * `updateProfile` valida o formulário INTEIRO — nome, fuso, avatar. Chamá-la
 * daqui obrigaria o seletor do topo a conhecer e reenviar campos que ele não
 * mostra, e um deles chegar vazio apagaria o dado de quem só queria trocar de
 * idioma. Uma ação que faz uma coisa não tem esse modo de falha.
 *
 * ─── O que ela grava, e o que NÃO grava ────────────────────────────────────
 *
 * Escreve a PREFERÊNCIA da pessoa (`user_metadata.locale`), nunca o idioma da
 * organização: trocar o próprio idioma no topo não pode mudar o que os colegas
 * veem. O idioma da empresa continua onde tem dono — Configurações ›
 * Organização, sob permissão de admin.
 */
export async function trocarIdioma(
  idioma: Idioma,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!(IDIOMAS as readonly string[]).includes(idioma)) {
    return { ok: false, error: "idioma_desconhecido" };
  }

  const authUser = await loadAuthUser();
  if (!authUser) return { ok: false, error: "unauthenticated" };

  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser({ data: { locale: idioma } });
  // #3696: o `getUser` vai para o cache curto; outra sessão da pessoa leria o metadata velho.
  invalidarUsuario(authUser.id);
  if (error) {
    // #3747: o toast leva a frase do operador; o texto do GoTrue fica no log.
    return respostaParaOperador(error, {
      contexto: "[idioma] falha ao gravar a preferência de idioma",
      idioma: authUser.idioma,
    });
  }

  const hdrs = await headers();
  const activeOrg = await resolveActiveOrg(authUser);
  await audit({
    action: "profile.updated",
    actorUserId: authUser.id,
    organizationId: activeOrg?.orgId ?? null,
    resourceType: "user",
    resourceId: authUser.id,
    requestId: hdrs.get("x-request-id"),
    ip: ipDoCliente(hdrs),
    userAgent: hdrs.get("user-agent") ?? null,
    metadata: { locale: idioma, origem: "seletor_do_topo" },
  });

  // O layout inteiro lê `user.idioma`; sem revalidar, a próxima navegação
  // ainda viria montada no idioma anterior.
  revalidatePath("/app", "layout");
  return { ok: true };
}
