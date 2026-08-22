# Atualizar o SonghaiCRM pela própria tela

**Data:** 2026-07-28
**Branch:** `feat/atualizar-pela-ui`
**Estado:** desenho aprovado, pronto para plano de implementação

---

## 1. Problema

Quem hospeda o SonghaiCRM numa VPS atualiza hoje assim: abre um terminal, conecta por SSH
(`ssh -p 22022 root@IP`), entra na pasta do projeto e roda `bash hostgator-setup-kit/update.sh`.

O produto é distribuído para pessoas que não programam. A maioria não sabe fazer isso — e não
saber significa rodar para sempre uma versão antiga, sem as correções de segurança e sem as
funcionalidades novas. A atualização precisa caber num clique dentro do próprio CRM.

O `update.sh` já faz a parte difícil e faz bem: confere se há versão nova, faz backup do banco
antes de tocar em qualquer coisa, atualiza o código, re-aplica o `baseline.sql` (idempotente e
auto-curativo), sobe a imagem nova e confere a saúde no fim. **Este trabalho não reescreve a
atualização — dá a ela um gatilho na tela.**

## 2. A restrição que define o desenho

O app roda dentro de um container (`ghcr.io/melgarafael/deskcommcrm`) sem nenhum volume do host.
Um container não roda `git` no host nem `docker compose up -d`. Dar a ele o socket do Docker
resolveria — e transformaria qualquer falha de segurança no CRM em acesso root à VPS inteira.
Descartado.

A saída é inverter a direção: **o app publica uma intenção; um agente que já vive no host lê a
intenção e roda um script versionado no repositório.** O host já faz exatamente isso a cada
minuto para o `event-log-drain` (cron instalado pelo `install.sh`, autenticado com
`Authorization: Bearer $INTERNAL_SECRET`). Reusamos o mecanismo — sem porta nova, sem socket,
sem volume, sem alterar o `docker-compose.prod.yml`.

O que atravessa a fronteira é um booleano, não um comando. Mesmo com o app comprometido, o
atacante não escolhe *o que* roda no host — só *quando* o `update.sh` da tag assinada roda.

### Alternativas descartadas

| Alternativa | Por que não |
|---|---|
| Socket do Docker montado no container | Falha de segurança no CRM vira root no host. |
| Watchtower (auto-update de imagem) | Troca a imagem mas não faz o `git` do `baseline.sql` → app novo sobre banco velho. E atualizar sem gate humano assusta quem depende do CRM para trabalhar. |
| Botão que só ensina o comando | Não resolve o problema declarado ("poucos sabem fazer"). Vira o estado de fallback, não a solução. |

## 3. Decisões tomadas

1. **O alvo da atualização é a última tag SemVer, não o topo da `main`.** O CHANGELOG.md do
   repositório já é Keep a Changelog em pt-BR, com seção "⚠️ Requer atenção" escrita para o
   self-hoster ler antes de atualizar. Seguir tags dá a você controle sobre o que chega no
   cliente e dá à tela um texto curado para exibir. Consequência: o `update.sh` passa a fazer
   checkout de tag e a puxar imagem versionada.
2. **O aviso vive só no rodapé da sidebar.** Sem faixa no topo. Discreto, sempre ao alcance,
   zero ruído no trabalho diário.
3. **Quem pode atualizar é `is_platform_admin`**, não role de organização. O `install.sh` já
   promove o primeiro dono a `platform_admins` — é literalmente "o dono do servidor". Num CRM
   com várias organizações, admin da org B não reinicia o servidor de todo mundo.
4. **Quem não pode agir não é avisado.** Usuário comum vê a versão em cinza, nunca o alerta.
   Aviso sem ação disponível é só ansiedade.

## 4. Arquitetura

```
VPS (host)                                  container do app
┌────────────────────────────┐              ┌──────────────────────────┐
│ cron */5min → agent.sh     │              │  Next.js                 │
│  1. git fetch --tags       │──POST /api/v1/system/agent──▶  grava    │
│     versão atual / última  │   bearer INTERNAL_SECRET     │  estado  │
│  2. lê a resposta       ◀──│──{update_requested, run_id}──│          │
│  3. se pedido:             │              │                          │
│     flock + update.sh --to │              │                          │
│  4. reporta o desfecho  ───│──POST /api/v1/system/agent──▶            │
└────────────────────────────┘              │  ◀── GET /version ─── UI │
                                            └──────────────────────────┘
```

Uma única direção de chamada: host → app. O app nunca alcança o host.

### 4.1 `hostgator-setup-kit/agent.sh` (novo)

Rodado por cron a cada 5 minutos, instalado pelo `install.sh` **e** pelo `update.sh` (mesma
função em `_common.sh` que hoje instala o cron do drain).

1. `git fetch --tags --quiet`
2. Resolve **versão atual**: `git describe --tags --exact-match HEAD`; se o HEAD não estiver
   numa tag (instalação fora de release), reporta o SHA curto e marca `off_release: true`.
3. Resolve **última disponível**: `git tag -l 'v*' --sort=-v:refname | head -1`.
4. Se há versão nova, lê o CHANGELOG **da tag nova**: `git show <tag>:CHANGELOG.md`. Se não há,
   o campo vai vazio.
5. `POST /api/v1/system/agent` com `kind: "heartbeat"`.
6. Se a resposta trouxer `update_requested: true`, roda sob `flock`:
   `bash update.sh --to <tag>`, capturando a saída num arquivo de log.
7. **Reporta cada passo concluído** (`kind: "run_progress"`) enquanto o app ainda está de pé:
   `backup`, `codigo`, `banco`. A partir de `app` o container reinicia e os `POST` deixam de
   passar — é esperado, e a tela cobre esse intervalo com "reiniciando…".
8. Ao terminar, `POST` com `kind: "run_result"` — com retry (backoff até ~2 min), porque o app
   acabou de voltar e pode ainda não estar respondendo.

O agente não decide nada além de "há tag nova?". Como os passos lentos (backup do banco e
re-aplicação do `baseline.sql`) acontecem **antes** do reinício, o progresso que a tela mostra é
real durante quase todo o tempo de espera — não é barra de progresso decorativa.

O agente não decide nada além de "há tag nova?" — quem interpreta o CHANGELOG e quem autoriza é
o app.

### 4.2 Rotas

**`POST /api/v1/system/agent`** — autenticação por `Authorization: Bearer <INTERNAL_SECRET>`
(ou `INTERNAL_CRON_SECRET`), comparação em tempo constante, igual às rotas de cron existentes.
Corpo validado por união discriminada em Zod:

```ts
{ kind: "heartbeat",
  current_version: string,      // "v1.0.0" ou sha curto
  current_sha: string,
  off_release: boolean,
  latest_version: string,
  changelog: string }           // CHANGELOG.md cru da tag nova (vazio se não há), teto de 64 KB

{ kind: "run_progress",
  run_id: uuid,
  step: "backup" | "codigo" | "banco" }

{ kind: "run_result",
  run_id: uuid,
  status: "success" | "failed" | "failed_rolled_back",
  log_tail: string }            // últimas ~40 linhas, teto de 16 KB
```

Resposta nos três casos: `{ data: { update_requested: boolean, run_id: uuid | null } }`.

**`GET /api/v1/system/version`** — sessão + `is_platform_admin`. Devolve o estado para a UI:
versão atual, disponível, seção do CHANGELOG já extraída, saúde do agente e o run em andamento,
se houver.

**`POST /api/v1/system/update`** — sessão + `is_platform_admin`. Cria o run em `dispatched` e
marca `update_requested_at/by`. Recusa com `update_already_running` se já existe run ativo.
Emite `system.update_requested` no `api_audit_log`.

O CHANGELOG é interpretado no app, em TypeScript (não em `awk` no bash), justamente para que o
extrator seja uma função pura testável no Vitest.

### 4.3 Banco

Migration versionada em `supabase/migrations/` + apêndice idempotente no `supabase/baseline.sql`
+ linha no `MANIFEST.md`, conforme a doutrina de migrations.

**`system_version`** — singleton (uma linha, `check (id = 1)`):
`current_version`, `current_sha`, `off_release`, `latest_version`, `changelog_raw`,
`agent_last_seen_at`, `update_requested_at`, `update_requested_by`.

**`system_update_runs`** — histórico append:
`id`, `from_version`, `to_version`, `status`, `last_step`, `requested_by`, `dispatched_at`,
`finished_at`, `log_tail`.

Nenhuma das duas tem `organization_id`: são estado da instância, não do inquilino. **Nenhuma
policy de RLS é criada**, o que significa que `authenticated` e `anon` não leem nada pelo
PostgREST; todo acesso passa pelas rotas com service role, que checam `is_platform_admin`.
Mesmo padrão de `platform_admins`.

### 4.4 Máquina de estados do run

```
(sem run) ──POST /update──▶ dispatched ──run_progress──▶ (mesmo estado, last_step avança)
                                 │       ──run_result──▶ success
                                 │                       failed
                                 │                       failed_rolled_back
                                 └──sem notícia por 15 min──▶ unknown (derivado, não gravado)
```

`unknown` não é reportado por ninguém: é derivado na leitura, comparando `dispatched_at` com o
relógio. Um agente morto não consegue anunciar a própria morte.

O app escreve **apenas** a transição para `dispatched` — é o único instante em que ele sabe com
certeza que a ordem saiu (ele mesmo acabou de respondê-la). Dali em diante quem escreve é o
agente. Isso fecha o buraco clássico: o app cai no meio da atualização e ninguém sabe se ela
começou. Transição inválida (ex.: `success` → `failed`) é rejeitada pela rota.

### 4.5 Mudanças no `update.sh`

- Aceita `--to <tag>`. Sem argumento, resolve a última tag sozinho — o uso pelo terminal
  continua idêntico ao de hoje.
- Troca `git pull --ff-only` por checkout da tag. O repositório do host passa a viver em HEAD
  destacado, o que é correto para uma instalação: ela acompanha releases, não desenvolve.
  Instalação que hoje está no topo da `main` (`off_release`) é levada para a última tag no
  primeiro update — a tela explica isso antes do clique.
- Sobe `APP_IMAGE=ghcr.io/melgarafael/deskcommcrm:<versão>` em vez de `latest`.
- Antes do `docker compose pull`, guarda o digest da imagem em execução
  (`docker inspect --format '{{.Image}}'`) para permitir a volta.

## 5. A tela

### 5.1 Rodapé da sidebar

Acima do botão "Recolher", sempre presente:

```
┌─ sidebar ───────────┐
│  Inbox              │
│  ...                │
│  Configurações      │
├─────────────────────┤
│ ● Nova versão       │   ← só para quem é dono do servidor
│   1.1.0 disponível  │
├─────────────────────┤
│  « Recolher         │
└─────────────────────┘
```

Sem novidade — ou para quem não é dono: `versão 1.0.0` em cinza, texto pequeno, não clicável.
Com a sidebar recolhida: só o ponto sobre o número, com `title`.

### 5.2 `/app/settings/atualizacao`

Página, não modal: um progresso de dois minutos com reinício do servidor no meio não cabe num
modal.

**Estado "em dia"** — "Você está na versão 1.0.0, a mais recente." + data da última checagem.

**Estado "tem novidade"** — versão nova em destaque; **o que muda** renderizado da seção do
CHANGELOG daquela versão (o texto curado em pt-BR, nunca mensagem de commit); se a seção contém
**⚠️ Requer atenção**, esse bloco aparece acima do botão, em destaque. Botão `Atualizar agora`
acompanhado da frase honesta: *"o sistema sai do ar por cerca de 2 minutos e volta sozinho. Faço
um backup do banco antes."*

**Estado "atualizando"** — passos com estado (backup → código → banco → app → conferindo saúde),
alimentados por polling. Quando o app cai, o polling falha: a tela mostra "reiniciando…", não
erro. É comportamento esperado, e a tela reconecta sozinha.

**Estado "sem agente"** — nenhum heartbeat, ou o último com mais de 24h: *"não estou conseguindo
falar com o servidor. Enquanto isso, quem tem acesso pode rodar:"* + comando com botão de copiar.

Esse quarto estado não é um erro tratado: é a peça anti-morte exigida pela doutrina do Sistema
Vivo. Uma feature que depende de um cron no host morre em silêncio se o cron sumir. Transformar
a ausência de sinal numa tela que ensina o caminho manual faz a falha degradar para o
comportamento de hoje — nunca para um botão que não faz nada. É também o estado de toda
instalação existente antes do primeiro update manual, ou seja, ele **é** a instrução de
bootstrap.

## 6. Falhas e como o sistema responde

| Falha | Resposta |
|---|---|
| App novo não sobe | O agente re-sobe o digest guardado antes do `pull` e reporta `failed_rolled_back`. A tela: *"a atualização não deu certo e eu voltei para a versão anterior. Seus dados estão intactos."* |
| Banco já migrado, app revertido | O `baseline.sql` é aditivo e idempotente: o app anterior roda sobre o schema novo. A tela **diz** que o banco não voltou e aponta o backup + `restore.sh`. Prometer rollback de schema seria mentira. |
| Dois cliques, ou dois crons concorrentes | `flock` no host (a segunda invocação sai na hora) **e** recusa na rota se já há run ativo. |
| Alteração local na VPS impede o checkout | Aborta **antes** de tocar no banco e reporta em português — comportamento que o `update.sh` já tem. |
| Agente some no meio | Run vira `unknown` após 15 min sem notícia; a tela pede para conferir o log e oferece o comando manual. |
| Segredo vazado em log | Bearer só em header, nunca em query string; comparação em tempo constante. |

Auditoria: `system.update_requested` (quem clicou, de qual versão para qual) e
`system.update_finished` (desfecho) no `api_audit_log`.

## 7. Bootstrap — a primeira vez ainda é pelo terminal

O agente que atende o botão precisa ser instalado por uma atualização. Quem já tem o CRM rodando
precisa executar **uma vez** `bash hostgator-setup-kit/update.sh`; a partir daí o cron está
instalado e nunca mais é preciso o terminal. Instalações novas já saem com o agente. Isso é
inerente ao problema, não uma limitação do desenho, e a tela no estado "sem agente" mostra
exatamente esse comando.

## 8. Verificação

- **Unit (Vitest):** extrator da seção do CHANGELOG — versão presente, versão ausente, com e sem
  "⚠️ Requer atenção", arquivo malformado, arquivo acima do teto; máquina de estados do run —
  toda transição inválida rejeitada.
- **Invariantes (`pnpm test:db`):** `system_version` e `system_update_runs` não são legíveis por
  `authenticated`; `baseline.sql` aplica em banco novo (`ON_ERROR_STOP=1`) e re-aplica em banco
  existente.
- **E2E Playwright, dirigindo a tela** (DoD 12): dono vê a versão no rodapé; um `curl` assinado
  simula o agente anunciando 1.1.0; a sidebar acende; a tela mostra o texto do CHANGELOG; o
  clique em `Atualizar agora` cria o run; um segundo `curl` do agente confirma o recebimento e
  devolve sucesso; a tela chega em "Você está na 1.1.0". Caso espelhado: usuário `agent` não vê
  o botão. Evidência visual em `.superpowers/evidence/`.
- **Prova real na VPS** (129.121.45.100): o ciclo completo com uma tag de teste, ponta a ponta.
  Sem isso a feature não é declarada pronta — o E2E prova a tela, não prova o host.

## 9. Living System Checklist

- **Entrada:** heartbeat do agente (a cada 5 min) e o clique do dono.
- **Saída:** `update.sh` executado no host, run gravado, entradas no audit log.
- **Aparece na tela:** rodapé da sidebar + página de atualização, com progresso ao vivo.
- **Anti-morte:** ausência de heartbeat vira o estado "sem agente", que ensina o caminho manual
  em vez de falhar em silêncio.
- **Mapa vivo:** `docs/architecture/` ganha a peça "atualização self-service" com arestas para o
  agente do host, o `api_audit_log` e a sidebar.

## 10. Fora de escopo

Agendamento de atualização, atualização automática sem clique, canal beta e notificação por
e-mail. Nenhum é necessário para "o leigo consegue atualizar sozinho"; todos custam superfície de
manutenção. Entram depois, se houver demanda real.
