/**
 * A base pública desta instalação — o endereço que o operador cola no painel da Meta.
 *
 * `env.*` e NÃO `process.env.NEXT_PUBLIC_APP_URL` direto: variáveis `NEXT_PUBLIC_`
 * são substituídas no BUILD, e a imagem genérica do self-host é construída com
 * `https://placeholder.invalid` (Dockerfile). Lendo direto do `process.env`, a tela
 * mostrava essa URL — e quem a colasse no dashboard apontaria o webhook para o nada,
 * sem erro em lugar nenhum.
 *
 * Existe como módulo porque três rotas passaram a precisar do mesmo endereço (a de
 * canal oficial, a de canal do parceiro e a de reaplicar o webhook): a cópia era o
 * defeito em potencial — duas telas dizendo URLs diferentes para o MESMO webhook.
 */
import { env } from "@/lib/env";

/** Aceita `NextRequest` e qualquer objeto com estas duas peças (testes). */
export function basePublicaDaInstalacao(req: { headers: Headers; nextUrl: URL }): string {
  const configurada = env.NEXT_PUBLIC_APP_URL;
  const usavel = configurada && !configurada.includes("placeholder.invalid") ? configurada : null;
  const base = usavel ?? req.headers.get("origin") ?? `${req.nextUrl.protocol}//${req.nextUrl.host}`;
  // A barra final virou responsabilidade DESTE módulo ao unificar as três cópias: o
  // caminho é colado com `/`, e um `NEXT_PUBLIC_APP_URL` terminado em barra produzia
  // `https://crm.exemplo.com//api/v1/...` — que a Meta aceita no painel e recusa no
  // override do número (`(#100) Invalid callback URL`).
  return base.replace(/\/+$/, "");
}

/**
 * A base do callback da META — e só dela (#1426). `META_WEBHOOK_BASE_URL`, quando
 * definida, deixa o painel numa rede privada e expõe à Meta só `/api/v1/webhooks/meta/*`.
 *
 * NÃO mora dentro de `basePublicaDaInstalacao`: aquela também monta a URL de webhook
 * dos canais parceiros (`channels/partner` e `channels/graph-partner`, em
 * `/api/v1/webhooks/channel/<token>`), e a variável trocaria a URL deles para um
 * endereço que o proxy da receita da issue bloqueia.
 */
export function basePublicaDoWebhookMeta(req: { headers: Headers; nextUrl: URL }): string {
  const configurada = env.META_WEBHOOK_BASE_URL.trim();
  if (configurada && !configurada.includes("placeholder.invalid")) {
    return configurada.replace(/\/+$/, "");
  }
  return basePublicaDaInstalacao(req);
}

const MAQUINA_LOCAL = new Set(["localhost", "127.0.0.1", "[::1]", "::1", "0.0.0.0"]);

/** O endereço aponta para a própria máquina? URL inválida conta como não. */
export function enderecoDaPropriaMaquina(url: string): boolean {
  try {
    return MAQUINA_LOCAL.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * A base pública CONFIGURADA da instalação — sem cair na requisição.
 *
 * Irmã de `basePublicaDaInstalacao`, para o que a instalação grava num terceiro
 * em nome de TODAS as organizações (o webhook único do provedor parceiro). Ali
 * o `Origin` de quem clicou não serve de fallback: qualquer admin de qualquer
 * organização escolheria para onde vão os eventos de todos os números.
 *
 * `null` quando não há base utilizável: ausente, o `placeholder.invalid` da
 * imagem genérica, ou a própria máquina — que só vale quando o outro lado
 * também está nela (`aceitarMaquinaLocal`, o dublê das provas de tela).
 */
export function basePublicaConfiguradaDaInstalacao(opcoes: { aceitarMaquinaLocal: boolean }): string | null {
  const configurada = env.NEXT_PUBLIC_APP_URL?.trim();
  if (!configurada || configurada.includes("placeholder.invalid")) return null;
  if (!opcoes.aceitarMaquinaLocal && enderecoDaPropriaMaquina(configurada)) return null;
  return configurada.replace(/\/+$/, "");
}
