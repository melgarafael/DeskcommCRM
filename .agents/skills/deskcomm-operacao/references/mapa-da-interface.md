# Mapa da interface

Esta lista foi extraída do catálogo de navegação (`lib/navigation/catalogo.ts`) em 2026-10-10.
O catálogo manda sobre este arquivo: se a tela disser diferente, a tela tem razão.
Para consultar na hora, veja a seção 'Como consultar na hora' do SKILL.md.

## Atendimento

| Tela | Caminho | Serve para | Quem vê | Observação |
|---|---|---|---|---|
| Inbox | Atendimento → Inbox `/app/inbox` | As conversas de WhatsApp, com você e a IA atendendo lado a lado. | todos | Mostra quantas conversas esperam uma pessoa (aba Fila). |
| Radar | Atendimento → Radar `/app/radar` | Quem esfriou e ainda está aberto — o que corre risco de morrer sem resposta. | todos |  |
| Agenda | Atendimento → Agenda `/app/agenda` | O que está marcado, com quem, e quem atende — seu e da equipe. | todos |  |
| Respostas rápidas | Atendimento → Respostas rápidas `/app/templates` | Scripts salvos para responder mais rápido, seus ou da equipe. | todos |  |

## CRM

Hub: "Ver tudo em CRM" → `/app/crm`

### O dia a dia da venda

| Tela | Caminho | Serve para | Quem vê | Observação |
|---|---|---|---|---|
| Prospecção | CRM → Hub "Ver tudo em CRM" → Prospecção `/app/prospecting` | Busque empresas e conduza abordagens graduais com IA. | administrador |  |
| Funis | CRM → Funis `/app/kanban` | Seus funis de venda — clique em um para abrir o quadro de clientes. | todos |  |
| Campanhas | CRM → Hub "Ver tudo em CRM" → Campanhas `/app/campaigns` | Fale com uma lista de contatos que você escolhe, no ritmo do número. | todos |  |
| Contatos | CRM → Contatos `/app/contacts` | As pessoas do outro lado da conversa e seu histórico. | todos |  |
| Empresas | CRM → Hub "Ver tudo em CRM" → Empresas `/app/companies` | Cadastro B2B — razão social, CNPJ e decisores. | todos | Só aparece se o módulo `crm_b2b` estiver ligado. |
| Pessoas | CRM → Hub "Ver tudo em CRM" → Pessoas `/app/people` | Decisores e contatos ligados a empresas, com vários telefones. | todos | Só aparece se o módulo `crm_b2b` estiver ligado. |
| Tarefas | CRM → Tarefas `/app/tasks` | O que ficou combinado, com prazo — e o que já venceu sem ninguém fazer. | todos |  |
| Planos de tarefa | CRM → Hub "Ver tudo em CRM" → Planos de tarefa `/app/tasks/planos` | Sequências reutilizáveis de tarefas — montar uma vez e aplicar a cada negócio. | todos |  |
| Chamadas | CRM → Hub "Ver tudo em CRM" → Chamadas `/app/calls` | Histórico de ligações (voz por IA) com transcrição. | gerente ou acima |  |
| Comandas | CRM → Hub "Ver tudo em CRM" → Comandas `/app/comandas` | O que foi feito, por quem, e quanto o cliente paga. | todos | Só aparece se o módulo `financeiro` estiver ligado. |

### Preparar a venda

| Tela | Caminho | Serve para | Quem vê | Observação |
|---|---|---|---|---|
| Produtos | CRM → Hub "Ver tudo em CRM" → Produtos `/app/products` | O catálogo da loja, com o preço que o atendente de IA responde. | todos |  |
| Importações | CRM → Hub "Ver tudo em CRM" → Importações `/app/imports` | Lotes CSV/XLSX de empresas, pessoas e telefones. | gerente ou acima | Só aparece se o módulo `crm_b2b` estiver ligado. |
| Etapas do funil | CRM → Hub "Ver tudo em CRM" → Etapas do funil `/app/settings/tenant/pipelines` | As colunas de cada funil, o vocabulário do negócio e os motivos de perda. | gerente ou acima |  |

### Fechar a venda

| Tela | Caminho | Serve para | Quem vê | Observação |
|---|---|---|---|---|
| Propostas | CRM → Hub "Ver tudo em CRM" → Propostas `/app/proposals` | Rascunhe, revise e envie propostas comerciais — do orçamento ao aceite. | todos | Só aparece se o recurso `propostas` estiver ligado. |

## Agente de IA

Hub: "Ver tudo em IA" → `/app/ai`

### Montar o agente

| Tela | Caminho | Serve para | Quem vê | Observação |
|---|---|---|---|---|
| Agentes | Agente de IA → Agentes `/app/ai/agents` | Quem atende por você: instruções, modelo, ferramentas e publicação. | gerente ou acima |  |
| Follow-ups | Agente de IA → Follow-ups `/app/ai/followups` | Como o agente retoma uma conversa que esfriou, para nenhuma morrer no silêncio. | gerente ou acima |  |
| Fluxos de atendimento | Agente de IA → Hub "Ver tudo em IA" → Fluxos de atendimento `/app/ai/atendimento` | Perguntas que a IA conduz durante a conversa, com as respostas guardadas na ficha do cliente. | gerente ou acima | Só aparece se o módulo `fluxos_atendimento` estiver ligado. |
| Roteadores | Agente de IA → Hub "Ver tudo em IA" → Roteadores `/app/ai/routers` | Qual agente pega qual conversa, e quando o humano assume. | gerente ou acima |  |
| Credenciais | Agente de IA → Hub "Ver tudo em IA" → Credenciais `/app/ai/credentials` | A chave do provedor de IA que os agentes usam para pensar. | gerente ou acima |  |
| Provedores | Agente de IA → Hub "Ver tudo em IA" → Provedores `/app/ai/providers` | Ligue o Jev para decisões rápidas e escolha qual inteligência atende cada parte do sistema. | gerente ou acima |  |

### Ensinar o agente

| Tela | Caminho | Serve para | Quem vê | Observação |
|---|---|---|---|---|
| Conhecimento | Agente de IA → Hub "Ver tudo em IA" → Conhecimento `/app/ai/knowledge/sources` | Os materiais que o agente consulta antes de responder sobre o seu negócio. | gerente ou acima |  |
| Memória | Agente de IA → Hub "Ver tudo em IA" → Memória `/app/ai/memory` | O que o agente já aprendeu sobre a sua operação e reaproveita. | gerente ou acima |  |
| Skills | Agente de IA → Hub "Ver tudo em IA" → Skills `/app/ai/skills` | As ações que o agente pode executar sozinho durante o atendimento. | gerente ou acima |  |

### Acompanhar o agente

| Tela | Caminho | Serve para | Quem vê | Observação |
|---|---|---|---|---|
| Casos | Agente de IA → Casos `/app/ai/cases` | Os atendimentos que o agente conduziu, do início ao desfecho. | atendente ou acima | Mostra quantos casos esperam uma pessoa. |
| Alertas | Agente de IA → Hub "Ver tudo em IA" → Alertas `/app/ai/inbox` | O que a IA encontrou e precisa de uma decisão sua. | todos |  |
| Aviso no WhatsApp | Agente de IA → Hub "Ver tudo em IA" → Aviso no WhatsApp `/app/ai/cases/avisos` | Receber no WhatsApp quando o assistente abrir um caso. | administrador |  |
| Propostas | Agente de IA → Hub "Ver tudo em IA" → Propostas `/app/ai/proposals` | Melhorias que a IA sugere para si mesma, esperando sua decisão. | todos |  |
| Execuções | Agente de IA → Hub "Ver tudo em IA" → Execuções `/app/ai/runs` | O que a IA fez — e, quando falhou, o que aconteceu e o que fazer. | gerente ou acima |  |
| Uso e orçamento | Agente de IA → Hub "Ver tudo em IA" → Uso e orçamento `/app/ai/usage` | Quanto a IA consumiu e qual é o teto de gasto do mês. | gerente ou acima |  |

## Canais

| Tela | Caminho | Serve para | Quem vê | Observação |
|---|---|---|---|---|
| Conexões | Canais → Conexões `/app/connections` | Seus números de WhatsApp: por QR ou canal oficial da Meta, com saúde, reconexão e templates. | administrador | Mostra um ponto de saúde da conexão. Botão Agendar pausa para janelas de manutenção. |
| Nuvemshop | Canais → só pela busca → Nuvemshop `/app/integrations/nuvemshop` | Conecte a loja para trazer pedidos e clientes para dentro do CRM. | administrador | Não está no menu: só se chega pela busca. |
| Webhooks | Canais → Webhooks `/app/webhooks` | Avise outros sistemas quando algo acontecer aqui dentro. | gerente ou acima |  |

## Análise

Hub: "Ver tudo em Análise" → `/app/analise`

### Dinheiro

| Tela | Caminho | Serve para | Quem vê | Observação |
|---|---|---|---|---|
| Faturamento | Análise → Hub "Ver tudo em Análise" → Faturamento `/app/faturamento` | Quanto entrou, de que forma, e quanto cada pessoa tem a receber. | todos |  |
| Honorários | Análise → Hub "Ver tudo em Análise" → Honorários `/app/honorarios` | O modelo de cobrança de cada caso e o calendário de parcelas. | todos | Só aparece se o módulo `honorarios` estiver ligado. |

### Os números do período

| Tela | Caminho | Serve para | Quem vê | Observação |
|---|---|---|---|---|
| Desempenho | Análise → Desempenho `/app/metrics` | Funil e performance por atendente nos últimos 30 dias. | todos |  |
| Meta Ads | Análise → Meta Ads `/app/ads/meta` | Quanto custou cada resultado das campanhas que trazem gente para cá. | gerente ou acima |  |
| Atividades | Análise → Atividades `/app/activities` | Relatório do que a equipe e os agentes fizeram no período: quanto, quem e de que tipo. | todos |  |

### O histórico que se consulta

| Tela | Caminho | Serve para | Quem vê | Observação |
|---|---|---|---|---|
| Evolução da IA | Análise → Hub "Ver tudo em Análise" → Evolução da IA `/app/ai/evolution` | Se o agente está melhorando, onde ele erra e o que falta ensinar. | gerente ou acima |  |
| Audit Log | Análise → Hub "Ver tudo em Análise" → Audit Log `/app/audit` | Quem fez o quê, quando — o histórico que não se apaga. | gerente ou acima |  |

## Organização

Hub: "Configurações" → `/app/settings`

### Sua conta

| Tela | Caminho | Serve para | Quem vê | Observação |
|---|---|---|---|---|
| Perfil | Organização → Hub "Configurações" → Perfil `/app/settings/profile` | Seu nome, idioma, fuso horário e avatar. | todos |  |
| Segurança | Organização → Hub "Configurações" → Segurança `/app/settings/security` | Verificação em duas etapas, códigos de recuperação e sessões. | todos |  |
| Notificações | Organização → Hub "Configurações" → Notificações `/app/settings/notifications` | Por onde e sobre o quê você quer ser avisado. | todos |  |

### Sua empresa

| Tela | Caminho | Serve para | Quem vê | Observação |
|---|---|---|---|---|
| Equipe | Organização → Hub "Configurações" → Equipe `/app/team` | Quem trabalha aqui, com qual papel e quanta conversa cada um aguenta. | todos |  |
| Distribuição de atendimento | Organização → Hub "Configurações" → Distribuição de atendimento `/app/settings/atendimento` | Quem recebe cada cliente novo, e o que cada atendente enxerga. | gerente ou acima |  |
| Automações | Organização → Hub "Configurações" → Automações `/app/settings/automacoes` | O freio único do passo em que a IA escolhe entre as opções de uma regra, para a empresa inteira. | gerente ou acima |  |
| Tags | Organização → Hub "Configurações" → Tags `/app/settings/tags` | O vocabulário de etiquetas da empresa: onde cada uma é usada e como renomear, juntar ou excluir. | gerente ou acima |  |
| Recursos opcionais | Organização → Hub "Configurações" → Recursos opcionais `/app/settings/recursos` | Tudo o que se liga e desliga, se está ligado e onde se ajusta. | gerente ou acima |  |
| Organização | Organização → Hub "Configurações" → Organização `/app/settings/tenant` | Dados da empresa, retenção de dados e encarregado de LGPD. | administrador |  |
| Conversões | Organização → Hub "Configurações" → Conversões `/app/settings/conversoes` | Devolver ao anúncio as vendas que ele trouxe, e marcar a origem de quem chega pelo site. | administrador |  |
| Meta Ads | Organização → Hub "Configurações" → Meta Ads `/app/settings/meta-ads` | Conectar a conta de anúncios para ler o desempenho das campanhas. | administrador |  |
| Marca | Organização → Hub "Configurações" → Marca `/app/settings/marca` | O nome e a cor que sua empresa mostra dentro do sistema. | administrador | Com cor opcional para o tema escuro. |
| Plano e cobrança | Organização → Hub "Configurações" → Plano e cobrança `/app/settings/billing` | Pagamento, troca de plano e faturas da sua empresa. | administrador |  |
| Tipos de agendamento | Organização → Hub "Configurações" → Tipos de agendamento `/app/settings/tenant/agenda` | O que se pode marcar, quanto dura, onde acontece e quem atende. | todos |  |
| Propostas | Organização → Hub "Configurações" → Propostas `/app/settings/tenant/proposals` | Configure a validade padrão e condições para propostas comerciais. | gerente ou acima | Só aparece se o módulo `propostas` estiver ligado. |
| Modelos de proposta | Organização → Hub "Configurações" → Modelos de proposta `/app/settings/tenant/proposals/modelos` | Personalize os modelos da plataforma ou crie os da sua empresa, inclusive a partir de uma proposta que você já usa. | gerente ou acima | Só aparece se o recurso `propostas` estiver ligado. |
| Financeiro | Organização → Hub "Configurações" → Financeiro `/app/settings/tenant/financeiro` | Contas, formas de pagamento e como cada lançamento é classificado. | todos | Com Editar em contas, formas, plano de contas, comissões e recorrências. |
| Extensões | Organização → Hub "Configurações" → Extensões `/app/extensions` | Guias instalados para orientar o trabalho no CRM, com permissões e estado visíveis. | todos |  |

### Dados e acesso

| Tela | Caminho | Serve para | Quem vê | Observação |
|---|---|---|---|---|
| LGPD | Organização → Hub "Configurações" → LGPD `/app/lgpd/requests` | Pedidos de exportação e exclusão de dados feitos por clientes. | administrador |  |
| API Tokens | Organização → Hub "Configurações" → API Tokens `/app/settings/api-tokens` | Chaves para outro sistema conversar com o seu CRM. | administrador |  |
| Trunk SIP | Organização → Hub "Configurações" → Trunk SIP `/app/settings/voip-trunk` | Credenciais do provedor SIP para chamadas de voz por IA. | administrador |  |
| Dados externos | Organização → Hub "Configurações" → Dados externos `/app/integracao-dados` | Conecte um banco de dados de outro sistema para o agente consultar em tempo real. | todos | Só aparece se o módulo `banco_externo` estiver ligado. |

## Fora do menu: administração da instalação

Estas páginas ficam em `app/admin/` e são de quem administra a instalação (o servidor), não de quem
administra a organização (a empresa). Títulos medidos no próprio arquivo da página.

| Rota | Título medido |
|---|---|
| `/admin/dashboard` | Dashboard |
| `/admin/tenants` | Tenants |
| `/admin/tenants/new` | Novo Tenant |
| `/admin/tenants/[id]` | não encontrei título no arquivo (mostra o painel do tenant) |
| `/admin/tenants/[id]/agent` | Agente (do tenant) |
| `/admin/tenants/[id]/health` | Status de Saúde (do tenant) |
| `/admin/users` | Usuários |
| `/admin/users/[id]` | Detalhe do usuário |
| `/admin/usage` | Uso & Custo |
| `/admin/audit` | Audit Log |
| `/admin/audit/[entryId]` | Detalhe da entrada de auditoria |
| `/admin/incidents` | Incidentes |
| `/admin/incidents/[id]` | Detalhe do incidente |
| `/admin/inbox` | Supervisão de conversas (somente leitura; mostra "Selecione uma conversa para visualizar") |
| `/admin/inbox/[conversationId]` | Conversa do tenant (somente leitura) |
| `/admin/lgpd` | LGPD — visão entre empresas |
| `/admin/lgpd/requests/[id]` | Detalhe da solicitação LGPD |
| `/admin/cadastro` | Cadastro |
| `/admin/cobranca` | Cobrança dos seus clientes |
| `/admin/configuracao` | Configuração da instalação |
| `/admin/destinos-internos` | Destinos internos |
| `/admin/email` | Servidor de e-mail da instalação (título da aba; não conferi o cabeçalho visível) |
| `/admin/extensoes` | Extensões da instalação |
| `/admin/google` | Google Agenda da instalação (título da aba; não conferi o cabeçalho visível) |
| `/admin/marca` | Marca |
| `/admin/meta` | API Oficial da Meta da instalação (título da aba; não conferi o cabeçalho visível) |
| `/admin/modulos` | Módulos da instalação |
| `/admin/sistema` | Recursos opcionais |
| `/admin/platform-admins` | Platform Admins |
| `/admin/forbidden` | Acesso negado |

A página `app/admin/(protected)/page.tsx` não é uma tela: ela redireciona para `/admin/dashboard`.

## Como validar

Quando a pergunta depender de uma tela específica:

1. procure o nome em `app/app/` ou `app/admin/`;
2. consulte `docs/current-state.md`;
3. não transforme este arquivo em autoridade se a tela atual disser diferente.
