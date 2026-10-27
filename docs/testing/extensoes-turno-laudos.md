# Turno de extensões e consulta de laudos — estado da prova

Referência: PR #3477, fonte `825512d5b5766c784018cb10cfef82b4dc36daf1` mais o
reparo de baseline e fixture descrito abaixo. Consumidor: `consulta-de-laudos`;
contrato em `docs/specs/extensoes-declarativas-v1.md`, seção “Gancho antes da IA”.
O host é genérico; categorias, perguntas e idiomas pertencem ao pacote.

## O que o CI mediu antes deste reparo

O [run 40381355864](https://github.com/melgarafael/DeskcommCRM/actions/runs/40381355864)
tem `head_sha=825512d5…` e executou a prévia
`3511916c99c377c71bec78ff56c79dcd5f5f00e4` sobre `028b40c118af…`.

- O **typecheck completo passou** no step `Typecheck` do
  [job 121778117144](https://github.com/melgarafael/DeskcommCRM/actions/runs/40381355864/job/121778117144).
  Isso encerra a dúvida sobre o TS2322 anterior nesse candidato, sem afirmar que
  um novo typecheck local foi executado depois deste reparo.
- Duas cercas reprovaram: o CHECK de `accepted_permissions` era recriado duas
  vezes no baseline, e a função da proposta 0800 estava depois da varredura de anon.
- Em pg15 e pg17, seis dos oito casos de
  `tests/invariants/extensoes-turno-consentimento.test.ts` falharam antes de medir
  seus efeitos: a fixture entregava um array JavaScript cru ao parâmetro JSONB;
  `pg` o serializava como array PostgreSQL, produzindo `22P02`. O replay integral
  ainda não foi provado por esses resultados.

## Reparo e verificação leve

A fixture agora serializa o aceite para JSONB, preservando o nulo e todas as
asserções. No baseline, a regra final fica num único bloco antes da varredura de
anon: a função conhece os **onze nomes** antes de conferir o CHECK. As migrations
0798/0800 mantêm o mesmo comportamento final; não há concessão nem backfill de
aceite. O bloco repetido do fim passou a apontar para essa definição única.

Em 26/10/2026, com um worker e sem paralelismo de arquivos, passaram **71 testes
em sete arquivos**, RC 0, em 5,69 s:

```sh
pnpm exec vitest run --maxWorkers 1 --no-file-parallelism \
  tests/unit/baseline-constraint-reconstruida.test.ts \
  tests/unit/varredura-anon-e-o-ultimo-bloco.test.ts \
  tests/unit/apendice-do-baseline-nao-diverge-da-cadeia.test.ts \
  tests/unit/apendice-do-baseline-espelha-a-migration.test.ts \
  lib/extensions/consentimento.test.ts \
  lib/agent-engine/agent/gancho-de-extensao.test.ts \
  lib/extensions/exemplo-turno-jornada.test.ts
```

ESLint do invariante alterado e `git diff --check`: RC 0. Essa rodada mede a
estrutura do baseline e os focos de unidade; **não é uma rodada verde de banco,
nem uma nova execução da suíte completa**.

## O que ainda precisa de prova real

O CI do reparo precisa executar os oito casos de banco, incluindo duas
organizações, viewer/admin, revisões, retry, atualização, leitura opcional e RPC
privada. O replay integral exige `psql -v ON_ERROR_STOP=1`, status 0, nenhum
ERROR/FATAL, aceite preservado e CHECK validado. O consumidor concede três nomes
(`turn.send`, `turn.handoff`, `turn.context`); onze é o tamanho do vocabulário,
não a quantidade de aceites desse pacote.

Continuam pendentes concorrência simultânea real, geração de
`lib/database.types.ts` pelo schema provado e jornada fresca pela tela. A jornada
deve medir instalação e aceite separado, patologia com passagem imediata,
biópsia/radiologia com apenas seus campos pendentes, saudação que não vira nome,
cinco idiomas, contexto com proveniência, atualização de quatro perguntas para
uma, reconfiguração, desativação/reativação, duas organizações e os dois caminhos
de provedor. Cada caso pelo agente precisa do par com o mesmo texto cru pela
função direta, conforme `docs/doctrine/prova-em-par.md`.

Os E2E genéricos de extensões não substituem essa jornada. Ainda não há evidência
visual nova de laudos para citar. O #3063 permanece aberto: a adaptação preserva
a contribuição e não anuncia a promessa cumprida antes do gancho na main e da
prova prevista nas decisões 139/167.

## Jornada de navegador preparada para o CI

`tests/e2e/extensoes-turno-laudos.spec.ts` acrescenta **uma** jornada de no máximo
240 s, incluindo setup e todos os subpassos. Ainda não foi executada: lint, parse
e cercas de cobertura não substituem o navegador nem o banco real.

A preparação encontrou uma omissão no DTO: `accept_permissions` aceitava no
máximo dois nomes, recusando com 422 o botão de contexto depois dos dois efeitos.
O teste novo em `lib/extensions/requests.test.ts` reproduziu **1 falha e 3 acertos**
com o schema anterior; o limite agora deriva de `PERMISSOES_DE_TURNO.length`.
Não muda as permissões, o aceite próprio nem concede algo por omissão. A rodada
dirigida posterior passou **89 testes em dez arquivos**, um worker, em 5,39 s;
inclui DTO, serviço/consentimento, corpus do consumidor e cercas do workflow.
ESLint dos seis TS alterados e parse dos quatro TS do E2E: RC 0.

A revisão fria posterior encontrou dois defeitos no caminho real da passagem.
O cliente da transação agora é descartado com erro quando query/rollback ficam
incertos; commit e recibo repetido saudáveis continuam reutilizando a conexão.
O envio sem modelo preserva custódia e entrega separadas: `queued` mantém a coleta,
mas grava cliente não avisado com o motivo canônico `na_fila_canal_fora`.
Não acrescenta reenvio nem retentativa geral. O teste novo
`tests/unit/extensoes-turno-desfechos-reais.test.ts` extrai e executa os nós reais
da transação, do envio e dos callbacks: **8 falhas/8 acertos antes, 16 acertos após**.
A rodada dirigida com testes vizinhos e a cerca documental passou **168 testes
em oito arquivos**, um worker, em 13,78 s. Isso mede os ramos com falhas dirigidas
nas bordas; não é execução de PostgreSQL nem prova visual do CI.

| ID | Medida prevista |
| --- | --- |
| TL01 | Admitir catálogo, instalar bytes exatos, nenhum aceite automático |
| TL02 | Viewer recusado; aceite de envio/passagem separado da leitura |
| TL03 | Biópsia, radiologia, patologia e escolha numérica; par com função pura |
| TL04 | Saudação não coletada como nome; devolução à IA nos dois SDKs |
| TL05 | OUTBOUND selecionado, aceite próprio e outra conversa do mesmo contato |
| TL06 | Outra organização não herda efeitos nem leitura opcional |
| TL07 | Reconfigurar, desligar e reativar não retomam respostas da revisão antiga |

As capturas desses IDs estão planejadas para o diretório
`evidence/extensoes/turno-laudos/`; ainda não há imagem nova observada para citar. O
`manifesto.json` dessa pasta registra os IDs concluídos, tempo e contadores sem
prompts, cabeçalhos ou respostas coletadas. O upload de evidências em sucesso
já existente no workflow inclui a pasta; falhas mantêm os artifacts do Playwright.

A instalação e os aceites passam pela UI/API reais. A fixture semeia somente
atores, conversas e agente publicado, adquire apenas seu próprio job e chama
`createInboundTurnHandler`; não usa a prévia, que exclui o gancho. O sink, as
guardas, o ledger e a passagem são os canônicos, com receiver WAHA HTTP local.
Cada rodada de coleta exige zero pedidos ao modelo e zero linhas em `llm_calls`.
A devolução exige tool call, mensagem física e checkpoint reais pelos SDKs
Anthropic Messages e OpenAI Responses contra receivers HTTP locais. O registry
troca somente o endpoint: não mede credenciais externas, inferência ou egress do
registry padrão. Os cinco idiomas continuam medidos pelo corpus literal unitário;
a jornada de navegador usa os ramos em inglês nos dois provedores.

A parte 2 do [e2e 40381355859](https://github.com/melgarafael/DeskcommCRM/actions/runs/40381355859)
levou 1078 s de job. Somar 180 s **estimados** resulta em 1258 s, com 182 s até o
orçamento de 1440 s e 422 s até o corte de 1680 s. A spec tem teto total de 240 s;
não foi medida a duração nem a nova vizinhança. O workflow ganha somente o item
da lista da parte 2, preservando as listas anteriores, os sete runners e os tetos.

Reprodução no runner canônico já semeado, com o app de produção iniciado:

```sh
pnpm exec playwright test tests/e2e/extensoes-turno-laudos.spec.ts --workers=1
```

## Distribuição do consumidor e limite do laboratório

O caminho versionado existente já contém `extensoes/pacotes/deskcomm/consulta-de-laudos-1.0.0.json`,
os metadados em `extensoes/loja.json` e a entrada derivada em `extensoes/catalogo.json`.
`scripts/gerar-catalogo-de-extensoes.ts --conferir` usa `parseManifest` e
`checkCompatibility` reais: passou nesta preparação, quatro pacotes, revisão 3.
Isso prova geração e integridade; não prova a publicação HTTP do domínio do catálogo.
O próprio gerador mantém a publicação como ato do dono (DEC-007); não foi encontrado
empacotamento desses arquivos no Dockerfile nem workflow de deploy do catálogo.

O CLI de `experiments/extensoes/catalog/catalog.py` é laboratório local e seu
`publish` ainda só valida `crm_cards`. A fixture nova valida os bytes pelo parser
do host e prepara o SQLite temporário usando os helpers de entry/storage do CLI;
`init`, `export` e `serve` continuam reais, assim como digest, download e instalação.
Não se afirma que essa escrita de fixture seja publicação oficial, nem se altera o
CLI experimental ou o contrato de capacidades para obter uma prova verde.
