/**
 * GET /chat/<chave> — a janela do chat no site (spec 36, F2).
 *
 * Pública: quem abre é o visitante, dentro de um iframe no site do cliente, sem sessão. A
 * chave pública (`wck_`) está na URL e não é segredo. Ela só identifica a conexão; a
 * organização sai da LINHA da conexão, nunca do pedido.
 *
 * Responde HTML. Quem decide quem pode embutir é a própria resposta: o `frame-ancestors` da
 * CSP leva as origens da conexão. Por isso a rota NÃO põe `X-Frame-Options`, e a configuração
 * de cabeçalhos (`next.config.ts`) deixa `/chat/` de fora do `DENY` do painel.
 *
 * Chave inexistente, conexão arquivada, organização suspensa e módulo desligado saem com o
 * MESMO 404 e o mesmo corpo, como em `sessao`. A rota não diz por que não abriu.
 */
import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { marcaDaSaida } from "@/lib/branding/saida";
import { conexaoPelaChave } from "@/lib/channels/webchat/conexao-pela-chave";
import { descreverErro } from "@/lib/channels/webchat/entrada-publica";
import { montarJanela, PAGINA_INDISPONIVEL } from "@/lib/channels/webchat/janela-html";
import { lerControladorDoChat } from "@/lib/legal/controlador-do-chat";
import { ipDoCliente } from "@/lib/http/ip-do-cliente";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

/** A janela não é gerada em cache: a configuração e a marca mudam sem aviso. */
export const dynamic = "force-dynamic";

const CHAVE = /^wck_[A-Za-z0-9_-]{1,64}$/;

/** Por IP: 30 aberturas de janela por minuto. Mesmo teto de `sessao`. */
const LIMITE_POR_IP = 30;
const JANELA_SEGUNDOS = 60;

/** Todo "não abriu" sai como esta página, com o mesmo corpo: só o status e o `Retry-After` mudam. */
function indisponivel(status: number, cabecalhos: Record<string, string> = {}) {
  return new Response(PAGINA_INDISPONIVEL, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
      ...cabecalhos,
    },
  });
}

function naoEncontrado() {
  return indisponivel(404);
}

export async function GET(req: Request, { params }: { params: Promise<{ chave: string }> }) {
  try {
    const ip = ipDoCliente(req.headers) ?? "sem-ip";
    const teto = await checkRateLimit(`webchat:janela:ip:${ip}`, LIMITE_POR_IP, JANELA_SEGUNDOS);
    if (!teto.allowed) {
      return indisponivel(429, { "Retry-After": String(JANELA_SEGUNDOS) });
    }

    const { chave } = await params;
    if (!CHAVE.test(chave)) return naoEncontrado();

    const admin = createAdminClient();
    const conexao = await conexaoPelaChave(admin, chave);
    // Os quatro casos (chave, arquivada, suspensa, módulo) saem como o mesmo 404.
    if (!conexao) return naoEncontrado();

    const [marca, controlador] = await Promise.all([
      marcaDaSaida(conexao.organizationId),
      lerControladorDoChat(admin, conexao.organizationId),
    ]);

    const { html, csp } = montarJanela({
      chave,
      marca,
      config: conexao.config,
      controlador,
      origens: conexao.allowedOrigins,
    });

    return new Response(html, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy": csp,
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (erro) {
    // Sem a chave no log: ela identifica a conexão do cliente.
    logger.error("webchat: erro na janela do chat", { rota: "janela", ...descreverErro(erro) });
    return indisponivel(500);
  }
}
