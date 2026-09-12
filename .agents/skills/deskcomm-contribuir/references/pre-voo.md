# O pré-voo, item a item — o que cada linha do `pre-voo.sh` significa e o que fazer

O script mede; esta página diz o que fazer com a medida. A ordem é a **frequência com que cada
item derruba PR** na triagem (medido nos relatos de triagem de agosto e setembro de 2026).

## A. O que o CI reprova sozinho (rode antes de abrir)

| gate | comando | o que costuma pegar |
|---|---|---|
| `verify` | `pnpm typecheck && pnpm lint && pnpm lint:channels && pnpm test:unit && pnpm test:shell` | tipo, lint, canal nomeado fora de `lib/channels/`, teste unitário, kit |
| `invariants` | `pnpm test:db` (Docker) | baseline em modo install **e** update, RLS, RBAC, funções expostas |
| `build-and-size` | `pnpm build` | import quebrado, página que não compila |
| `e2e` | ver `receita-e2e-local.md` | spec nova órfã, tela quebrada |
| `imagens-ok` | (só no CI) as três imagens Docker constroem e o app **sobe** | `Dockerfile*`, `docker-compose*`, kit |

A lista acima envelhece: confira com `gh api repos/melgarafael/DeskcommCRM/branches/main/protection --jq '.required_status_checks.contexts'`.
O `pre-voo.sh` faz isso quando o `gh` está logado.

## B. O que só a triagem vê (o `pre-voo.sh` mede)

### Branch atrasada e sobreposição
`⚠ branch N commit(s) atrás` → `git fetch origin && git merge origin/main` (ou `--ff-only` sem
commits próprios). O CI mede a branch, não o merge (`strict=false`): verde numa branch atrasada
não prova o que vai entrar. Sobreposição lista os arquivos onde o conflito vai nascer — mescle
agora, não na hora do PR.

**Conflito ao mesclar:** leia os dois lados. O delimitador que os dois compartilhavam é o ponto de
partida; a resposta certa costuma ser a **combinação**, não um lado. Depois `pnpm typecheck` e a
suíte — e commite a resolução: resolução de merge vive no disco até o commit.

### Arquivo novo fora das pastas do produto
Quase sempre é a instalação da pessoa vazando para o PR (`.env`, logo, compose editado, script
próprio). Se é do produto, mova para a pasta certa; se é seu, tire do commit (`git rm --cached`).

### Segredo no diff
Connection string com senha, chave `sk-ant-`/`sk-or-`, token `sbp_`, JWT, hash de senha. **Remova
e rotacione a chave** — histórico de git não esquece. Se já deu push, rotacione antes de qualquer
outra coisa.

### Marca ou config de instalação no diff
`DEFAULT_APP_NAME`, `APP_NAME=`, cor, URL do app, `.env`. A marca vive no banco
(`platform_branding`, `organizations.settings.branding`) e na tela Configurações › Marca; o `.env`
é semente. Editar a constante muda o produto para o mundo inteiro e a sua marca some no próximo
update. Receita: `docs/white-label.md`.

### `console.log` novo
O `pnpm lint` só avisa (`no-console: warn`), então passa verde; a triagem reprova. Use
`lib/logger.ts`. Ver todos os avisos só dos seus arquivos:
`pnpm exec eslint --max-warnings=0 $(git diff --name-only origin/main...HEAD -- '*.ts' '*.tsx')`.

### Migration
A tripla é indivisível: arquivo em `supabase/migrations/`, apêndice **idempotente** no
`supabase/baseline.sql` (`add column if not exists`, `create ... if not exists`,
`create or replace function`, `drop policy if exists` + `create policy`), linha no `MANIFEST.md`.
O kit self-host aplica **só o baseline** — migration sem apêndice não existe para quem instalou.

- `NNNN` e timestamp únicos contra `origin/main` (o hook confere; o script também). Ao renumerar,
  troque o timestamp junto: renumerar só o `NNNN` é o que fabrica colisão de timestamp.
- Tabela tenant-aware: `organization_id uuid not null references organizations(id) on delete cascade`,
  `enable row level security`, policy `tenant_isolation_<tabela>_all` via `fn_user_org_ids()`, e a
  tabela entra na lista `TABLES` de `tests/invariants/rls-isolation.test.ts` — "RLS ligada" tem
  gate genérico; "policy certa" não.
- Função nova em `public`: `revoke execute on function ... from public, anon;` e `grant` só a quem
  precisa. São **duas** origens de `EXECUTE`; revogar uma só deixa a função exposta como RPC.
- Constraint nova: corrija os dados existentes **antes**, no mesmo apêndice — senão o `update.sh`
  de um clone com dados sujos quebra.
- Coluna com dado pessoal: acrescente à cascata de anonimização
  (`grep -n fn_lgpd_cascade_redact_contact supabase/baseline.sql`).
- Nunca edite migration já aplicada: forward-fix nova + mais um apêndice.

### CHANGELOG à mão
`## [1.x.y]` escrito à mão é **bloqueador**: o corte de release é automático e a seção manual já
quase publicou uma versão pelo merge de um PR. Remova; escreva um fragmento em `.changes/`.

### Fragmento em `.changes/`
Só a **forma** tem gate (`pnpm release:conferir`); a presença é humana. Regra: o operador da VPS
percebe a mudança? Então tem fragmento. `exige_acao` só se ele precisa fazer algo (variável
obrigatória nova, por exemplo — e aí o `install.sh` precisa perguntar por ela).

### Env var nova
Nos dois arquivos (`.env.example` **e** `lib/env.ts`), com default que não quebre instalação
existente. `required(...)` numa variável nova é `exige_acao` no fragmento e pergunta no instalador.

### Documento de autoridade tocado
Releia **só** as frases de estado do trecho que você mudou ("é obrigatório", "ainda não", "N de
M", "hoje") e troque número por comando onde der: um número corrigido envelhece de novo; `rode
isto para saber` não. Não saia caçando o repo inteiro.

### Teste que falta
Mudou comportamento sem teste? Escreva o teste que fica vermelho sem a sua mudança. Depois
**commite e sabote**: reverta só a linha do conserto (nunca o commit), preveja quantos casos caem
e quais, rode, confira, restaure. Molde de teste: qualquer `tests/unit/*.test.ts` recente — cabeçalho
com o defeito que motivou, guarda de vacuidade, asserção no valor (não na presença).

### Spec e2e nova
Entra em `SPECS_PARTE_N` do `.github/workflows/e2e.yml`, ou em `FORA_DO_CI` **com o motivo escrito**
(`grep -ciE "waha|resend|nuvemshop|redis" <spec>` diz se ela depende de serviço que o CI não tem).

### Identidade dos commits
`root@vps…`, `@localhost`, e-mail vazio: o GitHub não associa a conta nenhuma. Antes do push:
`git config --global user.email "<e-mail da sua conta>"` e, nos seus commits,
`git rebase -i` **só se ainda não publicou** — se publicou, abra assim e peça no PR que o
`.mailmap` credite (precisa de prova: a API associando o e-mail à conta).

## C. O que você declara como NÃO MEDIDO

Tudo que exige o que você não tem: VPS real (`vps-fresh-onboarding`, o GET externo do kit), WAHA,
Resend, Docker. Escreva no corpo do PR: "não medi X porque Y". O mantenedor mede — é o combinado
público do template de PR.
