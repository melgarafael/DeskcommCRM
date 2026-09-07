# Comunidade 360 — execução integral

Autorização: usuário aprovou implementar as oito sugestões e defeitos associados, em modo subagent-driven. Base medida: origin/main `4bc0fda4`, 2026-09-05. Este plano não autoriza deploy nem merge em produção. A especificação é o pedido do usuário e os resultados descritos abaixo; o relatório antigo é hipótese, não autoridade de estado.

| Pedido / defeito associado | Tasks |
|---|---|
| Organizações separadas + cache + suporte verdadeiro | 1, 2 |
| Interface adequada por cliente | 3 |
| Encerramento real | 4 |
| Sandbox / assistido / automático | 9 |
| Responsáveis por número + erros de capacidade WAHA | 10 |
| Meet | 8 |
| Sync e seleção de calendários | 7 |
| Presença/no-show e recuperação coerente | 6 |
| Central de avisos acionável | 5 |
| Provas cruzadas e entrega | 11 |

## Global Constraints

- Preserve trabalhos de outras sessões. Trabalho apenas no worktree `/Users/rafaelmelgaco/wt/comunidade-360`, branch `feat/comunidade-360`.
- Leia `CLAUDE.md` e `docs/doctrine/sistema-vivo.md`. Tenant confiável, filtros explícitos, RLS real, Zod, RBAC/MFA preservados, auditoria e superfície visível de falha.
- Schema em tripla: migration nova + apêndice idempotente baseline + MANIFEST, com tipos e testes DB. Instalação e atualização não exigem edição manual.
- Reutilize mecanismos existentes. DIRC antes de criar campos. Não ampliar autorização para implementar apresentação. Não introduzir provider fora de `lib/channels/`.
- Funcionalidade visível exige jornada por frontend, evidência local, atualização do mapa de jornadas/arquitetura e fragmento `.changes/`. Não declarar prova externa a partir de mock.
- Um implementador por vez; pesquisa/preparação e revisores podem trabalhar independentemente. Cada implementador faz auto-revisão; outro agente revisa especificação e qualidade. Nenhum implementador cria subagentes.
- Testes completos `pnpm test:unit` sem filtro antes de PR, typecheck/lint/gates, `pnpm test:db` e E2E relevantes. Registrar logs integrais e distinguir falhas prévias. Não repetir verificações caras sem mudança/risco concreto.
- Cada tarefa deve provar sua jornada e schema antes de iniciar uma dependente; Task 11 integra provas já executadas, não é a primeira prova. Servidor HTTP controlado prova transporte e estados, não consentimento Google nem convite entregue.
- UI em português claro conforme design system. O relógio solicita confirmação de presença; não prova ausência. Sandbox não produz efeitos reais; aprovação de rascunho não significa fala humana independente.

## Task 1: Criar e alternar organizações sem órfãs nem dados antigos

Ownership: criação administrativa de tenants, convite reutilizável, TenantSwitcher/porta administração, ação setActiveOrg e limite de cache autenticado; testes/docs/mapa/fragmento correspondentes. Não implementar impersonação nem perfil de interface nesta tarefa.

Leia primeiro `.superpowers/sdd/comunidade-360/audit-organizacoes.md` quando disponível. Inspecione a implementação atual para preservar contratos.

Critérios:
1. Instalação com uma organização oferece ao platform admin porta visível para gerenciar/criar organizações; usuário comum não ganha administração de plataforma.
2. Criação grava organização e membership admin do criador atomicamente. Nenhuma falha deixa organização órfã. `owner_email` gera convite real para responsável diferente do criador; se é o criador, não duplica membership/convite.
3. Sem Resend, sucesso mostra link copiável e validade do convite; falha de e-mail não perde organização nem promete entrega. Reutilizar assinatura/aceitação/branding canônicos. Um envio automático de teste só a receiver/caixa local, nunca pessoa real.
4. Valide input, duplicidade, autenticação, MFA/idempotência conforme contratos do repo. Auditoria representa criação e convite sem registrar token.
5. Troca org aceita somente membership ativa para navegação normal; não inventar bypass de platform admin. Verificar org válida/ativa, cookie UUID, erro visível e auditoria da troca bem-sucedida.
6. Troca remove dados anteriores imediatamente durante transição e recria/isola cache e estado de UI por contexto autenticado (usuário+org), incluindo respostas antigas em voo. Não basta invalidar uma query. Falha na troca não deixa shell afirmando org diferente dos dados. Provar A→B→A.
7. Testes reais DB da criação atômica e isolamento; testes de ação/convite e E2E criação desde org única, aceite convite e inbox com dados distinguíveis nas duas orgs. Adicione specs ao CI conforme regra existente. Atualize jornada, mapa e `.changes/`.
8. Aceitar convite ativa a organização convidada, preserva convidador e não reescreve papel de membership já ativa no replay. Convite antigo não pode restaurar privilégio rebaixado/revogado. Scope `support_readonly` não cria organizações. Solução de transição aceita navegação completa com bloqueio visual dos dados durante troca; não exige reescrever todas as query keys.

## Task 2: Acompanhamento administrativo com escopo verdadeiro

Ownership: impersonate cookie/start/end, resolução auth/org/RLS necessária e shell/banner; testes/docs correspondentes. Depende Task 1.

Cookie assinado referencia a sessão; banco, usuário autenticado e auth.session_id determinam o escopo após validar ator, prazo, tenant e autoridade de plataforma. Reads/server/client/realtime devem concordar. Acompanhamento não pode mostrar banner de B com dados de A nem fornecer acesso permanente escondido. Somente saída explícita restaura contexto e elimina cache; expiração/revogação bloqueia a continuação até essa saída. Preserve RLS; contrato e matriz abaixo determinam a concessão temporária e os testes de negativa/revogação/MFA/expiração. Registrar início/fim e mutações administrativas pela superfície do app atribuídas ao ator real. Provar via navegador com dados A/B.

Contrato escolhido após investigação: suporte concede acesso TEMPORÁRIO a B para a sessão Supabase autenticada, sem membership permanente e sem fingir outra identidade. Não revoga os direitos de plataforma preexistentes em A/C e não promete confinar todo o JWT. Implementar a alternativa em `.superpowers/sdd/comunidade-360/design-suporte-alternativa.md`, não o confinamento global proposto antes. `platform_support_sessions` liga ator/auth.session_id/alvo/modo/TTL/retorno; cookie é referência/presentação, banco é autoridade. Teto de TTL no corpo, scope atual só reduz, expiração/revogação bloqueia operação no app até saída explícita (não restaura A silenciosamente).

| Superfície | full | support_readonly |
|---|---|---|
| RSC/API/app/realtime | contexto e consultas explicitamente B, papel de suporte admin | contexto B, leitura compatível viewer; identidade plataforma não passa por cima do modo |
| Escrita API/Server Action/DML/RPC | B com ator real; auditoria nas operações pela superfície do app | recusada em B, inclusive ator que já tinha membership admin B |
| Direitos preexistentes A/C fora do app de suporte | preservados | preservados; não são grant novo nem promessa de confinamento |
| Worker/cron de outro ator | operação normal da org continua | observador não congela atendimento real |
| Expirada/revogada | app exige sair; grant virtual some | app exige sair; nenhum write B até saída |

`fn_user_org_ids` une memberships reais ao alvo temporário; `fn_user_role_in_org` aplica modo em B. Cercas DML AS RESTRICTIVE por catálogo e guardas dos definers write (`emit_event`, `fn_log_event`, `fn_conversation_assign`, `fn_mesclar_contatos`, confirmar catálogo aplicado). Guardas compartilhadas do servidor cobrem service role e Server Actions, inclusive administração de B. Readonly não faz mark-read/heartbeat/envio ao abrir conversa. Full não torna suporte atendente elegível. Início/fim usam a guarda de transição da Task1 e notificam outras abas do mesmo login. Auditoria derivada do contexto autenticado preserva ator e alvo; não atribuir cron ao observador. Provar DB com/sem membership B, session_id distinta, modo rebaixado e todos os caminhos de escrita citados; browser inicia B, lê B, full edita B, readonly recusa, fim volta A. Readonly não promete acesso às páginas que viewer já não pode consultar.

Gate de catálogo consulta `pg_proc`/`has_function_privilege` no banco aplicado: quatro nomes são expectativa atual, não allowlist eterna. `fn_support_write_allowed(B)` nega até `ended_at` em sessão inválida, mesmo quando ator tem membership admin real B. Saída valida somente a identidade autenticada e posse da própria sessão de suporte, sem exigir platform-admin ainda ativo nem TTL válido. Auditoria prometida é a das operações da superfície do app; não oferecer editor SQL/DML genérico novo nem afirmar que RLS é auditoria de escrita bruta. Direitos de DML de plataforma preexistentes continuam fora dessa promessa, e grants virtuais full novos devem ter suas operações expostas por handlers auditados.

Callbacks OAuth que retornam sem o JWT SameSite=Strict devem carregar a auth.session_id no state assinado novo e revalidar a sessão de suporte antes de escrever. State legado sem prova da sessão mantém fluxo normal quando não há restrição do ator/alvo; se pode atravessar suporte somente leitura/expirado, recusa recuperável solicita reiniciar pela tela. Não presumir que ausência do campo remove a restrição. Tasks posteriores de Google preservam esse contrato.

Durante suporte ativo, a configuração inicial incompleta do alvo não redireciona para o wizard: o app de acompanhamento permanece com banner/saída. Acesso direto ao wizard nesse contexto volta ao app. Isso não altera onboarded_at nem o fluxo do membro comum. Provar alvo incompleto em full e readonly, duas abas da mesma sessão na entrada/saída e transporte com receptor local e controle positivo.

## Task 3: Interface configurável por membro e convite

Ownership: registro navegação e consumidores sidebar/hubs/command menu, tipos/contexto membership, gestão equipe/convite/aceite; schema/testes/docs. Depende Task 1; consome contexto efetivo da Task 2 quando integrada.

Configuração separada do papel: perfil completo/simplificado e seleção clara de recursos visíveis, usando IDs canônicos do registry e schema central. Persistir escolha antes de aceitar convite e ao editar membro. Não bloquear URL/API por estar oculta nem permitir recurso proibido por RBAC. Incluir navegação secundária/atalhos/busca; garantir saída, equipe/perfil e administração do implementador recuperáveis. Configurar na criação de organização/convite responsável quando pertinente. Provar dois membros com mesmo papel e apresentação distinta, atualização e aceite.

Preset simplificado inicial: Inbox, Agenda, Contatos, Funis, Tarefas e Conexões/WhatsApp, sempre intersectado com o RBAC existente; IDs são os destinos canônicos reais. Conexões permite ao cliente autorizado reescanear QR sem expor toda navegação técnica. A seleção granular pode removê-lo. Perfil completo permanece default retrocompatível; não criar tela de conexão paralela ou ampliar permissões.

## Task 4: Encerramento, reabertura e memória de atendimento

Ownership: ingestão e demanda/conversa lifecycle, checkpoint/prompt memória e superfície inbox; schema/testes/docs.

Fechar conversa encerra o atendimento naquele canal e preserva histórico; encerrar demanda é comando separado, com desfecho explícito e revisão esperada. Nova mensagem válida reabre conversa e entra na fila apropriada com nova demanda visível/fechável. Não reabrir por duplicata/evento histórico/status ou mensagem própria. Reabertura idempotente e concorrente. Separar fatos úteis do contato de pendências/resumo de atendimento encerrado usando estrutura existente quando possível; novo turno recebe encerramento explícito, sem tratar assuntos antigos como pendentes. Superfície ao humano para entender memória/atendimento vigente. Preservar LGPD, opt-out e handoff. Teste DB + jornada fechar→novo contato→responder→fechar.

Contrato: fechar conversa encerra aquele atendimento/canal, não inventa desfecho resolvida da demanda compartilhada. UI oferece encerrar demanda com desfecho explícito do vocabulário existente e revisão esperada; ação afeta apenas demanda escolhida. Demanda aberta em outros canais permanece até comando explícito. A última conversa fechada sem desfecho deixa próximo passo visível em vez de inventar resolução. Novo inbound posterior a encerramento cria/reusa demanda aberta sob lock; evento atrasado anterior ao encerramento não reabre. Fronteira da memória operacional referencia a demanda atual; notas duráveis permanecem separadas.

Desenho revisto em `.superpowers/sdd/comunidade-360/task-4-design-review.md`: reusar demanda aberta somente quando vinculada à conversa e à revisão vigente; reentrada após encerramento cria demanda nova, sem escolher outro assunto do contato por recência. Vínculos compartilhados existentes permanecem históricos e demandas dos demais canais não são encerradas. Uma operação DB canônica de entrada, chamada pelo trigger de mensagem persistida, e os comandos de fechamento serializam pelo mesmo lock transacional org+contato, antes de alterar conversa/demanda, com revisão monotônica e CAS. Conferir todos os triggers/callers reais para manter a ordem e provar concorrência com estado final determinístico.

Jobs capturam fronteira imutável de conversa/demanda; leitor confiável e comparador puro a revalidam antes de tool mutável e do envio canônico. Fechar/reabrir invalida trabalho antigo definitivamente. Efeito já aceito pelo transporte não é recuperável: não prometer desfazer envio que começou antes do fechamento. Contexto atual contém só mensagens/checkpoint/next_action da fronteira vigente; lead_notes preserva fatos duráveis. Histórico anterior pode mostrar desfecho/resumo final sem listas de tarefas pendentes. Usar painel existente para memória e desfecho, sem novo sistema de tickets nem reescrita de leitores históricos sem efeitos.

Origem dos retornos: continuação de job, caso ou silêncio herda a fronteira demonstrável; cron, retry e nó de fluxo nunca a recapturam no disparo. Novas decisões autorizadas (comando MCP fora de execução, inscrição humana, regra/evento de recepção e aceite humano de reativação) selecionam/criam/reabrem a conversa atomicamente na origem e capturam a nova fronteira; conversa aberta sem demanda aceita demanda nula, sem inventar assunto. Propor reativação não autoriza envio. Persistir conversa/fronteira no retorno e na inscrição que emite os jobs; resolver canal pela conversa capturada. Legado sem origem demonstrável termina obsoleto com motivo recuperável, sem renovar autoridade. Mapa dos callers em `.superpowers/sdd/comunidade-360/mapa-origens-retorno.md`; limitar alterações aos caminhos operacionais afetados, sem reescrita geral de campanhas independentes.

Eventos com múltiplos consumidores preservam uma única resolução de origem por destino: automação e gatilho de follow-up de `lead.stage_changed` reutilizam um recibo interno vinculado ao evento e à sessão de canal, criado atomicamente com o início autorizado e revalidado em cada uso. Retry não abre atendimento novo. O recibo é escrito somente por RPC interna, não por payload ou metadata do cliente; emissores autenticados não podem forjar os campos reservados de origem. Sua retenção acompanha o evento existente, sem novo cron ou motor. Comandos observam os canais e o destino padrão na origem; uma sessão explicitamente configurada usa sua própria observação, inclusive ausência comprovada de conversa. Ações já configuradas para números distintos continuam válidas. Continuação permanece vinculada à conversa original e nunca muda de canal para escapar de uma recusa. Efeitos derivados conservam uma referência interna ao evento de origem e aos mesmos recibos por destino; uma ação puramente CRM não precisa abrir conversa. Resolver a referência exige organização/contato coerentes e rejeita ciclos ou origem ausente, sem observar um atendimento novo como alternativa. Eventos públicos não podem se apresentar como recebimento interno de mensagem.

## Task 5: Central de avisos com destino

Ownership: projeção de destino validada e UI Central, contratos refs, testes/docs.

Todos os tipos de aviso que têm contexto navegável oferecem ação legível para destino existente. Validar ref_kind/ref_id por catálogo, preservar autorização e org. Ref inválida/removida não produz link quebrado silencioso. Tipos sem referência têm orientação útil/contexto de configuração. Abrir contexto não resolve aviso automaticamente. Provar aviso→contexto→retorno/resolução.

Validar organização e papel não substitui a visibilidade por registro: conversas e negócios têm RLS de atribuição (`fn_can_view_conversation`/`fn_can_view_lead`). Resolver alvos por consultas autenticadas sob essa RLS, em lote e com filtro explícito da organização ativa, ou por guarda canônica equivalente; o admin client da listagem de avisos não autoriza abrir todos os registros da org. Provar também aviso que aponta para conversa de outro atendente na mesma organização com modo own/own_and_unassigned: sem link indevido e sem ampliar permissão. Não criar uma cópia das regras de visibilidade no catálogo de navegação.

Preparação de autenticação revisada em `.superpowers/sdd/comunidade-360/task-5-auth-contract.md`: manter o contrato cookie atual, sem inventar bearer REST. Destinos de revisão de modelos de canal pertencem a Conexões (sub-aba real), nunca à coleção de respostas rápidas `/app/templates`. Escolher somente contexto sustentado pela referência/produtor; sem referência inequívoca, usar orientação geral honesta.

## Task 6: Agenda vinculada, confirmação de presença e follow-up coerente

Ownership: agenda humana vínculo contato/conversa, desfecho/presença e worker relógio, follow-up guards/Radar/avisos; schema/tests/docs. Depende Tasks 4–5.

Agendamento humano vincula contato e opcional conversa com validação tenant. Registrar compareceu/faltou/cancelou com ator real e timeline. Worker após horário+toleração configurável solicita confirmação humana com aviso deduplicado; ausência de marcação não é no-show automático. Confirmar falta pode alimentar gatilho de recuperação no follow-up, configurável e idempotente; remarcar/cancelar/inbound cancela recuperação obsoleta. Consulta futura e situações vivas seguram cobrança por silêncio no agendamento e no envio; Radar explica proteção. Eventos têm consumidores. Provar relógio controlado, concorrência, atualização e isolamento.

Contrato de fonte: humano operador pode confirmar; declaração explícita do próprio contato pode ser registrada com referência à mensagem inbound confiável, mantendo autoria/fonte. Modelo não ganha booleano de autoautorização: silêncio ou inferência apenas propõe confirmação. Cancelamento declarado pelo contato mantém caminho operacional existente. No-show não é inferido por horário. Uma decisão compartilhada de proteção retorna motivo/compromisso/reavaliação; sweep, envio de inscrições existentes e Radar a consomem. Falha na leitura adia cobrança com diagnóstico. Lembrete e entrega de link não são cobrança por silêncio.

Preparação concreta em `.superpowers/sdd/comunidade-360/design-presenca-followup.md`. Decisões de execução: solicitar confirmação por padrão em `ends_at + 10 minutos`; proteger cobrança por presença desconhecida até `ends_at + 24 horas`. Ambos são configurações da organização com schema central e edição pela gestão, sem env novo. Depois do horizonte, manter pendência escalada visível na Central/Radar e liberar somente a proteção excepcional de silêncio: nunca inferir falta nem iniciar recuperação por timeout. Outros compromissos vivos ainda protegem. O operador mantém a possibilidade existente de registrar desfecho após o início, inclusive encerramento antecipado real; a confirmação é explícita e auditada, não inferência do relógio.

Texto livre do contato pode ser evidência vinculada à mensagem e validada por humano. Ferramenta sem prova interna e significado determinístico propõe confirmação, não grava o fato. Não criar classificador semântico de presença, endpoint público ou token novo nesta tarefa. Se outro follow-up ocupa o contato, não o substituir: registrar recuperação não iniciada com motivo e ação humana visível. Não deixar uma fila de recuperação oculta aguardando vaga. Vínculo/idempotência por compromisso+revisão impede retry tardio iniciar recuperação depois que o outro fluxo terminou.

Aplicar proteção e fronteira vigente também ao envio inline em `lib/followup/enviar-texto-fixo.ts`, callbacks e retries, além de sweep/daemon e Radar/score. Adiamento não é envio bem-sucedido: preservar nó e reagendar com prazo finito, sem callback sent por resultado queued/failed. Fonte de cobrança/lembrete/link é contexto interno confiável, nunca flag pública que contorne a guarda.

Na leitura humana do Radar, preservar também a visibilidade por registro: a rota atual usa admin e ignora a atribuição do negócio. Ao integrar a proteção de agenda, passar o leitor autenticado sob RLS para a consulta da tela, com filtro explícito da organização; execuções internas mantêm seu contexto próprio. Não duplicar ownership em TypeScript. Provar agent em own/own_and_unassigned sem negócio de outro atendente e suporte conforme papel efetivo. Preparação em `.superpowers/sdd/comunidade-360/task-6-radar-auth.md`: demandas têm RLS org-flat; para agent, validar os vínculos com lead ou conversa que a mesma sessão possa ler, em lote, antes das contagens. Consultar os IDs das candidatas sob RLS, sem confundir o pool limitado de negócios classificados com todo o conjunto autorizado. Preservar leitura org-wide de manager/admin e contexto interno; não criar nova policy geral de demandas nesta etapa.

Contrato de invalidação por retorno: reutilizar o recibo privado da decisão de recuperação, sem contador paralelo por contato. Inbound novo certificado, sob o mutex organização/contato, registra decisão obsoleta se o consumer ainda não iniciou ou invalida a decisão existente preservando seu histórico e cancelando a inscrição, inclusive pausada. Não usar `messages.created_at` como ordem de certificação: `now()` antecede a aquisição do mutex. Comparar o timestamp externo com o início do segundo do desfecho; mensagens distintas no mesmo segundo contam, replay da mesma identidade não duplica e desordem entre respostas posteriores não mantém a recuperação viva. Sem timestamp externo, o fallback de ingestão não distingue histórico de mensagem atual; documentar essa limitação. Consumer e envio final consultam a invalidação; uma decisão obsoleta nunca autoriza novo início.

## Task 7: Seleção de agendas e sincronização Google completa

Ownership: adapter Google calendário, seleção fontes/destino UI settings, sync eventos e contratos agenda; testes/docs.

Verificar documentação oficial antes de alterar API externa. Listar calendários com permissões, selecionar fontes de ocupação e um destino gravável. Preservar principal como padrão compatível. Usar is_destination existente; validar escolha no servidor. Sync ida/volta trata criação/edição/cancelamento conforme autoridade documentada, sem loop/duplicata, com IDs estáveis, paginação/sync tokens e recuperação 410 quando aplicável. Calendário somente leitura não recebe escrita. Troca destino não duplica nem perde compromissos já associados. UI mostra estado/erro/última sincronização e retentativa. Provar adapter por HTTP receiver e UX local; validação Google real só se credenciais de teste disponíveis.

Contrato: identidade publicada é `(organization_id, google_connection_id, google_calendar_id, google_event_id)` e fica no compromisso; novo destino só afeta novas publicações. CRM é autoridade para contato/conversa/tipo/desfecho e Google nunca apaga esses vínculos. Horário/cancelamento remoto de evento vinculado podem atualizar CRM quando não há revisão local pendente; se ambos mudaram desde checkpoint sincronizado, preservar ambos como conflito visível para escolha explícita do operador, sem last-write-wins silencioso. Escrita condicional etag/versão e CAS local não perdem edição concorrente. Recorrentes externos são instâncias de ocupação, sem condensar série em um compromisso; criação/edição de série CRM não é capacidade desta tarefa. Cancelamento mínimo é resolvido pela identidade antes do anti-eco.

Desenho executável em `.superpowers/sdd/comunidade-360/design-sync-google.md`: um destino efetivo por usuário entre suas conexões, sem transferir publicações antigas; crons existentes como executores com claim comum por compromisso e checkpoint de calendário cercado por claim, sem novo motor. Reusar revisão de domínio da Task6, separar revisão da projeção publicável; metadata de sync/Meet não gera remarcação ou push. Corrigir paginação incremental mantendo o mesmo syncToken em todas as páginas e checkpoint só depois de aplicação íntegra; desmarcar origem remove sua ocupação tanto da grade quanto da consulta de horários, preservando reconciliação dos vínculos antigos.

Comparação compartilhada base/local/remoto cobre horário e cancelamento. Campos outbound já existentes mantêm checkpoints normalizados da intenção local e escrita remota para enviar apenas grupos alterados localmente: mudar horário no CRM preserva título alterado no Google, sem importar título nem gerar conflito permanente. Uma intenção local que substituiria mudança remota nesses grupos exige decisão explícita e etag atual; não criar editor ou sincronização inbound de títulos/convidados. Não bloquear globalmente agendamento fora da janela atual de cache: renovar janela periodicamente com cursor retomável e informar cobertura parcial/frescor no fluxo existente; cobertura nova só vale após aplicação completa.

## Task 8: Google Meet no agendamento e no atendimento

Ownership: conferência Google via adapter/worker, meeting_url/state, detalhe agenda/resultado ferramenta e entrega no atendimento; testes/docs. Depende Task 7.

Solicitar conferenceData com requestId estável e acompanhar pending/success/failure por worker durável. Gravar link retornado na org/compromisso correto; retries não criam salas/eventos duplicados. Convidado e sendUpdates existentes preservados. Link disponível na UI, retorno da ferramenta/continuidade do agente e fluxo de envio consentido no atendimento; nunca prometer link antes de existir. Falha visível com retry; cancelamento/interrupção invalida efeito pendente. Testar HTTP real controlado, estados assíncronos, duplicatas e isolamento.

Preparação em `.superpowers/sdd/comunidade-360/design-meet.md`: usar o mesmo executor de publicação e identidade/claim da Task7. Intenção de entrega nasce na operação de booking autorizada com contexto interno coerente ou na escolha humana explícita; não usar inferência semântica/booleano do modelo como prova. Guardar referências e fronteira original, não URL/corpo duplicados em jobs. Uma entrega automática ou autorizada pelo botão transacional não simula fala humana independente nem aplica seu silenciamento; auditoria conserva solicitante. Nova tentativa humana cria intenção nova; trabalho antigo nunca reancora no atendimento reaberto. Estender apenas consumer/ledger existente quando necessário, sem LLM para enviar link determinístico. Material novo e persistência de resultados seguem anonimização existente e prova de invalidação concorrente.

## Task 9: Autonomia do agente e sandbox confiável

Ownership: lifecycle agente/publish/pause, motor compartilhado e sandbox boundary, rascunhos assistidos/approve/reject/edit e UI; schema/tests/docs. Depende Task 4 e integra ferramentas agenda atuais.

Pausa não destrói publicação e permite assistência. Seletor de operação assistido/automático e teste claramente disponível antes de publicar; modo teste nunca atende canal real. Sandbox usa mesmo core/config/RAG/gates aplicáveis com adapters de simulação; explicitar restrições simuladas. Assistido gera sugestão automaticamente por inbound usando conhecimento/contexto reais e tools de leitura seguras; efeitos de escrita não ocorrem antes da autorização apropriada. Humano edita/aprova/rejeita, com feedback estruturado e consumidor. Rascunho se torna obsoleto após mensagem/contexto/mode/assignment mudarem e revalida gates no envio. Aprovação autenticada não aplica silenciamento de fala humana independente, não permite bypass público. Claim atômico impede aprovação/envio duplo. Falhas visíveis e retomáveis. Auto preserva governança. Testar isolamento, pausa, transição em voo, obsolescência e sequência de duas aprovações.

Aprovar fala autoriza apenas envio da fala. Operação de escrita é proposta separada e nunca efeito implícito da aprovação textual; pode encaminhar o humano à ação canônica existente. Sandbox simula mutações com registro de proposta, sem criar credenciais MCP com poder de escrita em produção.

Reconciliar também o `rag_bot` legado produtivo que hoje grava `sending` e emite `message.send_requested` sem consumidor. Reutilizar a receita canônica de configuração/publicação do onboarding, preservando prompt/RAG e validando canal, modelo e credencial; não conceder ferramentas ou pipelines por inferência. Migração idempotente e recuperável pela tela de agentes, com escolha explícita quando houver ambiguidade e sem sobrescrever/publicar rascunho humano existente. O engine passa a ser o único executor da resposta. Sem configuração suficiente, mostrar causa e ação reparadora, sem mensagem fictícia nem estado “no ar”. Nenhum novo consumidor paralelo para transportar a resposta legada. Preparação concreta em `.superpowers/sdd/comunidade-360/design-autonomia.md`, seção 8, que substitui o adiamento proposto na seção 7.

## Task 10: Roteamento por número e compatibilidade da instalação

Ownership: routing worker/policies canal receptor/UI conexões/roteadores, adapter WAHA erros/capacidades e packaging; schema/tests/docs.

Número receptor seleciona responsáveis/grupo/política configurados, com fallback explícito por disponibilidade/capacidade e fila visível; não encaminhar outro corretor silenciosamente se configuração restringe. Membership/revogação/escopo verificados no claim. Sem configuração preserva rodízio atual. Resposta sai canal de origem. Servidor que recusa múltiplas sessões dá erro útil na criação; não inferir esse limite somente do rótulo Core. 409/422 só aceitos se sessão existente correta e pós-condição da operação foram confirmadas. Não republicar WAHA licenciado ou exigir Plus sem licença no kit. Capability check visível e docs/defaults honestos e compatíveis update. Testar DB dois números/atendentes indisponíveis, UI configuração e receiver HTTP/provider real local disponível.

Escopo escolhido: vínculo relacional canal↔responsáveis, sem CRUD novo de grupos/cadeia de fallback. Capacidade/jornada globais preservadas, rodízio por canal. Sem responsável elegível: fila + aviso acionável + retentativa/reativação durável quando elegibilidade voltar. Configuração explícita limita a lista; ausência de configuração preserva política legada. Implementar em dois commits revisáveis: distribuição por canal; capacidade/erros WAHA e documentação do kit. Preservar a instalação existente e múltiplos números quando o upstream os suporta, sem limite artificial por tier nem licenciar/republicar por conta do projeto.

Premissa corrigida por prova: `.superpowers/sdd/comunidade-360/qa-waha-core.md` registra a tag fixa `2026.7.2 CORE/NOWEB` criando/iniciando duas sessões simultâneas até `SCAN_QR_CODE`; não houve pareamento/envio nem duas contas WORKING provadas. O [comunicado oficial de 21/06/2026](https://waha.devlike.pro/blog/waha-2026-6/) informa que os recursos Plus, incluindo múltiplas sessões, estão na imagem pública desde `2026.6.1`. Portanto não criar teto de um número baseado em CORE nem obrigar compra de Plus para esta tag. Corrigir afirmações factuais obsoletas em docs/doutrina CLAUDE/AGENTS no commit de compatibilidade, preservando referências upstream fixas e contratos de versões antigas. A sonda mediu duplicidade create como 422, payload inválido400 e start repetido201; nenhum409 natural foi observado. Classificação+verificação de pós-condição continua obrigatória, sem transformar códigos desconhecidos em sucesso.

Preparação executável em `.superpowers/sdd/comunidade-360/design-roteamento.md`: ausência de política mantém legado, política existente vazia mantém restrição e fila. O carregador compartilhado recebe contexto explícito de canal para distribuição/handoff; resumo global de fila continua observacional. Claim automático compõe com mutex de atendimento da Task4, revalida membership/lista/capacidade e preserva o override humano vigente. Canais alternativos com sessão válida continuam atendidos. UI principal mostra estado e próximo passo em linguagem simples; versão/engine/tier ficam no diagnóstico. Estados de conexão usam vocabulário existente.

## Task 11: Integração e prova final

Ownership: reconciliação de contratos/docs/CI/cobertura e correções apontadas, revisão independente.

Executar suíte completa unit, typecheck/lint/channels/role, baseline install+update/invariantes, shell se packaging e build de produção. Jornadas por browser contra banco próprio fresco: criação e convite sem Resend; A/B isolamento e acompanhamento; menus; encerramento; assistência/sandbox; agenda/presença/Meet; roteamento. Registrar limitações de Google/WhatsApp real separadas. Revisão completa da branch com diff e ledger. Preparar commits/PR revisáveis sem merge/deploy. Não declarar concluído o que não foi provado.
