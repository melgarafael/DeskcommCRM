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
 */
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { supportWriteError } from "@/lib/impersonate/support";
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
  const user = await loadAuthUser();
  if (!user) return { ok: false, error: "unauthenticated" };

  // A sessão de acompanhamento não é a organização. Mesmo com `admin` no papel,
  // quem está do lado de fora vendo a tela do cliente não lê o relato de quem
  // reclamou: é a mesma barreira das actions de leitura desta natureza (ver
  // `app/actions/settings/listarFerramentasMcpExternas.ts`), e aqui ela pesa
  // mais porque a manifestação é sigilosa por definição (§ privacidade da #3611).
  if (supportWriteError(user.support)) return { ok: false, error: "forbidden_role" };

  const org = await resolveActiveOrg(user);
  if (!org) return { ok: false, error: "forbidden_tenant" };
  if (ROLE_RANK[org.role] < ROLE_RANK.admin) return { ok: false, error: "forbidden_role" };

  // Cliente de SESSÃO de propósito: a RLS da 9030 (organização + admin) é a
  // segunda cerca, e ela só existe neste caminho.
  const supabase = await createClient();
  const resultado = await lerManifestacao({ supabase, organizationId: org.orgId }, id);

  if (resultado.ok) return resultado;
  return {
    ok: false,
    error: resultado.erro === "erro_ao_ler" ? "erro_ao_ler" : "not_found",
  };
}
