---
impacto: capacidade_nova
secao: adicionado
titulo: O /api/v1/health diz a CAUSA do banco fora e aponta o runbook certo
---

O health já dizia `supabase: down` e errava o porquê: numa instalação no plano
free, o banco passou ~6 h fora com 100% das chamadas `/rest/v1` em 522 e a
resposta era só `tempo_esgotado`. Quem lia ia atrás de lentidão de rede com o
projeto sem memória — e o runbook que existia para o sintoma aponta outra causa
(o gateway do Supabase reexecutando requisições), com uma proteção que já estava
instalada e não resolveu.

Agora `checks.supabase` traz dois campos novos, ao lado dos que já existiam:
`causa` (`postgrest_sem_schema_cache`, `projeto_sem_resposta_na_origem`,
`banco_inacessivel` ou `lentidao_generica`) e `runbook`, com o caminho do
documento certo para aquela causa. `status`, `reason`, `error`, `latency_ms` e
`target` continuam com o mesmo nome e o mesmo significado, então monitor que já
lê o health não muda nada.

Os quatro ramos, e o que distingue cada um: 503 com `PGRST002` no corpo é o
PostgREST sem schema cache (memória insuficiente); 522 sem corpo é o projeto
fora, sem ninguém responder na origem; DNS, porta fechada ou TLS é o banco
inacessível — e esse NÃO manda para o runbook de memória; tempo esgotado sem
status nem corpo é lentidão genérica, e o health diz que não dá para separar em
vez de inventar schema cache.

Um endereço `*.supabase.co` que deixou de resolver cai em `banco_inacessivel`,
e o runbook apontado começa por conferir no painel se o projeto foi pausado ou
apagado (projeto pausado volta com **Restore project**).

Contribuição de @webtecnica (#3677).
