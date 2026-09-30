---
impacto: nada_mudou
secao: corrigido
titulo: Empresa suspensa responde 403 org_suspended em JSON nas rotas de API em vez de um 307 para uma página
---

Quando uma empresa é suspensa, `resolveActiveOrg` passou a redirecionar quem tenta usá-la para a página `/account-suspended`. Em tela isso é o comportamento certo (leva o operador ao hub para pagar ou pedir LGPD), mas em rota de API virava um **307 que aponta para uma página HTML**: o bloqueio acontecia, porém o cliente (`lib/api/client.ts`) não recebia um erro estruturado e não conseguia levar o usuário ao hub.

As rotas de `/api/v1` que resolvem a organização pela sessão agora respondem **403 `org_suspended` em JSON** quando a empresa não opera, no mesmo formato que `requireRole` já devolvia. Quem integra pela API recebe o código reconhecível e pode encaminhar o usuário ao hub; a tela continua funcionando como antes, redirecionando para `/account-suspended`. Rotas de admin e dos canais que decidem transição de estado não mudam.

Contribuição de @webtecnica (#2021).