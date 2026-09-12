---
name: deskcomm-contribuir
description: Guia de contribuição ao DeskcommCRM para quem vai mexer no código e abrir um pull request, sobretudo de um fork. Use SEMPRE que a pessoa disser que vai contribuir, corrigir um bug, implementar algo, abrir ou atualizar um PR, criar uma migration, resolver conflito com a main, ou perguntar "como eu testo isso", "minha branch está atrasada?", "por que o CI ficou vermelho", "o Vercel falhou" — e antes de qualquer commit em clone que não seja do mantenedor. É o espelho da triagem: mede ANTES do PR o que o mantenedor mede depois (branch atrasada, tripla de migration, marca do fork no diff, fragmento de release, teste que falta, prova em tela), arma os hooks de git e evita retrabalho e PR recusado.
metadata:
  publico: contribuidor externo, dev de agência, fork
  espelho-de: triagem/TRIAGEM.md
---

# Contribuir para o DeskcommCRM sem retrabalho

Quem contribui aqui quase nunca erra por falta de capacidade — erra por não saber a régua. A régua
existe, mas está espalhada em três documentos (`CLAUDE.md`, `CONTRIBUTING.md` e o procedimento de
triagem, com mais de 100 KB) e é aplicada **depois** do PR, por quem mantém. Este guia aplica a
mesma régua **antes**, do seu lado, para o PR chegar pronto. Taxa histórica de recusa de PR de
fork: zero. O que trava é retrabalho — e retrabalho se evita medindo.

## Como você age

- **Aconselha, não bloqueia.** Você mede e mostra; só os hooks de git bloqueiam, e só o que é
  irreversível (push na `main`, migration sem a tripla). Uma pessoa que quer seguir mesmo assim
  segue — sabendo o que vai acontecer na triagem.
- **Mede na fonte, nunca copia número.** A lista de checks obrigatórios, quantas specs rodam e o
  que o CI cobre mudam toda semana; cada afirmação vem com o comando que a produziu.
- **Declara o que não mediu.** Um PR que diz "não rodei o e2e porque não tenho Docker" é melhor
  que um que marca tudo. O mantenedor prova o que ficou faltando; a régua pública é essa.
- **Sabota antes de dizer "testado".** Teste que não fica vermelho quando o conserto sai não
  guarda nada.

## Passo 0 — quem está contribuindo

```bash
bash .agents/skills/deskcomm-contribuir/scripts/quem-sou.sh
```

Se a resposta começar com `mantenedor`, este guia fica quieto — o mantenedor tem o próprio ritual
(triagem, gov-loop) e hooks próprios em `loop/hooks`. Só siga se a pessoa pedir por nome. Se
começar com `contribuidor`, siga. O script diz **por quê** (e-mail do git no `.mailmap`, conta do
`gh`, o `origin` ser fork).

## Passo 1 — a âncora: `origin/main`, nunca o disco

```bash
git fetch origin
MAIN=$(git rev-parse --short origin/main); echo "main=$MAIN"
B=$(git merge-base origin/main HEAD)
echo "atraso=$(git rev-list --count $B..origin/main) proprios=$(git rev-list --count $B..HEAD)"
comm -12 <(git diff --name-only $B origin/main | sort) <(git diff --name-only $B HEAD | sort)   # sobreposição
```

- **Branch nova** nasce de `origin/main` **deste** repositório, com nome (`fix/o-que-conserta`),
  nunca do `main` do fork: o `main` do fork carrega as personalizações da instalação da pessoa
  (marca, `.env`, config) e um PR aberto dali propõe tudo isso ao produto inteiro — foi medido, sete
  arquivos com a marca de um cliente mergeando sem conflito (PR #465).
- **Atraso > 0** → traga a `main` para dentro: `git merge --ff-only origin/main` se `proprios=0`,
  senão `git merge origin/main`. Nunca `reset --hard` nem `push --force`: apaga trabalho. Conflito
  se resolve lendo os dois lados (ver `references/pre-voo.md`, seção "conflito").
- **Sobreposição** (arquivos que a `main` também mudou) é onde nasce conflito: mescle cedo, não na
  hora do PR.
- O CI testa **a branch**, não o resultado do merge (`strict=false` na proteção da `main`): verde
  na branch atrasada não prova nada sobre o merge.

## Passo 2 — arme os hooks (uma vez por clone)

```bash
bash .agents/skills/deskcomm-contribuir/scripts/armar-hooks.sh
```

Três guardas, e só isso: `pre-commit` reprova migration nova sem apêndice no `baseline.sql` e sem
linha no `MANIFEST.md` no mesmo commit, e número (`NNNN`) ou timestamp já usado na `origin/main`
ou em branch local; `pre-push` reprova push na `main`; e os dois avisam (sem bloquear) quando o
commit está assinado como `root@…` ou sem e-mail — trabalho assinado assim não aparece no perfil
do GitHub de quem fez. O mantenedor roda hooks próprios (`loop/hooks`); o script recusa
sobrescrevê-los.

## Passo 3 — antes de codar

- Leia a doutrina do que vai tocar: a skill `deskcomm-doutrina` aponta as três regras que mais
  custam (multi-tenancy com RLS, tripla de migration, nenhuma feature nomeia provider) e manda abrir
  o `CLAUDE.md` da `origin/main` — não de um resumo.
- Issue: comente "pego esta" antes de codar; um mantenedor atribui. Sem resposta em 48 h, comece e
  diga no PR. Issue com pessoa atribuída não se duplica.
- Peça de sistema (lead, agente, follow-up, tela, worker, métrica)? Carregue a skill `sistema-vivo`
  — o Living System Checklist é item do Definition of Done.

## Passo 4 — o pré-voo, antes de abrir o PR

```bash
bash .agents/skills/deskcomm-contribuir/scripts/pre-voo.sh
```

Ele imprime, medido e com o comando ao lado, o que o mantenedor vai medir: atraso e sobreposição,
arquivos fora do produto no diff (marca, `.env`, config do fork), segredo no diff, `console.log`
novo (o lint só avisa), migration nova e a tripla, seção de versão escrita à mão no `CHANGELOG.md`
(bloqueador — o corte de release é automático), fragmento em `.changes/`, documento de autoridade
tocado, identidade dos commits. A leitura de cada item e o que fazer: `references/pre-voo.md`.

Depois, os gates que o CI roda sozinho — rode a suíte, não os gates que você lembra:

```bash
rm -f tsconfig*.tsbuildinfo; pnpm typecheck; echo exit=$?
pnpm lint; echo exit=$?
pnpm lint:channels; echo exit=$?
pnpm test:unit > /tmp/vt.log 2>&1; echo exit=$?; grep -aE "Test Files|Tests " /tmp/vt.log | tail -2
pnpm test:shell; echo exit=$?          # se tocou hostgator-setup-kit/, Dockerfile* ou compose
pnpm test:db; echo exit=$?             # se tocou schema/RLS/RBAC (precisa de Docker)
pnpm build; echo exit=$?
```

`test:unit` sem caminho: o script alcança o repositório inteiro (testes ao lado do código
inclusive); `vitest run tests/unit` é um verde menor. Não corte a saída com `tail` — o rodapé é a
autoridade e os nomes dos arquivos vermelhos são o único dado que permite reconciliar.

## Passo 5 — o teste que falta, e a sabotagem

Mudou comportamento? Então existe um teste que fica vermelho sem a sua mudança. Se não existe,
escreva. Depois **commite** e sabote: reverta só a linha do conserto (não o commit), preveja
quantos casos vão cair (e quais), rode, confira a contagem, restaure. "1 vermelho de N, o previsto"
vai no corpo do PR. Sabotar antes de commitar já custou trabalho perdido aqui mais de uma vez.

## Passo 6 — prova em tela (se tocou UI ou fluxo de usuário)

A doutrina do repo: `curl` não prova experiência; Playwright dirigindo o front, num banco fresco do
`baseline.sql`, com os envs opcionais **ausentes** (o estado real de uma instalação nova). A receita
local inteira, na ordem, com o que precisa instalado: `references/receita-e2e-local.md`. Sem
Docker ou sem tempo: mande o que conseguiu provar (unit + o que testou na mão, passo a passo) e
diga que a prova de tela ficou com o mantenedor — é o combinado público, não uma falha.

Spec nova entra em `SPECS_PARTE_N` do `.github/workflows/e2e.yml` (ou em `FORA_DO_CI` com o
motivo escrito); o teste `tests/unit/e2e-cobertura-completa.test.ts` reprova spec órfã.

## Passo 7 — o fragmento de release (não o CHANGELOG)

Mudou algo que quem opera uma VPS percebe? Escreva `.changes/<kebab>.md`:

```markdown
---
impacto: capacidade_nova        # nada_mudou | capacidade_nova | exige_acao
secao: adicionado               # adicionado | alterado | corrigido
titulo: O que muda, na voz de quem usa
---
Um parágrafo do ponto de vista do operador. Sem título, sem ⚠. Crédito: @seu-usuario.
```

`pnpm release:conferir` valida a forma. **Nunca** escreva `## [1.x.y]` no `CHANGELOG.md`: o corte
de release é automático e uma seção à mão já quase publicou uma versão pelo merge de um PR.
`exige_acao` só se o operador precisa fazer algo na VPS (variável nova obrigatória, por exemplo) —
e aí o instalador precisa perguntar por ela.

## Passo 8 — o PR

- **Título** no imperativo, do ponto de vista de quem usa (`fix(agenda): a consulta remarcada não
  some do dia`), commits em conventional commits, PT-BR aceito.
- **Corpo**: o que muda para quem usa; `Closes #N`; o que você mediu (comandos e saídas: o rodapé
  do `test:unit`, a sabotagem, a prova de tela); e um bloco **"O que NÃO medi"** — é o campo que
  separa medição de relato.
- **Identidade**: `git log --format='%an <%ae>' origin/main..HEAD | sort -u` — se aparecer
  `root@…` ou um e-mail que não é da sua conta, o trabalho não aparece no seu perfil. Conserte antes
  do push (`git config user.email`, `git commit --amend --reset-author` nos seus commits).

O que vai parecer erro depois de abrir — e não é — e como acompanhar o CI de verdade:
`references/depois-do-pr.md`. Os erros mais frequentes de quem contribui, com o número do PR onde
aconteceram: `references/erros-recorrentes.md`.

## O que você nunca faz

- `git reset --hard`, `push --force`, `rebase` de commits já publicados, `stash pop` em worktree
  que não é seu (o stash é compartilhado entre worktrees e importa trabalho alheio).
- Editar migration já aplicada — corrija com uma nova (forward-fix) e mais um apêndice.
- Tocar em worktree com árvore suja que não é sua.
- Trocar constante de marca, título de tela ou `.env` do produto para "a sua instalação" — isso vive
  no banco e na tela Configurações › Marca; no PR é vazamento.
- Fechar o próprio PR por achar que "fez ruído". Três pessoas fizeram isso sem ter errado nada.
