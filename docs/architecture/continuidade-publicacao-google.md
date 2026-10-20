# Publicação Google e continuidade do atendimento

A reserva permanece na API e nas RPCs nativas da agenda. `publishBookingNow` reutiliza `reconcileAppointment`, com deadline de quatro segundos para o conjunto de requisições Google da operação. Nenhuma transação ou conexão PostgreSQL fica aberta durante HTTP. A releitura usa o evento persistido, a revisão Google local/sincronizada e `needs_google_push=false`; Google sincronizado não concede aprovação humana.

`google_publication_continuations` registra somente identidade da operação, compromissos/revisões, origem autenticada e fronteira do atendimento. Essa persistência é necessária porque a fila de sincronização anterior sabia publicar, mas não conservava o próximo passo da conversa. Nenhum compromisso existente é inscrito pela migration. RLS e privilégios reservam a escrita/leitura interna ao servidor; entradas públicas não fornecem autorização.

O registro começa em `attempting`. Após a tentativa, o handoff atômico escolhe `inline` quando a publicação já está comprovada, ou `waiting`. Apenas `waiting` pode gerar `google_publication_turn`. O turno original termina ao devolver a posse da resposta; não faz polling com LLM nem transforma espera em Caso. A recuperação no cron existente cobre interrupção antes do handoff; a confirmação Google gera um único evento/job na transação. Reentregas conservam identidade, lease e ledger nativos.

A continuação usa `runAgentTurn`, a mesma cadeia de revisão/envio e o mesmo contexto factual do agente/JEV/reserva/confirmador. Antes de qualquer efeito, `fn_google_continuation_current` confere a aquisição do job, operação do agente, origem, revisões, cancelamento/remarcação, fronteira/demanda, opt-out, anonimização e tomada humana. Sua ferramenta não pode alterar a reserva capturada. O texto do agente segue as instruções comerciais vigentes; não há texto empresarial fixado no motor.

Falhas Google são classificadas pelo classificador existente. Transientes conservam recuperação finita (20 tentativas, mesmo teto usado pelo Meet); falhas permanentes ou esgotamento precisam de intervenção. `google_sync_failure_kind` preserva essa distinção também no recibo/contexto. Google/Meet não prontos nunca produzem confirmação de publicação.

Living System Checklist: entrada na reserva nativa e no executor Google; saída para `job_queue` e `runAgentTurn`; evento `appointment.google_publication_ready` e atividade na timeline; acesso pela conversa/agenda existentes; recuperação no cron Google; configurações e erros nos painéis existentes da agenda; tomada humana revoga a continuidade; nova revisão cancela a prova antiga. Nenhuma nova tela, configuração de provedor, cron ou ambiente. O mapa JSON da agenda registra as arestas.

Validação: provas diretas do executor/recibo e em par com o turno nativo, com fixtures fictícias e doubles de transporte/modelo/canal. Essas provas não demonstram entrega ou publicação externa. Build e validação nas instalações são checkpoints posteriores; contribuição pública suspensa até autorização do responsável.

## Reconhecimento e nova entrada durante recuperação

O reconhecimento mantém evento/job/posse atômicos. A nota auxiliar é gravada idempotentemente pelo job nativo em statement separado, sem esperar contato/negócio; busy usa retry da fila. Uma nota não desfaz publicação nem segura inventário de agenda.

O inbound dispõe de resume_google_publication para acompanhar explicitamente os IDs da mesma reserva. Exige registro anterior, conversa/demanda/revisões atuais, execução/lease próprios e ausência de revogação/tomada humana. A nova entrada invalida o callback antigo; só o pedido atual adquire continuidade. Tool/revisor usam recibo relido; pending/retrying não é aprovação humana. Cancelamento, remarcação e casos legítimos preservados.

Diagnóstico contém fase, SQLSTATE/statusHTTP, tipo allowlisted, duração e prazo/lease, sem corpos/argumentos/identidades. Timeout não se apresenta como mudança de revisão.

O alerta low_sentiment aguarda brevemente a decisão do inbound atual (no máximo2min pelo relógio do banco). Somente a ação nativa explícita de acompanhamento da mesma reserva, com prova/autoridade atuais, consome esse alerta sem handoff. Sem adoção, prazo vencido, falha humana ou outro pedido, a política original permanece. Pedido explícito de humano e detecção semântica independente não são suprimidos; nenhum outro motivo de handoff muda. Não há nova chamadaLLM nem fila paralela: usa retry_at do dispatcher existente.

O produtor que reconhece o Google também tenta o mutex de contato sem esperar enquanto detém o inventário da agenda. Contenção preserva o recibo e a linha waiting; o cron nativo enfileira depois. A nota auxiliar é escrita pelo job com lease atual, em outra transação.


A revisão distingue o resultado operacional da confirmação por uma pessoa. O contexto factual calcula `natureza_confirmacao` a partir da reserva e do recibo Google atuais. `reserva_publicada_sem_aprovacao_humana_exigida` exige confirmação humana explicitamente dispensada, status confirmado, publicação sincronizada na mesma revisão e ausência de escrita/erro pendente. Isso descreve o recibo; não libera a cadeia de envio ou promete uma nova ação. Estado desconhecido, espera e aprovação humana exigida continuam explícitos. O dado chega pelo mesmo pacote ao agente, JEV, reserva e confirmador.

A classificação compara o pedido atual com beneficiário, serviço, data e horário do recibo. Comunicar fielmente essa execução sem atribuir aprovação a uma pessoa não é repasse humano; alegar que a equipe aprovou continua exigindo a fonte humana pertinente. Recibo de reserva não autoriza promessa comercial adicional nem comprova comunicação/presença. Casos pendentes incluem título, bloqueio e pedido original para não serem confundidos com outro pedido na mesma conversa. Gates, fotografia/revalidação, consentimento JEV e fronteira permanecem ativos.

O fluxo individual nativo, com os campos de serviço explicitamente nulos na leitura canônica, conserva a confirmação operacional pelo recibo publicado. Campos ausentes ou configuração de serviço desconhecida não são interpretados como dispensa humana.
