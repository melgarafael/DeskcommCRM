# Investigação 1 — O que impacta a plataforma de extensões

**Fotografia:** `main` em `25edc35b05c8d522e2bfe313863e6003f47b8f56`, investigada em 14/09/2026. **Escopo:** bases e contratos existentes dos quais a proposta depende. Leitura de código e doutrina; nenhum serviço, banco ou fluxo de usuário foi executado. Este documento não é evidência de funcionamento em tela.

**Resumo:** existem bons pontos de reaproveitamento: catálogo de capacidades, navegação derivada, versões de skills com ponteiros, eventos duráveis e atualização comandada pela tela. Esses mecanismos foram construídos para código confiável publicado junto do produto. Eles ainda não oferecem isolamento, permissões granulares, instalação independente nem compatibilidade para terceiros. A arquitetura deve preservar três níveis distintos: pacote disponível na instalação, capacidade ativada na organização e ação autorizada ao ator. O banco e os trabalhos pendentes precisam participar da compatibilidade desde o primeiro piloto.

**Legenda:** **CONFIRMADO** é observado nesta fotografia; **INFERIDO** é consequência do desenho observado, sem ensaio; **PROPOSTO** é recomendação, ainda não contrato aprovado. As referências `arquivo:linha` identificam a evidência. Documentos antigos de estado se declaram fotografias históricas (`docs/current-state.md:13`); não foram usados como prova do estado atual. `graphify-out/` não existe nesta worktree: a investigação usou buscas e leitura direta.

## 1. Identidade, acesso e autoridade são contratos do núcleo

**CONFIRMADO.** `requireRole()` valida a sessão, resolve organização por fonte confiável, consulta o papel efetivo no banco e exige MFA quando a sessão deve prová-lo (`lib/auth/require-role.ts:52`, `:94`, `:115`). Os helpers SQL também reconhecem acompanhamento administrativo com acesso delimitado (`supabase/baseline.sql:18410`). Não basta copiar o identificador de organização vindo de uma extensão.

Há quatro papéis humanos; o TypeScript acrescenta `ai_operator`, exclusivo da operação da IA, entre atendente e gerente. Ele não deve virar opção de equipe nem ser introduzido em `user_organizations` (`lib/auth/types.ts:7`, `:23`, `:47`). A autorização de instalação no servidor também difere da administração de uma organização: a atualização atual exige `is_platform_admin` (`app/api/v1/system/update/route.ts:26`).

**CONFIRMADO.** O ingresso MCP valida bearer com prefixo `dsk_`, hash, expiração e revogação; deriva organização e papel do token (`lib/mcp/auth.ts:77`). A definição de ferramenta só distingue os escopos `mcp:read` e `mcp:write` (`lib/mcp/types.ts:29`). O servidor entrega um cliente Supabase administrativo aos handlers (`lib/mcp/server.ts:63`); esse cliente ignora RLS (`lib/supabase/admin.ts:2`). `requireRole()` é ingresso de sessão, enquanto o MCP tem autenticação própria: uma futura integração não pode pressupor que qualquer rota HTTP já aceite qualquer token.

**INFERIDO.** Expor o `McpContext` atual diretamente a código de terceiros equivaleria a confiar nesse código para filtrar todas as organizações. RLS não corrigiria a omissão. Escopos genéricos de leitura/escrita também não representam uma permissão como “consultar somente agendamentos”.

**PROPOSTO.** Manter identidade, concessão e revogação no núcleo. A extensão recebe operações delimitadas, sem cliente administrativo, conexão SQL do núcleo ou credenciais do host. Cada chamada deve cruzar a autorização vigente da organização, do ator, da extensão e do recurso. O contrato externo preserva Zod, formatos de API, auditoria e erros canônicos exigidos em `CLAUDE.md:40`–`73`.

## 2. O marketplace de skills é precedente útil, com outra semântica

**CONFIRMADO.** A migration 0068 acrescentou manifesto, origem do fork e ativações de skills. O catálogo de plataforma consiste em linhas com `organization_id null`, no mesmo banco da instalação, legíveis por usuários autenticados (`supabase/migrations/20260724120000_0068_skills_marketplace.sql:5`, `:40`). Não representa um catálogo compartilhado entre VPSs.

O importador aceita ZIP com `SKILL.md`, referências e assets permitidos; valida caminhos, limites e hashes de arquivos (`lib/ai/skills/package.ts:30`, `:97`, `:194`). Publicar cria versão; ativar move ponteiro conferindo organização e nome no próprio SQL (`lib/agent-engine/agent/skills.ts:101`, `:147`). O importador só move esse ponteiro depois dos uploads (`lib/ai/skills/install.ts:20`). São padrões reutilizáveis de preparação e ativação.

**Limitação decisiva:** `loadSkills()` carrega também as skills de plataforma sem instalação explícita; o tenant pode sobrescrevê-las pelo nome (`lib/agent-engine/agent/skills.ts:170`). A própria API explica que uma skill de catálogo funciona antes de ser “instalada” (`app/api/v1/ai/skills/route.ts:10`). Desinstalar remove somente o ponteiro da organização (`app/api/v1/ai/skills/[name]/route.ts:47`), permitindo que a versão de plataforma volte a prevalecer.

**INFERIDO.** Essa semântica causaria surpresa grave em módulos opcionais: “desinstalar” poderia reativar comportamento de fábrica. SHA256 por arquivo comprova correspondência de conteúdo; o parser não autentica publicador nem executa um protocolo de dependências.

**PROPOSTO.** Reaproveitar os padrões, mantendo modelos separados. Uma extensão pode contribuir skills, mas catálogo, versão instalada, ativação por organização e concessões precisam de registros próprios. A ausência de ativação deve impedir operação. Não reinterpretar `skill_activations`, que mede matching de IA, como contagem de instalações do marketplace.

## 3. Eventos duráveis existem; isolamento entre consumidores ainda não

**CONFIRMADO.** `event_log` carrega organização, entidade, payload e `consumed_by`; o dispatcher evita consumidores já registrados nessa lista (`lib/event-log/dispatcher.ts:17`, `:81`). O dreno tem claim otimista, recuperação de trabalho preso e retentativas (`lib/event-log/drain.ts:57`, `:116`, `:159`). Isso evita começar um segundo barramento sem necessidade.

Contudo, o registro é global em memória, preenchido por imports estáticos. A mesma chave substitui silenciosamente um handler anterior; os consumidores executam em sequência (`lib/event-log/dispatcher.ts:62`, `:88`; `lib/event-log/register-handlers.ts:27`). Tentativas, reagendamento e estado terminal pertencem à linha do evento, não a uma entrega independente por extensão (`lib/event-log/drain.ts:125`).

Há uma segunda distinção: fatos sem consumidor interno, incluindo `contact.updated` e `message.sent`, nascem `done` por trigger da migration 0239 (`supabase/migrations/20260912200000_0239_registro_nao_fica_pendente.sql:110`, `:146`). O dreno seleciona apenas `pending` (`lib/event-log/drain.ts:100`). Registrar futuramente uma extensão interessada nesses fatos não basta para entregá-los. Reabrir o estado global tampouco seria neutro: desfaria a separação existente entre registro e fila.

**PROPOSTO.** Usar os fatos do núcleo como origem de uma entrega própria para extensões, independente do estado do dreno interno. Essa entrega precisa de identidade namespaced, versão do contrato, versão executora fixada, recibo por consumidor, limites, timeout, retentativa e diagnóstico visível. Não oferecer `registerHandler()` interno como SDK público.

**Ponto de captura a avaliar:** um trigger interno `AFTER INSERT` em `event_log`, independentemente de `status`, com assinatura autorizada por organização e tipo de evento. Capturar só em `emit_event()` seria incompleto: também há `fn_log_event` e INSERT direto (`lib/agent-engine/agent/operator-turn.ts:637`; `lib/wacalls/events-bridge.ts:349`). O trigger seria código revisado do núcleo, sem HTTP, scripts do pacote ou execução da extensão.

Para limitar custo transacional, prefiro uma entrada curta na caixa de saída do núcleo por fato elegível, contendo a referência durável ao evento e a revisão das assinaturas. Um worker desdobra essa entrada em recibos únicos por evento, assinatura e versão; retoma por leitura durável, com Realtime apenas para antecipar a observação. A revisão preserva quem estava inscrito na origem; concessões e ativação são novamente verificadas antes do efeito. Registrar diretamente um recibo por assinatura no trigger é alternativa mais simples, condicionada a limite de desdobramento e custo medidos. A retenção precisa preservar o conteúdo necessário até o desfecho da entrega.

**Tradeoff explícito:** a gravação da caixa de saída participa da transação comercial. Erro SQL, lock ou volume excessivo podem atrasar ou recusar a operação do núcleo; ausência de HTTP evita depender da disponibilidade remota, mas não elimina esse custo. Índices, limite de trabalho e prova sob carga são condições, não garantias presumidas. Engolir erro do trigger e afirmar entrega garantida seria falso: continuar sem recibo exigiria reconciliação comprovada a partir de `event_log`. Uma alternativa sem trigger também precisaria dessa reconciliação, independente de `pending`; um cursor ingênuo por data pode perder transações que confirmam fora de ordem.

Recibo único evita duplicar a mesma entrega local, mas não promete efeito externo exatamente uma vez. O consumo admite repetição e precisa de idempotência no destino. Se uma ação irreversível recebeu resposta incerta, o estado correto pode exigir reconciliação antes de repetir. O helper HTTP atual declara que não fecha a corrida entre requests simultâneos (`lib/api/idempotency.ts:22`); não serve sozinho como trava de instalação ou de operação financeira.

**CONFIRMADO.** Trabalho de atendimento já tem identidade de origem e revisões: `ServiceBoundary` liga organização, contato, conversa e demanda; rejeita trabalho atrasado sobre atendimento encerrado ou substituído (`lib/atendimento/fronteira.ts:1`, `:49`). A migration 0223 protege a origem de eventos operacionais (`supabase/migrations/20260906030000_0223_origem_imutavel_do_evento.sql:26`). **PROPOSTO:** eventos de extensão que causem ações nessa jornada devem preservar essa origem; não reconstruí-la consultando “a conversa atual” na hora de executar.

## 4. Capacidades e interface oferecem portas, mas ainda compiladas

**CONFIRMADO.** O catálogo MCP separa handlers e apresentação; declara nome estável, risco, explicação, pacote e restrição humana (`lib/mcp/tools/catalogo/tipos.ts:11`). O agregador é estático (`lib/mcp/tools/catalogo/index.ts:16`). A junção recusa handler sem apresentação (`lib/mcp/tools/catalogo-servido.ts:42`), e a publicação do agente valida IDs contra a lista compilada (`lib/ai/agents/validation.ts:91`).

O runtime seleciona capacidades autorizadas, aplica papel, escopo e funis, e não monta capacidades exclusivas de humanos (`lib/ai/runtime/tools.ts:98`, `:233`). A ponte exclui envio e handoff alternativos para preservar os mecanismos do engine (`lib/agent-engine/edge/crm/mcp-tools.ts:11`). Instalar um módulo não pode inseri-lo automaticamente nas ferramentas de todos os agentes.

Na interface, sidebar, hubs e busca derivam de `NAV_CATALOG`; os grupos e destinos são tipos estáticos (`lib/navigation/catalogo.ts:18`, `:105`). A preferência por vínculo também valida destinos contra essa lista e declara expressamente que esconder menu não autoriza nem proíbe ações (`lib/navigation/interface.ts:1`, `:6`). Não é possível tratar uma nova entrada de menu como ativação segura.

**INFERIDO.** Descompactar uma pasta com páginas Next na VPS não integra automaticamente essas páginas: a imagem executa o resultado standalone do build (`Dockerfile:78`), e o CSS tem fontes de compilação declaradas (`app/globals.css:10`).

**PROPOSTO.** Criar pontos de contribuição limitados, usados pelas projeções existentes: página hospedada, widget, ação contextual, configuração e capacidade de IA. Manter marca, idioma, acessibilidade e navegação como contratos do host. UI declarativa pode ser uma primeira modalidade; JavaScript externo exige isolamento e contrato visual próprios. A escolha não deve supor importação arbitrária de React dentro do processo principal.

## 5. Schema opcional é uma mudança de distribuição, não apenas de tabela

**CONFIRMADO.** O produto promete software MIT completo, sem versão paga (`VISION.md:59`). A distribuição exige build no CI, procedência, versão imutável e atualização sem edição manual na VPS (`docs/doctrine/packaging.md:63`, `:94`, `:170`, `:207`). A numeração do produto responde ao efeito no operador, calculada por fragmentos (`docs/doctrine/versionamento.md:34`, `:119`). **PROPOSTO:** distinguir versão do produto, versão do pacote e versão do contrato de extensão. Compatibilidade não deve depender apenas de comparar números de release: deve verificar contratos, capacidades disponíveis e schema exigido, com rejeição explicável antes da ativação. Não há versão “compatível” que dispense os gates.

**CONFIRMADO.** A doutrina exige migration versionada, apêndice idempotente no baseline e MANIFEST (`CLAUDE.md:419`). O instalador aplica baseline no banco; a atualização também o reaplica, antes de trocar imagens (`hostgator-setup-kit/install.sh:1776`; `hostgator-setup-kit/update.sh:135`). O produto não tem, nesses caminhos investigados, um executor operacional de migrations arbitrárias enviadas por catálogo.

Já existe uma fronteira valiosa: a tela registra pedido, e o agente do host puxa esse pedido. O que atravessa a resposta é “há atualização?” e o identificador do run, não um comando shell (`app/api/v1/system/agent/route.ts:4`, `:138`). O host escolhe e executa seu `update.sh` conhecido (`hostgator-setup-kit/agent.sh:276`).

DDL usa `url_do_schema()`, que prefere a conexão administrativa e mantém fallback para instalações antigas (`hostgator-setup-kit/_common.sh:433`). **Limite real:** a credencial administrativa ainda chega ao app/worker por `env_file` integral; um teste proíbe seu uso em código, mas isso não é isolamento contra terceiros (`lib/env.ts:128`; `tests/unit/env-ddl-fora-do-app.test.ts:9`). Não se deve herdar esse ambiente num runtime de extensões.

**PROPOSTO — primeira fase preservando a doutrina:** os pilotos oficiais com dados relacionais recebem schema pela tripla atual. As tabelas podem existir na instalação inteira enquanto a capacidade permanece desligada nas organizações que não a escolheram. Essa fase prova modularidade e ativação; não deve ser anunciada como distribuição independente de schema. Consultas, RLS, acesso direto por API e trabalhos agendados devem respeitar a ativação; ocultar a tela não basta.

Financeiro, por exemplo, precisa de entidades e invariantes próprios: valores tipados, moeda, relações, unicidade e transações. Uma tabela universal de JSON não é substituto adequado para fugir de migrations; `CLAUDE.md:133` exige DIRC e `:156` proíbe JSON sem schema central.

**PROPOSTO — evolução posterior:** antes de DDL opcional independente, criar ADR que estenda explicitamente o contrato de packaging/migrations: autoridade instaladora delimitada, artefatos revisados e imutáveis, manifesto de schema, procedência, livro de migrations por módulo/instalação, pré-condições, recuperação e provas fresh/update. A comparação deve incluir schema relacional isolado e governado na instalação versus armazenamento próprio do módulo, considerando backup, consultas, isolamento e manutenção. Não dispensar a tripla vigente por chamar o artefato de plugin; qualquer mudança de responsabilidade precisa ficar aprovada e documentada.

**Rollback não significa desfazer banco.** O agente volta as imagens conhecidas (`hostgator-setup-kit/agent.sh:295`), preservando o schema já aplicado. Extensões precisam declarar compatibilidade entre código anterior, código novo e dados; preferir evolução aditiva, convivência de versões e correção para frente. Desativar preserva registros e histórico. Apagar dados é outra operação, com escopo e responsável explícitos.

O atual `update.sh` transforma erros SQL inesperados em aviso e continua (`hostgator-setup-kit/update.sh:151`). **PROPOSTO:** um novo gerenciador não pode concluir instalação só porque o script terminou: deve verificar pós-condições de schema e estado utilizável antes de ativar o módulo. Recursos do servidor também entram na admissão: app e worker têm tetos de memória declarados, respectivamente em `docker-compose.prod.yml:26` e `:70`; não foi medida a capacidade disponível para extensões.

## 6. Sistema vivo governa também marketplace e operação local

**CONFIRMADO.** A doutrina exige entrada, saída, registro visível, porta, configuração, continuidade e retorno (`docs/doctrine/sistema-vivo.md:31`). Há consumidores concretos para reutilizar: `audit()` grava `api_audit_log` (`lib/audit/index.ts:84`); atividades têm vocabulário central e aparecem no painel do inbox (`lib/leads/activity-vocabulary.ts:2`; `components/inbox/CRMSidePanel.tsx:777`). Registro técnico de instalação e atividade comercial são informações diferentes; um não substitui o outro.

Canais já possuem matriz de capacidades e adaptadores que recusam provider desconhecido (`lib/channels/types.ts:31`; `lib/channels/index.ts:14`). A doutrina preserva as restrições de envio e exige motivo explícito quando um gate não se aplica (`docs/doctrine/restricao-de-canal.md:33`, `:81`). Uma extensão de nicho deve pedir ações ao núcleo, mantendo essas garantias.

Na comunidade, a telemetria atual é consentimento para relatórios de erro, não instalações/atividade (`README.md:489`; `hostgator-setup-kit/install.sh:1417`). O manual exige campos declarados, possibilidade de desligar e agregado devolvido ao público (`docs/doctrine/sistema-vivo/07-o-projeto-como-sistema.md:53`). **PROPOSTO:** métricas do marketplace precisam de consentimento e contrato próprios; um identificador pseudônimo não deve ser anunciado como anonimato garantido. Estrelas não demonstram uso; downloads não comprovam instalação; ausência de relato não comprova abandono.

**Prioridades arquiteturais propostas:** formalizar o registro de extensão e a ativação explícita; estabelecer fronteira de chamadas sem privilégios internos; separar entregas de eventos; provar um piloto relacional pela tripla atual; só então habilitar distribuição executável e DDL independentes. Em cada falha, o administrador deve ver o motivo, o trabalho afetado e o caminho para corrigir. A prova posterior deve passar pela tela, com duas organizações, extensão ausente, conflito, atualização interrompida e histórico preservado após desativação. Nenhuma dessas jornadas foi executada nesta investigação.

## Comandos de reprodução

Consultas para reproduzir a investigação na worktree indicada, sem abrir `.env*`, credenciais ou dados reais:

```bash
git rev-parse HEAD
git status --short
rg --files lib app workers supabase tests
rg -n 'registerHandler|consumed_by|status:|await handler' lib/event-log
rg -n 'loadSkills|skill_pointers|organization_id is null' lib/agent-engine/agent/skills.ts
rg -n 'VALID_TOOL_IDS|tool_ids' lib/ai/agents/validation.ts
rg -n 'NAV_CATALOG|destinos|canSee' lib/navigation
rg -n 'baseline.sql|url_do_schema|PREV_IMAGE|ROLLBACK_ARGS' hostgator-setup-kit/update.sh hostgator-setup-kit/agent.sh
rg -n 'SUPABASE_DB_ADMIN_URL' lib/env.ts tests/unit/env-ddl-fora-do-app.test.ts
rg -n 'fn_event_log_e_registro|trg_event_log_marca_registro' supabase/baseline.sql
nl -ba lib/mcp/types.ts
nl -ba app/api/v1/system/agent/route.ts
```
