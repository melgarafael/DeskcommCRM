# Atualização segura e agenda — plano de implementação

> **Para quem executa (humano ou agente):** SUB-SKILL OBRIGATÓRIA — use
> `superpowers:subagent-driven-development` (recomendada) ou
> `superpowers:executing-plans` para executar tarefa a tarefa. Os passos usam
> caixa (`- [ ]`) para marcação.

**Goal:** que a atualização pare de apagar regra de isolamento em silêncio, que a
agenda deixe de exigir dois campos para uma escolha só, que o compromisso chegue
ao cliente pelo WhatsApp e se corrija ao ser remarcado, e que o observador de
risco pare de abortar para a organização inteira.

**Architecture:** cinco ondas numa **única branch**, cada uma fechada por prova
na tela da instalação real antes da seguinte começar. A Parte A é shell (o
`update.sh` do kit) com dublês de `docker` em teste; a Parte B é tela e uma linha
de API; a B.6 é gatilho no banco com migration e uma ação nova de rota; a Parte C
é regra pura em TypeScript. **Um PR só, no fim, e só com a palavra do Paulo.**

**Tech Stack:** Bash + `docker compose` (kit), Next.js 16 App Router + React 19 +
Tailwind 4 (tela), Postgres/Supabase com RLS e migrations versionadas, Vitest
(unit e invariantes), Playwright (e2e), `tests/shell/*.test.sh` (kit).

**Spec:** [`docs/superpowers/specs/2026-09-12-atualizacao-segura-e-agenda-design.md`](../specs/2026-09-12-atualizacao-segura-e-agenda-design.md)

---

## Global Constraints

Valem para **toda** tarefa deste plano.

- **Uma branch só:** `fix/atualizacao-segura-e-agenda`. Nasce de `origin/main`
  com `--no-track` e aponta para `fork`. Nunca abrir branch nova por onda.
- **A ordem é lei:** implementa → desce para a VPS → **publica a tag** → Paulo
  clica em "Atualizar agora" → **prova na tela** → só então a onda seguinte.
  Nenhum PR ao Rafael antes da última onda provada e da palavra dele.
- **Migration é tripla:** arquivo em `supabase/migrations/` + apêndice
  idempotente no `supabase/baseline.sql` **antes do bloco final de varredura da
  anon** + linha em `supabase/migrations/MANIFEST.md`, **no mesmo commit**.
- **Numeração da migration** sai do maior `NNNN`, nunca do último arquivo:
  `ls supabase/migrations/ | grep -oE '_[0-9]{4}_' | tr -d _ | sort -n | tail -1`
- **Nunca comitar** `NOSSA-REGRA.md`, `NOSSA-INTEGRACAO.md`, `FILA.md` — o fork é
  público e eles têm caminho da VPS, usuário de SSH e domínio.
- **Todo critério que APAGA roda como `select` antes de virar `delete`.**
- **Nunca inventar sinal que o banco não guarda.**
- **Gates rápidos por tarefa** (`pnpm typecheck`, `pnpm lint`, e só os arquivos de
  teste tocados). **A suíte inteira uma vez por onda**, antes de publicar:

  ```bash
  pnpm test:unit > /tmp/vt.log 2>&1; echo "exit=$?"
  grep -aE "Test Files|Tests " /tmp/vt.log | tail -2
  r=$(grep -aE "^ *Tests " /tmp/vt.log | tail -1 | grep -oE "[0-9]+ failed" | head -1)
  g=$(grep -acE "^ *FAIL " /tmp/vt.log); echo "rodapé: ${r:-0 failed} | grep contou: $g"
  ```

  Se as duas contagens não baterem, a sonda está cega — rode com
  `--reporter=verbose`, não conclua pelo silêncio.
- **Fragmento de release** em `.changes/` em toda onda que muda o que o operador
  vê. Confira com `pnpm release:conferir`.
- **Nomes reais dos contêineres desta instalação** (medidos, não supostos):
  `deskcomm-app-1`, `deskcomm-worker-1`, `deskcomm-scheduler-1`, `supabase-rest`,
  `supabase-studio` e **`realtime-dev.supabase-realtime`** — este último **não**
  se chama `supabase-realtime`. Um padrão `^supabase-realtime` não o alcança.
- **A VPS hospeda outros sistemas** (`imobplus-*`, `wordpress_*`). Nenhum comando
  pode parar contêiner por varredura larga (`docker stop $(docker ps -q)` está
  proibido); a lista é sempre explícita.

---

## Estrutura de arquivos

| Arquivo | Responsabilidade | Onda |
|---|---|---|
| `hostgator-setup-kit/_common.sh` | ganha `supabase_local_containers()` — quem fala com o banco e pode ser parado | 1 |
| `hostgator-setup-kit/update.sh` | para/sobe essas peças em volta da etapa de banco; confere **parado**; recria as que faltam | 1 |
| `tests/shell/atualizacao-para-quem-fala-com-o-banco.test.sh` | prova do ciclo com `docker` dublê | 1 |
| `hostgator-setup-kit/manutencao/index.html` | a página que o cliente vê enquanto o banco é aplicado | 2 |
| `hostgator-setup-kit/manutencao.sh` | sobe e derruba o aviso, com as labels do proxy | 2 |
| `components/agenda/EscolhaDoCliente.tsx` | **novo** — um campo só, com busca embutida | 3 |
| `components/agenda/VinculoDaMarcacao.tsx` | passa a usar o campo novo; perde o par de campos | 3 |
| `app/api/v1/agenda/vinculos/route.ts` | devolve também o `email` do contato | 3 |
| `app/app/agenda/_client.tsx` | campo de observação; e-mail do convidado pré-preenchido | 3 |
| `lib/agenda/email-do-convidado.ts` | **novo** — regra pura: quando preencher e quando NÃO sobrescrever | 3 |
| `lib/agenda/texto-do-compromisso.ts` | **novo** — o texto que vai ao cliente (primeiro envio e correção) | 4 |
| `supabase/migrations/<ts>_<NNNN>_remarcar_corrige_o_envio.sql` | o gatilho que reenfileira a correção | 4 |
| `app/api/v1/agenda/agendamentos/[id]/google/meet/resend/route.ts` | **novo** — o reenvio explícito | 4 |
| `lib/leads/risk-since.ts` | `since` nunca no futuro | 5 |
| `lib/leads/risk-worker.ts` | uma gravação que falha não derruba as outras | 5 |

---

## Onda 0 — a branch (antes de tudo)

- [ ] **Passo 1: criar a branch a partir de `origin/main`, sem herdar o rastreio**

```bash
git fetch origin && git fetch fork
git checkout --no-track -b fix/atualizacao-segura-e-agenda origin/main
git push -u fork fix/atualizacao-segura-e-agenda
git branch --set-upstream-to=fork/fix/atualizacao-segura-e-agenda
```

⚠️ `--no-track` **não é detalhe**: sem ele o git grava `origin/main` como
upstream e o app oferece abrir o PR no repositório do Rafael. Já aconteceu.

- [ ] **Passo 2: trazer para dentro o que já está pronto e provado**

```bash
git merge --no-ff fix/atualizacao-confere-as-regras-de-isolamento
git merge --no-ff fix/o-envio-do-meet-diz-o-motivo
```

- [ ] **Passo 3: conferir que o rastreio ficou certo**

```bash
git rev-parse --abbrev-ref --symbolic-full-name @{u}   # tem de ser fork/...
```

Esperado: `fork/fix/atualizacao-segura-e-agenda`. Se sair `origin/main`, refaça
o passo 1 — **não siga**.

---
# ONDA 1 — a atualização para de apagar regra em silêncio

**O que esta onda entrega:** a etapa de banco roda com **ninguém falando com o
banco**, a conferência acontece **antes de subir**, e o que falta é **recriado**
em vez de o arquivo inteiro ser reaplicado.

**Por que nesta ordem:** é a peça de que todas as outras dependem para chegar ao
Paulo. Enquanto ela não estiver de pé, cada entrega das ondas seguintes viaja
num `update.sh` que ainda pode apagar uma regra e dizer "concluída com sucesso".

---

### Task 1: Saber quem fala com o banco e pode ser parado

**Files:**
- Modify: `hostgator-setup-kit/_common.sh` (acrescentar ao fim das funções de compose)
- Test: `tests/shell/atualizacao-para-quem-fala-com-o-banco.test.sh` (criar)
- Modify: `package.json:27` (acrescentar o teste novo ao `test:shell`)

**Interfaces:**
- Produces: `supabase_local_containers()` — imprime, uma por linha, o **nome** de
  cada contêiner Supabase local que reage a mudança de estrutura. Vazio quando o
  Supabase é hospedado. Não recebe argumento e não altera nada.

- [ ] **Passo 1: escrever o teste que falha**

Crie `tests/shell/atualizacao-para-quem-fala-com-o-banco.test.sh`:

```bash
#!/usr/bin/env bash
# Prova de que a atualização sabe QUEM parar antes de mexer no banco — com
# `docker` substituído por dublê. Nada aqui toca a máquina de quem roda.
#
#   bash tests/shell/atualizacao-para-quem-fala-com-o-banco.test.sh
set -uo pipefail
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
falhas=0
ok()   { printf '  ✓ %s\n' "$1"; }
nao()  { printf '  ✗ %s\n     esperava: %s\n     veio:     %s\n' "$1" "$2" "$3"; falhas=$((falhas+1)); }

# Dublê de `docker`: imprime a lista de contêineres que a instalação REAL tem
# (medida em 2026-09-12), incluindo os de OUTROS sistemas na mesma VPS.
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin"
cat > "$tmp/bin/docker" <<'DUBLE'
#!/usr/bin/env bash
if [ "$1" = "ps" ]; then
  cat <<'LISTA'
deskcomm-app-1
deskcomm-worker-1
deskcomm-scheduler-1
realtime-dev.supabase-realtime
supabase-auth
supabase-db
supabase-rest
supabase-studio
imobplus-server-app-1
wordpress_app_pljr
LISTA
  exit 0
fi
exit 0
DUBLE
chmod +x "$tmp/bin/docker"
export PATH="$tmp/bin:$PATH"

# shellcheck disable=SC1090
. "$RAIZ/hostgator-setup-kit/_common.sh" 2>/dev/null || true

echo "caso 1 — acha as três peças do Supabase local"
saida="$(supabase_local_containers | sort | tr '\n' ' ')"
esperado="realtime-dev.supabase-realtime supabase-rest supabase-studio "
[ "$saida" = "$esperado" ] && ok "achou as três, e só elas" || nao "as três peças" "$esperado" "$saida"

echo "caso 2 — NÃO leva sistema de terceiro junto"
case "$saida" in
  *imobplus*|*wordpress*) nao "não toca em outro sistema" "sem imobplus/wordpress" "$saida" ;;
  *) ok "imobplus e wordpress ficam de fora" ;;
esac

echo "caso 3 — NÃO leva o banco nem o auth (parar o banco seria absurdo)"
case "$saida" in
  *supabase-db*|*supabase-auth*) nao "poupa o banco e o auth" "sem supabase-db/auth" "$saida" ;;
  *) ok "supabase-db e supabase-auth ficam de pé" ;;
esac

echo "caso 4 — CONTROLE: Supabase hospedado devolve vazio"
cat > "$tmp/bin/docker" <<'DUBLE'
#!/usr/bin/env bash
if [ "$1" = "ps" ]; then printf 'deskcomm-app-1\ndeskcomm-worker-1\n'; exit 0; fi
exit 0
DUBLE
chmod +x "$tmp/bin/docker"
vazio="$(supabase_local_containers | tr -d '[:space:]')"
[ -z "$vazio" ] && ok "hospedado: nada a parar" || nao "hospedado devolve vazio" "(vazio)" "$vazio"

[ "$falhas" -eq 0 ] && { echo "TUDO VERDE"; exit 0; } || { echo "$falhas caso(s) vermelho(s)"; exit 1; }
```

- [ ] **Passo 2: rodar e ver falhar**

```bash
bash tests/shell/atualizacao-para-quem-fala-com-o-banco.test.sh
```

Esperado: **vermelho**, com `supabase_local_containers: command not found` nos
quatro casos.

- [ ] **Passo 3: implementar**

Acrescente em `hostgator-setup-kit/_common.sh`, logo depois de `dc_files()`:

```bash
# ── QUEM FALA COM O BANCO E PODE SER PARADO ──────────────────────────────────
#
# O `update.sh` aplica o `baseline.sql`, que APAGA e RECRIA cada regra de
# isolamento (o Postgres não tem `create or replace policy`). Com tráfego vivo,
# isso vira disputa de trava: medido nesta instalação, 113 travamentos com tudo
# de pé, 60 com o CRM parado, e ZERO com o CRM mais estas três peças paradas.
# Quando o `create` trava, o `drop` já valeu — a regra some, o banco passa a
# negar a leitura em silêncio, e a tela fica VAZIA sem um erro sequer.
#
# ⚠️ O `realtime` NÃO se chama `supabase-realtime`. Na instalação real o nome é
# `realtime-dev.supabase-realtime`, e um padrão ancorado em `^supabase-` deixa
# justamente ele de pé — que é quem mais reage a mudança de estrutura.
#
# ⚠️ O banco e o auth ficam DE PÉ de propósito: é no banco que o DDL roda, e
# derrubar o auth deslogaria quem está na tela sem necessidade.
#
# ⚠️ Nada de varredura larga. Esta VPS hospeda outros sistemas (medido: um CRM
# imobiliário e dois WordPress). A lista é explícita, e é só a nossa.
#
# Vazio quando o Supabase é HOSPEDADO — lá não há o que parar, e é por isso que
# a conferência (que não depende de parar nada) é a peça portável.
supabase_local_containers() {
  docker ps --format '{{.Names}}' 2>/dev/null | grep -E \
    '^(supabase-rest|supabase-studio|realtime-dev\.supabase-realtime)$' || true
}
```

- [ ] **Passo 4: rodar e ver passar**

```bash
bash tests/shell/atualizacao-para-quem-fala-com-o-banco.test.sh
```

Esperado: `TUDO VERDE`.

- [ ] **Passo 5: pendurar no gate e commitar**

Em `package.json:27`, acrescente `bash tests/shell/atualizacao-para-quem-fala-com-o-banco.test.sh && ` ao início do valor de `test:shell`. Depois:

```bash
pnpm test:shell
git add hostgator-setup-kit/_common.sh tests/shell/atualizacao-para-quem-fala-com-o-banco.test.sh package.json
git commit -m "feat(kit): a atualizacao sabe quem fala com o banco e pode ser parado"
```

---
### Task 2: Parar quem fala com o banco, e não voltar ao ar quebrado

**Files:**
- Modify: `hostgator-setup-kit/update.sh:144` (antes de `step "Atualizando o banco de dados"`)
- Test: `tests/shell/atualizacao-para-quem-fala-com-o-banco.test.sh` (acrescentar casos 5–7)

**Interfaces:**
- Consumes: `supabase_local_containers()` da Task 1.
- Produces: as variáveis de script `PARADOS` (nomes parados) e `REGRAS_FALTANDO`
  (vazio = tudo certo), e a função `restaurar_servicos()` pendurada num `trap EXIT`.

- [ ] **Passo 1: escrever os casos que falham**

Acrescente ao arquivo de teste, **antes** do bloco final que conta falhas:

```bash
# ── O ciclo inteiro, com `docker` gravando o que foi chamado ────────────────
diario="$tmp/chamadas.txt"
cat > "$tmp/bin/docker" <<DUBLE
#!/usr/bin/env bash
echo "\$*" >> "$diario"
if [ "\$1" = "ps" ]; then
  printf 'deskcomm-app-1\nrealtime-dev.supabase-realtime\nsupabase-rest\nsupabase-studio\nimobplus-server-app-1\n'
  exit 0
fi
exit 0
DUBLE
chmod +x "$tmp/bin/docker"

echo "caso 5 — para as três peças do Supabase pelo nome exato"
: > "$diario"
PARADOS="$(supabase_local_containers)"; REGRAS_FALTANDO=""
[ -n "$PARADOS" ] && docker stop $PARADOS >/dev/null 2>&1
grep -q 'stop realtime-dev.supabase-realtime supabase-rest supabase-studio' "$diario" \
  && ok "parou as três num comando só" \
  || nao "parar as três" "stop realtime-dev... supabase-rest supabase-studio" "$(cat "$diario")"

echo "caso 6 — com regra faltando, o CRM NÃO volta ao ar"
: > "$diario"; REGRAS_FALTANDO="crm_leads_select|crm_leads"
restaurar_servicos >/dev/null 2>&1
grep -q 'start realtime-dev' "$diario" && ok "as peças do Supabase voltam" \
  || nao "peças do Supabase voltam" "start realtime-dev..." "$(cat "$diario")"
grep -q 'up -d app' "$diario" \
  && nao "o CRM fica parado" "sem 'up -d app'" "$(cat "$diario")" \
  || ok "o CRM fica parado de propósito"

echo "caso 7 — CONTROLE: sem regra faltando, o CRM volta"
: > "$diario"; PARADOS="$(supabase_local_containers)"; REGRAS_FALTANDO=""
restaurar_servicos >/dev/null 2>&1
grep -q 'up -d app' "$diario" && ok "tudo certo: o CRM volta" \
  || nao "o CRM volta" "up -d app" "$(cat "$diario")"
```

- [ ] **Passo 2: rodar e ver falhar**

```bash
bash tests/shell/atualizacao-para-quem-fala-com-o-banco.test.sh
```

Esperado: casos 5–7 vermelhos (`restaurar_servicos: command not found`).

- [ ] **Passo 3: implementar a pausa**

Em `hostgator-setup-kit/update.sh`, **imediatamente antes** de
`step "Atualizando o banco de dados"` (hoje linha 144):

```bash
# ── NINGUÉM FALA COM O BANCO ENQUANTO ELE MUDA ───────────────────────────────
#
# Medido nesta instalação, no mesmo dia e com o mesmo arquivo:
#   tudo de pé ................................ 113 travamentos
#   CRM parado ................................  60 travamentos
#   CRM + rest + realtime + studio parados ....   0 travamentos
#
# Travamento aqui não é lentidão: quando o `create policy` trava, o `drop` que
# veio antes já valeu. A regra some, o banco nega a leitura em silêncio, e a
# tela fica vazia — indistinguível de "não há nada aqui".
#
# Custa ~16s (medido: parar 10,3s, subir 6,0s) numa atualização cuja mediana
# real é 308s e cuja variação natural entre duas rodadas é de 785s.
PARADOS=""
REGRAS_FALTANDO=""
restaurar_servicos() {
  if [ -n "${PARADOS:-}" ]; then
    docker start $PARADOS >/dev/null 2>&1 || true
    PARADOS=""
  fi
  # O CRM NAO VOLTA AO AR COM REGRA DE ISOLAMENTO FALTANDO.
  # Um CRM fora do ar é um problema visível que alguém resolve. Um CRM no ar sem
  # regra de isolamento mostra tela vazia para todo mundo e ninguém sabe por
  # quê — foi exatamente o que custou um dia inteiro nesta instalação.
  if [ -n "${REGRAS_FALTANDO:-}" ]; then
    c_red "   O CRM segue PARADO de propósito. Resolva as regras antes de subir."
    return 0
  fi
  dc up -d app worker scheduler >/dev/null 2>&1 || true
}
# O trap é o que impede um erro no meio de deixar a instalação pela metade.
trap restaurar_servicos EXIT

if [ -f supabase/baseline.sql ]; then
  PARADOS="$(supabase_local_containers)"
  c_ylw "Pausando o sistema para mexer no banco com segurança."
  dc stop app worker scheduler >/dev/null 2>&1 || true
  if [ -n "$PARADOS" ]; then
    docker stop $PARADOS >/dev/null 2>&1 || true
  fi
fi
```

- [ ] **Passo 4: rodar e ver passar**

```bash
bash tests/shell/atualizacao-para-quem-fala-com-o-banco.test.sh && pnpm test:shell
```

Esperado: `TUDO VERDE` nos dois.

- [ ] **Passo 5: commitar**

```bash
git add hostgator-setup-kit/update.sh tests/shell/atualizacao-para-quem-fala-com-o-banco.test.sh
git commit -m "fix(kit): ninguem fala com o banco enquanto ele muda, e o CRM nao volta quebrado"
```

---
### Task 3: Conferir **parado** e recriar exatamente o que falta

**Files:**
- Modify: `hostgator-setup-kit/update.sh:229-243` (substitui o bloco que reaplicava o arquivo)
- Test: `tests/unit/atualizacao-confere-regras-de-isolamento.test.ts` (grupo novo)

**Interfaces:**
- Consumes: `REGRAS_FALTANDO` da Task 2 — este bloco é quem a preenche.
- Produces: o awk de recriação dentro do `update.sh`, extraído pelo teste do
  mesmo jeito que o awk da régua já é hoje.

- [ ] **Passo 1: escrever os casos que falham**

Acrescente a `tests/unit/atualizacao-confere-regras-de-isolamento.test.ts`:

```ts
/** Extrai o awk que RECRIA as regras que faltam — a régua de verdade, não uma cópia. */
function programaAwkRecria(): string {
  const abre = "recria=\"$(awk -v faltantes=\\\"$faltam_arq\\\" '";
  const i = UPDATE.indexOf(abre);
  const j = UPDATE.indexOf("' supabase/baseline.sql", i);
  return UPDATE.slice(i + abre.length, j);
}

describe.skipIf(!temAwk)("recriar o que falta: o comando INTEIRO, nunca o nome", () => {
  function recria(sql: string, faltantes: string[]): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recria-"));
    const b = path.join(dir, "b.sql");
    const f = path.join(dir, "faltam.txt");
    fs.writeFileSync(b, sql, "utf8");
    fs.writeFileSync(f, faltantes.join("\n") + "\n", "utf8");
    try {
      return execFileSync("awk", ["-v", "faltantes=" + f, programaAwkRecria(), b], {
        encoding: "utf8",
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it("devolve o comando completo da regra que falta", () => {
    const saida = recria('create policy "x_select" on public.x for select using (true);\n', [
      "x_select|x",
    ]);
    expect(saida).toMatch(/create policy "x_select" on public\.x for select using \(true\);/);
  });

  it("comando de VÁRIAS LINHAS vem inteiro — senão o SQL sai quebrado", () => {
    // As regras reais do baseline ocupam várias linhas. Recriar só a primeira
    // produziria um comando sem `;` e sem predicado — pior que não recriar,
    // porque falharia deixando a impressão de que tentou.
    const saida = recria(
      'create policy "y_all" on public.y\n  for all\n  using (fn_user_org_ids() @> array[organization_id]);\n',
      ["y_all|y"],
    );
    expect(saida).toMatch(/for all/);
    expect(saida).toMatch(/fn_user_org_ids/);
    expect(saida.trim().endsWith(";")).toBe(true);
  });

  it("NÃO devolve regra que o arquivo apaga depois — é decisão deliberada", () => {
    const saida = recria(
      'create policy "velha" on public.z for all using (true);\n' +
        'drop policy if exists "velha" on public.z;\n',
      ["velha|z"],
    );
    expect(saida.trim()).toBe("");
  });

  it("devolve SÓ o que foi pedido, nunca o arquivo inteiro", () => {
    // Reaplicar o arquivo inteiro NÃO converge: medido nesta instalação, a
    // segunda passada devolveu `conversations_select` e levou embora
    // `conversations_agent_insert`; a terceira trocou o conjunto de novo.
    const saida = recria(
      'create policy "a1" on public.a for select using (true);\n' +
        'create policy "b1" on public.b for select using (true);\n',
      ["a1|a"],
    );
    expect(saida).toMatch(/a1/);
    expect(saida).not.toMatch(/b1/);
  });

  it("SABOTAGEM: regra que o arquivo não declara NÃO é inventada", () => {
    // A metade que importa da sabotagem. Se a regra não está no baseline, ela
    // não é fabricada — `REGRAS_FALTANDO` continua preenchida e o CRM não volta
    // ao ar (provado no caso 6 do teste de shell).
    const saida = recria('create policy "existe" on public.a for select using (true);\n', [
      "sumida|b",
    ]);
    expect(saida.trim()).toBe("");
  });

  it("CONTROLE: nada faltando devolve vazio", () => {
    expect(recria('create policy "a1" on public.a for select using (true);\n', []).trim()).toBe("");
  });
});
```

- [ ] **Passo 2: rodar e ver falhar**

```bash
npx vitest run tests/unit/atualizacao-confere-regras-de-isolamento.test.ts --reporter=verbose
```

Esperado: os seis casos novos vermelhos — `indexOf` devolve `-1`, o programa
extraído sai vazio e o `awk` reclama de programa sem corpo.

- [ ] **Passo 3: implementar**

Em `hostgator-setup-kit/update.sh`, **substitua** o bloco `if [ -n "$faltando" ]`
das linhas 229–243 (o que hoje reaplica o arquivo inteiro) por:

```bash
  if [ -n "$faltando" ]; then
    # RECRIAR AS QUE FALTAM, NUNCA REAPLICAR O ARQUIVO.
    #
    # Isto corrige o que este script fazia antes. Medido nesta instalacao,
    # reaplicar NAO CONVERGE: a segunda passada devolveu `conversations_select`
    # e levou embora `conversations_agent_insert`; a terceira trocou o conjunto
    # outra vez. Cada passada sorteia, porque cada passada e a mesma corrida de
    # APAGAR e CRIAR 92 vezes.
    #
    # Recriar so o que falta e um punhado de comandos rapidos, com muito menos
    # superficie para travar — e roda com os servicos ainda PARADOS, que e a
    # unica janela sem disputa.
    c_ylw "Faltaram regras de isolamento. Recriando exatamente as que faltam..."
    faltam_arq="$PROJECT_DIR/.deskcomm-regras-faltando.txt"
    printf '%s\n' "$faltando" > "$faltam_arq"

    recria="$(awk -v faltantes="$faltam_arq" '
      BEGIN { while ((getline l < faltantes) > 0) { sub(/[ \t\r]+$/, "", l); if (l != "") quero[l] = 1 } }
      /create policy|drop policy if exists/ { buf = ""; coletando = 1 }
      coletando { buf = buf $0 "\n" }
      coletando && /;[ \t]*$/ {
        coletando = 0
        if (match(buf, /drop policy if exists "?[a-zA-Z0-9_]+"? on public\.[a-zA-Z0-9_]+/)) { k = substr(buf, RSTART, RLENGTH); acao = "drop" }
        else if (match(buf, /create policy "?[a-zA-Z0-9_]+"? on public\.[a-zA-Z0-9_]+/)) { k = substr(buf, RSTART, RLENGTH); acao = "create" }
        else next
        gsub(/.*policy (if exists )?"?/, "", k); gsub(/"? on public\./, "|", k)
        estado[k] = acao; if (acao == "create") texto[k] = buf
      }
      END { for (k in quero) if (estado[k] == "create") printf "%s", texto[k] }
    ' supabase/baseline.sql)"

    if [ -n "$recria" ]; then
      printf '%s\n' "$recria" | docker run --rm -i postgres:17-alpine \
        psql "$(url_do_schema)" >> "$PROJECT_DIR/.deskcomm-banco.log" 2>&1 || true
    fi
    rm -f "$faltam_arq"

    existentes="$(docker run --rm -i postgres:17-alpine psql "$(url_do_schema)" -t -A -F'|' -c \
      "select p.polname, c.relname from pg_policy p join pg_class c on c.oid=p.polrelid
         join pg_namespace n on n.oid=c.relnamespace where n.nspname='public';" 2>/dev/null | sort -u)"
    faltando="$(comm -23 <(printf '%s\n' "$esperadas") <(printf '%s\n' "$existentes") || true)"
  fi

  # A variavel que o `restaurar_servicos` (Task 2) le para decidir se o CRM volta.
  REGRAS_FALTANDO="$faltando"
```

- [ ] **Passo 4: rodar e ver passar**

```bash
npx vitest run tests/unit/atualizacao-confere-regras-de-isolamento.test.ts --reporter=verbose
pnpm test:shell
```

Esperado: verde nos dois.

- [ ] **Passo 5: fragmento de versão e commit**

Crie `.changes/atualizacao-nao-volta-quebrada.md`:

```markdown
---
efeito: capacidade_nova
---

A atualização agora pausa o sistema enquanto mexe no banco, confere as regras de
isolamento com tudo parado e recria as que faltarem. Se ainda faltar alguma, ela
avisa em vermelho e não devolve o CRM ao ar — tela vazia sem explicação é pior
que sistema fora do ar por alguns minutos.
```

```bash
pnpm release:conferir
git add hostgator-setup-kit/update.sh tests/unit/atualizacao-confere-regras-de-isolamento.test.ts .changes/atualizacao-nao-volta-quebrada.md
git commit -m "fix(kit): recria exatamente as regras que faltam, em vez de reaplicar o arquivo"
```

---

### Fecho da Onda 1 — a prova que vale

- [ ] **Suíte inteira** (o comando do bloco *Global Constraints*), mais
      `pnpm typecheck`, `pnpm lint`, `pnpm test:shell`
- [ ] **Descer para a VPS** e **publicar a tag** no fork
- [ ] **Paulo clica em "Atualizar agora"**
- [ ] **Provar na tela, nesta ordem:**
  - [ ] a atualização termina sem travamento — `grep -ci deadlock .deskcomm-banco.log` devolve `0`
  - [ ] a linha verde diz `regras de isolamento conferidas (92 declaradas, todas no lugar)`
  - [ ] o funil abre com os negócios de sempre
  - [ ] o tempo total ficou dentro da faixa medida (100s–885s), conferido em `system_update_runs`

**Só com esses quatro na tela a Onda 2 começa.**

---

# ONDA 2 — quem está com o CRM aberto vê um aviso, não um erro

**O que esta onda entrega:** durante a pausa da Onda 1, quem estiver com o
sistema aberto vê uma página explicando que a atualização está em curso, em vez
de um erro do navegador.

**Por que é onda própria, e não parte da Onda 1:** a Onda 1 entrega a
**proteção**; esta entrega a **educação**. Se algo der errado aqui, a proteção já
está de pé — e essa é a ordem certa de correr risco.

---

### Task 4: A página de manutenção assume enquanto o CRM está parado

**Files:**
- Create: `hostgator-setup-kit/manutencao/index.html`
- Create: `hostgator-setup-kit/manutencao.sh`
- Modify: `hostgator-setup-kit/update.sh` (chamar antes do `dc stop` e depois do `up -d`)
- Test: `tests/shell/atualizacao-para-quem-fala-com-o-banco.test.sh` (casos 9–11)

**Interfaces:**
- Consumes: `REGRAS_FALTANDO` e `restaurar_servicos()` da Task 2.
- Produces: `manutencao_sobe()` e `manutencao_desce()` — sobem e derrubam um
  contêiner `nginx:alpine` chamado `deskcomm-manutencao`, com as mesmas labels
  de roteamento do `app` e prioridade maior.

- [x] **Passo 1: escrever os casos que falham**

```bash
echo "caso 9 — o aviso sobe ANTES de o CRM parar"
: > "$diario"
manutencao_sobe >/dev/null 2>&1
grep -q 'deskcomm-manutencao' "$diario" && ok "o aviso subiu" \
  || nao "aviso sobe" "run ... deskcomm-manutencao" "$(cat "$diario")"

echo "caso 10 — o aviso desce quando o CRM volta"
: > "$diario"
manutencao_desce >/dev/null 2>&1
grep -q 'rm -f deskcomm-manutencao' "$diario" && ok "o aviso desceu" \
  || nao "aviso desce" "rm -f deskcomm-manutencao" "$(cat "$diario")"

echo "caso 11 — com regra faltando, o aviso FICA (o CRM nao volta)"
: > "$diario"; REGRAS_FALTANDO="crm_leads_select|crm_leads"
restaurar_servicos >/dev/null 2>&1
grep -q 'rm -f deskcomm-manutencao' "$diario" \
  && nao "o aviso fica" "sem 'rm -f deskcomm-manutencao'" "$(cat "$diario")" \
  || ok "o aviso fica de pé explicando por que o CRM nao voltou"
```

- [x] **Passo 2: rodar e ver falhar**

```bash
bash tests/shell/atualizacao-para-quem-fala-com-o-banco.test.sh
```

Esperado: casos 9–11 vermelhos (`manutencao_sobe: command not found`).

- [x] **Passo 3: escrever a página**

Crie `hostgator-setup-kit/manutencao/index.html`:

```html
<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Atualizacao em andamento</title>
    <style>
      :root { color-scheme: light dark; }
      body {
        margin: 0; min-height: 100vh; display: grid; place-items: center;
        font: 16px/1.6 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
        background: #f7f7f8; color: #18181b; padding: 24px;
      }
      @media (prefers-color-scheme: dark) { body { background: #18181b; color: #f4f4f5; } }
      main { max-width: 32rem; text-align: center; }
      h1 { font-size: 1.375rem; margin: 0 0 0.75rem; }
      p { margin: 0 0 0.5rem; }
      .fraca { opacity: 0.7; font-size: 0.9375rem; }
    </style>
  </head>
  <body>
    <main>
      <h1>Estamos atualizando o sistema</h1>
      <p>Leva alguns minutos. Nada do seu trabalho se perde.</p>
      <p class="fraca">Esta pagina volta sozinha quando terminar.</p>
    </main>
    <script>
      // Recarrega sozinha: quando o CRM voltar, o roteamento deixa de apontar
      // para ca e a pessoa cai direto na tela dela, sem precisar saber de nada.
      setTimeout(function () { location.reload(); }, 15000);
    </script>
  </body>
</html>
```

⚠️ **Sem marca.** A doutrina de marca própria do projeto proíbe `NEXT_PUBLIC_*`
de marca e imagem por revendedor; e esta página sobe **antes** de qualquer coisa
poder consultar o banco, que é onde a marca mora. Uma página neutra é a única
que não mente sobre de quem é o sistema.

- [x] **Passo 4: escrever o script**

Crie `hostgator-setup-kit/manutencao.sh`:

```bash
#!/usr/bin/env bash
# O aviso que assume a porta enquanto o CRM esta parado para o banco.
#
# Por que um container separado e nao um "modo manutencao" dentro do app: o app
# e justamente quem precisa PARAR (medido: com ele de pe, 60 travamentos; com
# ele parado e mais tres pecas do Supabase, zero). Um modo dentro dele exigiria
# mante-lo no ar, que e o oposto do conserto.
#
# Por que nao ha `middleware.ts`: medido em 2026-09-12, o projeto nao tem um. E
# criar um so para isto poria uma peca no caminho de TODA requisicao do produto
# para resolver uma janela de poucos minutos por atualizacao.
set -euo pipefail

NOME="deskcomm-manutencao"

manutencao_sobe() {
  local html="$KIT_DIR/manutencao"
  local labels=()
  if [ "${REVERSE_PROXY:-caddy}" = "traefik" ]; then
    # As MESMAS regras de roteamento do app, com prioridade maior: e assim que
    # o proxy da hospedagem passa a entregar o aviso sem ninguem editar nada.
    labels=(
      --label "traefik.enable=true"
      --label "traefik.http.routers.deskcomm-manutencao.rule=Host(\`${APP_DOMAIN}\`)"
      --label "traefik.http.routers.deskcomm-manutencao.priority=100"
      --label "traefik.http.routers.deskcomm-manutencao.entrypoints=websecure"
      --label "traefik.http.routers.deskcomm-manutencao.tls=true"
      --label "traefik.http.services.deskcomm-manutencao.loadbalancer.server.port=80"
    )
  fi
  docker run -d --rm --name "$NOME" \
    --network "${TRAEFIK_NETWORK:-bridge}" \
    -v "$html:/usr/share/nginx/html:ro" \
    "${labels[@]}" \
    nginx:alpine >/dev/null 2>&1 || true
}

manutencao_desce() {
  docker rm -f "$NOME" >/dev/null 2>&1 || true
}
```

- [x] **Passo 5: pendurar no update.sh**

Em `hostgator-setup-kit/update.sh`, logo depois do `trap restaurar_servicos EXIT`
da Task 2, acrescente o `source` e as duas chamadas:

```bash
# shellcheck source=manutencao.sh
. "$KIT_DIR/manutencao.sh"
```

Dentro de `restaurar_servicos()`, **depois** do `dc up -d app worker scheduler`,
acrescente `manutencao_desce`. E no bloco de pausa, **antes** do
`dc stop app worker scheduler`, acrescente `manutencao_sobe`.

⚠️ O `manutencao_desce` fica **depois** do `return 0` do caso de regra faltando —
de propósito. Com regra faltando o CRM não volta, e o aviso é a única coisa que
explica isso a quem tentar abrir o sistema.

- [x] **Passo 6: rodar e ver passar**

```bash
bash tests/shell/atualizacao-para-quem-fala-com-o-banco.test.sh && pnpm test:shell
```

- [x] **Passo 7: fragmento e commit**

Crie `.changes/aviso-de-manutencao.md`:

```markdown
---
efeito: capacidade_nova
---

Durante a atualizacao, quem estiver com o sistema aberto passa a ver um aviso de
"estamos atualizando" em vez de um erro do navegador. A pagina volta sozinha
quando o sistema sobe.
```

```bash
git add hostgator-setup-kit/manutencao hostgator-setup-kit/manutencao.sh hostgator-setup-kit/update.sh tests/shell/atualizacao-para-quem-fala-com-o-banco.test.sh .changes/aviso-de-manutencao.md
git commit -m "feat(kit): quem esta com o CRM aberto ve um aviso de atualizacao, nao um erro"
```

---

---

#### ⚠️ Corrigido NA EXECUÇÃO — o que este plano dizia estava errado

Medido no `docker-compose.traefik.yml` antes de escrever uma linha. Quatro
desvios, os dois primeiros seriam queda:

1. **`${APP_DOMAIN}` não existe.** A variável do domínio é `DOMAIN`. Sob
   `set -u` a atualização morreria nessa linha — com o CRM **já parado**.
2. **`tls=true` sem resolvedor** faz o Traefik servir o certificado interno
   dele: quem abrisse o CRM veria "site inseguro", que é pior que o erro de
   conexão que esta página veio tirar. O certo é `tls.certresolver`.
3. **O caso do Caddy era vacuoso.** `--network bridge` não põe o aviso em rota
   nenhuma: numa instalação com o Caddy do próprio kit, a página nunca seria
   vista. O caminho real é o aviso assumir o apelido `app` na rede interna e
   atender em **3000**, onde o `reverse_proxy app:3000` do Caddyfile já procura
   — daí existir também `manutencao/nginx.conf`, que o plano não previa.
4. **A ordem da descida estava invertida.** O plano punha `manutencao_desce`
   *depois* do `dc up -d app`. Com o apelido, os dois de pé ao mesmo tempo fazem
   o Docker dar rodízio: metade das pessoas veria "estamos atualizando" com o
   CRM já no ar. Desce **antes**.

Também mudou a numeração dos casos: o plano falava em "casos 9–11" e o arquivo
já tinha 19 casos. Os novos são **20–29**, e dois deles (22 e 23) existem só
para reprovar os desvios 1 e 2 se alguém os reescrever.

---

### Fecho da Onda 2

- [x] Suíte inteira + `pnpm test:shell` — 10 casos novos verdes; o único vermelho
      da suíte do kit é `.env continua 600`, que **já falhava no HEAD** antes
      desta mudança (o Windows não tem a permissão), provado num worktree limpo
- [ ] Publicar a tag; Paulo clica
- [ ] **Provar na tela:** com o CRM aberto em outra aba durante a atualização,
      aparece o aviso; quando termina, a aba volta sozinha para a tela de antes

---
# ONDA 3 — a agenda que só precisa de tela

**O que esta onda entrega:** B.1 (um campo só para escolher o cliente), B.2
(observação do compromisso) e B.3 (e-mail do convidado pré-preenchido).

**Por que juntas:** as três mexem no mesmo formulário e nas mesmas duas telas. Um
único ciclo de prova cobre as três, e a pessoa que abre o painel depois desta
onda vê a tela inteira coerente, não um pedaço novo ao lado de dois velhos.

**Medido antes de planejar:** `calendar_appointments.notes` já existe e a API já
a aceita no POST **e** no PATCH (`app/api/v1/agenda/agendamentos/route.ts:84`,
`z.string().max(2000)`) — B.2 é **zero banco, zero rota**. Já B.3 **precisa de
uma linha de rota**: `/api/v1/agenda/vinculos` hoje faz `.select("id,name")` e
não devolve o e-mail (medido em `app/api/v1/agenda/vinculos/route.ts:18`).

---

### Task 5: Um campo só para escolher o cliente

**Files:**
- Create: `components/agenda/EscolhaDoCliente.tsx`
- Modify: `components/agenda/VinculoDaMarcacao.tsx` (trocar os dois campos por um)
- Test: `tests/unit/escolha-do-cliente.test.tsx` (criar)

**Interfaces:**
- Produces: `<EscolhaDoCliente contatos={Contato[]} valor={string} busca={string}
  onBusca={(q: string) => void} onEscolhe={(id: string) => void} />`, com
  `type Contato = { id: string; name: string; email?: string | null }`.
  `valor === ""` significa **compromisso pessoal, sem cliente**, e é o padrão.

- [ ] **Passo 1: escrever o teste que falha**

Crie `tests/unit/escolha-do-cliente.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { EscolhaDoCliente } from "@/components/agenda/EscolhaDoCliente";

/**
 * Dois campos em sequência para UMA escolha.
 *
 * "Buscar cliente" (texto) e "Quem será atendido" (lista) viviam um embaixo do
 * outro: o segundo parecia que ia abrir algo ao digitar, o primeiro parecia não
 * fazer nada até a lista mudar. Quem opera relatou a confusão pela tela.
 */
const CONTATOS = [
  { id: "c1", name: "Ana Ribeiro", email: "ana@exemplo.com" },
  { id: "c2", name: "Bruno Alves", email: null },
];

describe("escolher o cliente num campo só", () => {
  it("abre SEM cliente — 'compromisso pessoal' é o padrão", () => {
    // O caso degenerado é o que manda no desenho: um seletor que abre no
    // primeiro contato da lista marca compromisso no nome de outra pessoa.
    // Já aconteceu nesta instalação, por herança do painel anterior.
    render(
      <EscolhaDoCliente contatos={CONTATOS} valor="" busca="" onBusca={() => {}} onEscolhe={() => {}} />,
    );
    expect(screen.getByRole("combobox")).toHaveValue("");
    expect(screen.getByText(/compromisso pessoal/i)).toBeInTheDocument();
  });

  it("digitar filtra ali mesmo, sem segundo campo", async () => {
    const onBusca = vi.fn();
    render(
      <EscolhaDoCliente contatos={CONTATOS} valor="" busca="" onBusca={onBusca} onEscolhe={() => {}} />,
    );
    await userEvent.type(screen.getByRole("combobox"), "Ana");
    expect(onBusca).toHaveBeenCalled();
    expect(screen.queryByLabelText(/quem será atendido/i)).not.toBeInTheDocument();
  });

  it("escolher devolve o id do contato", async () => {
    const onEscolhe = vi.fn();
    render(
      <EscolhaDoCliente contatos={CONTATOS} valor="" busca="Ana" onBusca={() => {}} onEscolhe={onEscolhe} />,
    );
    await userEvent.click(screen.getByRole("option", { name: /Ana Ribeiro/ }));
    expect(onEscolhe).toHaveBeenCalledWith("c1");
  });

  it("CONTROLE: a opção de limpar volta ao compromisso pessoal", async () => {
    const onEscolhe = vi.fn();
    render(
      <EscolhaDoCliente contatos={CONTATOS} valor="c1" busca="" onBusca={() => {}} onEscolhe={onEscolhe} />,
    );
    await userEvent.click(screen.getByRole("button", { name: /tirar o cliente/i }));
    expect(onEscolhe).toHaveBeenCalledWith("");
  });
});
```

- [ ] **Passo 2: rodar e ver falhar**

```bash
npx vitest run tests/unit/escolha-do-cliente.test.tsx --reporter=verbose
```

Esperado: FAIL — `Failed to resolve import "@/components/agenda/EscolhaDoCliente"`.

- [ ] **Passo 3: implementar**

Crie `components/agenda/EscolhaDoCliente.tsx`:

```tsx
"use client";
import { useId, useState } from "react";
import { useT } from "@/hooks/i18n/useT";

export type Contato = { id: string; name: string; email?: string | null };

/**
 * UM campo para uma escolha.
 *
 * Antes eram dois em sequência — "Buscar cliente" (texto) e "Quem será
 * atendido" (lista) —, e quem opera relatou que o segundo parecia que ia abrir
 * algo ao digitar, enquanto o primeiro parecia não fazer nada.
 *
 * O padrão é o VAZIO, e isso não é detalhe de gosto: um seletor que abre já
 * apontando para o primeiro contato marca compromisso no nome de outra pessoa.
 */
export function EscolhaDoCliente({
  contatos,
  valor,
  busca,
  onBusca,
  onEscolhe,
}: {
  contatos: Contato[];
  valor: string;
  busca: string;
  onBusca: (q: string) => void;
  onEscolhe: (id: string) => void;
}) {
  const t = useT();
  const id = useId();
  const [aberto, setAberto] = useState(false);
  const escolhido = contatos.find((c) => c.id === valor) ?? null;

  return (
    <div className="space-y-1">
      <label className="block text-xs font-medium text-text-muted" htmlFor={id}>
        {t("Cliente do compromisso")}
      </label>

      {escolhido ? (
        <div className="flex items-center gap-2 rounded-md border bg-surface p-2">
          <span className="flex-1 truncate text-sm">{escolhido.name}</span>
          <button
            type="button"
            className="rounded px-2 py-1 text-xs underline"
            onClick={() => {
              onEscolhe("");
              onBusca("");
            }}
          >
            {t("Tirar o cliente")}
          </button>
        </div>
      ) : (
        <>
          <input
            id={id}
            role="combobox"
            aria-expanded={aberto}
            aria-controls={`${id}-lista`}
            autoComplete="off"
            className="w-full rounded-md border bg-surface p-2 text-sm"
            placeholder={t("Compromisso pessoal, sem cliente — digite para buscar")}
            value={busca}
            onFocus={() => setAberto(true)}
            onChange={(e) => {
              onBusca(e.target.value);
              setAberto(true);
            }}
          />
          <p className="text-xs text-text-muted">
            {t("Compromisso pessoal, sem cliente")}
          </p>
          {aberto && contatos.length > 0 ? (
            <ul
              id={`${id}-lista`}
              role="listbox"
              className="max-h-48 overflow-y-auto rounded-md border bg-surface"
            >
              {contatos.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={false}
                    className="w-full px-2 py-1.5 text-left text-sm hover:bg-surface-muted"
                    onClick={() => {
                      onEscolhe(c.id);
                      setAberto(false);
                    }}
                  >
                    {c.name}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      )}
    </div>
  );
}
```

- [ ] **Passo 4: rodar e ver passar**

```bash
npx vitest run tests/unit/escolha-do-cliente.test.tsx --reporter=verbose
```

- [ ] **Passo 5: trocar no `VinculoDaMarcacao`**

Em `components/agenda/VinculoDaMarcacao.tsx`, substitua os **dois** blocos
`<label>` (o de "Buscar cliente" e o de "Quem será atendido") por:

```tsx
      <EscolhaDoCliente
        contatos={query.data?.contacts ?? []}
        valor={contactId}
        busca={search}
        onBusca={(q) => {
          setSearch(q);
          // Trocar a busca solta a escolha anterior: sem isto, a lista filtra
          // por um nome e o contato preso continua sendo outro.
          onChange("", "");
        }}
        onEscolhe={(id) => onChange(id, "")}
      />
```

E acrescente o import no topo:

```tsx
import { EscolhaDoCliente } from "@/components/agenda/EscolhaDoCliente";
```

- [ ] **Passo 6: gates e commit**

```bash
pnpm typecheck && pnpm lint
npx vitest run tests/unit/escolha-do-cliente.test.tsx --reporter=verbose
git add components/agenda/EscolhaDoCliente.tsx components/agenda/VinculoDaMarcacao.tsx tests/unit/escolha-do-cliente.test.tsx
git commit -m "feat(agenda): escolher o cliente num campo so, com busca embutida"
```

---

### Task 6: A observação do compromisso

**Files:**
- Modify: `app/app/agenda/_client.tsx` (campo no painel + `notes` no POST/PATCH)
- Test: `tests/e2e/agenda-observacao.spec.ts` (criar)

**Interfaces:**
- Consumes: a API que já aceita `notes` (medido: `z.string().max(2000)` no POST e
  no PATCH de `app/api/v1/agenda/agendamentos/route.ts:84`).
- Produces: o estado `observacao` / `setObservacao` no cliente da agenda.

⚠️ **Decisão do dono do produto, registrada porque eu propus o contrário:** é
**uma** observação por compromisso, de quem está marcando. **Não** é histórico de
várias anotações de várias pessoas. Eu havia desenhado uma tabela
`appointment_notes` com autor e data; ele corrigiu — *"o agendamento é
individual"*. A tabela resolveria um problema que ninguém tem.

⚠️ **E ela é interna, sem decisão adicional:** medido em
`lib/agenda/google/evento.ts:330`, o que viaja para o convite do Google é
`description`. `notes` **não** viaja.

- [ ] **Passo 1: escrever a prova pela tela**

Crie `tests/e2e/agenda-observacao.spec.ts`:

```ts
import { expect, test } from "@playwright/test";
import { entrarComoDono } from "./helpers/sessao";

/**
 * A observação existia no banco e não existia na tela.
 *
 * `calendar_appointments.notes` está lá desde sempre, e a API a aceita no POST
 * e no PATCH. Quem marca um compromisso não tinha onde escrever "levar o
 * contrato" — o que fazia a informação viver no WhatsApp de alguém.
 */
test("a observação sobrevive a fechar e reabrir o compromisso", async ({ page }) => {
  await entrarComoDono(page);
  await page.goto("/app/agenda");
  await page.getByRole("button", { name: /novo compromisso/i }).click();

  await page.getByLabel(/observação/i).fill("Levar o contrato impresso");
  await page.getByRole("button", { name: /^marcar$/i }).click();
  await expect(page.getByText(/marcado/i)).toBeVisible();

  // Fecha e reabre pelo detalhe: é onde quem atende vai ler antes da reunião.
  await page.getByRole("button", { name: /ver na agenda/i }).click();
  await page.getByText("Levar o contrato impresso").click();
  await expect(page.getByText("Levar o contrato impresso")).toBeVisible();
});
```

- [ ] **Passo 2: rodar e ver falhar**

```bash
npx playwright test tests/e2e/agenda-observacao.spec.ts
```

Esperado: FAIL em `getByLabel(/observação/i)` — o campo não existe.

- [ ] **Passo 3: implementar o estado**

Em `app/app/agenda/_client.tsx`, ao lado de `const [contactId,setContactId]=React.useState("");`
(linha 103):

```tsx
  // UMA observação por compromisso, de quem está marcando. Não é histórico:
  // decisão do dono do produto — "o agendamento é individual".
  const [observacao, setObservacao] = React.useState("");
```

- [ ] **Passo 4: implementar o campo**

Logo **depois** do bloco do e-mail do convidado (o `<p id="ajuda-do-convidado">`,
hoje na linha 598):

```tsx
            <label className="mt-3 block text-xs font-medium text-text-muted" htmlFor="observacao-do-compromisso">
              {t("Observação")}{" "}
              <span className="font-normal">{t("(só você e quem atende veem)")}</span>
            </label>
            <textarea
              id="observacao-do-compromisso"
              data-testid="observacao-do-compromisso"
              rows={3}
              maxLength={2000}
              className="mt-1 w-full rounded-md border bg-surface p-2 text-sm"
              value={observacao}
              onChange={(e) => setObservacao(e.target.value)}
              placeholder={t("O que lembrar para esta reunião, call ou visita")}
            />
```

- [ ] **Passo 5: mandar no corpo**

No `marcar.mutateAsync({...})` (linha 683) acrescente `notes: observacao || undefined,`
e no `.then(...)` acrescente `setObservacao("");`.

No `remarcar.mutateAsync({...})` (linha 674) acrescente `notes: observacao || undefined,`.

⚠️ `|| undefined` e **nunca** a string vazia — pelo mesmo motivo já escrito no
arquivo para o convidado: o PATCH leria `""` como "apague a observação".

- [ ] **Passo 6: rodar e ver passar**

```bash
npx playwright test tests/e2e/agenda-observacao.spec.ts
pnpm typecheck && pnpm lint
```

- [ ] **Passo 7: commitar**

```bash
git add app/app/agenda/_client.tsx tests/e2e/agenda-observacao.spec.ts
git commit -m "feat(agenda): a observacao do compromisso ganha lugar na tela"
```

---

### Task 7: O e-mail do convidado vem preenchido

**Files:**
- Create: `lib/agenda/email-do-convidado.ts`
- Create: `tests/unit/email-do-convidado.test.ts`
- Modify: `app/api/v1/agenda/vinculos/route.ts:18` (`select("id,name")` → `select("id,name,email")`)
- Modify: `app/app/agenda/_client.tsx` (usar a regra ao trocar de cliente)

**Interfaces:**
- Produces: `emailDoConvidadoAoTrocarDeCliente({ atual, tocado, emailDoCliente }):
  string` — regra pura, sem React e sem rede.

- [ ] **Passo 1: escrever o teste que falha**

Crie `tests/unit/email-do-convidado.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { emailDoConvidadoAoTrocarDeCliente } from "@/lib/agenda/email-do-convidado";

/**
 * O e-mail já estava no sistema e era digitado à mão.
 *
 * `contacts.email` existe. O campo "E-mail do convidado" nascia vazio, e quem
 * marcava redigitava um endereço que o CRM já tinha.
 *
 * O cuidado que decide o desenho é o AVESSO do defeito do cliente herdado:
 * preencher por cima do que alguém digitou é tão ruim quanto herdar o cliente
 * da abertura anterior. Só preenche campo INTOCADO.
 */
describe("preencher o e-mail do convidado sem atropelar ninguém", () => {
  it("campo intocado recebe o e-mail do cliente", () => {
    expect(
      emailDoConvidadoAoTrocarDeCliente({ atual: "", tocado: false, emailDoCliente: "ana@exemplo.com" }),
    ).toBe("ana@exemplo.com");
  });

  it("campo DIGITADO à mão não é sobrescrito", () => {
    expect(
      emailDoConvidadoAoTrocarDeCliente({
        atual: "outro@exemplo.com",
        tocado: true,
        emailDoCliente: "ana@exemplo.com",
      }),
    ).toBe("outro@exemplo.com");
  });

  it("cliente sem e-mail deixa o campo vazio, como hoje", () => {
    expect(
      emailDoConvidadoAoTrocarDeCliente({ atual: "", tocado: false, emailDoCliente: null }),
    ).toBe("");
  });

  it("trocar de cliente troca o preenchimento, enquanto ninguém digitou", () => {
    expect(
      emailDoConvidadoAoTrocarDeCliente({
        atual: "ana@exemplo.com",
        tocado: false,
        emailDoCliente: "bruno@exemplo.com",
      }),
    ).toBe("bruno@exemplo.com");
  });

  it("CONTROLE: tirar o cliente esvazia o campo intocado, e só ele", () => {
    expect(
      emailDoConvidadoAoTrocarDeCliente({ atual: "ana@exemplo.com", tocado: false, emailDoCliente: null }),
    ).toBe("");
    expect(
      emailDoConvidadoAoTrocarDeCliente({ atual: "eu@exemplo.com", tocado: true, emailDoCliente: null }),
    ).toBe("eu@exemplo.com");
  });
});
```

- [ ] **Passo 2: rodar e ver falhar**

```bash
npx vitest run tests/unit/email-do-convidado.test.ts --reporter=verbose
```

Esperado: FAIL — módulo não resolvido.

- [ ] **Passo 3: implementar a regra**

Crie `lib/agenda/email-do-convidado.ts`:

```ts
/**
 * Quando preencher o e-mail do convidado — e quando NÃO tocar nele.
 *
 * O endereço já existe em `contacts.email`, e o campo nascia vazio: quem marcava
 * redigitava o que o CRM já sabia.
 *
 * O cuidado que decide o desenho é o AVESSO do defeito do cliente herdado.
 * Naquele, o painel abria com o cliente da vez anterior e marcava compromisso no
 * nome de outra pessoa. Aqui o risco é escrever por cima do endereço que alguém
 * digitou de propósito — e essa pessoa só descobriria depois do convite enviado.
 */
export function emailDoConvidadoAoTrocarDeCliente({
  atual,
  tocado,
  emailDoCliente,
}: {
  /** O que está no campo agora. */
  atual: string;
  /** Alguém digitou nele nesta abertura do painel? */
  tocado: boolean;
  /** O e-mail do cliente recém-escolhido, quando ele tem um. */
  emailDoCliente: string | null | undefined;
}): string {
  // Digitado à mão manda, sempre — inclusive quando o cliente novo tem e-mail.
  if (tocado) return atual;
  return emailDoCliente ?? "";
}
```

- [ ] **Passo 4: rodar e ver passar**

```bash
npx vitest run tests/unit/email-do-convidado.test.ts --reporter=verbose
```

- [ ] **Passo 5: a rota devolver o e-mail**

Em `app/api/v1/agenda/vinculos/route.ts:18`, troque:

```ts
    .select("id,name")
```

por:

```ts
    // `email` entra aqui para o painel preencher o convidado sem redigitação.
    // É o mesmo contato que a pessoa acabou de escolher na mesma tela — não
    // amplia alcance: a consulta já roda sob RLS com o `organization_id` dela.
    .select("id,name,email")
```

- [ ] **Passo 6: usar a regra no painel**

Em `app/app/agenda/_client.tsx`, ao lado do estado do convidado, acrescente o
marcador de "alguém digitou":

```tsx
  // Sem este marcador não há como distinguir "campo vazio porque ninguém mexeu"
  // de "campo vazio porque alguém apagou de propósito" — e a segunda leitura é
  // a que não pode ser atropelada.
  const [convidadoTocado, setConvidadoTocado] = React.useState(false);
```

No `onChange` do input `email-do-convidado`, acrescente `setConvidadoTocado(true);`.
No `onChange` do `VinculoDaMarcacao` (linha 537), acrescente:

```tsx
                setEmailConvidado(
                  emailDoConvidadoAoTrocarDeCliente({
                    atual: emailConvidado,
                    tocado: convidadoTocado,
                    emailDoCliente: emailDoContatoEscolhido,
                  }),
                );
```

onde `emailDoContatoEscolhido` vem da lista que o `VinculoDaMarcacao` já carrega —
passe-o como terceiro argumento do `onChange` do componente
(`onChange: (contact: string, conversation: string, email?: string | null) => void`).

E no fechamento do painel (linha 467, junto de `setContactId("")`), acrescente
`setConvidadoTocado(false);` — reabrir começa limpo, pela mesma razão do cliente.

- [ ] **Passo 7: gates e commit**

```bash
pnpm typecheck && pnpm lint
npx vitest run tests/unit/email-do-convidado.test.ts --reporter=verbose
git add lib/agenda/email-do-convidado.ts tests/unit/email-do-convidado.test.ts app/api/v1/agenda/vinculos/route.ts app/app/agenda/_client.tsx components/agenda/VinculoDaMarcacao.tsx
git commit -m "feat(agenda): o e-mail do convidado vem preenchido, e nao atropela quem digitou"
```

---

### Fecho da Onda 3

- [ ] Suíte inteira, `pnpm typecheck`, `pnpm lint`
- [ ] Publicar a tag; Paulo clica
- [ ] **Provar na tela:**
  - [ ] escolher cliente num campo só, com "Compromisso pessoal" como padrão
  - [ ] fechar e reabrir o painel **não** herda cliente nenhum
  - [ ] a observação aparece no detalhe e sobrevive a remarcar
  - [ ] o e-mail chega preenchido e continua editável
  - [ ] e-mail digitado à mão **não** é sobrescrito ao trocar de cliente

---
# ONDA 4 — remarcar corrige sozinho, e o botão destrava

**O que esta onda entrega:** B.6. Hoje, remarcar um compromisso cujo link já foi
enviado **não** avisa o cliente — e o botão fica preso em *"Link já enviado"*,
então nem à mão dá para corrigir. O cliente aparece no dia errado.

**Decisão do dono do produto: os DOIS.** O automático cobre quem remarcou e foi
embora; o manual cobre o caso em que a correção automática não saiu (atendimento
mudou, canal fora) e alguém precisa agir.

**O que já está medido e NÃO precisa ser construído:** todas as proteções. A
vigência da entrega reconfere fronteira de atendimento, dono, papel,
anonimização e bloqueio **no momento do envio**, não no clique
(`fn_meet_delivery_current`); e `current_intent` no `fn_meet_delivery_settle`
impede um job órfão de escrever estado por cima da entrega nova. Não há guarda
nova a inventar — só a de repetição.

---

### Task 8: O texto que diz que MUDOU

**Files:**
- Create: `lib/agenda/texto-do-compromisso.ts`
- Create: `tests/unit/texto-do-compromisso.test.ts`
- Modify: `lib/agent-engine/agent/meet-delivery.ts:96-101` (escolher o texto pelo motivo)

**Interfaces:**
- Produces: `textoDaEntrega({ motivo, startsAt, timeZone, url, idioma }): string`,
  com `motivo: "primeiro_envio" | "remarcado" | "reenvio_manual"`.
- Consumes: `traduzir` e `tagDeIdioma`, já usados por `meetingDeliveryBody`.

⚠️ **Por que não reaproveitar a frase atual:** hoje ela é *"Sua reunião está
marcada para…"*. Receber isso **duas vezes, com datas diferentes e sem
explicação**, é pior que o silêncio — a pessoa não sabe qual das duas vale.

- [ ] **Passo 1: escrever o teste que falha**

Crie `tests/unit/texto-do-compromisso.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { textoDaEntrega } from "@/lib/agenda/texto-do-compromisso";

const BASE = {
  startsAt: "2026-09-24T12:30:00.000Z",
  timeZone: "America/Sao_Paulo",
  url: "https://meet.google.com/abc-defg-hij",
  idioma: "pt" as const,
};

describe("o texto diz o que aconteceu", () => {
  it("primeiro envio: a frase de sempre", () => {
    const t = textoDaEntrega({ ...BASE, motivo: "primeiro_envio" });
    expect(t).toMatch(/está marcada para/i);
    expect(t).not.toMatch(/mudou|alterad/i);
  });

  it("remarcado: diz que MUDOU, e dá o horário novo", () => {
    const t = textoDaEntrega({ ...BASE, motivo: "remarcado" });
    expect(t).toMatch(/mudou/i);
    expect(t).toMatch(/24\/09/);
  });

  it("os dois formatam no fuso do COMPROMISSO, não no do servidor", () => {
    // 12:30 UTC é 09:30 em São Paulo. O molde que já existia acertava isto, e
    // perder o acerto ao criar a variação seria trocar um defeito por outro.
    for (const motivo of ["primeiro_envio", "remarcado"] as const) {
      expect(textoDaEntrega({ ...BASE, motivo })).toMatch(/09:30/);
    }
  });

  it("compromisso sem link não inventa link", () => {
    const t = textoDaEntrega({ ...BASE, url: null, motivo: "remarcado" });
    expect(t).not.toMatch(/meet\.google\.com/);
    expect(t).toMatch(/mudou/i);
  });

  it("CONTROLE: reenvio manual usa a frase do primeiro envio", () => {
    // Quem clica "Enviar de novo" quer que o cliente receba os dados, não um
    // aviso de mudança que pode não ter havido.
    expect(textoDaEntrega({ ...BASE, motivo: "reenvio_manual" })).toMatch(/está marcada para/i);
  });
});
```

- [ ] **Passo 2: rodar e ver falhar**

```bash
npx vitest run tests/unit/texto-do-compromisso.test.ts --reporter=verbose
```

- [ ] **Passo 3: implementar**

Crie `lib/agenda/texto-do-compromisso.ts`:

```ts
import { tagDeIdioma } from "@/lib/i18n/datas";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";

export type MotivoDaEntrega = "primeiro_envio" | "remarcado" | "reenvio_manual";

/**
 * O texto que chega ao cliente.
 *
 * Nasce do molde que já existia (`meetingDeliveryBody`), e mantém as duas coisas
 * que ele acertava e que costumam dar errado: formata no fuso do COMPROMISSO
 * (não no do servidor) e traduz para o idioma do CONTATO (não o de quem marcou).
 *
 * O que ele acrescenta é uma frase para a REMARCAÇÃO. Mandar "Sua reunião está
 * marcada para…" duas vezes, com datas diferentes e sem explicação, é pior que
 * o silêncio: a pessoa não sabe qual das duas vale.
 */
export function textoDaEntrega({
  motivo,
  startsAt,
  timeZone,
  url,
  idioma,
}: {
  motivo: MotivoDaEntrega;
  startsAt: string;
  timeZone: string;
  url: string | null;
  idioma: Idioma;
}): string {
  const quando = new Intl.DateTimeFormat(tagDeIdioma(idioma), {
    dateStyle: "short",
    timeStyle: "short",
    timeZone,
  }).format(new Date(startsAt));

  const abertura =
    motivo === "remarcado"
      ? traduzir("O horário da sua reunião mudou. Agora é", idioma)
      : traduzir("Sua reunião está marcada para", idioma);

  const link = url ? ` ${traduzir("Link do Google Meet:", idioma)} ${url}` : "";
  return `${abertura} ${quando} (${timeZone}).${link}`;
}
```

- [ ] **Passo 4: rodar e ver passar**

```bash
npx vitest run tests/unit/texto-do-compromisso.test.ts --reporter=verbose
```

- [ ] **Passo 5: usar no trabalhador**

Em `lib/agent-engine/agent/meet-delivery.ts`, troque a chamada de
`meetingDeliveryBody(...)` (linha 96) por:

```ts
          body: textoDaEntrega({
            // O motivo viaja no payload do job, posto pelo gatilho que
            // reenfileira a correção (migration 0241). Sem ele, o padrão é o
            // primeiro envio — que é o comportamento de antes desta onda.
            motivo: (job.payload.motivo as MotivoDaEntrega | undefined) ?? "primeiro_envio",
            startsAt: row.starts_at,
            timeZone: row.time_zone,
            url,
            idioma: normalizarIdioma(row.contact_locale ?? row.organization_locale),
          }),
```

E acrescente o import:

```ts
import { textoDaEntrega, type MotivoDaEntrega } from "@/lib/agenda/texto-do-compromisso";
```

⚠️ **Não apague `meetingDeliveryBody`.** Ela é exportada e há teste em cima dela;
deixe-a delegando para `textoDaEntrega` com `motivo: "primeiro_envio"`, para que
nenhum chamador existente mude de comportamento.

- [ ] **Passo 6: gates e commit**

```bash
pnpm typecheck && pnpm lint
npx vitest run tests/unit/texto-do-compromisso.test.ts tests/unit/agenda-meet-routes.test.ts --reporter=verbose
git add lib/agenda/texto-do-compromisso.ts tests/unit/texto-do-compromisso.test.ts lib/agent-engine/agent/meet-delivery.ts
git commit -m "feat(agenda): o texto da entrega sabe dizer que o horario MUDOU"
```

---

### Task 9: Remarcar reenfileira a correção (migration 0241)

**Files:**
- Create: `supabase/migrations/20260913000000_0241_remarcar_corrige_o_envio.sql`
- Modify: `supabase/baseline.sql` (apêndice idempotente, **antes** do bloco final de varredura da anon)
- Modify: `supabase/migrations/MANIFEST.md`
- Create: `tests/invariants/remarcar-corrige-o-envio.test.ts`

**Interfaces:**
- Produces: `public.fn_remarcar_corrige_o_envio()` (gatilho BEFORE UPDATE em
  `calendar_appointments`) e a ação `'resend'` em `public.fn_meet_action`.
- Consumes: `fn_meet_delivery_enqueue()`, que passa a ler `nao_antes_de` e
  `motivo` do `meeting_delivery`.

⚠️ **Número da migration:** confira antes de criar o arquivo —
`ls supabase/migrations/ | grep -oE '_[0-9]{4}_' | tr -d _ | sort -n | tail -1`
devolvia `0240` em 2026-09-12. Se já houver `0241`, use o próximo.

- [ ] **Passo 1: escrever o invariante que falha**

Crie `tests/invariants/remarcar-corrige-o-envio.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { sql } from "./helpers/db";

/**
 * Remarcar depois de enviar deixava o cliente com o horário errado.
 *
 * Medido no código em 2026-09-12: o gatilho de remarcação não tocava em
 * `meeting_delivery`; o de enfileirar só age em `waiting_for_link`; e a tela
 * desabilitava o botão com "Link já enviado". Nenhuma varredura cobria o buraco
 * — `fn_appointment_confirmation_sweep` só age DEPOIS que o compromisso termina,
 * e o que ela cria é aviso interno, nunca mensagem ao cliente.
 */
describe("remarcar corrige o envio", () => {
  it("mudar o HORÁRIO de um compromisso já enviado reenfileira a correção", async () => {
    const { id } = await semearCompromissoEnviado();
    await sql`update calendar_appointments set starts_at = starts_at + interval '1 day' where id = ${id}`;
    const [linha] = await sql`select meeting_delivery from calendar_appointments where id = ${id}`;
    expect(linha.meeting_delivery.state).toBe("queued");
    expect(linha.meeting_delivery.motivo).toBe("remarcado");
  });

  it("mudar o FUSO também — é o outro campo que entra no texto", async () => {
    const { id } = await semearCompromissoEnviado();
    await sql`update calendar_appointments set time_zone = 'America/Manaus' where id = ${id}`;
    const [linha] = await sql`select meeting_delivery from calendar_appointments where id = ${id}`;
    expect(linha.meeting_delivery.motivo).toBe("remarcado");
  });

  it("⛔ mudar só o TÍTULO não manda nada", async () => {
    // A guarda que impede o conserto de virar defeito novo: reagir a qualquer
    // `update` na linha faria uma edição de título mandar link ao cliente.
    const { id } = await semearCompromissoEnviado();
    await sql`update calendar_appointments set title = 'Outro nome' where id = ${id}`;
    const [linha] = await sql`select meeting_delivery from calendar_appointments where id = ${id}`;
    expect(linha.meeting_delivery.state).toBe("sent");
  });

  it("⛔ compromisso CANCELADO não recebe correção", async () => {
    const { id } = await semearCompromissoEnviado();
    await sql`update calendar_appointments set status = 'cancelled', starts_at = starts_at + interval '1 day' where id = ${id}`;
    const [linha] = await sql`select meeting_delivery from calendar_appointments where id = ${id}`;
    expect(linha.meeting_delivery.state).not.toBe("queued");
  });

  it("ANTIRREPETIÇÃO: duas remarcações seguidas deixam UM job vivo", async () => {
    // Arrastar o compromisso cinco vezes na grade não pode virar cinco
    // mensagens. A correção entra com 2 minutos de espera, e uma remarcação nova
    // dentro da janela substitui a anterior: a geração muda, e o job velho
    // reprova na vigência e se cancela sozinho.
    const { id, org } = await semearCompromissoEnviado();
    await sql`update calendar_appointments set starts_at = starts_at + interval '1 day' where id = ${id}`;
    await sql`update calendar_appointments set starts_at = starts_at + interval '2 days' where id = ${id}`;
    const vivos = await sql`
      select id from job_queue
       where organization_id = ${org} and kind = 'transactional_delivery'
         and status in ('pending','running')`;
    expect(vivos.length).toBe(1);
  });

  it("a correção espera 2 minutos antes de sair", async () => {
    const { id, org } = await semearCompromissoEnviado();
    await sql`update calendar_appointments set starts_at = starts_at + interval '1 day' where id = ${id}`;
    const [job] = await sql`
      select run_after, now() as agora from job_queue
       where organization_id = ${org} and kind = 'transactional_delivery' and status = 'pending'`;
    expect(new Date(job.run_after).getTime()).toBeGreaterThan(new Date(job.agora).getTime() + 60_000);
  });

  it("CONTROLE: compromisso que NUNCA foi enviado não ganha entrega ao ser remarcado", async () => {
    const { id } = await semearCompromissoSemEnvio();
    await sql`update calendar_appointments set starts_at = starts_at + interval '1 day' where id = ${id}`;
    const [linha] = await sql`select meeting_delivery from calendar_appointments where id = ${id}`;
    expect(linha.meeting_delivery?.state ?? null).not.toBe("queued");
  });
});
```

⚠️ `semearCompromissoEnviado()` e `semearCompromissoSemEnvio()` são auxiliares
deste arquivo: criam organização, contato, conversa com atendimento aberto e o
compromisso, e no primeiro caso deixam `meeting_delivery` em
`{"state":"sent", …}` com `service_boundary` corrente. Siga o molde de
`tests/invariants/agenda-meet.test.ts`, que já semeia essa mesma árvore.

- [ ] **Passo 2: rodar e ver falhar**

```bash
pnpm test:db
```

Esperado: os seis casos vermelhos — `meeting_delivery.state` continua `sent`.

- [ ] **Passo 3: escrever a migration**

Crie `supabase/migrations/20260913000000_0241_remarcar_corrige_o_envio.sql`:

```sql
-- 0241 — Remarcar um compromisso já enviado CORRIGE o cliente, e o botão destrava
--
-- Medido em 2026-09-12: o cliente recebia "marcado para 24/09 às 09:30", alguém
-- remarcava, e nada saía. O gatilho de remarcação não tocava em
-- `meeting_delivery`; o de enfileirar só age em `waiting_for_link`; e a tela
-- desabilitava o botão com "Link já enviado". A pessoa aparecia no dia errado.
--
-- O que já funcionava e continua: remarcar ANTES de o trabalhador enviar sai com
-- o horário NOVO — o texto é montado na hora do envio, de um select fresco.

create or replace function public.fn_remarcar_corrige_o_envio()
returns trigger language plpgsql security definer set search_path=public as $$
begin
 if tg_op <> 'UPDATE' then return new; end if;
 -- Cancelado não recebe correção: avisar cancelamento é outra funcionalidade,
 -- e mandar "o horário mudou" de um compromisso que não existe mais é pior que
 -- calar.
 if new.status = 'cancelled' then return new; end if;
 -- Só quem JÁ recebeu. Quem está em `waiting_for_link`/`queued` já vai sair com
 -- o horário novo sozinho, porque o texto é montado no envio.
 if coalesce(new.meeting_delivery->>'state','') <> 'sent' then return new; end if;
 -- APENAS os campos que entram no texto da mensagem. Reagir a qualquer `update`
 -- na linha faria uma edição de título mandar link ao cliente.
 if row(new.starts_at, new.time_zone) is not distinct from row(old.starts_at, old.time_zone) then
  return new;
 end if;

 -- Geração nova: é ela que faz o job anterior (se houver) reprovar na vigência
 -- e se cancelar sozinho, em vez de duas mensagens saírem.
 new.meeting_delivery := jsonb_build_object(
   'state','waiting_for_link',
   'generation', gen_random_uuid(),
   'service_boundary', old.meeting_delivery->'service_boundary',
   'channel_session_id', old.meeting_delivery->>'channel_session_id',
   -- Quem autorizou o envio original autoriza a correção: é a mesma intenção,
   -- corrigida. E a vigência RECONFERE no envio se essa pessoa ainda é a
   -- responsável e ainda tem papel — se não for, a correção não sai e abre
   -- aviso na Central, que é o comportamento certo.
   'authorized_by', old.meeting_delivery->'authorized_by',
   'source_operation_id', gen_random_uuid(),
   'motivo','remarcado',
   -- ANTIRREPETIÇÃO: arrastar o compromisso cinco vezes na grade não pode virar
   -- cinco mensagens. Dentro da janela, a remarcação seguinte substitui esta.
   'nao_antes_de', (now() + interval '2 minutes')::text);
 new.meeting_delivery_job_id := null;
 return new;
end;$$;
revoke execute on function public.fn_remarcar_corrige_o_envio() from public, anon, authenticated;

drop trigger if exists trg_remarcar_corrige_o_envio on public.calendar_appointments;
create trigger trg_remarcar_corrige_o_envio
  before update on public.calendar_appointments
  for each row execute function public.fn_remarcar_corrige_o_envio();

-- O enfileirador passa a respeitar a espera e a carregar o motivo.
create or replace function public.fn_meet_delivery_enqueue()
returns trigger language plpgsql security definer set search_path=public as $$
declare jid uuid; b jsonb;
begin
 perform public.fn_service_lock(new.organization_id,new.contact_id);
 if new.meeting_state='cancelled' or new.meeting_delivery->>'state' in ('blocked','stale') then
  update public.job_queue set status='failed',locked_at=null,locked_by=null,payload='{}',last_error='meet_delivery_stale'
   where organization_id=new.organization_id and id=new.meeting_delivery_job_id and kind='transactional_delivery' and status in ('pending','running');
  return new;
 end if;
 if new.meeting_state='failed' then perform public.fn_meet_notice(new.organization_id,new.id,'meeting_failed');end if;
 if new.meeting_state<>'ready' or new.meeting_delivery->>'state'<>'waiting_for_link' then return new;end if;
 b:=new.meeting_delivery->'service_boundary';
 if not public.fn_meet_boundary_current(b) then
  update public.calendar_appointments set meeting_delivery=meeting_delivery||'{"state":"stale","error":"service_boundary_stale"}' where organization_id=new.organization_id and id=new.id;
  perform public.fn_meet_notice(new.organization_id,new.id,'service_boundary_stale');return new;
 end if;
 -- Um job pendente da geração anterior é morto AQUI, e não deixado para a
 -- vigência: assim a antirrepetição vale mesmo com o trabalhador parado.
 update public.job_queue set status='failed',locked_by=null,locked_at=null,last_error='meet_delivery_superseded'
  where organization_id=new.organization_id and id=new.meeting_delivery_job_id and kind='transactional_delivery' and status in ('pending','running');
 jid:=gen_random_uuid();
 insert into public.job_queue(id,organization_id,contact_id,kind,payload,run_after)
 values(jid,new.organization_id,new.contact_id,'transactional_delivery',jsonb_build_object('appointment_id',new.id,'meeting_request_id',new.meeting_request_id,
  'delivery_generation',new.meeting_delivery->>'generation','service_boundary',b,
  'motivo',coalesce(new.meeting_delivery->>'motivo','primeiro_envio')),
  coalesce((new.meeting_delivery->>'nao_antes_de')::timestamptz, now()));
 update public.calendar_appointments set meeting_delivery_job_id=jid,meeting_delivery=meeting_delivery||'{"state":"queued"}'
  where organization_id=new.organization_id and id=new.id;
 return new;
end;$$;
revoke all on function public.fn_meet_delivery_enqueue() from public,anon,authenticated;
```

⚠️ **Não recrie o gatilho `trg_meet_delivery_enqueue`** — `create or replace
function` já troca o corpo, e recriar o gatilho reintroduz a janela de
apagar-e-criar que esta mesma entrega está consertando na Onda 1.

- [ ] **Passo 4: acrescentar a ação `resend` (mesma migration)**

Acrescente ao fim do arquivo o `create or replace function public.fn_meet_action(...)`
**inteiro**, copiado da migration 0226, com **duas** mudanças:

```sql
 -- (1) na validação da ação, `resend` é aceita:
 --     elsif p_action in ('deliver','resend') then
 --
 -- (2) dentro desse ramo, o curto-circuito de idempotência passa a valer só
 --     para `deliver`:
 --
 --   if a.meeting_delivery->'service_boundary'=b and a.meeting_delivery->>'channel_session_id'=destination_channel::text then
 --    if p_action='deliver' and a.meeting_delivery->>'state' in ('waiting_for_link','sent') then return false;end if;
 --    ...
 --
 -- ⛔ POR QUE UMA AÇÃO NOVA, E NÃO SÓ HABILITAR O BOTÃO.
 -- O `return false` em estado `sent` NÃO é sobra: é a proteção contra CLIQUE
 -- DUPLO — é ele que impede a mesma mensagem de sair duas vezes por um clique
 -- nervoso. Reescrever esse ramo ganharia o reenvio e perderia a proteção. Por
 -- isso o reenvio explícito é uma ação separada, que a tela só dispara depois de
 -- confirmação, e o `deliver` continua exatamente como está.
 --
 -- (3) e o `meeting_delivery` reconstruído nesse ramo ganha o motivo:
 --     'motivo', case when p_action='resend' then 'reenvio_manual' else 'primeiro_envio' end
```

- [ ] **Passo 5: espelhar no baseline e no MANIFEST**

```bash
# O apêndice vai ANTES do bloco final de varredura da anon, que precisa ficar por último.
grep -n "varredura" supabase/baseline.sql | tail -3
```

Copie o conteúdo da migration para o apêndice do `supabase/baseline.sql` sob o
rótulo `-- ---- remarcar corrige o envio (migration 0241) ----`, e acrescente a
linha em `supabase/migrations/MANIFEST.md`.

- [ ] **Passo 6: rodar e ver passar**

```bash
pnpm test:db
```

- [ ] **Passo 7: commitar — a tripla no MESMO commit**

```bash
git add supabase/migrations/20260913000000_0241_remarcar_corrige_o_envio.sql supabase/baseline.sql supabase/migrations/MANIFEST.md tests/invariants/remarcar-corrige-o-envio.test.ts
git commit -m "fix(agenda): remarcar um compromisso ja enviado corrige o cliente"
```

---

### Task 10: O botão "Enviar de novo"

**Files:**
- Create: `app/api/v1/agenda/agendamentos/[id]/google/meet/resend/route.ts`
- Modify: `app/api/v1/agenda/agendamentos/[id]/google/meet/_action.ts` (aceitar `"resend"`)
- Modify: `components/agenda/MeetDoCompromisso.tsx:150-170`
- Modify: `tests/unit/agenda-meet-ui.test.tsx`

**Interfaces:**
- Consumes: `fn_meet_action(..., 'resend', ...)` da Task 9.
- Produces: `POST /api/v1/agenda/agendamentos/:id/google/meet/resend`.

- [ ] **Passo 1: escrever o teste de tela que falha**

Acrescente a `tests/unit/agenda-meet-ui.test.tsx`:

```tsx
it('⛔ estado "enviado" NÃO prende mais o botão', async () => {
  // Antes: `alreadyAuthorized` deixava o botão desabilitado com "Link já
  // enviado", e não havia como corrigir um horário remarcado pela tela.
  render(<MeetDoCompromisso {...props({ delivery_state: "sent" })} />);
  const botao = screen.getByRole("button", { name: /enviar de novo/i });
  expect(botao).toBeEnabled();
});

it("pede confirmação antes de mandar de novo", async () => {
  // A confirmação é o que substitui a proteção de clique duplo que o
  // `return false` do banco dá ao `deliver`.
  render(<MeetDoCompromisso {...props({ delivery_state: "sent" })} />);
  await userEvent.click(screen.getByRole("button", { name: /enviar de novo/i }));
  expect(screen.getByRole("dialog")).toHaveTextContent(/mandar de novo/i);
});

it("CONTROLE: sem atendimento aberto, o botão fica desabilitado e explicado", () => {
  render(<MeetDoCompromisso {...props({ delivery_state: "sent", destinations: [] })} />);
  expect(screen.getByRole("button", { name: /enviar/i })).toBeDisabled();
  expect(screen.getByText(/nenhum atendimento aberto/i)).toBeInTheDocument();
});
```

- [ ] **Passo 2: rodar e ver falhar**

```bash
npx vitest run tests/unit/agenda-meet-ui.test.tsx --reporter=verbose
```

- [ ] **Passo 3: a rota**

Crie `app/api/v1/agenda/agendamentos/[id]/google/meet/resend/route.ts`:

```ts
import { requireSupportWrite } from "@/lib/impersonate/support";
import { meetingAction } from "../_action";
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const denied = await requireSupportWrite();
  if (denied) return denied;
  return meetingAction(req, context, "resend");
}
```

E em `_action.ts`, troque a assinatura
`action: "retry" | "deliver"` por `action: "retry" | "deliver" | "resend"`, e a
guarda `(action === "deliver" && !parsed.data.conversation_id)` por
`(action !== "retry" && !parsed.data.conversation_id)`.

- [ ] **Passo 4: a tela**

Em `components/agenda/MeetDoCompromisso.tsx`, troque o cálculo de
`alreadyAuthorized` e o `<Button>` por:

```tsx
  // "Já enviado" deixa de TRANCAR: vira o rótulo da ação de reenviar. O que
  // impede envio em dobro por clique nervoso é a confirmação abaixo, e do lado
  // do banco o `deliver` continua devolvendo `false` em estado `sent`.
  const jaEnviado =
    meeting.delivery_authorization_current === true &&
    meeting.delivery_conversation_id === sendTo &&
    meeting.delivery_state === "sent";
  const aguardando =
    meeting.delivery_authorization_current === true &&
    meeting.delivery_conversation_id === sendTo &&
    ["waiting_for_link", "queued"].includes(meeting.delivery_state);
```

```tsx
          <Button
            size="sm"
            disabled={!sendTo || action.isPending || meeting.state === "failed" || aguardando}
            onClick={() => (jaEnviado ? setConfirmando(true) : action.mutate("deliver"))}
          >
            {t(
              aguardando
                ? "Envio já autorizado"
                : jaEnviado
                  ? "Enviar de novo"
                  : meeting.state === "ready"
                    ? "Enviar link ao cliente"
                    : "Enviar quando ficar pronto",
            )}
          </Button>
          {confirmando ? (
            <div role="dialog" aria-label={t("Confirmar reenvio")} className="rounded-md border p-3 text-sm">
              <p>{t("Mandar de novo os dados desta reunião para o cliente?")}</p>
              <div className="mt-2 flex gap-2">
                <Button size="sm" onClick={() => { setConfirmando(false); action.mutate("resend"); }}>
                  {t("Mandar de novo")}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmando(false)}>
                  {t("Cancelar")}
                </Button>
              </div>
            </div>
          ) : null}
```

E acrescente o estado `const [confirmando, setConfirmando] = useState(false);`, e
`"resend"` ao tipo do `mutationFn`.

- [ ] **Passo 5: rodar e ver passar**

```bash
npx vitest run tests/unit/agenda-meet-ui.test.tsx --reporter=verbose
pnpm typecheck && pnpm lint
```

- [ ] **Passo 6: fragmento e commit**

Crie `.changes/remarcar-corrige-o-cliente.md`:

```markdown
---
efeito: capacidade_nova
---

Remarcar um compromisso cujo link já foi enviado passa a avisar o cliente com o
horário novo, e o botão deixa de ficar preso em "Link já enviado" — vira "Enviar
de novo", com confirmação.
```

```bash
git add app/api/v1/agenda/agendamentos/ components/agenda/MeetDoCompromisso.tsx tests/unit/agenda-meet-ui.test.tsx .changes/remarcar-corrige-o-cliente.md
git commit -m "feat(agenda): o botao destrava — enviar de novo, com confirmacao"
```

---

### Fecho da Onda 4

- [ ] Suíte inteira, `pnpm typecheck`, `pnpm lint`, `pnpm test:db`
- [ ] Publicar a tag; Paulo clica
- [ ] **Provar na tela:**
  - [ ] remarcar um compromisso já enviado faz o cliente receber a **correção**,
        com o horário novo e a frase dizendo que mudou
  - [ ] arrastar o compromisso várias vezes seguidas manda **uma** mensagem só
  - [ ] editar só o título **não** manda nada
  - [ ] o botão diz "Enviar de novo" e pede confirmação
  - [ ] clique duplo em "Enviar link ao cliente" continua mandando **uma** vez

---
# ONDA 5 — mandar o compromisso ao cliente pelo WhatsApp

**O que esta onda entrega:** B.4. Hoje só o compromisso **com Google Meet** chega
ao cliente, porque a entrega inteira exige `meeting_state='ready'` e
`meeting_url is not null`. Um compromisso presencial ou por telefone não tem como
ser mandado.

**Por que é a onda mais tardia:** ela **afrouxa guardas** de uma máquina que
protege envio de mensagem a cliente. Vem depois de as outras estarem provadas, e
cada guarda afrouxada ganha o seu caso de controle.

**O mecanismo já existe, medido:** `job_queue.kind = 'transactional_delivery'`
resolve fila, canal, fronteira de atendimento e autorização. O que muda é **para
quais compromissos** ele vale.

⚠️ **Restrição herdada, e não negociável:** a entrega exige **atendimento
aberto** naquela conversa. Foi essa regra que recusou o envio do link em
2026-09-12 (`meet_conversation_stale`). A tela diz isso **antes** do clique.

⚠️ **Opt-out:** contato com `is_blocked` não recebe. Marcar consulta não é
consentir em receber mensagem, e esta funcionalidade não contorna a doutrina.

---

### Task 11: A entrega deixa de exigir link (migration 0242)

**Files:**
- Create: `supabase/migrations/20260913010000_0242_entrega_do_compromisso_sem_meet.sql`
- Modify: `supabase/baseline.sql` (apêndice) e `supabase/migrations/MANIFEST.md`
- Modify: `tests/invariants/agenda-meet.test.ts` (casos novos)

**Interfaces:**
- Produces: `fn_meet_delivery_current` e `fn_meet_action` passam a tratar as
  exigências de Meet como **condicionais a `location_kind='google_meet'`**.
- Consumes: `textoDaEntrega` (Task 8), que já trata `url: null`.

- [ ] **Passo 1: escrever os invariantes que falham**

Acrescente a `tests/invariants/agenda-meet.test.ts`:

```ts
describe("compromisso SEM Meet também chega ao cliente", () => {
  it("presencial com atendimento aberto entra na fila", async () => {
    const { id, org } = await semearCompromisso({ location_kind: "in_person" });
    await autorizarEntrega(id);
    const [linha] = await sql`select meeting_delivery from calendar_appointments where id = ${id}`;
    expect(linha.meeting_delivery.state).toBe("queued");
  });

  it("⛔ compromisso COM Meet continua exigindo o link pronto", async () => {
    // O controle que impede o afrouxamento de virar buraco: onde o Meet é o
    // local, mandar antes do link é mandar uma reunião sem como entrar nela.
    const { id } = await semearCompromisso({ location_kind: "google_meet", meeting_state: "pending" });
    await expect(autorizarEntrega(id)).rejects.toThrow(/meet_stale/);
  });

  it("⛔ sem atendimento aberto, recusa — a regra herdada continua de pé", async () => {
    const { id } = await semearCompromisso({ location_kind: "in_person", atendimento: "fechado" });
    await expect(autorizarEntrega(id)).rejects.toThrow(/meet_conversation/);
  });

  it("⛔ contato bloqueado não recebe", async () => {
    const { id } = await semearCompromisso({ location_kind: "in_person", is_blocked: true });
    await autorizarEntrega(id).catch(() => {});
    const [linha] = await sql`select meeting_delivery from calendar_appointments where id = ${id}`;
    expect(linha.meeting_delivery.state).not.toBe("sent");
  });
});
```

- [ ] **Passo 2: rodar e ver falhar**

```bash
pnpm test:db
```

Esperado: o primeiro caso vermelho com `meet_stale` — `fn_meet_action` recusa
`location_kind<>'google_meet'`.

- [ ] **Passo 3: escrever a migration**

Crie `supabase/migrations/20260913010000_0242_entrega_do_compromisso_sem_meet.sql`
com `create or replace` das duas funções, aplicando **exatamente** estas trocas:

```sql
-- 0242 — o compromisso chega ao cliente mesmo sem Google Meet
--
-- A entrega transacional já resolvia fila, canal, fronteira de atendimento e
-- autorizacao. Ela só não valia para compromisso presencial ou por telefone,
-- porque duas exigências eram incondicionais: `meeting_state='ready'` e
-- `meeting_url is not null`. Elas passam a valer SÓ onde o Meet é o local.
--
-- ⛔ O QUE NÃO MUDA, e é o que impede isto de virar buraco:
--   • atendimento aberto na conversa continua obrigatório;
--   • contato anonimizado ou bloqueado continua fora;
--   • quem autoriza continua tendo de ser o responsável, com papel conferido
--     no ENVIO e não no clique;
--   • e onde o local É o Meet, o link continua tendo de estar pronto.

-- em fn_meet_delivery_current, trocar:
--    and a.meeting_state='ready' and a.meeting_url is not null
-- por:
--    and (a.location_kind <> 'google_meet'
--         or (a.meeting_state='ready' and a.meeting_url is not null))

-- em fn_meet_action, trocar a guarda de `meet_stale`:
--    or a.location_kind<>'google_meet'
-- por: (nada — a guarda sai da condição de `meet_stale`)
-- e acrescentar, dentro do ramo de entrega:
--    if a.location_kind='google_meet' and (a.meeting_state<>'ready' or a.meeting_url is null)
--     then raise exception 'meet_stale' using errcode='40001'; end if;
```

⚠️ Escreva as funções **inteiras** no arquivo (o `create or replace` substitui o
corpo todo); os comentários acima dizem **o que** muda, não são o arquivo.

- [ ] **Passo 4: espelhar no baseline e no MANIFEST, rodar e commitar**

```bash
pnpm test:db
git add supabase/migrations/20260913010000_0242_entrega_do_compromisso_sem_meet.sql supabase/baseline.sql supabase/migrations/MANIFEST.md tests/invariants/agenda-meet.test.ts
git commit -m "feat(agenda): a entrega do compromisso deixa de exigir link do Meet"
```

---

### Task 12: O botão de compartilhar, e o motivo quando não dá

**Files:**
- Modify: `components/agenda/MeetDoCompromisso.tsx` (rótulo depende do local)
- Modify: `app/api/v1/agenda/agendamentos/[id]/route.ts:77` (expor `location_kind` no bloco do compromisso)
- Modify: `tests/unit/agenda-meet-ui.test.tsx`

**Interfaces:**
- Consumes: a migration 0242 e a rota `resend` da Task 10.

- [ ] **Passo 1: escrever o teste que falha**

```tsx
it("compromisso presencial oferece mandar os dados, sem falar em link", () => {
  render(<MeetDoCompromisso {...props({ location_kind: "in_person", delivery_state: "none" })} />);
  expect(screen.getByRole("button", { name: /mandar ao cliente/i })).toBeEnabled();
  expect(screen.queryByText(/link do google meet/i)).not.toBeInTheDocument();
});

it("CONTROLE: sem atendimento aberto, o botão está desabilitado E explicado", () => {
  // "Desabilitado e explicado" é uma coisa só. Botão cinza sem motivo faz a
  // pessoa clicar de novo; foi assim que os 20 segundos do Meet viraram três
  // tentativas.
  render(<MeetDoCompromisso {...props({ location_kind: "in_person", destinations: [] })} />);
  expect(screen.getByRole("button", { name: /mandar ao cliente/i })).toBeDisabled();
  expect(screen.getByText(/nenhum atendimento aberto para este contato/i)).toBeInTheDocument();
});
```

- [ ] **Passo 2: rodar e ver falhar, implementar, rodar e ver passar**

```bash
npx vitest run tests/unit/agenda-meet-ui.test.tsx --reporter=verbose
```

Na implementação, o rótulo passa a depender do local:

```tsx
  // O texto muda com o local porque a promessa muda: onde há Meet, o que vai é
  // o LINK; onde não há, o que vai são os DADOS do compromisso. Prometer link
  // num compromisso presencial é prometer o que não existe.
  const ehMeet = meeting.location_kind === "google_meet";
  const rotuloPrimario = ehMeet ? "Enviar link ao cliente" : "Mandar ao cliente";
```

- [ ] **Passo 3: fragmento e commit**

Crie `.changes/mandar-o-compromisso-ao-cliente.md`:

```markdown
---
efeito: capacidade_nova
---

Agora dá para mandar os dados do compromisso ao cliente pelo WhatsApp, mesmo
quando ele não é por Google Meet. Continua exigindo atendimento aberto na
conversa, e contato que pediu para não receber continua de fora.
```

```bash
git add components/agenda/MeetDoCompromisso.tsx app/api/v1/agenda/agendamentos/ tests/unit/agenda-meet-ui.test.tsx .changes/mandar-o-compromisso-ao-cliente.md
git commit -m "feat(agenda): mandar o compromisso ao cliente pelo WhatsApp"
```

---

### Fecho da Onda 5

- [ ] Suíte inteira, `pnpm typecheck`, `pnpm lint`, `pnpm test:db`
- [ ] Publicar a tag; Paulo clica
- [ ] **Provar na tela:** compartilhar por WhatsApp chega na conversa com
      atendimento aberto; sem atendimento aberto o botão está desabilitado e
      explicado

---

# ONDA 6 — o observador de risco para de abortar

**O que esta onda entrega:** Parte C. O observador para **inteiro**, para a
organização toda, na primeira travessia cuja data cai no futuro.

⚠️ **A causa que a spec dizia era outra, e está corrigida.** Eu havia escrito que
o `detected_at` congelava no UPDATE. Medido: o gatilho
`trg_crm_lead_risk_states_detected_at` é `before insert **or update**` e carimba
`now()` em toda escrita — e está presente e ligado na produção.

**A causa real, provada rodando as próprias funções:** `classifyRisk` tem dois
atalhos da agenda (`agenda.adiar` → `em_voo`, `agenda.motivo='presenca_vencida'`
→ `critico`) que atribuem balde **sem limiar cruzado**, enquanto `sinceDoBucket`
devolve o instante do **cruzamento** daquele balde. Num negócio tocado há pouco,
esse instante ainda não chegou.

```
balde: em_voo   | since: 2026-09-15T21:00Z | agora: 2026-09-12T22:00Z | FUTURO? true
balde: critico  | since: 2026-09-19T21:00Z | agora: 2026-09-12T22:00Z | FUTURO? true
CONTROLE — negócio realmente frio:
balde: critico  | since: 2026-09-08T22:00Z | FUTURO? false
```

---

### Task 13: `since` nunca nasce no futuro

**Files:**
- Modify: `lib/leads/risk-since.ts:23-40` (assinatura ganha `agora`)
- Modify: `lib/leads/risk-worker.ts` (passar `agora`)
- Modify: `lib/leads/risk-seed.ts` (mesmo ajuste, se chamar `sinceDoBucket`)
- Create: `tests/unit/risk-since-nunca-no-futuro.test.ts`

**Interfaces:**
- Produces: `sinceDoBucket(bucket, lastActivityAt, window, agora: Date): Date` —
  o quarto parâmetro é **obrigatório**, de propósito: opcional deixaria os
  chamadores antigos no comportamento defeituoso sem nenhum sinal.

- [ ] **Passo 1: escrever o teste que falha**

Crie `tests/unit/risk-since-nunca-no-futuro.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { classifyRisk } from "@/lib/leads/risk-radar";
import { sinceDoBucket } from "@/lib/leads/risk-since";

/**
 * O observador de risco parava INTEIRO, para a organização toda.
 *
 *   [risk-watcher] org falhou — new row for relation "crm_lead_risk_states"
 *   violates check constraint "crm_lead_risk_states_since_no_passado"
 *
 * `check (since <= detected_at)`, e `detected_at` é sempre `now()` (carimbo do
 * banco, gatilho 0081). Então violar exige `since` no FUTURO — e ele nascia no
 * futuro nos dois atalhos da agenda, que atribuem balde sem limiar cruzado.
 *
 * `risk-worker.ts:120` faz `throw` dentro do laço: uma linha ruim derrubava a
 * avaliação de todas as outras.
 */
const JANELA = { coldHours: 72, criticalHours: 168 };
const AGORA = new Date("2026-09-12T22:00:00Z");
const TOCADO_HA_UMA_HORA = new Date("2026-09-12T21:00:00Z");

describe("since nunca nasce no futuro", () => {
  it("adiamento na agenda, negócio ativo", () => {
    const r = classifyRisk({
      lastActivityAt: TOCADO_HA_UMA_HORA, now: AGORA, inFlight: false,
      window: JANELA, agenda: { adiar: true },
    } as never);
    expect(r.bucket).toBe("em_voo");
    expect(sinceDoBucket(r.bucket, TOCADO_HA_UMA_HORA, JANELA, AGORA).getTime())
      .toBeLessThanOrEqual(AGORA.getTime());
  });

  it("presença vencida, negócio ativo", () => {
    const r = classifyRisk({
      lastActivityAt: TOCADO_HA_UMA_HORA, now: AGORA, inFlight: false,
      window: JANELA, agenda: { motivo: "presenca_vencida" },
    } as never);
    expect(r.bucket).toBe("critico");
    expect(sinceDoBucket(r.bucket, TOCADO_HA_UMA_HORA, JANELA, AGORA).getTime())
      .toBeLessThanOrEqual(AGORA.getTime());
  });

  it("CONTROLE: negócio realmente frio mantém o instante do CRUZAMENTO", () => {
    // O controle é o que impede o conserto de virar um `since = now` geral,
    // que apagaria a informação que a coluna existe para dar: "há quanto tempo
    // este negócio está NESTE estado".
    const frio = new Date("2026-09-01T22:00:00Z");
    const since = sinceDoBucket("critico", frio, JANELA, AGORA);
    expect(since.toISOString()).toBe("2026-09-08T22:00:00.000Z");
    expect(since.getTime()).toBeLessThan(AGORA.getTime());
  });
});
```

- [ ] **Passo 2: rodar e ver falhar**

```bash
npx vitest run tests/unit/risk-since-nunca-no-futuro.test.ts --reporter=verbose
```

Esperado: os dois primeiros casos vermelhos (`since` 3 e 7 dias à frente) e erro
de tipo no quarto argumento.

- [ ] **Passo 3: implementar**

Em `lib/leads/risk-since.ts`, mude a assinatura e o retorno:

```ts
export function sinceDoBucket(
  bucket: RiskBucket,
  lastActivityAt: Date,
  window: StageWindow,
  agora: Date,
): Date {
  const h = (horas: number): Date => new Date(lastActivityAt.getTime() + horas * 3_600_000);
  // ⛔ NUNCA NO FUTURO — e isto não escolhe significado, escreve o que já é
  // verdade.
  //
  // `classifyRisk` tem dois atalhos da agenda (`adiar` e `presenca_vencida`)
  // que atribuem balde SEM limiar cruzado. Para esses, o instante do cruzamento
  // ainda não chegou, e gravá-lo violava `check (since <= detected_at)` —
  // derrubando o observador INTEIRO da organização.
  //
  // O `upsert` só roda quando o balde MUDOU (`risk-worker.ts`, `if (de ===
  // e.bucket) continue`). Uma travessia percebida agora começou, no mais
  // tardar, agora.
  const teto = (d: Date): Date => (d.getTime() > agora.getTime() ? agora : d);
  switch (bucket) {
    case "critico":
      return teto(h(window.criticalHours));
    case "em_risco":
    case "em_voo":
      return teto(h(window.coldHours));
    case "em_dia":
      return teto(lastActivityAt);
  }
}
```

Atualize os chamadores (`lib/leads/risk-worker.ts` e `lib/leads/risk-seed.ts`)
passando o mesmo `now` que já usam para classificar — **nunca** um `new Date()`
novo, senão os dois relógios divergem dentro da mesma passada.

- [ ] **Passo 4: rodar e ver passar**

```bash
npx vitest run tests/unit/risk-since-nunca-no-futuro.test.ts --reporter=verbose
pnpm typecheck
```

- [ ] **Passo 5: commitar**

```bash
git add lib/leads/risk-since.ts lib/leads/risk-worker.ts lib/leads/risk-seed.ts tests/unit/risk-since-nunca-no-futuro.test.ts
git commit -m "fix(risco): since nunca nasce no futuro — era ele que derrubava o observador"
```

---

### Task 14: Uma linha ruim não derruba as outras

**Files:**
- Modify: `lib/leads/risk-worker.ts:120`
- Modify: `tests/unit/risk-worker.test.ts` (ou criar, se não houver)

**Interfaces:**
- Produces: `ResultadoDaObservacao` ganha o campo `falhasDeGravacao: number`.

⚠️ **Isto é cinto, não conserto.** A Task 13 tira a causa; esta tira a
**amplificação**. As duas juntas são o que faz uma linha ruim futura custar uma
linha, e não a organização inteira.

- [ ] **Passo 1: escrever o teste que falha**

```ts
it("uma gravação que falha NÃO derruba a avaliação das outras", async () => {
  const admin = fakeAdmin({ falharNoLead: "c2" });
  const r = await observaTravessias(admin, "org-1");
  expect(r.travessias).toBeGreaterThan(1);
  expect(r.falhasDeGravacao).toBe(1);
});

it("CONTROLE: a falha não some — ela é contada e registrada", async () => {
  // Engolir erro em silêncio seria trocar "para e grita" por "não faz e cala",
  // que é pior: ninguém descobriria.
  const admin = fakeAdmin({ falharNoLead: "c2" });
  const r = await observaTravessias(admin, "org-1");
  expect(r.falhasDeGravacao).toBe(1);
});
```

- [ ] **Passo 2: rodar e ver falhar; implementar**

Em `lib/leads/risk-worker.ts`, troque:

```ts
    if (upErr) throw new Error(`observador de risco (gravação): ${upErr.message}`);
```

por:

```ts
    if (upErr) {
      // Uma linha ruim custa UMA linha. Antes este `throw` parava o laço, e o
      // observador inteiro da organização morria na primeira travessia
      // problemática — as demais nem chegavam a ser avaliadas.
      //
      // ⛔ E não é silêncio: a falha é CONTADA e registrada. Engolir seria
      // trocar "para e grita" por "não faz e cala", que ninguém descobre.
      r.falhasDeGravacao += 1;
      logger.error("risco.gravacao_falhou", {
        organizationId,
        leadId: e.leadId,
        bucket: e.bucket,
        motivo: upErr.message,
      });
      continue;
    }
```

Acrescente `falhasDeGravacao: 0` ao objeto `r` e o campo ao tipo
`ResultadoDaObservacao`.

- [ ] **Passo 3: rodar, ver passar, fragmento e commit**

```bash
pnpm test:unit > /tmp/vt.log 2>&1; grep -aE "Test Files|Tests " /tmp/vt.log | tail -2
```

Crie `.changes/observador-de-risco-nao-aborta.md`:

```markdown
---
efeito: nada_mudou
---

O observador de risco parava inteiro quando um negócio com compromisso na agenda
entrava em risco por adiamento ou falta. Corrigido na causa, e uma falha isolada
deixa de derrubar a avaliação dos outros negócios.
```

```bash
git add lib/leads/risk-worker.ts tests/unit/risk-worker.test.ts .changes/observador-de-risco-nao-aborta.md
git commit -m "fix(risco): uma gravacao que falha nao derruba a passada inteira"
```

---

### Fecho da Onda 6

- [ ] Suíte inteira, `pnpm typecheck`, `pnpm lint`, `pnpm test:db`
- [ ] Publicar a tag; Paulo clica
- [ ] **Provar na VPS:** marcar um compromisso num negócio ativo, adiar, e
      conferir no log do worker que nenhuma linha
      `crm_lead_risk_states_since_no_passado` aparece:

```bash
docker logs --since 1h deskcomm-worker-1 2>&1 | grep -ci since_no_passado   # tem de ser 0
```

- [ ] **CONTROLE:** conferir que o observador de fato RODOU na janela (zero
      linhas com o worker parado não prova nada):

```bash
docker logs --since 1h deskcomm-worker-1 2>&1 | grep -c "risk-watcher"      # tem de ser > 0
```

---

# O PR — o último passo, e só com a palavra do Paulo

- [ ] As **seis** ondas provadas na tela, cada uma na sua versão publicada
- [ ] `pnpm typecheck`, `pnpm lint`, suíte inteira, `pnpm test:db`, `pnpm test:shell`
- [ ] `pnpm release:conferir` sem pendência
- [ ] Conferir que nada privado entrou no diff:

```bash
git diff origin/main...HEAD --name-only | grep -E 'NOSSA-REGRA|NOSSA-INTEGRACAO|FILA\.md' \
  && echo "PARE — arquivo privado no diff" || echo "ok, nada privado"
```

- [ ] Conferir que o commit está numa versão publicada (a regra que custou o PR #740):

```bash
git tag --contains "$(git rev-parse HEAD)" | grep '^v' || echo "NAO PROVADO — nao abra o PR"
```

- [ ] **Perguntar ao Paulo** se vai para o Rafael. Um PR só, com as seis ondas.

---

## Autorrevisão do plano

**1. Cobertura da spec.** Parte A → Ondas 1 e 2 (A.6 passos 1–5; A.7 inteiro).
Parte B → Onda 3 (B.1, B.2, B.3), Onda 4 (B.6), Onda 5 (B.4). Parte C → Onda 6.
Os critérios de aceite B.5 estão distribuídos nos fechos das Ondas 3, 4 e 5; os
de C.3, no fecho da Onda 6.

**2. Buraco conhecido, declarado.** A.5 diz que a parada **não** vale para
instalação com Supabase hospedado — e o instalador padrão do produto cria o banco
na nuvem. A Onda 1 entrega, para esse parque, apenas a **conferência** e a
**recriação** (que não dependem de parar nada). A parada é para quem tem Supabase
local, por decisão do dono do produto. Isto não é omissão do plano: é o alcance
que a decisão define, escrito para ninguém descobrir depois.

**3. Consistência de tipos.** `Contato` (Task 5) é o mesmo shape que a rota de
vínculos passa a devolver na Task 7 (`id,name,email`). `MotivoDaEntrega` (Task 8)
é o mesmo vocabulário que a migration 0241 grava em `meeting_delivery.motivo`
(Task 9) e que a ação `resend` usa (Task 10). `sinceDoBucket` ganha o quarto
parâmetro na Task 13 e todos os chamadores são atualizados no mesmo passo.

**4. O que este plano NÃO faz.** Não toca no PR #740, que está aberto e é
assunto separado. Não resolve o item 9 (`fix/criador-provisorio-sai-na-entrega`),
que continua parado por falta de alguém ter rodado o SQL como `select`. E não
trata da senha do banco visível em `ps aux` — achado real, ainda sem PR.
