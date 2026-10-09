# Plano de execução — pendências de pagamento e avisos locais

Status (retomada em 07/10/2026): foi encontrada colisão no número da migration 0540 e lacunas na retomada após pausa, na troca de destino/canal e na forma como o histórico descreve o aceite do envio. A correção está em andamento, incluindo cadência editável dos avisos (padrão 3/6/9, configurável de 1 a 10 marcos entre 1 minuto e 24 horas). A mesma cadência se aplica à Central e aos reforços de WhatsApp; o opt-in do WhatsApp continua separado e desligado por padrão. A validação desta rodada será focada e limitada a 10 minutos; sem banco remoto, Docker, build ou WhatsApp real.

Status (retificado em 06/10/2026): implementação presente no checkout, mas ativação remota não comprovada. O registro cronológico mais recente deste arquivo diz que as migrations 0535–0538 ainda não tinham sido aplicadas, o preflight via a tabela/colunas novas ausentes e o `test:db` integral precisava ser repetido. Imagens `payment-20261004` foram preparadas para QA, sem evidência de troca das imagens em uso. Não há verificação atual do banco neste registro.
Data: 04/10/2026.

Esta retificação substitui a afirmação anterior de “ativação concluída” no cabeçalho, que não é sustentada pelas atualizações cronológicas abaixo. A confirmação independente da Bia v5 ativa e da janela 00:00–24:00 no plano de correções do atendimento não comprova a publicação do fluxo financeiro nem do follow-up pós-dados.

## Ativação concluída — 05/10/2026

- Backup completo autorizado e validado antes da mudança, no destino protegido descrito abaixo.
- Migrations 0535–0538 aplicadas ao Supabase `kwmwkrrpzmfrwkednoyl` em transação única, com validação de schema, RLS, funções e triggers após o commit.
- App, worker e scheduler locais usam as imagens `payment-20261004`, estão saudáveis e o endpoint de saúde respondeu HTTP 200.
- Bia v4 publicada e sem rascunho pendente. Dry-run do pedido de chave Pix sem compra identificada perguntou qual pedido será pago; nenhuma mensagem real foi enviada.
- Follow-up “Pagamento — retomar após envio dos dados” ativo e republicado. O código inicia a inscrição somente após recibo aceito do envio oficial e bloqueia pagamento confirmado, conferência pendente, resposta da cliente ou compra encerrada. O grafo espera 5 minutos e depois mais 5 minutos.
- Build, typecheck, lint, shell e testes dirigidos passaram. A primeira suíte integral de banco teve 368 arquivos aprovados de 370; as duas falhas eram lacunas nos scanners de governança, corrigidas e aprovadas em repetição dirigida (4 arquivos, 119 testes). Uma repetição integral do banco foi iniciada, mas seu resultado ainda não foi confirmado neste registro. Sem contato real, o aceite de ponta a ponta no WhatsApp segue pendente.

## Preflight de ativação — primeira tentativa, 04/10/2026

Execução iniciada a pedido do usuário e **interrompida antes de alterar a instalação ou o banco**. O código da funcionalidade continua apenas na árvore de trabalho, junto de modificações independentes de autenticação, na branch `codex/auth-confirmation-fix` (`901a17fe2`); não há build publicado desta implementação. A suíte unitária completa e a suíte shell completa ainda não passaram no Windows, como registrado abaixo. Isso impede tratar os gates de release como aprovados.

- `docker ps --format ...` no sandbox: acesso negado ao Docker API (`npipe:////./pipe/docker_engine`). A tentativa de consulta somente leitura com permissão elevada foi recusada **antes de executar** porque a revisão automática atingiu o limite de uso. Não houve inspeção nem mudança nos serviços Docker.
- `Invoke-WebRequest http://localhost:3000/login`: HTTP 200, prova somente que a tela local responde; não identifica app/worker/relógio nem versão em execução.
- `supabase/.temp/project-ref`: ausente. O conector Supabase lista dois projetos (`Diagnóstico Escla e lucro`, inativo; `DisparoZapCRM`, ativo), sem vínculo comprovado com esta instalação. Nenhum foi escolhido como destino. Nenhuma migration foi consultada ou aplicada remotamente.

Condição de parada do plano: **alvo do banco e estado da instalação incertos, além de gates completos pendentes**. Não repetir a tentativa de permissão por outro caminho, não aplicar as migrations `0536`–`0538`, não ligar avisos e não publicar uma Bia que dependa do contrato novo até obter diagnóstico e procedimento de verificação. Próximo responsável: usar um modelo mais forte para identificar com segurança o destino e a topologia, concluir os gates em Linux/CI e preparar a publicação da implementação sem incluir as alterações independentes de autenticação. Depois disso, retomar pelo preflight e conferir backup/recuperação antes das migrations.

## Retomada com modelo 6.1 — 04/10/2026

Retomada explicitamente autorizada pelo usuário após a troca de modelo. O diagnóstico identificou a instalação Docker `bia-local`, composta por app, worker, scheduler, WAHA, Redis e SRH. Os serviços estavam saudáveis. O banco real é o projeto Supabase `kwmwkrrpzmfrwkednoyl`, Postgres 17.11; não é nenhum dos dois projetos retornados pelo conector. O papel de manutenção/worker é `postgres`. Histórico `supabase_migrations.schema_migrations` ausente é compatível com esta instalação por baseline e não autoriza escolher outro projeto.

- Preflight somente leitura: zero casos ativos e zero jobs pendentes/em execução; funções pré-requisito presentes, `case_stale` autorizado pela Central, RLS nas tabelas existentes. As colunas novas de pagamento e `before_send_traces.tipo_envio` ainda estavam ausentes. A diferença de migrations entre o fonte da imagem antiga e o HEAD exige `0535`, além das `0536`–`0538` da funcionalidade.
- Backup completo autorizado explicitamente pelo usuário, incluindo dados de clientes, em `C:/Users/Atlas ADS/.codex/visualizations/2026/10/04/01a106ba-def5-77c2-b0e8-f056ae6a9ae0/payment-activation/backup/db-before.dump`. ACL restrita ao usuário local e SYSTEM. `pg_restore --list` e leitura integral do arquivo para `/dev/null` concluídos. SHA-256: `AF1048B31BC9472EF9370DB788B1E76C035A613C76E495060A2A4A5F342210B2`. Não publicar nem anexar o conteúdo.
- Incidente na primeira tentativa de dump: uma URL de conexão com senha apareceu no retorno técnico do utilitário. O usuário foi informado e decidiu explicitamente manter a senha atual em 04/10/2026. O runner foi corrigido para normalizar aspas e ocultar URLs; não registrar nem repetir o valor da senha. Nenhuma alteração de banco ocorreu nessa tentativa.
- Fonte isolado: HEAD `901a17fe2` mais arquivos de pagamento, excluindo dez alterações independentes de autenticação. Snapshot em `payment-activation/source`; sem arquivos de credenciais e sem alterações nas sessões WAHA. Imagens locais provisórias de validação seguem a exceção documentada em `docs/runbooks/deploy.md` §4; não são uma release publicada pelo CI.
- Suítes integrais unitária, shell e verificações estáticas estão em execução no Linux com histórico Git real e dependências iguais às da imagem. Não considerar o gate aprovado antes do resultado.
- A aplicação das quatro migrations está preparada em uma única transação, com timeout de lock, instalação sem jobs ativos, validação de tipos/RLS/permissões/triggers antes do commit e rollback integral em erro. Ainda não executada.
- Bia publicada v3; rascunho v4 em revisão para tarefas estruturadas e envio direto aprovado pela equipe. Cinco dry-runs anteriores, sem mensagem WhatsApp, evidenciaram promessas de retorno/conferência sem ação correspondente. Publicação depende do antes/depois e do runtime atualizado. O fluxo pós-dados também precisa perder a dependência de tag como prova de envio; o recibo durável passa a iniciar a inscrição.

### Ponto de retomada para Luna

O Luna pode executar as etapas operacionais já definidas aqui. As falhas da primeira passada foram analisadas pelo modelo forte e as duas lacunas de mock/declaração do teste já foram corrigidas, sem alterar o comportamento de produção. O cron genérico agora tem teste para garantir que exclui tarefas com relógio de 3/6/9 minutos. O consumidor do recibo agora está incluído no contrato de consumidores.

Ainda há gates pendentes: a rodada integral unitária não terminou; os scanners estáticos dependem de GNU grep e do checkout completo, e precisam de evidência depois de finalizada a rodada. O ambiente Linux atingiu limites de recursos e expirou timeouts de alguns scanners na primeira passada. Não avançar para migration/publicação até os gates aplicáveis ficarem verdes. Rodar de novo apenas os testes afetados após concluir a suíte atual e preservar seus logs.

Na checagem read-only mais recente (04/10, 22:58 UTC), a suíte reportava 1.149 arquivos, 1.142 aprovados e sete com falha, sem `unit.exit`. Diagnósticos: mock do filtro `.is()`, declaração do novo consumidor no teste organizacional, BusyBox `grep` na primeira passada e timeouts por carga para duas sondas. GNU `grep` foi instalado no contêiner efêmero QA após a primeira passada; portanto a saída inicial dessas sondas precisa ser repetida nesse ambiente corrigido. Os arquivos de teste atualizados no workspace ainda não foram propagados para o snapshot QA. O worker e scheduler foram construídos localmente. O app compilou com sucesso pelo Next e concluiu `runAfterProductionCompile`, mas ficou sem saída na checagem de TypeScript após o Docker Desktop começar a retornar HTTP 500; o cliente da build foi cancelado e a imagem final não foi confirmada.

Antes do schema, repetir o preflight não mutante e conferir que o alvo é `kwmwkrrpzmfrwkednoyl`, as quatro migrations necessárias continuam ausentes, a instalação está sem casos/jobs ativos e o backup permanece válido. Aplicar as migrations numa única transação curta com pré e pós-condições, como no runner preservado no artefato local. Parar diante de qualquer erro, divergência ou resultado incerto de commit; não repetir às cegas nem improvisar correções. O rascunho da Bia é v4; não publicar até haver runtime atualizado e uma comparação de antes/depois visível ao usuário. O usuário decidiu manter a senha atual; rotação não é condição para seguir.

## Objetivo e escopo autorizado

Operar o aplicativo local com dados no Supabase, mantendo a Bia no atendimento enquanto a equipe fornece dados oficiais e confere pagamentos. Cada tarefa pendente recebe avisos internos aos 3, 6 e 9 minutos. Uma decisão humana, o envio à cliente e a conclusão da tarefa são fatos separados.

Este documento organiza a execução. Não publica agentes, não ativa avisos, não envia mensagens nem aplica mudanças no banco. As alterações locais já existentes de autenticação e testes estão fora deste serviço e devem ser preservadas.

## Regra obrigatória para execução com Luna

O Luna pode executar as etapas já definidas neste plano. Deve **parar e avisar para trocar para um modelo mais forte** se ocorrer qualquer uma destas situações:

- Erro ao aplicar uma migration, inclusive execução parcial ou dúvida sobre quais alterações foram aplicadas.
- Divergência entre o banco da instalação e o schema esperado: histórico de migrations, tabelas, colunas, funções, constraints, RLS ou permissões.
- Necessidade de alterar código, criar uma migration corretiva ou mudar o plano para contornar uma falha.
- Falha de verificação que impeça o aceite da etapa e não tenha uma solução operacional já documentada. As limitações conhecidas registradas neste plano não autorizam ignorar gates antes da ativação.
- Dúvida sobre o banco de destino, preservação dos dados ou procedimento de recuperação.

Ao parar, suspenda as operações seguintes que dependem da etapa com problema. Preserve o estado e as evidências; não tente correções improvisadas, não edite migrations já aplicadas e não use reset, exclusão de dados ou execução forçada para fazer a atualização passar. Não repita uma migration sem confirmar o resultado da tentativa anterior.

Registre neste plano a etapa, o comando ou ação executada, o erro completo sem segredos nem dados pessoais, o que foi concluído e o que permanece pendente. Se houver aplicação parcial, informe isso explicitamente. Avise o usuário com uma mensagem como:

> Interrompi em [etapa] porque encontrei [erro ou divergência]. Já foi concluído [resumo]; permanece pendente [resumo]. Troque para um modelo mais forte para analisar este diagnóstico antes de retomar.

Retome a etapa bloqueada somente depois da troca de modelo, da análise do diagnóstico e da definição de um procedimento de correção e verificação. Não marque a etapa como concluída enquanto o problema permanecer.

## Requisitos confirmados

- Aplicativo local; Supabase como banco. Não exigir domínio público para um aviso interno sem link.
- Duas tarefas distintas: fornecer dados oficiais de Pix/cartão e conferir recebimento.
- A equipe confirma dados e recebimento por ações claras na tela.
- Avisos aos 3, 6 e 9 minutos desde o início da espera por uma ação da equipe, e não três intervalos acumulados.
- Assumir, abrir, comentar ou atualizar a tela não zera esse relógio.
- Ao chegar aos 9 minutos, a tarefa continua visível como atrasada até resolução.
- Não confundir esses avisos com os follow-ups enviados à cliente.
- A IA não presume pagamento confirmado a partir de comprovante.

## Evidências da análise inicial (antes da implementação)

| Comportamento existente                                         | Fonte                                                                       | Consequência                                                                  |
| --------------------------------------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Resposta humana genérica: concluir, pedir informação ou escalar | `app/app/ai/cases/_components/CaseReplyPanel.tsx`, `lib/ai/case-copy.ts`    | Faltam ações e campos estruturados de pagamento                               |
| Concluir fecha o caso e enfileira a resposta em uma transação   | `app/api/v1/ai/cases/[id]/reply/route.ts`                                   | O caso pode estar fechado antes de a mensagem sair                            |
| O processamento da resposta chama o turno da IA para enviar     | `lib/agent-engine/agent/case-reply-turn.ts`                                 | Repassar dados exatos precisa de um contrato próprio de envio                 |
| Um caso ativo por conversa impede outra abertura                | `lib/agent-engine/agent/human-cases.ts`                                     | Comprovante recebido com chamado anterior aberto exige continuidade explícita |
| Atribuição de conversa não é atribuição de caso                 | UI, tipos e consultas de casos                                              | Assumir tarefa não deve retirar a conversa da Bia                             |
| Verificador cobra após 24h usando `updated_at`                  | `app/api/v1/cron/case-stale-watcher/route.ts`                               | Não atende à cadência pedida nem à regra de não reiniciar por comentários     |
| Agendamento desse verificador é horário                         | `docker/scheduler/entrypoint.sh`                                            | Trocar apenas 24h por 3min não basta                                          |
| Os caminhos locais analisados não incluem esse verificador      | `scripts/dev-crons.ts`, `lib/relogio/executar.ts`, `lib/relogio/tarefas.ts` | É necessário ligar e provar o processamento local                             |
| URL pública bloqueia ativação e envio do aviso                  | `lib/escalacao/estado-do-aviso.ts`, `lib/escalacao/aviso-ao-suporte.ts`     | Modo sem link deve chegar à tela, ao servidor e ao teste de envio             |

Essas evidências são do código, não uma prova da execução atual dos processos ou da entrega real no WhatsApp.

## Contrato implementado

1. Cliente escolhe Pix/cartão; o agente registra a tarefa de fornecer os dados oficiais para a compra identificada.
2. A equipe assume a tarefa. Outros atendentes veem o responsável; concorrência não permite dois responsáveis simultâneos. A Bia continua dona da conversa.
3. A equipe revisa os dados e usa “Liberar dados para envio”. A decisão é registrada e o envio é enfileirado; a tela mostra “Envio pendente”.
4. Só após confirmação de envio a tarefa de dados termina. A equipe pode escolher um fluxo publicado no campo `post_delivery_pointer_id` ao liberar os dados. O evento `ai.case_task_delivery_confirmed` inicia esse fluxo após revalidar recibo aceito, compra aberta, origem do atendimento e ausência de resposta posterior ou conferência pendente. Falha mantém uma pendência com motivo e ação de recuperação. Confirmação técnica de envio não será apresentada como leitura da cliente.
5. Se a cliente informar pagamento, a cobrança à cliente para imediatamente. A pendência passa a ser conferência, mesmo se a tarefa anterior não tiver sido concluída. O histórico anterior permanece; não gerar um segundo caso ativo que o motor recusaria.
6. A equipe usa “Pagamento confirmado”, “Não localizado” ou “Pedir informação”. O resultado financeiro registrado não depende de a IA conseguir comunicá-lo. Falha de comunicação vira uma pendência própria de envio.
7. “Não localizado” nunca vira declaração de que a cliente não pagou. A próxima ação precisa estar registrada. Uma nova conferência tem seu próprio início de espera.

O vínculo é `agent_cases.lead_id`, validado contra a organização e o contato da conversa. Compra ambígua fica pendente de identificação pela equipe, sem liberar dados ou confirmar pagamento. O caso ativo continua por fases `payment_details` e `payment_review`. A aprovação humana, o job de entrega e o recibo do canal são fatos separados; título, nota e tag não confirmam recebimento. Gestor pode reassumir uma tarefa sem reiniciar a espera.

Atualização de 08/10/2026: os lembretes de **3/6/9 minutos** valem para todos os casos que aguardam a equipe na Central. Uma opção administrativa separada, `config_aviso_de_caso.repetir_lembretes_whatsapp`, permite enviar esses mesmos marcos ao WhatsApp interno configurado; começa desligada e não altera o aviso opcional de abertura. O reforço usa um recibo por organização/caso/geração/patamar/destino e nunca é enviado à cliente. Enquanto o caso aguarda resposta do cliente, o relógio pausa; quando ele responde, começa novo episódio. Se a execução voltar atrasada, apenas o marco atual pode sair. No modo `sem_link`, ausência de endereço público não impede o aviso; a resolução continua no computador. Esse modo não torna o aplicativo local acessível pela internet.

## Etapas de execução

### 0. Fechar o desenho e os pontos de integração

- [x] Ler integralmente a doutrina atual antes das alterações e revisar os contratos de caso, canal, fila e envio.
- [x] Identificar o vínculo real de oportunidade/compra e o ponto que registra sucesso/falha do envio.
- [ ] Verificar como os processos locais iniciam e como mostrar sua saúde sem depender de aba aberta.
- [ ] Definir dados oficiais reutilizáveis, campos necessários para Pix/cartão e visibilidade por papel.
- [x] Definir destinatários dos avisos: Central como registro obrigatório; WhatsApp como canal opcional configurado. Não disparar para todos os atendentes indiscriminadamente.
- [x] Registrar decisão sobre reaproveitar caso com fases/tarefas; só então nomear campos e migrations.

Aceite: transições, autoridade humana e fontes de verdade descritas antes de escrever o schema.

### 1. Estado durável e concorrência

- [x] Adicionar estado da tarefa, responsável, início da espera, decisão humana e referência do envio conforme o desenho aprovado.
- [x] Atribuir/liberar/transferir com atualização condicional e conflitos claros.
- [x] Registrar identidade de quem decidiu e histórico das mudanças.
- [x] Garantir vínculo com organização, conversa e compra, incluindo permissões da equipe.
- [x] Criar migration nova com `-- manifest:` e apêndice idempotente em `supabase/baseline.sql`; não editar migrations aplicadas nem tipos gerados manualmente.

Pontos principais: `lib/agent-engine/agent/human-cases.ts`, `lib/escalacao/chamados.ts`, rotas em `app/api/v1/ai/cases/`, schema e testes de invariantes.

Aceite: dois atendentes ou duas instâncias não duplicam responsabilidade, decisão ou envio; nenhuma leitura/escrita cruza organizações ou visibilidade permitida.

### 2. Ações na tela e continuidade com a Bia

- [x] Exibir tarefa, compra, responsável, idade da espera e próximo passo.
- [x] Implementar ações específicas e campos validados; não esconder efeitos em um “Concluí” genérico.
- [x] Separar liberação, envio pendente, envio confirmado e falha.
- [x] Registrar conferência positiva/negativa/pedido de informação de forma estruturada.
- [x] Tratar comprovante durante tarefa de dados aberta sem perder a demanda.
- [x] Preservar comportamento dos casos genéricos e handoff existentes.

Pontos principais: `CaseList.tsx`, `CaseDetail.tsx`, `CaseReplyPanel.tsx`, `hooks/ai/useCases.ts`, `lib/ai/case-copy.ts`, rota de resposta, `case-reply-turn.ts` e consumidor real de envio.

Aceite: uma pessoa conclui cada tarefa pela tela e consegue distinguir uma decisão registrada de uma mensagem enviada.

### 3. Lembretes aos 3, 6 e 9 minutos

- [x] Usar início da espera da tarefa; não usar `updated_at` como relógio comercial.
- [x] Registrar cada patamar de forma durável, única e auditável.
- [x] Verificar a pendência novamente antes de enviar; cancelamento/conclusão impede aviso atrasado.
- [x] Manter um item claro na Central, atualizando nível/horário sem empilhar duplicatas.
- [x] Incluir a tarefa no processamento local e no agendador self-host com cadência adequada.
- [x] Se o computador parar, retomar pendências sem mandar de uma vez todos os avisos vencidos; registrar atraso e aplicar regra explícita de recuperação.
- [x] Mostrar tarefa atrasada após 9 minutos; não apagar nem resolver por silêncio.
- [x] Preservar a política existente para casos gerais; cadência de pagamento não vira mudança global silenciosa.
- [x] Implementar opt-in separado para reforços no WhatsApp da equipe, com recibo por organização/caso/geração/patamar/destino e desligado por padrão.
- [x] Mostrar abertura e marcos de 3/6/9 na lista de entregas; cobrir opt-in independente, tarefa encerrada, patamar atual, atraso e deduplicação em testes.

Pontos principais: verificador de casos ou módulo de tarefa compartilhado, `lib/relogio/`, `scripts/dev-crons.ts`, `docker/scheduler/entrypoint.sh`, consumidor de avisos e Central.

Aceite: não há aviso precoce, repetido, para cliente ou depois da resolução; assumir/comentar não adia a cobrança. Os prazos são alvos sujeitos à cadência e à disponibilidade, com atraso visível.

### 4. Aviso interno no modo local

- [x] Opção explícita “Sem link — resolver neste computador”, sem inventar domínio ou expor o CRM na internet.
- [x] Alinhar validações da tela, API, banco, envio e teste de aviso.
- [x] Incluir referência compreensível do caso e instrução de onde abri-lo.
- [x] Preservar limites do canal, aquecimento, estado da conexão, tentativas e falhas visíveis.
- [ ] Registrar destinatário(s) autorizados; ativar/testar envio real somente no escopo autorizado pelo usuário.

Pontos principais: `lib/escalacao/{estado-do-aviso,tela-do-aviso,texto-do-aviso,aviso-de-teste,aviso-ao-suporte}.ts`, UI de avisos, rotas de alerta e função de configuração no banco.

Aceite: ausência de domínio não bloqueia o modo sem link; modo com link continua validando endereço. Falta de conexão ou destinatário continua tendo explicação.

### 5. Configuração da Bia e validação completa

- [ ] Adaptar o prompt ao contrato implementado, removendo a obrigação de abrir caso separado quando já houver pendência ativa.
- [x] Retomada da cliente inicia somente após envio confirmado; comprovante interrompe cobranças sem confirmar recebimento.
- [ ] Testar em par: atendimento pelo agente e ferramenta chamada diretamente com a mesma entrada.
- [x] Testar 3/6/9 com relógio controlado, incluindo atraso, resolução, opt-in e idempotência (`tests/unit/aviso-de-caso-lembretes-whatsapp.test.ts`).
- [ ] Fazer prova real na instalação atualizada; depende de aplicar o schema e subir a imagem no próximo passo. Nenhum WhatsApp real foi enviado nesta etapa.
- [x] Provar pela tela e guardar evidência visual na bancada local.
- [x] Typecheck completo (`tsc --noEmit -p tsconfig.typecheck.json`), lint direcionado e testes focados de envio/configuração passaram.
- [x] Testes estáticos de migration/baseline passaram (13 testes em 3 arquivos).
- [x] Lint completo (`eslint .`, comando do script `pnpm lint`) terminou com zero erros; o repositório reportou 487 avisos.
- [ ] Rodar os gates de banco/RLS, E2E e shell aplicáveis antes de declarar a release validada; `test:db`/E2E não foram executados para manter Docker intocado.
- [x] Atualizar mapa de arquitetura e jornadas; registrar limites do que foi medido.

Casos obrigatórios: dois atendentes assumindo/respondendo juntos; duplo clique; falha no envio dos dados; comprovante com caso anterior aberto; conferência não localizada; nova conferência; conclusão no instante do aviso; comentário que não reinicia tempo; desconexão e limite de canal; aplicativo reiniciado; duas instâncias compartilhando banco; permissões e isolamento; casos genéricos sem regressão.

## Checklist de arquitetura

- Entrada: `openPaymentTask`, `applyCaseTaskAction` e `fn_processar_lembretes_tarefa` recebem, respectivamente, pedido do agente, decisão humana e passagem de tempo.
- Saídas: `case-task-delivery.ts` entrega o texto aprovado; `apos-dados-confirmados.handler.ts` consome o recibo; `agent_inbox_items` recebe a pendência interna.
- Registro: `agent_case_events`, `job_queue`, ledger de envio e `audit()` na API de tarefa registram decisão, tentativa e resultado.
- Tela/porta: `PaymentTaskPanel.tsx` no detalhe de Casos; `AvisoNoWhatsApp.tsx` e Central pela navegação existente.
- Anti-esquecimento: `case_task_reminders`, cron `case-task-reminders` e scheduler mantêm patamares 3/6/9 e atraso persistente, inclusive após reinício.
- Configuração: `config_aviso_de_caso.sem_link` e escolha explícita `post_delivery_pointer_id`; nenhum destinatário ou fluxo é ativado automaticamente.
- Continuidade: equipe decide; worker envia texto aprovado; Bia continua atendendo; envio aceito alimenta o acompanhamento escolhido.
- Laço de retorno: `send_failed` aparece no painel, permite tentar novamente a mesma aprovação e mantém a decisão financeira. A recuperação de job morto reconcilia o ledger antes de concluir.
- Mapa: `docs/architecture/tarefas-de-pagamento.architecture.json` declara entrada, entrega, Central e consumidor pósdados.

## Controle de execução e retomada

Ao terminar cada etapa, atualizar as caixas deste arquivo e registrar: arquivos alterados, testes executados e resultados, evidências, limitações e próximo passo. Uma etapa só fica concluída com seu aceite medido. Nenhuma configuração de prompt substitui uma transição durável ou confirmação de envio.

### Implementação registrada

- Schema: migrations `0536` (aviso sem link), `0537` (tarefas, decisão, vínculo, recuperação e LGPD) e `0538` (recibos e lembretes). Blocos correspondentes no baseline; tipos regenerados pelo banco de teste.
- Tarefa e entrega: `lib/agent-engine/agent/case-task-schema.ts`, `case-task.ts`, `case-task-delivery.ts`, `payment-review-followup.ts`, integração de `human-cases.ts` e `case-reply-turn.ts`; API `app/api/v1/ai/cases/[id]/task/route.ts`.
- Tela: `PaymentTaskPanel.tsx`, `CaseDetail.tsx`, `hooks/ai/useCaseTask.ts` e consultas de casos. Texto oficial revisado por tarefa; não foi criado um cadastro compartilhado de chaves ou links reutilizáveis.
- Relógio: `lib/escalacao/lembretes-tarefa.ts`, cron `case-task-reminders`, `lib/relogio/`, `scripts/dev-crons.ts` e scheduler. O vigia de 24 horas exclui essas tarefas e preserva casos gerais.
- Retomada pósdados: `lib/followup/apos-dados-confirmados.ts`, handler e registry do `event_log`. Matrícula e recibo são atômicos. Reentrega não reinicia fluxo concluído; acompanhamento ativo existente não é substituído. Uma decisão humana durável `payment_confirmed` impede matrícula atrasada e cancela a retomada da mesma compra/conversa, inclusive se o aviso ao cliente falhar ou a tarefa terminar sem marcar a compra como ganha no CRM.
- Modo local: validação e texto `sem_link` na configuração, API, teste e consumidor de avisos. Isso não configura destinatário nem liga o envio automaticamente.
- Reforços WhatsApp e cadência configurável: migration `20261007172316_0580_configuracao_de_cadencia_de_lembretes_equipe.sql` e apêndice idempotente no baseline; opção separada na tela/API, default desligado, marcos editáveis (padrão 3/6/9), eventos no `event_log`, envio pelo handler existente e recibos identificados por marco. Testes dirigidos passaram; schema remoto, imagem nova e envio real seguem pendentes.

### Evidência disponível e limites

Validação dirigida concluída em 04/10/2026:

| Verificação         | Resultado e alcance                                                                                                                                                                                                                                                        |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Typecheck           | `tsc --noEmit -p tsconfig.typecheck.json`: exit 0, incluindo testes.                                                                                                                                                                                                       |
| Compilação          | `next build`: exit 0 com a configuração local de E2E, após a correção financeira final.                                                                                                                                                                                    |
| Lint                | Árvore de produto sem erros; verificação final dos arquivos financeiros e E2E sem erros. `lint:channels`, `lint:role-rank` e conferência de release aprovados. Avisos preexistentes do lint permanecem.                                                                    |
| Unitários dirigidos | 204 testes nas 11 suítes de relógio, matrícula, cron, avisos, UI e guardas. Sondas de auditoria/permissão e os 209 testes de mapa de arquitetura também passaram.                                                                                                          |
| Banco               | 49 cenários nas seis suítes financeiras, avisos, relógio e casos gerais, consolidados entre a rodada completa e a repetição final da entrega. Install e update do baseline aprovados. PostgreSQL descartável; somente o transporte externo é simulado na prova de entrega. |
| Scheduler           | `tests/shell/scheduler-entrypoint.test.sh`: exit 0, incluindo registro do novo cron e preservação literal do segredo.                                                                                                                                                      |
| Tela                | Dois testes Playwright aprovados: salvar/recarregar modo local sem link; assumir, revisar dados e registrar conferência. Aplicativo de produção e Supabase local reais; nenhuma mensagem real enviada.                                                                     |

Evidências visuais: `evidence/casos-vivos/chat/60-painel-pagamento.png`, `evidence/casos-vivos/chat/62-painel-conferencia.png` e `evidence/casos-vivos/aviso/70-modo-local-salvo-sem-envio.png`.

A prova visual final usou o Node 24.21 disponibilizado pelo runtime do Codex e servidor de teste iniciado separadamente, mantendo testes, fixtures e teardown do Playwright. Com o Node 24.11 desta máquina houve falha de libuv ao encerrar, depois de ambos os testes aprovados; o gerenciador automático do servidor também deixou processos aguardando encerramento no Windows. A repetição com o runtime mais recente saiu com código 0. A limpeza canônica das sessões de teste foi executada e o projeto Supabase `bia-payment-qa` foi parado.

A suíte unitária completa não foi aprovada: a execução acumulou falhas de comandos shell, caminhos com espaços, permissões de Git e esperas de infraestrutura, e foi interrompida. A suíte shell completa também não passou neste Windows, por ausência de `python3` no Git Bash e diferenças de permissões de arquivo. Esses resultados não são apresentados como gates verdes; a conferência completa em Linux/CI permanece pendente.

Nenhuma migration foi aplicada ao Supabase remoto nesta execução. Não houve envio real à equipe ou à cliente, ativação de avisos nem publicação de uma nova Bia. A configuração da instalação permanece um passo separado.

O fluxo selecionado após os dados usa suas condições publicadas. Não há tag, etapa ou ID de loja codificado no núcleo. Antes da ativação, revisar o fluxo existente se depender de uma tag que só o prompt antigo criava. Sem fluxo selecionado, a entrega termina a tarefa e não matricula uma retomada.

Próximo passo: conferir a suíte completa no ambiente suportado, atualizar a instalação e o banco pelo processo de atualização, revisar o prompt publicado da Bia e configurar os avisos e o acompanhamento pósdados. Prova com canal real e prova em par do agente permanecem pendentes. O computador precisa manter aplicativo, worker e relógio em operação; 3/6/9 são patamares de elegibilidade sujeitos à cadência e à disponibilidade do processo.

### Instruções financeiras para a próxima versão da Bia — rascunho

Ao precisar de dados oficiais de Pix ou cartão, use `open_human_case` com `task_kind=payment_details`, título, resumo e motivo da dependência humana. Informe no resumo a forma escolhida e a compra em discussão. Não invente chave, beneficiário, conta ou link. Se a forma ainda não foi escolhida, pergunte à cliente antes de solicitar dados à equipe.

Quando a cliente disser que pagou ou enviar comprovante, use `task_kind=payment_review`. O sistema continua a pendência ativa compatível; não resolva o caso anterior para forçar uma segunda abertura. Comprovante recebido significa que a equipe precisa conferir, não que o dinheiro foi recebido. Continue atendendo enquanto essa tarefa estiver pendente.

Se a equipe pedir informações adicionais e a cliente responder, registre a informação real em `provide_case_update` para o caso daquela conversa. Não confirme pagamento por conta própria e não encerre uma tarefa financeira pela ferramenta genérica de resolução.

A equipe revisa e aprova o texto financeiro; o worker o envia diretamente. Não duplique essa comunicação nem prometa que ela foi entregue antes do resultado do envio. A confirmação humana interrompe o acompanhamento daquela compra mesmo se a comunicação falhar. Uma nova compra exige vínculo próprio; confirmação de uma compra antiga não encerra pedidos diferentes.

Este trecho ainda precisa ser conciliado com o prompt publicado e com os nomes das ferramentas habilitadas antes de publicar uma nova versão. Confirmar o pagamento não move automaticamente a oportunidade para `won` ou para uma etapa de funil.

### Ponto de retomada — gates completos Linux (04/10/2026)

A rodada isolada `bia-payment-linux-qa` usa Node 22, HEAD `901a17fe2`, o overlay financeiro e as cinco fronteiras shallow reais. Package e lock conferiram com a imagem; dependências Linux foram reaproveitadas. Limites: 2 CPU e 4 GiB, sem ambiente da instalação, socket Docker, banco ou transporte real.

A última contagem disponível da execução única `pnpm exec vitest run --maxWorkers=2` foi 1.149 arquivos finalizados: 1.142 aprovados e sete com falha, após 39 min 17 s. A suíte continuava executando depois dessa medição. Não há resumo final nem código de saída confirmado; shell e gates estáticos estavam enfileirados, sem aprovação registrada.

Falhas observadas: `case-stale-watcher/route.test.ts` tem dublê sem `.is()` após o novo filtro `task_kind`; `dispatcher-org-parada.test.ts` tem lista literal sem o novo consumidor. `performed-at-um-relogio-so`, `dialog-base-roda-e-tem-teto` e `namespace-das-imagens` executaram inicialmente com BusyBox grep, que não oferece os argumentos GNU usados pelas sondas; GNU grep foi instalado só no QA. `hidratacao-useState-nao-le-o-navegador` e `knobs-da-versao-publicada-sao-aplicados` ultrapassaram 15 s sob o limite de CPU. A classificação final exige os detalhes de asserção do rodapé; nenhuma falha foi compensada alterando a fonte do snapshot.

Docker Desktop passou a recusar consultas com HTTP 500 e uma leitura já aberta deixou de responder. A rodada fica **inconclusiva**, sem ser tratada como gate verde. O log parcial redigido está em `payment-activation/unit.partial.redacted.log` na pasta de artefatos da sessão; o log integral e os futuros arquivos `.exit` estão em `/qa/qa-logs` no container. Não reiniciar testes nem ativar a instalação com base nesta rodada. Retomar pela recuperação/leitura segura do QA, conferir os exits, diagnosticar as sete falhas e só então decidir a validação necessária. Não reiniciar o Engine nem serviços de atendimento para recuperar um teste.

A leitura travada foi cancelada apenas no cliente Docker. A tentativa única de encerrar `bia-payment-linux-qa` também retornou HTTP 500 (exit 1); a parada do container não pôde ser confirmada. Não houve nova execução nem alteração na instalação.

### Atualização da retomada após “pode seguir” (04/10/2026)

O Docker Desktop continuou sem responder: nova tentativa de `docker ps` ficou pendente e foi cancelada somente no cliente. Não reiniciar o Engine, o container de QA ou os serviços de atendimento para obter os logs.

Para avançar sem depender do Docker, os sete arquivos que falharam na contagem parcial Linux foram rodados juntos no checkout Windows, com GNU grep/bash do Git for Windows no `PATH`: **73 testes passaram em sete arquivos** (`case-stale-watcher`, `dispatcher-org-parada`, `namespace-das-imagens`, hidratação, `performed-at`, knobs publicados e limite de altura dos diálogos). A execução `pnpm` não chegou a rodar: o gerenciador automático tentou buscar a versão fixada sem rede; as validações seguintes usaram os binários já instalados em `node_modules/.bin`.

O teste de knobs foi refeito para chamar `git grep` uma vez e mapear os consumidores em memória, preservando o controle positivo e o escopo de arquivos versionados. O teste de altura dos diálogos deixou de depender de `grep`/shell e agora percorre arquivos `.tsx` por Node, incluindo caminhos Windows com espaços. Ambos passaram dentro do pacote de 73 testes, e ESLint direcionado também passou.

Gates locais concluídos depois dessas mudanças: `tsc --noEmit -p tsconfig.typecheck.json` exit 0; `eslint .` exit 0 (490 avisos, sem erros); `lint-channels` exit 0 (62 dívidas conhecidas, nenhuma nova); `lint-role-rank` exit 0. A primeira rodada de 73 testes passou antes desses dois ajustes de teste; o pacote foi repetido após os ajustes e também passou.

A suíte unitária completa, `test:shell`, `test:db`, prova E2E contra a instalação atualizada, build completo da imagem e teste real de canal seguem pendentes. A build anterior do app compilou pelo Next, mas não concluiu TypeScript antes de o cliente ser cancelado após a pane do Docker. Não promover imagens nem executar migrations enquanto os gates Linux e o preflight não estiverem resolvidos. O usuário optou por não trocar a senha; essa decisão não bloqueia a execução. Backup permanece preservado e válido; Bia v4 e a mudança do follow-up continuam como rascunhos, sem publicação.

### Retomada do ambiente e build isolada (05/10/2026)

O Docker Desktop foi recuperado após encerrar apenas a distribuição travada `docker-desktop` no WSL e iniciá-la novamente. Os serviços locais voltaram automaticamente; app, worker, scheduler, WAHA, Redis e SRH não tiveram volumes removidos. O app antigo voltou a responder 200 em `/api/v1/health`. O container de QA havia encerrado com código 255, portanto sua rodada completa anterior segue inconclusiva. O log recuperado mostrou mais duas suítes UI com timeout (`agent-form-prompt-nao-trunca` e `composer-rascunho-sugerido`); ambas passaram isoladas no Windows, 10/10 testes.

O SHA-256 do backup autorizado foi novamente conferido e corresponde ao valor registrado no momento da criação. A build isolada do app terminou com código 0 e gerou `bia-app:payment-20261004`; as imagens `bia-worker:payment-20261004` e `bia-scheduler:payment-20261004` já estavam prontas. Nenhuma imagem em uso foi trocada e nenhuma migration remota foi aplicada.

O container de QA foi reiniciado somente para testes; os quatro arquivos de teste corrigidos foram copiados para ele. A conferência Linux focada das nove suítes observadas na rodada interrompida está em execução, seguida da suíte completa se passar. Manter a build e a suíte desacopladas para evitar a sobrecarga que travou o Docker.

### Gates Linux e preflight de banco (05/10/2026)

As nove suítes inicialmente suspeitas passaram juntas no Linux: **9 arquivos, 83 testes**. A suíte unitária integral encerrou com **1.804 arquivos aprovados e um reprovado**, **18.638 testes aprovados, um reprovado, um expected-fail e 13 ignorados**. A única falha foi uma sonda que exigia aspas simples no texto fonte (`janela-propria-de-followup.test.ts`) embora a condição executável permanecesse com aspas duplas. A sonda passou a aceitar ambas as convenções de aspas mantendo a exigência da condição; sua repetição Linux passou **8/8**. Essa correção é somente de teste; a suíte integral não foi repetida após ela.

O gate shell integral terminou com código 0 no QA Linux após instalar GNU grep, `procps` e GNU diffutils apenas no contêiner. O percurso encontrou e corrigiu um defeito real do kit: `ultima_versao_publicada` usava `head -1` em pipeline com `pipefail`, e o produtor podia receber SIGPIPE e fazer a versão encontrada sumir. A função agora consome todas as refs e seleciona só a primeira válida. Repetição do gate completo aprovou. Os erros intermediários de `ps -p` e formato de `diff` eram diferenças do BusyBox do contêiner, não alterações no app ou na instalação.

Typecheck e lint direcionado passaram depois do ajuste do teste. O preflight somente leitura no Supabase real confirmou `postgres` 17.11 no projeto esperado, zero casos e jobs ativos, ausência das colunas/funções/tabela novas. As quatro migrations foram conferidas byte a byte contra o snapshot usado nas imagens; arquivos e runner foram copiados ao worker, **sem executar**. O gate completo `test:db` está em curso em Postgres descartável pelo Git Bash; a primeira invocação por WSL1 não encontrou Docker e não tocou em banco algum. A aplicação remota continua condicionada ao resultado desse gate e à repetição do preflight.

O primeiro `test:db` integral encerrou com **368 arquivos e 2.987 testes aprovados**, dois arquivos/testes reprovados, um expected-fail e um ignorado. As falhas foram nos inventários: faltava uma prova comportamental de leitura cross-tenant para a nova tabela `case_task_reminders` e a declaração justificada da função `fn_definir_aviso_de_caso_local` chamada pelo client da sessão. Foi adicionada uma prova com JWT de usuários de dois tenants, leitura positiva local e zero do vizinho em ambos os sentidos, além da declaração do call site/guardas da função. A primeira asserção da nova prova assumia uma linha local, mas outras provas da mesma suíte criam mais recibos; foi corrigida para exigir pelo menos uma linha local e zero do vizinho. A repetição dirigida das quatro suítes relevantes aprovou **4 arquivos, 119 testes**, com install e update do baseline. Typecheck e lint direcionado após as edições aprovaram. A suíte integral será repetida para fechar o gate antes da aplicação remota.
