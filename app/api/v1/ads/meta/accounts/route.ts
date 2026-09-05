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
 * Org da org ativa (cookie validado), NUNCA do query/body. Read-only ⇒ sem
 * audit, mesma regra de `metrics/attendants`.
 */
import { randomUUID } from "node:crypto";

import { requireRole } from "@/lib/auth/require-role";
import { listarContas } from "@/lib/plataformas-de-anuncio/meta/insights";
import { lerCredencialDeLeitura } from "@/lib/plataformas-de-anuncio/credenciais-de-leitura";
import { ok } from "@/lib/api/wrappers";
import { createAdminClient } from "@/lib/supabase/admin";

import { respostaDeFalha, respostaSemConexao } from "../_falha";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const requestId = randomUUID();

  const authz = await requireRole("manager", { requestId, resource: "ads_insights" });
  if (!authz.ok) return authz.response;
  const { org } = authz;

  // Admin client: `ad_insights_connections` tem RLS ligada e ZERO policies
  // (0214). Pelo client de sessão isto devolveria vazio, sem erro.
  const admin = createAdminClient();
  const credencial = await lerCredencialDeLeitura(admin, org.orgId, "meta_ads");
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
