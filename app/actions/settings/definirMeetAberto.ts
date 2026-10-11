"use server";

/**
 * LIGAR E DESLIGAR "GOOGLE MEET JÁ COM ACESSO ABERTO" (#2063, migration 0579).
 *
 * DESLIGADA (o padrão de toda organização, inclusive de quem já instalou): o
 * Meet da reunião nasce do jeito de sempre, com "pedir para participar". LIGADA
 * + escopo opcional concedido na conexão: o Meet nasce via `spaces.create` com
 * `accessType OPEN` — quem tiver o link entra sem pedir.
 *
 * É a irmã de `definirAgendaDosColegas` em TUDO, menos no nome da RPC: mesmo
 * piso (`manager`), mesma leitura pela SESSÃO, mesma recusa de suporte
 * somente-leitura, mesma auditoria só quando algo mudou, mesmo `revalidatePath`.
 *
 * ⚠️ PELO CLIENT DA SESSÃO, e não pelo admin client: é `auth.uid()` que faz
 * `fn_definir_google_meet_acesso_aberto` reconferir papel, suporte e MFA.
 * Nunca `.from("organizations").update(...)` aqui: pela sessão de um Gerente de
 * tenant essa escrita casa ZERO linhas e devolve sucesso — o defeito clássico
 * que a action da 0262 documenta.
 *
 * ⚠️ O RISCO FAZ PARTE DO DESENHO, e é por isso que a tela mostra o aviso ao
 * lado do interruptor: ligar é decidir que qualquer pessoa com o link entra na
 * reunião. Aqui não se confirma nada além disso — desligar é apertar de novo.
 *
 * O `organization_id` vem de `resolveActiveOrg`, nunca de argumento.
 */
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { supportWriteError } from "@/lib/impersonate/support";
import { logger } from "@/lib/logger";
import { createClient } from "@/lib/supabase/server";

/** O que a RPC devolve. Validado: é o corpo que a tela mostra ao usuário. */
const resultadoSchema = z.object({
  ligado: z.boolean(),
  mudou: z.boolean(),
});

export type ResultadoMeetAberto = z.infer<typeof resultadoSchema>;

/**
 * Códigos, e não frases: a tela traduz (pt-BR/es). Uma frase pronta aqui
 * chegaria em português a quem usa o produto em espanhol.
 */
export type ErroMeetAberto =
  | "sessao"
  | "somente_leitura"
  | "sem_empresa"
  | "sem_permissao"
  | "mfa"
  | "tente_de_novo"
  | "falha";

export type RespostaMeetAberto =
  | ({ ok: true } & ResultadoMeetAberto)
  | { ok: false; erro: ErroMeetAberto };

export async function definirMeetAberto(ligado: boolean): Promise<RespostaMeetAberto> {
  // Server Action é endpoint público: o tipo do parâmetro não chega ao servidor.
  const entrada = z.boolean().safeParse(ligado);
  if (!entrada.success) return { ok: false, erro: "falha" };

  const user = await loadAuthUser();
  if (!user) return { ok: false, erro: "sessao" };
  if (supportWriteError(user.support)) return { ok: false, erro: "somente_leitura" };
  const org = await resolveActiveOrg(user);
  if (!org) return { ok: false, erro: "sem_empresa" };
  if (ROLE_RANK[org.role] < ROLE_RANK.manager) return { ok: false, erro: "sem_permissao" };

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("fn_definir_google_meet_acesso_aberto", {
    p_org: org.orgId,
    p_ligado: entrada.data,
  });

  if (error) {
    if (error.code === "42501") {
      // A função recusa com `mfa_required` quando o fator existe mas a sessão
      // não o comprovou — é o mesmo contrato das duas irmãs.
      return { ok: false, erro: error.message.includes("mfa_required") ? "mfa" : "sem_permissao" };
    }
    // Escrita em `organizations`: a única disputa possível é com outra escrita
    // da mesma linha, serializada pelo Postgres. Estes três desfechos voltam a
    // transação inteira (nada gravado) e tentar de novo resolve:
    //   55P03  o prazo do papel `authenticated` (migration 0243) venceu;
    //   40P01  o Postgres escolheu esta transação para desfazer um ciclo;
    //   40001  conflito de serialização.
    if (error.code === "55P03" || error.code === "40P01" || error.code === "40001") {
      return { ok: false, erro: "tente_de_novo" };
    }
    logger.error("[meet-acesso-aberto] a RPC falhou", {
      organization_id: org.orgId,
      code: error.code,
      error: error.message,
    });
    return { ok: false, erro: "falha" };
  }

  const resultado = resultadoSchema.safeParse(data);
  if (!resultado.success) {
    logger.error("[meet-acesso-aberto] a RPC devolveu um corpo inesperado", {
      organization_id: org.orgId,
    });
    return { ok: false, erro: "falha" };
  }

  if (resultado.data.mudou) {
    await audit({
      action: "agenda.meet_acesso_aberto_alterado",
      actorUserId: user.id,
      organizationId: org.orgId,
      resourceType: "organization",
      resourceId: org.orgId,
      metadata: resultado.data,
    });
  }

  // O layout monta o `ActiveOrg` que as telas leem; sem invalidar, a mudança só
  // apareceria no próximo recarregamento completo.
  revalidatePath("/app", "layout");
  return { ok: true, ...resultado.data };
}
