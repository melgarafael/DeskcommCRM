# Relatório consolidado de segurança, bugs, implementação e produção — DeskcommCRM

**Projeto:** DeskcommCRM  
**Repositório:** [prevprocesso-maker/DeskcommCRM][1]

**Ambiente permanente:** [deskcomm-crm-five.vercel.app][2]

**Projeto Vercel:** `deskcomm-crm`

**Data da validação final:** 20 de agosto de 2026

**Responsável:** Manus AI

## 1. Sumário executivo

O DeskcommCRM foi executado, publicado e auditado sobre o código-fonte, os handlers de API, os fluxos de autenticação, o isolamento multi-tenant, os scripts de instalação, as dependências, os testes automatizados e o ambiente público. A metodologia de segurança seguiu a abordagem de reconhecimento, análise de superfície, reprodução, correção e verificação independente inspirada na [Cloudflare Security Audit Skill][3].

A versão final foi publicada na branch `main` e chegou à produção Vercel no deployment `dpl_3wt7v8mg3rrNG8UPDfoEVa5EqmBo`, associado ao commit `c85efe46`. O deployment terminou em estado **READY**, com o domínio permanente `deskcomm-crm-five.vercel.app` apontando para a nova versão. A página `/login` respondeu HTTP 200 e apresentou o formulário de autenticação e o link de cadastro.

O núcleo Supabase permanece saudável. O healthcheck público respondeu HTTP 503 porque o Redis está configurado com valor inválido e o WhatsApp/WAHA ainda não está configurado; essa resposta é **intencional e correta** para uma dependência real configurada, mas indisponível. A resposta não expõe URL, header, token, corpo de exceção ou mensagem bruta do upstream: o Redis aparece somente como `error: "invalid_configuration"` e `reason: "configuracao_invalida"`, enquanto o WAHA aparece como `not_configured`.

> **Conclusão operacional:** não restaram erros reproduzíveis nos testes automatizados, no typecheck, no lint de canais, na auditoria de dependências ou no deployment Vercel. Permanecem pendências operacionais de credenciais e serviços externos, especialmente a substituição do token Redis malformado, a instalação de WAHA, a configuração da IA e a definição do segredo de impersonação.

## 2. Escopo e metodologia

A auditoria cobriu as rotas `/api/v1/health`, autenticação, handlers de leads, schema Zod, cliente Redis REST, rate limiter, debounce RAG, cliente WAHA, validações de configuração, emissão de eventos, auditoria, atividades de timeline e isolamento por `organization_id`. Também foram verificadas as políticas e decisões arquiteturais documentadas no repositório, incluindo a regra de que o trigger `fn_crm_lead_close_on_stage` é a fonte única de `status` e `closed_at` para transições terminais.

A análise combinou revisão estática, testes unitários e de API, testes de invariantes, testes shell, auditoria de dependências e verificação pública pós-deploy. Os achados de produção foram comparados com os logs de runtime da Vercel. Erros históricos de deployments antigos sem variáveis de ambiente foram separados dos resultados atuais: na janela recente de dez minutos após a publicação final, não houve clusters de erro de runtime.

## 3. Inventário de bugs e vulnerabilidades

| ID | Severidade | Achado | Reprodução ou evidência | Correção | Estado |
|---|---:|---|---|---|---|
| BUG-01 | Baixa | O teste de alcance do resolver de modelos era sensível a códigos ANSI produzidos pelo `git grep`. | A comparação de caminhos falhava quando a coloração do Git estava habilitada. | Adicionado `--color=never` ao `git grep` controlado. | Corrigido no commit [`0d9e2097`][4]. |
| BUG-02 | Baixa | O teste do instalador interativo respondia à posição errada da pergunta de cor da marca. | A fila de respostas ficava desalinhada na validação de `APP_ACCENT_HEX`. | Corrigida a posição da pergunta e os comentários da fila. | Corrigido no commit [`0d9e2097`][4]. |
| BUG-03 | Média | O healthcheck classificava placeholders e endpoints locais de serviços opcionais como indisponibilidade real. | Redis/WAHA sem configuração geravam 503 mesmo com Supabase saudável. | Criada classificação explícita `degraded`/`nao_configurado`; indisponibilidade de serviço real continua sendo `down`/503. | Corrigido no commit [`59dfd10b`][5]. |
| SEC-01 | Alta | O healthcheck podia incluir a mensagem bruta de uma exceção Redis no JSON público. Uma credencial malformada havia sido refletida parcialmente na resposta. | A tentativa de ativar Upstash usou valor contendo aspas, nome da variável e quebras de linha; o upstream rejeitou o header e a exceção carregou parte do valor. | O healthcheck passou a responder apenas `request_failed` para exceções de upstream; não há mais exposição de URL, header, token ou corpo de resposta. | Corrigido e publicado no commit [`2207354f`][6]. |
| SEC-02 | Alta | A configuração Redis podia ser passada ao cliente mesmo contendo formato de bloco `.env`, aspas ou quebras de linha. | Valores como `UPSTASH_REDIS_REST_TOKEN=...`, token entre aspas e token com newline chegavam à construção do request. | Criado `lib/redis-config.ts`, validador puro que rejeita URL inválida, token com aspas, newline, prefixo de variável e credenciais incompletas. O healthcheck e o rate limiter usam o mesmo validador. | Corrigido no commit [`0f802a92`][7]. |
| BUG-04 | Média | O encerramento win/lose podia escolher stage terminal arquivado e colocar o lead fora do quadro ativo. | A consulta terminal não filtrava `is_archived=false`. | Stage terminal agora é filtrado por organização, pipeline, flag terminal, não arquivado e posição. | Corrigido no commit [`0f802a92`][7]. |
| BUG-05 | Média | Win/lose não aplicava a regra de posicionamento `max(position_in_stage) + 1000`. | Leads encerrados poderiam entrar em posição indefinida ou não ocupar o fim lógico da coluna terminal. | O encerramento calcula a maior posição dentro da organização e stage destino e grava a próxima posição. | Corrigido no commit [`0f802a92`][7]. |
| BUG-06 | Média | O endpoint REST de perda devolvia `validation_error` genérico quando `lost_reason` estava ausente. | `POST /api/v1/leads/[id]/lose` com `{}` não atendia o contrato `lost_reason_required` do épico. | A rota mapeia erro de campo Zod para HTTP 422 com `error.code="lost_reason_required"`, mantendo `validation_failed` no contrato interno/MCP para compatibilidade. | Corrigido no commit [`0f802a92`][7]. |
| BUG-07 | Média | A capacidade compartilhada de encerramento emitia manualmente `lead.won`/`lead.lost` enquanto o trigger de banco já era a fonte de eventos para mudança de status. | O `event_log` não possui chave idempotente que impedisse duas linhas semanticamente iguais. | Removida a emissão manual; o trigger `fn_crm_lead_close_on_stage` permanece como fonte única para status, fechamento e evento. | Corrigido no commit [`0f802a92`][7]. |
| BUG-08 | Baixa | O lint de restrição de canais classificou a nova prosa de `lib/health/status.ts` como menção a provider. | `pnpm lint:channels` reprovou o arquivo por uma menção textual a um provider em comentário. | A documentação foi reescrita de modo neutro, sem alterar o comportamento. | Corrigido no commit [`c85efe46`][8]. |

Não foi encontrado segredo persistido no repositório. A chave anon pública do Supabase aparece no HTML de login como configuração pública esperada; ela não é a `service_role` key. As credenciais privadas continuam pertencendo exclusivamente às variáveis de ambiente do servidor.

## 4. Implementações entregues

### 4.1 Configuração segura do Redis

O módulo `lib/redis-config.ts` centraliza a validação de URL e token REST do Redis. Ele diferencia três situações: configuração válida, ausência de configuração e configuração inválida. A decisão é pura e testável, permitindo que o healthcheck recuse valores malformados antes de construir headers e que o rate limiter use fallback local sem tentar iniciar um cliente Redis inválido.

O healthcheck agora preserva a diferença operacional entre serviço opcional ausente e serviço real indisponível. O fallback de rate limit continua explicitamente sinalizado como inadequado para múltiplas instâncias; ele não é apresentado como rate limit distribuído enquanto o Upstash não estiver configurado corretamente.

### 4.2 Fluxo win/lose de leads

A capacidade existente `lib/leads/encerramento.ts` foi endurecida e testada. A mutação filtra o lead por `organization_id`, busca o stage terminal no pipeline correto, exclui stages arquivados, calcula a posição final e atualiza apenas `stage_id`, `position_in_stage`, `lost_reason` quando aplicável e `updated_at`. A fonte de verdade para `status`, `closed_at` e eventos continua sendo o trigger de banco.

O endpoint win permanece idempotente: se o lead já está ganho, retorna o registro atual sem nova mutação. O endpoint lose exige motivo não vazio. A validação REST devolve o código canônico `lost_reason_required`, enquanto a capacidade interna mantém `validation_failed` para não quebrar consumidores MCP que já dependiam desse contrato.

As mutações continuam registrando `demand_closed` na timeline e auditando o fechamento. Falhas de timeline são tratadas como falha de baixa prioridade: não desfazem o fechamento, mas são registradas para observabilidade.

### 4.3 Custom fields de Customer 360

A implementação anterior de Customer 360 adicionou `contacts.custom_fields` como JSONB obrigatório com default `{}`, constraint de objeto JSON e validação Zod com limites de tamanho. O backend e a tela de detalhe foram integrados, e a migration foi registrada no baseline e no manifesto de migrações. Essa entrega foi publicada nos commits [`35726fee`][9], [`4ed0abeb`][10] e [`7203b3b9`][11].

### 4.4 Hardening de WAHA e debounce RAG

O cliente WAHA agora usa timeout de 10 segundos, não devolve corpo bruto de erro e trata parada de sessão inexistente de forma idempotente. O debounce Redis usa `retry:false`, fallback fail-fast e chaves com escopo por organização, agente e tipo de evento. Essas entregas foram publicadas nos commits [`0f684930`][12], [`c4add78f`][13] e [`53038e0f`][14].

## 5. Validações realizadas

| Verificação | Resultado | Evidência final |
|---|---:|---|
| TypeScript | PASS | `pnpm typecheck`, código de saída 0. |
| Vitest completo | PASS | 428 arquivos e 4.745 testes aprovados. |
| Testes de regressão desta sessão | PASS | 51 testes em 5 arquivos direcionados, incluindo Redis, lose REST, schemas, encerramento e compatibilidade MCP. |
| Testes shell | PASS | `pnpm test:shell`, incluindo scheduler, update guard e validadores do instalador. |
| ESLint | PASS | 0 erros e 247 avisos não bloqueantes no lint completo. Arquivos alterados também passaram no lint direcionado. |
| Lint de canais | PASS | `pnpm lint:channels`: 60 arquivos de dívida conhecida, nenhum arquivo novo infrator. |
| Auditoria de dependências | PASS | `pnpm audit --audit-level=high`: “No known vulnerabilities found”. |
| `git diff --check` | PASS | Nenhum whitespace problemático. |
| Build Vercel | PASS | Build remoto concluiu e deployment `c85efe46` ficou READY. |
| Build local | LIMITAÇÃO DO SANDBOX | Turbopack/Webpack locais foram encerrados por pressão de memória (`SIGTERM`/`SIGKILL`), sem erro de TypeScript ou rota; o build remoto da Vercel concluiu com a lista de rotas. |
| Login em produção | PASS | `/login` respondeu HTTP 200 e exibiu o formulário. |
| Healthcheck em produção | PASS COM DEGRADAÇÃO ESPERADA | Supabase `ok`; Redis `down`/`configuracao_invalida`; WAHA `degraded`/`nao_configurado`. |
| Runtime Vercel recente | PASS | Nenhum erro agregado na janela de dez minutos após o deployment final. |

Os 247 avisos do ESLint são dívida de qualidade distribuída no repositório e não falhas bloqueantes. Recomenda-se corrigi-los em ondas pequenas, sem `--fix` global sem revisão.

## 6. Estado de produção

O deployment final é o `dpl_3wt7v8mg3rrNG8UPDfoEVa5EqmBo`, associado ao commit `c85efe46`, com estado `READY` e alias permanente `deskcomm-crm-five.vercel.app`. O Supabase usado pela aplicação pública é `nzhfwgfpprjhlseutxhy.supabase.co`, conforme a configuração pública entregue pelo HTML de login.

A resposta observada em 20/08/2026 às 18:23 GMT-3 foi equivalente a:

```json
{
  "data": {
    "status": "unhealthy",
    "checks": {
      "supabase": { "status": "ok" },
      "redis": { "status": "down", "error": "invalid_configuration", "reason": "configuracao_invalida" },
      "waha": { "status": "degraded", "error": "not_configured", "reason": "nao_configurado" }
    }
  }
}
```

Esse 503 não representa falha do login ou do Supabase. Ele comunica corretamente que existe uma dependência Redis configurada, porém inválida. Depois da substituição do token por um valor limpo, o healthcheck deverá mudar para `redis: ok`; se o Redis for removido ou deixado vazio, a expectativa é `degraded`/`nao_configurado`, não 503.

## 7. Pendências operacionais

| Item | Situação | Próxima ação |
|---|---|---|
| Token Upstash Redis | Pendente e bloqueante para rate limit distribuído. O healthcheck atual identifica `configuracao_invalida`. | No console Upstash, abrir o banco configurado, copiar somente o valor do REST token e substituir `UPSTASH_REDIS_REST_TOKEN` na Vercel sem aspas, nome da variável, espaços ou quebras de linha. Salvar e redeployar. |
| URL Redis | Deve corresponder ao mesmo banco do token. | Conferir `UPSTASH_REDIS_REST_URL` no formato `https://...upstash.io`, sem aspas e sem bloco `.env`. |
| WhatsApp/WAHA | Não configurado no Vercel. | Hospedar WAHA em ambiente persistente, configurar URL, chave, webhook e HMAC e executar teste de sessão, QR, envio, recebimento e assinatura. |
| IA | Chaves de gateway ausentes na validação local; o sistema degrada com `ai_gateway_key_missing`. | Escolher provedor, cadastrar chave no ambiente server-side e testar geração, fallback, timeout, custo e redaction de dados sensíveis. |
| `IMPERSONATE_COOKIE_SECRET` | Ausente ou menor que 32 caracteres; o fluxo retorna 503 até ser configurado. | Criar segredo aleatório com pelo menos 32 caracteres, cadastrar na Vercel e testar autorização, expiração e auditoria. |
| ESLint | 247 avisos não bloqueantes. | Corrigir por grupos, priorizando imports não usados e tipos inconsistentes. |
| E2E com dados reais | Não foi realizado cadastro com dados pessoais nem criação de lead em organização real nesta sessão. | Executar cadastro de teste, criar organização e lead, e confirmar com segundo usuário que o isolamento por organização impede leitura cruzada. |
| Build local no sandbox | Limitado pela memória disponível; o build remoto Vercel passou. | Para validação local completa, usar máquina com mais memória ou configurar um runner CI com memória suficiente. |

## 8. Histórico de commits relevantes

| Commit | Entrega |
|---|---|
| [`0d9e2097`][4] | Correções dos testes ANSI e da fila interativa do instalador. |
| [`59dfd10b`][5] | Classificação correta do healthcheck com serviços opcionais ausentes. |
| [`35726fee`][9] | Persistência de custom fields em contatos. |
| [`4ed0abeb`][10] | Registro da migration de custom fields. |
| [`7203b3b9`][11] | Integração da interface de custom fields. |
| [`0f684930`][12] | Timeout e redaction do cliente WAHA. |
| [`c4add78f`][13] | Teste de parada idempotente de sessão WAHA. |
| [`53038e0f`][14] | Hardening do debounce Redis. |
| [`2207354f`][6] | Redaction de exceções no healthcheck público. |
| [`0e5754db`][15] | Documentação do redaction do healthcheck. |
| [`0f802a92`][7] | Validador Redis, correções win/lose, testes de regressão e remoção de evento duplicado. |
| [`c85efe46`][8] | Correção da menção textual detectada pelo lint de canais. |

## 9. Parecer final

O sistema está **publicado e funcional para autenticação, onboarding já configurado e núcleo Supabase**, com as correções de segurança e regressão desta sessão implantadas na produção. O fluxo de fechamento de leads agora respeita isolamento organizacional, stages ativos, posicionamento terminal, idempotência e contratos de erro. O healthcheck não deve ser alterado para esconder a falha atual do Redis: o próximo passo correto é corrigir a variável de ambiente com valor limpo e conferir a transição para `redis: ok`.

A plataforma pode continuar recebendo desenvolvimento incremental. Não é correto declarar WhatsApp, rate limit distribuído, IA ou impersonação como prontos enquanto suas dependências operacionais permanecerem sem configuração válida. Com exceção dessas pendências externas e dos avisos de qualidade não bloqueantes, as verificações reproduzíveis executadas nesta sessão terminaram verdes.

## Referências

[1]: https://github.com/prevprocesso-maker/DeskcommCRM "Repositório GitHub do DeskcommCRM"
[2]: https://deskcomm-crm-five.vercel.app "Ambiente público permanente do DeskcommCRM"
[3]: https://github.com/cloudflare/security-audit-skill "Cloudflare Security Audit Skill"
[4]: https://github.com/prevprocesso-maker/DeskcommCRM/commit/0d9e2097651487d02ee4be107edbe1dcc3ff1c33 "Commit 0d9e2097"
[5]: https://github.com/prevprocesso-maker/DeskcommCRM/commit/59dfd10be57a5e9e12b1d856ff5afd152274fe98 "Commit 59dfd10b"
[6]: https://github.com/prevprocesso-maker/DeskcommCRM/commit/2207354f3bfcf9139e25ee8b97423f42ecfbb575 "Commit 2207354f"
[7]: https://github.com/prevprocesso-maker/DeskcommCRM/commit/0f802a92939341a80a499f161859f703589e5495 "Commit 0f802a92"
[8]: https://github.com/prevprocesso-maker/DeskcommCRM/commit/c85efe4601164f7b25a9937f5fcad54781c9022c "Commit c85efe46"
[9]: https://github.com/prevprocesso-maker/DeskcommCRM/commit/35726feea7b57bab05f1fad3a056091f6d20be75 "Commit 35726fee"
[10]: https://github.com/prevprocesso-maker/DeskcommCRM/commit/4ed0abeb680f166c5ab413fcae34d726b4f8ce12 "Commit 4ed0abeb"
[11]: https://github.com/prevprocesso-maker/DeskcommCRM/commit/7203b3b968fa4b8c6bc650cf6a973f8fcfde4d11 "Commit 7203b3b9"
[12]: https://github.com/prevprocesso-maker/DeskcommCRM/commit/0f6849302d9bbdb2ec3e0a4700189ad9935845c3 "Commit 0f684930"
[13]: https://github.com/prevprocesso-maker/DeskcommCRM/commit/c4add78fe0d82388f5634bf1e576c7de6e89e818 "Commit c4add78f"
[14]: https://github.com/prevprocesso-maker/DeskcommCRM/commit/53038e0f8a3c297bd5424382fdb79827cae499a1 "Commit 53038e0f"
[15]: https://github.com/prevprocesso-maker/DeskcommCRM/commit/0e5754dbc9e59a79384e6d3f074436be6707de97 "Commit 0e5754db"
