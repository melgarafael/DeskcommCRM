# TRIAGEM.md — o procedimento de triagem de PR

Este arquivo é o procedimento inteiro. O comando `/triagem-de-pr` é só a porta.

**Por que ele existe, em números medidos em 2026-08-04:** em 60 dias — janela que cobre 100% do
histórico do repositório — seis humanos externos abriram 16 PRs. **Quinze mergeados, zero fechados.**
A taxa de rejeição é zero. O gargalo nunca foi qualidade: os 7 PRs de um mesmo contribuidor
esperaram **5h08min** entre serem abertos e o CI começar, e depois foram do verde ao merge em 25
minutos. Um PR de contribuidor de primeira viagem ficou horas com zero execuções de workflow, zero
reviews, e um `Vercel :: FAILURE` como único check — a primeira coisa que ele viu deste projeto.

Logo: **esta triagem não é um porteiro.** Ela é uma desbloqueadora que, depois de desbloquear,
verifica com rigor. As duas coisas nesta ordem.

E o rigor precisa ser real, porque a branch protection **não exige review humano** (`required_pull_request_reviews`
está ausente; os 7 PRs citados foram mergeados com `reviews=0`). Não há rede embaixo de você. Erro
seu entra na `main`.

---

## 0. Âncora — o passe que impede o erro mais caro

```bash
git fetch origin
MAIN=$(git rev-parse origin/main)
```

Daqui em diante, **todo** config de gate se lê por `git show origin/main:<path>`. Nunca do disco.

Motivo, medido: o checkout de trabalho deste repositório já esteve numa branch que **não tinha**
`scripts/lint-channels.ts`, não tinha `.github/workflows/e2e.yml` e ainda usava Node 20 no
`perf.yml`. Uma triagem lendo o disco rodaria 4 gates onde a `main` exige 6, e declararia verde um PR
que o CI reprova.

O SHA curto da `main` entra em **toda** afirmação daí em diante. Número sem SHA não compara.

---

## 1. Acolhida — em minutos, sem uma linha de avaliação

Nesta ordem:

1. Liberar o CI do fork. **`gh pr checks` NÃO mostra workflow parado esperando aprovação** — ele
   lista só o que já começou, então um PR travado aparece como se não tivesse check nenhum, e a
   acolhida promete "acabei de liberar" sem ter liberado. A sonda que enxerga é o campo
   `conclusion`, e o comando é este, sempre, antes de qualquer outra coisa:

   ```bash
   BR=$(gh pr view <n> --json headRefName --jq .headRefName)
   for id in $(gh api repos/{owner}/{repo}/actions/runs \
                 --jq "[.workflow_runs[] | select(.head_branch==\"$BR\" and .conclusion==\"action_required\")] | .[].id"); do
     gh api -X POST "repos/{owner}/{repo}/actions/runs/$id/approve"
   done
   ```

   Medido: o PR #176 ficou **6 dias** aberto e, quando a triagem chegou, os 4 workflows estavam em
   `action_required` desde o primeiro push. A latência de 5h08min que este arquivo cita não é
   lentidão de runner — é PR esperando um humano clicar.
2. Aplicar `triagem:recebido` + as labels `area/*` derivadas do diff.
3. Postar a acolhida — molde em `references/resposta-ao-contribuidor.md`, seção *Acolhida*.

**A liberação do CI é o primeiro comando da triagem, antes de ler o diff.** Medido em 2026-09-03: numa fila de 26 PRs, **12 workflows** de cinco contribuidores estavam parados em `action_required`, um deles havia mais de um dia — e três PRs tinham **zero** execuções no `head_sha` (ver modo de falha 17). Cada minuto entre abrir o PR e liberar é latência pura, que é o gargalo que este documento existe para matar. Libere primeiro; avalie depois.

A acolhida **não contém juízo técnico**. É isso, e só isso, que a torna segura de ser automática:
ela não pode estar errada sobre o mérito porque não fala do mérito. Ela diz três coisas — o `Vercel`
vermelho é esperado em fork e não é culpa dele, o CI está sendo liberado, e quando vem o veredito.

Todo comentário desta triagem abre com a âncora invisível `<!-- triagem-de-pr:v1:pass=N -->`. Leia as
âncoras existentes antes de escrever: **acolhida nunca é postada duas vezes.**

---

## 2. Raio de dano — decide quanto se gasta

| o PR toca | passes obrigatórios |
|---|---|
| só `.md`, `docs/` | 3, 9, 10 |
| só `package.json`/lockfile | 3, 4 (linha de dependência), 9, 10 |
| `app/`, `components/`, `lib/` | todos |
| `supabase/` | todos, com o passe 4 reforçado |
| `hostgator-setup-kit/`, `docker-compose*`, `Dockerfile` | todos + instalação do zero + **GET externo** |
| `.github/workflows/` vindo de fork | todos + leitura linha a linha |

PR pequeno não paga pipeline caro. Isso não é economia: triagem lenta reintroduz exatamente a
latência que ela existe para matar.

---

## 3. Gates — na prévia do merge, não na branch

`strict=false` na branch protection: um PR pode ser mergeado sem estar rebasado na `main`. O CI testa
**a branch**; o que vai para produção é **o merge**. Monte a prévia e rode ali:

```bash
git merge-tree --write-tree origin/main <sha-do-pr>
```

É o único jeito de pegar convergência independente — dois lados que mudaram a mesma coisa de formas
compatíveis textualmente e incompatíveis semanticamente. Isso não gera conflito e não aparece em
nenhum gate.

Gates da `main`: `typecheck`, `lint`, `lint:channels`, `test:unit`, `test:shell`, `test:db`, `build`.
Obrigatórios no merge — **cinco**, e não confie nesta lista: meça.

```bash
gh api repos/melgarafael/DeskcommCRM/branches/main/protection \
  --jq '.required_status_checks.contexts|join(", ")'
# em 2026-08-14: verify, build-and-size, invariants, e2e, imagens-ok
```

Esta linha listava **três** — faltavam `e2e` e `imagens-ok`, que são justamente os que
cobrem o artefato que o self-hoster instala. Um triador que a lesse declararia "passou os
obrigatórios" tendo rodado 3 de 5, dentro do próprio documento que o `CLAUDE.md` aponta
como o lugar onde medir contra a régua errada é o modo de falha número um.

Meça exit code **direto**. `cmd | tail` devolve o exit do `tail` — verde falso.

---

---

## 3-bis. Meça o CUSTO da medição antes de pagá-lo

O passe 3 manda rodar os gates na prévia do merge. Ele não diz quando isso é **redundante**, e
essa omissão custa horas quando há fila.

Dois números decidem, e os dois são baratos:

```bash
B=$(git merge-base origin/main pr-<n>)
git rev-list --count $B..origin/main                                   # ATRASO
comm -12 <(git diff --name-only $B origin/main | sort) \
         <(git diff --name-only $B pr-<n>     | sort) | wc -l          # SOBREPOSIÇÃO
```

| atraso | sobreposição | o que a prévia pode ter que a branch não tinha | o que fazer |
|---|---|---|---|
| 0 | 0 | **nada** — a prévia É a branch | não rode gate nenhum; leia o CI da branch |
| >0 | 0 | só acoplamento **semântico** (a `main` mudou um contrato que o PR usa) | rode `typecheck` — é ele que pega assinatura mudada — e leia |
| >0 | >0 | convergência independente: texto compatível, semântica incompatível | rode **tudo** na prévia. É o caso que o passe 3 existe para pegar |

Medido em 2026-09-03, com 21 PRs abertos: **16 tinham atraso 0 e sobreposição 0**. Rodar a bateria
completa nos 16 teria custado horas de CPU para reproduzir, byte a byte, um verde que o CI já tinha
publicado — enquanto os contribuidores esperavam. Latência é o gargalo deste repositório; gastar o
relógio provando o já provado é o passe 3 trabalhando contra o motivo pelo qual ele existe.

⚠️ **O atraso 0 tem prazo de validade: ele vence no seu próprio primeiro merge.** Assim que um PR
entra, todos os outros ficam com atraso ≥1 — e a linha da tabela muda. Ver 3-ter.

---

## 3-ter. Quando há FILA, o risco muda de lugar

Com um PR na mesa, o risco é o PR contra a `main`. Com vinte, o risco dominante é **um PR contra o
outro** — e nenhum gate do mundo o mede, porque no instante em que o CI roda os dois ainda não se
encontraram.

Antes de mergear qualquer coisa, monte a matriz:

```bash
for a in $LISTA; do for b in $LISTA; do
  [ "$a" -lt "$b" ] || continue
  L=$(comm -12 <(git diff --name-only $(git merge-base origin/main pr-$a) pr-$a | sort) \
               <(git diff --name-only $(git merge-base origin/main pr-$b) pr-$b | sort) \
       | grep -v '^\.changes/')
  [ -n "$L" ] && echo "#$a x #$b -> $L"
done; done
```

`.changes/` sai da conta de propósito: fragmentos são arquivos novos com nome próprio, nunca colidem,
e mantê-los no resultado esconde as colisões que importam atrás de ruído.

O que a matriz devolve costuma ser **um punhado de pares e um arquivo-hub**. Medido na mesma data:
dos 21 PRs, 15 eram totalmente independentes; as 7 colisões se concentravam em `lib/i18n/dicionario.ts`
(4 PRs) e um par em `.github/workflows/release.yml`.

A consequência é a ordem de trabalho, e ela é o oposto do intuitivo:

1. **Independentes primeiro**, em qualquer ordem, sem re-medir nada entre eles.
2. **Cluster por último**, em série, **re-medindo a prévia a cada merge** — porque o segundo do par
   deixou de ter atraso 0 no instante em que o primeiro entrou.

Mergear na ordem em que os PRs aparecem na tela é o que produz o conflito que ninguém entende de
onde veio.

### ⚠️ A matriz por ARQUIVO é necessária e NÃO é suficiente

Medido no mesmo dia, e é a correção que este passe pediu poucas horas depois de ser escrito: os PRs
**#497 e #498 têm sobreposição de arquivo ZERO**, cada um com os cinco checks obrigatórios verdes
contra a `main` — e **a prévia do merge dos dois é vermelha**.

```
#498  acrescenta o job  publish-image.yml::promover-stable
#497  acrescenta GATILHO_ESPERADO, um mapa que exige igualdade de CONJUNTO
      entre os jobs de .github/workflows e as chaves do mapa

merge dos dois → Tests 1 failed | 13 passed (14)
                 AssertionError: Um job apareceu ou sumiu em .github/workflows.
                 +   "publish-image.yml::promover-stable"
```

A classe é esta, e vale para muito além deste par:

> **Um teste que prende um INVENTÁRIO do repositório — jobs, telas, tabelas, rotas — colide com
> qualquer PR que mude esse inventário, sem tocar em nenhum arquivo em comum.**

O arquivo A declara o mundo; o arquivo B muda o mundo. Nenhum `git merge-tree` acusa, nenhum `comm`
de nomes de arquivo enxerga, e — como a branch protection roda com `strict=false` — **quem mergear
por segundo entra sem re-rodar o CI e deixa a `main` vermelha**, em qualquer das duas ordens.

Esta base tem vários desses inventários, e todos têm a mesma propriedade:
`tests/unit/navegacao-completude.test.ts` (telas), `tests/invariants/rls-isolation.test.ts` (a lista
fixa `TABLES`), `tests/unit/e2e-cobertura-completa.test.ts` (specs), `GATILHO_ESPERADO` (jobs).

**Como cobrir o buraco, sem custo:** depois de montar a matriz por arquivo, faça uma segunda
varredura — para cada PR da fila, o diff **adiciona ou remove** uma entrada de inventário?

```bash
gh pr diff <n> | grep -E "^[+-]  [A-Za-z0-9_-]+:$"        # jobs de workflow (com controle positivo)
gh pr diff <n> --name-only | grep -E "registry\.ts|rls-isolation|e2e-cobertura|GATILHO"
```

Se **algum** PR mexe no inventário e **outro** mexe na declaração dele, os dois estão acoplados
mesmo com interseção de arquivos vazia — e a emenda pertence ao PR **do mapa**, porque o mapa é
artefato dele.

E note o desfecho estrutural: com `strict=false`, esta classe **não tem gate**. Ou a branch
protection passa a exigir a branch atualizada, ou algum check roda na prévia do merge. Enquanto não
rodar, quem cobre é este passe — à mão.

---

## 4. Complemento — o que os gates não provam

`references/complemento-do-ci.md`, linha por linha, com o gatilho de cada uma no diff.

Esta é a razão de a triagem existir tecnicamente. Repetir o que o CI já faz é teatro; o trabalho é o
que ele **não** alcança — e a lista não é opinião, é o que foi medido: a tripla de migration é
guardada por um hook local que fork nunca roda, o teste de RLS cobre uma lista fixa de tabelas,
`no-console` é aviso sem `--max-warnings`, e nenhum job testa o instalador.

---

## 5. Reprodução — no SHA da `main`, não na base do PR

Todo PR que alega consertar bug:

1. Reproduza o defeito na `main` **de hoje**. Se não reproduzir, o PR pode estar consertando algo que
   já foi consertado — e isso é achado, não bloqueio.
2. Prove que a correção o remove.
3. Se a borda é infraestrutura, **suba a dependência real** e varie **uma variável por vez**,
   reportando a matriz. `--dry-run`, `config` e `typecheck` são renderização, não comportamento.

E a pergunta que tem nome próprio — **falha-em-verde**:

> Qual é a sonda que declara sucesso, e ela mede o mesmo caminho que o usuário usa?

Um instalador já terminou com "Instalação concluída! Acesse: https://$DOMAIN" com o site inalcançável
de fora, porque a sonda de saúde era interna ao contêiner. Num produto self-host essa é a classe mais
cara de todas: o cliente não descobre que está quebrado.

---

## 6. O teste que falta — o passe de maior rendimento

Se o PR muda comportamento e não traz teste, **você escreve o teste**. Não peça primeiro.

O valor não é o teste. É que escrevê-lo obriga a percorrer o caminho inteiro, e é ali que aparece o
defeito que ninguém pediu para procurar. Rendimento real desta casa: uma cascata de LGPD que deixava
o arquivo no bucket enquanto a auditoria registrava que havia redigido; um realtime que refazia a
mesma primeira página; o tratamento de erro de um script inteiro inalcançável por `pipefail` + `set -e`.

Depois de escrever: **sabote e veja vermelho.** Sabote a linha cuja perda seria **silenciosa** — a que
convergência independente sobrescreve sem gerar conflito e que nenhum grep de símbolo detecta.
Presença de símbolo não é comportamento. E ao medir discriminância, reverta **só o fonte**: reverter o
commit leva os testes junto e devolve verde.


### 6-bis. O gate que o PR deixou cego — a classe que passa por "tem teste"

O passe 6 pergunta *falta teste?*. Falta uma pergunta irmã, e ela é a que escapa:

> **O PR criou uma SEGUNDA porta para um dado que já tinha guarda na primeira?**

Quando a resposta é sim, o gate existente **continua verde** — ele não foi quebrado, ele ficou com o
escopo velho. E nada avisa, porque uma guarda de ausência não sabe distinguir "não achei nada" de
"não olhei ali".

Medido na triagem do PR #474 (2026-09-03). `tests/unit/ocupacao-do-google-nao-expoe-titulo.test.ts`
guarda que o nome de um evento pessoal do Google não chegue à tela da Agenda, e o recorte dele era
`app/app/agenda/**`. O PR acrescentou a rota `app/api/v1/agenda/agendamentos` como segunda fonte da
mesma ocupação — a que substitui a semente do servidor no primeiro refetch. A **mesma** sabotagem
(`title` acrescentado ao `select`) nos dois caminhos:

```
em app/app/agenda/page.tsx                  → exit 1   (a guarda pega)
em app/api/v1/agenda/agendamentos/route.ts  → exit 0   (a guarda passa)
```

O autor tinha respeitado a decisão à risca no código — rótulo fixo, coluna fora do `select`, o
argumento inteiro no comentário. O que faltava era o mecanismo por trás, e a falha é do projeto.

**Como procurar, em três movimentos:**

1. O PR toca um dado que já tem guarda? (`grep` o nome da tabela/coluna em `tests/`.)
2. Abra a guarda e **leia o recorte dela** — quase sempre é uma constante de caminho no topo. Guarda
   de escopo fixo é a regra nesta base, não a exceção.
3. Sabote **no caminho novo** e no antigo. Dois exits diferentes para a mesma sabotagem é o achado.

E ao consertar o recorte, meça as **três** direções: limpo → verde; sabotado no caminho novo →
vermelho; sabotado no caminho antigo → **ainda** vermelho. Sem a terceira, você pode ter trocado
cobertura nova por cobertura velha e chamado isso de conserto.

---

## 7. Teste a própria suspeita antes de exigir

Regra de cultivo, não de rigor.

Numa revisão desta casa, duas acusações do revisor foram testadas e **caíram** antes de virar
exigência. Noutra, um contribuidor foi mandado consertar um bug que não existia na `main` — teria
escrito código para um defeito inexistente.

**Nenhum pedido sai sem a medição que prova o defeito, anexada ao pedido.** Se você não mediu, não é
pedido: é pergunta, e vai redigido como pergunta.

---

## 8. Reconciliação

O que é mecânico, você conserta — branch própria, commit próprio, creditando o autor original no
corpo. O que muda uma decisão de projeto do contribuidor **volta como pergunta**, nunca como patch
por cima. A diferença entre as duas é: você consegue enunciar a intenção dele e mostrar que ela
sobrevive à sua mudança?

---

## 9. Veredito com proveniência

```
VEREDITO: MERGEAR | MERGEAR+ISSUE | SEGURAR
main: <sha curto>            prévia do merge: <tree>
MEDIDO:      <o quê> — <comando> — <saída observada>
NÃO MEDIDO:  <o quê> — <por quê>
BLOQUEADOR:  <arquivo:linha> — <o defeito> — <como reproduzir>
VERSÃO:      <patch | minor | major | nenhuma> — <o que o dono da VPS precisa fazer>
```

**`NÃO MEDIDO` é campo obrigatório.** Veredito sem ele é recusado pelo cético e não vai para o PR.
Ausência de dado herda a frase otimista de quem escreve; escrever o vazio explicitamente é o que
impede isso.

Aplique a label do desfecho: `triagem:pronto`, `triagem:bloqueado` ou `triagem:decisao`.

---

## 10. Resposta que faz voltar

`references/resposta-ao-contribuidor.md`. As três regras duras:

- **Creditar pelo nome** o que o contribuidor achou ou mediu.
- **Nunca cobrar como descuido um gate que não está documentado.** Quando acontecer, conserte a
  documentação no mesmo movimento e diga que a falha é do projeto.
- **Nunca pedir sem medição anexada** (passe 7).

Uma ressalva honesta, para não fingirmos saber: que creditar medição faça o contribuidor voltar é
**hipótese** — ninguém perguntou a ele. A alavanca que É mensurável, e que você reporta, é o **tempo
entre abrir o PR e a primeira resposta humana**.

---

## 11. Catraca — o passe que impede esta triagem de ser eterna

Todo defeito que os gates não pegaram vira **gate novo** ou dívida com issue aberta.

A consequência é a parte elegante: a tabela do passe 4 é a **lista de tarefas do CI**. Cada linha que
vira gate de verdade é uma linha que a triagem para de fazer à mão. Este procedimento deve ficar mais
leve com o tempo. Se estiver ficando mais pesado, o passe 11 não está sendo cumprido.

---

## 12. A versão — porque merge na `main` não é entrega

**O self-hoster puxa imagem publicada por número de versão.** Um PR que para na `main` existe só no
repositório: nenhuma VPS de cliente o recebe, nunca. Triar até o merge e ir embora deixa o trabalho
do contribuidor a meio caminho — ele fica no repo, e o cliente segue com o defeito.

A lei é [`docs/doctrine/versionamento.md`](../docs/doctrine/versionamento.md). O que muda para você:

### O fragmento é bloqueador, e você o escreve quando falta

Todo PR que muda comportamento traz um arquivo em `.changes/` declarando **o efeito no operador** —
`nada_mudou`, `capacidade_nova` ou `exige_acao` —, nunca o número. Sem ele o trabalho chega na VPS e
**não aparece na tela de atualização**: o dono ganha a mudança e não fica sabendo.

Contribuidor externo não conhece essa regra, e o passe 10 proíbe cobrar como descuido um gate não
documentado. Então: **se o PR muda comportamento e não traz fragmento, escreva você**, em branch
própria, creditando o autor — é reconciliação mecânica (passe 8), não decisão de projeto. Só volta
como pergunta se você não souber dizer o que muda para quem opera.

O impacto se **mede**, não se chuta. A pergunta é uma: *o operador precisa fazer alguma coisa?*
Variável nova é o caso clássico — abra `lib/env.ts` e veja se ela é `required()` ou
`optional().default(...)`. Obrigatória sem default é `exige_acao`, e o fragmento **precisa** trazer o
bloco `## Requer atenção` dizendo o que fazer. Confira com `pnpm release:conferir`.

### Seção de versão escrita à mão é BLOQUEADOR

Se o PR adiciona uma linha `## [X.Y.Z]` ao `CHANGELOG.md`, isso entra no veredito como bloqueador e
sai da branch. Ninguém digita número: ele é calculado dos fragmentos, e a seção é montada no corte.

Isso não é preciosismo — foi medido em 2026-08-27. O PR #354 trazia `## [1.7.0]` escrito à mão, e
até aquele dia o merge dele teria criado a tag e publicado as três imagens **sozinho**, pulando a
aprovação. O gatilho hoje exige a assinatura do corte, mas a linha à mão continua errada: ela
produziria uma seção duplicada, ou um número que já saiu.

```bash
gh pr diff <n> | grep -E '^\+## \[[0-9]+\.[0-9]+\.[0-9]+\]'   # vazio é o esperado
```

### Depois do merge, a versão sai — e isso não é opcional

O merge é do mantenedor (Fronteira). Assim que ele acontecer, **a versão precisa sair**, ou o passe
12 não foi cumprido. O corte é `Actions → release → Run workflow`: ele lê os fragmentos, calcula o
número, e abre um PR de release em português. O merge desse PR cria a tag, publica as três imagens e
move o canal `stable`.

Você não decide o número — ele é consequência do que os fragmentos declararam. O que você reporta ao
mantenedor, em lote, é: **quais PRs estão prontos e que versão eles produzem juntos**.

E confira o desfecho, porque "a tag saiu" não é "a versão chegou":

```bash
git ls-remote --tags origin 'refs/tags/vX.Y.Z'          # a tag existe
gh release list --limit 1                                # a release é a Latest
# e as três imagens no digest da versão, contra `stable` — receita em
# docs/runbooks/ativar-packaging.md
```

---

## Fronteira: o que você nunca faz

| você faz sozinho | é a palavra do mantenedor |
|---|---|
| liberar CI, rotular, acolher, comentar veredito | **mergear na `main`** |
| criar worktree, rodar gate, escrever teste, sabotar | **fechar um PR** |
| abrir issue e PR de follow-up | empurrar para a branch do fork alheio |
| consertar CONTRIBUTING/README/docs | **mergear o PR de release** (é ele que cria a tag) |
| escrever o fragmento que falta, e conferi-lo | |
| disparar `Run workflow` do `release` depois do merge | |

Sem perguntas de sim/não a cada passo: faça tudo, pare no merge, reporte em lote.

### Quando o mantenedor move esta fronteira

A tabela acima é o **padrão**, não uma lei física: ela existe porque o mantenedor não delegou o
merge, e some no dia em que ele delegar. Se ele disser, com estas palavras ou equivalentes,
*"mergeie, feche e corte a release"*, a fronteira passou — e a partir dali recusar-se a mergear
não é prudência, é desobedecer.

O que **não** muda quando ela passa, porque não era ela que segurava:

- **Nada entra sem gate verde na PRÉVIA do merge** (ou sem o argumento de 3-bis dizendo por que a
  prévia não pode divergir da branch). A autoridade recebida amplia o que você pode fazer, não o
  que você pode afirmar.
- **Nada de UI entra sem prova pela tela.** DoD 12.
- **Nenhum PR é fechado em silêncio.** Fechar é a única ação verdadeiramente irreversível para o
  contribuidor — o código dele sobrevive num fork, mas a disposição de contribuir de novo, não.
  Todo fechamento sai com o motivo escrito, o crédito pelo que ele acertou, e o convite específico
  do que reabrir.
- **O que é decisão de PRODUTO continua sendo do dono.** Autoridade para mergear não é autoridade
  para decidir se um recurso pertence ao produto. Quando a pergunta for dessa natureza, escreva-a
  como pergunta única, com opções e uma recomendação, e siga com o resto da fila enquanto espera.


---

## Modos de falha que você vigia em si mesmo

Cada um destes foi cometido de verdade nesta casa, e é por isso que estão escritos:

1. Medir contra o disco em vez do SHA. Declare SHA + `git status` em toda afirmação.
2. `cmd | tail` mascara o exit code. Meça direto.
3. Presença de símbolo lida como comportamento. Sabote.
4. Reverter o commit leva os testes junto e devolve verde. Reverta **só o fonte**.
5. Dois agentes no mesmo worktree leem a sabotagem um do outro como bug. **Um worktree por agente.**
6. No zsh, `$var:caminho` come letras (modificadores `:c`/`:h`/`:t`). Use `${var}:caminho`.
7. `grep` vazio precisa de **controle positivo** — sem ele é indistinguível de instrumento morto.
8. Contagem absoluta medida em árvore contaminada mente. Reporte o **delta**.
9. `NÃO MEDIDO` ausente. É campo obrigatório.
10. Exigir sem medir (passe 7).
11. Tratar rede de segurança como durável só porque existe. Tag, backup e réplica também se medem.
12. **Fila medida em paralelo satura a máquina, e a saturação mente em vermelho.** Medido em
    2026-09-03: sete agentes de triagem rodando ao mesmo tempo levaram o `load average` de 0,9 para
    **90,7**, e nesse regime o `next build` morreu duas vezes com `ELIFECYCLE 143` — `SIGTERM`, não
    erro de compilação. O sintoma imita defeito do PR com perfeição: log truncado, sem stack, sem
    linha culpada. Antes de atribuir um vermelho ao código, rode `uptime`. E escalone: leitura e
    `gh` em paralelo à vontade, mas **um `build`/`test:db` por vez** — os dois pesados são serial,
    não porque sejam lentos, e sim porque concorrer com eles corrompe o resultado de todo o resto.
13. **Um worktree por agente vira entulho se ninguém varre.** A mesma medição achou **195**
    worktrees registrados, **23** deles `prunable`. Worktree órfão não é só disco: ele aparece em
    `git worktree list` e faz a próxima sessão achar que há trabalho vivo onde não há. Feche o seu
    com `git worktree remove --force` no fim do seu passe, e rode `git worktree prune` ao encerrar
    a triagem. Isto é passe 11 aplicado ao próprio espaço de trabalho: se a bagunça só cresce, o
    procedimento não está se pagando.
14. **Verde de um gate não é verde de outro: eles medem DIMENSÕES diferentes.** O `CLAUDE.md` já
    avisa que *gate escolhido não é suíte* — mas ali o recorte é por **arquivo** (rodar
    `vitest run tests/unit` em vez de `pnpm test:unit`). Este é por **dimensão**, e escapa até de
    quem rodou a suíte inteira: **o vitest não checa tipo**. Uma árvore com `test:unit` verde pode
    ter `typecheck` vermelho, e a leitura natural do verde — "a suíte está limpa" — é falsa. Medido
    em 2026-09-03 num PR desta casa: o autor rodou `tsc`, depois acrescentou casos ao teste, nunca
    re-rodou o `tsc`, viu `test:unit` verde e abriu o PR; o `verify` do CI reprovou por
    `modeloDeAmbiente` recebendo `null` onde o tipo é `string | undefined`. **Tipo e comportamento
    são eixos independentes** — a ordem certa é `typecheck` **depois** da última edição, nunca antes.

    ⚠️ **E a spec de e2e não é exceção: o Playwright TRANSPILA sem checar tipo.** Medido em
    2026-09-04 — uma spec rodou **verde com um erro de tipo dentro dela**, e quem o achou foi o
    `pnpm typecheck`. Spec verde não diz nada sobre os tipos dela, exatamente como o `test:unit` não
    diz.

    ⚠️ **E o mesmo comando pode ter duas dimensões DENTRO dele, em sequência.** O `next build`
    imprime **`✓ Compiled successfully`** e só **depois** roda **`Running TypeScript`**. O check
    verde do primeiro passo aparece na tela **antes** de o segundo ter começado — e foi ali que um
    `TS2589` reprovou, num build que já parecia aprovado. Quem para de ler no primeiro ✓ dá o build
    por bom.

    Isso é diferente de rodar o comando errado (modo 23): aqui o comando é o certo, a ferramenta
    está correta, e o erro é **parar de ler cedo**. **A régua de um comando é o exit code, nunca uma
    linha verde no meio da saída.**
15. **Árvore parada é pré-condição do resultado, não detalhe.** `scripts/test-db.sh` guarda isso
    explicitamente (`arvore_mexeu` → *"a árvore mudou DURANTE a corrida: este resultado não vale,
    tenha ele passado ou não"*). **O `test:unit` não tem essa guarda**, e a ausência produz uma
    assinatura que se lê como defeito: **1 arquivo vermelho com 0 casos vermelhos** — os dois
    números discordando. A causa medida foi trocar de branch com a suíte rodando: o arquivo saiu do
    disco no meio e o vitest não conseguiu carregá-lo. Numa triagem com vários worktrees em
    paralelo isto deixa de ser acidente e vira risco de rotina. Antes de atribuir um vermelho ao
    código, confirme que **nada mexeu na árvore durante a corrida** — e, se mexeu, jogue o
    resultado fora e rode de novo, tenha ele passado ou não.
16. **O alvo se move enquanto você mede — e em lote ele se move sempre.** Toda medição vale para um
    SHA, e num repositório vivo o `head` de um PR muda no meio da triagem. Medido em 2026-09-03: um
    agente reportou o `verify` do #495 vermelho em `d94e30e1`, com a causa raiz identificada e
    reproduzida. Quando o veredito ia sair, o `head` era `61d9c066` — alguém consertara às 19:49 —
    e o `verify` estava `SUCCESS`. Deferir ao relatório teria produzido um pedido para consertar o
    que já estava consertado, que é exatamente o erro que o passe 7 existe para impedir. **Antes de
    agir sobre qualquer medição de terceiro — ou sua, de meia hora atrás —, reconfira o
    `headRefOid`.**

    ⚠️ **E reconferir no INÍCIO da medição não basta — tem de ser IMEDIATAMENTE ANTES do merge.**
    Medido no mesmo dia, no mesmo PR, na direção contrária: mergeei o #495 às **21:29:38 UTC**; o
    autor empurrou às **21:31:07** a guarda que faltava — a varredura de fonte que prende os dois
    call sites do conserto. **89 segundos.** O conserto de comportamento entrou na `main`; a rede
    que o protege, não. E ninguém teria notado, porque tudo ficou verde: era justamente uma guarda
    contra um defeito que a suíte não pegava.

    Numa fila, o intervalo entre "medi" e "mergeei" é onde o contribuidor está trabalhando — ele
    está ativo *porque* você respondeu. **Releia o `headRefOid` como último ato antes do merge**, e
    se ele mudou, remeça o que a mudança tocou.

    ⚠️ **E declare QUAL evento você comparou.** Ao reportar o intervalo, duas pessoas honestas
    divergiram: eu disse **89 segundos**, o autor disse **três minutos**. Os dois números estavam
    certos — eu comparei a **data do commit** contra a hora do merge, ele comparou a **hora do
    push**. Um commit fica no disco antes de ser empurrado, e a diferença é exatamente o intervalo.

    A régua desta casa passa a ser a **committer date do `headRefOid`** contra a hora do merge — e
    quem citar o número diz qual dos dois eventos mediu. É o modo *régua implícita* que o
    `CLAUDE.md` já nomeia, reaparecendo dentro do modo que existe para evitá-lo.
17. **`?branch=` é sonda cega quando o fork abriu o PR a partir da `main` dele.** Medido em
    2026-09-03: os PRs #418 e #465 têm `headRefName = main`, então `actions/runs?branch=main`
    devolve os runs da **`main` do upstream** — dezenas de execuções verdes sem relação nenhuma com
    o PR. Um triador que leia essa saída conclui "o CI rodou". Não rodou: no `head_sha` real havia
    **zero** execuções, e o contribuidor estava esperando havia dias sem que nada tivesse começado.
    Use sempre `actions/runs?head_sha=$(gh pr view <n> --json headRefOid --jq .headRefOid)`.
18. **Re-run não é evento novo.** Quando o vermelho é staleness — o CI testou contra uma `main`
    velha —, `gh run rerun` **não resolve**: ele reusa o payload do evento original, e o checkout
    faz `fetch` do **SHA fixo** daquele merge (`+61e359c…:refs/remotes/pull/<n>/merge`), não do ref.
    Medido no #422 em 2026-09-03. Se o workflow não tiver `workflow_dispatch` — e o `e2e.yml` não
    tem —, o único caminho é um evento `pull_request` novo: close+reopen do PR. **Avise o
    contribuidor antes de fazer**, porque ele recebe um e-mail de "fechado" e isso lê como rejeição.

    ⚠️ **E o close+reopen NÃO basta sozinho: o run novo nasce TRAVADO.** Medido logo em seguida, no
    mesmo #422 — reabri o PR, os quatro workflows foram criados, e os quatro nasceram em
    `conclusion: action_required`, esperando aprovação manual outra vez, porque a política de fork
    vale para **cada** evento novo. E o pior: `gh pr checks` continuava mostrando o `e2e=FAILURE`
    **do run velho**, então a tela dizia "reprovou de novo" quando na verdade **nada tinha rodado**.
    Eu quase reabri o diagnóstico e desmenti publicamente uma explicação que estava certa.

    **Depois de todo close+reopen, refaça o passe 1** — libere os runs novos e confirme pelo
    `head_sha`, nunca pelo `gh pr checks`:

    ```bash
    SHA=$(gh pr view <n> --json headRefOid --jq .headRefOid)
    gh api "repos/{owner}/{repo}/actions/runs?head_sha=$SHA&per_page=30" \
      --jq '[.workflow_runs[]|select(.conclusion=="action_required")]|.[].id'
    ```
19. **Precedência invertida: consultar a fonte SÓ quando o palpite não sabe.** Uma cascata escrita
    como *"se a heurística conhece, use-a; senão, vá à fonte"* faz o palpite **vencer sempre que ele
    acha que sabe** — e o dado bom nunca é ouvido. Medido em 2026-09-03, no PR #524, rodando a
    função de verdade:

    ```
    openrouter/openai/gpt-3.5-turbo   catalogo=false  registro=true   => enxergaImagem=true
    openrouter/google/gemma-2-9b-it   catalogo=false  registro=true   => enxergaImagem=true
    openrouter/anthropic/claude-2.1   catalogo=false  registro=true   => enxergaImagem=true
    openrouter/mistralai/mistral-7b   catalogo=false  registro=false  => enxergaImagem=false
    ```

    Num roteador (OpenRouter) o registro interno responde pelo **prefixo do fabricante**: vê
    `openai/` e afirma que o modelo enxerga imagem, para qualquer modelo daquele fabricante. O
    catálogo tem o dado que a **própria OpenRouter declarou** (`architecture.input_modalities`), e
    para o `gpt-3.5-turbo` ele diz `false` — que é a verdade. Como o catálogo só era consultado
    quando o registro não conhecia, e num roteador o registro sempre "conhece" se o prefixo bate, o
    dado declarado **nunca chegava a ser lido**.

    A quarta linha é o que fecha o argumento: com `registro=false`, a cascata cai no catálogo e
    acerta. Não é o registro que está errado — é a **ordem**.

    **A regra — e a primeira versão dela, escrita aqui, estava ERRADA.** Eu tinha escrito *"fonte
    declarada primeiro, heurística só no vazio"*, e quem mediu o caso derrubou a formulação no mesmo
    dia: **no provedor direto a coluna do catálogo é um default que ninguém preencheu** — medido
    `false` para todos os modelos numa instalação real. "Fonte primeiro" ali faria o sistema mentir
    `false` para tudo, que é o mesmo defeito virado do avesso.

    A regra certa é **MEDIDA VENCE PALPITE**, e o critério é ter opinião:

    | caminho | quem manda | por quê |
    |---|---|---|
    | provedor direto | o **registro** | a coluna do catálogo é default não preenchido — não tem opinião |
    | roteador | o **catálogo** quando ele tem opinião | `supports_vision` é `not null default false`, então `null` só acontece quando **não há linha** |

    Ou seja: não é a *origem* do dado que decide, é se aquela origem **tem algo a dizer sobre este
    caso**. Um default que ninguém preencheu não é dado — é ausência com cara de resposta, e é
    exatamente por isso que a heurística existia.

    ⚠️ **A regra tem uma PRÉ-CONDIÇÃO DE SCHEMA, e sem ela desmorona.** "Ter opinião" só é
    decidível porque `supports_vision` é **`not null default false`**: é o schema que faz `null`
    significar *"não há linha"* em vez de *"o provedor declarou false"*. Numa coluna **nullable**,
    os dois colapsam no mesmo valor, "tem opinião" vira indistinguível de "está vazia", e a regra
    devolve o defeito **com a doutrina do lado de quem errou**.

    Então, antes de aplicar: **confira a nulabilidade da coluna**. Se ela for nullable, o que
    distingue ausência de declaração não existe ainda — e o conserto é criar essa distinção (uma
    coluna de "sabemos?", um sentinela, ou tornar a coluna `not null` com default) **antes** de
    escrever a precedência. Ressalva trazida por quem mediu o caso, e ela é parte da regra, não
    nota de rodapé. E quando encontrar uma cascata
    num PR, pergunte de cada degrau: *ele pode responder ERRADO com confiança, impedindo o degrau
    seguinte — que tem o dado bom — de ser consultado?* Cascata é onde esta classe mora: `??`, `||`,
    `if (!conhecido) buscar(...)`, cache lido antes da fonte, prefixo/regex decidindo o que um campo
    declarado já responde.
20. **O conserto que troca ruído por SILÊNCIO — e por que essa direção é a pior.** O #524 nasceu
    para matar um aviso **falso** no caminho do provedor direto, e de quebra matou um aviso
    **verdadeiro** no caminho do roteador: antes dele a tela dizia *"gpt-3.5-turbo não enxerga
    imagens; fotos e comprovantes serão ignorados"*, e estava certa; depois, o aviso some e o `PUT`
    responde 200 limpo.

    As duas direções do erro **não custam o mesmo**. Aviso demais o operador percebe e reclama —
    o defeito se auto-denuncia. Silêncio ele **não percebe**: perde a informação sem saber que
    perdeu, e num produto self-host ninguém está olhando por ele.

    **Portanto, sempre que um PR REMOVE um aviso, um erro, um log ou uma validação, a pergunta é
    obrigatória:** *em quais casos esse aviso estava CERTO, e eles continuam avisando?* Enumere os
    casos verdadeiros **antes** de aceitar a remoção dos falsos, e exija um teste que prenda pelo
    menos um verdadeiro — senão o próximo conserto os leva junto de novo, e em silêncio.

    Note que este PR tinha checks verdes, teste próprio e fragmento. **Nada disso mede a direção do
    erro.** Quem achou foi uma revisão adversarial rodando a função com casos que separavam os
    caminhos — e quem confirmou foi o autor, remedindo contra o próprio PR em vez de deferir ao
    relatório. É o passe 7 aplicado a si mesmo, e é o que se espera de quem contribui aqui.
21. **O teste que prende o SINTOMA reprova o conserto certo.** Um caso escrito durante a
    investigação tende a codificar *a circunstância em que o defeito apareceu*, não *a propriedade
    que deve valer*. Enquanto o defeito existe, os dois são indistinguíveis — e o teste passa. Ele
    só se revela no dia em que alguém conserta de verdade.

    Medido em 2026-09-03, no PR #544. O caso escrito foi *"com `count` nulo, não afirme ausência"*.
    Depois do conserto ele ficou **vermelho — e estava certo em ficar**: com o conserto, quem prova
    o fim da varredura passa a ser a **página vazia** (fato independente do `count`), então numa
    loja de 3000 itens a quarta página volta vazia, a varredura **é** completa, e afirmar ausência
    passa a ser **correto**. O `count` nulo tinha deixado de significar qualquer coisa.

    **Isso é pior que teste ausente**, e é o ponto: um vermelho que aponta para o conserto empurra
    quem vem depois a desfazer o conserto para "consertar" o teste. O invariante certo — *só afirme
    ausência se chegou ao fim de verdade* — foi escrito com 12.000 itens, acima do teto de páginas,
    onde a varredura é parcial **de fato**.

    **E todo teste de "não faça X" precisa do irmão "mas ainda faça X quando é certo".** Sem ele, o
    conserto **degenerado** passa: *"nunca afirme ausência"* satisfaria o caso original e tornaria o
    agente **eternamente evasivo** — outro defeito, na direção de que ninguém reclama, porque
    excesso de cautela não gera reclamação de cliente. O controle que fecha essa porta aqui foi um
    caso de 2.500 itens que chega ao fim sem `count` e **deve** poder dizer que não tem.

    Ao revisar um teste novo, pergunte: *este caso descreve a CIRCUNSTÂNCIA em que o bug foi visto,
    ou a PROPRIEDADE que precisa valer?* E: *qual conserto degenerado passaria por ele?*

    E note a inversão desconfortável: **o perigo desta classe cresce com a confiança que a equipe
    tem na suíte.** Onde ninguém confia no verde, um caso errado é ignorado; onde o verde é levado a
    sério — que é o estado que se persegue — ele **dirige** a decisão, e dirige para o lado errado.
    Quanto melhor a disciplina de testes, mais caro fica cada teste que prende a circunstância.
22. **Fragmento ainda não lançado é PROMESSA, não histórico.** Um PR que faz uma promessa já escrita
    virar verdade **não precisa de fragmento próprio** — enquanto a versão não foi cortada, o texto
    que o operador vai ler é o que está em `.changes/`, e ele ainda não foi lido por ninguém.

    Medido no par #520 → #544: o fragmento do #520 promete *"a busca percorre o catálogo em páginas,
    na ordem do código, **até encontrar ou terminar**"*. Essa frase não era inteiramente verdadeira
    num dos ramos, e o #544 a torna verdadeira. A última release era a **v1.12.0**, anterior aos
    dois — logo não havia nada a corrigir do lado de fora.

    Um segundo fragmento diria *"consertamos o conserto"*, que é ruído para quem opera: **a versão
    sai inteira ou não sai**. O critério é este, e não a existência de código novo:

    | o PR… | fragmento próprio? |
    |---|---|
    | faz verdadeira uma promessa já escrita e ainda não lançada | **não** — confira que o texto existente segue verdadeiro |
    | muda o que o operador vai ler, ou acrescenta efeito | **sim** |
    | corrige algo já lançado numa versão anterior | **sim** — aquele texto já foi lido |
23. **"O gate passou" não é afirmação verificável — o COMANDO é.** Medido em 2026-09-03, e a
    retratação veio de quem tinha feito a afirmação:

    ```
    pnpm typecheck   =  tsc --noEmit -p tsconfig.typecheck.json
    o que foi rodado =  tsc --noEmit            ← sem -p, portanto contra tsconfig.json
    ```

    E os dois **fazem perguntas diferentes de propósito**: `tsconfig.json` exclui `**/*.test.ts`,
    `**/*.test.tsx` e `tests/**`; o `tsconfig.typecheck.json` **reinclui** tudo isso — a exclusão
    existe para o `next build` não typechecar teste, e o gate existe para typechecar. Rodar `tsc`
    pelado responde a pergunta do **build**, não a do gate, e chamar isso de "typecheck passou"
    afirma o que não foi medido.

    O desfecho foi caro: o gate real reprovava **desde sempre** (`exit 2`, um único `TS2589`), com
    controle no commit pai dando `exit 0`. Ninguém tinha olhado, porque "typecheck passou" parecia
    resposta.

    **Cite o comando, não o nome.** `pnpm typecheck exit=0` é verificável; *"o typecheck passou"* é
    uma lembrança de quem digitou outra coisa. Leia o `package.json` antes de citar um gate — os
    nomes mentem por abreviação, e este arquivo já registra a mesma classe em `test:unit`, que **não
    é** `tests/unit/`.

    ⚠️ **E apague o `.tsbuildinfo` antes de medir.** Os dois tsconfig têm `incremental: true`, e há
    `tsconfig.tsbuildinfo` **e** `tsconfig.typecheck.tsbuildinfo` no disco. Com cache, `tsc` devolve
    a resposta de uma árvore que talvez não exista mais: **incremental transforma medição em
    lembrança**. Numa varredura desta sessão, 3 de 5 worktrees tinham buildinfo.

    ### A parte que vale mais que a regra

    A explicação descartada era *"dois checadores de tipo discordam"* — e quem a descartou nomeou
    por que ela era suspeita: **ela fazia a FERRAMENTA parecer inconsistente em vez de fazer a
    MEDIÇÃO parecer errada.** Toda hipótese que inocenta quem mede merece um exame a mais, não a
    menos. É a mesma classe da **régua trocada** do modo 16 — lá eram dois **eventos** (commit contra
    push), aqui são dois **comandos** (`tsc` contra `tsc -p <config>`) — e nas duas vezes a
    divergência parecia defeito do mundo e era escolha de instrumento.
24. **Custo não quebra nada — por isso ele passa.** Um roundtrip a mais por turno não derruba
    teste, não acende alerta e não aparece em nenhum gate. Ele aparece na fatura, semanas depois, e
    ninguém liga a conta ao PR que a criou. É a classe de defeito com o retorno mais lento desta
    casa, e a única que **piora sozinha com o sucesso do produto**: quanto mais conversas, mais caro
    o mesmo descuido.

    O antídoto medido, trazido em 2026-09-03: **um dublê que EXPLODE se o recurso caro for
    consultado.** No caminho do provedor direto, onde a consulta ao catálogo é desnecessária, o
    dublê do banco lança em vez de responder — então a ida ao banco vira **vermelho**, e não conta
    subindo em silêncio.

    ```
    provedor direto  → dublê do banco LANÇA  → se alguém consultar, o teste quebra
    roteador         → dublê responde        → o caminho que PRECISA consultar segue medido
    ```

    Generalizando: quando um caminho **não deve** tocar um recurso caro — banco, LLM, rede, storage
    —, não baste comentar isso. **Injete um dublê que falha ao ser tocado.** É o único jeito de a
    ausência de uma chamada virar propriedade guardada, em vez de intenção escrita num comentário
    que a próxima refatoração não lê.

    Isto é o passe 6-bis olhando para o outro lado: lá a pergunta é *"o dado atravessa uma porta
    sem guarda?"*; aqui é *"a chamada acontece numa porta onde ela não devia?"*. As duas se provam
    do mesmo jeito — sabotando e exigindo vermelho.

    ### A classe é maior que o caso, e esta casa já pagou duas irmãs

    | irmã | forma | o que custou |
    |---|---|---|
    | consulta ao banco desnecessária por turno | roundtrip a mais | o caso acima |
    | **chamada de LLM a mais por turno** | mesma forma, **custo por unidade muito maior** | não medido aqui |
    | **linha de audit por rodada de cron VAZIA** | escrita a mais por minuto | **95% do audit log** numa VPS real, e ~51.840 linhas/mês numa instalação que não atende ninguém |

    A terceira já tem gate, e o desenho dele é o molde a copiar:
    `tests/unit/cron-audita-so-quando-ha-efeito.test.ts` percorre o **AST** de **toda** rota de
    `app/api/v1/cron/` — **21** hoje — em vez de uma lista fixa, então alcança rota que ainda não
    existe. E ele mede as **duas** direções: *auditar quando houve efeito* **e** *não parar de
    auditar*. Um gate que só proibisse a escrita seria satisfeito por "nunca audite", que é o
    conserto degenerado do passe 21.

    O que une as três: **nenhum gate mede fatura.** O efeito não aparece em teste, em lint, em
    tipo, em build — aparece semanas depois, num lugar onde ninguém está procurando um PR.
25. **Alegação COMPOSTA: separe antes de aceitar ou descartar inteira.** Uma alegação com duas
    afirmações dentro pode ter uma metade falsa e outra verdadeira, e o trabalho é **separar**.
    Retratar tudo leva a parte boa junto; defender tudo mantém a ruim.

    Medido em 2026-09-03. A alegação era: *"`pnpm typecheck` verde e `next build` vermelho, mesmo
    arquivo, mesma linha — dois checadores discordando"*.

    - **Caiu:** não havia dois checadores. O gate é `tsc --noEmit -p tsconfig.typecheck.json` e o
      que rodou foi `tsc --noEmit` (modo 23).
    - **Ficou:** o `next build` imprime `✓ Compiled successfully` e só **depois** roda
      `Running TypeScript`, e o erro saiu no segundo passo (modo 14).

    ### O sinal barato que diz se são duas — use antes de retratar

    > **Liste as afirmações atômicas e veja para QUEM cada uma aponta a culpa. Se apontam para
    > agentes diferentes, quase nunca é uma alegação só.**

    Aqui: a metade falsa culpava a **ferramenta** (ela seria inconsistente); a verdadeira culpa
    **quem para de ler cedo**. Culpados distintos, alegações distintas.

    E há um viés que o sinal desarma: a metade que culpa a ferramenta é sempre a mais confortável de
    manter, porque ela inocenta quem mediu. Foi ela que caiu.
26. **O desfecho bom esconde o erro de método — e é o caso mais perigoso, porque não deixa
    vermelho.** Quando o conserto está certo, ninguém volta a olhar como ele foi verificado. O
    acerto vira álibi da verificação.

    Medido em 2026-09-03, e o relato é de quem cometeu: um erro de tipo **dentro de um arquivo de
    teste** foi consertado, e a verificação declarada foi *"(vazio = typecheck ok)"* — rodando `tsc`
    **pelado**. Só que o `tsconfig.json` **exclui** `**/*.test.ts` e `tests/**`. Aquele verde era
    **vazio**: não disse nada sobre o arquivo que acabara de ser consertado. **O conserto estava
    certo, e quem provou isso foi o CI, não a medição.**

    Compare com os outros erros do mesmo dia: os que produziram vermelho foram achados em minutos,
    porque o vermelho reclama. Este ficou de pé até alguém reabrir o caso **contra si mesmo**, sem
    nenhum sintoma pedindo atenção.

    **A pergunta que desarma:** *o que eu rodei teria ficado VERMELHO se o conserto estivesse
    errado?* Se você não consegue responder com um controle — um erro deliberado que a sua sonda
    **enxerga** —, você tem um desfecho, não uma verificação. E vale para qualquer sonda, não só
    typecheck: `grep` que volta vazio, teste que passa, script que sai 0.

    É o irmão exato do modo 7 (`grep` vazio precisa de controle positivo), promovido de sonda para
    **método**: o controle positivo não é um capricho do `grep`, é o que separa medir de lembrar.

    ### O gatilho, e ele é um COMANDO — não "lembre-se de perguntar"

    A regra acima tem um defeito honesto: quem a cometeu só reabriu o caso porque um detalhe do
    `tsconfig` chegou por acaso. **O achado dependeu de sorte, não de mecanismo** — e regra disparada
    por lembrança é a que falha exatamente no dia cansado.

    O mecanismo existe, é barato, e vale para toda sonda:

    > **Toda sonda que declara verde consegue LISTAR o que olhou. Confira que o arquivo que você
    > mudou está na lista.**

    Medido em 2026-09-03, e é a prova completa do caso deste passe:

    ```bash
    tsc --noEmit -p tsconfig.typecheck.json --listFilesOnly | grep -c 'tests/unit/branding-saida.test.ts'   # → 1
    tsc --noEmit -p tsconfig.json           --listFilesOnly | grep -c 'tests/unit/branding-saida.test.ts'   # → 0
    ```

    **1** contra **0**, e é essa a forma que importa. Contar o total dos dois lados também
    funciona — deu 8.055 contra 6.979 no dia — mas **número de contagem envelhece**: a árvore
    cresce, os dois números mudam, e a diferença deixa de significar o que significava. O
    `grep -c <o seu arquivo>` responde **1 ou 0** e vai continuar respondendo 1 ou 0 daqui a um ano.

    O verde do pelado não era sobre aquele arquivo, e **o comando diz isso sem que ninguém precise
    suspeitar de nada**.

    ⚠️ **E prove sobre O ARQUIVO REAL, não sobre um sintético.** Um erro deliberado num arquivo
    novo prova que o mecanismo existe; a listagem sobre o arquivo que você **declarou verificado**
    prova que a sua afirmação estava vazia. São perguntas diferentes, e só a segunda fecha o caso
    contra você.

    A receita por ferramenta:

    | sonda | como perguntar "você olhou o meu arquivo?" |
    |---|---|
    | `tsc` | `--listFilesOnly` e `grep` o seu arquivo |
    | `vitest` | `--reporter=verbose` (a saída nomeia os arquivos) ou `vitest related <fonte> --run` |
    | `eslint` | `--format=json` — o `filePath` de cada entrada é a lista |
    | `grep` / sonda própria | o controle positivo do modo 7 |

    A diferença entre este gatilho e a regra: a regra pede que você **desconfie**; o comando responde
    mesmo quando você **não** desconfia. É a mesma preferência que o `CLAUDE.md` já enuncia noutro
    contexto — *prefira o comando à afirmação, porque comando não envelhece*. Aqui ele também não
    depende de humor.
27. **Convergência independente vale MAIS quando difere por uma constante explicada.** Duas medições
    do mesmo fenômeno que batem **exatamente** são evidência mais fraca do que duas que diferem por
    um offset constante e explicável — porque o número idêntico também sai de alguém ter **copiado o
    método** sem pensar.

    Medido em 2026-09-03, no bloqueador do #507. Duas pessoas mediram o tamanho da URL, cada uma com
    o seu fixture:

    ```
              medição A    medição B
    ids=100     4.753 B      4.760 B
    ids=200     8.653 B      8.660 B     ← acima de 8.192 nas duas
    ```

    **Sete bytes de diferença nas duas linhas.** O que fecha o argumento não é o "acima de 8.192"
    coincidente — é o offset ser **constante**: uma divergência de *mecanismo* escalaria com o
    número de ids; esta não escala. Logo é parte **fixa** diferente (o termo de busca, o uuid da
    organização), e as duas medições descrevem o mesmo fenômeno por caminhos independentes.

    A leitura prática, ao receber uma medição de terceiro que confirma a sua:

    | o que você vê | o que significa |
    |---|---|
    | número **idêntico** | pode ser confirmação — ou o mesmo script rodado duas vezes. Pergunte qual fixture a outra pessoa usou |
    | offset **constante**, explicável pela parte fixa | **a evidência mais forte**: dois caminhos, um fenômeno |
    | divergência que **escala** com o parâmetro | mecanismos diferentes. Uma das duas está medindo outra coisa — volte ao passe de régua |

    É o complemento do modo *medições discordantes*: nem toda diferença é erro, e nem toda igualdade
    é confirmação.
28. **Ao auditar a sua própria auditoria, meça a lente — e ponha controle positivo na sonda que a
    mede.** Uma taxa de sobrevivência alta (18 de 20 num lote) pode significar achados bons **ou**
    lente frouxa, e as duas leituras são indistinguíveis sem medir.

    O teste barato: **conte quantos achados vieram com REPRODUÇÃO (comando rodado + saída) contra
    quantos vieram só de leitura de código.** Se a maioria for leitura, a lente passou perto demais.

    ⚠️ **E a sonda que classifica precisa de controle positivo, igual a qualquer outra.** Medido no
    mesmo dia: a classificação automática marcou um achado como "zero sinais de execução", e ao ler
    o texto ele era **um dos mais bem medidos do lote** — rodou as duas versões da função com o
    mesmo dublê, aplicou a expressão exata da rota e mostrou antes/depois. O regex procurava
    `exit=` e `Tests N`; o autor escreveu `[catalogo 503]` e `=> linha final:`. **A cega era a
    sonda, não o achado** — o modo 7 aparecendo dentro do instrumento que audita.

    E reporte a **margem**, não só o placar. Numa votação de 3 lentes com corte em 2 refutações,
    conte quantos sobreviventes tiveram **uma** refutação: são os que passaram raspando, e o número
    deles diz mais sobre o rigor do que o total. No lote medido: 60 votos, 12 refutaram, 2 achados
    caíram (4 votos) — sobrando 8 refutações espalhadas entre 18 sobreviventes.

    Por fim, o denominador importa: **auditar código que ninguém revisou não produz a mesma taxa que
    auditar código já revisado**. Um lote de 13 PRs de autores variados e um lote de 3 PRs que o
    próprio autor já revisou adversarialmente não são comparáveis, e a diferença entre 90% e 17% de
    sobrevivência pode ser inteiramente isso.
29. **Número derivado de um CORTE não significa nada sem o corte declarado.** Duas taxas do mesmo
    tipo de medição, produzidas por **limiares de decisão diferentes**, não são comparáveis — e a
    comparação parece legítima porque as duas são "porcentagem de sobreviventes".

    Medido em 2026-09-03, e foi a **terceira** aparição da régua implícita no mesmo dia, por um
    caminho novo:

    | # | o que divergia | a régua escondida |
    |---|---|---|
    | 1 | 89 segundos × 3 minutos | **evento**: committer date × hora do push |
    | 2 | typecheck verde × CI vermelho | **comando**: `tsc` × `tsc -p <config>` |
    | 3 | 90% × 25% de sobrevivência | **limiar**: 1 refutação mata × 2 refutações matam |

    Nenhuma das três foi má-fé, e é isso que as torna perigosas: em todas, dois números do mesmo
    *tipo* de medição, produzidos por critérios diferentes, comparados como se fossem a mesma
    grandeza.

    No caso 3, o lote de 20 achados dava **18 sobreviventes** sob "2 refutações matam" e **~10** sob
    "1 refutação mata" — 90% contra 50%, do mesmo dado. A diferença que parecia ser de **rigor** era
    de **corte**.

    ⚠️ **E o texto do prompt discordava do código**: ele dizia *"na dúvida, refute"* enquanto o
    código implementava `refutaram < 2`, que é o oposto. Prosa e mecanismo divergindo dentro do
    próprio instrumento — o mesmo defeito que este documento persegue no código do produto.

    **Ao escolher o limiar, pergunte o custo de cada erro, não qual é o "correto":**

    - **1 refutação mata** — conservador. Mata achado bom, e o custo é um defeito que segue vivo.
    - **2 refutações matam** — permissivo. Deixa passar achado fraco, e o custo é **tempo de
      gente**, que é o recurso escasso.

    Num lote **já mergeado**, a assimetria é clara: achado fraco que passa vira alguém investigando
    o que não existe. **Use 1.** E declare o limiar ao lado da taxa, sempre.

    ### O gate que impede isso de voltar — e é de três linhas

    O problema não é escolher o limiar errado; é o limiar **viver em dois lugares**. Enquanto o
    critério estiver em **prosa** no prompt e em **aritmética** no agregador, os dois divergem **sem
    sintoma**: nenhum teste reprova, nenhum vermelho aparece, e o único jeito de descobrir é alguém
    comparar taxas de dois harnesses por acaso — que foi exatamente o que aconteceu.

    **A regra: o prompt e o agregador leem o limiar do MESMO lugar.**

    ```js
    /** FONTE ÚNICA — o prompt e o agregador leem daqui. */
    const REFUTACOES_QUE_MATAM = 1

    // no prompt da lente:
    `${REFUTACOES_QUE_MATAM === 1
        ? 'Basta a SUA refutação para o achado cair — nenhuma outra lente precisa
           concordar com você, então pese o voto sabendo disso.'
        : `São precisas ${REFUTACOES_QUE_MATAM} refutações para o achado cair.`}`

    // no agregador:
    sobrevive: refutaram < REFUTACOES_QUE_MATAM

    // e no log final, para a taxa nunca sair sem o corte ao lado:
    log(`${n} sobreviveram (limiar: ${REFUTACOES_QUE_MATAM} refutação basta para matar)`)
    ```

    Note o efeito colateral bom: com a constante em **1**, o prompt passa a **avisar o revisor** de
    que o voto dele decide sozinho — informação que muda como ele pesa a decisão, e que a versão
    anterior escondia dele.

    Isto vale para qualquer harness com voto: revisão adversarial, painel de juízes, qualquer
    agregação por corte. **Critério que vive em dois lugares é critério que vai divergir.**
30. **Sonda boa guardada, sonda ruim na hora de decidir.** O instrumento improvisado aparece
    justamente no momento da decisão — e é ali que ele custa mais caro.

    Dois casos medidos no mesmo dia, ambos por quem tinha a sonda certa disponível:

    - Uma classificação de 20 achados por `grep` de `exit=` e `Tests N` marcou como "sem execução"
      **o achado mais bem medido do lote**, que escrevia `[catalogo 503]` e `=> linha final:`.
      Custo: tempo perdido e uma conclusão errada sobre a própria auditoria.
    - Um `jq` improvisado para a decisão final de liberar um PR **agregava apenas os checks
      presentes** — e "ausente" virou "verde" por omissão. O PR quase foi liberado com um dos cinco
      obrigatórios **sem ter começado**. A ferramenta boa existia e estava guardada num monitor que
      tratava ausência de propósito.

    O segundo é pior, e a diferença diz onde olhar: **classificar errado gasta tempo; decidir errado
    entrega**. A pressa de concluir é exatamente o momento em que o atalho entra.

    A regra: **a sonda que decide é a que mais precisa de controle positivo** — e se você já tem uma
    sonda boa para aquela pergunta, use-a, mesmo que pareça exagero para "só conferir uma coisa".

    ### O caso mais barato da mesma família: o RÓTULO lido como ESTADO

    Uma sonda que **agrupa** estados por conveniência de exibição transforma imprecisão de rótulo em
    imprecisão de relato. Medido no mesmo dia: um monitor imprimia **"rodando"** para `QUEUED`,
    `PENDING` e `IN_PROGRESS` juntos, e o relato saiu como *"já saiu da fila para execução"* quando
    o dado bruto dizia `QUEUED` — ainda na fila.

    Aqui não mudou nada prático (os dois significam "espere"), e é por isso que o caso é bom para
    aprender: **o erro passa despercebido justamente quando não custa nada**, e o hábito que ele
    forma é o que custa depois.

    O mesmo vício apareceu num relato meu, de outra forma: eu vinha reportando `4/5` sem dizer
    **qual** faltava nem **em que estado** — um agregado que esconde a diferença entre "reprovou",
    "está rodando" e "nem começou", que são três decisões diferentes.

    **A regra: ao reportar estado de gate, imprima um por linha com o valor bruto.** E se agregar,
    diga o que ficou de fora:

    ```bash
    # ruim: esconde qual e em que estado
    ... | jq '[.[] | select(.state=="SUCCESS")] | length'

    # bom: a contagem VEM com o resto nomeado
    ... | jq '{verdes: [...|select(.state=="SUCCESS")]|length,
               faltando: [...|select(.state!="SUCCESS")|"\(.name)=\(.state)"]}'
    ```

    ⚠️ **E "AUSENTE" em `gh pr checks` tem DUAS causas opostas.** Um check obrigatório pode não
    aparecer porque (a) o workflow nunca foi disparado — e aí alguém precisa agir — ou porque (b)
    ele está **rodando agora** e o *check de fachada* (o job que agrega os filhos, como o `e2e` e o
    `imagens-ok`) só reporta no fim. Medido em 2026-09-04: `gh pr checks` dizia `e2e=AUSENTE` num PR
    cujo `actions/runs` mostrava `e2e: in_progress`.

    As duas causas pedem coisas opostas — liberar/re-disparar contra apenas esperar —, então **a
    lista de checks não basta: confirme pelo run**.

    ```bash
    SHA=$(gh pr view <n> --json headRefOid --jq .headRefOid)
    gh api "repos/{owner}/{repo}/actions/runs?head_sha=$SHA&per_page=20" \
      --jq '.workflow_runs[] | "\(.name): \(.status)/\(.conclusion // "-")"'
    ```

    É a terceira vez que `gh pr checks` engana nesta doutrina — nos modos 17 e 18 mostrando o run
    **velho**, aqui escondendo o run **em curso**. A regra que sai das três: **`gh pr checks` serve
    para ver o que já concluiu; para saber o que está acontecendo, vá ao `actions/runs` do
    `head_sha`.**
31. **`exit 1` com RODAPÉ VAZIO não é reprovação — é "não rodou nada".** E numa sabotagem essa
    confusão é fatal, porque o vermelho é justamente o resultado que você **espera**: você lê "a
    guarda pegou" quando o que aconteceu foi o comando não ter medido coisa alguma.

    Medido em 2026-09-03. Uma sonda passou dois caminhos de teste via variável sem aspas — e **o
    shell aqui é `zsh`, que não faz word-splitting de `$VAR`**. O vitest recebeu um único argumento
    inexistente, respondeu `No test files found` e saiu **1**. Os **cinco primeiros** resultados de
    sabotagem daquele PR vieram assim, e quase foram lidos como acerto.

    O que denuncia é o **rodapé**: `Test Files … | Tests …` ausente ou zerado. `exit 1` sozinho é
    ambíguo entre três coisas — reprovou, não achou arquivo, não conseguiu carregar —, e as três
    exigem reações opostas.

    ```bash
    pnpm test:unit <alvo> > /tmp/s.log 2>&1; echo "exit=$?"
    grep -aE "Test Files|Tests " /tmp/s.log | tail -2   # VAZIO aqui = não mediu, não "reprovou"
    ```

    **A regra: toda sabotagem declara, além do exit code, quantos casos rodaram.** Previsão de
    *"1 vermelho de 12"* é verificável; previsão de *"vai dar erro"* é satisfeita por um comando
    quebrado. E no `zsh`, prefira **argumentos literais** ou `bash -c` — `${=VAR}` existe, mas
    lembrar dele é o tipo de coisa que falha no dia cansado.
32. **Saturação produz vermelho falso em MASSA, e a massa é o sinal.** Uma rodada de `test:unit`
    reprovou **19 arquivos e 39 casos** — *nenhum* deles tocado pelo PR, todos com
    `Test timed out in 15000ms` — enquanto um `test:shell` corria em paralelo. Serializado e sozinho:
    **639/639 verde, zero timeouts**.

    A assinatura que distingue de defeito real, e ela é barata de ler:

    | sinal | saturação | defeito |
    |---|---|---|
    | quantidade | dezenas de arquivos de uma vez | poucos, concentrados |
    | mensagem | `Test timed out` / `Hook timed out` | asserção nomeada |
    | relação com o diff | arquivos que o PR **não toca** | arquivos do PR |
    | reprodução isolada | **verde** | vermelho de novo |

    **Nunca reporte contagem medida sob concorrência.** Rode `uptime`, serialize, e diga na medição
    que serializou — um número colhido em máquina saturada não é conservador nem otimista: é outro
    número, de outra pergunta.

    ### A mesma doença no CI: o vermelho do VIZINHO

    Na máquina local a saturação vira timeout; no runner ela vira **porta ocupada**. Medido em
    2026-09-04, num `e2e` reprovado:

    ```
    failed to bind host port for 0.0.0.0:54324 … address already in use
    Error: failed to start containers
    ```

    O ambiente **não subiu** — nenhuma spec chegou a rodar —, e o job aparece como `failure` igual a
    uma asserção quebrada. Com a fila cheia (23 runs enfileirados naquele momento, todos vindos dos
    merges do próprio dia), dois jobs disputam a mesma porta fixa do stack local.

    **Como distinguir de defeito, e é barato:** procure no log a fase em que morreu. Se a falha
    aparece **antes** de qualquer nome de spec — em "Subir Supabase local", em `docker`, em bind de
    porta —, nenhuma asserção foi avaliada e o vermelho não é do PR.

    ```bash
    gh run view --job <id> --log-failed | grep -aE "address already in use|failed to start containers"
    ```

    ⚠️ **E aqui `gh run rerun` É o certo**, ao contrário do modo 18: lá o problema era o SHA velho e
    re-run reproduzia a base errada; aqui o SHA está certo e o que falhou foi o ambiente. **Re-run
    contra falha de ambiente é correto; contra staleness é teatro.** A pergunta que separa as duas:
    *o que mudou desde a falha — o código ou a máquina?*
33. **A prévia do merge é árvore DESCARTÁVEL — commitar nela perde o trabalho em silêncio.** O passe
    3 manda montar a prévia (`git merge-tree` ou um worktree com a `main` mesclada) para rodar os
    gates. Essa árvore existe para **medir**, não para guardar.

    Medido em 2026-09-04, e o desfecho foi público: escrevi o fragmento de versão e o conserto de um
    gate de privacidade **dentro da prévia**, dei o veredito no PR do contribuidor dizendo que os
    dois estavam feitos, e mergeei o PR dele pelo GitHub. A prévia nunca foi empurrada. O conserto
    dele entrou; **os dois artefatos que eu prometi, não** — e a afirmação ficou escrita no PR dele
    por horas.

    ```
    .changes/<o fragmento>                 → não existe na main
    <a constante do gate estendido>        → 0 ocorrências na main
    ```

    **Não há sintoma.** Sem conflito, sem vermelho, sem nada: o merge do PR do contribuidor é
    legítimo e completo — só que o *seu* trabalho estava noutra árvore, que ninguém pediu para
    ninguém.

    A regra: **trabalho seu nasce numa branch a partir de `origin/main`, nunca na prévia.** Se você
    já escreveu na prévia, `cherry-pick` para uma branch de verdade **antes** de mergear o PR que a
    originou — depois do merge, a prévia vira uma árvore órfã que só você sabe que existe, e o
    worktree pode ser varrido por qualquer limpeza.

    E há a verificação que fecha, que custa um comando por artefato prometido:

    ```bash
    # depois de mergear, confira na main o que você DISSE que fez
    git show origin/main:<caminho do artefato> >/dev/null 2>&1 && echo ok || echo "NÃO CHEGOU"
    ```

    Foi a **segunda** vez no mesmo dia que um artefato ficou para trás de um merge — a primeira foi
    uma guarda empurrada 89 segundos depois (modo 16). As duas têm a mesma forma: **o merge entrega
    o que estava no PR, e nada mais**; tudo o que você prometeu e não pôs lá dentro precisa de um
    caminho próprio, e de uma conferência depois.

    **E há uma distinção que muda o conserto**, apontada por quem revisou este modo. As três
    ocorrências têm a mesma forma, mas o *lugar* onde o trabalho ficou preso é diferente em espécie:

    | onde o trabalho ficou | por que se perdeu | o que conserta |
    |---|---|---|
    | branch empurrada, PR de outro | ninguém **olhou** | um lembrete: conferir depois do merge |
    | commit local, não empurrado | ninguém **puxou** | um comando: `git show origin/main:` |
    | **árvore de prévia** | a árvore **existe para ser destruída** | não commitar ali, nunca |

    Os dois primeiros são acidentes de atenção. O terceiro não é: a prévia é **descartável por
    construção**. Trabalho commitado nela não corre o risco de se perder — ele **já nasce perdido**,
    e nenhuma disciplina de conferência corrige isso, porque a conferência acontece depois de a
    árvore ter cumprido a função dela, que é sumir. É a diferença entre esquecer a chave em cima da
    mesa e deixá-la dentro do saco de lixo: o segundo caso não pede memória melhor, pede não pôr.

34. **o erro de objeto: medir com precisão perfeita a coisa errada.** **Sintoma:** um alarme grave, sustentado por uma medição correta. O comando rodou, a saída é real, o
    raciocínio fecha — e a conclusão é falsa, porque o objeto medido não era o objeto em vigor.

    O caso que gerou este modo quase virou um relatório de que a release não sairia: a guarda que
    autoriza o corte não tinha rodada para o commit que removeu os fragmentos. Verdade — e irrelevante.
    Aquele commit era o de **dentro do PR**; quem está na `main` é o **merge**, e a guarda roda no merge.

    O modo é traiçoeiro porque **imita rigor**. Quem mede com cuidado sente que está sendo cuidadoso, e o
    cuidado se aplica todo à execução da medida, nenhum à escolha do que medir. Medir de novo, com mais
    capricho, não sai do buraco: devolve a mesma resposta errada com mais casas decimais.

    A pergunta que sai, e ela vem **antes** do comando:

    > **Sobre qual objeto esta regra roda?** O commit ou o merge? A branch ou a prévia? O arquivo no
    > disco ou o do `origin/main`? A função ou o *call site*?

    E o corolário, que é o achado dentro do achado: a mesma guarda tinha um segundo modo de falha que só
    apareceu quando o objeto certo foi nomeado. Num *merge commit*, o autor visível é **quem clicou**; o
    assinante do trabalho é o **segundo pai** (`HEAD^2`). Uma guarda que lesse o autor do merge recusaria
    a própria release — e passaria em todo teste que não fosse um merge assinado por bot. Não é um gate
    que nasce vermelho (modo 21): é pior, **nasce verde e só vermelha em produção**.

35. **a árvore recém-criada não tem `node_modules`, e o gate mente nos dois sentidos.** `git worktree add` copia o que está versionado, e `node_modules` não está. Numa árvore nova:

    | comando | o que devolve | o que parece |
    |---|---|---|
    | `npx tsc --noEmit -p tsconfig.json` | **exit=0, 0 erros** — tendo carregado **9 arquivos** | sucesso |
    | `npx vitest run <arquivo>` | baixa outra versão da rede, não resolve `vitest/config`, **exit=1 sem rodapé** | teste vermelho |

    As duas saídas enganam em direções **opostas**, e a primeira é a pior: ela devolve o número
    **otimista**, que ninguém questiona. Um `typecheck` que passou é a última coisa que alguém relê.

    O gatilho mecânico, que custa um comando:

    ```bash
    npx tsc --noEmit -p tsconfig.json --listFilesOnly | wc -l   # milhares = mediu; dezenas = não mediu
    ```

    Para conferências que não dependem de tipos — duplicata de chave, o regex de um gate, ordem de blocos —
    **reproduza a regra com `python3`/`grep` na própria árvore e valide com controle positivo.** Sai em
    segundos, contra o gigabyte de um `pnpm install` que você não vai reusar.

36. **o hook recusa o commit, e o `push` seguinte publica o SHA errado calado.** Um `git commit` barrado por hook de governança não interrompe o bloco: o `push` na linha seguinte roda,
    publica **o HEAD que já existia**, e devolve sucesso. O eco que você escreveu (`echo "salva: ✓"`) sai
    igual ao do caminho certo.

    Foi assim que três branches nasceram apontando para o commit da `main`, com o trabalho inteiro só no
    disco de uma árvore descartável — o modo 33 e o modo 36 se somando.

    Duas defesas, e a segunda é a que pega:

    ```bash
    DESKCOMM_GOV_MIGRATION_EDIT=1 git commit ...        # a variável que o hook exige
    git log --oneline -1 && git diff --stat origin/main..HEAD   # o commit EXISTE e tem o tamanho certo?
    ```

    É a mesma família do [bloco que edita e commita]: **um bloco onde um passo falha e o seguinte
    "tem sucesso" produz uma afirmação verdadeira sobre a coisa errada.** Nunca deixe o eco de sucesso
    depender só de o último comando ter retornado zero.

37. **extrações paralelas escolhem todas o mesmo número de migration.** Três recortes do mesmo PR gigante, rodando ao mesmo tempo. Cada um lê `ls supabase/migrations/`, vê que
    o último é `0207`, e escolhe `0208`. Duas escolhem até o **mesmo timestamp**.

    Sozinha, cada uma está certa — e é isso que torna o modo invisível: nenhuma revisão individual pega.
    A colisão só existe no conjunto, e o conjunto não é revisado por ninguém.

    E o número livre **não se descobre na `main`**: ele se descobre nos **PRs abertos**, que já reservaram
    os seguintes sem tê-los mergeado.

    ```bash
    # o que a main já tem
    git ls-tree --name-only origin/main supabase/migrations/ | grep -oE "_0[0-9]{3}_" | sort -u | tail -1
    # o que os PRs ABERTOS já reservaram
    for P in $(gh pr list --state open --json number --jq '.[].number'); do
      gh pr view $P --json files --jq '.files[].path' | grep -oE "_0[0-9]{3}_" | sed "s|^|#$P |"
    done | sort -u
    ```

    **E renumerar é três arquivos, não um.** O nome do `.sql`, o rótulo `-- ---- … (migration NNNN) ----`
    no apêndice do `baseline.sql`, e a linha do `MANIFEST.md`. No MANIFEST o número vem **colado ao slug**
    (`0208_juntar_contatos_duplicados`), então um `sed` por palavra isolada não o alcança — e o
    `grep -c 0208` seguinte devolve `1` por causa de outra ocorrência qualquer, **confirmando um conserto
    que não aconteceu**. Confira pelo conteúdo da linha, não pela contagem.
