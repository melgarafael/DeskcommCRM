import { randomInt } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import { senhaForteSchema } from "@/lib/auth/schemas";
import { escreveComoPlatformAdmin, type AuthUser } from "@/lib/auth/types";
import { logger } from "@/lib/logger";

/**
 * QUEM pode criar a pessoa já com senha, sem convite (#3876, decisão do dono
 * do produto, doc 310 alternativa A).
 *
 * A conta criada aqui é da INSTALAÇÃO inteira, não só da empresa de quem cria:
 * o e-mail passa a estar ocupado em todas as empresas, e quem cria conhece a
 * senha de uma pessoa que nunca provou ser dona do e-mail. Por isso a porta só
 * abre em dois casos:
 *
 *  - quem cria é o DONO DA INSTALAÇÃO — `is_platform_admin` com scope `full`,
 *    fora de sessão de acompanhamento (`escreveComoPlatformAdmin`, a mesma
 *    régua de `podeAdministrarEmpresa`); ele já responde pela instalação
 *    inteira;
 *  - a instalação tem UMA empresa só — aí "a instalação" e "a empresa" são o
 *    mesmo conjunto de pessoas, e o admin da empresa não alcança ninguém de
 *    fora dela.
 *
 * Com mais de uma empresa, o admin de empresa continua só com o convite por
 * e-mail. Contar `organizations` inteira (suspensa e arquivada inclusive) é de
 * propósito: empresa parada continua tendo pessoas com e-mail nesta instalação.
 *
 * Falha de leitura FECHA a porta: sem saber quantas empresas existem, a
 * resposta segura é a do caso de várias.
 */
export async function podeCriarPessoaComSenha(
  user: Pick<AuthUser, "is_platform_admin" | "platform_admin_scope" | "support">,
  admin: SupabaseClient,
): Promise<boolean> {
  if (escreveComoPlatformAdmin(user) && !user.support) return true;

  const { count, error } = await admin
    .from("organizations")
    .select("id", { count: "exact", head: true });
  if (error || count === null) {
    logger.warn("equipe: contagem de empresas falhou — criar com senha fica fechado", {
      code: error?.code,
    });
    return false;
  }
  return count <= 1;
}

/**
 * Alfabeto da senha provisória: sem os caracteres que se confundem lidos em voz
 * alta ou copiados à mão (0/O, 1/l/I), porque a senha é entregue por quem
 * administra, fora do sistema.
 */
const ALFABETO = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";

/**
 * Senha provisória gerada pelo SERVIDOR — quem administra não a escolhe.
 *
 * Três grupos de 4 separados por `-` (≈ 69 bits do `randomInt` do Node, que é
 * CSPRNG). O hífen é o símbolo que a régua de senha (`senhaForteSchema`) exige;
 * o laço só repete no caso raro de o sorteio não trazer número ou letra, e a
 * saída passa sempre pela mesma régua da recuperação de senha.
 */
export function gerarSenhaProvisoria(): string {
  for (;;) {
    const grupos = Array.from({ length: 3 }, () =>
      Array.from({ length: 4 }, () => ALFABETO[randomInt(ALFABETO.length)]).join(""),
    );
    const senha = grupos.join("-");
    if (senhaForteSchema.safeParse(senha).success) return senha;
  }
}
