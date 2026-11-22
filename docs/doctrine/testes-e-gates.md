---
type: doctrine
project: DeskcommCRM
---

# Testes e gates

> Extraído **literalmente** do `CLAUDE.md` (seção «Testes») para o arquivo de entrada caber no
> limite de 40k caracteres do Claude Code. O `CLAUDE.md` guarda a regra dura e aponta para cá;
> aqui mora o texto completo, com os motivos e as medições. Em divergência, vale **este** texto (é o original, copiado literalmente), e o resumo do `CLAUDE.md` é que se corrige.

```bash
pnpm typecheck   # tsc --noEmit -p tsconfig.typecheck.json (inclui tests/)
pnpm lint        # eslint next/core-web-vitals
pnpm test:unit   # Vitest (NÃO inclui tests/invariants/** — ver abaixo)
pnpm test:db     # Postgres efêmero + baseline install/update + 364 invariantes
pnpm test:e2e    # Playwright (requer dev server)
pnpm gov:verify  # typecheck + lint + lint:channels + lint:role-rank + test:unit
pnpm cercas      # só as cercas estruturais (projeto vitest "cercas")
pnpm test:journeys  # Playwright com tests/journeys/playwright.config.ts
pnpm format:check   # prettier
```

Um teste só:

```bash
pnpm vitest run lib/foo/bar.test.ts         # um arquivo unit
pnpm vitest run -t "nome do caso"           # um caso pelo nome
pnpm test:db tests/invariants/x.test.ts     # um invariante (o script repassa os args ao vitest)
pnpm playwright test tests/e2e/x.spec.ts    # uma spec e2e
```

**⚠️ `test:unit` NÃO é `tests/unit/`.** O script é `vitest run` **sem caminho**, e ele alcança
o repositório inteiro — os testes co-localizados em `lib/`, `app/`, `components/` e `hooks/`
inclusive. Medido em 2026-08-28: `vitest run` alcança **566 arquivos**; `tests/unit/` tem **388**.
Os 178 de fora são 133 em `lib/`, 37 em `app/`, 3 em `components/`, 1 em `hooks/` e 4 em `tests/`.

Quem lê o nome do script e roda `vitest run tests/unit` obtém um **verde menor e mais fácil** sem
perceber que obteve — e foi o que aconteceu num PR: a suíte foi reportada como verde, e o que
estava verde era o recorte. O comando que vale é `pnpm test:unit`, sem caminho.

Duas armadilhas irmãs, as duas pagas no mesmo dia:

- **Gate escolhido não é suíte.** `typecheck`, `lint`, `lint:channels` e os arquivos de cerca
  podem estar todos verdes enquanto a suíte tem 17 falhas — nenhum deles toca o arquivo que
  quebrou. Antes de abrir PR, rode a suíte, não os gates que você lembra.
- **Não corte a saída.** `| tail -8` guarda o rodapé e joga fora os NOMES dos arquivos que
  falharam, que é o único dado que permite reconciliar depois. Redirecione e filtre:

  ```bash
  pnpm test:unit > /tmp/vt.log 2>&1; echo "exit=$?"
  grep -aE "Test Files|Tests " /tmp/vt.log | tail -2                   # ← a AUTORIDADE
  grep -aE "^ *FAIL " /tmp/vt.log | sed 's/ > .*//' | sort | uniq -c   # arquivos + contagem
  ```

  **O rodapé é a autoridade; o `grep FAIL` é conveniência — e ele pode devolver
  vazio COM falhas.** Medido: em execução sem TTY o reporter padrão às vezes
  imprime só o resumo, e os nomes dos arquivos vermelhos nunca chegam a ser
  escritos. Uma rodada com `3 failed` produziu um log de 629 bytes onde `FAIL`
  não aparece em posição nenhuma — e o vazio dessa sonda lê exatamente como
  "nenhuma falha".

  Por isso **compare as duas saídas antes de concluir** — e compare a linha
  certa: `Test Files N failed` conta ARQUIVOS, `Tests N failed` conta CASOS, e o
  `uniq -c` do `grep` soma CASOS. O controle é contra a segunda linha:

  ```bash
  r=$(grep -aE "^ *Tests " /tmp/vt.log | tail -1 | grep -oE "[0-9]+ failed" | head -1)
  g=$(grep -acE "^ *FAIL " /tmp/vt.log)
  echo "rodapé: ${r:-0 failed} | grep contou: $g"   # têm de bater
  ```

  Se não baterem, antes de diagnosticar *"sonda cega"* e re-rodar a suíte inteira
  com `--reporter=verbose`, confira se a divergência é explicada por **falha de
  coleta ou de hook** (que o Vitest imprime na seção dedicada `Failed Suites`,
  somando às linhas `FAIL` sem entrar no rodapé de casos `Tests ... failed`):

  ```bash
  grep -aoE "Failed Suites [0-9]+" /tmp/vt.log | grep -oE "[0-9]+"   # > 0 ⇒ arquivo/suíte falhou SEM ser por caso
  grep -aqE "^ *Test Files" /tmp/vt.log && echo "log inteiro" || echo "log truncado — o zero não vale"
  ```

  O segundo comando é necessário: a seção só aparece quando existe falha de
  suíte, então log truncado ou comando que não rodou também devolvem zero.
  Se `Failed Suites` for > 0 (e o log estiver inteiro), a conta fecha: `Tests failed` + `Failed Suites` = `grep FAIL`.
  A causa (falha de sintaxe na coleta ou `Hook timed out` em `beforeAll`) está no próprio log.
  Reserve o diagnóstico de *"sonda cega"* (trocar por `--reporter=verbose`) para quando
  as seções também não explicarem a divergência.

  **E as duas podem bater em zero com a suíte reprovada.** O Vitest sai com
  `exit=1` quando há **erro não tratado** durante a execução, mesmo com todos os
  testes passando — e esse erro aparece numa TERCEIRA linha do rodapé, que
  nenhuma das duas sondas acima lê:

  ```
   Test Files  866 passed (866)
        Tests  8904 passed | 1 expected fail (8905)
       Errors  1 error          ← só o exit code viu isto
  ```

  Medido em 2026-09-15: `EnvironmentTeardownError: [vitest-worker]: Closing rpc
  while "onUserConsoleLog" was pending`, sob carga. Rodapé `0 failed`, `grep FAIL`
  vazio, exit 1. **O exit code é a autoridade; o rodapé e o grep são explicação
  dele.** Quando o exit diverge dos dois, leia a linha `Errors` antes de concluir
  qualquer coisa:

  ```bash
  grep -aE "^ *Errors " /tmp/vt.log      # vazio é o esperado
  ``` (Comparar contra `Test Files` dá
  divergência falsa: `2 failed` de arquivos contra `7` de casos parece defeito
  da sonda e é só régua trocada.)

**Vermelho local que NÃO é seu:** `lib/ai/dispatcher/rate-limit.test.ts` falha em 5 casos, com
15s de timeout cada, quando o `.env.local` tem `UPSTASH_REDIS_REST_URL`/`TOKEN` e o Redis para o
qual eles apontam **não está de pé** (neste repo é o `serverless-redis-http` local, não a nuvem).
O `tests/setup/vitest.setup.ts` carrega o `.env.local` para dentro do `process.env`, e o módulo
só usa o contador em memória quando essas variáveis estão **ausentes**. Provado nos dois sentidos.
No CI não há `UPSTASH` nenhum, então lá o caminho é o contador em memória e o arquivo passa.

**Os invariantes não estão no `test:unit`.** `vitest.config.ts` exclui `tests/invariants/**` de propósito: essa suíte precisa de um Postgres real e roda via `vitest.db.config.ts`, orquestrada por `scripts/test-db.sh`. Rodar só `pnpm test:unit` e concluir "está tudo verde" é um falso verde — o isolamento RLS não foi exercitado.

Checks **obrigatórios** na branch protection da `main` (verificado na configuração, não só no papel):

- **`verify`** (`ci.yml`) — typecheck + lint + test:unit.
- **`invariants`** (`ci.yml`) — **job de fachada**: ele não roda suíte nenhuma; reprova quando a matriz `invariants-majors` não fecha em `success`. Quem roda é a matriz, uma perna por major do Postgres que o produto diz suportar, e cada perna faz duas passadas: `pnpm test:db` (baseline em modo install com `ON_ERROR_STOP=1` e update, mais os invariantes, incluindo o isolamento RLS entre 2 organizações) e `pnpm test:db:update` (atualização de um banco COM dados). Para saber quais majors hoje, pergunte ao arquivo em vez de a esta linha: `awk '/^  invariants-majors:/,/^  [a-z-]+:/' .github/workflows/ci.yml | grep -A6 'matrix:'`.
- **`build-and-size`** (`perf.yml`) — `pnpm build` em Node 22.
- **`e2e`** (`e2e.yml`) — sobe Supabase local, aplica o `baseline.sql` e roda **todas as specs Playwright menos as que `FORA_DO_CI` declara** — **em PR que alcança algo que ele mede**. PR só de documentação, teste de outra suíte, fragmento ou workflow alheio pula as partes (regra em `scripts/pr-alcanca-o-e2e.sh`, na dúvida roda), e ali o `e2e` verde **não prova tela nenhuma**. O número saiu daqui de propósito: ele apodreceu **cinco** vezes (a quinta em 2026-08-24, quando `inbox-quem-manda.spec.ts` entrou), e a condição que o PR #242 pôs para parar de recontar já tinha vencido na quarta. Quem precisa do número roda o comando abaixo — comando não envelhece. Quais ficam de fora, e por quê, é o que a própria variável diz — **não confie nesta linha, leia-a**:

  ```bash
  git show origin/main:.github/workflows/e2e.yml | \
    python3 -c "import sys,re; y=sys.stdin.read(); print(sorted({s for _,c in re.findall(r'(FORA_DO_CI):\s*>-\n((?:[ ]{8,}.*\n)+)',y) for s in re.findall(r'[a-z0-9-]+\.spec\.ts',c)}))"
  ```

  **Esta frase já envelheceu TRÊS vezes, e é o parágrafo que denuncia afirmações que envelhecem.** Ela dizia "a **única** de fora é `vps-fresh-onboarding`" quando a variável já listava duas (2026-09-04, `inbox-tempo-real`); depois seguiu dizendo que a jornada de instalação fresca estava sem gate — e em 2026-09-19 o **#983** (@webtecnica) pôs `vps-fresh-onboarding.spec.ts` para rodar no CI, com WAHA e Redis de verdade, então a frase virou o contrário do estado.

  Por isso ela sai e não volta: a pergunta "a jornada de instalação fresca tem gate?" se responde por **comando**, com o de cima (o que `FORA_DO_CI` declara) e com este, que diz quem o CI **invoca**:

  ```bash
  git show origin/main:.github/workflows/e2e.yml | python3 -c "import sys,re; y=sys.stdin.read(); print('vps-fresh-onboarding no CI:', 'vps-fresh-onboarding.spec.ts' in {s for _,c in re.findall(r'(SPECS_PARTE_\d+):\s*>-\n((?:[ ]{8,}.*\n)+)',y) for s in re.findall(r'[a-z0-9-]+\.spec\.ts',c)})"
  ```

  As duas saídas se fecham uma contra a outra porque `tests/unit/e2e-cobertura-completa.test.ts` reprova spec que não esteja nem numa `SPECS_PARTE_*` nem na `FORA_DO_CI`: ausência da primeira saída é presença na segunda, e nenhuma spec cai no vão entre as duas.

  O que **não** envelhece e é o que importa: `vps-fresh-onboarding` é a **P0** da doutrina de QA Visual porque a instalação fresca é o produto que se vende. Ter gate não dispensa a prova pela tela (DoD 12) — gate prova que não regrediu, não que a experiência ficou boa. E a ressalva do começo do item continua de pé: em PR que pula as partes, o verde não prova tela nenhuma, a da instalação fresca inclusive.

  **Não confie em `grep` no arquivo inteiro.** `grep -oE '[a-z0-9-]+\.spec\.ts' .github/workflows/e2e.yml | sort -u | wc -l` conta quem é CITADO, não quem é INVOCADO: a `FORA_DO_CI` é uma variável YAML como as outras e entra na conta. (Até 2026-08-14 este parágrafo culpava "menções em comentários", e isso é falso — medido, o conjunto de specs citadas fora de variável é **vazio**.) O que roda são as `SPECS_PARTE_*`:

  ```bash
  ls tests/e2e/*.spec.ts | wc -l                    # quantas existem
  python3 - <<'PY'                                  # quantas o CI invoca
  import re
  y = open(".github/workflows/e2e.yml", encoding="utf-8").read()
  print(len({s for _, c in re.findall(r'(SPECS_PARTE_\d+):\s*>-\n((?:[ ]{8,}.*\n)+)', y)
               for s in re.findall(r'[a-z0-9-]+\.spec\.ts', c)}))
  PY
  ```

  **Por que não há mais número aqui.** O conserto que este parágrafo pedia era pôr a prosa sob gate — `tests/unit/e2e-cobertura-completa.test.ts` cobrando também o texto daqui. Tirar o número é melhor e mais barato: não há o que policiar, e a diferença entre disco e CI segue vigiada onde importa, no próprio teste, que reprova toda spec nova que não esteja em `SPECS_PARTE_*` ou em `FORA_DO_CI` **com motivo escrito**. Prosa que nenhum gate lê é prosa que diverge; prosa que não afirma número não tem como divergir.
- **`imagens-ok`** (`publish-image.yml`) — reprova quando qualquer uma das três imagens Docker não constrói. **É obrigatório desde 2026-08-13**; este arquivo dizia o contrário em outro parágrafo (ver a doutrina de packaging acima, já corrigida).

Todos os **cinco** são **obrigatórios** — medido em 2026-08-14 na branch protection:

```console
$ gh api repos/melgarafael/DeskcommCRM/branches/main/protection --jq '.required_status_checks.contexts|join(", ")'
verify, build-and-size, invariants, e2e, imagens-ok
```

Duas correções que este bloco já pagou: o `e2e` entrou para a lista depois de o arquivo ser escrito, e
a versão anterior dizia que ele "ainda não é obrigatório"; depois o `imagens-ok` entrou e o arquivo
seguiu dizendo "quatro". Uma triagem que leia qualquer uma dessas versões mede contra a régua errada —
que é o modo de falha nº 1 do procedimento de triagem. **Reconfira na fonte antes de confiar em
qualquer lista aqui**, com o comando acima.

**Onde os jobs rodam.** A conta tem o plano Pro: até **40** jobs simultâneos nas máquinas do GitHub
(medidos 39 em 18/09/2026, com 180 na fila). Os jobs pesados do trabalho **nosso** (push na `main`
e PR de branch deste repositório) podem ir para o **executor próprio** (`infra/executor-proprio/`)
quando a variável de repositório `EXECUTOR_PROPRIO` vale `ligado`; PR de fork roda sempre no GitHub,
e a publicação da `main` também. Duas regras que não se negociam:

- **A guarda contra fork mora na máquina, não no YAML.** Em PR de fork o GitHub roda o workflow do
  fork, que pode reescrever `runs-on:`. Quem recusa é `infra/executor-proprio/so-o-que-e-nosso.sh`,
  gravado na imagem como hook de entrada do runner. Mudar a expressão de `runs-on` não é mudar a
  segurança — e afrouxar a guarda é.
- **Imagem que o parque instala nunca se constrói na máquina nossa.** `build-and-push` e
  `promover-stable` ficam em `ubuntu-latest`; os jobs `*-sobe` só vão para a máquina em PR.

Vigiado por `tests/unit/executor-proprio-so-roda-o-que-e-nosso.test.ts`. Botão de emergência:
apagar a variável `EXECUTOR_PROPRIO` — os jobs novos voltam na hora para o GitHub. **A fila de merge
(merge queue) do GitHub não está disponível** neste repositório (conta pessoal; medido em 18/09/2026:
a regra é recusada com 422 e uma regra comum no mesmo formato é aceita) — a integração em lote da
triagem (`triagem/TRIAGEM.md` §3-quinquies) é o que cumpre esse papel.

Ao mexer em schema, RLS, RBAC, atribuição, escopo, roteamento, follow-up, webhooks ou automações: rode `pnpm test:db` **localmente** antes de abrir PR. É o único caminho que exercita o `baseline.sql` que o self-hoster realmente aplica.

---
