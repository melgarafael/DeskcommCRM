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
