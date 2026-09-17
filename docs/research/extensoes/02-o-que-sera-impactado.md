# Extensões — investigação 2: o que será impactado

Data: 2026-09-14. Base investigada: `25edc35b05c8d522e2bfe313863e6003f47b8f56`.

**Síntese:** o maior impacto não é acrescentar telas. É garantir que instalar, atualizar ou desligar uma extensão não abandone uma demanda, altere silenciosamente a autoridade de um agente ou deixe dados pessoais fora das rotinas existentes. A arquitetura precisa manter identidade, permissões, contexto, próximos passos e histórico sob responsabilidade do sistema anfitrião. Uma especialização transversal, como financeiro, pode continuar opcional; atender muitos nichos não basta para torná-la núcleo.

**Estado desta investigação:** leitura de código e doutrina; nenhum ambiente de produção, credencial, dado real ou serviço externo foi utilizado. `CONFIRMADO` significa demonstrado pela implementação citada; `INFERIDO` descreve consequência arquitetural; `PROPOSTA` ainda precisa virar contrato e implementação. A matriz final é plano de aceite pela tela, **não teste executado**. Nenhum comportamento foi alterado.

## 1. O que já existe e não deve ser recriado

**CONFIRMADO — há catálogo local de Skills.** A página consulta `skill_pointers` da organização e da plataforma (`app/app/ai/skills/page.tsx:24`). Importa ZIP com `SKILL.md`, referências e arquivos permitidos; valida caminhos, tamanho e conteúdo (`lib/ai/skills/package.ts:97`). A instalação copia uma versão de plataforma para a organização, preservando origem (`lib/ai/skills/install.ts:74`). O ponteiro só muda depois dos uploads (`:60`); remover o ponteiro preserva versões históricas (`app/api/v1/ai/skills/[name]/route.ts:48`). Isso fornece experiência e mecanismos reutilizáveis, mas não distribuição externa de módulos executáveis, dependências entre extensões ou avaliações globais.

**CONFIRMADO — “instalada” não representa toda a disponibilidade efetiva.** `loadSkills` lê sempre plataforma **e** organização, dando preferência ao nome local (`lib/agent-engine/agent/skills.ts:177`). O turno usa esse resultado (`lib/agent-engine/agent/inbound-turn.ts:1909`). Portanto, retirar uma cópia local que tenha equivalente global revela novamente a versão global. A tela anuncia “desinstalada” (`app/app/ai/skills/_client.tsx:68`). É divergência verificável pelo encadeamento do código, ainda sem reprodução visual nesta investigação. Migrar apenas os ponteiros locais perderia o inventário do que efetivamente atendia cada organização.

**CONFIRMADO — existem métricas locais de Skills.** O turno grava `skill_activations`, distinguindo uso por correspondência e sinal de possível correspondência perdida (`lib/agent-engine/agent/inbound-turn.ts:2327`). Não são instalações globais nem estrelas. O README promete telemetria comunitária de **erros**, com escolha no instalador (`README.md:489`); essa autorização não equivale a consentimento para medir adoção. O manual exige conteúdo declarado, desligamento e agregado devolvido ao público (`docs/doctrine/sistema-vivo/07-o-projeto-como-sistema.md:47`).

## 2. Jornadas, navegação, marca e idioma

**CONFIRMADO — existe uma única declaração de destinos.** Sidebar, hubs e busca derivam de `NAV_CATALOG` (`lib/navigation/catalogo.ts:4`, `lib/navigation/registry.ts:94`). A interface por vínculo escolhe destinos e preserva portas essenciais; seu próprio contrato diz que apresentação não é autorização (`lib/navigation/interface.ts:1`).

**PROPOSTA — conexão `contribuiçõesDeInterface`.** Projetar destinos autorizados das extensões sobre o mesmo catálogo e seus consumidores. Disponibilidade da extensão, papel da pessoa e preferência visual compõem a projeção. A rota e a operação verificam autorização independentemente. Uma tela de uso eventual entra no hub pertinente; instalar dez extensões não cria dez itens obrigatórios na lateral. A gestão de extensões precisa ser uma porta recuperável mesmo quando a interface simplificada esconde o restante.

O fluxo a preservar é **descobrir → entender → instalar → configurar → ativar → usar → resolver falha**. A ficha deve explicar benefício, quem pode usar, recursos necessários, dependências e permissões adicionais. “Instalada, falta configurar” não pode parecer “funcionando”. Configuração pendente aponta para o campo que falta; falha aponta para um responsável e uma ação possível. Links salvos e avisos históricos devem abrir uma explicação legível quando a extensão estiver desativada.

**CONFIRMADO — marca e idioma são infraestrutura compartilhada.** Marca vem da instalação e organização; saídas externas usam `marcaDaSaida`, e o PDF de LGPD identifica controlador/DPO (`CLAUDE.md:125`). O idioma é `pt-BR` ou `es`, resolvido pela preferência da pessoa, organização e padrão (`lib/i18n/idiomas.ts:42`). `IdiomaProvider` reconcilia a escolha local com o servidor (`lib/i18n/IdiomaProvider.tsx:69`).

**PROPOSTA — conexão `apresentaçãoDaExtensão`.** Expor tokens visuais, idioma e componentes permitidos do anfitrião. Textos de extensão têm identidade própria, fallback legível e validação de traduções; ausência não pode vazar uma chave técnica. Tema deve declarar a área que modifica, com conflito explícito entre substituições exclusivas. Componentes opcionais precisam conter a própria falha sem derrubar layout, login ou a página inteira. Validar contraste, densidade, teclado, foco, fontes e marca em estados de sucesso e erro; o manifesto sozinho não prova isolamento de CSS ou código.

## 3. Autoridade, agentes e operações em andamento

**CONFIRMADO — capacidades já distinguem público humano e modelo.** Metadados de tela e handlers são separados, com junção validada (`lib/mcp/tools/catalogo-servido.ts:42`). Nomes publicados são contrato estável (`lib/mcp/tools/catalog.ts:17`). Capacidades críticas não são ativadas automaticamente por pacote (`lib/mcp/tools/selecao-por-pacote.ts:74`). MCP verifica papel e escopo (`lib/mcp/server.ts:72`); o runtime da IA também aplica seu escopo operacional (`lib/ai/runtime/tools.ts:98`).

**PROPOSTA — conexão `capacidadesDisponíveisDaOrganização`.** A mesma origem validada alimenta configuração dos agentes, exposição MCP e execução. Instalação oferece uma capacidade; seleção/publicação do agente concede uso dentro da autoridade existente. Extensões não recebem `service_role` nem o `admin` irrestrito dos contratos internos atuais. Nomes precisam de namespace, versão contratual e classificação de risco. Atualizar não adiciona permissões silenciosamente, nem troca o significado de ferramenta usada por agentes publicados.

Há precedente forte para impedir ações antigas: `AgentOperationContext` fixa agente, versão e revisão; sua guarda relê a publicação e o estado operacional (`lib/ai/agents/operation.ts:4`). `guardServiceEffect` confere novamente essa autoridade e a fronteira da demanda antes de efeitos (`lib/atendimento/fronteira-server.ts:59`).

**PROPOSTA — conexão `autoridadeDaExtensãoNoEfeito`.** Cada execução registra versão exata/digest do pacote, revisão da ativação, organização, ator e demanda. O snapshot preserva a interpretação; não perpetua permissão revogada. Desativar bloqueia novas invocações e invalida a revisão. Imediatamente antes da mutação ou envio, o anfitrião verifica novamente ativação, concessão e fronteira da demanda, inclusive em turnos iniciados antes da mudança. Para escrita local, a revisão participa da mesma transação que admite o efeito: reler antes e gravar depois ainda permite corrida. Cancelamento de chamada em memória não substitui essa guarda.

Uma operação externa já aceita não pode ser “desfeita” pelo desligamento. Se a resposta se perdeu, o estado deve ser “resultado a confirmar”, com conciliação pelo identificador da operação; retentativa cega pode duplicar cobrança ou mensagem. O contrato de cada efeito precisa declarar idempotência e resolução desse estado.

**PROPOSTA — conexão `continuidadeDaCapacidadeIndisponível`.** Falha que impede cumprir um compromisso abre item visível na Central e preserva responsável/próximo passo na demanda. Quando exigir atendimento humano, usar o handoff existente: ele silencia automação, cancela crons e cria aviso com contexto (`lib/agent-engine/agent/human-handoff.ts:169`); `buildHandoffSummary` agrega o necessário (`:315`). A resposta humana volta estruturada ao contexto. Reativar extensão não permite à IA reassumir conversa entregue ao humano. O precedente explícito é: capacidade só muda de dono quando o novo dono existe (`lib/agent-engine/agent/entrega-de-capacidade.ts:18`).

## 4. Eventos, automações e propagação do desligamento

**CONFIRMADO — os registros internos são confiados ao código do produto.** `registerHandler` aceita substituir uma chave já registrada, útil para recarga local (`lib/event-log/dispatcher.ts:62`); os consumidores executam em sequência (`:88`). O drain seleciona somente tipos com handler atual (`lib/event-log/drain.ts:102`), recupera processamento abandonado (`:78`) e mantém recibos em `consumed_by`. Ações de automação recebem cliente administrativo (`lib/automation/types.ts:12`) e seu registro sobrescreve por tipo (`lib/automation/actions/index.ts:5`).

**INFERIDO:** expor esses registros diretamente a terceiros permite colisões e amplia o alcance de falhas. Remover o último consumidor de um tipo deixa eventos pendentes fora da seleção. Atualizar um consumidor mantendo chave e mudando significado também compromete a interpretação dos recibos históricos.

**PROPOSTA — conexão `entregasDaExtensão`.** O anfitrião administra assinaturas por organização, identidades estáveis, versão do payload, recibo por destinatário e limite de execução. Consumidor externo recebe somente dados autorizados. Trabalho novo não nasce para extensão inativa; trabalho já aceito termina sob a versão fixada quando permitido, ou é cancelado/transferido com razão e próximo passo. A retirada não apaga recibos nem deixa eventos sem destino. Novas extensões não recebem automaticamente todo o passado. Ações de automação e seus formulários precisam preservar leitura histórica quando o executor sair.

**CONFIRMADO — cache e realtime têm mecanismos aproveitáveis, não um protocolo de extensões.** O `AuthProvider` remonta os providers ao mudar pessoa/organização (`hooks/auth/AuthProvider.tsx:89`). Skills invalidam apenas queries locais após mutações (`hooks/ai/useSkills.ts:23`). O hook de realtime usa autenticação canônica (`hooks/realtime/useRealtimeChannel.ts:47`), e `useRefetchDeSeguranca` relê, detecta divergência e recupera ao voltar à aba (`hooks/realtime/useRefetchDeSeguranca.ts:93`).

**PROPOSTA — conexão `revisãoDeDisponibilidade`.** Uma revisão persistida governa catálogo local, menus, ferramentas e assinatura de eventos. Realtime comunica mudanças; releitura no foco e reconexão recupera perda. Caches são separados por organização e revisão, inclusive workers e abas abertas. Nenhum cache autoriza efeito. A tela comunica perda de atualização; o servidor barra ação revogada mesmo antes de a interface receber o aviso. O modo de suporte deve continuar respeitando leitura e escrita restritas.

## 5. Dados, privacidade e manutenção na VPS

**CONFIRMADO — LGPD contém enumerações explícitas.** O exportador coleta contatos, pedidos, atividades, agenda, tarefas e outras fontes individualmente (`lib/lgpd/export-collector.ts:316`, `:556`). A anonimização combina RPC e rotinas complementares (`lib/lgpd/redact-cascade.ts:106`, `lib/lgpd/cascata.ts:121`). O teste de cobertura descobre tabelas em `public` com FK para contato e determinados nomes de colunas (`tests/invariants/lgpd-cascata-alcanca-quem-guarda-pessoa.test.ts:78`); não prova toda estrutura possível de um plugin. A retenção tem políticas diferentes para evidência e dados reconstruíveis (`lib/retencao/politica.ts:34`).

**PROPOSTA — conexão `obrigaçõesDosDadosDaExtensão`.** Declarar dados pessoais, vínculo com organização/contato/demanda, exportação, anonimização, arquivos e retenção. Exportar e redigir devem alcançar extensões inativas. Resultado parcial permanece pendente e visível; não marca cumprimento completo. A limpeza não pode depender de reativar código indisponível ou inseguro. Isso exige manter um adaptador de dados confiável ou operações declarativas administradas pelo núcleo, inclusive depois da retirada do pacote. Sem tal garantia, extensão com dados pessoais não está pronta para publicação.

Reutilizar contatos e vínculos existentes, aplicando DIRC antes de criar campos. Dados de nicho não justificam duplicar identidade nem enfraquecer RLS. Métricas globais não recebem contatos, nomes de organizações ou conteúdo operacional; identidade comunitária para avaliações é separada do login local. Downloads, instalações reportadas e uso reportado são indicadores diferentes. Medir também falhas, retiradas após erro e recuperação: estrelas não substituem saúde operacional.

**CONFIRMADO — atualização muda banco antes de imagens.** O kit reaplica o baseline (`hostgator-setup-kit/update.sh:145`) e fixa imagens do app, worker e scheduler (`:230`). O rollback atual alcança as três imagens disponíveis (`hostgator-setup-kit/agent.sh:303`); não reverte o schema. Comentários antigos em marca ainda descrevem rollback só do app, portanto não devem fundamentar o desenho.

**PROPOSTA — transição preservando quem já instalou:**

1. Inventariar capacidades efetivas, configurações, versões, dados e trabalhos pendentes; incluir Skills globais e personalizações locais.
2. Introduzir contratos e adaptadores com comportamento atual preservado. Não remover módulos existentes como efeito incidental da modularização.
3. Instalar um piloto opcional por organização, com dependências visíveis e versões fixas. Provar convivência antes de extrair o próximo módulo.
4. Validar atualização e rollback com banco novo e código anterior, app/worker compatíveis, módulos ausentes e permissões ampliadas exigindo escolha explícita.
5. Separar desativação, retirada do executável e descarte de dados. Plano de retirada mostra demandas, automações, agentes e dependentes atingidos antes da ação.

Build e publicação permanecem no CI, sem compilação exigida na VPS (`docs/doctrine/packaging.md:63`). Backup/restauração precisa incluir pacotes/versionamento, dados, arquivos e revisões de ativação; restaurar só o banco não reconstitui uma instalação modular.

## 6. PRs e mapa vivo

**PROPOSTA:** classificar contribuição como núcleo, extensão, configuração ou mudança combinada. Cada contribuição declara entradas, saídas, obrigação de dados, autoridade, dependências, consumidor do evento, recuperação e superfície humana. A matriz contratual deve conferir versões suportadas, duas organizações e combinações relevantes; a comparação não precisa enumerar todas as combinações possíveis do marketplace.

A contribuição externa continua acolhida: a prova em tela que exige ambiente completo é responsabilidade do mantenedor (`.github/PULL_REQUEST_TEMPLATE.md:29`). SDK e ambiente reproduzível reduzem esse custo. Acrescentar critério sem ferramenta transfere fragilidade aos criadores. Atualizar `CLAUDE.md`, contrato público, template, material de contribuição e mapas no mesmo marco; mapas distinguem existente e proposto (`docs/architecture/README.md:59`).

O laço fica concreto: evento autorizado → execução → atividade na `LeadTimeline` (`components/kanban/LeadTimeline.tsx:96`) e/ou aviso na `AgentInboxList` (`app/app/ai/inbox/_components/AgentInboxList.tsx:143`) → pessoa corrige configuração ou decide → nova revisão efetiva. `event_log` serve efeitos; auditoria serve rastreio. Não emitir evento decorativo sem consumidor.

## 7. Matriz de aceite obrigatoriamente pela tela

Ambiente: instalação fresca pelo baseline, conta de teste real, duas organizações A/B, usuários com papéis diferentes, dois navegadores e dependências locais reais. Efeitos externos usam receiver real. Screenshot/trace e medidas de layout complementam a observação; consultas ao banco confirmam efeitos, sem substituir cliques do usuário. **Todos os cenários abaixo estão pendentes de implementação e execução.**

| Jornada pela tela | Caminho adverso e resultado a observar | Conferência de backend |
|---|---|---|
| Descobrir e instalar em A | Catálogo indisponível, pacote inválido, dependência incompatível; explicação e recuperação compreensíveis | Nenhuma ativação parcial; versão anterior intacta |
| Configurar e ativar | Credencial ausente ou permissão insuficiente; nada aparenta sucesso | Ativação distinta de configuração; B permanece igual |
| Migrar e desativar Skill existente | Skill global, cópia local e personalização com mesmo nome | Comportamento anterior preservado na migração; desativação efetiva sem retorno global silencioso |
| Encontrar recurso em menus, hub e busca | Interface simplificada, teclado, tela pequena; nenhum botão escondido | URL direta respeita autorização e ativação |
| Instalar tema e módulo funcional juntos | Conflito, logo ruim, tema claro/escuro, espanhol e texto longo | Preferências isoladas; falha visual contém seu alcance |
| Agente usar capacidade autorizada | Capacidade instalada mas não concedida; pedido fora do escopo | Recusa instrutiva, auditoria e ausência de efeito |
| Desligar durante turno/follow-up | Segunda aba atrasada tenta agir; receiver demora a responder | Revisão invalida efeito; sem duplicação; próximo passo preservado |
| Atualizar com tarefa/evento pendente | Worker reinicia; pacote novo quebra; resultado externo ambíguo | Versão fixada, recibo, recuperação e histórico legível |
| Resolver falha na Central | Humano assume, decide e devolve contexto; fila sem pessoa disponível | Sem retomada automática indevida; responsabilidade explícita |
| Alternar A/B e reconectar | Realtime interrompido, aba em fundo, sessão de suporte | Cache sem mistura; releitura corrige e denuncia perda |
| Exportar/anonimizar contato com extensão inativa | Armazenamento indisponível e retomada posterior | Todas as fontes alcançadas; falha parcial visível; B intacta |
| Atualizar instalação antiga e restaurar backup | Rollback de imagens sobre banco atualizado | Dados, personalizações, permissões e próximos passos preservados |
| Avaliar extensão e escolher métricas | Sem conta comunitária, voto repetido, envio desativado | CRM funciona independente; métricas consentidas e distinguíveis |

Esses cenários aproveitam jornadas já existentes de capacidades, organizações/cache, follow-up, marca e atualização em `tests/e2e/`. Cada nova spec deve entrar na seleção efetivamente executada do CI ou declarar a exceção; referência: `.github/workflows/e2e.yml:106`. Prova de arquitetura é encerrar essas jornadas sem surpresa para quem usa, com a mesma obrigação mantida quando uma peça falha ou deixa de existir.
