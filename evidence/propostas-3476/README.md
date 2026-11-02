# Revisão dos campos lidos no documento — #3476

Fonte: [workflow E2E 40400799649](https://github.com/melgarafael/DeskcommCRM/actions/runs/40400799649),
parte 7, [job 121847899398](https://github.com/melgarafael/DeskcommCRM/actions/runs/40400799649/job/121847899398).
**42 casos passaram; seis são desta entrega.** HEAD do PR:
`0a52385384baf59f9bc0135789c91168bf9f91bc`. O checkout compilado foi o merge
`111bbf7581aeedca43a5525692683a9259b51b81`. A comparação de produto, baseline,
spec, seeds e workflow entre esses commits é vazia.

O ambiente foi Supabase local novo, baseline do checkout, seeds canônicos,
Next de produção e Chromium real. Os dados são fixtures sintéticas.

| Captura | O que permite conferir |
| --- | --- |
| [Revisão antes de decidir](01-revisao-sintetica.png) | Valor atual, proposta, trecho e controles de decisão juntos. |
| [Revisão encerrada](02-decidida-sintetica.png) | A revisão desapareceu e o formulário do negócio segue aberto. |
| [Leitura do viewer](03-leitura-sintetica.png) | Propostas visíveis sem os controles de decisão. |

A spec chama `/api/mcp` de verdade com o texto controlado `1,234`: a ferramenta
devolve `1.234`, sem mudar o card. O manager confirma pela tela, e a asserção do
formulário mede `1.234`, igual ao banco. Outro caso corrige para `9,876`; outro
preserva a mensagem 409 numa revisão antiga. O viewer recebe 403 ao tentar
decidir diretamente. A disputa entre duas decisões usa uma trava de linha real
e exige somente um 200; a expiração vence uma confirmação já em andamento e dá 409.

Na segunda captura, o campo Medida está abaixo da área visível: a imagem mostra
o encerramento da revisão; o valor confirmado foi medido pela asserção no
formulário. O teste agora rola até esse campo antes da captura seguinte. Não se
atribui essa melhoria à imagem preservada aqui.

A coleta aceitou somente o artefato `evidencia-parte-7` dessa execução. Conferiu
PR, head, run, job, seis casos verdes no log, expiração, digest e os nomes exatos
de três PNGs. IDs, hashes, dimensões e linhas do log estão no [manifesto](manifest.json).

Depois dessa execução, somente o ramo de erro inesperado do handler de decisão
mudou no produto: ele conserva o rollback para pendente e retorna JSON 500
genérico. `RevisaoDoDocumento`, `LeadDossier` e `LeadFieldsForm` mantêm os blobs
medidos. A prova complementar
é unitária: o caso novo falhou com a exceção escapando (1 falha/15 sucessos) e
passou com o retorno canônico (16 sucessos), incluindo o controle de `ApiError`
422. Os cinco checks do candidato final continuam obrigatórios antes do merge.

Depois também entrou a `main` em `63dfc0fda`, incluindo a migration 0793. O
conflito do baseline foi resolvido preservando integralmente os blocos 0793 e
0797 antes da varredura de funções; a policy final 0807 permaneceu. Isso exigiu
nova geração de tipos num Postgres 17.11 vazio, limitado a 1 GiB e um processador:
prelude canônico, instalação e reaplicação do baseline com `ON_ERROR_STOP=1`,
duas gerações idênticas pelo CLI 2.122.0 e Prettier. A única diferença gerada é a
assinatura de `fn_go_live_solta_numero_formado`; ela permanece sem execução para
`anon`, `authenticated` ou `service_role`. O banco temporário foi removido. O
manifesto separa os hashes da prova UI dos hashes desse candidato integrado.

A prova mede MCP → fila → revisão → edição canônica. Não mede modelo lendo PDF,
upload/anexo nem entrega externa. O motivo livre de recusa não alimenta
aprendizado automático; esse consumidor não existe nesta entrega.

A origem de @webtecnica `f1e104bdc92edb403739291dc7d771861cf52498` permanece
ancestral. O [diff autorizado na decisão 209](invariantes-autorizados.diff), sem linhas de contexto,
acrescenta somente 6 e 20 linhas, sem remoções. Esses arquivos não mudaram entre
a origem autorizada `c987ddaa` e a revisão `f1e104bd`. A migration 0772 original
foi preservada; as correções adiante são 0797 e 0807. Provas de banco, tipos e
reprodução estão no [relatório de QA](../../docs/testing/propostas-de-campos-3476.md).
