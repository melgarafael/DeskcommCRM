# Checklist de deploy

Este projeto já teve **dois destinos de deploy com bancos diferentes**, e confundi-los custou um
incidente — é por isso que a distinção segue escrita aqui. Hoje há **um** procedimento vivo: a
seção A. A seção B é registro, e não tem caixa a marcar.

| Destino | O que é | Banco |
|---|---|---|
| **A. VPS self-host** | **o produto** — o que o cliente compra e o que a doutrina rege | Supabase cloud provisionado pelo `install.sh` |
| **B. Vercel** | ambiente do mantenedor, **congelado em 2026-09-17**: o projeto foi desvinculado do GitHub e nenhum push publica código novo lá | outro projeto Supabase |

> Este arquivo ficou sem revisão de 2026-04-28 a 2026-08-13 — escrito **dois meses antes de o
> Dockerfile existir**. Ele cobria só a Vercel e mandava aplicar `supabase/migrations/`, que
> não é o caminho de nenhum self-hoster (o kit aplica **só** `supabase/baseline.sql`). Quem o
> seguisse para um deploy de VPS não fazia nada do que o produto exige.

---

## A. VPS self-host — release de versão

O procedimento completo está em [`doctrine/packaging.md`](doctrine/packaging.md)
§Checklist de release. O resumo verificável:

**Antes de taguear**

- [ ] `CHANGELOG.md` tem a seção da versão, dizendo o que muda **para quem já instalou**
- [ ] Nenhuma variável nova é obrigatória sem default (`git diff` em `.env.example` e `lib/env.ts`)
- [ ] Mudança de schema saiu como **tripla**: `supabase/migrations/` + apêndice idempotente no
      `supabase/baseline.sql` + linha no `MANIFEST.md`. **O kit aplica só o baseline** — o que
      não chegar lá não chega a ninguém

      Schema antes de código, e não o contrário: em 2026-08-04 o ambiente do mantenedor
      subiu código à frente do banco e o inbox devolveu 500 (`42703`). O build passa — quem
      descobre é o usuário, na tela.
- [ ] `pnpm test:db` verde localmente (aplica o baseline em install **e** update num Postgres limpo)
- [ ] `pnpm test:shell` verde (é o único gate que exercita o kit)
- [ ] O número da versão nunca foi publicado: `git tag --list 'vX.Y.Z'` vazio **e**
      `ghcr_status deskcommcrm X.Y.Z` → **404**

      Use a função `ghcr_status` de [`doctrine/packaging.md`](doctrine/packaging.md)
      §Checklist de release. **Não use `curl` cru no GHCR**: ele responde `401`, e um corpo de
      erro não contém a versão procurada — o que faria este item aprovar qualquer coisa,
      inclusive uma versão já publicada.

**Publicar**

- [ ] `git tag vX.Y.Z && git push origin vX.Y.Z` a partir de um commit da `main`
- [ ] `gh run list --workflow=publish-image.yml --limit 3` → verde
- [ ] As **três** imagens existem na versão: `deskcommcrm`, `deskcomm-worker`, `deskcomm-scheduler`
- [ ] `gh release create vX.Y.Z` com as notas do CHANGELOG
- [ ] **Depois da release**, `stable` e `X.Y.Z` são o mesmo digest nas três imagens.
      Nesta ordem, e não antes: na v1.3.0 a conferência rodou antes do
      `gh release create`, passou, e o próprio `release` republicou a versão em
      cima — verde às 19:53, divergente às 19:58.

**Provar (o item que exige VPS, e não é opcional)**

- [ ] Ensaio de atualização numa instalação **real e não-fresca**: `update.sh` a partir da
      versão anterior, sem editar arquivo nenhum na mão
- [ ] `GET /api/v1/health` responde `version: "X.Y.Z"` depois do update
- [ ] O domínio responde **307** (redireciona para o login), não 404 — 404 com contêiner
      `healthy` significa labels de roteamento perdidas (ver `runbooks/deploy.md`)
- [ ] Smoke manual pela tela: login com MFA, criar lead, receber e enviar mensagem no WhatsApp,
      ver a entrada no audit log, abrir o kanban

**Rollback**

- [ ] A versão anterior está anotada (é uma linha do `.env`: `APP_IMAGE`)
- [ ] Existe backup do banco anterior à atualização (`backup.sh` roda sozinho no `update.sh`)
- [ ] Migração é forward-only com caminho de hot-fix documentado

---

## B. Vercel — ambiente do mantenedor, congelado em 2026-09-17

> O projeto do CRM na Vercel foi desvinculado do GitHub: push e PR neste repositório não geram
> mais deploy, e o que estava no ar não recebe mais código. **Nada abaixo é acionável**: fica
> como registro do que aquele ambiente exigia enquanto recebia código. O destino vivo é a
> seção A.

- Envs do projeto na Vercel espelham o `.env.local`
- `SENTRY_DSN` definido; `SENTRY_AUTH_TOKEN` configurado para upload de sourcemap
- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
- `WAHA_*` (URL, api key em plaintext no cliente, hash SHA512 no servidor)
- `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`
- `INTERNAL_SECRET` (rotacionado ao menos uma vez)
- Migrations aplicadas naquele banco, porque o deploy de lá nunca aplicou nenhuma — **não
  aplique**: o código que as leria não avança mais. A lição que sobrou disso está na seção A,
  no item da tripla de schema, e vale igual na VPS
- RLS verificada nas tabelas tenant-aware (smoke cross-tenant)
- Evento de teste do Sentry capturado no ambiente de produção
- `pnpm typecheck`, `pnpm lint`, `pnpm test:unit` limpos no commit da release
- LCP/CLS/INP dentro do orçamento (Vercel Analytics RUM)

---

Referência: [`stories/epics/EPIC-12-hardening.md`](stories/epics/EPIC-12-hardening.md) §S-12.10.
