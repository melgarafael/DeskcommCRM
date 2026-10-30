# Feature A — LeadSubmitted por clique CTWA recebido

## Estado e decisão de produto

Esta branch de contribuição porta a Feature A para a `main` oficial a partir do checkpoint
[`eacc82d232d6c3e9a6b21b2c73713c112fbf6857`](https://github.com/oianmaxdev/DeskcommCRM/commit/eacc82d232d6c3e9a6b21b2c73713c112fbf6857)
do fork. O comportamento funcional foi homologado no SHA
[`4d76349977ed5196a90c00722c240ae4764af747`](https://github.com/oianmaxdev/DeskcommCRM/commit/4d76349977ed5196a90c00722c240ae4764af747).
A correção textual de marca e traduções está no commit
[`e85f6abfb585f30d42259361503cc557f6113870`](https://github.com/oianmaxdev/DeskcommCRM/commit/e85f6abfb585f30d42259361503cc557f6113870),
com 73 testes dirigidos aprovados no fork. **Os gates desta branch portada ainda precisam ser
executados; a evidência do fork não os substitui.**

**A Feature A termina na A1. A2 foi cancelada.** Purchase, QualifiedLead e MetaEtapa mantêm a
atribuição de primeiro toque. Não houve merge na `main` oficial, deploy nem aceite real da Meta.

## Problema e regra funcional

Um contato pode voltar por anúncios Click-to-WhatsApp (CTWA) diferentes sem nascer outro card.
Vincular `LeadSubmitted` ao nascimento do lead perde esses novos cliques; criar um card por clique
duplicaria trabalho comercial. A A1 registra cada clique CTWA válido recebido numa mensagem
inbound e cria uma oportunidade de envio independente do card, preservando o primeiro toque.

- **Clique e abertura do WhatsApp não bastam.** A conversão depende de uma mensagem inbound
  efetivamente recebida com `ctwa_clid` confiável na evidência do canal.
- Novo contato, contato existente e contato com lead aberto podem produzir `LeadSubmitted` para
  **cliques diferentes**, sem gerar card adicional por causa do clique.
- O mesmo `ctwa_clid` na mesma organização identifica uma única oportunidade. Reentrega do
  webhook, mensagens posteriores, concorrência e retry não criam outro `event_id`.
- `source_id`/`ad_id` identifica o anúncio, **não** substitui `ctwa_clid`. Mensagem orgânica,
  origem `post` e prova causal fornecida pelo cliente não tornam o clique elegível. O parser
  atual também aceita `ctwa_clid` quando `sourceType` está ausente; essa compatibilidade foi
  coberta no E2E sintético, mas a origem CTWA real ainda precisa ser verificada.
- A chave por organização começa desligada. A captura usa o relógio do banco e guarda o instante
  da ativação; clique anterior à ativação, durante uma desativação ou de uma ativação anterior
  não é enviado após reativação. O consumidor confere a ativação antes de iniciar o POST. Uma
  chamada já iniciada pode terminar após o desligamento.

## Caminho da mensagem ao registro de envio

1. A entrada WAHA autentica o webhook pelo mecanismo configurado e deduplica a mensagem por
   `organization_id` e `external_id`. Os parsers em
   [`lib/waha/atribuicao-de-anuncio.ts`](../../lib/waha/atribuicao-de-anuncio.ts) e
   [`lib/channels/atribuicao-de-anuncio-oficial.ts`](../../lib/channels/atribuicao-de-anuncio-oficial.ts)
   distinguem `ctwa_clid` do ID do anúncio. A ingestão grava a âncora `meta_ctwa_message_v1`
   nos metadados da mensagem, conforme
   [`lib/leads/prova-meta-lead-submitted.ts`](../../lib/leads/prova-meta-lead-submitted.ts).
2. O trigger `trg_record_meta_ctwa_click`, criado pela
   [migration 0805](../../supabase/migrations/20261026191002_0805_meta_lead_por_clique.sql),
   insere `meta_ctwa_click_dispatches` **na transação da mensagem**. A linha preserva organização,
   contato, primeira mensagem, `ctwa_clid`, instante confiável, época de ativação e `event_id`.
   A identidade não pode ser reassociada por atualização. A unicidade por organização e
   `ctwa_clid` impede um segundo registro; a linha retém o ID da primeira mensagem mesmo se a
   conversa for excluída e é removida por cascata quando contato ou organização forem excluídos.
   Num pedido do titular o contato é **anonimizado**, não excluído: aí quem apaga as linhas dele
   é o gatilho da virada de `is_anonymized`
   ([migration 0806](../../supabase/migrations/20261026191003_0806_clique_ctwa_some_na_anonimizacao.sql),
   doc de decisão 199). Se a Meta reenviar um clique antigo dessa pessoa, ele é contado de novo.
3. A mensagem emite `message.received` pelo mecanismo do banco. O dispatcher registra
   [`conversoes.clique_meta`](../../lib/conversoes/clique-meta.handler.ts), que busca a linha na
   organização, valida a ativação, faz claim por RPC e envia pelo
   [transporte Meta](../../lib/plataformas-de-anuncio/meta/conversions.ts). O consumidor legado
   de `lead.created` continua disponível para eventos anteriores e se abstém quando já existe a
   linha do clique; não há segundo emissor para o mesmo clique.
4. O `event_id` é `<id da linha>:LeadSubmitted`. Claim com token e lease, settlement e reenvio
   usam as RPCs `fn_claim_meta_ctwa_click`, `fn_settle_meta_ctwa_click` e
   `fn_solicitar_reenvio_meta_ctwa_click`. Falha transitória agenda retry com a mesma identidade.
   A função `fn_meta_ctwa_click_enviado_legado` consulta a prova histórica
   `meta_capi_lead_birth_v1` e impede reenviar um clique já marcado `sent` no ledger anterior.
5. O POST à Graph usa `/{dataset_id}/events`, `LeadSubmitted`, `action_source` de mensagem,
   `ctwa_clid` e a identidade estável. O transporte exige confirmação `events_received = 1`;
   isso comprova a resposta da API, não a atribuição da conversão a uma campanha. Com
   `test_event_code`, o ledger fica `skipped` (`evento_de_teste`), não `sent`.

A [migration 0803](../../supabase/migrations/20261026191000_0803_meta_lead_submitted_causal.sql)
introduziu a prova causal de nascimento e o ledger legado. A
[migration 0804](../../supabase/migrations/20261026191001_0804_ativacao_meta_lead_por_org.sql)
introduziu a ativação por organização. O [baseline](../../supabase/baseline.sql) contém os
apêndices idempotentes das quatro mudanças. A 0805 traz `-- manifest:` no próprio SQL, RLS ligada,
grants restritos a `service_role` e filtros explícitos de organização no consumidor. O
`supabase/migrations/MANIFEST.md` é histórico e, pela doutrina atual, **não recebe linha nova**.

## Configuração e operação

1. Em **Configurações → Conversões**, configure uma conexão direta Meta Ads da organização com
   dataset e credencial CAPI próprios. Para o evento de mensagem, a identidade da conta precisa
   fornecer `page_id` **ou** `whatsapp_business_account_id`. A captura precisa receber a
   evidência CTWA real pelo canal de WhatsApp.
2. Um administrador da organização ativa **Enviar LeadSubmitted por clique CTWA à Meta** na
   mesma tela. A [ação](../../app/actions/settings/definirLeadSubmittedCausal.ts) usa a
   organização da sessão, RBAC, MFA quando exigida, bloqueio de suporte somente leitura,
   [RPC com horário do banco](../../supabase/migrations/20261026191001_0804_ativacao_meta_lead_por_org.sql)
   e auditoria `conversions.meta_lead_birth_updated`. Desativar essa chave não desliga a conexão
   Meta nem os demais eventos.
3. A tela apresenta o [histórico dos cliques](../../lib/conversoes/historico-de-cliques.ts) e
   permite pedir reprocessamento autorizado. Verifique a situação no ledger e a resposta da
   Meta antes de considerar um envio concluído. Não use código de teste para contabilizar
   conversões reais.

O WAHA padrão do produto permanece inalterado. A exigência de assinatura foi ativada no
cenário causal de QA; não é uma mudança global de configuração de produção.

## Compatibilidade e limites

O ledger novo é exclusivo de `LeadSubmitted` por clique. Purchase, QualifiedLead, MetaEtapa e
Google Ads continuam nos consumidores e livros anteriores. A atribuição do contato e do card
permanece de primeiro toque; retries de conversões antigas não trocam esse toque. Uma regra de
etapa Meta pode usar o nome externo `LeadSubmitted`, mas sua identidade e seu ledger continuam
separados do evento causal por clique.

A reentrega WAHA de um `external_id` já persistido reacelera o pipeline de eventos, mas não
reexecuta `aplicarEfeitosPosEntrada`. Se a primeira entrega gravou a mensagem e falhou
antes de criar o card, a reentrega isolada não recupera esse nascimento comercial. Essa
limitação do fluxo existente não foi ampliada nem corrigida por este porte.

O ledger registra a oportunidade quando a mensagem é persistida, inclusive se a organização
estiver desligada; nesse caso a linha fica `skipped` e não é reenviada retroativamente. Erro
transitório de leitura da configuração não equivale a desativação e solicita retry. Não se deve
interpretar um HTTP 200 do receptor sintético como aceitação pela Meta.

### Living System Checklist

1. Entrada: mensagem inbound com âncora CTWA validada na ingestão WAHA ou no canal oficial.
2. Saída: `conversoes.clique_meta` usa o transporte Meta; falha no anúncio não bloqueia a mensagem.
3. Registro: `message.received`, `meta_ctwa_click_dispatches` e auditoria da mudança da chave.
4. Tela e porta: histórico e chave em **Configurações → Conversões**.
5. Recuperação: claim com lease, retry transitório e pedido de reprocessamento autorizado.
6. Configuração: chave independente por organização, desligada por padrão, e conexão Meta direta.
7. Continuidade: atendimento e card seguem seus fluxos mesmo se a conversão não for enviada.
8. Retorno: status e motivo do ledger orientam nova tentativa ou correção da conexão.
9. Mapa vivo: [conversões de anúncios](../architecture/conversoes-de-anuncios.architecture.json).

## Evidência sintética e trabalho ainda pendente

| Evidência                                                                                      | Resultado demonstrado                                                                                                              | Limite                                                                                                                     |
| ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| [QA 39285916921](https://github.com/oianmaxdev/deskcomm-feature-a-qa/actions/runs/39285916921) | Três shards unitários, typecheck, build, E2E causal e regressões aprovados; Graph e WAHA sintéticos, evidências age criptografadas | O job agregado ficou vermelho no gate de banco por uma dependência de release; não contar esse run como aprovação do banco |
| [QA 39307744735](https://github.com/oianmaxdev/deskcomm-feature-a-qa/actions/runs/39307744735) | Invariantes A1 de banco em PostgreSQL descartável aprovados                                                                        | Demais jobs foram dispensados nessa execução direcionada                                                                   |

Os dois runs usam o **mesmo SHA funcional `4d76349977ed5196a90c00722c240ae4764af747`**;
a homologação sintética é a combinação de seus gates efetivamente executados. A
[spec causal](../../tests/e2e/meta-lead-submitted-causal.spec.ts), os
[invariantes do clique](../../tests/invariants/meta-lead-por-clique.test.ts) e os
[testes de regressão](../../tests/e2e/conversoes-reprocessamento.spec.ts) são o ponto de partida
para uma nova validação após integração.

**Ainda não foi comprovado:** clique de campanha CTWA verdadeira → payload do provedor →
mensagem recebida → aceite pela Meta e atribuição no Gerenciador de Eventos. Não houve merge na
`main` oficial, deploy ou uso de dados reais. No histórico do fork baseado na v1.73,
a execução do aplicativo antigo sobre o schema migrado e a restauração de backup ficaram
pendentes para um ensaio de instalação. Este porte mira a `main` oficial atual: sua
compatibilidade de instalação e atualização deverá ser comprovada de novo sobre a base
integrada. O rollback de imagens não reverte migrations.

## Estado do porte para o upstream

A adaptação preserva o commit original do @oianmaxdev e foi atualizada com a `main` oficial
`028b40c118af6346c759186a40a67bdcf3748b63` em branch isolada. As migrations
**0803 → 0804 → 0805** substituem os números 0617, 0618 e 0693 do fork nesta proposta;
a **0806** aplica a decisão de LGPD do doc 199. As quatro propostas foram renumeradas em
26/10 após conferir os nomes e carimbos da main e dos 57 PRs abertos; os apêndices idempotentes ficam no
[baseline](../../supabase/baseline.sql). O `supabase/migrations/MANIFEST.md` permanece histórico.
Os componentes de entrada preservam o registro de anúncio e demais metadados acrescentados
na `main` depois da v1.73; a prova CTWA é acrescentada na mesma mensagem.

O acesso LGPD coleta os cliques do próprio titular com filtro de organização e contato,
paginação por chave estável e erro alto se a leitura falhar. A cópia inclui o identificador
do clique, as datas e o estado do envio; tokens de processamento e detalhes internos não
são coletados. Quem não tem clique conserva o formato anterior, sem seção vazia nova.

A validação do **novo código portado** ainda depende de tipos gerados de um Supabase descartável, gates
estáticos, testes de instalação e atualização do baseline, RLS/grants, E2E com Graph em loopback
e revisão dos resultados do CI oficial. Os runs do fork acima são evidência histórica da regra
funcional, não aprovação automática desta integração. A comparação com PRs abertos deve ser
repetida antes de solicitar revisão, pois outros trabalhos também alteram nascimento do lead,
auditoria e traduções.

Permanece pendente a prova com clique CTWA de campanha verdadeira e confirmação de aceite e
atribuição pela Meta. Nenhuma validação desse tipo deve usar dados reais de clientes sem uma
homologação controlada própria. O rollback de imagens não desfaz migrations.
