---
impacto: nada_mudou
secao: corrigido
titulo: A documentação do módulo conectado não promete mais o papel `agent` sem a chave da pessoa
---

O `.env.example`, o comentário da variável em `lib/env.ts` e as declarações da F3 diziam que, sem `MODULE_JWT_PRIVATE_KEY`, o módulo conectado ficava com teto `agent`. O comportamento real é outro: o token da F2 nasce como `viewer`, então sem a chave o papel efetivo é `viewer` — o módulo lê o que um visitante lê, e rotas que cobram `agent` respondem 403 `forbidden_role`. A chave só acrescenta a identificação da pessoa, com teto `manager`.

A doc passou a dizer isso, e um teste novo trava o 403 e o 200 com a área consentida. Nada muda para quem instala: a variável continua opcional e nenhum acesso foi ampliado.
