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

export const DEFAULT_APP_NAME = "CarlosCostaPrev – Sistema Integrado de Gestão";

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

/**
 * A marca da instalação — **SOMENTE em componente de servidor.**
 *
 * ⚠️ NÃO CHAME ISTO DE UM `"use client"`. Em client component use
 * `useMarcaDaInstalacao()` (`lib/branding/contexto.tsx`), que recebe a marca por
 * prop do servidor. A regra é vigiada por
 * `tests/unit/marca-sem-divergencia-de-hidratacao.test.tsx`, que varre todo
 * arquivo `"use client"` — comentário não reprova build, teste reprova.
 *
 * ── Por que a regra existe ───────────────────────────────────────────────────
 *
 * Esta função lê fontes DIFERENTES nos dois lados da fronteira, e as duas
 * deixaram de concordar. No navegador ela lê `window.__PUBLIC_ENV__`, que desde
 * a onda do logo carrega a marca RESOLVIDA (banco acima do `.env`). No servidor
 * — inclusive no SSR de um client component, onde `window` não existe — ela lê
 * `process.env`, que é só o `.env`. Numa instalação com logo gravado pela tela e
 * `APP_LOGO_URL` vazio (o caso normal de quem sobe logo pela tela), o SSR
 * renderizava o nome em `<span>` e o cliente hidratava um `<img>`: troca de tipo
 * de elemento, React #418 em toda tela, árvore descartada e regerada.
 *
 * No SERVIDOR o comportamento é correto e é DELIBERADO: o texto sob o "Entrar"
 * sai daqui (o `.env`) enquanto o título da aba sai do banco, e
 * `tests/e2e/icone-da-marca.spec.ts:64-77` cruza as duas resoluções de propósito
 * — é o que faz "trocar o nome pela tela e a aba não acompanhar" reprovar. Por
 * isso o defeito se fecha tirando os client components daqui, e não mudando o
 * que esta função devolve.
 *
 * O ramo do navegador continua de pé porque a alternativa é pior: sem ele, um
 * client component que voltasse a chamar `branding()` cairia no padrão do
 * produto nos DOIS lados e mostraria a marca errada em SILÊNCIO. Divergir é
 * barulhento (o console acusa), e barulhento é o modo de falhar que se conserta.
 */
export function branding(): Branding {
  if (typeof window !== "undefined") {
    const runtime = window.__PUBLIC_ENV__;
    return resolveBranding(runtime?.APP_NAME, runtime?.APP_LOGO_URL);
  }
  return resolveBranding(process.env.APP_NAME, process.env.APP_LOGO_URL);
}
