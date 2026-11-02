# Propriedade da fila de execução

`job_queue` é o registro interno de trabalho, identidade e lease do motor.
O cliente de sessão lê estado da própria organização. A escrita direta pertence
à conexão interna e ao cliente de serviço; a role dedicada do worker conserva
seus grants próprios, conforme [o guia self-host](../deploy-selfhost/README.md).

| Ação | Porta |
|---|---|
| Conferir estado de entrega | SELECT de sessão, sob RLS existente |
| Aprovar resposta assistida | fn_reply_action, com ator, MFA, contexto e revisão |
| Autorizar/repetir entrega de compromisso | fn_meet_action, com dono, destino e revisão |
| Criar, reivindicar e dispor trabalho | produtores internos e serviço; lease canônico |
| Assumir conversa, suspender organização, LGPD e fusão | comandos/gatilhos já existentes |

A migration 9020 separa essas portas por ACL sem alterar estados, índices,
policies ou assinaturas dos comandos humanos. Não há nova configuração,
credencial ou permissão em outras tabelas.

A coluna nullable `job_queue.catalog_presentation_snapshot` começa vazia em
linhas legadas e não recebe backfill. A chave antiga no payload NÃO autentica
estado: o consumidor do #3525 deverá ignorá-la por completo. Não há limpeza histórica
que apague retomadas válidas quando o baseline é reaplicado.

`catalog_presentation_snapshot` é estado reservado de execução. Não é
entrada de enqueue, mesmo quando o enqueue é produzido pelo scheduler. Sua
presença no payload de INSERT recusa o job, inclusive com valor null; uma coluna
preenchida no INSERT também é recusada. O produtor interno
legítimo grava o snapshot por UPDATE do job running, sob o lease original;
esta migration não muda essa aquisição nem autoriza dados pelo nome de uma role
ou por um campo do JSON. A allowlist do estado inclui só o plano já existente e
os quatro campos canônicos de AgentOperation (`organizationId`, `agentId`,
`versionId`, `revision`), sem copiar o contexto inteiro. Validação e revalidação antes de
cada envio pertencem ao consumidor do #3525, ainda pendente nesta fundação.

A virada de `contacts.is_anonymized` limpa a coluna na própria org/contato por
trigger restrito. Excluir o contato continua usando a FK com ON DELETE CASCADE.
O produtor deverá recusar gravação posterior à anonimização. Na mesma transação,
adquire primeiro o mutex de atendimento existente `fn_service_lock(org,contato)`
e depois bloqueia o job com a identidade/lease exatos. Só então faz o UPDATE em
uma nova instrução, conferindo contato não anonimizado e `rowCount`. Esse é o
mesmo ordenamento contato→job da anonimização canônica; um EXISTS isolado não
serializa os dois produtores. A prova em duas sessões está em
`tests/invariants/fila-snapshot-e-lgpd-concorrencia.test.ts`. ACL não substitui
os cortes de lease, atendimento e operação no código confiável do worker.
O UPDATE direto de `contacts.is_anonymized` já passa pelo gatilho canônico
`fn_contact_redaction_lock`: quando o mutex está ocupado, a tentativa não
espera com o row lock invertido; recusa com `40001/contact_redaction_busy`.
O chamador precisa repetir a transação inteira. A 9020 conserva essa porta.

Provas de banco em `tests/invariants/fila-propriedade-e-snapshot-interno.test.ts`:
ACL por dois tenants, serviço/worker, claim/lease, RPCs humanas, cascata e porta
do scheduler. Preparação de teste não significa execução; o relatório do PR
deve registrar os resultados reais de install/update e os limites observados.
