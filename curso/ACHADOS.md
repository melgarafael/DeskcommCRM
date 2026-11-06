# Defeitos achados na produção do curso em imagens

**Data:** 24/10/2026 · **Código conferido:** checkout `DeskcommCRM-curso` em `469012ee6`

## Contexto

Estes achados saíram da produção do curso em imagens. 70 agentes, divididos em 14 módulos (Radar, Agenda, Respostas rápidas, Funis, Contatos, Tarefas, Agentes, Follow-ups, Casos, Conexões, Webhooks, Desempenho, Meta Ads e Atividades), fotografaram cada tela numa instalação fresca semeada com a clínica de exemplo, leram o código para escrever as lições e anotaram o que viram de errado. Somam-se 3 achados da Inbox que já tinham sido reproduzidos no navegador. As 238 anotações brutas (235 + 3) foram deduplicadas, porque vários agentes do mesmo módulo descreveram o mesmo defeito, e separadas em três grupos: **A**, defeito do produto; **B**, débito cosmético do produto; **C**, problema do ambiente de captura ou da semente do curso. Cada item de A teve o arquivo:linha citado aberto. "Confirmado no código" quer dizer que a causa existe como foi descrita. Não quer dizer que o defeito foi reproduzido: só os 3 da Inbox foram. Itens marcados "plausível" vieram assim do agente e continuam sem reprodução.

## Resumo por tela

| Tela | A · Alta | A · Média | A · Baixa | B |
|---|---:|---:|---:|---:|
| Radar | 1 | 3 | 0 | 2 |
| Agenda | 2 | 3 | 6 | 1 |
| Respostas rápidas | 1 | 2 | 2 | 1 |
| Inbox | 0 | 4 | 1 | 0 |
| Funis | 1 | 2 | 2 | 4 |
| Contatos | 1 | 8 | 2 | 5 |
| Tarefas | 1 | 2 | 3 | 1 |
| Agentes | 3 | 4 | 6 | 3 |
| Follow-ups | 3 | 1 | 2 | 2 |
| Casos | 1 | 1 | 4 | 2 |
| Conexões | 1 | 6 | 0 | 4 |
| Webhooks | 2 | 4 | 2 | 5 |
| Desempenho | 0 | 2 | 2 | 5 |
| Meta Ads | 1 | 1 | 1 | 0 |
| Atividades | 0 | 1 | 2 | 0 |
| **Total** | **18** | **44** | **35** | **35** |

Grupo C: 16 itens (último parágrafo).

---

## A · Gravidade alta

**A1. Follow-ups: o modelo pronto "Consulta · retomar quem sumiu na marcação" não tem nenhum teto.**
- Vê: o modelo vem instalado sem "silêncio máximo", sem limite de repetições e sem "só se a equipe já respondeu". Na primeira varredura ele alcança todo contato calado há mais de 1 dia, inclusive quem sumiu há meses. Quem nunca responde recebe de novo o "Esta é a última vez que eu apareço sobre isso", e o ciclo não termina. Também alcança o paciente que escreveu e não foi atendido. A promessa "com a marcação em aberto" não é conferida por nenhum gatilho.
- Causa: `lib/followup/modelos/clinica.ts:54-58` (gatilho só com `threshold_minutes`). As três falhas são justamente os avisos de `lib/followup/validate-publish.ts:157-177`.
- Conserto: pôr `max_silence_minutes`, `max_enrollments_por_contato` e `exige_resposta_da_equipe` no gatilho do modelo, e um teste que reprova modelo que dispare aviso de publicação.
- Conferência: confirmado no código.

**A2. Follow-ups: "Desativar" um fluxo não para os envios que já estão em andamento.**
- Vê: o fluxo aparece desativado, mas quem já estava inscrito continua recebendo mensagens. Nenhum texto avisa isso.
- Causa: `app/api/v1/ai/followup-flows/[id]/disable/route.ts:50-53` só grava `status='disabled'` no ponteiro. O motor (`lib/followup/engine.ts:1305`, `:1475`) lê o ponteiro sem olhar o status, e o banco não tem gatilho que cancele inscrições.
- Conserto: ao desativar, cancelar ou pausar as inscrições ativas do ponteiro (ou fazer o motor conferir o status) e dizer isso na confirmação.
- Conferência: confirmado no código (nenhum leitor do status). Não reproduzido.

**A3. Webhooks: "Enviar lead de teste" cria um cliente real e dispara as automações.**
- Vê: o teste grava contato e negócio de verdade com o telefone fixo 11999990000, sem marca de teste. As automações "Quando entrar um contato novo" e os fluxos rodam, então uma regra de boas-vindas mandaria WhatsApp para +5511999990000, que pode ser de alguém real. A cada teste o funil acumula um "Lead de Teste".
- Causa: `app/app/webhooks/_components/SourceDetail.tsx:255-262` faz POST real na fonte; `app/api/v1/webhooks/in/[token]/route.ts:1152` chama `kickLocalPipeline`.
- Conserto: marcar o envio como teste (flag no payload) e pular automações, fluxos e envio para ele, ou validar sem gravar.
- Conferência: confirmado no código.

**A4. Respostas rápidas (Inbox): escolher uma resposta rápida apaga, sem aviso, o que o atendente já tinha digitado.**
- Vê: o texto digitado no campo some e é trocado pelo da resposta. No caminho com imagem, o campo é zerado.
- Causa: `components/inbox/Composer.tsx:454` (`setText(conteudo)` em vez de inserir no cursor) e `:545` (`setText("")`).
- Conserto: inserir o conteúdo na posição do cursor e manter o texto existente.
- Conferência: confirmado no código.

**A5. Agentes: os limites "Volume de texto por atendimento" e "Custo máximo por atendimento" não são aplicados.**
- Vê: o dono preenche os limites, salva e publica, e acredita que limitou o gasto. Nada limita.
- Causa: `app/app/ai/agents/[id]/_components/AgentForm.tsx:1055` e `:1068` gravam `token_budget`/`cost_budget_cents`. Nenhum arquivo de `lib/agent-engine` lê esses campos. Só o runtime antigo `lib/ai/runtime/agent.ts` os lia, e ele está `@deprecated` e fora do caminho quente.
- Conserto: aplicar os dois limites no agent-engine ou tirar os campos da tela até existirem.
- Conferência: confirmado no código.

**A6. Agentes: as chaves "Não responder em grupos" e "Não responder às mensagens do próprio número" e o seletor "Quantos atendimentos ao mesmo tempo" não fazem nada.**
- Vê: o dono muda as opções e o comportamento continua igual. Grupo é sempre pulado, com a chave ligada ou desligada.
- Causa: `TriggerEditor.tsx:137`, `:146`, `:170` gravam `ignore_groups`, `ignore_self` e `concurrency`, e nada em `lib/agent-engine` os lê. O pulo de grupo é fixo em `lib/agent-engine/edge/crm/drain.ts:295-302`.
- Conserto: tirar os controles (grupo já é regra dura) ou ligá-los ao motor.
- Conferência: confirmado no código.

**A7. Agentes: numa instalação sem chave de IA, não dá para salvar nem o rascunho das instruções.**
- Vê: o dono escreve o prompt, clica em salvar e é barrado por "Escolha a chave de acesso…". O texto não é guardado.
- Causa: `AgentForm.tsx:479-480` põe a falta de credencial na validação que impede salvar. O mesmo arquivo (`:489-500`) já tirou dessa validação a exigência do número, pelo mesmo motivo.
- Conserto: levar a exigência de chave para `bloqueioDePublicacao`, como foi feito com o número.
- Conferência: confirmado no código.

**A8. Follow-ups: dois textos dizem que nenhum fluxo dispara sem um agente publicado, e isso é falso para fluxos de texto fixo.**
- Vê: "Sem um agente publicado armando o fluxo, o gatilho automático não dispara" (galeria de modelos) e "Os fluxos abaixo só entram em ação… se este agente estiver publicado" (editor do agente). 3 dos 4 modelos de clínica disparam sem agente. Quem lê configura um agente sem precisar, ou não percebe que o fluxo já está mandando mensagens.
- Causa: `app/app/ai/followups/_components/ModelosDialog.tsx:235` e `AgentForm.tsx:1419`. A regra real está em `lib/followup/agent-followup-gate.ts:72-97` (`fluxoPedeAgente`, `agenteDoGatilhoAutomatico`).
- Conserto: o texto passa a dizer que só fluxos com passo de IA precisam de agente e, na galeria, indica por modelo.
- Conferência: confirmado no código.

**A9. Contatos: um cliente que já teve qualquer compromisso na Agenda nunca pode ser excluído, e o aviso manda fazer algo impossível.**
- Vê: "Cancele ou apague o compromisso antes de excluir". Cancelar não resolve, e a Agenda não tem como apagar um compromisso.
- Causa: `app/api/v1/contacts/_handler.ts:1011-1013` e `:1064-1069` contam toda linha de `calendar_appointments`, sem olhar o status. O DELETE da Agenda é cancelamento (`app/api/v1/agenda/agendamentos/route.ts:321-325`). O texto está em `hooks/contacts/useDeleteContact.ts:25-28`.
- Conserto: contar só compromissos não cancelados, ou desvincular os cancelados, e corrigir o texto.
- Conferência: confirmado no código.

**A10. Tarefas: a confirmação de apagar fica armada indefinidamente.**
- Vê: o atendente clica na lixeira e desiste. O botão "Confirmar" fica invisível (opacidade) e armado, e na próxima passada do mouse um único clique apaga a tarefa. Isso vale também na ficha do negócio.
- Causa: `app/app/tasks/_components/ListaDeTarefas.tsx:178-199` (o `onBlur` só está na lixeira, que sai da tela; o "Confirmar" não tem `onBlur` nem tempo limite); mesma lista em `components/kanban/TarefasDoNegocio.tsx:113`.
- Conserto: desarmar no `onBlur`/`onMouseLeave` do "Confirmar" ou após alguns segundos.
- Conferência: confirmado no código.

**A11. Agenda: "Remarcar" usa o tipo e a pessoa escolhidos na tela, e não os do compromisso.**
- Vê: com "Horários livres de" em "Sessão de fisioterapia" (Ana), remarcar uma consulta do Carlos mostra "Ana · 50 min" e os horários da Ana. Ao confirmar, a consulta do Carlos vai para um desses horários, mesmo fora do expediente dele, sem aviso. O arraste na grade tem o mesmo efeito.
- Causa: `app/app/agenda/_client.tsx:352-356` (horários consultados com `tipo.id` da página), `:862-880` (painel com o tipo da página) e `:1116-1119` (`onRemarcar` só guarda o id). Para usuário, o servidor só confere sobreposição com o tipo e o dono originais (`app/api/v1/agenda/agendamentos/_handler.ts:571-597`, `:819-821`).
- Conserto: abrir a remarcação com o `event_type_id` e o dono do próprio compromisso.
- Conferência: confirmado no código.

**A12. Agenda: a ajuda do campo de convidado promete um convite que só existe com o Google conectado.**
- Vê: "O cliente com e-mail na ficha já recebe o convite." Sem Google, ninguém recebe nada, e o cliente pode faltar porque nunca foi avisado.
- Causa: `app/app/agenda/_client.tsx:829-834`. Os e-mails do cliente e do convidado só são usados em `lib/agenda/google/sync-executor.ts:522-524` e `:692-694`.
- Conserto: mostrar a frase e o campo só quando a agenda do responsável estiver conectada ao Google.
- Conferência: confirmado no código.

**A13. Radar: lista propostas mesmo com o recurso Propostas desligado, e o link dá 404.**
- Vê: o quadro "proposta vencida sem retomada" aparece com o link `0007/2026`, e o link abre "404 — Página não encontrada". O caso real é a empresa que usou Propostas e depois desligou.
- Causa: `lib/leads/radar-de-risco.ts:456-461` consulta `crm_proposals` sem olhar a capacidade. `app/app/radar/_components/RiskRadarList.tsx:153` e `:185` sempre mostram o link, e `app/app/proposals/layout.tsx:20` responde `notFound()`.
- Conserto: com "propostas" fora de `capacidadesDaOrganizacao`, não consultar nem desenhar os dois quadros.
- Conferência: confirmado no código.

**A14. Funis: o aviso "Sem resposta há X" mostra o tempo na etapa, mas o que decide "esfriando" é o tempo desde a última atividade.**
- Vê: um negócio sem atividade há 29h, que entrou na etapa há 5h, mostra "Sem resposta há 5h" com a borda laranja. O número diminui a urgência real.
- Causa: o rótulo usa `hoursInStage` (`lib/kanban/card-state.ts:111` e `:225`; a linha `:834` citada pelo agente não é o ponto), e o risco vem de `classifyRisk` sobre `last_activity_at` (`lib/leads/risk-radar.ts:70`).
- Conserto: o rótulo de esfriando passa a usar horas desde a última atividade (o radar já devolve `hours_since_activity`).
- Conferência: confirmado no código.

**A15. Webhooks: "Últimos recebimentos" pinta de verde envios que o CRM recusou.**
- Vê: um envio sem nome, telefone nem e-mail aparece como "Não entrou" em Leads recebidos e com bolinha verde no painel da fonte.
- Causa: `app/api/v1/webhooks/in/[token]/route.ts:268-282` grava o log com `valid_signature: true, status: 'received'` antes de mapear e criar o lead. `SourceDetail.tsx:681` só pinta de vermelho quando `valid_signature === false`.
- Conserto: atualizar o status do log com o desfecho (criado/recusado + motivo) e colorir pelo desfecho.
- Conferência: confirmado no código.

**A16. Meta Ads: salvar a conexão não testa o token.**
- Vê: um token vencido, curto demais ou sem `ads_read` mostra "Conexão salva." e só falha depois, na tela de Meta Ads.
- Causa: `app/actions/settings/updateAdInsightsConnection.ts:148-161` só cifra e grava. O próprio código chama isso de "erro nº 1" (`app/app/settings/meta-ads/page.tsx:70-73`).
- Conserto: chamar `/me/adaccounts` antes de gravar e devolver o erro da Meta traduzido.
- Conferência: confirmado no código.

**A17. Conexões: a aba Telefone deixa cadastrar números sem avisar que a telefonia é um módulo opcional e desligado por padrão.**
- Vê: o número fica cadastrado e nunca toca, e a tela não explica por quê. A aba "Chamada de voz" tem esse aviso.
- Causa: `components/connections/TelefoniaClient.tsx:104-120` não tem aviso de módulo (depende de `COMPOSE_PROFILES=telefonia` e de tronco SIP, segundo `.env.example:156-172`, que não foi aberto nesta conferência).
- Conserto: detectar o módulo desligado e mostrar o mesmo aviso de `CanalVozClient.tsx:145`, bloqueando o cadastro.
- Conferência: confirmado no código (falta de aviso).

**A18. Casos: a linha do tempo atribui a "Você" toda decisão humana, seja quem for o autor.**
- Vê: o Carlos abre um caso que a Helena concluiu e lê "Você concluiu o caso". Não há como saber quem decidiu.
- Causa: `lib/ai/case-copy.ts:133-137` e `:151-152` (`HUMAN_ACTION_LABEL` sem olhar `actor_user_id`). Só a origem WhatsApp é tratada (`:146-150`).
- Conserto: o GET do caso devolve o nome do autor; "Você" só quando `actor_user_id` é o usuário logado.
- Conferência: confirmado no código.

---

## A · Gravidade média

**A19. Radar: continua mostrando a demanda depois que o próximo passo é anotado na Inbox.** Vê: voltar ao Radar pelo menu em menos de 30s ainda mostra o cliente em "sem próximo passo". Causa: o `salvar()` de `components/inbox/CRMSidePanel.tsx:204-212` não invalida `["leads-at-risk"]` (`hooks/leads/useAtRiskLeads.ts:33`), e o `staleTime` é 30s (`lib/query/client.ts:9`). Conserto: invalidar `["leads-at-risk"]` no sucesso do PATCH de demanda. Conferência: confirmado no código.

**A20. Radar: há dois "próximo passo" diferentes, e anotar um não apaga o aviso do outro.** Vê: a linha do Radar diz "Sem próximo passo agendado"; o atendente anota o próximo passo da demanda e o aviso continua. Causa: `RiskRadarList.tsx:295` (sem agendamento nem retorno) contra `CRMSidePanel.tsx:1079` (`demandas.proximo_passo`). Conserto: renomear o aviso da linha ("Sem retorno agendado") ou contar o `proximo_passo` da demanda. Conferência: confirmado no código.

**A21. Radar: assumir pelo Radar um negócio que está com um agente de IA não muda o que a linha mostra.** Vê: a conversa passa para a pessoa, o botão some e a linha continua "Agente: <nome>". Causa: `owner_kind === "ai"` tem precedência sobre `assignee_kind` em `RiskRadarList.tsx:236-240`. Conserto: quando `assignee_kind === "user"`, mostrar "Agente: X · com atendente". Conferência: confirmado no código.

**A22. Funis: um cartão marcado como ganho ou perdido mantém a borda laranja e o "Sem resposta" por até 60s.** Causa: a marcação de esfriando vem de `useAtRiskLeads` (`components/kanban/KanbanBoard.tsx:121-139`, polling de 60s), e ganhar/perder só invalida o quadro (`hooks/kanban/useUpdateLead.ts`, `onSettled`). Conserto: invalidar `["leads-at-risk"]` em ganhar, perder e mover. Conferência: confirmado no código.

**A23. Funis: a janela "Marcar como perdido" manda cadastrar motivos em "Configurações › Funis", e esse caminho não existe.** Os motivos ficam em "Etapas do funil", no grupo CRM. Causa: `components/kanban/LoseLeadDialog.tsx:212`; rótulo real em `lib/navigation/catalogo.ts:519-520`. Conserto: apontar "CRM › Etapas do funil", com link. Conferência: confirmado no código.

**A24. Agenda: o quadro "Sincronização Google" acusa pendência numa instalação sem Google.** Vê: todo compromisso mostra "Há alterações aguardando sincronização." e, para o dono, "Tentar sincronizar novamente". Causa: `app/api/v1/agenda/agendamentos/[id]/route.ts:87` calcula `configured` pela forma de publicação do tipo, sem olhar se existe Google configurado ou conectado; `components/agenda/SincronizacaoDoCompromisso.tsx:66-75` e `:158-160`; desenho incondicional em `DetalheDoCompromisso.tsx:140-147`. Conserto: `configured = false` quando não há credenciais nem conexão do responsável, o que leva ao estado "Somente no CRM". Conferência: confirmado no código.

**A25. Agenda: no painel de detalhes, o botão de cancelar acende com 1 caractere, mas a API exige 3.** Vê: digitar "ok" e clicar dá erro. Causa: `components/agenda/DetalheDoCompromisso.tsx:366` (`!reason.trim()`) contra `app/api/v1/agenda/agendamentos/route.ts:136` (`min(3)`); a lista já usa 3 (`_client.tsx:1051`). Conserto: `reason.trim().length < 3`. Conferência: confirmado no código.

**A26. Agenda: na visão de mês, as setas andam 30 dias, não um mês.** Vê: partindo de 31/01, um clique leva a 02/03 e fevereiro some. Causa: `app/app/agenda/_client.tsx:452` (`passo = 30`, usado em `:570` e `:579`). Conserto: `addMonths` na visão de mês. Conferência: confirmado no código.

**A27. Respostas rápidas: o menu "/" vazio diz "Nenhum template. Crie em Configurações."** A tela se chama "Respostas rápidas" e fica em Atendimento. Causa: `components/inbox/composer/TemplateMenu.tsx:35`. Conserto: "Nenhuma resposta rápida. Crie em Atendimento › Respostas rápidas", com link. Conferência: confirmado no código.

**A28. Respostas rápidas: uma resposta excluída continua por até 60s na Inbox dos colegas, e a imagem dela falha ao ser usada.** Causa: `hooks/inbox/useMessageTemplates.ts:38` (`staleTime: 60_000`, sem tempo real). Conserto: reconsultar ao abrir a barra ou o "/", ou tratar o 404 do anexo com um aviso claro. Conferência: confirmado no código.

**A29. Contatos: ordenar por "Nome" não ordena pelo nome que aparece na lista.** Vê: Mariana, Roberto, Juliana… em vez de A–Z; quem não tem `display_name` vai para o fim. Causa: `components/contacts/ContactsTable.tsx:242` (`column="display_name"`) com `app/api/v1/contacts/_handler.ts:174`, enquanto a coluna exibe `rotuloParaAEquipe` (que prioriza `name`). Conserto: ordenar pela mesma cadeia do rótulo (coluna gerada ou `coalesce`). Conferência: confirmado no código.

**A30. Contatos: as opções do filtro de etiquetas vêm só dos contatos já filtrados.** Vê: depois de marcar uma etiqueta, as outras somem do menu; "Qualquer uma (OU)" não consegue juntar etiquetas, e quando o filtro zera a lista o botão "Tag" fica desabilitado e só sai por "Limpar filtros". Causa: `app/app/contacts/_client.tsx:133-145` (opções a partir de `allContacts`) e `:283` (`disabled={tagOptions.length === 0}`). Conserto: buscar as etiquetas da organização inteira e manter sempre as já marcadas. Conferência: confirmado no código.

**A31. Contatos: uma busca ou filtro sem resultado mostra "Nenhum contato ainda — Contatos chegam automaticamente via WhatsApp ou Nuvemshop".** Isso também acontece ao digitar só 1 letra, e dá a entender que a base está vazia. Causa: `app/app/contacts/_client.tsx:447-450` usa `EmptyContacts` (`components/empty/variants.tsx:61-62`) sem distinguir filtro de base vazia. Conserto: estado "Nenhum contato para este filtro" com "Limpar filtros". Conferência: confirmado no código.

**A32. Contatos: o botão "Iniciar conversa" aparece sem número de WhatsApp conectado e devolve "Sessão de canal não encontrada."** Causa: `components/contacts/ContactsTable.tsx:369-380` (só olha `phone_number`) e `app/api/v1/conversations/open-with-contact/route.ts:67-68`. Conserto: esconder ou desabilitar o botão sem sessão ativa, com um aviso que leve a Conexões. Conferência: confirmado no código.

**A33. Contatos: "Duplicados" e "Juntar" aparecem para qualquer papel, mas a rota exige gerente.** Vê: o atendente confirma a junção e recebe 403. Causa: `app/app/contacts/_client.tsx:214-217` (sem portão) contra `app/api/v1/contacts/merge/route.ts:85`. Conserto: esconder para papel abaixo de manager. Conferência: confirmado no código (rota).

**A34. Contatos: "Preencher campo personalizado" em lote pede o nome interno do campo em texto livre, e o servidor grava qualquer chave.** Vê: um erro de digitação cria um campo que nenhuma tela mostra, e a ação parece ter dado certo. Causa: `components/contacts/BarraDeContatosEmLote.tsx:290-297` e `app/api/v1/contacts/bulk/route.ts:187-198`. Conserto: um seletor com os campos definidos no funil, e o servidor recusa a chave desconhecida. Conferência: confirmado no código.

**A35. Contatos: a caixa "selecionar todos" marca, mas não desmarca.** Causa: `ContactsTable.tsx:222-236` chama `selecionarTodos`, que só soma (`hooks/contacts/useSelecaoEmLote.ts:32-38`). Conserto: alternar (limpar os visíveis quando todos já estão marcados). Conferência: confirmado no código.

**A36. Contatos: a janela de exclusão diz só "remove X e a conversa associada".** Não avisa que os negócios do cliente ficam sem cliente (`crm_leads ON DELETE SET NULL`) nem que as mensagens somem com a conversa. Causa: `ContactsTable.tsx:419`. Conserto: listar o que será apagado e o que ficará órfão, como já se faz com compromissos. Conferência: confirmado no código (texto). O efeito em `crm_leads` não foi conferido no schema.

**A37. Tarefas: os botões Editar e Apagar ficam invisíveis em tela de toque.** Causa: `app/app/tasks/_components/ListaDeTarefas.tsx:162` (`opacity-0` + `group-hover`/`focus-within`). Conserto: visíveis por padrão em `@media (hover: none)`. Conferência: confirmado no código.

**A38. Tarefas: há duas réguas de "atrasada".** Vê: uma tarefa de hoje às 8h, vista às 14h, fica no grupo "Hoje" e ao mesmo tempo conta como "1 atrasada" no card e na ficha. Causa: `lib/tarefas/tipos.ts:179-180` (grupo pelo início do dia) contra `:113-120`/`:136-148` (hora exata). O comentário de `:131-134` afirma que é a mesma régua. Conserto: uma função só para as duas. Conferência: confirmado no código.

**A39. Agentes: um agente pausado aparece com o selo "Rascunho", e o filtro "Pausado" nunca encontra nada.** Também não existe a opção "Rascunho" no filtro. Causa: `app/app/ai/agents/_components/AgentStatusBadge.tsx:44-45` converte "parado" em `draft`; o filtro oferece `paused` (`AgentsListFilters.tsx:49`). Conserto: distinguir `paused` (com `paused_at`) de `draft` (nunca publicado) e alinhar o filtro. Conferência: confirmado no código.

**A40. Agentes: em Execuções, o detalhe mostra "Steps 0" e "Sem trace disponível." em todo atendimento, e "Ver conversa" nunca aparece.** Causa: a rota devolve `steps_count`, `tool_calls` e `conversation_id` como `null` de propósito (`app/api/v1/ai/agents/[id]/runs/route.ts:106`, `:121-122`), e `app/app/ai/agents/[id]/_components/RunDetailDrawer.tsx:87` (e `RunsTable.tsx:141`) troca `null` por 0. Conserto: mostrar "—" para null e esconder o trace quando não existe essa informação. Conferência: confirmado no código.

**A41. Agentes: "Aplicar como versão nova" publica na hora, sem rascunho e sem a confirmação que o botão Publicar tem.** Causa: `app/api/v1/ai/agents/[id]/proposals/[pid]/apply/route.ts` (o cabeçalho diz que "o clique É o gate humano") e `ProposalsPanel.tsx:101` chama direto. Conserto: abrir o mesmo `PublishConfirmDialog` antes de aplicar. Conferência: confirmado no código.

**A42. Agentes: o selo "Publicado" não avisa quando o agente não pode responder por falta de chave.** Causa: `deriveAgentStatus` e `AgentCard.tsx` não olham credencial. Só acontece se a chave sumir depois da publicação (publicar já exige chave). Conserto: um selo "Sem chave" quando `credential_id` é nulo e a instalação não tem chave do provedor. Conferência: confirmado no código (o selo não considera chave).

**A43. Follow-ups (plausível): no WhatsApp oficial, a mensagem de texto fixo fora da janela de 24h sai sem conferência.** Os modelos de clínica disparam depois de 24h ou mais de silêncio, então nesse canal a Meta tende a recusar. Causa: `lib/followup/enviar-texto-fixo.ts:293-299` (só o caminho com mídia é conferido). Conserto: aplicar a mesma régua ao texto e avisar no construtor e na galeria. Conferência: confirmado que o texto não é conferido; a recusa da Meta não foi reproduzida.

**A44. Casos: um caso "Aguardando o cliente" nunca expira.** O evento `lead_unresponsive` existe no CHECK e tem rótulo, mas ninguém o emite, e o vigia de casos parados só olha `awaiting_human`. Causa: `lib/ai/case-copy.ts:122`, `app/api/v1/cron/case-stale-watcher/route.ts:123`, `:196`. Conserto: o vigia também expira `awaiting_lead` após um prazo e emite `lead_unresponsive`. Conferência: confirmado no código.

**A45. Conexões: excluir um número que caiu não mostra o que está ligado a ele.** Vê: "Não foi possível verificar o que está ligado a este número", justamente quando o serviço do WhatsApp não responde. Causa: `app/api/v1/channel-sessions/[id]/route.ts:178` calcula o impacto e `:211-213` devolve 502 antes de entregá-lo. Conserto: com `impact=1`, devolver o impacto mesmo com falha na conferência ao vivo. Conferência: confirmado no código.

**A46. Conexões: a frase "N números conectados" conta todos os números, inclusive os que caíram.** Causa: `components/connections/ConnectionsClient.tsx:395` (`list.length`). Conserto: contar só os de status `WORKING`, ou trocar por "N números na lista". Conferência: confirmado no código.

**A47. Conexões: sem canal oficial, "Templates da Meta" manda conectar em "Conexões WhatsApp", um lugar que não existe.** O certo é a sub-aba "Conexão" de "API Oficial (Meta)". Causa: `components/connections/TemplatesClient.tsx:168-169`. Conserto: corrigir o texto e pôr link para a sub-aba. Conferência: confirmado no código.

**A48. Conexões: apagar o "Teto diário de envios" e salvar não remove o teto.** O campo vazio sugere "sem teto definido", mas o 300 continua. Causa: placeholder em `components/connections/AntiBanSheet.tsx:522`; o campo vazio é omitido do envio (`:206-208`); a coluna é `NOT NULL DEFAULT 300` (`supabase/baseline.sql:1340`). Conserto: placeholder "300 (padrão)" e validação de campo obrigatório. Conferência: confirmado no código.

**A49. Conexões (provável): fechar a janela "Conectar novo WhatsApp" sem parear deixa um número órfão, e a faixa vermelha de desconectado aparece em todas as telas.** Causa: a sessão é criada no clique (`ConnectionsClient.tsx:274-282`), e `SCAN_QR_CODE` está em `STATUS_QUE_AVISAM` (`lib/channels/health.ts:53`). Conserto: não avisar sobre sessão que nunca chegou a `WORKING`, e limpar pareamentos abandonados. Conferência: criação no clique e status de aviso confirmados; a falta de limpeza não foi conferida.

**A50. Conexões (provável): a faixa de conexão caída não acompanha a navegação.** Ela não aparece quando o número cai nem some quando ele volta, até a página ser recarregada. Causa: `components/app/ConexaoCaidaBanner.tsx:43` recebe a lista do layout de servidor (`app/app/layout.tsx:144`, `:321`) e não consulta nem faz `refresh` sozinha. Conserto: consulta própria com polling ou tempo real. Conferência: confirmado no código (sem refresh); o efeito não foi reproduzido.

**A51. Webhooks: a chave "Fonte ativa" volta à posição antiga depois de pausar ou ativar.** Vê: aparece "Fonte pausada.", mas a chave e o selo "Ativa" continuam até o painel ser fechado. Causa: `app/app/webhooks/_components/SourceDetail.tsx:705` lê o retrato `source.is_active`, e o `onSuccess` (`:711-712`) só mostra o aviso. Conserto: guardar a resposta do PATCH em estado local, como as outras chaves do painel. Conferência: confirmado no código.

**A52. Webhooks: o "Formulário pronto" sem "URL de obrigado" mostra JSON cru ao visitante.** Vê: o visitante vê `{"data":{"lead_id":…}}` ou o JSON de erro. Causa: `app/api/v1/webhooks/in/[token]/route.ts:337-341`. Conserto: para envio de formulário, responder com uma página HTML de agradecimento (e uma de erro). Conferência: confirmado no código.

**A53. Webhooks: depois de criada a fonte, não dá para ver nem editar a "URL de obrigado", o funil ou a etapa de entrada.** Causa: os campos só existem em `CreateSourceDialog.tsx`; `SourceDetail.tsx` não usa `redirect_to`, `pipeline_id` nem `stage_id`. Conserto: levar os três campos ao painel da fonte. Conferência: confirmado no código.

**A54. Webhooks (plausível): a orientação para WordPress não funciona com o Contact Form 7.** Os campos `your-name` e `your-email` caem em `sem_campo_mapeavel`; a própria semente mostra a recusa. Causa: o texto de `SourceDetail.tsx:502-506`. Conserto: mapear os nomes do CF7 ou orientar o mapeamento. Conferência: o texto está confirmado; o mapeamento não foi conferido.

**A55. Desempenho: o papel "viewer" vê "Desempenho" no menu e cai numa tela de erro que culpa a rede ou o plano.** Causa: `lib/navigation/catalogo.ts:845-852` não tem `minRole`, todas as rotas exigem `agent` (`app/api/v1/metrics/atrito/route.ts:99`, `attendants/route.ts:60`, `serie/route.ts:66`), e o texto do erro está em `app/app/metrics/_components/MetricsClient.tsx:104-105`. Conserto: `minRole: "agent"` no catálogo. Conferência: confirmado no código.

**A56. Desempenho: "Passagens para humano" só conta passagens com negócio ligado.** Causa: `supabase/baseline.sql:32139` conta `crm_lead_activities type='handoff_triggered'`, gravada só quando há lead (`lib/mcp/tools/handoff.ts:6`). Conserto: contar pelo `event_log` `ai.handoff_triggered`. Conferência: confirmado no código.

**A57. Meta Ads: a tela diz que os números vêm "no momento em que você clica em Atualizar", mas a busca dispara sozinha.** Vê: a busca roda ao abrir a tela e a cada troca de conta ou de período, e cada uma gasta 2 chamadas da cota da Meta. Sem conta ligada, o botão citado nem existe. Causa: `app/app/ads/meta/page.tsx:67`; `hooks/ads/useMetaAds.ts:74-93` (`enabled: Boolean(contaId)`, a `queryKey` inclui o período). Conserto: buscar só no clique (`enabled: false` + `refetch`) ou corrigir a frase. Conferência: confirmado no código.

**A58. Atividades: o número da aba "Por etiqueta" não bate com a lista que o link abre.** Vê: a linha mostra "2" e a Inbox abre com 4. Causa: a tabela conta só a etiqueta da conversa, no período (`app/api/v1/reports/tags/route.ts:350`); o link (`TagReportClient.tsx:155`) não leva o período, e o filtro da Inbox inclui a etiqueta da ficha (`lib/inbox/marcador-da-conversa.ts:85`). Conserto: a mesma régua nos dois lados (o link leva período e modo "só conversa", ou a tabela conta também a ficha). Conferência: confirmado no código.

**A59. Inbox: o atalho "?" (Shift+/) não abre "Atalhos de teclado", que é a única porta para essa ajuda.** Reproduzido: Shift+/, "?" e Shift+Slash não abrem nada; "j" funciona. Causa: `components/inbox/InboxKeyboardShortcuts.tsx:71` registra `"shift+/"`, combinação que a biblioteca de atalhos não casa quando o teclado produz "?". Conserto: registrar pela tecla produzida (`"?"` com `useKey`) e cobrir com teste de tela. Conferência: a linha foi confirmada e o defeito reproduzido.

**A60. Inbox: a etiqueta adicionada ao contato não aparece na ficha quando a conversa aberta não está na aba atual da lista.** Reproduzido 2x: na aba Fila, com `?id=` de uma conversa que está em Minhas, o PATCH devolve 200 e o banco tem a tag, mas a ficha não a mostra; com `?filter=all` ela aparece. Causa: não localizada nesta conferência (provável leitura da ficha a partir do cache da lista da aba). Conserto: a ficha passa a ler o contato da query própria da conversa, não da lista. Conferência: reproduzido; causa não apurada.

**A61. Inbox: depois de "Assumir e responder" no cartão de passagem, a linha "Assumida por <nome>" demora ou só aparece ao recarregar.** Causa: `hooks/inbox/useClaimConversation.ts:22-23` e `:27-28` invalidam `["conversations"]` e `["conversation", id]`, mas não `["passagens", id]` (`hooks/inbox/usePassagensDaConversa.ts:37`). Conserto: invalidar `["passagens", conversation_id]` no sucesso. Conferência: confirmado no código e reproduzido.

**A62. Inbox: a linha da lista mostra só as etiquetas da ficha do contato, nunca as da conversa.** Vê: quem chega pelo link da aba Por etiqueta vê conversas sem nenhuma etiqueta à vista, o que parece filtro quebrado. Causa: `components/inbox/ConversationListItem.tsx:172` (`c.tags`). Conserto: unir as etiquetas da conversa e da ficha na linha. Conferência: confirmado no código.

---

## A · Gravidade baixa

| # | Tela | O que o usuário vê | Causa | Conserto | Conferência |
|---|---|---|---|---|---|
| A63 | Agenda | Toda linha da lista diz "Agendamento", nunca o tipo ("Sessão de fisioterapia") | `app/app/agenda/page.tsx:301-321` não monta `tipo`; `components/agenda/HistoricoDaAgenda.tsx:241` cai no fallback | Incluir o nome do tipo (join em `calendar_event_types`) | Confirmado |
| A64 | Agenda | "Mensagem do cliente usada como evidência" aparece em compromisso sem cliente, sempre vazia | `components/agenda/DetalheDoCompromisso.tsx:273-293`; a rota só busca mensagens com `contact_id` (`[id]/route.ts:48`) | Esconder sem `contact_id`; trocar "evidência" | Confirmado |
| A65 | Agenda | O cartão do Google mostra `GOOGLE_CALENDAR_CLIENT_ID/SECRET` e manda "registrar no console" a qualquer membro | `lib/agenda/google/config.ts:271-272`; `CartaoDaConexaoGoogle.tsx:96-110`; `page.tsx:272` passa sempre | Detalhe técnico só para admin | Confirmado |
| A66 | Agenda | Abrir pelo nome na lista perde o `?tipo=`, e o F5 volta ao primeiro tipo | `HistoricoDaAgenda.tsx:236` | Preservar `tipo` no link | Confirmado |
| A67 | Agenda | Compromisso sem tipo oferece Remarcar e responde "O tipo deste agendamento não existe mais." | `_handler.ts:572-579` | Esconder Remarcar sem tipo ou mensagem verdadeira | Confirmado |
| A68 | Agenda | O painel "Remarcar" não diz qual compromisso está sendo movido | sem arquivo citado | Cabeçalho com cliente, dia e hora, como no de cancelar | Visto em captura |
| A69 | Resp. rápidas | Áudio no "Enviar anexo" sem prévia; mostra `uuid.wav`, "Legenda" e "Remover imagem" | `components/inbox/composer/AttachmentPreviewDialog.tsx:62-66`, `:88` | Player de áudio, nome legível, rótulo genérico | Confirmado |
| A70 | Resp. rápidas | No menu "/", a resposta de áudio aparece sem o 🎧 e com a linha vazia | `TemplateMenu.tsx:44-45` (a barra tem: `BarraDeRecursos.tsx:42`) | Mesmo marcador da barra | Confirmado |
| A71 | Inbox | O separador "Ontem" cobre o cabeçalho do cartão "Por que a IA passou para você" | sem arquivo citado | Ajustar empilhamento (z-index/sticky) | Visto em captura |
| A72 | Funis | A aba Calendário diz "não tem campo de data" mesmo com "Fechamento previsto" | `components/kanban/CalendarioDoFunil.tsx:168-174` | Oferecer o fechamento previsto como campo padrão | Confirmado |
| A73 | Funis | Organização nova nasce com o funil de e-commerce "Pedidos" e motivos de perda de loja | `supabase/baseline.sql:716-729` | Rever o padrão de quem pula a etapa de funil do onboarding | Parcial: o onboarding já oferece funis por nicho (`lib/onboarding/pacotes-de-funil.ts`); o de e-commerce fica para quem pula |
| A74 | Contatos | A ficha não oferece "Iniciar conversa" para contato com telefone e sem conversa | `app/app/contacts/[id]/_client.tsx:362`; `components/kanban/ConversaNoDossie.tsx:37-41` | Passar `contactId`/`phone` | Confirmado |
| A75 | Contatos | CSV exportado com vírgula e cabeçalhos em inglês; no Excel pt-BR cai numa coluna só (plausível) | `lib/contacts/exportar.ts:111-113` | `;` + cabeçalhos em pt, ou opção | Confirmado (formato); o efeito no Excel não foi testado |
| A76 | Tarefas | No card, o selo de tarefas encavala com "agora em <etapa>" | `components/kanban/KanbanCard.tsx:304-316` | Deixar o selo encolher/quebrar | Estrutura confirmada; sobreposição vista em captura |
| A77 | Tarefas | O calendário abre "Editar tarefa" para quem só lê, e Salvar dá 403 | `CalendarioDeTarefas.tsx:141-144` ignora `podeEditar` | Abrir só leitura sem permissão | Confirmado |
| A78 | Tarefas | "+N mais" no calendário não é clicável | `CalendarioDeTarefas.tsx:159-163` | Abrir a lista do dia | Confirmado |
| A79 | Agentes | O filtro "Arquivado" devolve vazio sem "Incluir arquivados" | `AgentsList.tsx:33-34` | Escolher "Arquivado" implica incluir | Confirmado |
| A80 | Agentes | "Despausar" aparece para agente nunca publicado e sempre falha | `AgentRowMenu.tsx:49`; `_actions.ts:103-108` | Mostrar só com `paused_at` | Confirmado |
| A81 | Agentes | "Reverter" aparece na própria versão publicada e cria uma cópia idêntica | `VersionHistory.tsx:140-141` | Excluir a versão vigente | Confirmado |
| A82 | Agentes | Dois cartões "Estilo de resposta"; o segundo diz "Desligada por você" sem ninguém ter escolhido | `AjustesDeEstilo.tsx:29`, `:45-47` | Renomear e dizer "Desligada (padrão)" | Confirmado |
| A83 | Agentes | "Fuso horário" é texto livre esperando `America/Sao_Paulo` | `TriggerEditor.tsx:200-206` | Seletor de fusos (`Intl.supportedValuesOf`) | Confirmado |
| A84 | Agentes | Com alteração não salva num agente publicado, o aviso diz "Sem rascunho para publicar." | `lib/ai/agents/bloqueio-de-publicacao.ts:102-104` (ordem) | Conferir `alteracoesNaoSalvas` antes | Confirmado |
| A85 | Follow-ups | O construtor abre um modelo instalado com "Início" e fim fora da tela | `lib/followup/modelos/escada.ts:44`; `FlowCanvas.tsx:384` sem `minZoom` | `minZoom` menor ou layout em mais de uma linha | Confirmado (sem `minZoom`) |
| A86 | Follow-ups | No editor do agente, rolado até Follow-up, a metade esquerda fica vazia | sem arquivo citado | Investigar o layout | Não confirmado (visto em captura) |
| A87 | Casos | Título longo nunca pode ser lido: cortado na lista e ausente no detalhe | `CaseList.tsx:134`; `CaseDetail.tsx` não usa `title` | Mostrar o título no detalhe e um `title=` na lista | Confirmado |
| A88 | Casos | "Abrir IA › Provedores" aparece para qualquer papel e leva a /403 | `CaseChatPanel.tsx:265-267`; `app/app/ai/providers/page.tsx:27` | Esconder abaixo de manager | Confirmado |
| A89 | Casos | Caso encerrado ainda mostra "Conversar sobre o caso — Pergunte antes de decidir." | sem linha citada (`CaseChatPanel.tsx`) | Trocar a frase ou ocultar quando fechado | Visto em captura |
| A90 | Casos | Em instalação nova, "Modelo padrão" aparece selecionado com a chave ainda não cadastrada | sem arquivo citado | Indicar "sem chave" no seletor | Visto em captura |
| A91 | Webhooks | Botões de copiar endereço e segredo sem `aria-label` | `SourceDetail.tsx:377-384`, `:581-588` | `aria-label` | Confirmado |
| A92 | Webhooks | A chave "Fonte ativa" não respeita `webhooks.manage` | `SourceDetail.tsx:704-716` (só `isPending`) | `disabled={!podeGerirWebhooks}` | Confirmado |
| A93 | Desempenho | "Ganhos por período" em "Mês" sobre 30 dias dá 1 ponto, invisível sem marcador | `app/api/v1/metrics/serie/route.ts:87`; `SeriePanel.tsx:168` (`dot={false}`) | Marcador quando há 1 ponto, ou janela por mês | Confirmado (código); não reproduzido |
| A94 | Desempenho | A nota de "Insistência" diz "demandas que passaram por atendimento humano", mas N conta demandas com caso do agente (plausível) | `lib/metrics/atrito.ts:219`; CTE `insistencia` no baseline | Alinhar o texto ao que é medido | Não conferido o CTE |
| A95 | Atividades | "Últimos 7 dias" desenha 8 barras (30 → 31), e a aba Por etiqueta usa outra régua | `lib/reports/atividades.ts:206-210` contra `lib/reports/etiquetas.ts:61-65` | Uma janela de dias inteiros para as duas | Confirmado |
| A96 | Atividades | Latente: ação de `actor_kind='contact'` teria bolinha cheia mas contaria em "Automático" | `lib/leads/activity-vocabulary.ts:368` contra `lib/reports/atividades.ts:188-192` | Alinhar os dois mapas | Confirmado (hoje ninguém grava `contact`) |
| A97 | Meta Ads | Nenhum passo a passo para gerar o token no Meta for Developers | `app/app/settings/meta-ads/page.tsx:76` | Guia curto com link e aviso de validade | Confirmado (texto) |

---

## B · Débito menor (cosmético)

- **Radar:** "venceu em 2026-10-22" com data crua (`RiskRadarList.tsx:157`); comentário desatualizado sobre "janelas fixas" (`lib/leads/risk-radar.ts:14`).
- **Agenda:** a mesma situação tem dois nomes, Confirmado/Realizado/Não compareceu na lista (`lib/agenda/tipos.ts:95-101`) e Agendado/Compareceu/Faltou no detalhe (`DetalheDoCompromisso.tsx:194-199`).
- **Respostas rápidas:** crases literais e "fila de anexos" na ajuda do áudio (`TemplateFormDialog.tsx:396`, `:323`; também no espanhol, `lib/i18n/dicionario.ts:10960`); "Scripts salvos" (`app/app/templates/page.tsx:31`, `catalogo.ts:214`); `aria-label` "Templates de script" (`TemplateMenu.tsx:32`).
- **Funis:** o slug técnico continua ao lado do nome depois de renomear ("Pacientes /pedidos", `app/app/kanban/_client.tsx:314`, `:590`); "neste pipeline" e placeholder de e-commerce no Novo Lead (`NewLeadDialog.tsx:353`); "custom fields" (`settings/tenant/pipelines/page.tsx:72`); no card esfriando, o rodapé fica "em <etapa>" sem tempo (`KanbanCard.tsx:314-316`).
- **Contatos:** origem crua na ficha, como "manual" e "import_csv" (`[id]/_client.tsx:440`); "Customer 360" no subtítulo (`_client.tsx:193`); jargão nos diálogos de lote e de fusão ("com auditoria por contato", "dono validado um a um", "vira registro de fusão", `BarraDeContatosEmLote.tsx:198-199`, `:238`); "Mudou de estágio" contra "etapa" (`lib/leads/activity-vocabulary.ts:107`, `:223`, que também aparece em Atividades); frase repetida no quadro Carteira.
- **Tarefas:** "Outubro De 2026" (`capitalize` em `CalendarioDeTarefas.tsx:85`).
- **Agentes:** jargão em inglês nas abas Teste, Execuções e Histórico ("provider", "dry-run", "sample", "Tokens in/out", "Custo (cents)", "Steps", "Diff", "superseded", "revert"; `TestPanel.tsx`, `VersionHistory.tsx`); dados crus no cartão ("rag_bot", selo "default", `AgentCard.tsx:78-80`, `:92-93`); "~N tokens" sem explicação e "Tools adicionadas"/"Prompt:" (`PublishConfirmDialog.tsx:100`, `:109`); textos da aba Segurança com "Jev" e frases contraditórias (não encontrados neste checkout, então vêm de outra branch ou do banco); o exemplo "8h às 18h" contra o padrão 8h–20h (não conferido).
- **Follow-ups:** a Fila mostra o id cru do passo ("resposta-2") em vez do nome (`app/api/v1/ai/followups/queue/route.ts:117`), e o estado vazio fala em "Enrollments ativos" (`QueueTab.tsx:199`); jargão "Handoff", "Rollback", "nó", "aresta", "Inscrições", "lead" (`FlowsList.tsx:176`, `PublishBar.tsx`, `NodePalette.tsx:39`).
- **Casos:** a descrição do menu, "Os atendimentos que o agente conduziu…", não é o que a tela mostra (`lib/navigation/catalogo.ts:652`); para quem já é admin, o aviso de provedor diz "Peça a quem administra" (`CaseChatPanel.tsx:262`).
- **Conexões:** status cru "WORKING" (`CanalOficialClient.tsx:96`, `CanalParceiroClient.tsx:156`); jargão "E.164", campos em "ms", "accountIds", "WABA", "Ressincronizar webhook"; a dica diz "Salvar" mas o botão é "Buscar perfis", e "Zernio" aparece solto (`RedesSociaisClient.tsx:247`); a variável `WACALLS_API_BASE_URL` aparece ao leigo (`CanalVozClient.tsx:148`).
- **Webhooks:** placeholder em espanhol "https://tusitio.com/gracias", fora do `t()` (`CreateSourceDialog.tsx:152`); código cru "http_404"/"redirect_not_followed" na Atividade (`ActivityTab.tsx:366`, `call-webhook.ts:491`); ajuda que aponta `docs/integracao/webhooks-de-saida.md` (`ActionConfigForm.tsx:943`); "Run" nas mensagens de reenvio (`automation-rules/runs/[runId]/resend/route.ts`); blocos técnicos (external_id, ai_service_consent) no topo do painel da fonte.
- **Desempenho:** `` `visibility_mode='own'` `` e "Limiar de 0,7" na tela (`lib/metrics/atrito.ts:291`); decimais com ponto, como "27.8%" (`atrito.ts:419`, `:423`); tempos acima de 1h só em minutos, como "136min 46s" (`lib/metrics/canais.ts:91-98`); "p90", "Vetos por execução", "Turnos (mediana)", "balde"; a descrição "nos últimos 30 dias" vale também para Funil e Previsão, que são retratos do momento (`catalogo.ts:848`).

---

## C · Fora do produto

16 itens, todos do ambiente de captura ou da semente do curso. O navegador da captura roda em en-US e mostra `mm/dd/yyyy`, AM/PM e "Choose File"; falta `locale: 'pt-BR'` e `timezoneId: 'America/Sao_Paulo'` no Playwright. O selo numerado do montador cobre textos e botões vizinhos. As capturas e a revisão são indexadas só por lição, e como `conhecendo-a-tela` existe em 7 módulos, as imagens se sobrescrevem. **Uma imagem de Respostas rápidas acabou expondo a URL de um webhook com o token: conferir antes de publicar.** Problemas da semente: a mensagem da Fernanda em falha sem explicação; horários de abertura que divergem entre lições; cronologia impossível (última atividade antes da criação); duplicados com telefone idêntico; o funil "Pacientes" com slug `/pedidos` e etapas de e-commerce; áudio 0:00 e imagem em quadrado verde; o contato-grupo "Turma de Pilates"; tarefas sem o emissor de produção, o que deixa a linha do tempo vazia; o modelo do agente gravado como `anthropic/claude-sonnet-4-6`, que deixa o campo "Modelo" vazio e repete o provedor no cartão (`curso/semear-demonstracao.ts:267`, quando o formato do produto é sem prefixo). A semente não é reiniciada entre capturas, então Leads de Teste se acumulam e uma edição "não aparece" nas fotos seguintes. O endereço aparece como `127.0.0.1` porque falta a URL pública. A ordem das respostas rápidas varia entre capturas, embora a ordenação tenha desempate (`ordem`, `updated_at`, `id`). A animação do gráfico foi capturada no meio.

## D · Revisão dos módulos novos — retomada de 26/10/2026

O curso passou a ter 61 módulos, 259 lições e 1097 passos. A autoria e as revisões dos 46 módulos novos foram lidas nesta retomada. O app fotografado destes módulos é a versão **1.89.0**, em 24 e 26/10; o checkout de montagem foi rebaseado depois. Portanto, estes relatos **não afirmam o estado atual do produto após o rebase**. Nenhum defeito do produto foi corrigido nesta tarefa.

O [inventário detalhado com procedência](achados-revisao-2026-10-26.json) preserva a descrição inteira, arquivos citados e origem de cada observação. Relatos cético e visual sobre a mesma causa foram unidos; prazo LGPD, rótulos de auditoria, recuperação SMTP, cobrança e extensões têm referências cruzadas, sem criar um segundo defeito para cada tela. As observações visuais adicionais estão separadas nesse arquivo e abaixo; continuam sem reprodução independente. Notas do ambiente/curso e sugestões rejeitadas têm categorias próprias com motivo, e não foram promovidas a defeitos confirmados.

**Régua de evidência:** “leitura” abaixo significa causa descrita na revisão do código, **não reprodução**. Hipóteses continuam identificadas como hipóteses no inventário. Só três causas foram reconferidas pontualmente nesta retomada: os status impossíveis de WhatsApp no painel, os escopos de tokens oferecidos sem consumidor e o CNPJ aceito como texto sem normalização. A prova de tela dos novos módulos é trabalho de recaptura/revisão visual do controlador.

### admin-audit

- **D001 · leitura.** O "Limpar" desliga o filtro de datas, mas os campos continuam mostrando a data. components/admin/audit/AuditFiltersAdmin.tsx:206-209 chama onChange({}), e os campos datetime-local das linhas 238-256 não têm value controlado.
- **D002 · leitura.** Erro da consulta aparece como lista vazia. app/admin/(protected)/audit/_client.tsx:24-27 ignora isError, e qualquer 400 ou 500 vira "Nenhum evento encontrado / Ajuste os filtros" (AuditTable.tsx:90-93) com o contador em "0 eventos". Fonte: `(app/api/v1/admin/audit/route.ts:15`.
- **D003 · leitura.** O filtro de empresas oferece só as primeiras 30. hooks/useAdminTenants.ts:48 pede limit=30, e o _client.tsx:16-22 nunca chama fetchNextPage (o comentário diz "up to 200").
- **D004 · leitura.** A coluna Actor mostra o código bruto da pessoa: AuditTable.tsx:153 aplica maskEmail sobre actor_user_id, que é o código e não o e-mail.
- **D005 · leitura.** A espera de 400 ms do campo Actor sobrevive ao Limpar. Fonte: `AuditFiltersAdmin.tsx:174-183,`.

### admin-cadastro

- **D006 · leitura.** Texto da chave promete redirecionamento que não existe: _form.tsx:60 diz 'Quem abrir a tela de cadastro sem convite vê um aviso e é levado ao login', mas app/(public)/signup/page.tsx:76-95 só mostra o aviso e um botão 'Entrar'.
- **D007 · leitura.** Jargão técnico no aviso para quem administra (público leigo): 'GoTrue', 'VPS', 'Em GoTrue próprio' e 'DISABLE_SIGNUP=true' em app/admin/(protected)/cadastro/page.tsx:82,97,113-116.
- **D008 · leitura.** Fila sem aviso (Sistema Vivo, saída sem consumidor): pedido novo não avisa o administrador da instalação (só audit em app/actions/auth/recoverOrganization.ts:156-163) e a decisão não avisa quem pediu (app/actions/registration/decide.ts:91-113 só grava e audita).
- **D009 · leitura.** A recusa só vale com 'Cadastro com aprovação' ligado: app/get-started/page.tsx:52-54 e recoverOrganization.ts:142-147 consultam o pedido apenas nesse modo; ao desligar a chave, conta recusada abre empresa própria sem aprovação.
- **D010 · leitura.** Pedido pendente fica velho: quem abre a empresa sozinho depois que a chave é desligada mantém o pedido 'pending' para sempre (nada o encerra), e ele reaparece na fila de /admin/cadastro se a chave for religada (lib/auth/registration-requests.ts:66-74).

### admin-cobranca

- **D011 · leitura.** components/admin/tenants/CardDeCobranca.tsx:151: o aviso 'Suspensa por falta de pagamento. Fonte: `(app/api/v1/admin/tenants/[id]/assinatura/route.ts:186-187`.
- **D012 · leitura.** app/admin/(protected)/cobranca/_planos.tsx:212: o selo 'Plano do cadastro' continua num plano arquivado, porque não olha arquivado_em. Fonte: `(supabase/baseline.sql:47669`.
- **D013 · leitura.** app/admin/(protected)/cobranca/_visao-geral.tsx:101: o texto 'mais de 7 horas: confira se o agendador está rodando.' usa jargão ('agendador', o serviço scheduler do compose) e não dá ao revendedor leigo nenhum caminho de ação.
- **D014 · hipótese.** app/admin/(protected)/cobranca/_conexao.tsx:150: diz que a Stripe 'aceita boleto' sem condição, mas o Checkout não define meios de pagamento (lib/cobranca/provedores/stripe.ts:52).

### admin-configuracao

- **D015 · leitura.** app/admin/(protected)/configuracao/page.tsx:35: o resumo do quadro E-mail diz "Sem isto o sistema não envia convite para a equipe nem recuperação de senha." Isso ficou desatualizado depois que a chave e o remetente foram para /admin/email (DEC-009).
- **D016 · leitura.** lib/instalacao/catalogo.ts:282: a explicação da "Chave que tranca as credenciais" diz "inclusive as que você digita nesta tela".
- **D017 · leitura.** app/actions/admin/salvarConfiguracaoDaInstalacao.ts:75-83: SUPPORT_EMAIL e LGPD_DPO_EMAIL são gravados sem validar o formato de e-mail. Fonte: `(billing/page.tsx:80`.
- **D018 · leitura.** lib/instalacao/catalogo.ts:148: a explicação do E-mail de suporte ("mostra a quem usa") promete mais do que entrega. Fonte: `(app/account-suspended/page.tsx:96-100`.

### admin-dashboard

- **D019 · leitura.** O cartão 'Alertas WAHA' e os alertas de WhatsApp não funcionam: a rota filtra channel_sessions.status em ('ban_suspected', 'disconnected_unexpected') ou 'disconnected' (app/api/v1/admin/dashboard/kpis/route.ts:80 e 121), mas o schema só aceita STARTING, SCAN_QR_CODE, WORKING, STOPPED e FAILED…
- **D020 · leitura.** 'Pendentes >10min' e o alerta 'Overflow' contam só status = 'pending' (kpis/route.ts:73 e 170) e ignoram 'open', embora a fila canônica seja open + pending (lib/schemas/messaging.ts:285).
- **D021 · leitura.** A contagem de alertas para em 20: kpis/route.ts:339 corta antes de devolver, e AlertsBanner.tsx:39 mostra esse total cortado como se fosse o total real.
- **D022 · leitura.** O alerta de Overflow lê no máximo 2000 conversas pendentes da instalação inteira (kpis/route.ts:171).
- **D023 · leitura.** O cartão 'Budgets IA' e o alerta 'IA Budget' usam o contador ai_budgets.current_month_consumed_cents, que só acumula e é recalculado apenas no install.sh ou no update.sh (baseline.sql:11500-11516 e 13232-13235). Fonte: `kpis/route.ts:229-253`.
- **D024 · leitura.** 'LGPD em Risco' exclui os pedidos com status 'failed' (kpis/route.ts:86 e 137).
- **D025 · leitura.** O canal em tempo real 'alerts-platform' tem quem escuta (hooks/useAlertsRealtime.ts:39), mas ninguém transmite nele: a única outra ocorrência só cria o canal (lib/realtime/channels.ts:13).
- **D026 · leitura.** Jargão e rótulos inconsistentes na tela para leigos: 'Visão cross-tenant' (_client.tsx:48), 'Tenants Ativos' (KPICards.tsx:57), 'Alertas WAHA' (KPICards.tsx:79), 'Overflow' (AlertItem.tsx:20). Fonte: `(kpis/route.ts:287`.

### admin-destinos-internos

- **D027 · leitura.** lib/recursos-opcionais/catalogo.ts:212 descreve Destinos internos como algo que 'Libera endereços da rede interna, como um modelo de IA rodando na própria máquina.' Isso é falso. Fonte: `(lib/ai/provider-validators.ts:351,`.
- **D028 · leitura.** app/app/ai/providers/_components/PainelDeProvedores.tsx:661 aponta um caminho que não existe: 'só funciona se quem administra a instalação o tiver liberado em Destinos internos — e, mesmo liberado, ele não vale para o endereço que esta empresa escolhe aqui'.
- **D029 · hipótese.** Mesmo liberado na lista, um endereço interno com http é recusado no servidor de verdade: unsafe_url:https_required (outbound-url.ts:28-30) roda antes da exceção da lista (destinos-internos-autorizados.ts:300-303).
- **D030 · leitura.** app/admin/(protected)/destinos-internos/_form.tsx:28: depois de salvar, o campo não é atualizado com a lista que de fato foi gravada (sem duplicatas e normalizada pela action em updateDestinosInternos.ts:64-74).
- **D031 · leitura.** Só o processo do site zera a lista guardada depois de salvar (destinos-internos-autorizados.ts:265).

### admin-email

- **D032 · leitura.** O campo 'Nome que aparece como remetente' (app/admin/(protected)/email/_form.tsx:216) é ignorado em convites, entrega da LGPD e avisos de prazo.
- **D033 · leitura.** A explicação da 'Chave do serviço de e-mail' (lib/instalacao/catalogo.ts:126-127) diz 'Sem ela o sistema não consegue enviar e-mail nenhum — nem convite para a equipe, nem recuperação de senha'.
- **D034 · leitura.** A tela não diz qual serviço externo é aceito. Fonte: `(lib/email/resend.ts:71-74`.
- **D035 · leitura.** Salvar no quadro 'Serviço externo de envio' não atualiza o resto da tela. salvarConfiguracaoDaInstalacao e voltarConfiguracaoAoPadrao só chamam revalidatePath('/admin/configuracao') (app/actions/admin/salvarConfiguracaoDaInstalacao.ts:114,144), e CampoEditavel não chama router.refresh().
- **D036 · leitura.** O fluxo do servidor próprio obriga a salvar antes de testar. 'Testar conexão' confere só o que está salvo (lib/email/smtp.ts:97-99), e salvar já desvia TODO o envio para o servidor próprio, sem volta automática ao serviço externo (lib/email/roteador.ts:14-29, 83-85).
- **D037 · leitura.** A tarja de aviso usa jargão e um endereço como texto de link: 'Sem SMTP configurado' e 'Configurar em /admin/email' (components/admin/AvisoSemSmtp.tsx:42,51). Fonte: `(components/admin/AdminSidebar.tsx:72`.
- **D038 · hipótese.** No erro do teste, só a recusa com código 535 vira 'recusou o usuário e a senha'. Fonte: `(lib/email/smtp.ts:104-105`.

### admin-extensoes

- **D039 · leitura.** A frase "X de Y empresa(s) com ela ligada" (app/admin/(protected)/extensoes/page.tsx:64, 67-73, 145-147) usa como denominador o número de empresas com uma linha em organization_extensions, e não o total de empresas do servidor.
- **D040 · leitura.** As duas telas usam vocabulário diferente para o mesmo estado: o Admin diz "ligada" (page.tsx:147) e a tela da empresa diz "Ativa"/"Desativada"/"Ativa no CRM" (components/extensions/InstalledExtensionCard.tsx:159-160).
- **D041 · leitura.** O Admin lista TODOS os catálogos admitidos (page.tsx:54, sem limite), mas a tela da empresa só lê os 8 mais recentes (lib/extensions/service.ts:307-311, .limit(8)).
- **D042 · leitura.** A leitura de organization_extensions no Admin (page.tsx:64) não tem paginação.

### admin-google

- **D043 · leitura; complementa A65.** Jargão para quem não administra: quem não administra a instalação vê na Agenda 'Quem instalou o sistema precisa configurar GOOGLE_CALENDAR_CLIENT_ID e GOOGLE_CALENDAR_CLIENT_SECRET', com os nomes das variáveis em fonte de código (app/app/agenda/_components/CartaoDaConexaoGoogle.tsx:74-80, e a lista vem de…
- **D044 · leitura.** Promessa enganosa para o admin: 'Falta cadastrar o aplicativo do Google desta instalação. Fonte: `(CartaoDaConexaoGoogle.tsx:70`.
- **D045 · leitura.** Botão que não existe: o aviso data-testid=google-tem-no-ambiente diz 'apagar o que está aqui faz o sistema voltar a usar as do arquivo' (app/admin/(protected)/google/_form.tsx:129), e o comentário da action diz que 'apagar é outro botão' (app/actions/settings/updateGoogleOAuth.ts:61).
- **D046 · leitura.** Erro técnico em aviso para leigo: se a cifra não estiver disponível, o aviso de erro mostra 'cifra indisponível nesta instalação (GUC app.nuvemshop_oauth_key ausente) — o segredo não foi gravado' (app/actions/settings/updateGoogleOAuth.ts:122-126).
- **D047 · leitura.** Salvar não valida nada com o Google: qualquer ID com 10 ou mais caracteres e qualquer chave com [A-Za-z0-9_-] gravam com 'Credenciais do Google salvas.' (updateGoogleOAuth.ts:57-85, 131-143).
- **D048 · leitura.** Textos fora do i18n em _form.tsx: 'Última alteração em ...' (linha 147), 'Salvando…'/'Salvar' (171), o rótulo 'ID do cliente' (85) e a orientação 'Cole exatamente isto em "URIs de redirecionamento autorizados"...' (79-80) não passam por t().

### admin-inbox

- **D049 · leitura.** Texto velho e com código interno à vista do usuário: app/admin/(protected)/inbox/_components/AdminThread.tsx:110-113 mostra 'Use “Impersonate” (em breve, S-11.07) para responder.', mas o recurso já existe e se chama 'Acompanhar organização' (components/admin/ImpersonateButton.tsx:98).…
- **D050 · leitura.** A situação da conversa aparece como a palavra técnica em inglês: AdminThread.tsx:72-74 imprime conversation.status cru ('Ai_handling', 'Claimed', 'Closed'). components/inbox/ConversationHeader.tsx:80-88 já tem o STATUS_LABEL que traduz os 7 valores e avisa no próprio comentário que um buraco 'imprime o token cru em… Fonte: `_components/AdminSidePanel.tsx:75-77`.
- **D051 · hipótese.** Histórico de auditoria inflado sem ação do admin (plausível, não reproduzido): hooks/useAdminInboxRealtime.ts:18-20 invalida ['admin','inbox'] a cada INSERT em messages de qualquer empresa. Fonte: `([id]/route.ts:106`.
- **D052 · hipótese.** Paginação da lista do Admin (plausível, não reproduzido): route.ts:111-114 monta o cursor com last_inbound_at.lt/eq, o que exclui as linhas com last_inbound_at NULL. Fonte: `(route.ts:115-118`.
- **D053 · leitura.** O detalhe da conversa no Admin não busca metadata nem sent_on_behalf_of_user_id (app/api/v1/admin/inbox/conversations/[id]/route.ts:74-92).
- **D054 · leitura.** O filtro de situação oferece opções mortas e esconde as reais: InboxList.tsx:60-65 e route.ts:15 só aceitam pending/open/resolved, mas nenhum código atual grava pending nem resolved (lib/inbox/comando-da-conversa.ts:191).
- **D055 · leitura.** Débito cosmético de i18n e de privacidade: os rótulos 'Contato', 'Contato anonimizado', 'Bloqueado', 'Tenant', 'Slug:', 'Status:' e 'Abrir tenant' estão fixos no código, sem t() (AdminSidePanel.tsx:30, 36, 52, 64, 73, 76, 82), e não viram espanhol.

### admin-incidents

- **D056 · leitura.** Tela sem fonte de dados: nenhum código do produto cria incidentes. Fonte: `(app/api/v1/admin/incidents/[id]/resolve/route.ts:69-78`.
- **D057 · leitura.** Filtro 'Reconhecidos' sem caminho: o status 'acknowledged' existe no filtro e no selo (app/admin/(protected)/incidents/_client.tsx:25; components/admin/incidents/IncidentsTable.tsx:41,47), mas não há rota nem botão que leve um incidente a esse estado.
- **D058 · leitura.** O limite de 1000 caracteres da nota de resolução só existe no servidor (resolve/route.ts:19-24). Fonte: `(components/admin/incidents/ResolveIncidentDialog.tsx:67-75`.
- **D059 · leitura.** O botão de confirmar usa AlertDialogPrimitive.Action (components/ui/alert-dialog.tsx:89-94), que fecha a janela no clique.
- **D060 · leitura.** O detalhe do incidente resolvido não mostra quem resolveu: o quadro 'Resolução' exibe só a nota e a data (app/admin/(protected)/incidents/[id]/_client.tsx:190-210), embora resolved_by seja gravado (resolve/route.ts:74).
- **D061 · leitura.** Inconsistência de identificação da empresa: a lista mostra o display_name (IncidentsTable.tsx:166-167) e o detalhe mostra o slug em fonte mono (incidents/[id]/_client.tsx:112-116).
- **D062 · leitura.** Cada GET do detalhe grava platform_admin.incident_viewed com incident_id (app/api/v1/admin/incidents/[id]/route.ts:64-73), e isso inclui as recargas automáticas do React Query ao voltar o foco para a aba depois de 30s (hooks/useAdminIncident.ts:42).

### admin-lgpd

- **D063 · leitura.** Selo de risco ignora a situação: computeRiskLevel é chamado só com due_at/received_at (app/api/v1/admin/lgpd/requests/route.ts:157).
- **D064 · leitura.** Link 'Ver detalhes' do aviso vermelho não funciona: aponta para /admin/lgpd?risk_level=expired (LgpdRiskBanner.tsx:45-49), mas LgpdAdminClient começa com useState({}) e nunca lê a URL (app/admin/(protected)/lgpd/_client.tsx:30).
- **D065 · leitura.** Filtro de risco aplicado depois da paginação: o servidor busca 50 linhas por prazo e só então filtra por risco (app/api/v1/admin/lgpd/requests/route.ts:162-164).
- **D066 · leitura.** Trilha de auditoria cortada nas 50 mais ANTIGAS: order asc + limit 50 (app/api/v1/admin/lgpd/requests/[id]/route.ts:58-63).
- **D067 · leitura.** Prazo acaba à meia-noite UTC: em instalação brasileira, o selo 'Vencido' e o 'em atraso' viram às 21h (Brasília) do último dia (lib/lgpd/sla.ts, comentário de horasAteOFimDoPrazo).
- **D068 · leitura.** Detalhe da ficha mostra jargão cru ao administrador: rótulos 'Escopo' com o valor bruto 'contact'/'tenant', 'Slug', 'Contact ID', 'External customer ID' sem tradução ([id]/_client.tsx:331, 336, 340, 343); 'Origem' mostra o valor bruto 'nuvemshop' (:330).

### admin-marca

- **D069 · leitura.** app/admin/(protected)/marca/_estado.tsx:178-182: a frase miúda 'O logo ainda é trocado no arquivo de instalação do servidor…' está desatualizada.
- **D070 · leitura.** app/admin/(protected)/marca/_form.tsx:294 e :340: 'Deixe em branco para voltar ao nome padrão' e 'voltar à cor padrão do sistema' são imprecisos. Fonte: `(hostgator-setup-kit/install.sh:1467`.
- **D071 · hipótese.** app/api/v1/marca/logo/route.ts:272 (plausível, não reproduzido): enviar só o logo ou o ícone grava seeded_from_env=false na linha inteira.
- **D072 · leitura.** lib/branding/css-personalizado.ts:131-161: as recusas do CSS personalizado não dizem QUAL regra ou propriedade foi barrada ('Essa propriedade não é permitida…').
- **D073 · leitura.** components/branding/CampoDoIconeDaAba.tsx:76-83: o ícone da aba não passa pelo ajustarLogo que o logo usa (CampoDeLogo.tsx:275).
- **D074 · leitura.** app/admin/(protected)/marca/page.tsx:94: o subtítulo 'O nome e a cor que este sistema mostra…' omite o logo, o ícone e o CSS que a mesma tela edita (cosmético).

### admin-meta

- **D075 · leitura.** CONFIRMADO, leve: o cabeçalho de /admin/meta (app/admin/(protected)/meta/_form.tsx:124) diz 'É com estas duas informações que o sistema confere que cada mensagem recebida... veio mesmo da Meta'.
- **D076 · hipótese.** PLAUSÍVEL: depois de 'Gerar novo token', os números que o sistema registrou sozinho na Meta continuam com o token antigo gravado lá (webhook-override.ts:107-115). Fonte: `(components/connections/CanalOficialClient.tsx:129-148`.
- **D077 · leitura.** CONFIRMADO, leve: na falha de cifra, a tela mostra ao administrador um texto técnico cru: 'cifra indisponível nesta instalação (GUC app.nuvemshop_oauth_key ausente)' (app/actions/settings/updateMetaApp.ts:227, 242, 284, exibido por _form.tsx:85).

### admin-modulos

- **D078 · leitura.** Um módulo Suspenso não tem como ser recuperado pela tela. Fonte: `(supabase/baseline.sql:33479-33481`.
- **D079 · leitura.** O motivo da suspensão aparece cru para quem administra. motivo_suspensao recebe o sqlerrm do Postgres (supabase/baseline.sql:33532), e ModulosManager.tsx:90-93 exibe esse texto sem tradução: mensagem técnica, muitas vezes em inglês, para um usuário leigo.
- **D080 · leitura.** A página 'Acesso negado' (app/admin/forbidden/page.tsx:36) diz 'restrita a administradores da plataforma com MFA ativo' e manda 'contate o time de operações'.
- **D081 · leitura.** A tela usa jargão onde um leigo vai ler. Fonte: `(app/admin/(protected)/modulos/page.tsx:35`.
- **D082 · hipótese.** A mensagem de erro genérica 'Não foi possível confirmar o resultado. Fonte: `(lib/modulos/service.ts:56`.

### admin-platform-admins

- **D083 · leitura.** Link quebrado: o "Ver runbook →" do aviso de Platform Admins (components/admin/platform-admins/DBAOnlyNotice.tsx:32-37) aponta para /runbook/platform-admin-management.md.
- **D084 · leitura.** A tabela de Platform Admins não mostra quando, por quem nem por que um acesso foi revogado. Fonte: `(app/api/v1/admin/platform-admins/route.ts:154-157`.
- **D085 · leitura.** O aviso da tela é escrito em jargão para quem é o dono da instalação: "Conforme Spec 01 §3.4 T-04", "via SQL pelo DBA", "api_audit_log", "read-only" (DBAOnlyNotice.tsx:16-28).
- **D086 · hipótese.** (plausível, ainda não reproduzido) Um admin da plataforma com mfa_required=true e sem código cadastrado que abre /admin é mandado para /login/mfa. Fonte: `(app/(public)/login/mfa/page.tsx:26`.

### admin-sistema

- **D087 · leitura.** A chave "Divulgação de pagamento no atendimento" não faz nada e tem nome enganoso. Fonte: `(lib/agent-engine/guardrails/disclosure/template.ts:2,15`.
- **D088 · leitura.** A conferência de promessa mostra estados que se contradizem entre duas telas. Fonte: `(lib/agent-engine/agent/turn-knobs.ts:58`.
- **D089 · leitura.** A tela /admin/sistema afirma "Cada escolha vale para todas as empresas daqui" (_form.tsx:93).
- **D090 · hipótese.** Dúvida, ainda não confirmada: na instalação de servidor único, a tarja diz que a recuperação de senha 'não sai até configurá-lo aqui' (AvisoSemSmtp.tsx:45). Fonte: `(hostgator-setup-kit/_common.sh:759,`.
- **D091 · leitura.** Jargão técnico no texto da tela /admin/sistema, que é para leigos: "entrega de webhook precisa vir assinada com o segredo da sessão" (_form.tsx:132); "devolve ao modelo a razão, para ele reescrever" (_form.tsx:187); "conferência de modelo" e "chamada de modelo por envio" (_form.tsx:219); "declarar um valor no…

### admin-tenants

- **D092 · leitura.** A faixa de empresa suspensa sempre mostra 'Sem razão registrada.', mesmo quando o motivo foi gravado. Fonte: `(app/admin/(protected)/tenants/[id]/_client.tsx:45-47`.
- **D093 · leitura.** A contagem 'Users' (lista) e 'Usuários' (ficha) inclui vínculos revogados: user_organizations é contada sem filtro de revoked_at (app/api/v1/admin/tenants/_lista.ts:103; app/api/v1/admin/tenants/[id]/route.ts:84-86).
- **D094 · leitura.** 'WAHA sessions' (ficha) e o cartão 'WAHA' (saúde) contam channel_sessions de TODOS os provedores (waha, meta_cloud, zernio, zernio_social, wacalls, datafy) sem filtrar provider='waha' (app/api/v1/admin/tenants/[id]/route.ts:129-131; app/api/v1/admin/tenants/[id]/health/route.ts:191-196).
- **D095 · leitura.** O cartão Nuvemshop da saúde fica em 'Atenção' em toda empresa que nunca integrou loja: status null cai em NUVEMSHOP_DESCONHECIDO com saude 'warning' (app/api/v1/admin/tenants/[id]/health/route.ts:118-125).
- **D096 · leitura.** O selo de situação no topo da ficha não calcula 'Onboarding': mostra 'Ativo' para uma empresa que a lista mostra como 'Onboarding' (app/admin/(protected)/tenants/[id]/layout.tsx:95-98 contra components/admin/tenants/TenantsTable.tsx:49-50).
- **D097 · leitura.** O 'Audit Lag' se contamina com a própria leitura: a página de saúde grava platform_admin.tenant_health_viewed em toda consulta (health/route.ts:318-327) e se atualiza a cada 60 segundos (hooks/useTenantHealth.ts:22).
- **D098 · leitura.** Rótulos em inglês ou técnicos na interface em português: 'Users' (TenantsTable.tsx:161; o dicionário não traduz a chave), 'WAHA sessions' (TenantOverview.tsx:167), 'Audit Lag' e 'Lag' (HealthGrid.tsx:107,139) e 'DPO email' (app/app/settings/tenant/_form.tsx:104).

### admin-usage

- **D099 · leitura.** Números truncados acima de 1.000 linhas. app/api/v1/admin/usage/route.ts:139-147, 159-163, 185-189, 264-268 e 283-287 lê as linhas de messages, conversations e llm_calls para somar no código, mas o PostgREST devolve no máximo 1.000 linhas (supabase/config.toml:12). Fonte: `(lib/ai/usage/aggregate.ts:5-8`.
- **D100 · leitura.** O título do gráfico diz "Custo AI / dia (R$)" (components/admin/usage/UsageCharts.tsx:120; também em lib/i18n/traducoes/en.json:3181 e lib/i18n/dicionario.ts:5711), mas os valores são em dólar (formatCentsUSD, lib/money.ts:133-135).
- **D101 · leitura.** O CSV não abre direito no Excel em português (UsageTable.tsx:58-59): usa vírgula como separador e ponto como decimal, e é UTF-8 sem BOM.
- **D102 · leitura.** A coluna "Agente" mostra agente pausado como se estivesse atendendo. Fonte: `(app/api/v1/ai/agents/[id]/pause/route.ts:5-7`.
- **D103 · leitura.** O gráfico "Mensagens / dia" conta contatos pessoais (route.ts:264-268), e a coluna "Mensagens" não conta (route.ts:144-146), então gráfico e tabela não fecham.
- **D104 · leitura.** Os dias dos gráficos são contados em UTC (route.ts:257, 271 e 290): o que acontece depois das 21h de Brasília cai no dia seguinte. Fonte: `(route.ts:132-134`.
- **D105 · leitura.** "Invoc. Fonte: `(route.ts:185-200`.

### admin-users

- **D106 · leitura.** Uma falha do servidor aparece como lista vazia. Fonte: `app/admin/(protected)/users/_client.tsx:35-39`.
- **D107 · leitura.** O seletor 'Filtrar por tenant' só lista as 30 primeiras empresas. Fonte: `(hooks/useAdminTenants.ts:48,`.
- **D108 · leitura.** A paginação por cursor repete linhas quando alguém faz login entre uma página e outra. Fonte: `app/api/v1/admin/users/route.ts:310-322`.
- **D109 · leitura.** A busca diferencia acento. Fonte: `route.ts:284-290,`.
- **D110 · leitura.** Contas sem vínculo com empresa ficam invisíveis no Admin. Fonte: `route.ts:92-104`.

### api-tokens

- **D111 · leitura.** A tela oferece permissões que nada confere. "contacts:read", "contacts:write", "leads:read", "leads:write", "messages:read", "messages:write" e "audit:read" (ApiTokensClient.tsx:63-71) não são exigidas por nenhuma rota nem ferramenta.
- **D112 · leitura.** Nenhum caminho com chave cria contato. Fonte: `(app/api/v1/contacts/route.ts:169`.
- **D113 · leitura.** Chave vencida aparece como "Ativo". Fonte: `(lib/mcp/auth.ts:177-178`.
- **D114 · leitura.** "Revogar" é irreversível e não pede confirmação (ApiTokensClient.tsx:168-178).
- **D115 · leitura.** Jargão na tela: "Tokens server-to-server. Fonte: `(ApiTokensClient.tsx:193`.
- **D116 · leitura.** A lista busca last_used_at (route.ts:23) mas não tem coluna de último uso.
- **D117 · leitura.** O catálogo não tem role:ai_operator. Fonte: `(app/api/v1/agenda/agendamentos/route.ts:372`.

### app-no-celular

- **D118 · leitura.** O interruptor Push de 'Nova mensagem' aparece LIGADO por padrão (prefsPadrao push: true, lib/notifications/prefs.ts:19-30) mesmo quando o navegador nunca deu permissão. Fonte: `(notifications/_client.tsx:88-93`.

### automacoes

- **D119 · leitura.** Na aba Atividade, o passo aparece com o nome técnico "ai_decide" em vez de "A IA decide". Fonte: `(app/app/webhooks/_components/ActivityTab.tsx:34-36`.
- **D120 · leitura.** A frase da tela Configurações › Automações promete mais do que faz: "Com o interruptor desligado, nenhuma regra consulta o modelo" (app/app/settings/automacoes/_interruptor.tsx:55).
- **D121 · leitura.** O passo "A IA decide" não pode ser criado nem editado pela interface, só pela API (CaixaDaAutomacao.tsx:238; PainelDaCaixa.tsx:493-497).
- **D122 · leitura.** Quando a empresa desliga a chave de propósito, as execuções viram "Parcial" (com aviso), ou "Falhou" (vermelho) se o passo da IA for o único da regra (lib/automation/engine.ts:421-427, com skipped contando como não-enviado).

### aviso-de-agendamento

- **D123 · leitura.** Frase de erro errada na tela da agenda: FRASE_DO_ERRO_DO_AVISO.canal_nao_aceita_aviso_livre diz "...ela não serve para o aviso de caso." (lib/escalacao/vocabulario-do-aviso.ts:79-80). Fonte: `(app/app/agenda/avisos/_components/AvisoDeAgendamento.tsx:163-164,`.
- **D124 · leitura.** A ajuda da chave lista só as origens 'IA, equipe ou Google Agenda' (AvisoDeAgendamento.tsx:259-261). Fonte: `(lib/agenda/google/mudanca-vinda-do-google.ts:1-12`.
- **D125 · leitura.** O seletor 'Conexão que envia os avisos' mostra números desconectados sem nenhuma indicação (o filtro é só por aceitaMensagemLivre, AvisoDeAgendamento.tsx:124 e :209-213).
- **D126 · leitura.** Na lista 'Últimos avisos', a palavra 'Cancelado' é ao mesmo tempo o tipo do evento (TITULO_DO_EVENTO, AvisoDeAgendamento.tsx:55) e a situação da entrega (FRASE_DO_STATUS_DE_AGENDAMENTO.cancelado, lib/agenda/vocabulario-do-aviso-de-agendamento.ts:48).
- **D127 · leitura.** As entregas guardadas para o resumo ('para_o_resumo') não têm limite de data: represadasParaOResumo (lib/agenda/aviso-de-agendamento.ts:787-795) pega todas, sem filtro de idade.

### conversoes

- **D128 · leitura.** O cartão de conexão com a Meta não tem título (app/app/settings/conversoes/_form.tsx:101-104).
- **D129 · hipótese.** A ajuda do campo 'Identificador do destino de conversões' manda procurar 'no gerenciador de anúncios' (_form.tsx:113).
- **D130 · leitura.** 'Enviar vendas pelo canal da conversa' aparece sempre (page.tsx:340), mas só o adaptador do canal parceiro Zernio implementa reportConversion (lib/channels/conversao-pelo-canal.ts:80-82; lib/channels/adapters/zernio.ts).
- **D131 · hipótese.** PLAUSÍVEL: etapas arquivadas aparecem nas regras por etapa da Meta e do Google. Fonte: `(app/actions/settings/salvarRegrasDeConversaoMeta.ts:80-85`.
- **D132 · leitura.** A lista 'Conversões que não foram reportadas' corta nas 20 mais recentes (lib/conversoes/estado-da-conexao.ts:85,95) sem aviso nem link para ver o resto.
- **D133 · leitura.** O Diagnóstico mostra nomes de variável de ambiente ao administrador leigo: 'GOOGLE_ADS_OAUTH_CLIENT_ID e GOOGLE_ADS_OAUTH_CLIENT_SECRET' (lib/conversoes/historico.ts:275).
- **D134 · leitura.** O seletor 'Evento enviado à Meta' mostra o nome técnico em inglês entre parênteses, por exemplo 'Lead enviado (LeadSubmitted)' (_regrasMeta.tsx:170).
- **D135 · leitura.** A lista de pendências mistura envios que a plataforma já recebeu e aguardam confirmação ('aguardando_processamento') sob o título 'Conversões que não foram reportadas' (estado-da-conexao.ts:93; page.tsx:394).

### dados-externos

- **D136 · leitura.** O botão 'Testar' aparece para qualquer pessoa da equipe (app/app/integracao-dados/_components/ListaDeConexoes.tsx:211-218, sem a trava canWrite), mas a rota POST /api/v1/external-db/connections/[id]/test exige administrador (route.ts:42).
- **D137 · leitura.** A tela de Dados externos não avisa que o agente só usa o banco se tiver as capacidades 'Ver as tabelas do banco conectado' e 'Buscar dados no banco conectado' ligadas. Fonte: `(lib/mcp/tools/catalogo/dados-externos.ts:33,44`.
- **D138 · leitura.** O erro do último teste aparece cru e em inglês no cartão (ListaDeConexoes.tsx:193-195). Fonte: `(lib/external-db/conexao.ts:156-162`.
- **D139 · leitura.** O aviso da página de uma conexão desativada diz 'Ative-a na lista para consultar os dados.' (app/app/integracao-dados/[id]/page.tsx:86), mas na lista não existe chave de ativar.

### distribuicao-de-atendimento

- **D140 · leitura.** Texto que não bate com o botão: o texto da tela em app/app/settings/atendimento/_form.tsx:287 diz 'a IA só volta quando alguém clica em Devolver', mas o botão da conversa se chama 'Devolver ao automático' (components/inbox/ConversationHeader.tsx:455).
- **D141 · leitura.** O rótulo 'Tentativas antes de desistir' e o texto 'Ao estourar, a conversa fica na fila esperando alguém' (_form.tsx:187 e 201) prometem que o sistema desiste.
- **D142 · leitura.** Destino padrão do número sem plano B e sem aviso: se o 'Atendente de destino padrão' está indisponível ou com a capacidade cheia, fn_channel_routing_claim devolve capacity_changed. Fonte: `(lib/routing/worker.ts:246-251`.
- **D143 · leitura.** Armadilha no quadro por número: escolher só uma regra própria em 'Como este número distribui' e clicar em 'Salvar responsáveis' sem marcar ninguém cria a política com a lista vazia (fn_set_channel_routing, baseline.sql:23013-23024). Fonte: `(_channels-form.tsx:49`.
- **D144 · leitura.** Primeira impressão: attendant_availability.is_available nasce false (baseline.sql:5894).

### equipe

- **D145 · leitura.** O diálogo de revogar membro tem jargão e uma afirmação falsa: "perderá acesso ao tenant. Fonte: `(app/app/team/_components/TeamMembersClient.tsx:234`.
- **D146 · leitura.** Na tela de Equipe e no convite aparece jargão técnico para o leigo: o subtítulo "Gestão de membros, roles e atendimento do tenant." (app/app/team/page.tsx:55), "escolha a role compartilhada" (app/app/team/invite/page.tsx:24), "Resend não configurado — link copiável abaixo (DEV)."… Fonte: `(app/api/v1/team/[user_id]/revoke/route.ts:68`.
- **D147 · leitura.** "Copiar link" de um convite Expirado copia um link já vencido. Fonte: `(app/api/v1/team/invites/route.ts:50`.
- **D148 · leitura.** Um membro revogado continua com o seletor de papel ativo (TeamMembersClient.tsx:102 só testa canManage e se é a própria pessoa). Fonte: `(app/api/v1/team/[user_id]/_shared.ts:58-59`.
- **D149 · leitura.** "Devolver acesso" não desfaz por inteiro o que a revogação fez. Fonte: `(app/api/v1/team/[user_id]/reactivate/route.ts:81-84`.
- **D150 · leitura.** A chave "Disponível" tem efeitos diferentes em dois lugares. Fonte: `(lib/agenda/consulta.ts:259-263`.
- **D151 · hipótese.** O diálogo de interface promete "aparece para o membro sem sair da conta" (components/team/MemberInterfaceDialog.tsx:52), mas não há atualização ao vivo.
- **D152 · leitura.** O selo de plantão usa um relógio congelado no momento em que a tela abriu (AttendantsClient.tsx:559, useMemo sem dependência).
- **D153 · leitura.** A coluna "Última atividade" mostra a data do último login (last_sign_in_at), não a última atividade (TeamMembersClient.tsx:85, 172-174).

### extensoes

- **D154 · leitura.** components/extensions/ExtensionsManager.tsx:912: o cabeçalho da tela de Extensões diz 'Antes de abrir Tarefas, o acesso e a ativação são conferidos novamente.' Tarefas está escrito fixo no texto, mas desde a ADR-0003 cada extensão pode abrir Agenda, Conversas, Contatos, Funil ou Radar.
- **D155 · leitura.** components/extensions/ExtensionOperations.tsx:47 com supabase/baseline.sql:28326: o recibo de 'Configuração' de uma empresa (ligar/desligar um guia) é gravado sem publisher/name.
- **D156 · leitura.** components/extensions/InstalledExtensionCard.tsx:249: a frase 'Os guias aparecem no hub do CRM.' usa o termo técnico 'hub'.

### financeiro

- **D157 · leitura.** Contas de todo mês: depois de 'Adicionar', o formulário NÃO é limpo (app/app/settings/tenant/financeiro/_client.tsx:394 chama criar.mutate sem onSuccess; _recorrencias.tsx:156 chama onCriar sem callback de limpar).
- **D158 · leitura.** Seção 'Comissão' (módulo Comandas): o tipo Pessoa lê name/email (_comissao.tsx:25, 71, 115), mas GET /api/v1/team/assignable devolve full_name (app/api/v1/team/assignable/route.ts:23, 59) e não traz email.
- **D159 · leitura.** Desativar uma conta não afeta quem aponta para ela: fn_finalizar da comanda só recusa account_id null e não confere is_active da conta (supabase/baseline.sql:34008-34018), e o cron recurring-entries não filtra conta inativa (app/api/v1/cron/recurring-entries/route.ts:59-64).
- **D160 · leitura.** Desativar (contas, formas, planos) e o '×' das contas fixas agem na hora, sem confirmação (_client.tsx:447, _recorrencias.tsx:213-220), e nenhuma tela permite reativar: a API aceita ?inativos=1 (app/api/v1/financeiro/catalogo/[tipo]/route.ts:71), mas nada a usa.
- **D161 · leitura.** Cron de contas fixas não olha a data de cadastro: uma conta cadastrada com um dia que já passou no mês gera o lançamento pendente do mês corrente na rodada seguinte (app/api/v1/cron/recurring-entries/route.ts:75-81).
- **D162 · leitura.** Inconsistência de rótulo: o '×' das contas fixas tem aria-label 'Remover lançamento recorrente' (_recorrencias.tsx:215), mas a ação só inativa.
- **D163 · leitura.** Textos da tela presumem Comandas ligado: a descrição de 'Formas de pagamento' ('quando a comanda é fechada', _client.tsx:214) e o aviso 'sem conta definida' aparecem também na instalação nova, onde o módulo vem desligado (lib/modulos/catalogo.ts:29-36) e a forma de pagamento não é usada em lugar nenhum.

### lgpd

- **D164 · leitura.** Anonimização da loja inteira pula contatos: o loop do 'tenant' em workers/lgpd-redact-worker.ts:384-391 filtra is_anonymized=false e, ao mesmo tempo, avança o offset (range(progress.batch_offset, ...)).
- **D165 · leitura.** Apagamentos vindos da Nuvemshop rodam sem aprovação humana: customer-redact e store-redact emitem lgpd.redact_received direto (customer-redact/route.ts:234-236, store-redact/route.ts:234-236), e workers/lgpd-redact-worker.ts não tem o portão manually_approved que o export tem (workers/lgpd-export-worker.ts:118).
- **D166 · leitura.** Não há como registrar um pedido LGPD fora da Nuvemshop: os únicos criadores de lgpd_requests são os 3 webhooks da Nuvemshop (createLgpdRequest em customer-data-request/route.ts:236, customer-redact/route.ts:209, store-redact/route.ts:208), e source 'admin_panel'/'api' existe no tipo (lib/lgpd/repository.ts:20) sem…
- **D167 · leitura.** Filtro de SLA quebra o contador e a paginação: app/api/v1/lgpd/requests/route.ts:70-78 conta sem o filtro de SLA, e :108-110 aplica o filtro só nas 25 linhas da página.
- **D168 · hipótese.** Aprovação pode deixar o pedido preso em 'Processando': em app/api/v1/lgpd/requests/[id]/approve/route.ts:166 a falha do emit_event só é logada, e :173 muda o status para 'processing' mesmo assim.
- **D169 · leitura.** A janela de confirmação da anonimização não mostra quem vai ser apagado: ApproveButton.tsx:97-108 só mostra 'Titular'/'Envio para' para data_request.
- **D170 · leitura.** Etapas da 'Linha do tempo SLA' em dias corridos (D+5, D+7, D+10, D+15 somados em 24h, app/admin/(protected)/lgpd/requests/[id]/_client.tsx:48-59, 88-90) enquanto o prazo real é em dias úteis. 'Entrega ao titular' e 'Anonimização concluída' aparecem verdes ('já passou') antes do prazo legal.
- **D171 · leitura.** Jargão e inglês na tela de LGPD: o toast 'Aprovação registrada — request mudou para processing' (ApproveButton.tsx:71); 'O histórico de timestamps é preservado' e 'tenant' nos textos da anonimização (ApproveButton.tsx:43-49, RequestsTable.tsx:40); os rótulos 'Contact ID' e 'External customer ID' e o valor cru de…
- **D172 · leitura.** Rótulo do tipo diferente entre telas: a lista diz 'Solicitação dados' (RequestsTable.tsx:39) e o detalhe diz 'Solicitação de dados' (_client.tsx:29).

### marca

- **D173 · leitura.** Três frases da tela prometem que a cor original 'fica no logo' ou 'nos destaques', e isso não acontece: lib/branding/linguagem.ts:293 ('A sua cor original continua no logo e nos destaques.'), lib/branding/linguagem.ts:121 ('a sua fica reservada ao logo'), lib/branding/linguagem.ts:100 ('ela aparece no logo') e a… Fonte: `(lib/branding/css.ts:109`.
- **D174 · leitura.** O texto de ajuda 'Aparece no menu lateral, para quem trabalha aqui' (app/app/settings/marca/_form.tsx:333) vale só sem logo.
- **D175 · hipótese.** O campo 'Nome de exibição' em branco mostra como placeholder o nome da instalação (_form.tsx:502, semAOrganizacao.name), mas o e-mail não sai com esse nome. Fonte: `(lib/automation/actions/send-email.ts:402`.

### meta-ads-conexao

- **D176 · leitura.** O aviso de formato errado não diz QUAL campo está errado nem qual é o formato. Fonte: `(app/actions/settings/updateAdInsightsConnection.ts:84,`.
- **D177 · leitura.** A frase "Cole o token para poder salvar." (_form.tsx:144-147) aparece também quando já há algo colado com menos de 20 caracteres (_form.tsx:54).
- **D178 · leitura.** "Desconectar" apaga na hora, sem confirmação, um segredo que não pode ser recuperado: o token e a conta padrão (_form.tsx:133-141; updateAdInsightsConnection.ts:210-214).
- **D179 · leitura.** Ao apagar a conta padrão com a conta ligada e clicar em "Salvar", a escolha é apagada (envia null; _form.tsx:62 e updateAdInsightsConnection.ts:144-146).

### meta-de-vendas

- **D180 · leitura.** Para o atendente, a linha "Empresa" do quadro "Meta do mês" mostra um número de vendas errado. /api/v1/metrics/metas conta os negócios ganhos com o acesso de quem pediu (app/api/v1/metrics/metas/route.ts:162-168), e o crm_leads_select deixa o agent ver só os negócios dele e os sem dono…
- **D181 · leitura; complementa A55.** O viewer (somente leitura) não abre o Desempenho: a página não tem minRole (lib/navigation/catalogo.ts:846-853), mas as APIs exigem agent (app/api/v1/metrics/attendants/route.ts:60).
- **D182 · leitura.** O quadro do Desempenho fica desatualizado por até 30 segundos depois de corrigir a meta: useMetasDoMes tem staleTime 30_000 (hooks/metrics/useMetasDoMes.ts:42-47), o cache é global (app/providers.tsx) e definirMetaMensal não limpa ['metrics','metas'] (só chama revalidatePath,…
- **D183 · leitura.** Na tela de Meta de vendas, o seletor "Mês" não recarrega nada. Fonte: `(app/app/settings/metas/_form.tsx:44-45,`.
- **D184 · leitura.** O erro mfa_required, que a action pode devolver (definirMetaMensal.ts:87), não está em ERRO_EM_PORTUGUES (_form.tsx:25-31).
- **D185 · leitura.** Na tela de cadastro, o mês vem do relógio do SERVIDOR (page.tsx:39, mesLocal() com new Date() no servidor). Fonte: `(MetricsClient.tsx:67`.
- **D186 · leitura.** A nota da tela usa jargão interno de desenvolvimento: "Nesta primeira versão... ficam para as próximas fatias" e "EMPRESA" em caixa alta (app/app/settings/metas/page.tsx:68-70).

### modelos-de-proposta

- **D187 · leitura.** O campo 'Para que serve (opcional)' dos modelos (proposal_templates.descricao) não é lido por ninguém. Fonte: `(app/api/v1/settings/proposal-templates/route.ts:167`.
- **D188 · leitura.** A caixa 'Obrigatória' do editor de modelo não tem efeito no documento. Fonte: `([slug]/_client.tsx:180-183`.
- **D189 · leitura.** O hub de Configurações não filtra o cartão 'Modelos de proposta' por capacidade nem por módulo. app/app/settings/page.tsx:34-45 não passa capacidadesLigadas ao NavHub (sem esse parâmetro, o hub não filtra: components/shell/NavHub.tsx:25-26), e a entrada do catálogo tem capacidade mas não tem modulo… Fonte: `(app/app/settings/tenant/proposals/layout.tsx:14`.
- **D190 · leitura.** A mensagem de falha da IA na importação de modelo chega ao usuário em linguagem técnica. importar/route.ts:89 devolve err.message, por exemplo 'provider LLM desconhecido na config da org: …' ou 'modelo não habilitado para a org (enabled_models): …' (lib/agent-engine/edge/llm/run-model-call.ts:105,113). Fonte: `(app/app/settings/tenant/proposals/modelos/_client.tsx:105,173`.
- **D191 · leitura.** O editor de modelo não mostra quais campos existem. Fonte: `([slug]/_client.tsx:202-209`.
- **D192 · leitura.** 'Personalizar' grava a cópia no clique, antes de qualquer edição (route.ts:111-134).
- **D193 · leitura.** As páginas /app/settings/tenant/proposals/modelos e /modelos/[slug] não verificam o papel do usuário (page.tsx só faz requireAuth).

### notificacoes

- **D194 · leitura.** Push com o site fechado ignora a escolha por tipo: o servidor envia 'Lead atribuído', 'Lead ganho', 'Lead perdido' e 'Você foi mencionado' a todo aparelho inscrito sem consultar os interruptores de Push por linha (lib/notifications/push.handler.ts:286-316; o próprio lib/notifications/prefs.ts:133-135 admite que 'o… Fonte: `(app/app/settings/notifications/_client.tsx:171-178`.
- **D195 · leitura.** O cartão push-status-pronto diz 'In-app (toast) e Push (Chrome) já funcionam para as cinco categorias, inclusive com a aba fechada.' (app/app/settings/notifications/_push-neste-endereco.tsx:43-45).
- **D196 · leitura.** O lembrete de tarefa por WhatsApp manda só o nome da tarefa, sem dizer que é um lembrete nem se está perto de vencer ou já venceu (app/api/v1/cron/task-reminder/route.ts:415 usa texto.corpo; lib/tarefas/preferencia-de-lembrete.ts:242-249).
- **D197 · leitura.** O rótulo do campo de WhatsApp diz 'Número com DDD, só dígitos' (_tarefas.tsx:155) e não pede o código do país, mas sem o 55 a busca do contato nunca casa (lib/channels/phone-variants.ts:35-38 só prefixa '+'), e o lembrete cai em silêncio no motivo sem_contato.
- **D198 · hipótese.** Apagar o número de WhatsApp e sair do campo grava string vazia, que a validação recusa (regex ^[0-9]{8,15}$ em lib/tarefas/preferencia-de-lembrete.ts:111-115).
- **D199 · leitura.** Menor: o quadro sem chaves mostra comandos de terminal ('bash hostgator-setup-kit/update.sh', 'npx web-push generate-vapid-keys') e nomes de variável .env a qualquer membro, inclusive leigos sem acesso ao servidor (app/app/settings/notifications/page.tsx:87-105).

### organizacao

- **D200 · leitura.** Texto da tela diz o contrário da regra: app/app/settings/tenant/_inbox.tsx:67 diz que a trava vale para quem abre 'uma conversa sem responsável', mas lib/inbox/bloqueio-ate-assumir.ts:31 trava qualquer conversa cujo responsável não é quem está na tela, inclusive a que é de um colega.
- **D201 · leitura.** 'URL política de privacidade' não chega ao público: lib/legal/operador.ts:97-108 e 120-122 só preenche politicaPropria com sessão de um membro da empresa, então app/legal/privacy/page.tsx:20 só redireciona a equipe logada.
- **D202 · leitura.** A Zona de perigo omite as propostas: _danger-zone.tsx:79 e 107 listam 'mensagens, conversas, negócios, contatos, agendamentos e pedidos', mas lib/settings/apagar-dados-operacionais.ts:66 e 142-147 também apaga crm_proposals e os PDFs delas.
- **D203 · leitura.** O CNPJ é único só como texto exato e não é validado: lib/schemas/settings.ts:90-95 aceita qualquer texto de até 20 caracteres, e baseline.sql:2383 (UNIQUE(cnpj)) não normaliza o formato.
- **D204 · leitura.** O aviso 'Dados inválidos.' do formulário da organização (app/app/settings/tenant/_form.tsx:58-61) não diz qual campo está errado: quem passa de 120 caracteres no nome ou de 20 no CNPJ não tem pista do que corrigir.

### perfil

- **D205 · leitura.** 'Sair' desconecta todos os aparelhos sem avisar: o menu só diz 'Sair' (components/shell/UserMenu.tsx:90-93), mas a ação faz o signOut global e desliga os avisos (push) em todos os aparelhos (app/actions/auth/signOut.ts:18-23).
- **D206 · leitura.** Fuso horário pessoal é gravado e não é usado: o Perfil grava user_metadata.timezone (app/actions/settings/updateProfile.ts:41), e o único lugar que o lê é a Agenda, que só o põe num atributo data-fuso (app/app/agenda/page.tsx:66; app/app/agenda/_client.tsx:469).
- **D207 · leitura.** O fuso aparece pelo código técnico ('America/Sao_Paulo') no Perfil (app/app/settings/profile/_form.tsx:27,119-123) e na Organização (app/app/settings/tenant/_form.tsx:119-123), embora lib/tempo/fusos.ts:33+ já tenha o nome legível ('São Paulo (Brasil)').
- **D208 · hipótese.** Plausível, não provado: salvar o Perfil chama só revalidatePath('/app/settings/profile') (app/actions/settings/updateProfile.ts:82). Fonte: `(app/actions/settings/trocarIdioma.ts:59`.
- **D209 · leitura.** Texto da tela errado: o subtítulo do Perfil diz 'Informações pessoais. Fonte: `(app/app/settings/profile/page.tsx:34`.

### plano-e-cobranca

- **D210 · leitura.** Faixa de cancelamento oferece uma ação que não existe: com a assinatura 'ativa' e cancela_no_fim=true, FaixaDaCobranca mostra 'Sua assinatura termina em DD/MM.' com o link 'Assinar de novo' para /app/settings/billing (components/cobranca/FaixaDaCobranca.tsx:35-47). Fonte: `(components/cobranca/AcoesDaAssinatura.tsx:120`.
- **D211 · hipótese.** Troca de plano no teste grátis promete o contrário do que acontece: o servidor aplica a troca NA HORA quando estado='trial' e trial_ate está no futuro (lib/cobranca/troca.ts:186, 370-376, 406-407). Fonte: `(components/cobranca/AcoesDaAssinatura.tsx:355-366`.
- **D212 · leitura.** 'Números conectados' conta mais do que números conectados: lerUsoDaOrganizacao conta todo channel_sessions não arquivado, exceto wacalls (lib/cobranca/uso.ts:39-44). Fonte: `(components/cobranca/PainelDaAssinatura.tsx:64`.
- **D213 · leitura.** app/app/settings/billing/page.tsx:71-72: a tela onde o e-mail de suporte aparece mostra ao cliente final "Em breve — Fase 2" e "Billing entra na Fase 2 do roadmap.".

### propostas

- **D214 · leitura.** A validade padrão é ignorada nas propostas criadas à mão. app/app/proposals/novo/_client.tsx:57-60 e 81 preenche hoje + 15 dias fixos, sem ler 'Validade padrão (dias)'. Fonte: `(app/api/v1/proposals/route.ts:128-132`.
- **D215 · hipótese.** Configurações › Propostas não confirma quando salva (app/app/settings/tenant/proposals/_client.tsx:34-49).
- **D216 · leitura.** O campo de validade tem min=1 mas não tem max=365 (_client.tsx:69-75), embora o servidor recuse acima de 365 (route.ts:17).
- **D217 · leitura.** A dica da chave 'Avisar no WhatsApp da equipe…' diz só 'Sem ele configurado e ligado, nada é enviado' (_client.tsx:96-98). Fonte: `(lib/propostas/aviso-no-whatsapp.ts:126-133`.

### recursos-opcionais

- **D218 · leitura.** Os módulos falham fechados na leitura. Fonte: `(lib/instalacao/modulos.ts:136-150`.
- **D219 · leitura.** O subtítulo da parte 'Em cada agente' diz 'Estes se ligam em cada agente, em Agente de IA › Agentes.' (app/app/settings/recursos/page.tsx:145).
- **D220 · leitura.** O cabeçalho da tela da empresa diz 'Tudo o que se liga e desliga, num lugar só' (page.tsx:86), mas a lista deixa de fora os recursos da instalação e do servidor (E-mail, Google Agenda, API Oficial da Meta, voz, Nuvemshop, Google Ads, Transcrição, Quem pode criar conta), em catalogo.ts:163-350 e page.tsx:55-57.
- **D221 · leitura.** O módulo 'Login do Codex por assinatura', quando está ligado, aparece como 'Disponível nesta instalação' sem botão Ajustar. Fonte: `lib/navigation/catalogo.ts`.

### seguranca

- **D222 · leitura.** Recuperação só procura nos primeiros 200 usuários: useRecoveryCode chama admin.auth.admin.listUsers({ page: 1, perPage: 200 }) e procura o e-mail só nessa página (app/actions/auth/useRecoveryCode.ts:~55-66).
- **D223 · leitura.** Aviso que some antes de aparecer: toast.success seguido de window.location.reload() na linha seguinte, em salvarPolitica ('A política de verificação foi salva.', app/app/settings/security/_client.tsx:85-86) e ao desligar a verificação ('Verificação desligada.', _client.tsx:382-383).
- **D224 · leitura.** No login com código, a caixa 'Confiar neste dispositivo por 30 dias' fica depois de um campo que já abre com o cursor e envia sozinho no sexto dígito (components/auth/MfaForm.tsx:77-94).
- **D225 · leitura.** A janela de cadastro aberta pelo botão 'Ativar' em Segurança (motivo='escolha') não tem botão de cancelar nem fecha com Esc (components/auth/MfaEnrollModal.tsx:88-223).
- **D226 · leitura.** Jargão técnico na tela: 'Habilite MFA antes de gerar códigos.' (app/app/settings/security/_client.tsx:106,264).
- **D227 · leitura.** O painel de chamada de voz afirma 'Ligada. Fonte: `(components/voice/PainelDeChamadaDeVoz.tsx:152`.
- **D228 · leitura.** console.warn/console.error em código de produção: app/actions/auth/useRecoveryCode.ts (aviso de service role ausente e falha ao apagar fatores).

### servidor-mcp-externo

- **D229 · leitura.** Cadastrar o servidor MCP externo não tem efeito em nenhum agente, e não há porta na interface para isso. Fonte: `(app/app/ai/agents/[id]/_components/ToolPicker.tsx`.
- **D230 · leitura.** A tela não mostra se já existe servidor cadastrado. Fonte: `(listarFerramentasMcpExternas.ts:87-90`.
- **D231 · leitura.** Os rótulos de carregamento vêm de um único estado 'pendente' (CadastroDoServidorMcpExterno.tsx:95, 207-211).
- **D232 · leitura.** Remover não pede confirmação (CadastroDoServidorMcpExterno.tsx:135-149) e anuncia 'Servidor externo removido' mesmo quando não havia nada cadastrado.
- **D233 · hipótese.** A checagem anti-SSRF no Salvar é só sobre o texto do endereço (lib/automation/outbound-url.ts).

### tags

- **D234 · leitura.** A coluna "Regras de agente" e o aviso de exclusão contam regras de automação DESLIGADAS. Fonte: `(lib/automation/engine.ts:268`.
- **D235 · leitura.** Seletor de cor da etiqueta: o title de cada bolinha é o código hex, por exemplo '#cf3716' (app/app/settings/tags/_painel.tsx:441).
- **D236 · leitura.** Contador com 1 etiqueta sai como '1 Etiqueta · Página 1 / 1', com E maiúsculo (app/app/settings/tags/page.tsx:122).

### tipos-de-agendamento

- **D237 · leitura.** app/app/settings/tenant/agenda/_client.tsx:473: depois de criar um tipo, `setRascunho(VAZIO)` zera `default_owner_user_id`.
- **D238 · leitura.** app/api/v1/agenda/tipos/route.ts:353: com `service_draft`, a rota força `default_owner_user_id: null` e descarta em silêncio o "Quem atende" que o formulário continua mostrando já preenchido com o criador (_client.tsx:533-555).
- **D239 · leitura.** app/app/settings/tenant/agenda/_client.tsx:556: a dica do rascunho manda abrir "Serviço e horários", mas não existe botão com esse texto.
- **D240 · leitura.** app/app/settings/tenant/agenda/_client.tsx:659-665: a linha mostra as antecedências do lembrete em minutos crus ("1440, 120 min antes"), enquanto o editor trabalha em dias/horas (_client.tsx:284-286).
- **D241 · leitura.** components/agenda/DiasBloqueados.tsx:298: o botão "Reabrir" aparece também nos dias marcados como "aberto excepcionalmente".
- **D242 · leitura.** app/app/settings/tenant/agenda/_client.tsx:894 + components/agenda/DiasBloqueados.tsx:176: o formulário de fechar dia só aparece para gerente ou administrador (podeEditar). Fonte: `(app/api/v1/agenda/excecoes/route.ts:98,114,`.
- **D243 · leitura.** i18n: textos sem t(): "Desativar" (_client.tsx:696), "Reativar" (:721), toasts "Tipo desativado."/"Tipo reativado."/"Tipo alterado." (:692,:717,:798) e o rótulo "Nome" do formulário de edição (:805). Fonte: `(app/api/v1/agenda/tipos/route.ts:360`.
- **D244 · leitura.** components/agenda/MeetComAcessoAberto.tsx:49-50,125: o aviso de self-host mostra a todo gerente termos técnicos ("app OAuth", "Meet API do Google Cloud", "escopo meetings.space.created", "tela de consentimento") numa tela de configuração usada por leigos.

### trunk-sip

- **D245 · leitura.** Trunk SIP: salvar uma alteração com a senha em branco sempre falha, apesar do texto cinza 'Deixe em branco para manter a atual' (app/app/settings/voip-trunk/_client.tsx:187). Fonte: `(app/api/v1/voip/trunk/route.ts:98`.
- **D246 · leitura.** Trunk SIP: o estado 'copiou' não volta ao normal depois de um novo Salvar (app/app/settings/voip-trunk/_client.tsx:76,101-105,243).

### Observações visuais adicionais do produto

Estes itens vieram das capturas dos revisores. Permanecem observações ou hipóteses, **sem reprodução independente nesta retomada**. As duplicatas dos itens D foram anexadas à causa correspondente no inventário; notas de montagem, dados de exemplo e limitações anunciadas ficaram em categorias próprias.

- **V001 · Admin — vocabulário comum.** O menu, as faixas e a auditoria misturam português, inglês e códigos internos no Admin.
- **V002 · admin-cadastro.** /admin/cadastro: com 'Cadastro apenas por convite' ligado, a chave 'Cadastro com aprovação' fica desabilitada, mas o texto dela continua 'Desligado: quem cria conta abre a própria empresa na hora.
- **V003 · admin-cadastro.** /admin/cadastro: a tela deixa ligar o cadastro só por convite com a faixa 'Sem SMTP configurado' ativa e não avisa que, nesse estado, os convites não saem por e-mail.
- **V004 · admin-configuracao.** Frase curta errada na 'Chave que assina os documentos de privacidade' (LGPD_SIGNING_KEY).
- **V005 · admin-dashboard.** Na página de saúde do tenant, o cartão 'AUDIT LAG' mostra o selo amarelo 'Atenção' com valores vazios ('—' em 'Último evento' e 'Lag').
- **V006 · admin-dashboard.** Na foto, o cartão 'LGPD em Risco' mostra 4 e a lista de alertas tem só 2 linhas de LGPD visíveis.
- **V007 · admin-inbox.** Página do tenant (/admin/tenants/<id>): a linha 'Plano' mostra um selo cinza vazio, sem texto, quando a empresa não tem plano.
- **V008 · admin-incidents.** O seletor de gravidade é estreito demais: o texto 'Todas severidades' encosta na setinha e aparece cortado em todas as fotos da lista (filtrando p1–p3, conhecendo p1–p3, resolvendo p5).
- **V009 · admin-incidents.** O Audit Trail não mostra a visita que acabou de acontecer: na abertura (p2) aparece vazio, mas depois (p4) mostra platform_admin.incident_viewed às 09:46:08, horário dessa mesma visita.
- **V010 · admin-lgpd.** O aviso vermelho conta só a primeira página (50) da lista sem filtro (_client.tsx:38, useAdminLGPDRequests({}) sem paginar).
- **V011 · admin-marca.** Os campos "Cor da marca" e "Cor da marca no tema escuro" mostram o quadradinho cinza com o placeholder "#7a5cd6" (roxo) escrito em clarinho.
- **V012 · admin-meta.** /admin/meta: o link "Abrir Conexões em outra aba" (data-testid meta-abrir-conexoes) quebra no meio, com "Abrir" numa linha e "Conexões em outra aba" na seguinte.
- **V013 · admin-meta.** /admin/meta, janela "Gerar um novo token de verificação?": o texto fala em "endereço do webhook", jargão para quem instala sem saber programar (a página diz "servidor"/"Conexões").
- **V014 · admin-platform-admins.** Em 'Concedido por', shortEmail (components/admin/platform-admins/PlatformAdminsTable.tsx:40-42) corta o domínio no primeiro ponto, então 'ana@empresa.com' e 'ana@empresa.com.br' aparecem iguais ('ana@empresa').
- **V015 · admin-users.** Pode ser auditoria em dobro: na ficha da Helena aparecem duas entradas organization.deleted no mesmo segundo (24/10 09:31:20) com o mesmo começo de código (organization · a9166666…).
- **V016 · api-tokens.** O campo "Expira em (dias)" usa placeholder="365".
- **V017 · automacoes.** Texto do produto, na tela Automações e no cartão da aba Atividade: 'o passo a IA decide é pulado' e 'desligou todos os passos a IA decide' trazem o nome do passo sem aspas, e a frase fica truncada para quem lê.
- **V018 · conversoes.** lib/conversoes/estado-da-conexao.ts:160: a mensagem de 'venda sem valor' é uma só para as duas plataformas.
- **V019 · conversoes.** Placeholders numéricos com cara de valor real ('123456789012345', '104987654321098', 'TEST12345', '+5511999998888') em _form.tsx, _identidadeDaMeta.tsx e _linksRastreaveis.tsx.
- **V020 · dados-externos.** Na confirmação "Remover esta conexão?", o botão "Remover" é verde, o mesmo verde dos botões de ação normais, quando deveria ser vermelho de ação perigosa.
- **V021 · dados-externos.** No guia 'Como criar um acesso só de leitura' do MySQL, os comandos saem cortados na direita ('TROQUE_POR_U…', "TO '") e precisam de rolagem lateral.
- **V022 · dados-externos.** O texto que aparece no campo Senha ao editar, 'Guardada — preencha só para trocar', é cortado na largura padrão do campo.
- **V023 · distribuicao-de-atendimento.** Aviso da combinação que trava tudo (aviso-combinacao-morta, _form.tsx ~250) usa bg-amber-50/60 com borda amber-500/40 e fica quase branco.
- **V024 · distribuicao-de-atendimento.** 'Voltar ao padrão da organização' confirma com a mesma frase do salvar: 'Responsáveis salvos.' (_channels-form.tsx:33, save(reset=true)).
- **V025 · equipe.** Aba Atendimento, coluna Horário: o ícone de relógio fica por cima do texto 'Não publicado', e o 'Editar' da Ana encosta na chave 'Disponível' (layout apertado)
- **V026 · equipe.** Editor de horário: o cabeçalho 'Sem janelas, o roteamento aceita conversa a qualquer hora...' continua aparecendo depois que as janelas são publicadas
- **V027 · extensoes.** Provável, deduzido só das fotos e não conferido num navegador ao vivo: o menu lateral e a barra do topo deixam de ficar fixos quando uma lista (Select) ou um aviso (AlertDialog) abre com a página rolada.
- **V028 · extensoes.** Falta o espaço depois do ponto e vírgula na permissão dos cartões instalados: 'Abre Agenda;não lê seus dados.' / 'Abre Contatos e Tarefas;não lê seus dados.'.
- **V029 · financeiro.** A seção Contas diz 'o valor aqui é só o ponto de partida', mas a tela não tem campo de saldo inicial. opening_balance_cents existe na API (lib/financeiro/catalogo.ts:46), só que o formulário e a lista não mostram esse valor.
- **V030 · lgpd.** O atraso aparece diferente na lista e no detalhe do mesmo pedido (7c41e9a2).
- **V031 · lgpd.** Pedido Concluído continua com o prazo contando.
- **V032 · lgpd.** Há duas réguas para o 'amarelo'.
- **V033 · meta-ads-conexao.** Produto (UX): o placeholder "act_123456789012345" em app/app/settings/meta-ads/_form.tsx:119 parece um valor real.
- **V034 · organizacao.** Subtítulo da tela Organização em inglês para o leigo: "Dados da empresa, retenção de mídia, DPO.
- **V035 · organizacao.** A explicação da própria tela sob "Perfil de interface" ("Perfil, segurança e acesso à equipe de quem administra continuam disponíveis") não cita Notificações, App no celular nem Organização, que também são essenciais em PORTAS_ESSENCIAIS.
- **V036 · plano-e-cobranca.** Os quadros "Trocar de plano" e "Cancelar assinatura" não têm botão de fechar ou voltar.
- **V037 · propostas.** Existem duas telas chamadas "Propostas": a de CRM (/app/proposals) e a de IA (/app/ai/proposals, 'Melhorias que a IA sugere para si mesma').
- **V038 · trunk-sip.** Trunk SIP: o texto do topo da tela usa jargão de servidor ('Asterisk/AudioSocket', 'VPS', 'asterisk/pjsip.conf') numa tela de Configurações que um administrador leigo vai abrir.

### O que foi corrigido no curso, fora do produto

- A restauração inclui `country`, `currency` e `media_retention_enforced`; snapshots novos guardam os valores exatos. Para snapshot antigo, os padrões do baseline são `null` (Brasil), `BRL` e `true`.
- A organização principal é resolvida pelo vínculo do dono. Antes da limpeza, a base recusa qualquer organização que não tenha um dos ids declarados pelas sementes; nem a principal pode entrar nesse conjunto. Não se escolhe mais a empresa pela data de criação.
- O App da Meta volta ao snapshot mesmo depois de uma captura parcial. O acesso direto exige Postgres local e a presença da mesma organização resolvida pelo client Supabase. Pedidos LGPD de ids próprios da demonstração são limpos antes de outra lição.
- O token real fotografado ao criar uma chave é revogado pela UI no `finally` da lição; falha de limpeza reprova a captura. A próxima preparação da base também revoga somente essa chave pelo nome e organização. Chaves cenográficas têm hash de segredo aleatório descartado. A regra de automação e os ponteiros de follow-up de demonstração ficam desarmados fora do módulo que os recria; não se usa o status do ponteiro como prova de que inscrições antigas pararam — a base também recria os contatos/conversas, e o ambiente foi conferido sem workers/agendador/WAHA pelo controlador.
- Organização › Salvar não espera um toast oculto pelo capturador: a persistência é conferida ao reabrir a página no passo seguinte.
- Medidas sem interseção com a foto falham explicitamente; alvos parcialmente visíveis são recortados nas quatro bordas. Nenhuma altura negativa é aceita. Os dois atalhos fora da foto em Distribuição foram removidos, mantendo o passo seguinte com o botão correspondente.
- As datas e versões das fotos são preservadas individualmente, e o rodapé distingue a atualização do material das datas reais de captura.

As anotações de ambiente da seção C continuam como histórico da primeira rodada. Os itens resolvidos acima não devem voltar a ser registrados como defeitos do produto.
