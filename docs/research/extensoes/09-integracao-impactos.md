# Marco 2 — o que será impactado

Referência informada: a branch do PR #1016, commit `b3a056b85`, incorporando `origin/main` `60079eb5`. Investigação por leitura de código em 14/set/2026; não executou SQL, serviços, testes ou jornadas. `CONFIRMADO` abaixo significa observado no código, não comportamento medido nesta rodada.

## Fronteira aprovada

**CONFIRMADO — contrato:** PROG-017 §§4–8 separa instalação de instância, ativação/configuração por organização e autoridade do ator. Pacote declarativo não executa JS/SQL externo; o host renderiza contribuições conhecidas. PROG-018, marco 2, exige catálogo separado, pacote realmente baixado, uso em A sem alterar B, desativação e recuperação pela tela, sem rebuild do CRM. Não autoriza extração de funcionalidades já entregues.

**INFERIDO:** o primeiro incremento pode acrescentar navegação/conteúdo tipado sem criar tabelas de domínio, ferramentas de IA, consumidor de eventos ou executor. Ainda precisa de estado durável próprio e verificação de backend; esconder um card não equivale a desativar uma capacidade.

## Estado, schema, RLS e autoridade

| Camada | CONFIRMADO no repositório | PROPOSTO para a primeira integração |
|---|---|---|
| Instância | Migration `20260728130000_0089_system_self_update.sql`: `system_version`/`system_update_runs` não têm `organization_id`; têm RLS habilitada e nenhuma policy. `tests/invariants/system-self-update.test.ts` cobre essas tabelas nominalmente. | Registro novo de pacote admitido: identidade, versão/digest, manifesto validado e estado de instalação. Separar do registro de atualização do CRM; negar acesso direto de tenant e fornecer projeção mínima autorizada. |
| Organização | `organizations`, `user_organizations` e helpers `fn_user_org_ids()`/`fn_user_role_in_org()` são as fontes canônicas. `requireRole` consulta novamente o papel efetivo no banco. | Ativação/configuração com FK para organização e instalação, unicidade do vínculo e revisão. Leitura de membro não autoriza alterar ativação/concessão. Policies/RPC devem exigir o mesmo papel do backend. |
| Instalar | `lib/auth/requirePlatformAdmin.ts` é guard de página com redirects; `app/api/v1/system/update/route.ts` usa `loadAuthUser`, verifica `is_platform_admin` e `requireSupportWrite`. | Instalação exige autoridade de plataforma conforme PROG-017. API responde `fail/ok`, sem reutilizar cegamente um guard de redirect; preservar os bloqueios de suporte e a política de sessão/MFA pertinente. |
| Ativar/usar | `lib/auth/require-role.ts` resolve org do cookie validado, nunca do body; compara o papel via RPC. `lib/auth/server.ts` distingue vínculo, org ativa e contexto de suporte. | Ativação/configuração pelo admin da organização; uso respeita a autorização do destino existente. Não habilitar `allowPlatformAdmin` indiscriminadamente nem tratar preferência visual como concessão. |
| Acesso direto | Client de sessão em `lib/supabase/server.ts`; admin em `lib/supabase/admin.ts` bypassa RLS. Policies de leitura podem permitir todas as orgs de um mesmo usuário. | Filtrar explicitamente a org ativa mesmo com RLS; provar JWT de A contra B e usuário membro de ambas. Service role não pode confiar em `organization_id` enviado no payload. |
| Recuperação | `system_update_runs` demonstra registro de etapa; índice parcial e tratamento de run abandonado têm prova própria. Não é instalador genérico de extensões. | Operação persistida com etapa, erro sanitizado e próximo passo, unicidade/idempotência no banco. Não chamar instalação concluída antes da pós-condição; conservar metadados após desativar. |

**PROPOSTO — sem DDL prematuro:** manter instalação, vínculo por organização e operações como responsabilidades distintas; os nomes/tipos finais dependem do contrato de instalação. Manifesto é configuração validada, não fonte para executar DDL. Não reaproveitar `organizations.settings` como depósito irrestrito que qualquer mutação ampla de settings possa ativar.

**CONFIRMADO — entrega de schema:** CLAUDE/AGENTS exigem migration nova + apêndice idempotente no `supabase/baseline.sql` + `supabase/migrations/MANIFEST.md`; `lib/database.types.ts` é gerado. Pacote opcional não elimina essa obrigação para tabelas do framework entregues pelo CRM. Não editar migration antiga.

### Onde os gates precisam acompanhar a própria migration

- **CONFIRMADO:** `tests/invariants/rls-completude-varredura.test.ts:371` exige que toda tabela com `organization_id` tenha prova em `TABLES` de `rls-isolation.test.ts` ou em `PROVA_PROPRIA`, citando a prova comportamental. **PROPOSTO:** incluir a nova tabela de ativação no mesmo commit da migration; não aumentar `DEBITO_CONHECIDO`.
- **INFERIDO:** o molde genérico de leitura cross-tenant é insuficiente para ativação/concessões administrativas. Criar prova própria com controles positivos de admin e negativos de viewer/agent, outro tenant, alteração direta e revisão desatualizada. A policy deve falhar se sabotada, não apenas existir no catálogo.
- **CONFIRMADO:** o censo por `organization_id` não alcança tabelas de instância; o teste de atualização só enumera duas tabelas antigas. **PROPOSTO:** teste específico para novas tabelas de instalação/operação, grants, deny-all ao tenant e impossibilidade de instalar via PostgREST direto.
- **CONFIRMADO:** `tests/invariants/hardening-definer-varredura.test.ts` controla exposição de funções. **PROPOSTO:** qualquer RPC nova precisa de revokes de `PUBLIC` e `anon`, grants mínimos, `search_path` fechado e autorização interna; registrar o call site real quando `authenticated` precisar executar uma definer volátil.
- **CONFIRMADO:** `tests/unit/manifest-x-migrations.test.ts` controla MANIFEST/numeração e `apendice-do-baseline-nao-diverge-da-cadeia.test.ts` controla paridade. **PROPOSTO:** acrescentar ao conjunto existente provas install/update do baseline, unicidade de instalação/vínculo/operação e retomada, sem tratar fixture `bench_state` como migration publicável.

## Navegação e contribuição: consumidores existentes

**CONFIRMADO:** `lib/navigation/catalogo.ts` contém `NAV_CATALOG`; `registry.ts` deriva ícones, sidebar, hubs e busca. `interface.ts:7` valida destinos por enum dessa lista estática; `lerInterface` elimina destinos desconhecidos. Logo, apenas gravar uma URL externa ao catálogo no JSON não a torna um destino admitido.

**CONFIRMADO:** `components/shell/NavHub.tsx` consome `hubSections`; `app/app/crm/page.tsx` resolve usuário/org e passa papel e preferências ao hub. `Sidebar.tsx`, `MobileSidebar.tsx` e `CommandPalette.tsx` são consumidores da navegação. Não há ponto genérico de contribuição de pacote nesses contratos lidos.

**PROPOSTO:** um único ponto tipado de cards/conteúdo de extensão no hub CRM, resolvido no servidor pela instalação e ativação da org. Preservar catálogo estático e preferências atuais; se houver destino dinâmico, compor explicitamente sua identidade e elegibilidade no resolvedor, sem alargar a allowlist para aceitar qualquer href. O pacote referencia destinos internos admitidos por ID, nunca HTML, expressão, script, componente React ou URL arbitrária.

**CONFIRMADO — gate:** `tests/unit/navegacao-completude.test.ts` enumera páginas estáticas e ignora segmentos `[id]`. **PROPOSTO:** registrar a tela estática de gestão em `NAV_CATALOG`, ou justificar porta alternativa real; adicionar prova da listagem que abre o detalhe dinâmico e da resolução de pacote inexistente/inativo. Uma rota `[id]` passar nesse teste não prova que tem porta.

**INFERIDO:** ativação e preferência por vínculo precisam se reconciliar em troca de org, reload e abas antigas; estado de A não pode ficar no cache de B. O ponto de extensão deve compor com a resolução de marca/idioma em `app/app/layout.tsx`, sem sobrescrever tokens globais, marca da instalação ou portas essenciais.

## Menor jornada real sugerida

**PROPOSTO:** pacote declarativo de orientação com um card “Organizar tarefas” no hub CRM e conteúdo curto próprio, com ação tipada para o destino existente `/app/tasks`. É conteúdo novo instalado depois do build; não torna Tarefas dependente da extensão nem extrai sua implementação. O título é exemplo de fixture de produto, não regra de negócio aprovada.

1. Dono da instalação consulta o catálogo de teste separado e instala uma versão imutável realmente servida por ele; tela confirma versão/digest e resultado persistido.
2. Admin de A ativa e configura somente a apresentação admitida. O hub de A mostra a contribuição; B, em outra sessão, não mostra. Viewer/agent não conseguem instalar/ativar por tela nem API direta.
3. Em A, pessoa abre o conteúdo da extensão e usa sua ação para chegar à tela de Tarefas; cria/conclui uma tarefa sintética pelo formulário já existente, com a autorização habitual. Isso prova um consumidor operacional além da instalação.
4. Admin desativa; contribuição e entrada específica desaparecem, acesso direto ao conteúdo inativo é recusado ou mostra estado sem permitir uso. A tela Tarefas e os dados já criados continuam disponíveis pelo caminho normal.
5. Reativar recupera configuração admitida pela tela; B permanece intacta. Recarregar, trocar A/B e retomar outra aba não restaura estado antigo incorreto.

**CONFIRMADO — efeito já implementado:** `app/app/tasks/page.tsx` permite leitura e habilita edição a partir de agent; `TarefasClient` usa `hooks/tasks/useTasks.ts`. `app/api/v1/tasks/route.ts` exige viewer para GET, agent para POST, valida Zod e filtra `crm_tasks.organization_id`; mutação registra atividade por `lib/tarefas/atividade.ts` e auditoria. Não adicionar API de negócio paralela.

**LIMITE:** card/guia que abre tarefa prova distribuição declarativa, ativação e integração de navegação. Não prova widget com consultas arbitrárias, nova capacidade funcional, IA, código isolado, schema por pacote ou marketplace público. Se a expectativa de piloto exigir resumo vivo de tarefas, isso é um incremento explícito do contrato de leitura; não chamar uma lista limitada a 500 linhas de contagem total.

## Auditoria, privacidade e histórico

**CONFIRMADO:** `lib/audit/index.ts` grava `api_audit_log`; `lib/audit/actions.ts` é vocabulário único, consumido pelos filtros. `app/api/v1/audit/route.ts` limita a org ativa; painel administrativo tem filtro próprio em `app/api/v1/admin/audit/route.ts`. Falha de audit não bloqueia a mutação, portanto audit sozinho não serve como recibo de instalação.

**PROPOSTO:** adicionar ações estáveis para instalação, ativação, configuração e desativação, com ID de recurso UUID e metadados mínimos (versão/digest/resultado), sem pacote bruto, segredos ou dados do contato. Registrar ação de instância com escopo de plataforma e ação de organização com org correspondente. Mostrar histórico de operações na gestão e reaproveitar as auditorias existentes de Tarefas; não gerar uma cópia do seu conteúdo em recibos da extensão.

**CONFIRMADO:** `collectExportData` em `lib/lgpd/export-collector.ts` enumera fontes, inclusive `crm_tasks`; `lib/lgpd/redact-cascade.ts` chama a RPC canônica, e `lib/lgpd/cascata.ts` completa redações. O gate `lgpd-cascata-alcanca-quem-guarda-pessoa.test.ts` encontra FK para contacts + nomes de colunas pessoais; JSON genérico sem esse vínculo pode ficar fora do censo.

**PROPOSTO:** o primeiro manifesto/configuração admite somente conteúdo de apresentação, sem dados de contatos e sem copiar tarefas. Retenção do estado de instalação, configuração e operações deve sobreviver à desativação; remoção do pacote não apaga os dados canônicos de negócio. Se forem permitidos campos pessoais, referências a contato ou payloads de execução, o contrato de dados, inventário, exportação, anonimização e gates devem evoluir no mesmo incremento. Não afirmar conformidade só porque a nova tabela não apareceu no censo atual.

## Fixtures de duas organizações e prova futura

- **CONFIRMADO:** `scripts/seed-e2e-tenant-b.ts` cria B com usuário próprio e cenário ativo para testar isolamento entre sessões; `scripts/seed-e2e-duas-organizacoes.ts` cria o outro caso: um mesmo usuário membro de A e B, com dados distintos. São cenários complementares, não substitutos.
- **CONFIRMADO:** `tests/e2e/interface-por-vinculo.spec.ts` cria usuários/orgs isolados e contextos de browser separados; demonstra personalização visível, acesso direto, troca de contexto e limpeza. `tests/invariants/rls-isolation.test.ts` tem seeds A/B e execução como `authenticated` com JWT, útil para o gate de banco.
- **PROPOSTO:** criar fixture própria do piloto com nomes exclusivos, sem disputar slugs de outros seeds; combinar plataforma/admin/agent/viewer, A/B separados e membro das duas. O catálogo deve fornecer o pacote real sem interceptação de rede simulando download; dados sintéticos apenas.
- **CONFIRMADO:** `.github/workflows/e2e.yml` seleciona specs explicitamente; `tests/unit/e2e-cobertura-completa.test.ts` guarda a inclusão. **PROPOSTO:** adicionar a jornada à seleção e ao `docs/testing/user-journey-map.md`, com screenshot/trace, recusas por API e leitura do efeito persistido.

## Fechamento do recorte

**PROPOSTO — laço concreto:** catálogo → admissão/estado local → vínculo de A → hub CRM → conteúdo instalado → Tarefas existente; operação/erro → tela de gestão → correção/retomada → nova resolução. Configuração inválida ou download incompleto deve ter motivo e próximo passo, sem ativação parcial. Registrar as arestas no mapa de arquitetura quando a peça existir.

**Limites desta investigação:** somente leitura e este relatório; nenhum serviço, SQL, fixture ou teste foi executado. Não leu `.env`, arquivos de credenciais ou CRED. A escolha do card é recomendação técnica para reduzir o piloto, sujeita ao contrato final; não é evidência de funcionalidade instalada. O perfil físico de schema independente continua fora deste marco.
