# Os erros que mais derrubam PR de contribuidor — medidos, com o número do PR

Fonte: os relatos de triagem de agosto e setembro de 2026, o procedimento de triagem e o
histórico dos PRs de fork (10 dos ~40 mais recentes fechados sem merge). Ordem = frequência.

| # | o erro | onde aconteceu | como evitar (o `pre-voo.sh` mede) |
|---|---|---|---|
| 1 | **Migration sem a tripla ou com número já usado.** Renumerada 11 vezes desde agosto; 5 PRs disputaram o `0161` numa rodada (issue #285) | #418, #465, #501, #518 e outros | hook `pre-commit` + item "Migration" do pré-voo; `NNNN` e timestamp livres na `origin/main`; renumerar troca o timestamp junto |
| 2 | **Config ou marca do próprio fork dentro do PR** — nome do cliente, logo, `.env`, compose editado, imagens publicadas no namespace do fork | #465 (7 arquivos com a marca de um cliente mergeando sem conflito), #518, #596, #600, #605 | branch nomeada a partir de `origin/main`, nunca do `main` do fork; item "marca/config" do pré-voo; a marca é tela, não código |
| 3 | **Seção de versão `## [x.y.z]` escrita à mão no CHANGELOG** — o corte é automático e a seção manual quase publicou uma versão pelo merge | #354, #518, #588 | fragmento em `.changes/`; item "CHANGELOG" do pré-voo |
| 4 | **PR aberto do `main` do fork** (traz tudo que a instalação da pessoa tem) | #418, #465 | `git switch -c fix/… origin/main` |
| 5 | **Autor fecha o próprio PR** achando que "fez ruído" ou "abriu no lugar errado" (6 vezes; um fechou 36 segundos depois de abrir, levando junto um bug real) | #515, #547, #588 | nunca feche; o Vercel vermelho e os workflows parados são esperados (`depois-do-pr.md`) |
| 6 | **Commit assinado como `root@vps` ou com nome alheio** — o trabalho some do perfil | #569-#571 (`root@vpsbr-…`), #352 ("SoftIA Backup Agent") | `git config user.email`; hook avisa; `.mailmap` só credita com prova |
| 7 | **Mudança de comportamento sem teste**, ou teste que não fica vermelho quando o conserto sai (uma segunda porta sem guarda) | #474 e vários | passe 5 do guia: teste + sabotagem com contagem prevista |
| 8 | **Funciona em instalação nova e quebra em quem já usa** — constraint nova sobre dados existentes; env obrigatória nova sem default | relato 13 da triagem | corrigir dados antes da constraint; env com default; fragmento `exige_acao` quando não há saída |
| 9 | **Decisão de produto embutida em código** (mudar regra de negócio para atender o próprio caso) | #406 (silenciar a IA), #518 | vira pergunta no corpo do PR, não código; regra não escrita não se inventa |
| 10 | **Branch atrasada** — CI verde na branch, conflito no merge; pre-commit do mantenedor acusando merge da main (issue #374) | recorrente | passo 1 do guia; mesclar cedo |
| 11 | **Vocabulário interno vazando para a tela** ou string em português fora do dicionário i18n (o guardião do espanhol é cego a `t(<variável>)`) | #631, #600 | `lib/i18n/dicionario.ts`; `docs/doctrine/separacao-fala-e-operacao.md` |
| 12 | **Tela que oferece o que o motor ignora** (controle decorativo: a UI grava, o runtime não lê) | #295 (cinco controles) | invariante 6 do sistema vivo: todo knob tem leitor — cite o arquivo que lê |
| 13 | **Provider nomeado fora de `lib/channels/`** | recorrente | `pnpm lint:channels` reprova arquivo novo sujo — e arquivo que ficou limpo e não saiu da lista de dívida |
| 14 | **`vitest run tests/unit` em vez de `pnpm test:unit`** — verde menor, 178 arquivos de fora | medido em PR interno | sempre `pnpm test:unit` sem caminho; não corte a saída |

## O que NÃO é erro seu (e já assustou gente)

- `Vercel` vermelho com "Authorization required to deploy" — esperado em fork; não entra no gate.
- Workflows "aguardando aprovação" no primeiro PR — política do GitHub; um mantenedor libera.
- Vermelho em arquivo que você não tocou: `Test timed out in 15000ms` em dezenas de arquivos é
  saturação da máquina (`uptime`); `address already in use` é o runner; leia o log do **passo**,
  não o resumo. Reexecute isolado antes de "consertar".
- Fragmento faltando, migration colidindo com PR aberto, conflito com a `main`, prova de tela: o
  template de PR diz que são trabalho **nosso**. Faça o que der; declare o resto.
