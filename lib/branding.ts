/**
 * Marca da instalação — nome e logo configuráveis pelo `.env`, SEM rebuild.
 *
 * Por que existe: quem instala o DeskcommCRM para clientes (agência, revendedor)
 * precisa da própria marca na interface. Fazer isso editando o código quebraria o
 * caminho de atualização — `update.sh` puxa a imagem nova e o patch local se perde,
 * que é exatamente a dor nº 1 de quem hospeda o próprio sistema. Configuração em
 * `.env` sobrevive a toda atualização.
 *
 * Vale para servidor (`process.env`) e navegador (`window.__PUBLIC_ENV__`, injetado
 * em runtime pelo `<PublicEnvScript/>`) — mesmo modelo de `lib/sentry/dsn.ts`.
 *
 * As variáveis NÃO são `NEXT_PUBLIC_*` de propósito: essas são queimadas no bundle
 * durante o `next build`, e o self-hoster roda uma imagem PRÉ-BUILDADA. A marca dele
 * nunca apareceria. É o mesmo motivo pelo qual a URL do Supabase é injetada em
 * runtime em vez de lida do bundle.
 */

export const DEFAULT_APP_NAME = "DeskcommCRM";

export type Branding = {
  /** Nome exibido na interface e nos títulos de página. */
  name: string;
  /** URL do logo, ou `null` quando a marca deve aparecer como texto. */
  logoUrl: string | null;
  /** Primeira letra do nome — usada onde só cabe um caractere (sidebar recolhida). */
  initial: string;
};

/**
 * Resolve a marca a partir dos valores crus. Função pura: recebe a fonte, não a
 * procura — assim o mesmo resolvedor serve servidor, navegador e teste.
 *
 * Valor vazio ou só com espaços cai no padrão. Isso importa porque `.env` gerado
 * por script costuma trazer a chave declarada e vazia (`APP_NAME=`), e tratar isso
 * como "marca sem nome" deixaria a interface em branco.
 */
export function resolveBranding(
  name: string | undefined | null,
  logoUrl: string | undefined | null,
): Branding {
  const resolvedName = (name ?? "").trim() || DEFAULT_APP_NAME;
  const resolvedLogo = (logoUrl ?? "").trim();
  return {
    name: resolvedName,
    logoUrl: resolvedLogo.length > 0 ? resolvedLogo : null,
    // Spread em vez de [0]: nome começando com emoji ou acento composto quebraria
    // no meio do code point e renderizaria caractere inválido.
    initial: ([...resolvedName][0] ?? DEFAULT_APP_NAME[0]!).toUpperCase(),
  };
}

/** Lê a marca da fonte correta em cada lado da fronteira servidor/navegador. */
export function branding(): Branding {
  if (typeof window !== "undefined") {
    const runtime = window.__PUBLIC_ENV__;
    return resolveBranding(runtime?.APP_NAME, runtime?.APP_LOGO_URL);
  }
  return resolveBranding(process.env.APP_NAME, process.env.APP_LOGO_URL);
}
