# Relatório de Auditoria de Segurança e Bugs — DeskcommCRM

**Projeto:** DeskcommCRM  
**Repositório:** [prevprocesso-maker/DeskcommCRM](https://github.com/prevprocesso-maker/DeskcommCRM)  
**Ambiente público:** [deskcomm-crm-five.vercel.app](https://deskcomm-crm-five.vercel.app)  
**Data da validação:** 20 de agosto de 2026  
**Responsável:** Manus AI

## Sumário executivo

A auditoria foi conduzida sobre o repositório, a suíte de testes, os scripts de instalação, as rotas críticas e o ambiente público. A metodologia adotada foi inspirada na [Cloudflare Security Audit Skill](https://github.com/cloudflare/security-audit-skill), que recomenda reconhecimento, análise de superfícies, validação adversarial, correção e verificação independente. A seleção foi feita após comparar outras skills de segurança disponíveis no GitHub; a opção da Cloudflare foi escolhida por ser especificamente orientada a auditoria reproduzível, e não apenas a revisão genérica de código.

O resultado final é **aprovado para continuidade do desenvolvimento**, com duas correções de testes e uma correção de comportamento em produção. A suíte completa terminou com **423 arquivos de teste aprovados e 4.724 testes aprovados**. O TypeScript terminou sem erros, o ESLint terminou com código de saída zero e 247 avisos não bloqueantes, e `pnpm audit --audit-level=high` não reportou vulnerabilidades conhecidas. O login público respondeu HTTP 200 e os cabeçalhos de proteção foram observados. O healthcheck público passou de HTTP 503 para HTTP 200 com estado `degraded`, porque Redis e WAHA ainda não estão configurados, enquanto o Supabase respondeu `ok`.

> **Conclusão operacional:** não restaram erros reproduzíveis bloqueantes nas verificações executadas. A implantação continua funcional para autenticação e para o núcleo Supabase. WhatsApp/WAHA, Redis e IA permanecem itens de configuração e validação funcional, não falhas silenciosas que devam ser tratadas como concluídas.

## Escopo e metodologia

A análise cobriu a validação de ambiente, isolamento por organização e RLS já presentes no projeto, rotas de autenticação e healthcheck, proteção de headers, busca por segredos e chamadas a provedores de IA, dependências, testes unitários e de API, scripts shell do Hostgator, e a resposta HTTP do domínio publicado. As referências de integração do Supabase foram conferidas na documentação de [Auth Hooks](https://supabase.com/docs/guides/auth/auth-hooks) e [Database Webhooks](https://supabase.com/docs/guides/database/webhooks), que distinguem hooks de autenticação de webhooks acionados por eventos de tabela.

A validação foi feita em duas camadas. Primeiro, os problemas foram reproduzidos no repositório com comandos determinísticos. Depois, as correções foram publicadas na branch `main` e verificadas pelo domínio público. A API do Vercel retornou 403 para a listagem de deployments nesta sessão; por isso, a comprovação final usou a própria URL pública, o status HTTP, o corpo JSON e os cabeçalhos da aplicação, sem inferir sucesso a partir de uma API que não autorizou a consulta.

## Achados e correções

| ID | Severidade | Achado | Evidência | Correção | Estado |
|---|---:|---|---|---|---|
| BUG-01 | Baixa | O teste de alcance do resolver de modelos era sensível à coloração ANSI do `git grep`; em ambientes que habilitavam cor, a comparação de caminhos falhava apesar do código estar correto. | `tests/unit/openrouter-alcance.test.ts` falhava por saída colorida do Git. | Foi adicionado `--color=never` à chamada controlada de `git grep`. | Corrigido e publicado no commit [`0d9e2097`](https://github.com/prevprocesso-maker/DeskcommCRM/commit/0d9e2097). |
| BUG-02 | Baixa | O teste do instalador interativo respondia à posição errada da pergunta `APP_ACCENT_HEX`, deixando a fila de respostas desalinhada. | `hostgator-setup-kit/test-validators.sh` falhava ao validar a posição da cor da marca. | A posição foi corrigida de 5 para 4, com comentários alinhados à ordem real da fila. | Corrigido e publicado no commit [`0d9e2097`](https://github.com/prevprocesso-maker/DeskcommCRM/commit/0d9e2097). |
| BUG-03 | Média | O healthcheck público retornava 503 quando Redis e WAHA tinham placeholders ou endereços locais, mesmo quando o Supabase estava saudável e as integrações opcionais ainda não haviam sido contratadas/configuradas. | `GET /api/v1/health` retornava `unhealthy`, Redis `endereco_nao_resolve` e WAHA `conexao_recusada`. | Endpoints sentinela são classificados como `degraded`/`nao_configurado`; falhas reais de serviços configurados continuam retornando 503. Foi criada uma função pura para a classificação e testes de regressão. | Corrigido e publicado no commit [`59dfd10b`](https://github.com/prevprocesso-maker/DeskcommCRM/commit/59dfd10b). |

A correção do healthcheck é deliberadamente conservadora. Ela não ignora indisponibilidade real: somente valores vazios, placeholders e endereços locais usados para setup são tratados como não configurados. Um Redis ou WAHA configurado com endereço real que responder com erro permanece `down` e mantém o status HTTP 503, preservando a capacidade de monitoramento.

## Validações executadas

| Verificação | Resultado | Observação |
|---|---:|---|
| TypeScript (`pnpm typecheck`) | PASS | Código de saída 0, sem erros de tipo. |
| ESLint (`pnpm lint`) | PASS | Código de saída 0; 247 avisos, 0 erros. |
| Auditoria de dependências (`pnpm audit --audit-level=high`) | PASS | “No known vulnerabilities found”. |
| Vitest completo | PASS | 423 arquivos e 4.724 testes aprovados. |
| Testes shell do Hostgator | PASS | Scheduler, update guard e validadores aprovados. |
| Teste direcionado do healthcheck | PASS | 3 casos, incluindo placeholder, estado degradado e falha real. |
| Teste direcionado do resolver OpenRouter | PASS | 6 casos aprovados. |
| `/login` em produção | PASS | HTTP 200, marcação de login presente. |
| `/api/v1/health` em produção | PASS | HTTP 200; Supabase `ok`, Redis/WAHA `degraded` e `nao_configurado`. |
| Cabeçalhos HTTP | PASS | HSTS, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, Referrer-Policy e Permissions-Policy observados. |
| Estado do Git | PASS | `main` sincronizada com `origin/main`, sem alterações pendentes. |

Os avisos do ESLint são dívida de qualidade, não falhas de compilação ou de execução. Eles devem ser tratados em uma tarefa própria para evitar misturar limpeza ampla com correções de segurança já validadas.

## Segurança observada

A rota de healthcheck continua pública para permitir monitoramento externo, mas não expõe os alvos internos Redis/WAHA sem `verbose=1` acompanhado do segredo interno. A comparação do segredo usa comparação em tempo constante e rejeita credenciais vazias. Os cabeçalhos HTTP observados reduzem riscos de enquadramento, MIME sniffing, downgrade de transporte e uso indevido de recursos do navegador.

A análise também confirmou que o projeto possui testes de invariantes para roteamento de modelos, validações de upload, proteção de credenciais em URLs, isolamento organizacional e comportamento de funções autenticadas. A presença dos testes não substitui uma prova E2E com usuários reais em cada ambiente, mas diminui o risco de regressão durante a próxima etapa de desenvolvimento.

## Backlog residual e limites da conclusão

| Item | Impacto | Próxima ação recomendada |
|---|---|---|
| WAHA/WhatsApp | A integração está `degraded` porque não há serviço WAHA ativo no Vercel. O login e o núcleo Supabase não dependem dessa prova. | Configurar WAHA em ambiente persistente, definir URL, chave, webhook e HMAC, e executar teste de sessão, envio, recebimento e assinatura. |
| Redis | O healthcheck indica `nao_configurado`; recursos que dependem de rate limit ou filas distribuídas não devem ser considerados validados em produção. | Criar/configurar Upstash ou Redis compatível, verificar token, executar testes de concorrência e conferir o isolamento entre organizações. |
| IA | As variáveis de provedores de IA estão ausentes ou não foram validadas nesta auditoria de integração externa. A aplicação degrada com aviso de `ai_gateway_key_missing`. | Escolher um provedor real, cadastrar a chave fora do repositório e executar testes de chat, fallback, custo, timeout e redaction de dados sensíveis. |
| `IMPERSONATE_COOKIE_SECRET` | A aplicação registra aviso quando a chave está ausente ou tem menos de 32 caracteres; o fluxo correspondente retorna 503 até ser configurado. | Definir segredo aleatório com pelo menos 32 caracteres em produção e testar autorização, expiração e auditoria do fluxo. |
| Avisos do ESLint | 247 avisos não bloqueantes reduzem a clareza da manutenção e podem esconder novos avisos. | Corrigir por grupos pequenos, começando por imports não usados e tipos inconsistentes, sem usar `--fix` em massa sem revisão. |
| Fluxos reais de cadastro e RLS | Foram validados por testes e pela presença do Supabase saudável, mas o relatório não executou cadastro com dados pessoais do usuário nem criou registros reais em sua organização. | Executar manualmente um cadastro de teste, criação de organização e lead, depois confirmar que um segundo usuário não lê dados da primeira organização. |

Esses itens não foram marcados como “corrigidos” porque dependem de serviços, credenciais ou dados operacionais que não estavam disponíveis para uma validação segura nesta sessão. O comportamento da aplicação agora os sinaliza explicitamente em vez de confundir ausência de configuração com indisponibilidade inesperada.

## Commits entregues

A primeira publicação, [`0d9e2097`](https://github.com/prevprocesso-maker/DeskcommCRM/commit/0d9e2097), estabilizou os dois testes reproduzíveis encontrados na auditoria. A segunda, [`59dfd10b`](https://github.com/prevprocesso-maker/DeskcommCRM/commit/59dfd10b), corrigiu o healthcheck, adicionou `lib/health/status.ts` e incluiu três testes de regressão. A branch `main` e `origin/main` estavam alinhadas na validação final.

## Referências

[1]: https://github.com/cloudflare/security-audit-skill "Cloudflare Security Audit Skill"

[2]: https://supabase.com/docs/guides/auth/auth-hooks "Supabase Auth Hooks"

[3]: https://supabase.com/docs/guides/database/webhooks "Supabase Database Webhooks"

[4]: https://github.com/prevprocesso-maker/DeskcommCRM "Repositório DeskcommCRM"


## Implementação adicional — EPIC-05 / Custom Fields

Após a auditoria, foi implementada a primeira tarefa funcional do backlog de Customer 360. A migration `20260820100000_0159_contact_custom_fields.sql` adiciona `contacts.custom_fields` como `jsonb NOT NULL`, com valor padrão `{}` e constraint que rejeita valores que não sejam objetos JSON. A mesma alteração foi registrada no `supabase/baseline.sql` e em `supabase/migrations/MANIFEST.md`, conforme o gate de consistência do repositório.

O backend passou a incluir `custom_fields` no SELECT, criação e atualização de contatos. O schema Zod aceita mapas JSON com chaves de até 80 caracteres e limite de 32 KB, reduzindo risco de payload abusivo. A tela de detalhe reutiliza `crm_pipelines.settings.fields[]`, ignora campos marcados como `deprecated` e fornece essas definições ao `CustomFieldsEditor` no diálogo de edição de contato.

A migration foi aplicada com sucesso no projeto Supabase autorizado pelo usuário e verificada diretamente no banco: a coluna existe como `jsonb`, é `NOT NULL` e possui default `{}`. A implementação foi publicada nos commits `35726fee` e `4ed0abeb`.

A validação final após a correção do manifesto ficou verde: **423 arquivos Vitest e 4.726 testes aprovados**, typecheck aprovado, auditoria de dependências sem vulnerabilidades conhecidas, testes shell aprovados, login público HTTP 200 e healthcheck público HTTP 200 com status `degraded` apenas para Redis e WAHA não configurados.


## Implementação adicional — Hardening do cliente WAHA

A camada de comunicação com WAHA foi endurecida no commit `0f684930`. Todas as chamadas do cliente agora usam timeout explícito de 10 segundos com `AbortController`, evitando que uma dependência externa offline prenda uma rota até o limite do runtime. Erros HTTP não incluem mais o corpo devolvido pelo WAHA, impedindo que tokens, telefones ou outros dados presentes na resposta acabem em exceções e logs.

Também foi adicionada cobertura para timeout, não vazamento do corpo de erro e idempotência de parada de sessão inexistente (`404`). Os testes direcionados passaram com 13 casos. A suíte completa posterior passou com **424 arquivos e 4.729 testes**, sem vulnerabilidades conhecidas na auditoria de dependências, com typecheck aprovado e produção respondendo login HTTP 200 e healthcheck HTTP 200.

Redis e WAHA continuam deliberadamente `degraded / nao_configurado` em produção porque não há credenciais/serviços reais ativos. O código não os marca como saudáveis artificialmente e não ativa envio, filas ou rate limit distribuído sem configuração válida.


## Nova fase — Hardening do debounce Redis

A camada de debounce usada pelo indexador RAG foi reforçada no commit `53038e0f`. O cliente Redis agora usa `retry: false`, evitando retries longos quando o serviço está indisponível. Como o debounce já possui fallback em memória, a falha de Redis é tratada de forma explícita, com aviso operacional e sem derrubar o worker. A chave usada pelo indexador continua escopada por organização, agente e tipo de evento: `rag:debounce:{organization_id}:{agent_id}:{event_type}`.

A liberação de lock também passou a tolerar indisponibilidade do Redis e limpar o estado local quando aplicável. Foram adicionados testes para fallback quando o `SET NX EX` falha, preservação do TTL, segunda tentativa bloqueada no mesmo processo, `retry: false` e liberação sem exceção quando o Redis está fora.

A validação direcionada passou com **17 testes** e o typecheck passou. A suíte completa desta fase passou com **425 arquivos e 4.731 testes aprovados**, a auditoria de dependências não encontrou vulnerabilidades conhecidas, o login público continuou HTTP 200 e o healthcheck continuou HTTP 200 com Supabase `ok` e Redis/WAHA `degraded / nao_configurado`. O branch permaneceu limpo e sincronizado com `origin/main`.

Esta implementação não ativa Redis em produção por conta própria. Enquanto `UPSTASH_REDIS_REST_URL` e `UPSTASH_REDIS_REST_TOKEN` não forem configurados, o sistema sinaliza a limitação e o fallback permanece local, portanto não deve ser considerado rate limit ou lock distribuído entre múltiplas instâncias.
