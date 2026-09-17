"use server";

/**
 * LIGAR E DESLIGAR "CLIENTES PELA AGENDA" — a regra da migration 0262.
 *
 * Com ela ligada, quem tem horário marcado ganha a etiqueta `cliente` e a data
 * de "Cliente desde"; ao ligar, o histórico da organização é classificado na
 * mesma transação. Desligada (o padrão de toda organização), nada acontece.
 *
 * ⚠️ PELO CLIENT DA SESSÃO, E NÃO PELO ADMIN CLIENT — ao contrário de
 * `definirExigenciaDeMfa`. Lá é leitura-mescla-escrita de um booleano; aqui
 * ligar é gravar a chave E reescrever etiquetas de toda a organização, e só o
 * banco dá as duas coisas atômicas e serializadas com os agendamentos em voo.
 * `fn_definir_cliente_pela_agenda` confere papel, suporte e MFA pelo
 * `auth.uid()`, que o admin client não tem. E nunca
 * `.from("organizations").update(...)`: pela sessão de um admin de tenant ele
 * casa ZERO linhas e devolve sucesso.
 *
 * ⚠️ O PAPEL É CONFERIDO TRÊS VEZES, e só a última é autoridade: a tela
 * (esconde), esta action (não chama a RPC à toa) e o corpo da função (decide).
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
  ganharam_etiqueta: z.number().int().nonnegative(),
  perderam_etiqueta: z.number().int().nonnegative(),
  clientes: z.number().int().nonnegative(),
  /**
   * Contatos que TÊM horário e nenhum que conte (todos cancelados ou faltas).
   * É o que distingue "esta agenda está vazia" de "esta agenda só tem
   * cancelamento" — sem ele a tela dizia a primeira frase sobre a segunda
   * organização. `.default(0)` porque a coluna é nova no corpo da RPC: um banco
   * que ainda não aplicou o apêndice devolve o corpo antigo, e um campo
   * obrigatório transformaria isso em "Não consegui salvar essa mudança agora".
   */
  com_agendamento_que_nao_conta: z.number().int().nonnegative().default(0),
});

export type ResultadoClientePelaAgenda = z.infer<typeof resultadoSchema>;

/**
 * Códigos, e não frases: a tela traduz (pt-BR/es). Uma frase pronta aqui
 * chegaria em português a quem usa o produto em espanhol.
 */
export type ErroClientePelaAgenda =
  | "sessao"
  | "somente_leitura"
  | "sem_empresa"
  | "sem_permissao"
  | "mfa"
  | "tente_de_novo"
  | "falha";

export type RespostaClientePelaAgenda =
  | ({ ok: true } & ResultadoClientePelaAgenda)
  | { ok: false; erro: ErroClientePelaAgenda };

export async function definirClientePelaAgenda(
  ligado: boolean,
): Promise<RespostaClientePelaAgenda> {
  // Server Action é endpoint público: o tipo do parâmetro não chega ao servidor.
  const entrada = z.boolean().safeParse(ligado);
  if (!entrada.success) return { ok: false, erro: "falha" };

  const user = await loadAuthUser();
  if (!user) return { ok: false, erro: "sessao" };
  if (supportWriteError(user.support)) return { ok: false, erro: "somente_leitura" };
  const org = await resolveActiveOrg(user);
  if (!org) return { ok: false, erro: "sem_empresa" };
  if (ROLE_RANK[org.role] < ROLE_RANK.admin) return { ok: false, erro: "sem_permissao" };

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("fn_definir_cliente_pela_agenda", {
    p_org: org.orgId,
    p_ligado: entrada.data,
  });

  if (error) {
    if (error.code === "42501") {
      return { ok: false, erro: error.message.includes("mfa_required") ? "mfa" : "sem_permissao" };
    }
    // A ligação espera, na trava da organização, todo agendamento e toda junção
    // de contatos em voo naquela organização (migration 0262). Três desfechos
    // dessa espera voltam a transação inteira — nada foi gravado — e tentar de
    // novo resolve:
    //   55P03  o prazo de 4s do papel `authenticated` (migration 0243) venceu;
    //   40P01  o Postgres escolheu esta transação para desfazer um ciclo;
    //   40001  conflito de serialização.
    // O 40P01 não é o caminho esperado: a ordem das travas (organização antes do
    // contato, na fusão e no recálculo) existe para que ele não aconteça, e as
    // corridas I32/I33 do invariante medem as duas que aconteciam.
    if (error.code === "55P03" || error.code === "40P01" || error.code === "40001") {
      return { ok: false, erro: "tente_de_novo" };
    }
    logger.error("[cliente-pela-agenda] a RPC falhou", {
      organization_id: org.orgId,
      code: error.code,
      error: error.message,
    });
    return { ok: false, erro: "falha" };
  }

  const resultado = resultadoSchema.safeParse(data);
  if (!resultado.success) {
    logger.error("[cliente-pela-agenda] a RPC devolveu um corpo inesperado", {
      organization_id: org.orgId,
    });
    return { ok: false, erro: "falha" };
  }

  if (resultado.data.mudou) {
    await audit({
      action: "crm.cliente_pela_agenda_alterado",
      actorUserId: user.id,
      organizationId: org.orgId,
      resourceType: "organization",
      resourceId: org.orgId,
      metadata: resultado.data,
    });
  }

  // O selo de Contatos, a data da ficha e o funil de clientes leem a regra pelo
  // `ActiveOrg` que o layout monta: sem invalidar o layout, a mudança só
  // apareceria no próximo recarregamento completo.
  revalidatePath("/app", "layout");
  return { ok: true, ...resultado.data };
}
