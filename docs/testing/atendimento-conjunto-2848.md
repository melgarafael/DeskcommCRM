# Atendimento conjunto — integração do PR 2848

Fonte: @webtecnica, head `8d28e3762f867a45a30bf4d6f76e055b3f35c844`; escopo decidido na issue #2542. O convite concede leitura e resposta sem substituir o responsável. Viewer conserva sua leitura usual, sem convidar ou enviar pela API. Notificação e nova guarda de IA continuam fora desta fatia.

## Prova real do candidato integrado

O [E2E3](https://github.com/melgarafael/DeskcommCRM/actions/runs/40426519144/job/121935888949) mediu `cefb0475cb9cf9199f6ebacab27cbf294e5449c1`, checkout CI `6288e3ee360e6bdddc66230eed83e064cc45f19f`, com main `7f1` integrada. O caso próprio passou em **51,9 s**; a parte terminou com **97 casos passando e um skip**. As quatro PNGs estão no [artefato 12702035532](https://github.com/melgarafael/DeskcommCRM/actions/runs/40426519144/artifacts/12702035532) e na evidência persistente da operação.

A jornada usa quatro contas sintéticas e tenant vizinho. Sem reload, o convite aparece em Minhas e a remoção retira o acesso na outra sessão aberta. Contagem pela API real e tela comprovam 0→1→0; o badge zero é omitido. A convidada responde sem assumir, com autoria preservada no banco e uma única saída no receiver HTTP controlado. Viewer não envia, colega sem convite não vê/envia, convidada não fecha nem altera status. Reconvidar reutiliza o vínculo e conserva responsável, status e auditoria. O receiver local não comprova entrega externa pelo provedor.

O [PG17 do mesmo candidato](https://github.com/melgarafael/DeskcommCRM/actions/runs/40426519119/job/121935478126) executou 13 casos de `atendimento-conjunto-participantes.test.ts` e 16 de `participante-nao-herda-controle-da-conversa.test.ts`, todos passando. O job completo falhou em dois casos de `claim-respeita-hold-do-numero.test.ts` na fronteira das 22h; ele não é contado como PASS global.

## Fixture central e preservação do schema

O commit `7c14d268a30e8a8defac4989d17864efae11c122` ([PR #3530](https://github.com/melgarafael/DeskcommCRM/pull/3530), doc222=A) entra por merge normal. São exatamente oito linhas na fixture de retenção, com janela de 24h em UTC só nos seus três canais e cleanup scoped; nenhuma assertiva, relógio ou regra do produto muda. O patch passou os mesmos 12 casos em PG17 real com install/update e conferência do kit. O original também passou após as 22h; o RED válido permanece o CI registrado acima.

A dependência 0563 inteira precede 9016 inteira e a varredura final. Seus blocos mantêm SHA256 `459565b5483f0a61fa4c00d4e3756f047a344dac3653d12784b228005fa35d44` e `607ebe43a4e93310728a04ef8a2f0a95f6ba2cf023db785b999a7083b4bd6b8f`. As migrations 0563/0661/9016 e os acréscimos protegidos anteriormente autorizados permanecem intactos.

## Tipos inteiros gerados do banco

O bruto CI/CLI 2.117 foi preservado e recusado: omitia `conversations.Row.tags_do_contato`. Em PG17.11 descartável, o baseline do candidato SHA256 `a7f5c88e327c7c9ab556d53178012146c749bac636c39ca8dbe99693c19ba363` recebeu prelude canônico e install/update com `ON_ERROR_STOP=1`. CLI 2.122.0 gerou o schema público duas vezes, byte a byte idêntico: raw SHA256 `34d0520f6d43cc14fe9275e068b2dee90a1863c8c49d86e3f1d3a36d56e28907`.

A saída inteira foi formatada mecanicamente com Prettier 3.9.10: SHA256 `cdccb2698f42fe8e4173b33c75bb3b504e8ba988ad01aa7479aca6bf9766fb79`. AST: 207 tabelas e 248 funções; participantes, propostas e campo computado presentes; nenhum objeto ou campo canônico perdido. A única adição contra os tipos da main é `conversation_participants`. O merge central não mudou o baseline medido. Nenhum tipo foi escrito à mão; raws, comandos e origem permanecem no recibo da operação.

## Aceite do head final

O head que incorpora fixture central e tipos ainda precisa dos cinco checks finais antes de sair do draft. As provas acima pertencem somente às fontes declaradas. Sem Ready ou auto-merge.

Entrada: cabeçalho do Inbox e `/api/v1/conversations/[id]/participants`. Registro: `conversation.invited` e `conversation.participant_removed`. Preserva responsável, RLS, preferências de visibilidade e Assumir. Mapa: `docs/architecture/atendimento-conjunto.architecture.json`.

A coleta futura do CI fixa isoladamente CLI 2.122.0 pelo helper próprio, sem alterar dependências, lock ou a versão da stack. O DSN numérico local é validado antes de acrescentar `sslmode=disable` com URLSearchParams. A AST confere a tabela própria, propostas e o campo computado; os brutos 2.122 passaram e o bruto 2.117 sem o campo foi recusado. O transporte externo não recebe essa exceção TLS.
