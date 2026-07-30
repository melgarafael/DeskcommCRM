# Aula — Demo de Pull Request

> **Documento de demonstração.** Criado apenas para mostrar, ao vivo numa aula, o fluxo
> completo de contribuição no DeskcommCRM: branch → commit → push → PR → review → merge.
> Não descreve funcionalidade do produto e pode ser removido sem impacto.

---

## Por que este arquivo existe

Numa aula, explicar Git no slide não cola. O que fixa é ver o ciclo inteiro acontecer:
uma mudança pequena e inofensiva percorrendo o mesmo caminho que uma feature de verdade
percorreria neste repositório — inclusive passando pelos mesmos checks de CI.

Este documento **é** a mudança. O conteúdo dele importa menos do que o caminho que ele fez.

---

## O ciclo, passo a passo

### 1. Atualizar a `main` antes de qualquer coisa

`main` é produção e é a fonte da verdade. Trabalho iniciado numa branch atrasada gera
conflito e retrabalho.

```bash
git fetch origin
git merge --ff-only origin/main
```

### 2. Criar a branch a partir da `main` atualizada

Nome de branch com prefixo que diz a natureza da mudança (`docs/`, `fix/`, `feat/`, `chore/`):

```bash
git checkout -b docs/aula-demo-pr
```

### 3. Fazer a mudança

Aqui, criar este arquivo. Numa task real, seria o código + teste + migration, conforme o caso.

### 4. Commit com mensagem que explica o *porquê*

A mensagem descreve o efeito da mudança, não o arquivo que foi tocado:

```bash
git add docs/aula-demo-pull-request.md
git commit -m "docs: material de aula demonstrando o fluxo de pull request"
```

### 5. Push e abertura do PR

```bash
git push -u origin docs/aula-demo-pr
gh pr create --base main --title "..." --body "..."
```

### 6. CI roda sozinho

O `.github/workflows/ci.yml` tem dois jobs em paralelo, ambos obrigatórios antes do merge:

| Job | O que roda |
|---|---|
| `verify` | `typecheck` + `lint` + `test:unit` |
| `invariants` | `test:db` — Postgres efêmero, aplica `supabase/baseline.sql` em modo install e update, roda os invariantes (incluindo isolamento RLS entre duas organizações) |

Um PR de documentação passa nos dois sem esforço — que é exatamente o motivo de ele
servir bem como demonstração: o foco fica no *fluxo*, não em depurar teste quebrado ao vivo.

### 7. Review e merge

O PR é o ponto de conversa. Quem revisa comenta na linha; quem propôs responde ou ajusta
e dá push na mesma branch — o PR atualiza sozinho. Merge só depois do CI verde e do aprovado.

---

## O que muda quando o PR é de código de verdade

Este demo pula etapas que uma mudança real **não** pode pular. Vale citar em aula, porque é
onde mora a diferença entre "commitei" e "entreguei":

- **Mexeu em schema?** Sai migration versionada em `supabase/migrations/` **e** apêndice
  idempotente no `supabase/baseline.sql` — é o baseline que o self-hoster aplica na VPS.
  Migration que só existe em `migrations/` não chega em quem instalou o produto.
- **Mexeu em UI ou fluxo de usuário?** Prova pela tela, dirigindo o browser, em ambiente
  fresco estilo VPS. `curl` valida backend, não valida experiência.
- **Tabela tenant-aware?** RLS testada. Isolamento entre tenants não é presumido, é exercitado.
- **Rota pública?** Rate limit e Zod no input externo.

A lista completa está no `CLAUDE.md`, na seção *Definition of Done*.

---

## Resumo em uma linha

Branch a partir da `main` atualizada → mudança pequena e coerente → commit que explica o
porquê → push → PR → CI verde → review → merge.
