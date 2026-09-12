import { createClient } from "@/lib/supabase/server";

/**
 * Esta pessoa TEVE acesso a alguma organização e ele foi retirado?
 *
 * A pergunta existe porque `loadAuthUser` filtra `.is("revoked_at", null)`
 * (`lib/auth/server.ts`) — decisão certa para montar o menu, e que joga fora a
 * única informação capaz de distinguir dois estados muito diferentes:
 *
 *  - **nunca teve organização** — signup cujo provisionamento falhou. O
 *    caminho legítimo é `/get-started`, que existe justamente para isso.
 *  - **teve e foi revogada** — alguém retirou o acesso. Oferecer "configure
 *    sua organização" aqui transforma uma revogação em criação de tenant, o
 *    que numa instalação privada é o mesmo buraco do cadastro aberto por outra
 *    porta.
 *
 * Medido em 2026-09-10: um membro revogado via a tela vazia com o convite
 * "Configure sua organização", e só não criou uma porque ainda tinha
 * `invite_token` no `user_metadata` — acidente, não guarda. E a mensagem que o
 * barrou dizia "convite pendente ou inválido", que não era a verdade.
 *
 * **Nunca lança.** Roda em `app/app/layout.tsx`, e um throw ali é 500 em todas
 * as telas; erro de consulta degrada para `false`, que é o comportamento
 * anterior a esta função existir.
 *
 * Não é caminho quente: só é chamada quando NÃO há organização ativa.
 */
export async function acessoFoiRevogado(userId: string): Promise<boolean> {
  try {
    const supabase = await createClient();
    // A RLS `user_orgs_select` já limita a `user_id = auth.uid()`; o filtro
    // explícito fica porque toda query que cruza tabela tenant-aware filtra o
    // dono na mão, e porque `service_role` bypassa RLS se um dia chamarem daqui.
    const { data, error } = await supabase
      .from("user_organizations")
      .select("id")
      .eq("user_id", userId)
      .not("revoked_at", "is", null)
      .limit(1);

    if (error) return false;
    return (data?.length ?? 0) > 0;
  } catch {
    return false;
  }
}
