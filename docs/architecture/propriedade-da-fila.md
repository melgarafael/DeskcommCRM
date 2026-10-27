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
estado: o runtime de apresentação ignora essa chave por completo. Não há limpeza histórica
que apague retomadas válidas quando o baseline é reaplicado.

`catalog_presentation_snapshot` é estado reservado de execução. Não é
entrada de enqueue, mesmo quando o enqueue é produzido pelo scheduler. Sua
presença no payload de INSERT recusa o job, inclusive com valor null; uma coluna
preenchida no INSERT também é recusada. O produtor interno
legítimo grava o snapshot por UPDATE do job running, sob o lease original;
esta migration não muda essa aquisição nem autoriza dados pelo nome de uma role
ou por um campo do JSON. A allowlist do estado inclui só o plano já existente e
os quatro campos canônicos de AgentOperation (`organizationId`, `agentId`,
`versionId`, `revision`), sem copiar o contexto inteiro. A leitura valida plano, escopo e identidade originais. Antes de cada envio,
BeforeSend e sendTurnMessage reconferem essa mesma operação; não escolhem a
publicação mais recente para reautorizar o plano.

A virada de `contacts.is_anonymized` limpa a coluna na própria org/contato por
trigger restrito. Excluir o contato continua usando a FK com ON DELETE CASCADE.
O produtor recusa gravação posterior à anonimização. Na mesma transação,
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

A retomada do catálogo usa a coluna dedicada de uma linha reivindicada pela
fila, inclusive em processo novo. ColunaNULL permite o caminho normal do handler;
payload legado não autoriza nem decide o replay. Identidade ausente, inválida ou
operação alterada falham fechadas. O lease é conferido antes da materialização e
novamente pelo corte canônico do envio. A ferramenta terminal impede fallback
após falha durante a apresentação.

`tests/invariants/catalogo-operacao-persistida-real.test.ts` mede o produtor real,
LGPD concorrente e processo novo com handler/BeforeSend e receptor HTTP local.
Reusa a ponte SQL do harness; não mede HTTP PostgREST. O teste de salvar,
recarregar e revisão obsoleta está em `tests/e2e/fotos-no-catalogo.spec.ts`.
O relatório do PR distingue prova executada e evidência visual ainda pendente.
