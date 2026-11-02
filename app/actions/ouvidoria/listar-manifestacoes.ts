"use server";

/**
 * LISTAR AS MANIFESTAÇÕES DA OUVIDORIA (#3611, fatia 3).
 *
 * A porta da TELA de gestão. O que a lista É está em `lib/ouvidoria/tela.ts`;
 * quem pode vê-la está em `lib/ouvidoria/acesso.ts` e NÃO é decidido aqui —
 * esta action chama a mesma barreira da leitura da fatia 1, para a tela e a
 * leitura por id não poderem discordar sobre quem entra.
 *
 * ─── Por que a tela passa por uma action, e não lê o banco sozinha ─────────
 *
 * Porque a régua precisa de um lugar só. Se a página chamasse `createClient` e
 * montasse o `select`, o papel que ela exige seria uma segunda decisão sobre o
 * mesmo dado — e o teste que fixa "papel sem permissão não vê a lista" mediria a
 * página, não a regra. A página (Server Component) chama esta função direto e
 * traduz o resultado em tela; o cliente HTTP poderia chamá-la também, e a
 * resposta seria a mesma.
 *
 * ─── O pedido é da URL, e por isso é tratado como hostil ──────────────────
 *
 * `status` e `pagina` são strings de qualquer pessoa. O status fora dos três do
 * CHECK cai em "todos", a página inválida vira 1 e o TAMANHO da página não é
 * parâmetro (ver `lib/ouvidoria/tela.ts`). Nada disso chega ao banco sem passar
 * por essa normalização.
 */
import { acessoDaOuvidoria } from "@/lib/ouvidoria/acesso";
import { listarManifestacoes, type PaginaDaLista } from "@/lib/ouvidoria/tela";
import { createClient } from "@/lib/supabase/server";

export type ResultadoDaListaDaOuvidoria =
  | { ok: true; pagina: PaginaDaLista }
  | {
      ok: false;
      error:
        | "unauthenticated"
        | "forbidden_tenant"
        | "forbidden_role"
        | "erro_ao_ler";
    };

export async function listarManifestacoesDaOuvidoria(
  pedido: { status?: string | null; pagina?: string | null } = {},
): Promise<ResultadoDaListaDaOuvidoria> {
  const acesso = await acessoDaOuvidoria();
  if (!acesso.ok) return acesso;

  // Cliente de SESSÃO de propósito: a RLS da 9030 é a segunda cerca, e ela só
  // existe neste caminho.
  const supabase = await createClient();
  const resultado = await listarManifestacoes(
    { supabase, organizationId: acesso.org.orgId },
    { status: pedido.status ?? null, pagina: pedido.pagina ?? null },
  );

  if (resultado.ok) return resultado;
  return { ok: false, error: "erro_ao_ler" };
}
