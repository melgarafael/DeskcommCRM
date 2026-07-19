/**
 * Cliente de egress ÚNICO com ALLOWLIST (F4-03; blueprint 6.1/6.6 — ForcedLeak: o
 * fix é allowlist de REDE, não prompt). TODO HTTP do runtime sai por aqui: o host da
 * URL é validado contra uma allowlist derivada de CONFIG (nunca hardcoded) ANTES do
 * fetch nativo. Host desconhecido → FAIL CLOSED (lança) + evento de segurança.
 *
 * A allowlist é montada por org/config: host do CRM (CRM_BASE_URL) + WAHA do tenant +
 * endpoint do provedor LLM (F2-23) + utilitários (count-tokens/embed). Os call sites
 * de edge/ (mcp-client, count-tokens, embed — e o sink WAHA-via-CRM, que passa pelo
 * mcp-client) roteiam por `allowlistedFetch`; qualquer outro destino falha closed.
 *
 * Contenção de exfiltração: uma URL de imagem com dados no querystring ou um payload
 * de injeção pedindo POST externo aponta para um host FORA da allowlist → bloqueado.
 * O evento de segurança loga SÓ o host (nunca a URL/querystring/token/PII, regra 8).
 */
import type { Logger } from '../obs/logger';

/**
 * Destino fora da allowlist — FAIL CLOSED. NÃO é transiente: o chamador não deve
 * re-tentar como erro de transporte (é contenção de segurança, não flake de rede).
 */
export class EgressBlockedError extends Error {
  override readonly name = 'egress_blocked';
  readonly host: string;
  constructor(host: string) {
    super(`egress bloqueado: destino '${host}' fora da allowlist — fail closed (F4-03)`);
    this.host = host;
  }
}

/** Host (com porta, minúsculo) de uma URL/host cru; null se não parseável. */
export function hostOf(target: string | URL): string | null {
  try {
    return new URL(target).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Monta a allowlist a partir de entradas de CONFIG (URLs completas ou hosts crus).
 * Entradas vazias/undefined são ignoradas. O resultado é o conjunto de hosts
 * permitidos — nunca uma constante de código.
 */
export function buildAllowlist(entries: ReadonlyArray<string | undefined>): ReadonlySet<string> {
  const hosts = new Set<string>();
  for (const entry of entries) {
    if (!entry) continue;
    const trimmed = entry.trim();
    if (!trimmed) continue;
    // aceita URL completa (extrai host) ou host cru já normalizado
    const host = hostOf(trimmed) ?? (/^[a-z0-9.:-]+$/i.test(trimmed) ? trimmed.toLowerCase() : null);
    if (host) hosts.add(host);
  }
  return hosts;
}

/** Parseia o knob EGRESS_EXTRA_ALLOWED_HOSTS (CSV de hosts extra por org/tenant). */
export function parseExtraHosts(csv: string | undefined): string[] {
  if (!csv) return [];
  return csv
    .split(',')
    .map((h) => h.trim())
    .filter((h) => h.length > 0);
}

export interface AllowlistedFetchDeps {
  /** hosts permitidos — derivada de config; host fora dela falha closed. */
  allowlist: ReadonlySet<string>;
  /** logger do evento de segurança (só o host, nunca token/PII). Opcional: o veto vale sem ele. */
  log?: Logger;
  /** fetch injetável (testes); default = fetch nativo. */
  fetchImpl?: typeof fetch;
}

/**
 * Fetch com contenção de rede: valida o host contra a allowlist ANTES de sair byte.
 * Host desconhecido (ou URL não parseável) → EgressBlockedError + evento de segurança.
 */
export async function allowlistedFetch(
  input: string | URL,
  init: RequestInit | undefined,
  deps: AllowlistedFetchDeps,
): Promise<Response> {
  const host = hostOf(input);
  if (host === null || !deps.allowlist.has(host)) {
    // Evento de segurança: SÓ o host (a URL completa pode carregar querystring com
    // dados exfiltrados / token — nunca logada). Regra dura 8.
    deps.log?.warn('egress bloqueado: tentativa de saída fora da allowlist', {
      event: 'egress_blocked',
      host: host ?? 'unparseable',
    });
    throw new EgressBlockedError(host ?? 'unparseable');
  }
  // Contenção de REDIRECT (F4-08 ressalva 5): o fetch nativo seguiria um 3xx SEM re-checar
  // a allowlist — um host allowlistado poderia redirecionar para fora (exfil por Location).
  // `redirect: 'manual'` não segue; re-checamos o host do Location e bloqueamos se externo.
  const res = await (deps.fetchImpl ?? fetch)(input, { ...init, redirect: 'manual' });
  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get('location');
    const redirectHost = location !== null ? hostOf(new URL(location, input).toString()) : null;
    if (redirectHost === null || !deps.allowlist.has(redirectHost)) {
      deps.log?.warn('egress bloqueado: redirect para fora da allowlist', {
        event: 'egress_blocked',
        host: redirectHost ?? 'unparseable',
      });
      throw new EgressBlockedError(redirectHost ?? 'unparseable');
    }
  }
  return res;
}
