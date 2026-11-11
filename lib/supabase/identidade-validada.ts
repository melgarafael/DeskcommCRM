/**
 * A identidade que o PROXY valida — com o cache curto do #3696 (#4326 item 1).
 *
 * ─── O que estava caro ──────────────────────────────────────────────────────
 *
 * `proxy.ts` chamava `supabase.auth.getUser()` para todo caminho que não é
 * público. O `matcher` só exclui estáticos e o `isPublicPath` só libera as
 * rotas com autenticação própria, então a chamada valia para quase todo
 * `/api/v1/*`, para cada poll da casca (o contador da Fila, o sino, a
 * conferência da interface… todos de 30 s a 60 s) e para cada navegação RSC.
 * O #3696 pôs um cache curto de 30 s (`lib/auth/cache-curto.ts`) na cadeia do
 * handler (`lib/auth/server.ts`), mas o proxy roda ANTES do handler e ficou de
 * fora: mesmo com o cache do handler acertando, cada requisição autenticada
 * ainda fazia pelo menos uma ida a `/auth/v1/user`.
 *
 * ─── Por que aqui, e com a MESMA chave ──────────────────────────────────────
 *
 * Este módulo não inventa cache novo: usa `comCacheCurto`, a chave
 * `sessao:<hash-dos-cookies>` (`sessaoDosCookies`), o teto no `exp` do JWT com
 * a margem de 5 s e a regra de guardar SÓ o sucesso — exatamente o que
 * `lib/auth/server.ts` já faz. A chave ser a mesma é o ponto: proxy e handler
 * dividem a MESMA entrada, então a janela do proxy não é uma janela nova, é a
 * que o #3696 já tinha aberto. Quem invalida (`invalidarSessao` na saída,
 * `invalidarUsuario` em revogação) derruba as duas de uma vez.
 *
 * ─── O que continua SEM cache, de propósito ─────────────────────────────────
 *
 * Só a IDENTIDADE ("quem é") é reaproveitada. A decisão de AUTORIZAÇÃO que o
 * proxy toma depois — `fn_is_platform_admin` em `/admin/*` — continua indo ao
 * banco em toda requisição, e o teste do proxy fixa isso (`estado.admins` = 2
 * com `estado.usuarios` = 1). Cachear permissão junto com identidade é
 * exatamente o que este item não faz.
 *
 * ─── Por que não `getClaims()` ──────────────────────────────────────────────
 *
 * Medido em `@supabase/auth-js` 2.119.0 (`GoTrueClient.js`, `getClaims`): a
 * verificação local só acontece com chave ASSIMÉTRICA (JWKS). Sem `kid`, com
 * `alg` `HS*` ou sem WebCrypto, o método cai em `this.getUser(token)` — a
 * mesma ida ao GoTrue. O self-host deste produto assina com o segredo HS256,
 * então `getClaims()` não tiraria a chamada do caminho. Pior: quando ele
 * verificasse localmente, a sessão revogada continuaria valendo até o `exp` do
 * token (1 h por padrão) — muito além da janela que este item admite.
 */
import {
  comCacheCurto,
  etiquetaDeSessao,
  etiquetaDeUsuario,
  sessaoDosCookies,
} from "@/lib/auth/cache-curto";

/** O mínimo que o proxy usa da resposta de `auth.getUser()`. */
export interface RespostaDeIdentidade {
  data: { user: { id: string } | null };
  error: { name?: string; message?: string } | null;
}

/**
 * Valida a identidade da requisição, com o cache curto do #3696 quando há
 * sessão reconhecível — e pelo caminho direto em todo o resto.
 *
 * `carregar` é o `supabase.auth.getUser()` do client da requisição: quem chama
 * passa a função pronta, e o cache só decide SE ela roda.
 *
 * Sem cookie de sessão (logout já feito, visitante anônimo) não existe chave:
 * a chamada vai direto, e é ela que responde "não há usuário". Sem `exp`
 * legível no JWT também não se cacheia — servir identidade para um token
 * vencido devolveria "autenticado" com credencial morta. As duas escolhas são
 * fail-open para o comportamento antigo, nunca para "autorizado".
 */
export async function validarIdentidade(
  carregar: () => Promise<RespostaDeIdentidade>,
  cookies: { name: string; value: string }[],
): Promise<RespostaDeIdentidade> {
  const sessao = sessaoDosCookies(cookies);
  if (!sessao || sessao.expiraEm === null) return carregar();

  return comCacheCurto<RespostaDeIdentidade>({
    chave: `sessao:${sessao.chave}`,
    etiquetas: [etiquetaDeSessao(sessao.chave)],
    // A identidade também derruba a sessão: `invalidarUsuario` (sair de todos
    // os aparelhos, MFA novo, revogação) alcança as outras sessões da pessoa.
    etiquetasDoValor: (r) => (r.data.user ? [etiquetaDeUsuario(r.data.user.id)] : []),
    ate: sessao.expiraEm,
    guardar: (r) => !r.error && !!r.data.user,
    carregar,
  });
}
