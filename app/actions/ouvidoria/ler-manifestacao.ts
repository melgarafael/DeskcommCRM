"use server";

/**
 * LER UMA MANIFESTAÇÃO DA OUVIDORIA (#3611, fatia 1).
 *
 * A porta da leitura para quem tem sessão. O que a leitura É está em
 * `lib/ouvidoria/leitura.ts`; o papel que ela exige está AQUI, e é o único
 * lugar que decide recusa por papel — a mesma divisão de
 * `definirEntradaAutomaticaNoFunil` e das demais ações de configuração.
 *
 * ─── Por que o id vem de argumento, e a organização não ─────────────────────
 *
 * O id da manifestação é o dado que quem chama tem (veio do link, do protocolo).
 * A ORGANIZAÇÃO vem de `resolveActiveOrg`, nunca do argumento: aceitá-la de fora
 * deixaria um administrador da empresa A pedir a manifestação da empresa B
 * mandando o id da outra organização — a RLS barraria, mas a camada de cima
 * estaria convidando o erro.
 *
 * ─── Por que `admin` e não `manager` ────────────────────────────────────────
 *
 * A issue pede perfis configuráveis, "incluindo a opção de somente
 * administradores". Enquanto a configuração não existe (fatia seguinte), a régua
 * é a mais restritiva das opções — abrir para `manager` seria escolher pelo dono
 * do produto a opção MAIS permissiva, e manifestação é o dado mais sensível que
 * este CRM guarda.
 *
 * ─── Por que a leitura não checa o módulo ligado ────────────────────────────
 *
 * Desligar o módulo fecha a ENTRADA; não apaga o acervo nem o protocolo que já
 * foi entregue a alguém. A razão inteira está no cabeçalho de `leitura.ts`.
 *
 * ─── As respostas ───────────────────────────────────────────────────────────
 *
 * `not_found` cobre "não existe", "é de outra organização" e "id malformado" —
 * uma resposta só, porque distinguir contaria ao vizinho que a linha existe.
 * A ação NUNCA devolve a manifestação de outro tenant com `ok: true`: há dois
 * predicados (o `.eq("organization_id", …)` da leitura e a RLS da 9030) e o
 * teste de unidade mede o primeiro.
 *
 * ─── A régua de acesso saiu daqui (fatia 3) ─────────────────────────────────
 *
 * A fatia 3 precisa da MESMA régua em cinco portas (lista, detalhe, mudança de
 * status e as duas telas). Ela mora em `lib/ouvidoria/acesso.ts`, com a ordem
 * das recusas documentada lá — e esta ação passou a chamá-la em vez de repetir
 * as quatro linhas. A conduta é idêntica: a barreira de acompanhamento continua
 * vindo ANTES de `resolveActiveOrg`, e o piso continua `admin`.
 */
import { acessoDaOuvidoria } from "@/lib/ouvidoria/acesso";
import { lerManifestacao, type ManifestacaoLida } from "@/lib/ouvidoria/leitura";
import { createClient } from "@/lib/supabase/server";

export type ResultadoDaLeituraDaOuvidoria =
  | { ok: true; manifestacao: ManifestacaoLida }
  | {
      ok: false;
      error: "unauthenticated" | "forbidden_tenant" | "forbidden_role" | "not_found" | "erro_ao_ler";
    };

export async function lerManifestacaoDaOuvidoria(
  id: string,
): Promise<ResultadoDaLeituraDaOuvidoria> {
  const acesso = await acessoDaOuvidoria();
  if (!acesso.ok) return acesso;

  // Cliente de SESSÃO de propósito: a RLS da 9030 (organização + admin) é a
  // segunda cerca, e ela só existe neste caminho.
  const supabase = await createClient();
  const resultado = await lerManifestacao({ supabase, organizationId: acesso.org.orgId }, id);

  if (resultado.ok) return resultado;
  return {
    ok: false,
    error: resultado.erro === "erro_ao_ler" ? "erro_ao_ler" : "not_found",
  };
}
