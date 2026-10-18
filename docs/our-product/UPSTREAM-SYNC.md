# Sincronizar com o upstream

`origin` é o fork. `upstream` é `https://github.com/melgarafael/DeskcommCRM.git`.

Conferir:

```bash
git remote -v
git fetch upstream --tags
```

O esperado:

- `origin` busca e envia para `github.com/vinicasagranda/DeskcommCRM`
- `upstream` busca e envia para `github.com/melgarafael/DeskcommCRM`

## Quando trazer melhorias do original

```bash
git fetch upstream --tags
git checkout develop
git pull origin develop
git checkout -b chore/sync-upstream-AAAA-MM-DD
git merge upstream/main
```

Resolver conflitos preservando `docs/our-product/` e os módulos nossos. Não apagar customização para "ficar igual ao upstream".

Depois do merge, na branch de sync:

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test:unit
pnpm test:shell
pnpm test:db
pnpm build
```

Abrir pull request dessa branch para `develop`. Atualização de upstream é mudança de produto e precisa de testes.

## O que não fazer

- Não rodar `git pull upstream main` numa branch que já carrega mudança de produção.
- Não fazer rebase destrutivo em branch já publicada para cliente.
- Não desenvolver direto em `main`.
- Não misturar o sync com feature nova no mesmo pull request.
