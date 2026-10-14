# Evidências de segurança — vocabulário de etiquetas paginado

Escopo: complemento do PR #2855, revisão em 2026-10-14. Destino: núcleo; paginação/busca atende o vocabulário comum sem dependência paga ou configuração nova. Dados exclusivamente fictícios. Esta é evidência de regressão focada, não resultado de scanner/SARIF nem auditoria global.

## Superfície e ameaças

- `hooks/contacts/useContactTagVocabulary.ts` e `hooks/inbox/useConversationTags.ts`: separar cache por organização/busca; impedir que a busca injete parâmetros adicionais; propagar recusa do servidor.
- Rotas de sugestões e gerência: organização vem da sessão autorizada, não da query. A gerência mantém o gate manager e a política MFA existente; sugestões mantêm viewer. RPC usa cliente de sessão.
- `fn_vocabulario_de_tags_pagina`: SECURITY INVOKER, RLS vigente, grants explícitos sem execução anon; paginação limitada. Busca é texto literal, não SQL dinâmico nem wildcard.

## Execuções reproduzíveis

```sh
pnpm exec vitest run --project produto tests/unit/tags-vocabulary.security.test.ts tests/unit/tags-busca-api.test.ts tests/unit/tags-paginadas-schema.test.ts
pnpm test:db tests/invariants/tags-paginadas.test.ts
pnpm typecheck
pnpm exec eslint tests/unit/tags-vocabulary.security.test.ts
```

Resultados na revisão: 20 testes unitários passaram; cinco invariantes de banco passaram com baseline install + update no PostgreSQL 15 descartável; typecheck e lint do arquivo novo passaram.

A recusa `permission denied for function fn_vocabulario_de_tags_pagina` no log da suíte é o teste negativo anon esperado, não falha de instalação.

| Ameaça | Prova e limite |
| --- | --- |
| Cache compartilhado entre organizações | Teste dos dois hooks captura opções reais de useQuery e compara chaves de tenants distintos; não é ensaio de troca de sessão no navegador. |
| Busca injeta organization_id | Hooks usam encodeURIComponent; teste chama queryFn e verifica URL/sinal. Rotas recebem query maliciosa e usam org da sessão. Autenticação é mockada na suíte unitária. |
| Acesso sem autorização | Teste das três rotas retorna 403 sem RPC. Banco usa identidade authenticated real e outra organização: items vazio, total zero; anon não executa. |
| Busca/paginação abusiva | Schema recusa busca enorme; banco limita tamanho e corrige offset negativo; % é literal. |
| Falha aparece como lista vazia | API retorna 500 para banco/contrato inválidos; ambos os hooks propagam rejeição. |

## Controle negativo

Removida temporariamente `encodeURIComponent` apenas do hook de contatos: o teste de injeção de parâmetro reprovou. Arquivo restaurado e suíte novamente verde. A alteração negativa não integra o commit.

## Revisão e limites

Não foram adicionados segredos, dependências, endpoints públicos sem autenticação, workflows ou integração externa. Não houve mudança funcional neste complemento: testes e documentação somente. Não é prova end-to-end do proxy/cookie/MFA, varredura de dependências/segredos nem homologação de todas as rotas. A avaliação do bot e os checks obrigatórios do repositório continuam sujeitos à triagem do mantenedor; registrar estas evidências não garante aprovação automática.
