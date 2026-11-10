/**
 * A ida e a volta do NAVEGADOR do contato no OAuth por contato — o miolo das
 * duas rotas públicas (`/api/v1/mcp-oauth/iniciar/<state>` e
 * `/api/v1/mcp-oauth/callback/<servidor_id>`), sem `NextRequest`, para o teste
 * exercitar.
 *
 * ── Por que as rotas são públicas e o que as protege ─────────────────────────
 *
 * Quem chega é o navegador do CONTATO (cliente final), que nunca teve sessão
 * nossa. A autoridade inteira vem do `state`: 256 bits gerados no servidor,
 * gravados em `mcp_oauth_pedidos` amarrados a organização, servidor, contato e
 * conversa, de USO ÚNICO e com validade de 10 minutos. Nada do que chega na
 * URL escolhe organização, servidor ou contato — tudo é lido da linha do
 * pedido. O `code` só vira token com o `code_verifier` cifrado daquela linha.
 * O servidor da URL do callback só serve para CONFERIR: tem de ser o do pedido.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";

import {
  clienteDoServidor,
  consumirPedido,
  gravarCredencial,
  pedidoValido,
  urlDeAutorizacaoDoPedido,
} from "./credencial";
import { urlDoCallbackMcp } from "./enderecos";
import { ErroDeOauth, trocarCodigo, type OpcoesDeRede } from "./oauth";
import { lerServidor } from "./registro";

export type DesfechoDoInicio = { ok: true; destino: string } | { ok: false; motivo: "pedido_invalido" | "servidor_indisponivel" };

/** O link curto: confere validade e uso (sem consumir) e devolve o destino do 302. */
export async function iniciarAutorizacao(supabase: SupabaseClient, state: string): Promise<DesfechoDoInicio> {
  const pedido = await pedidoValido(supabase, state);
  if (!pedido) return { ok: false, motivo: "pedido_invalido" };
  const servidor = await lerServidor(supabase, pedido.organizationId, pedido.servidorId);
  if (!servidor || !servidor.ativo || servidor.modo !== "oauth_por_contato") {
    return { ok: false, motivo: "servidor_indisponivel" };
  }
  const destino = urlDeAutorizacaoDoPedido(servidor, pedido);
  return destino ? { ok: true, destino } : { ok: false, motivo: "servidor_indisponivel" };
}

export type DesfechoDoRetorno =
  | "autorizado"
  | "pedido_invalido"
  | "recusado_pelo_contato"
  | "servidor_indisponivel"
  | "troca_falhou";

/** Os status de conversa encerrada — o mesmo conjunto do gatilho da 9095. */
const STATUS_ENCERRADOS = new Set(["closed", "resolved", "archived"]);

/** Identificador de emissor comparável (RFC 9207 §2.4): sem a barra final. */
function emissorNormalizado(u: string): string {
  return u.replace(/\/+$/, "");
}

/**
 * A conversa do pedido já encerrou? Então a credencial nasce com a revogação
 * que o gatilho do encerramento teria agendado (agora + retenção) — o gatilho
 * só alcança credencial que já existia na hora em que a conversa fechou.
 */
async function revogacaoDaConversaEncerrada(
  supabase: SupabaseClient,
  organizationId: string,
  conversationId: string | null,
  retencaoHoras: number,
): Promise<Date | null> {
  if (!conversationId) return null;
  const { data } = await supabase
    .from("conversations")
    .select("status")
    .eq("organization_id", organizationId)
    .eq("id", conversationId)
    .maybeSingle();
  const status = (data as { status?: unknown } | null)?.status;
  if (typeof status !== "string" || !STATUS_ENCERRADOS.has(status)) return null;
  return new Date(Date.now() + retencaoHoras * 60 * 60 * 1000);
}

/**
 * A volta. Ordem que importa:
 * 1. consome o `state` (UPDATE condicional) ANTES de qualquer outra coisa —
 *    reuso, expirado ou inexistente param aqui, sem gravar nada;
 * 2. o servidor do endereço de retorno tem de ser o do pedido, e o `iss`
 *    (RFC 9207), quando vem, o emissor dele — senão o `code` é de outro
 *    authorization server e não vai ao `token_endpoint` deste;
 * 3. `error=` do authorization server (o contato negou) só é aceito depois de
 *    consumir, para o mesmo `state` não ser reaproveitado com um `code` depois;
 * 4. troca `code` + `code_verifier` (+ `resource`) no `token_endpoint`;
 * 5. grava a credencial cifrada — substituindo e revogando a anterior.
 */
export async function processarRetorno(
  supabase: SupabaseClient,
  parametros: {
    servidor: string | null;
    state: string | null;
    code: string | null;
    error: string | null;
    iss?: string | null;
  },
  opcoes?: OpcoesDeRede,
): Promise<DesfechoDoRetorno> {
  if (!parametros.state) return "pedido_invalido";
  const pedido = await consumirPedido(supabase, parametros.state);
  if (!pedido) return "pedido_invalido";
  if (pedido.servidorId !== parametros.servidor) return "pedido_invalido";

  const servidor = await lerServidor(supabase, pedido.organizationId, pedido.servidorId);
  const cliente = servidor ? clienteDoServidor(servidor) : null;
  if (!servidor || !cliente || servidor.modo !== "oauth_por_contato" || !servidor.ativo) {
    return "servidor_indisponivel";
  }
  if (parametros.iss && servidor.oauth && emissorNormalizado(parametros.iss) !== emissorNormalizado(servidor.oauth.emissor)) {
    return "pedido_invalido";
  }

  if (parametros.error || !parametros.code) {
    void audit({
      action: "contact.mcp_acesso_recusado",
      organizationId: pedido.organizationId,
      resourceType: "contact",
      resourceId: pedido.contactId,
      // `error` é vocabulário do RFC 6749, mas vem de fora: só o formato curto.
      metadata: { servidor_id: servidor.id, motivo: /^[a-z_]{1,40}$/.test(parametros.error ?? "") ? parametros.error : "sem_code" },
    });
    return "recusado_pelo_contato";
  }

  try {
    const tokens = await trocarCodigo(
      cliente,
      {
        code: parametros.code,
        codeVerifier: pedido.codeVerifier,
        redirectUri: urlDoCallbackMcp(pedido.servidorId),
        escopos: pedido.escopos,
      },
      opcoes,
    );
    const revogarApos = await revogacaoDaConversaEncerrada(
      supabase,
      pedido.organizationId,
      pedido.conversationId,
      servidor.retencaoHoras,
    );
    const gravou = await gravarCredencial(supabase, servidor, pedido.contactId, tokens, { ...opcoes, revogarApos });
    if (!gravou) return "troca_falhou";
    void audit({
      action: "contact.mcp_acesso_autorizado",
      organizationId: pedido.organizationId,
      resourceType: "contact",
      resourceId: pedido.contactId,
      metadata: {
        servidor_id: servidor.id,
        agent_id: servidor.agentId,
        conversation_id: pedido.conversationId,
        escopos: tokens.escopos,
      },
    });
    return "autorizado";
  } catch (err) {
    logger.warn("troca do code do OAuth MCP falhou", {
      organization_id: pedido.organizationId,
      servidor_id: servidor.id,
      motivo: err instanceof ErroDeOauth ? err.codigo : "desconhecido",
    });
    return "troca_falhou";
  }
}

const TEXTOS: Record<DesfechoDoRetorno | "pedido_invalido_inicio", { titulo: string; corpo: string }> = {
  autorizado: { titulo: "Acesso autorizado", corpo: "Pronto! Você já pode voltar à conversa." },
  pedido_invalido: {
    titulo: "Link expirado ou já usado",
    corpo: "Este link de autorização não vale mais. Volte à conversa e peça um novo.",
  },
  pedido_invalido_inicio: {
    titulo: "Link expirado ou já usado",
    corpo: "Este link de autorização não vale mais. Volte à conversa e peça um novo.",
  },
  recusado_pelo_contato: {
    titulo: "Acesso não autorizado",
    corpo: "Nenhum acesso foi concedido. Se quiser, volte à conversa e peça um novo link.",
  },
  servidor_indisponivel: {
    titulo: "Serviço indisponível",
    corpo: "Não foi possível concluir agora. Volte à conversa e tente de novo mais tarde.",
  },
  troca_falhou: {
    titulo: "Não foi possível concluir",
    corpo: "A autorização não pôde ser concluída. Volte à conversa e peça um novo link.",
  },
};

/** Página mínima, sem dado sensível, sem script e sem recurso externo. */
export function paginaDoDesfecho(desfecho: keyof typeof TEXTOS): string {
  const { titulo, corpo } = TEXTOS[desfecho];
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${titulo}</title><style>body{font-family:system-ui,sans-serif;background:#f6f6f4;color:#1c1c1a;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:16px}main{max-width:420px;background:#fff;border:1px solid #e3e3df;border-radius:12px;padding:28px}h1{font-size:1.25rem;margin:0 0 8px}p{margin:0;line-height:1.5;color:#4a4a46}@media (prefers-color-scheme:dark){body{background:#151514;color:#ededea}main{background:#1f1f1d;border-color:#33332f}p{color:#b8b8b2}}</style></head><body><main><h1>${titulo}</h1><p>${corpo}</p></main></body></html>`;
}
