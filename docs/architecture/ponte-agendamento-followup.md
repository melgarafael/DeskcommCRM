# A ponte entre agendamento, follow-up e Radar

Contrato implementado na Task6 da comunidade 360, migration 0224. A auditoria CAL-W0-PONTE de 2026-08-30 apontava uma régua sem consumidores; este documento agora descreve o enxerto executável. Histórico e medições anteriores permanecem no Git.

## Presença e tempo

`calendar_appointments` conserva contato/conversa, horário e estado. O operador registra compareceu/faltou após o início; cancelamento continua operacional. `fn_appointment_change` valida organização, papel efetivo e revisão observada. `auth.uid()` fornece autoria; corpo da API e tools não personificam o operador. Texto inbound certificado pode acompanhar a confirmação como evidência, sem inferência automática de significado.

A revisão muda com horário, vínculo, cancelamento e desfecho. Notas, checkpoints de sincronização e metadados Meet não a incrementam. Fonte, ator, mensagem e instante do desfecho referenciam dados existentes; a timeline e o audit guardam a ação humana. Referências apagadas por retenção viram nulas, sem desfazer o fato registrado.

`organizations.settings.agenda` usa schema compartilhado e UI em Configurações → Agenda: `confirmation_delay_minutes` (10 por padrão) e `unknown_protection_minutes` (1440). O horizonte não pode ser menor que a espera inicial. Valores legados inválidos degradam para os defaults, sem interromper o sweep.

O cron existente de follow-up chama `fn_appointment_confirmation_sweep`. Após fim + espera inicial, abre aviso por compromisso/revisão; snooze resolve e reabre o mesmo aviso. Após o horizonte, escala o desconhecido. Tempo nunca muda estado para falta nem inicia recuperação.

## Uma regra de proteção

`lib/agenda/protecao-followup.ts` calcula compromisso futuro/em curso/presença pendente/proteção vencida. Outro compromisso vivo continua protegendo o contato. Depois do horizonte só a proteção excepcional acaba; o desconhecido fica visível no Radar e na Central.

Consumidores: `silence-sweep`, engine, automações de mensagem, inline de texto, jobs do daemon, callbacks, Radar e score. `lib/agenda/efeito.ts` transporta finalidade proativa em contexto interno até o `beforeSend` do handler canônico de mensagens. Nenhum schema público aceita bypass. O adapter Supabase lê páginas ordenadas por ID até página vazia; uma página curta não prova ausência, pois o PostgREST pode truncá-la abaixo do limite solicitado. Leitura indisponível adia com diagnóstico; não produz score falsamente saudável. Link/lembrete dedicado das Tasks7/8 deverá ter produtor interno próprio, preservando as guardas de atendimento e autorização.

Um transporte que já aceitou a mensagem não pode ser desfeito. As guardas são reavaliadas imediatamente antes do efeito; queued/failed não são envio concluído. Turno deliberadamente sem envio termina com `turn_skipped` e motivo visível, sem inventar envio ou repetir indefinidamente as mutações CRM realizadas.

## Falta confirmada → decisão terminal

O evento interno `appointment.outcome_confirmed` tem consumidor `followup-gatilho-presenca.v1`. `fn_appointment_recover` valida o evento, organização, compromisso e revisão sob mutex org/contato. Recibo privado `appointment_recovery_receipts` e inscrição são atômicos. Fluxo publicado apto inicia na versão pinada; nenhum fluxo apto, múltiplos pointers ou outro fluxo vivo (inclusive pausado) geram resultado terminal visível. Não há precedência incidental por UUID nem espera oculta por vaga. Retry depois de liberar a vaga não inicia a recuperação recusada.

O recibo mantém o resultado original e `invalidated_at` quando interrompido. RLS/ACL permitem SELECT apenas a service_role; comandos internos escrevem. A rota do detalhe prova antes o acesso ao compromisso pela sessão e só então projeta o recibo por org/id/revisão. `source_event_id ON DELETE SET NULL` conserva a decisão após expurgo. Evento ausente nunca concede novo início, com ou sem recibo.

Inbound canônico distinto, certificado sob o mutex da Task4, invalida a recuperação quando `sent_at >= date_trunc('second', outcome_recorded_at)`. Histórico anterior é ignorado; duas respostas posteriores fora de ordem continuam válidas. No mesmo segundo, a identidade distinta conta como retorno. Quando o provedor omite timestamp, a ingestão usa seu fallback: não existe dado canônico capaz de separar histórico de entrada ao vivo nesse caso. Não há classificador nem contador extra.

A certificação invalida o recibo antes do consumer ou interrompe inscrição já criada, inclusive pausada e `cancel_on_reply=false`. Não se usa `messages.created_at` como ordem de certificação: uma transação pode começar antes do desfecho e adquirir o mutex depois. A prova DB reproduz essa ordem.

## Job, loop e callback

O engine já grava uma chave `node_id:steps_taken` em cada evento de passo. O payload interno do job agora carrega `source_step_key`, a chave do seu enqueue. Não há nova revisão/epoch: rechecks incrementam o contador existente e permanecem válidos, enquanto qualquer passo posterior que avance/encerre aquela execução invalida o job mesmo se o fluxo retornar ao mesmo `node_id`.

`fn_followup_job_current(org,job,enrollment,node)` valida a tupla, estado, origem da recuperação e evento de enqueue. Só chaves canônicas do passo entram na comparação; a chave do recibo de inscrição não é um passo. Job antigo sem marcador ou cujo evento fonte foi expurgado falha fechado; o consumidor não recaptura a geração atual. Trigger protege escrita cliente nos jobs de follow-up e nos eventos de passo; o marcador e vínculo do job são imutáveis também para updates internos.

`jobId` e `JobClaim { worker_id, acquired_at }` acompanham o contexto até transporte e callback. O claim PG devolve `locked_at::text` para preservar microssegundos; o inline captura o valor devolvido pelo UPDATE. Nenhuma borda recaptura o dono/instante da linha atual. `fn_followup_claim_current(org,job,worker,acquired_at)` exige estado running e aquisição exata: reaper ou reclaim, inclusive pelo mesmo worker lógico, invalidam o executor antigo. `fn_followup_apply_step` valida claim e geração sob mutex + lock da linha do job e combina CAS de enrollment + evento no mesmo commit. Callback velho não deixa evento órfão, não ressuscita cancelamento e não avança um loop posterior. O inline liquida retry/aviso terminal atomicamente com a aquisição original; ausência do token falha fechado. A fila PG também compara aquisição nas operações de conclusão/cancelamento/falha/adiamento do executor.

Inline e daemon usam `lib/agent-engine/edge/crm/send-ledger.ts`: a intenção `(job_id,seq)` determina o ledger, metadata.idempotency_key e o ID interno da mensagem. Retry pelo outro executor reconcilia o mesmo recibo, inclusive após envio aceito e callback indisponível. `queued` tenta novamente a mesma mensagem; `sending` não duplica transporte em voo; somente sent/delivered/read confirmam o envio.

## Superfícies e autorização

Agenda, entrada contextual pelo Inbox, aviso da Central e Radar abrem `/app/agenda?compromisso=id`, inclusive fora da semana atual. `DetalheDoCompromisso` mostra presença, evidência, snooze, resultado/impedimento e interrupção; o acompanhamento abre o dossiê existente. A revisão é capturada ao iniciar o rascunho ou decidir. Polling pode mostrar o resultado assíncrono, mas mudança de revisão bloqueia a edição antiga até descarte e revisão explícitos. CAS recusado também preserva o bloqueio. Configuração do gatilho fica no editor de follow-up existente e a ausência de configuração é explicada na tela.

O GET do detalhe projeta o `time_zone` existente no compromisso. O período e o registro da presença usam esse fuso e o idioma canônico da interface (`useTagDeIdioma` → `tagDeIdioma`); `formatRange` preserva o dia final quando o intervalo atravessa a meia-noite. Trocar o idioma não altera os instantes, a autoria nem a revisão. A prova frontend usa navegador inglês/Honolulu, compromisso São Paulo e troca real PT→ES.

Radar humano usa `createClient()` autenticado. Para agent, candidatos de demanda com lead são validados em lote próprio sob RLS + org; o pool frio limitado não é autorização. Demanda sem lead exige conversa vinculada visível. Contagens são posteriores ao recorte. Gestão/suporte full preservam visão org-wide; viewer/readonly continuam 403. Runtime/MCP conserva contexto interno e cálculo compartilhado.

Prova local final em 2026-09-06: os sete casos de `tests/e2e/agenda-presenca-recuperacao.spec.ts` passaram no build de produção, incluindo crons, receiver nos dois sentidos, aquisição vencida, proteção além de mil linhas, RLS do Radar e duas sessões. Evidências selecionadas e limites em `docs/testing/user-journey-map.md`; comandos, logs e reconciliação das rodadas em `.superpowers/sdd/comunidade-360/task-6-report.md`. O receiver HTTP controlado prova transporte, não pareamento/entrega real de WhatsApp ou consentimento Google. Mapa de arestas: `followup-dossie.architecture.json`.
