import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import {
  buscarTabelaDeValores,
  lerItemPorCodigo,
  listarItensDaTabela,
} from "@/lib/tabela-de-valores/store";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

type Ctx = { params: Promise<{ id: string }> };

const parametros = z.object({
  codigo: z.string().trim().min(1).max(60).optional(),
  busca: z.string().trim().max(120).optional(),
  limite: z.coerce.number().int().min(1).max(2_000).optional(),
});

/**
 * GET /api/v1/tabelas-de-valores/{id}/itens — a leitura por procedimento.
 *
 * `?codigo=` devolve UM procedimento com valor de partida e valor limite (é a
 * pergunta que a negociação vai fazer); sem `codigo`, devolve a lista da tabela,
 * opcionalmente filtrada por `busca` e limitada por `limite`.
 *
 * ─── O limite aqui é dado de servidor ────────────────────────────────────
 *
 * Esta rota entrega o valor LIMITE porque quem chama é a equipe (ou o motor do
 * agente, no servidor). O texto que vai ao CLIENTE é outra camada — a fatia da
 * conversa de negociação — e é lá que o limite deixa de existir para o cliente.
 * Misturar as duas coisas aqui seria esconder do time o número que ele precisa
 * para decidir.
 *
 * Leitura para `viewer`: ver preço não é privilégio de administrador — quem
 * negocia precisa dele. A organização vem da autenticação, e a tabela é
 * conferida contra ela antes de qualquer consulta.
 */
export async function GET(req: NextRequest, ctx: Ctx): Promise<Response> {
  const requestId = req.headers.get("x-request-id") ?? randomUUID();
  // Leitura SÓ DE SESSÃO: o preço da tabela é dado de tela. A porta de token
  // para o agente é a ferramenta da fatia seguinte, com o escopo dela — abrir
  // `dsk_…` aqui exporia a tabela inteira por uma credencial que não foi feita
  // para isso.
  const authz = await requireRole("viewer", { requestId, resource: "tabela_de_valores" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const { id: tabelaId } = await ctx.params;
  const filtro = parametros.safeParse(
    Object.fromEntries(new URL(req.url).searchParams),
  );
  if (!filtro.success)
    return fail("validation_failed", t("Parâmetros inválidos."), 422, {
      requestId,
      headers,
      details: filtro.error.flatten().fieldErrors as Record<string, unknown>,
    });

  const pool = getRequestPool();
  const org = authz.org.orgId;
  const tabela = await buscarTabelaDeValores(pool, org, tabelaId);
  if (!tabela) return fail("not_found", t("Tabela de valores não encontrada."), 404, { requestId, headers });

  if (filtro.data.codigo) {
    const item = await lerItemPorCodigo(pool, org, tabelaId, filtro.data.codigo);
    if (!item)
      return fail("not_found", t("Procedimento não encontrado nesta tabela."), 404, {
        requestId,
        headers,
      });
    return ok({ tabela: tabela.nome, item }, { requestId, headers });
  }

  const itens = await listarItensDaTabela(pool, org, tabelaId, {
    limite: filtro.data.limite,
    busca: filtro.data.busca ?? null,
  });
  return ok({ tabela: tabela.nome, itens, total: itens.length }, { requestId, headers });
}
