/**
 * GET /api/mcp/oauth/authorize — a porta de entrada do consentimento.
 *
 * Quem chega aqui é o NAVEGADOR da pessoa, mandado pelo ChatGPT (outro site).
 * O cookie de sessão é `sameSite: "strict"` e não viaja nessa navegação, então
 * esta rota não decide nada sobre a sessão: confere o pedido e responde com a
 * PONTE (`lib/auth/ponte-de-volta.ts`), um documento nosso que segue para a
 * tela de consentimento — navegação iniciada por nós, onde o cookie viaja. Sem
 * sessão, o `proxy` leva ao login e volta com `next`.
 *
 * Ordem das recusas (RFC 6749 §4.1.2.1): `client_id` ou `redirect_uri` que não
 * conferem com o REGISTRO viram página de erro aqui mesmo — devolver ao
 * `redirect_uri` não conferido faria desta rota um redirecionador aberto. Os
 * demais defeitos voltam ao cliente como `?error=` SÓ se ele já concluiu uma
 * troca de código aqui (`ultimo_uso_em`): o registro é aberto, e o endereço de
 * um cliente que nenhum admin autorizou ainda não merece um redirecionamento
 * nosso. Até lá, todo erro é página do CRM.
 */
import { randomUUID } from "node:crypto";

import { comIdDaRequisicao } from "@/lib/api/wrappers";
import { respostaDePonte } from "@/lib/auth/ponte-de-volta";
import { marcaDaSaida } from "@/lib/branding/saida";
import { buscarCliente } from "@/lib/mcp/oauth/clientes";
import { enderecosOAuth, recursoConfere } from "@/lib/mcp/oauth/config";
import { identidadeDoPedidoSchema, pedidoDeAutorizacaoSchema } from "@/lib/mcp/oauth/esquemas";
import { oauthMcpLimitado } from "@/lib/mcp/oauth/limites";
import { paginaDeErroOAuth } from "@/lib/mcp/oauth/pagina-de-erro";
import { urlDeVoltaComErro } from "@/lib/mcp/oauth/respostas";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  const requestId = randomUUID();
  if (await oauthMcpLimitado("autorizacao")) {
    return paginaDeErroOAuth("Muitas tentativas. Espere alguns minutos e tente conectar de novo.", 429, requestId);
  }

  const params = Object.fromEntries(new URL(req.url).searchParams);
  const identidade = identidadeDoPedidoSchema.safeParse(params);
  if (!identidade.success) {
    return paginaDeErroOAuth("O pedido de conexão veio incompleto. Volte ao aplicativo e tente conectar de novo.", 400, requestId);
  }
  const cliente = await buscarCliente(createAdminClient(), identidade.data.client_id);
  if (!cliente || !cliente.redirect_uris.includes(identidade.data.redirect_uri)) {
    return paginaDeErroOAuth(
      "Este aplicativo não está registrado aqui, ou pediu para voltar a um endereço que não registrou. Remova a conexão no aplicativo e adicione de novo.",
      400,
      requestId,
    );
  }

  const e = enderecosOAuth();
  const voltaComErro = (erro: string) =>
    cliente.ultimo_uso_em
      ? comIdDaRequisicao(
          Response.redirect(urlDeVoltaComErro(identidade.data.redirect_uri, erro, identidade.data.state, e.issuer), 302),
          requestId,
        )
      : paginaDeErroOAuth(
          `O aplicativo enviou um pedido de conexão inválido (${erro}). Volte ao aplicativo e tente conectar de novo.`,
          400,
          requestId,
        );

  const pedido = pedidoDeAutorizacaoSchema.safeParse(params);
  if (!pedido.success) {
    const naoSuportado = pedido.error.issues.some((i) => i.path[0] === "response_type");
    return voltaComErro(naoSuportado ? "unsupported_response_type" : "invalid_request");
  }
  if (!recursoConfere(pedido.data.resource, e.recurso)) return voltaComErro("invalid_target");

  // Só os campos conferidos seguem — nada cru da query chega à tela.
  const adiante = new URLSearchParams();
  for (const [k, v] of Object.entries(pedido.data)) if (v !== undefined) adiante.set(k, v);
  const marca = await marcaDaSaida(null);
  return comIdDaRequisicao(
    respostaDePonte(`/oauth/mcp/consentir?${adiante.toString()}`, marca.nome, "Abrindo a autorização…"),
    requestId,
  );
}
