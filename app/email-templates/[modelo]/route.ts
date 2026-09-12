import { NextResponse, type NextRequest } from "next/server";

import { marcaDaSaida } from "@/lib/branding/saida";
import {
  MODELOS_DE_ACESSO,
  montarTemplateDeAcesso,
  type ModeloDeAcesso,
} from "@/lib/email/templates/acesso-gotrue";

/**
 * GET /email-templates/{confirmation,recovery} — o molde que o GoTrue busca.
 *
 * ─── POR QUE UMA ROTA, E NÃO UM ARQUIVO ────────────────────────────────────
 *
 * O GoTrue **só carrega template por HTTP**. Fonte, `supabase/auth` v2.196.0,
 * `internal/mailer/templatemailer/template.go`:
 *
 *     url := getEmailContentConfig(&cfg.Mailer.Templates, typ, "")
 *     if !strings.HasPrefix(url, "http") {
 *         url = cfg.SiteURL + url                       // ← linha 456
 *     }
 *     req, _ := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
 *
 * O que não começa com `http` ele COLA no fim do `SiteURL` e busca. Um caminho
 * de arquivo não falha: ele faz o GoTrue pedir `https://SEU_DOMINIO/opt/...`,
 * receber o HTML da tela de login e mandar ISSO para a caixa de entrada.
 * Aconteceu numa instalação real em 2026-09-09, e o Gmail marcou como phishing.
 * A doc oficial concorda: `GOTRUE_MAILER_TEMPLATES_*` são *"template URLs"*, e
 * os knobs irmãos são descritos como *"Email-template HTTP loading"*.
 *
 * ─── POR QUE O APP SERVE, E NÃO UM ARQUIVO ESTÁTICO ────────────────────────
 *
 * Porque a marca vive no BANCO (`platform_branding`), não no `.env`. O
 * `marca-emails.sh` renderiza lendo o `.env`, então trocar nome ou cor em
 * **Configurações › Marca** não reescreve os e-mails de acesso — buraco que o
 * próprio produto documenta em `docs/white-label.en.md`. Servindo daqui, a
 * marca é resolvida a cada busca, e o GoTrue re-busca sozinho a cada
 * `GOTRUE_MAILER_TEMPLATE_MAX_AGE` (10 min por padrão): a troca chega sem
 * reiniciar nada e sem rodar script.
 *
 * ─── SEM RATE LIMIT, DE PROPÓSITO ──────────────────────────────────────────
 *
 * A rota é pública, e a regra da casa é que rota pública tem teto. Aqui o teto
 * seria contraproducente: quem consome é o GoTrue, no instante em que precisa
 * montar o e-mail, e um 429 o faz cair no modelo PADRÃO — isto é, recriaria
 * exatamente o defeito que esta rota existe para consertar, e só para quem
 * estivesse criando conta naquele minuto. O que ela devolve não tem segredo
 * (nome, cor e logo já aparecem na tela de login, sem sessão), não tem efeito
 * colateral e custa uma linha lida. O `Cache-Control` abaixo é a proteção
 * proporcional.
 */

export const dynamic = "force-dynamic";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ modelo: string }> },
): Promise<NextResponse> {
  const { modelo } = await params;

  if (!MODELOS_DE_ACESSO.includes(modelo as ModeloDeAcesso)) {
    return new NextResponse("modelo desconhecido", { status: 404 });
  }

  // `null` = camada da INSTALAÇÃO. Confirmar conta e redefinir senha acontecem
  // quando ainda não há organização a que atribuir a pessoa — e mesmo quando há,
  // o GoTrue não sabe qual é. `marcaDaSaida` nunca lança: degrada para o padrão
  // do produto, que é uma instalação funcionando.
  const marca = await marcaDaSaida(null);

  return new NextResponse(montarTemplateDeAcesso(modelo as ModeloDeAcesso, marca), {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      // Curto de propósito: o GoTrue já tem cache próprio de 10 min, e este
      // teto evita que uma troca de marca demore mais que isso para aparecer.
      "cache-control": "public, max-age=300",
      // O molde não é página do produto e não deve ser indexado nem seguido.
      "x-robots-tag": "noindex, nofollow",
    },
  });
}
