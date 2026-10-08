/**
 * O endereço que o provedor chama (spec §7a). O provedor só entrega aviso em
 * https público; `urlPublicaUsavel` aceita http e por isso o protocolo é
 * conferido aqui. Exceção única: com o dublê de teste ligado (loopback, e o app
 * em loopback — `baseDeTesteDaCobranca`), o endereço de bancada vale.
 */
import type { ProvedorDeCobranca } from "@/lib/cobranca/vocabulario";
import { env } from "@/lib/env";
import { urlPublicaUsavel } from "@/lib/escalacao/url-publica";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function urlDoWebhookDaCobranca(base: string, provedor: ProvedorDeCobranca, aceitaLoopback: boolean): string | null {
  const limpa = base.trim().replace(/\/+$/, "");
  if (!URL.canParse(limpa)) return null;
  const url = new URL(limpa);
  const publica = url.protocol === "https:" && urlPublicaUsavel(limpa);
  const deBancada = aceitaLoopback && LOOPBACK.has(url.hostname);
  return publica || deBancada ? `${limpa}/api/v1/webhooks/cobranca/${provedor}` : null;
}

/**
 * Para onde o provedor devolve o cliente (checkout, portal): Plano e cobrança da
 * empresa, PELA PONTE (`app/cobranca/volta`). A volta vem de outro site e o
 * cookie de sessão é Strict: direto na tela, a pessoa cairia no login, logada.
 */
export function urlDoPainelDaEmpresa(): string {
  return `${(env.NEXT_PUBLIC_APP_URL ?? "").trim().replace(/\/+$/, "")}/cobranca/volta?para=painel`;
}

/**
 * A volta de quem assina pelo hub da conta suspensa. Voltar a /app/settings/billing
 * não serve: enquanto o pagamento não é lido, o layout de /app redireciona ao hub
 * e o `?voltou=1` se perde — quem acabou de pagar veria "suspensa" sem retorno.
 */
export function urlDoHub(): string {
  return `${(env.NEXT_PUBLIC_APP_URL ?? "").trim().replace(/\/+$/, "")}/cobranca/volta?para=hub`;
}

/**
 * O destino da ponte `app/cobranca/volta`. Nada da query é refletido: só a
 * PRESENÇA de `voltou` e o valor exato `hub` escolhem entre destinos fixos.
 */
export function destinoDaVolta(params: URLSearchParams): string {
  const base = params.get("para") === "hub" ? "/account-suspended" : "/app/settings/billing";
  return params.has("voltou") ? `${base}?voltou=1` : base;
}
