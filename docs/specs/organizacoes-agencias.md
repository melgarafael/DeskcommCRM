# Organizações administradas por agências

## Escopo e destino

Implementação no núcleo: autorização e isolamento de organizações são contratos comuns do CRM. Sem habilitar agência, as organizações continuam usando seus vínculos diretos e a administração global existente. Base inicial da contribuição: `25102672f3082928369db90ed82838d6ea630fc9`; conferir atualização antes de publicar.

A habilitação de agência é independente do plano comercial. O administrador global configura habilitação, limite e inclusão dos clientes no acordo comercial da agência, tanto na criação quanto na edição de uma organização. A agência não altera essas autorizações.

## Uso

1. Na administração global, habilitar a gestão de organizações clientes e definir a cota.
2. O administrador direto da agência usa “Gerenciar organizações” no seletor do topo, ou o card “Organizações clientes” em Configurações.
3. Criar cliente informando nome e identificador. A organização criada é um tenant normal com dados próprios; não é uma empresa do módulo B2B.
4. “Abrir organização” inicia delegação vinculada à pessoa e à sessão autenticada. A faixa do aplicativo identifica a delegação e permite “Voltar à agência”.
5. Usar as telas existentes do cliente para sua operação. A identidade real do operador permanece na auditoria.

## Autoridade e isolamento

Somente membership direto `admin`, aceito e não revogado, de agência habilitada e ativa pode criar e abrir clientes. Funcionários com papel inferior não recebem essa autoridade. Não se cria membership permanente nem linha em `platform_admins` para o operador.

`requireAgencia` reutiliza `requireRole`; as RPCs revalidam o usuário autenticado. `fn_support_context` preserva o acompanhamento global e acrescenta contexto de agência com `agency_id`. Os helpers existentes de papel/RLS consomem esse contexto. A sessão dura até uma hora e perde autoridade se agência, vínculo, cliente, autenticação ou MFA deixarem de permitir o acesso. O encerramento continua permitido depois da revogação.

A auditoria conserva `actor_user_id`, cliente, agência e sessão delegada, inclusive no callback OAuth sem cookie com identidade de state validado. Delegação de agência não é registrada como atuação de administrador global. Depois de sair, um vínculo direto legítimo continua valendo com seu próprio papel.

Criação de convites, alteração de memberships e emissão de tokens permanentes pelo acesso delegado ficam bloqueadas neste primeiro recorte. Há guarda nas rotas de efeito e gatilhos no banco para impedir contorno pelo PostgREST. A aceitação de convite existente exige sair da delegação. O editor detalhado de permissões por função e credenciais delegadas revogáveis ficam para outra etapa. A marca do cliente continua usando o resolvedor por organização; a delegação não altera a marca global.

## Criação, cota e ciclo de vida

`agencia_configuracoes` guarda a autorização protegida. `agencia_clientes` vincula cada cliente a uma única agência. `agencia_sessoes` registra a delegação; `agencia_criacoes` guarda o recibo idempotente por agência, pessoa e chave.

A RPC de criação valida nome, identificador, ator e MFA, trava a configuração e cria organização, vínculo e recibo na mesma transação. O gatilho de hierarquia serializa as mudanças e verifica a cota. Duas criações concorrentes não ocupam a mesma última vaga. Repetir a mesma chave e pedido retorna a organização criada; pedido divergente é recusado.

Organizações suspensas contam. Reduzir a cota abaixo do uso preserva os dados e bloqueia novas criações. Desabilitar ou suspender a agência revoga sua delegação, sem suspender automaticamente os clientes. Excluir agência com clientes e transferir vínculos são recusados; não há exclusão em cascata dos clientes. Cliente não pode tornar-se agência nem administrar outro nível.

O provisionamento global mantém `fn_create_tenant_with_owner` e seu fluxo de responsável/convite. A criação delegada compartilha o schema de campos e as tabelas normais, mas tem RPC própria: chamar a função global com identidade emprestada daria autoridade indevida e deixaria membership permanente. A criação delegada não emite convite.

## Acordo comercial

Com cobrança desligada, a cota autoriza a criação. Com cobrança ligada, a plataforma precisa marcar “Incluir clientes no acordo comercial da agência”. Isso permite criar dentro da cota sem assinatura individual e sem trial de cadastro público. A agência não escolhe isenção por API ou pelo formulário.

Preço, porcentagem e repasse são negociados separadamente nesta etapa. O recurso não calcula comissão nem executa cobrança automática por cliente. Desmarcar a inclusão impede novas criações com cobrança ativa; não inventa dívida nem modifica contratos existentes.

## Self-host e migrations

As migrations de agências têm cabeçalho `-- manifest:` e apêndices no baseline. Na contribuição separada, elas foram renumeradas para 9200–9205: a `main` ocupa 9105–9108 e a consulta pública dos PRs abertos encontrou 9109–9114 em uso. A numeração não colide com a `main` medida em `7321fb9ba`; como a API pública do GitHub atingiu o limite durante a varredura completa, os PRs abertos precisam ser conferidos novamente imediatamente antes de publicar. As migrations já aplicadas no Supabase de teste permaneceram intactas na árvore principal. Não houve alteração na VPS nem uso de Docker.

## Provas e pendências

Medição local em 04/11/2026, sem Docker e sem alteração de produção:

- `tests/invariants/agencias.test.ts`: 19 casos aprovados no Supabase de teste autorizado e novamente em banco descartável instalado pelo baseline final. Incluem concorrência em duas conexões, isolamento de leitura/escrita, cota, suspensão, revogação, sessão Auth expirada, hierarquia, memberships, callbacks e vínculo direto. Fixtures são revertidas ou removidas por seus UUIDs próprios.
- Baseline final instalado em banco vazio, reaplicado e exercitado pelos 19 casos: aprovado. O bootstrap usa os stubs de `scripts/test-db.sh`; isso não equivale ao kit VPS inteiro nem à suíte oficial `test:db`/`test:db:update`.
- Atualização do baseline upstream com dados legados e preservação de organizações, contato e vínculo: aprovada antes do último ajuste de validação da sessão Auth. A reaplicação do baseline final também foi aprovada em banco descartável existente.
- Jornada em navegador real contra o servidor local e Supabase de teste: habilitar agência, criar cliente, abrir, voltar, abrir novamente, desabilitar na plataforma, recusar a sessão aberta e voltar: aprovada. As quatro capturas permanecem locais; não devem publicar a marca da instalação junto à contribuição.
- `tests/e2e/agencias-organizacoes.spec.ts` registra a jornada para o ambiente oficial e está na matriz E2E. Essa spec oficial ainda não foi executada no ambiente fresco completo de Supabase Auth/Storage; a prova local acima usou um roteiro separado.
- TypeScript e build de produção do código final: aprovados. Lint dos arquivos da contribuição, `lint:channels` e `lint:role-rank`: aprovados.
- Bateria focada final: 100 casos aprovados em 13 arquivos, cobrindo schema, efeitos delegados, invalidação do cache curto de autorização, auditoria, navegação, idempotência, UUID, baseline e cobertura da spec E2E.
- A execução integral de unitários terminou com 2.803 arquivos aprovados, 46 reprovados e um ignorado (30.420 casos aprovados e 201 reprovados, antes das correções focadas). Portanto não constitui um gate verde. Registrou falhas em scripts de shell, caminhos e outras cercas no Windows. As falhas da contribuição detectadas em ordem do baseline, expressão de UUID da auditoria e `randomId()` foram corrigidas e os testes correspondentes passaram. Também foram atualizados o contrato do catálogo (a porta de agência não pertence ao menu comum) e o registro de idempotência da nova rota; 25 casos dos dois arquivos de interface e 21 casos do registro de fronteiras passaram após esses ajustes. Não atribuir todas as demais falhas ao ambiente sem confirmar individualmente.

`vitest.agencias.config.ts` permite executar apenas essa suíte com `AGENCIA_TEST_DB_URL`; a credencial deve vir do ambiente, nunca de arquivo versionado ou da saída de um comando. Nenhum valor de segredo compõe esta contribuição.

Os tipos de schema foram gerados com o `@supabase/postgres-meta` oficial contra um banco descartável criado pelo baseline final; o arquivo preserva os contratos já presentes na `main` e incorpora somente as tabelas e funções desta entrega. Ainda pendentes para fechar a régua integral do mantenedor: executar a spec E2E no ambiente oficial com Supabase local e conferir colisões contra PRs abertos imediatamente antes de publicar. A jornada equivalente foi provada em navegador real contra o Supabase de teste, mas não substitui o check E2E obrigatório do CI. Não há PR publicado. As alterações independentes de Studio visual na árvore principal não integram a contribuição de agências.

## Living System Checklist

- Entrada: configuração global pelo formulário e `CardDeAgencia`.
- Saída: criação via `/api/v1/agencia/clientes` e operação normal do cliente.
- Registro: `audit()` com ações `agency.client_created`, `agency.session_started`, `agency.session_ended`; configuração usa `org.updated`.
- Superfície: lista de clientes e auditoria existente em `/app/audit`.
- Porta: `TenantSwitcher` e card do catálogo em Configurações.
- Próximo passo: cota atingida orienta pedir aumento; erro permite tentar novamente com chave idempotente.
- Configuração: habilitação, limite e acordo comercial na administração global.
- Continuidade IA/humano: a delegação não cria automação de IA nem altera os fluxos existentes.
- Retorno: erro não cria cliente parcial; sessão inválida perde acesso e oferece saída.
- Mapa: `docs/architecture/organizacoes-agencias.architecture.json`.
