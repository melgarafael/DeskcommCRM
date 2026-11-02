# Propostas de campos do negócio a partir de documento

Destino: **núcleo**. A revisão humana de dados do card, a autorização, a
expiração e a anonimização são garantias do CRM; a viagem é apenas um exemplo
de documento. Origem: #3316 e contribuição de @webtecnica no #3471.

## Contrato implementado

**CONFIRMADO por código; medições e limites no [relatório de QA](../testing/propostas-de-campos-3476.md).**

- `crm_propose_lead_fields_from_document` recebe `lead_id`, um `attachment_id`
  opcional e até 25 campos com valor textual e trecho. Exige `agent` e `mcp:write`.
  A leitura da mídia é a que o assistente já faz na conversa; anexar no dossiê
  não dispara extração automática por esta entrega.
- Só os campos de escopo `negocio` do funil atual são elegíveis. Tipo, opções e
  padrão são conferidos antes de nascer a proposta. A ferramenta não grava o card.
- `GET /api/v1/leads/[id]/field-proposals` exige `viewer`, lê sob RLS e mostra
  somente pendências cujo prazo ainda não venceu. `LeadDossier` monta
  `RevisaoDoDocumento` com valor atual, proposto, trecho e link do anexo quando há.
- `POST /api/v1/leads/[id]/field-proposals/[pid]` exige `agent`. `accept` pode
  levar `valor` corrigido; `dismiss` pode levar `motivo` de até 300 caracteres.
  A confirmação revalida o funil atual e grava pela porta `updateLeadHandler`.
  Número já persistido em jsonb conserva sua escala; correção digitada passa pelo
  leitor de texto. Ambos continuam sujeitos ao padrão atual do campo.
- Falha ao gravar restaura a proposta como pendente. `ApiError` preserva código,
  mensagem e status; falha inesperada devolve `internal_error`/500 em JSON com
  mensagem genérica, sem copiar o conteúdo do erro para a resposta.
- A proposta nasce com prazo de sete dias. Decisão vencida devolve 409 e não
  escreve no card. O cron `contact-proposals-watcher` encerra pendências vencidas;
  o nascimento também libera a pendência vencida que bloqueava o mesmo campo.
- Auditoria de proposta, aceite e recusa guarda metadados. `motivo_recusa` fica
  na fila e é redigido, com trecho e valores, pela cascata LGPD nos vínculos
  direto e `crm_lead_links`. Status e instante da decisão permanecem.

## Continuidade e limites de prova

Entrada: documento já lido pelo assistente → ferramenta MCP → fila. Saída:
revisão no dossiê → `updateLeadHandler` → campos do card e atividade `lead_edited`.
Anexos emitem `document_attached`; erros de decisão aparecem na própria revisão.
O prazo é o mecanismo para não acumular pendências indefinidas.

O retorno humano altera o valor confirmado que os próximos atendimentos leem no
card. O motivo de descarte é guardado, mas **nenhum consumidor de aprendizado
automático desse motivo foi implementado**; não se afirma ajuste automático de
prompt. O mapa é `docs/architecture/propostas-de-campos.architecture.json`.

A 0772 original foi preservada: não há como afirmar que nenhum fork a aplicou.
A 0797 corrige a redação do motivo adiante e repete o corpo vigente da cascata,
com execução restrita a `service_role`. O baseline contém o mesmo bloco.
A 0807 exige no `WITH CHECK` o vínculo com o negócio visível da mesma organização
e limpa o motivo legado de contatos já anonimizados. O baseline instala somente
a policy final, para não reabrir a versão intermediária durante a atualização.

O relatório preserva as provas dirigidas de banco, tipos gerados e seis casos
reais de MCP/revisão/RBAC/concorrência. O aceite antes do merge exige os cinco
checks obrigatórios do candidato final; não se atribui a captura anterior ao
reparo posterior do ramo de erro inesperado.
