# Depois de abrir o PR

## O que vai parecer erro e não é

- **`Vercel` vermelho** — "Authorization required to deploy". A `main` faz deploy de produção e a
  Vercel recusa construir PR de fork. **Não entra no gate de merge.** Ignore.
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
4. Empurre o conserto na mesma branch — o PR atualiza sozinho. Não abra outro.

## O que acontece do lado de cá

A triagem mede na **prévia do merge** (a branch mesclada com a `main` de agora), roda o que o CI
não roda (tripla de migration, RLS de tabela nova, `console.log`, marca no diff, fragmento,
instalação fresca do kit), reproduz o defeito no SHA atual da `main`, escreve o teste que falta se
faltar, resolve conflito preservando os seus commits, e responde com um veredito que declara o
que **não** mediu. O merge e o corte da versão são do mantenedor; a versão só chega em quem instalou
quando a tag sai — merge na `main` não é entrega.

Crédito: os seus commits ficam com o seu nome. Se o PR foi reconstruído do lado de cá (acontece
quando o conflito é grande), o commit final cita você como coautor.
