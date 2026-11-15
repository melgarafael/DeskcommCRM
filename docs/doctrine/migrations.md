---
type: doctrine
project: DeskcommCRM
---

# Migrations e banco

> Extraído **literalmente** do `CLAUDE.md` (seção «Migrations & Banco — DOUTRINA (projeto open-source)») para o arquivo de entrada caber no
> limite de 40k caracteres do Claude Code. O `CLAUDE.md` guarda a regra dura e aponta para cá;
> aqui mora o texto completo, com os motivos e as medições. Em divergência, vale **este** texto (é o original, copiado literalmente), e o resumo do `CLAUDE.md` é que se corrige.

**Este projeto é open-source. Toda mudança de schema DEVE sair como migration versionada** — quem clonou uma versão antiga do banco precisa conseguir atualizar aplicando as migrations em ordem. **Nunca** aplique `ALTER`/`CREATE` solto no banco sem o arquivo correspondente. Isto é critério de aceite de TODA sessão, não opcional.

Processo padrão (siga sempre):

1. **Arquivo versionado** em `supabase/migrations/` com o padrão do repo: `<timestamp>_<NNNN>_<slug>.sql` (ex.: `20260706210000_0027_whatsapp_conversation_unification.sql`). `NNNN` é o próximo número sequencial — e **não** é o do último arquivo da listagem:

   ```bash
   # A POPULAÇÃO da pergunta: main do PRODUTO (o remoto que aponta para
   # melgarafael/DeskcommCRM, com qualquer nome) + TODO PR ABERTO, inclusive de
   # fork. O `ls` abaixo mede o DISCO, que responde uma pergunta menor.
   pnpm checar:colisao-de-migration   # declara o que mediu e o que não mediu
   ```

   Se a leitura for manual, três coisas são obrigatórias: um `git fetch` antes (a árvore em dia
   não é a main atual), `git ls-tree` da main do PRODUTO e não `ls` do disco, e o `NNNN` tirado
   com a **âncora do nome canônico** aplicada ao nome **sem a pasta** —
   `sed 's#.*/##' | sed -nE 's#^[0-9]{14}_([0-9]{4})_.*#\1#p'`. O
   `ls | grep -oE '_[0-9]{4}_'` que estava aqui pegava um `_NNNN_` do SLUG (com
   `…_0326_relatorio_2024_anual.sql` o teto virava 2024) e media a árvore de
   trabalho, onde a 0336 já podia estar reservada por um PR aberto (#1273).

   O `checar` mede o arquivo que você **já** acrescentou: sem migration nova, ele responde
   `OK — nenhuma migration acrescentada` e não dá número. Crie o arquivo com um número provisório
   e rode; ou, para alocar antes, use a enumeração do que está em voo em `triagem/TRIAGEM.md`
   (modo de falha 37). O teto é a main **mais** tudo em voo, em NNNN **e** em timestamp.

   O nome do arquivo começa pelo **timestamp**, e timestamp e `NNNN` podem discordar: em
   09/09/2026 o `ls | tail -1` devolvia o `_0230_` (timestamp de 07/09) enquanto o maior `NNNN`
   era `_0231_` (timestamp de 05/09). Um contribuidor externo seguiu a instrução antiga ao pé da
   letra, escolheu `0231`, e o `manifest-x-migrations` reprovou o PR dele por colisão — a
   instrução é que estava errada, não ele. Ordene pelo número, nunca pela listagem.

   **E o número livre hoje pode estar tomado quando o seu PR entrar.** A colisão só aparece
   quando o SEGUNDO PR de schema é mesclado — medido em 19/09/2026: **11 PRs abertos colidiam
   com a `main` com os cinco checks obrigatórios verdes**. O `verify` **já executa** a guarda
   (`pnpm checar:colisao-de-migration`, o alias de `scripts/checar-colisao-de-migration.sh` —
   procurar pelo nome do arquivo no `ci.yml` devolve zero e mente), e mesmo assim os 12 passaram:
   cada um mediu a `main` do dia em que rodou — o `verify` do #965 terminou em 16/09 e segue verde.
   Por isso há duas camadas a mais: o CI reprova quando **um número deste PR foi tomado** por
   migration que entrou na base depois da prévia (colisão, nunca atraso — PR atrasado e sem colisão
   segue verde), e fora de `pull_request` ele varre a árvore inteira — nenhum `NNNN` nem timestamp pode aparecer duas vezes na `main`. Antes de escolher o número quando houver outros PRs de schema em voo, peça-o
   a quem estiver alocando na rodada: **não há reserva, quem mescla primeiro fica com o número**.
   Para ver o que está tomado agora, incluindo o que ainda não foi mesclado:

   ```bash
   pnpm checar:colisao-de-migration          # mede o SEU PR contra origin/main
   ```
2. **Idempotente sempre que possível**: `add column if not exists`, `create ... if not exists`, `create or replace function`. Uma migration deve poder ser re-aplicada sem quebrar nem duplicar efeito.
3. **Portável em `psql` puro** (clones podem não usar o MCP/CLI Supabase): **sem** `create temporary table ... on commit drop` fora de transação explícita; **sem** `BEGIN`/`COMMIT` explícito (o runner já envolve em transação, como as demais migrations). Prefira CTEs, subqueries de janela e colunas-mapa (ex.: `is_merged_into`) a temp tables.
4. **Data migrations genéricas**: se a migration corrige/deduplica dados, escreva pensando em QUALQUER banco de clone (não hardcode IDs do seu tenant). Repointe FKs conferindo o catálogo (`information_schema` FK map) para não perder histórico.
5. **Descreva no próprio arquivo — NÃO no MANIFEST**: o `.sql` leva uma linha `-- manifest: <o QUÊ e o PORQUÊ, numa linha>` no cabeçalho. Versão e nome saem do nome do arquivo. O `supabase/migrations/MANIFEST.md` é **histórico** e não recebe linha nova: todo PR com migration acrescentava uma linha no FIM dele, o `merge=union` do `.gitattributes` só vale no git local, e o GitHub ignora driver de merge — cada migration que entrava deixava todos os outros PRs com migration CONFLICTING (medido em 02/10/2026: #2009, #2049, #2078, #2080, #2091, #2137, várias vezes cada). Um arquivo por migration não tem com quem conflitar. O registro inteiro é o MANIFEST.md **mais** `grep -m1 '^-- manifest:' supabase/migrations/*.sql`. Quem cobra: `tests/unit/manifest-x-migrations.test.ts` (sem descrição, número ou carimbo repetido, ou descrita nos dois lugares, reprova) e o pre-commit `check-migration-triple.sh`.
6. **Reflita no `supabase/baseline.sql` (OBRIGATÓRIO — é o que o kit self-host aplica).** O baseline é um dump `--schema-only` + um **apêndice idempotente** no fim do arquivo (blocos rotulados `-- ---- <coisa> (migration NNNN) ----`). O kit HostGator aplica **só o baseline.sql**, tanto no `install.sh` (banco novo, `ON_ERROR_STOP=1`) quanto no `update.sh` (re-aplica em banco existente, **sem** `ON_ERROR_STOP`). Então toda mudança de schema pós-snapshot DEVE ser acrescentada ao apêndice, **idempotente e auto-curativa**: `add column if not exists`, `create ... if not exists`, `create or replace function`, e — se a mudança adiciona constraint — **deduplicar/corrigir os dados ANTES** de criar a constraint (senão o `update.sh` de um clone bugado quebra). Sem isto, clones não recebem a mudança (ou quebram ao atualizar). Migração adicionada só em `migrations/` mas não no baseline **não chega aos self-hosters**.
7. **Aplique e prove**: aplique via `mcp__plugin_supabase_supabase__apply_migration` (ou `supabase db push`), capture o estado ANTES/DEPOIS e prove invariantes (ex.: contagem de linhas que não pode mudar). Se mexeu em contrato, regenere `lib/database.types.ts`. Para mudanças de schema no kit, valide o baseline num Postgres descartável (`pgvector/pgvector:pg15` + extensões) aplicando `install` (fresh, `ON_ERROR_STOP=1`) e `update` (re-aplicar, sem a flag) — ambos têm que passar.
8. **Backfill de dados quebrados existentes**: constraint nova falha se os dados atuais a violam — a migration (e o apêndice do baseline) deve deduplicar/corrigir ANTES de criar a constraint.
9. **Função nova em `public` nasce EXPOSTA — revogue as DUAS origens.** Toda `create function` no schema `public` termina com:

   ```sql
   revoke execute on function public.fn_x(...) from public, anon;
   grant  execute on function public.fn_x(...) to <só quem precisa>;
   ```

   São duas origens distintas de `EXECUTE`, e tratar só uma deixa a função exposta com o gate verde: **(A)** o grant direto a `anon` do `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON FUNCTIONS TO anon` do baseline, que vale para toda função criada depois dele — isto é, para todo apêndice novo — e que `revoke from public` **não** remove; **(B)** o grant a `PUBLIC` que o Postgres dá a qualquer função ao criá-la, que `revoke from anon` **não** remove. Sem os dois, o PostgREST expõe a função como RPC alcançável pela anon key, que vai para o browser. Vigiado por `tests/invariants/hardening-definer-varredura.test.ts`, que varre todas as `security definer` de `public` (issue #128 — a versão anterior checava uma lista fixa de 6, e 8 de 25 estavam expostas).

10. **Ler o baseline com `grep` no arquivo inteiro mede a definição ERRADA.** O
    `baseline.sql` é dump + apêndice, então a mesma função aparece **várias
    vezes** — e quem vale é a **última**, porque o arquivo é aplicado inteiro e
    em ordem. Medido em 2026-09-20: `fn_meet_action` tinha **quatro**
    definições; a primeira (o corpo do dump) ainda trazia `errcode='40001'` nas
    três recusas permanentes, e a última — a que o banco instala — trazia
    `PT409`. Uma sonda de `grep`/`awk` ancorada na primeira ocorrência afirmou
    sobre o produto o oposto do que o produto faz. O mesmo vale para
    `fn_lgpd_cascade_redact_contact`, que tem oito.

    **As duas formas certas**, e a primeira decide:

    ```bash
    # (a) PERGUNTE AO BANCO, depois de aplicar — é o que o cliente terá
    pnpm test:db tests/invariants/<um caso que consulte>  # ou, num psql já com o baseline aplicado:
    psql "$URL" -Atc "select pg_get_functiondef(p.oid) from pg_proc p
      join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname='fn_x'"
    ```

    ```bash
    # (b) ANCORE NA ÚLTIMA definição, quando só o arquivo estiver à mão
    python3 -c "
    s=open('supabase/baseline.sql').read()
    i=s.rfind('create or replace function public.fn_x')   # rfind, nunca find
    print(s[i:s.index('\$\$;', i)+3])"
    ```

    Contar ocorrências no arquivo inteiro responde *"o arquivo menciona"*, nunca
    *"o banco faz"*. As duas perguntas divergem sempre que há apêndice — e
    apêndice é o mecanismo padrão desta casa.

**Resumo do fluxo de uma mudança de schema:** arquivo em `migrations/` (fonte da verdade p/ Supabase CLI) **+** apêndice idempotente no `baseline.sql` (p/ o kit self-host) **+** linha `-- manifest:` no cabeçalho do `.sql`. Os dois artefatos de schema andam juntos. Nunca edite migrations já aplicadas — corrija com uma "forward-fix" nova (e mais um apêndice no baseline).

---
