"use server";

/**
 * LIGAR E DESLIGAR "ATENDENTES PODEM MEXER NA AGENDA DOS COLEGAS" — a opção da
 * migration 0343 (issue #978).
 *
 * LIGADA (o padrão de quem já instalou): qualquer Atendente cancela e remarca o
 * compromisso de qualquer colega. DESLIGADA: o Atendente só mexe no compromisso
 * de que é dono, e Gerente/Administrador seguem mexendo em tudo. Nada de dado é
 * reescrito em nenhum dos sentidos — a regra é lida no ato, não materializada.
 *
 * ⚠️ PELO CLIENT DA SESSÃO, e não pelo admin client: é `auth.uid()` que faz
 * `fn_definir_colegas_podem_mexer_na_agenda` reconferir papel, suporte e MFA.
 * Nunca `.from("organizations").update(...)` aqui: pela sessão de um Gerente de
 * tenant essa escrita casa ZERO linhas e devolve sucesso — o defeito clássico
 * que a action da 0262 documenta.
 *
 * ⚠️ O PAPEL É CONFERIDO TRÊS VEZES, e só a última é autoridade: a tela
 * (desabilita o interruptor), esta action (não chama a RPC à toa) e o corpo da
 * função (decide). O piso é `manager`, e não o `admin` da regra de clientes: é
 * regra da AGENDA, mora na mesma tela de `fn_agenda_settings` (os prazos ao
 * lado), e não reescreve nem classifica histórico nenhum.
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

export type ResultadoAgendaDosColegas = z.infer<typeof resultadoSchema>;

/**
 * Códigos, e não frases: a tela traduz (pt-BR/es). Uma frase pronta aqui
 * chegaria em português a quem usa o produto em espanhol.
 */
export type ErroAgendaDosColegas =
  | "sessao"
  | "somente_leitura"
  | "sem_empresa"
  | "sem_permissao"
  | "mfa"
  | "tente_de_novo"
  | "falha";

export type RespostaAgendaDosColegas =
  | ({ ok: true } & ResultadoAgendaDosColegas)
  | { ok: false; erro: ErroAgendaDosColegas };

export async function definirAgendaDosColegas(
  ligado: boolean,
): Promise<RespostaAgendaDosColegas> {
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
  const { data, error } = await supabase.rpc("fn_definir_colegas_podem_mexer_na_agenda", {
    p_org: org.orgId,
    p_ligado: entrada.data,
  });

  if (error) {
    if (error.code === "42501") {
      // A função recusa com `mfa_required` quando o fator existe mas a sessão
      // não o comprovou — é o mesmo contrato que a action de clientes lê.
      return { ok: false, erro: error.message.includes("mfa_required") ? "mfa" : "sem_permissao" };
    }
    // A escrita é um UPDATE de uma linha em `organizations`: a única disputa
    // possível é com outra escrita da mesma linha, e ela é serializada pelo
    // Postgres. Estes três desfechos voltam a transação inteira (nada gravado)
    // e tentar de novo resolve:
    //   55P03  o prazo do papel `authenticated` (migration 0243) venceu;
    //   40P01  o Postgres escolheu esta transação para desfazer um ciclo;
    //   40001  conflito de serialização.
    if (error.code === "55P03" || error.code === "40P01" || error.code === "40001") {
      return { ok: false, erro: "tente_de_novo" };
    }
    logger.error("[agenda-dos-colegas] a RPC falhou", {
      organization_id: org.orgId,
      code: error.code,
      error: error.message,
    });
    return { ok: false, erro: "falha" };
  }

  const resultado = resultadoSchema.safeParse(data);
  if (!resultado.success) {
    logger.error("[agenda-dos-colegas] a RPC devolveu um corpo inesperado", {
      organization_id: org.orgId,
    });
    return { ok: false, erro: "falha" };
  }

  if (resultado.data.mudou) {
    await audit({
      action: "agenda.colegas_podem_mexer_alterado",
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
