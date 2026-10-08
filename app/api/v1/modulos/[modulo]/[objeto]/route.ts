import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { tabelaDoObjeto } from "@/lib/modulos/dados/tabela";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  contato: z.string().uuid().optional(),
  limite: z.coerce.number().int().min(1).max(200).default(50),
});

/**
 * GET /api/v1/modulos/{modulo}/{objeto} — as fichas que um módulo de dados guarda.
 *
 * A tabela do módulo é **server-only** (`revoke all from anon, authenticated` no compilador), então
 * esta rota é o ÚNICO caminho de leitura — e o filtro por organização existe só aqui, no código. Não
 * há RLS de navegador para salvar um esquecimento, e é por isso que a organização vem da SESSÃO e
 * nunca do pedido: `requireRole` a resolve, e o que vier na URL é ignorado.
 *
 * O nome da tabela também não vem da URL: `tabelaDoObjeto` o deriva do que está instalado, e o que
 * não casa é 404.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ modulo: string; objeto: string }> },
): Promise<Response> {
  const { modulo, objeto } = await params;

  const autorizado = await requireRole("viewer", { resource: `modulos:${modulo}` });
  if (!autorizado.ok) return autorizado.response;

  const bruto = Object.fromEntries(new URL(request.url).searchParams);
  const query = querySchema.safeParse(bruto);
  if (!query.success) {
    return fail("invalid_request", "Pedido inválido.", 400);
  }

  const alvo = await tabelaDoObjeto(modulo, objeto);
  const admin = createAdminClient();

  /**
   * ⚠️ AS DUAS RECUSAS RESPONDEM O MESMO 404, e isso é de propósito.
   *
   * Antes, "módulo não instalado" dava 404 e "a sua empresa não tem nenhuma ficha" dava 200 com
   * `rotulo` e `campos`. Quem quisesse descobrir quais módulos as OUTRAS empresas do mesmo
   * servidor usam só precisava comparar as duas respostas — a rota era um oráculo do catálogo da
   * instalação. Um cético achou isso quando o conserto anterior (esconder o painel vazio na tela)
   * já estava verde: a tela não mostrava, e o dado descia de todo jeito.
   *
   * Agora as duas são indistinguíveis — mesmo código, mesma mensagem, mesmo status. Quem tem ficha
   * lê; para todo o resto, o módulo não existe. O recorte por organização de verdade está em
   * `paineisDaEntidade`, que nem monta o painel; isto aqui é a segunda camada, para a rota não
   * responder a quem a chamar direto.
   *
   * Custo: uma contagem `head` por pedido. A alternativa — devolver lista vazia — é exatamente o
   * oráculo.
   */
  const semFicha = async (): Promise<boolean> => {
    const { count, error } = await admin
      .from(alvo!.tabela)
      .select("id", { count: "exact", head: true })
      .eq("organization_id", autorizado.org.orgId)
      .limit(1);
    // Falha de leitura NÃO abre a porta: na dúvida, o módulo não existe para esta empresa.
    if (error) return true;
    return (count ?? 0) === 0;
  };

  if (!alvo || (await semFicha())) {
    return fail("not_found", "Este módulo não guarda esta informação nesta instalação.", 404);
  }

  let consulta = admin
    .from(alvo.tabela)
    .select("*")
    .eq("organization_id", autorizado.org.orgId);

  // O recorte por contato só existe se o objeto DECLAROU a referência: pedir por contato num objeto
  // que não a tem devolveria a lista inteira da organização, o que seria uma surpresa silenciosa.
  if (query.data.contato) {
    if (!alvo.refDoContato) {
      return fail("invalid_request", "Esta informação não é ligada a um contato.", 400);
    }
    consulta = consulta.eq(alvo.refDoContato, query.data.contato);
  }

  const { data, error } = await consulta.order("created_at", { ascending: false }).limit(query.data.limite);
  if (error) {
    return fail("upstream_unavailable", "Não foi possível ler agora.", 503);
  }

  return ok({
    rotulo: alvo.rotulo,
    campos: alvo.campos,
    fichas: data ?? [],
  });
}
