# Depois de abrir o PR

## O que vai parecer erro e não é

- **Workflows parados "esperando aprovação"** — política do GitHub no primeiro PR de quem nunca
  contribuiu. Um mantenedor libera; do segundo PR em diante roda sozinho. Se demorar mais que um
  dia útil, comente no PR.
- **Um comentário automático de acolhida** chega em minutos e não avalia nada — é só para você
  saber que o PR foi visto e o que esperar.
- **Nunca feche o próprio PR** por achar que fez ruído ou abriu no lugar errado. PR de fork para
  cá é exatamente como se contribui.

## Ver o estado real do CI (em vez de adivinhar)

```bash
SHA=$(git rev-parse HEAD)
gh api "repos/melgarafael/DeskcommCRM/actions/runs?head_sha=$SHA" \
  --jq '.workflow_runs[] | "\(.name): \(.status) / \(.conclusion // "-")"'
gh pr checks <número>          # o resumo por check
```

Atenção: `conclusion` vem **vazio** (não `null`) enquanto o run não termina — leia `status`.

## Se um check ficou vermelho

1. Abra o log do **passo** que falhou, não o resumo. O nome do arquivo vermelho é o único dado que
   permite reconciliar.
2. É seu? Reproduza local isolado: `pnpm test:unit <arquivo> > /tmp/s.log 2>&1; echo exit=$?` e
   leia o rodapé (`Test Files … Tests …`).
3. Não é seu? `Test timed out` em dezenas de arquivos = saturação; `address already in use` /
   `failed to start containers` = runner. Diga isso no PR com o trecho do log; não "conserte" o
   que não quebrou.
4. Traga a branch antes (`git pull --no-rebase`): com "Allow edits by maintainers" ligado, a triagem
   pode ter empurrado nela um conserto ou o merge da `main`. Depois empurre o conserto na mesma
   branch — o PR atualiza sozinho. Não abra outro, e nunca use `--force`: ele apagaria o que foi
   empurrado do lado de cá.

## O que acontece do lado de cá

A triagem mede na **prévia do merge** (a branch mesclada com a `main` de agora), roda o que o CI
não roda (tripla de migration, RLS de tabela nova, `console.log`, marca no diff, fragmento,
instalação fresca do kit), reproduz o defeito no SHA atual da `main`, escreve o teste que falta se
faltar, resolve conflito preservando os seus commits, e responde com um veredito que declara o
que **não** mediu. O merge e o corte da versão são do mantenedor; a versão só chega em quem instalou
quando a tag sai — merge na `main` não é entrega.

Onde o conserto do lado de cá entra: se o PR permite edição por mantenedores, ajustes e a `main`
trazida para dentro podem ir na **sua** branch — sempre commit novo ou merge da `main`, nunca
`--force` nem rebase, com aviso no PR antes. Vai numa branch nossa quando o PR não permite edição,
ou quando o trabalho precisa separar escopo: tirar uma parte para outro PR, reimplementar, extrair.

Crédito: os seus commits ficam com o seu nome. Quando o seu trabalho precisa ser levado de outro
jeito — uma parte tirada para outro PR, reimplementado, ou reconstruído porque o PR trazia algo que
não pode entrar —, o commit que leva o seu trabalho sai com **você como autor** (`--author`, com o
nome e o e-mail que você usa nos seus próprios commits), inclusive quando ele junta o seu trabalho
com um ajuste nosso.

Se só parte do PR entrou, ele fica aberto enquanto o que sobrou tiver destino, escrito no próprio
PR (uma decisão pendente, um acompanhamento, uma resposta sua, ou o destino de virar extensão). Se o resto foi descartado, o PR
fecha dizendo o que entrou, com o link, e por que o resto não entra.
