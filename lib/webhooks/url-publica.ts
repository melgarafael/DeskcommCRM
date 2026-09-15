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
