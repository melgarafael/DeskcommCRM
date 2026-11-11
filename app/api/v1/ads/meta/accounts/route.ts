/**
 * GET /api/v1/ads/meta/accounts — as contas de anúncio que o token alcança.
 *
 * Existe separada de `campaigns` porque responde a uma pergunta de outra
 * frequência: a lista de contas muda quando alguém ganha acesso a um cliente
 * novo (raro), e as métricas mudam o tempo todo. Fundir as duas faria toda
 * atualização da tabela gastar uma terceira chamada de cota para reconfirmar uma
 * lista que não mudou — e a cota é o recurso escasso aqui (a conta sondada está
 * em `development_access`).
 *
 * Piso `manager`: gasto de mídia é dado comercial, do mesmo grau de Evolução da
 * IA e Audit Log, os vizinhos desta tela no grupo Análise. `viewer` — que nesta
 * casa é quem só acompanha o próprio trabalho — não precisa ver orçamento.
 *
 * Org da sessão (org ativa, cookie validado) ou da LINHA do token de servidor
 * (`dsk_…`, escopo `mcp:read`, papel `manager`), NUNCA do query/body. Read-only
 * ⇒ sem audit, mesma regra de `metrics/attendants`.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { listarContas } from "@/lib/plataformas-de-anuncio/meta/insights";
import { lerCredencialDeLeitura } from "@/lib/plataformas-de-anuncio/credenciais-de-leitura";
import { ok } from "@/lib/api/wrappers";
import { createAdminClient } from "@/lib/supabase/admin";

import { respostaDeFalha, respostaSemConexao } from "../_falha";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  // Sessão de navegador OU token de servidor. O teto vale para o token mesmo na
  // leitura: cada chamada daqui gasta cota da plataforma de anúncios.
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "ads_insights",
    role: "manager",
    scope: "mcp:read",
  });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "ads_insights", requestId);
  if (teto) return teto;

  // Admin client nos dois ramos: `ad_insights_connections` tem RLS ligada e ZERO
  // policies (0214). Pelo client de sessão isto devolveria vazio, sem erro. A
  // organização é a de `authz.organizationId` (sessão ou linha do token).
  const admin = createAdminClient();
  const credencial = await lerCredencialDeLeitura(admin, authz.organizationId, "meta_ads");
  if (!credencial.ok) return respostaSemConexao(credencial.motivo, { requestId });

  const contas = await listarContas(credencial.credencial.accessToken);
  if (!contas.ok) return respostaDeFalha(contas.falha, contas.detalhe, { requestId });

  return ok(
    {
      contas: contas.dados,
      conta_padrao: credencial.credencial.contaPadrao,
    },
    { requestId },
  );
}
