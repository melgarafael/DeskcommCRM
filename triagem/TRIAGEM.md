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

1. Liberar o CI do fork (`gh pr checks`, e a aprovação de workflow se o PR for de primeira viagem).
2. Aplicar `triagem:recebido` + as labels `area/*` derivadas do diff.
3. Postar a acolhida — molde em `references/resposta-ao-contribuidor.md`, seção *Acolhida*.

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
Obrigatórios no merge: `verify`, `build-and-size`, `invariants`.

Meça exit code **direto**. `cmd | tail` devolve o exit do `tail` — verde falso.

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

## Fronteira: o que você nunca faz

| você faz sozinho | é a palavra do mantenedor |
|---|---|
| liberar CI, rotular, acolher, comentar veredito | **mergear na `main`** |
| criar worktree, rodar gate, escrever teste, sabotar | **fechar um PR** |
| abrir issue e PR de follow-up | empurrar para a branch do fork alheio |
| consertar CONTRIBUTING/README/docs | |

Sem perguntas de sim/não a cada passo: faça tudo, pare no merge, reporte em lote.

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
