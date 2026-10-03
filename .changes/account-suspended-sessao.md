---
impacto: nada_mudou
secao: corrigido
titulo: Sessão volta a ser renovada na tela de conta suspensa
---

`/account-suspended` estava na lista de caminhos públicos do proxy
(`lib/auth/public-paths.ts`). Por isso o `proxy.ts` saía antes do
`getUser()` — que é quem revalida e renova o cookie da sessão — e o
refresh que a própria página tentava no Server Component é ignorado por
desenho (`lib/supabase/server.ts`). Na prática, a sessão que expirava
com a pessoa nessa tela nunca era renovada, e uma navegação seguinte
podia derrubá-la no login.

A rota agora sai da lista pública. Quem cai em `/account-suspended` vem
do redirect do layout de `/app` já autenticado, então o proxy passa a
revalidar e renovar a sessão normalmente ali, como em qualquer outra
rota da árvore logada. Quem chega sem sessão já era levado ao login; a
diferença é que agora volta ao mesmo ponto depois de entrar — por
exemplo, ao pedido de LGPD aberto em `/account-suspended?pedido=...`.

Refs #2016

Contribuição de @webtecnica (#2019).
