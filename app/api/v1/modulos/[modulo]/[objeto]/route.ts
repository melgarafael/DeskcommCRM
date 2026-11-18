import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { tabelaDoObjeto } from "@/lib/modulos/dados/tabela";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  contato: z.string().uuid().optional(),
  limite: z.coerce.number().int().min(1).max(200).default(50),
});

const paramsSchema = z.object({
  modulo: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/),
  objeto: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/),
});

/**
 * GET /api/v1/modulos/{modulo}/{objeto} — as fichas que um módulo de dados guarda.
 *
 * A tabela do módulo é **server-only** (`revoke all from anon, authenticated` no compilador), então
 * esta rota é o ÚNICO caminho de leitura — e o filtro por organização existe só aqui, no código. Não
 * há RLS de navegador para salvar um esquecimento, e é por isso que a organização vem da SESSÃO e
 * nunca do pedido: `resolveAuthDual` a resolve, e o que vier na URL é ignorado.
 *
 * O nome da tabela também não vem da URL: `tabelaDoObjeto` o deriva do que está instalado, e o que
 * não casa é 404.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ modulo: string; objeto: string }> },
): Promise<Response> {
  const { modulo, objeto } = await params;

  const requestId = randomUUID();
  const authz = await resolveAuthDual(request, {
    requestId,
    resource: `modulos:${modulo}`,
    role: "viewer",
    scope: "mcp:read",
  });
  if (!authz.ok) return authz.response;

  // Validação DEPOIS da autenticação: quem não está logado recebe a recusa dele, não 400.
  const parametros = paramsSchema.safeParse({ modulo, objeto });
  if (!parametros.success) {
    return fail("invalid_request", "Parâmetros inválidos.", 400, { requestId });
  }

  const teto = await tetoDeEscritaDoToken(authz, "modulos", requestId);
  if (teto) return teto;

  const bruto = Object.fromEntries(new URL(request.url).searchParams);
  const query = querySchema.safeParse(bruto);
  if (!query.success) {
    return fail("invalid_request", "Pedido inválido.", 400);
  }

  const alvo = await tabelaDoObjeto(parametros.data.modulo, parametros.data.objeto);
  const admin = createAdminClient();

  /**
   * AS DUAS RECUSAS RESPONDEM O MESMO 404: "este módulo não está instalado" e "a sua empresa não
   * tem nenhuma ficha deste módulo". As duas situações são indistinguíveis — mesmo código, mesma
   * mensagem, mesmo status.
   *
   * O motivo é de CONTRATO, e não de sigilo: a existência de um módulo instalado é informação da
   * INSTALAÇÃO por desenho (ADR-0002 D3), e `GET /api/v1/extensions` já a lista para qualquer
   * `viewer`, sem recorte por organização. Uma versão anterior deste comentário dizia que a
   * assimetria era um "oráculo do catálogo" — é falso, e um cético derrubou medindo aquela rota.
   *
   * O que a simetria compra é uma resposta só para "não há nada seu aqui", em vez de um 200 com
   * `rotulo` e `campos` e lista vazia. Quem consome tem um caso a menos, e a tela tem um estado a
   * menos: o recorte de verdade está em `paineisDaEntidade`, que nem monta o painel.
   *
   * Custo: uma contagem `head` por pedido.
   */
  const semFicha = async (): Promise<boolean> => {
    const { count, error } = await admin
      .from(alvo!.tabela)
      .select("id", { count: "exact", head: true })
      .eq("organization_id", authz.organizationId)
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
    .eq("organization_id", authz.organizationId);

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
