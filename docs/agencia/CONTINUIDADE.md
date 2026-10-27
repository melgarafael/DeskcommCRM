# Módulo da Agência — documento de continuidade

> Escrito em **26/10/2026, ~19h20 (Brasília)** e atualizado em **27/10/2026 ~00h30**, a pedido do dono, para outra IA (ou pessoa)
> continuar exatamente de onde o trabalho parou. Leia este arquivo inteiro antes de tocar
> em qualquer coisa. Depois, leia o [`CLAUDE.md`](../../CLAUDE.md) da raiz (a doutrina do
> repositório) e o [`mapa-de-capacidades.md`](mapa-de-capacidades.md) (o índice da iniciativa).

---

## 1. Onde o trabalho parou (estado exato)

**Atualização de 27/10/2026 ~00h30 (Brasília):** as **nove fases do mapa estão construídas e
publicadas no teste**. As fases 1 a 8 foram provadas pela tela; a Fase 9 (IA) foi provada em tudo
o que não chama o modelo, porque o teste não tem chave de IA (ver o
[`plano-fase-9.md`](plano-fase-9.md)). Nada foi para o GitHub e nada foi para a central.

| Item | Estado |
|---|---|
| Worktree | `F:\Área de Trabalho\SITES CLIENTES\CRM TESTE\DeskcommCRM-agencia` |
| Última branch | `feat/agencia-fase-9` (encadeada: sai da 8, que sai da 7…) |
| Migrations da agência | 9003–9012 (9010 mapa mental, 9011 publicações, 9012 IA). **Próxima livre: 9013** — e veja a colisão do §6b |
| Teste | tudo publicado; o último pacote foi `f12` + `f12b` (modal da tarefa) |
| Central (produção) | **intocada** — levar o módulo para lá é decisão do dono |

### O que falta (na ordem que faz sentido)

1. **Provar a IA com modelo** quando o dono puser uma chave no `.env` do teste:
   [`scripts/prova-fase9-com-modelo.mjs`](scripts/prova-fase9-com-modelo.mjs) (o roteiro está no
   plano da Fase 9).
2. **Provar a publicação automática na Meta** com uma **conta de teste da Meta**. Nunca use a
   organização "Empresa Modelo (Testes)": a conexão Meta dela é **real** (ver o plano da
   Fase 8, 8b).
3. **Resolver a colisão de numeração** com o outro chat (§6b) antes de juntar as branches na
   `main`.
4. **Juntar as branches** (`feat/agencia-fase-1` … `-9`) e decidir com o dono como e quando o
   módulo vai para a central. Isso exige autorização explícita, e o `update.sh` da central
   aplica o baseline.
5. Fora do mapa, mas citados pelo dono:
   - as trilhas dos clientes avulsos (gravação, tráfego, site…), ainda não descritas;
   - TikTok e YouTube nas publicações (precisam de pesquisa e de app aprovado);
   - a criação real de campanha pausada no Gerenciador de Anúncios (I5 da spec da IA).

---

## 2. Pendências que dependem do dono (fora do código)

1. **Google**: no Google Cloud do app da Agenda, ativar a **Google Drive API**, acrescentar os
   escopos `drive.file` e `calendar.events` e o endereço de retorno
   `https://teste.emmovimento.tech/api/v1/agencia/drive/callback`; depois, em Configurações da
   agência, **Conectar/Reconectar Google** marcando Drive e Agenda.
2. **WhatsApp da agência**: conectar o número por QR (WAHA) numa organização própria da agência
   e escolhê-lo em Configurações da agência. Sem isso não sai aviso, lembrete, link de
   formulário, mensagem de reunião, pedido de aprovação, nem grupo.
3. **Avisos gerais**: hoje **ninguém** recebe avisos gerais no teste (o login do dono não tem
   perfil de membro e nenhuma função tem "Receber os avisos gerais"). Configurações mostra um
   alerta. O dono precisa ativar o perfil em `/agencia/perfil` ou dar a permissão a alguém.
   Por isso o aviso "não publicou" da 8b não chegou a ninguém na prova.
4. **Contratos**: trocar o modelo inicial pelo texto real; cadastrar o token da ZapSign e o
   InfiniteTag em Configurações.
5. **Chave de IA** no `.env` do teste (e, um dia, na central) para a Fase 9 funcionar. Cada
   pedido gasta crédito do provedor.
6. **Meta**: para publicar sozinho, a conexão Meta da organização do cliente precisa das
   permissões `instagram_content_publish` / `pages_manage_posts`.
7. **Formulário antigo** (`formulario.emmovimento.tech`) pode ser aposentado quando o dono quiser.

---

## 3. Resumo do projeto

### O que é

Um **módulo interno da agência de marketing "Em Movimento"** dentro do fork do DeskcommCRM
(o CRM open source da casa). A agência usa a mesma instalação para duas coisas separadas:

- **Organizações** (`/app`): o CRM de cada cliente da agência (produto original).
- **Agência** (`/agencia`): a área interna da equipe — clientes da agência, tarefas, calendário,
  trilha, acessos, contratos (e, depois, mapa mental, aprovações, IA).

Instalações: **central.emmovimento.tech** = produção (NÃO MEXER sem autorização);
**teste.emmovimento.tech** = teste (é onde tudo é publicado e provado). As duas na mesma VPS.

### Quem usa

- **Dono** (platform admin `full`): tudo, sem precisar de perfil de membro (mas, para
  receber avisos, precisa ativar o perfil).
- **Equipe** (roteirista, videomaker, editor, designer, social media, gestor de tráfego,
  programador): login normal, cai direto em `/agencia`, vê só o que as funções permitem e
  só os clientes que atende (ou todos, com a chave "vê todos os clientes").
- **Cliente da agência**: hoje só pelo **formulário público** (Fase 5); na Fase 7, pela aba
  de aprovações na organização dele.

### Decisões que mandam (resumo — a lista completa D1–D20 está no mapa)

- Área própria `/agencia`, nunca admin do painel; regra de acesso no **servidor** (D1, D15).
- Avisos no sininho **e** no WhatsApp pessoal, pelo WhatsApp da agência, dentro da janela
  7h–22h (D4).
- Todo cliente ganha organização no CRM (D7); senhas no **cofre cifrado**, nunca no Drive (D8, D20).
- Contrato em PDF + ZapSign + InfinitePay; **assinado E pago** dispara grupo e formulário (D9, D10).
- Google Drive da conta AI Pro da agência como acervo; banco da central é a fonte (D20).
- Cada tarefa/bloco tem executor humano ou IA; ação que gasta dinheiro nasce pausada (D17).
- Tudo responsivo (celular e computador) (D14).

### O que já existe (Fases 1–9)

| Fase | Commit | Migration | Entrega |
|---|---|---|---|
| 1 | `c9f088370` (`feat/agencia-fase-1`) | 9003 | Equipe e funções com permissões, convite por link, WhatsApp da agência (fila com ritmo anti-bloqueio), avisos (sininho + WhatsApp, agrupamento), perfil. |
| 2 | `a4de7ddbe` (`feat/agencia-fase-2`) | 9004 | Clientes da agência (multiempresa, contratações, equipe do cliente, importar organização), acervo no Google Drive (8 subpastas por cliente), tarefas no estilo do vídeo (quadro, lista, ranking, checklist + lote, etiquetas, links, anexos, cronômetro, recorrentes, atraso em vermelho), crons `agencia-prazos` e `agencia-recorrentes`. |
| 3 | `da8b76227` (`feat/agencia-fase-3`) | 9005 | Calendário (Semana/Mês/Próximos), reuniões com Meet pela Agenda Google, Fechamento D+7 automático, pauta da Apresentação, lembretes 1 dia/1 hora, ata e gravação, WhatsApp ao cliente. |
| 4 | `9d59e64e9` (`feat/agencia-fase-4`) | 9006 | Trilha do cliente: modelo "Cliente recorrente" (20 passos das Etapas 1 e 2), desbloqueio, prazos por regra, regra do dia 15, começar do meio, remarcar Apresentação arrasta o Fechamento, relógio da trilha, painel e editor de modelos. |
| 5 | `9bbce4938` (`feat/agencia-fase-5`) | 9007 | Formulário de acesso público (link de 72 h, rascunho sem senha, várias empresas, CNPJ validado) e cofre de senhas (AES-256-GCM, "Ver senha" registrado, relatório PDF, 403 sem permissão). |
| 6 | `6a1c64b0b` (`feat/agencia-fase-6`) | 9008 | Contratos: modelos com campos, PDF, ZapSign/InfinitePay opcionais com webhooks conferidos, marcar à mão, assinado e pago → cliente ativo + trilha + formulário + grupo + aviso, recusa → remarketing. |
| 7 | `b383d513a` (`feat/agencia-fase-7`) | 9009 | Aprovações do cliente: a agência pede (vídeo, roteiro, arte, estratégia), o cliente aprova ou pede ajustes em `/app/aprovacoes` da organização dele; versões; a tarefa ligada acompanha. Primeira tabela da agência com `organization_id` e RLS de tenant. |
| 8a | `a2e0420bf` + `3946f4b87` (`feat/agencia-fase-8`) | 9010 | Mapa mental: Criação (blocos, setas sem círculo, arrasto) e Ao vivo (bloco liberado vira tarefa; tarefa concluída libera os seguintes). |
| 8b | `3aa2267bd` (`feat/agencia-fase-8`) | 9011 | Calendário de publicações ligado às aprovações; marcar publicada à mão; publicar sozinho na Meta por chave da publicação (desligada por padrão), pelo cron `agencia-prazos`. |
| 9 | `684b13f5d` (`feat/agencia-fase-9`) | 9012 | IA da agência: "Pedir à IA" no mapa (proposta conferida antes de aplicar) e executor IA na tarefa (roteiro, legenda, pautas, rascunho de campanha só em texto, publicação em rascunho). |

As branches são **encadeadas** (cada uma sai da anterior); nenhuma foi para a `main` nem para
o GitHub. O trabalho de cada fase tem **spec** (`SPEC-*.md`) e **plano com a verificação**
(`plano-fase-N.md`) nesta pasta, e **evidências** em `evidence/agencia-fase-N/`.

---

## 4. Arquitetura e convenções do módulo

### Onde está cada coisa

| O quê | Onde |
|---|---|
| Regras puras (testáveis sem banco) | `lib/agencia/**/regras.ts`, `perguntas.ts`, `vocabulario.ts` |
| Acesso e permissões | `lib/agencia/acesso.ts` (`requireAreaDaAgencia`, `exigirPermissao`, `contextoLiberado`), `lib/agencia/permissoes.ts` (vocabulário fechado; `PERMISSOES_EM_USO` controla o que a tela de funções mostra) |
| Quem vê qual cliente | `lib/agencia/clientes/visibilidade.ts` (`carregarAlcance`, `podeVerCliente`) |
| Avisos | `lib/agencia/avisos/criar.ts` (`criarAviso` — a ÚNICA porta) e `tipos.ts` |
| WhatsApp da agência | `lib/agencia/whatsapp/` (fila `enfileirar.ts`, regra `regra.ts`, handler do `event_log`, grupo `grupo.ts`) |
| Google (Drive + Agenda) | `lib/agencia/acervo/drive.ts` (uma conexão só), `lib/agencia/calendario/google.ts` |
| Tarefas, calendário, trilha, cofre, formulário, contratos, aprovações, mapa, publicações, IA | `lib/agencia/{tarefas,calendario,trilhas,cofre,formulario,contratos,aprovacoes,mapas,publicacoes,ia}/` |
| Tela do cliente (organização) | `app/app/aprovacoes/` (capacidade `aprovacoes_da_agencia`) |
| Gancho "a tarefa mudou" | `aoMudarTarefa` em `lib/agencia/trilhas/motor.ts`, que avisa a trilha **e** o mapa; a resposta do cliente à aprovação chama a publicação ligada (`aoResponderAprovacaoDaPublicacao`) |
| Ações (server actions) | `app/actions/agencia/*.ts` — toda escrita chama `exigirPermissao` e confere o alcance do cliente |
| Telas | `app/agencia/(area)/**` (área logada), `app/agencia/convite/[token]` e `app/agencia/formulario/[token]` (públicas) |
| Componentes | `components/agencia/**` |
| Rotas de API | `app/api/v1/agencia/**` (logadas), `app/api/v1/cron/agencia-*` (cron), `app/api/v1/webhooks/agencia/**` (ZapSign/InfinitePay, segredo no caminho) |
| Menu | `lib/agencia/menu.ts` + ícones em `components/agencia/CascaDaAgencia.tsx` |
| Testes | `tests/unit/agencia-*.test.ts`, `tests/invariants/agencia-*.test.ts` |

### Regras que não se quebram

- **Tabelas da agência são da instalação**: sem `organization_id`, RLS ligada, `revoke all from
  anon, authenticated`, nenhuma policy. Só o servidor (client admin) lê e escreve, **depois**
  do guarda de permissão. O cookie de sessão é HttpOnly: **nunca** ler tabela da agência
  pelo client do navegador (foi o bug do sininho na Fase 1).
- **Toda mudança de schema** = migration nova em `supabase/migrations/<timestamp>_<NNNN>_<slug>.sql`
  com `-- manifest:` no cabeçalho **+** o mesmo conteúdo no apêndice do `supabase/baseline.sql`,
  **antes** da linha `-- ---- VARREDURA anon: função nova nasce exposta em quem ATUALIZA (migration 0116) ----`.
  Numeração do fork: 9001 e 9002 são do **outro chat** (catálogo, Meta); 9003–9012 são deste
  módulo. **A próxima livre é 9013** — confira antes com
  `find supabase/migrations -name "*_90*"` no worktree **e** no checkout principal.
- Idempotência: `create … if not exists`, `drop constraint if exists` antes de recriar CHECK.
- Datas sempre no fuso **America/Sao_Paulo** (`formatarDataHora`, `diaLocal`, `instanteDoDia`).
  Tela montada no servidor mostra UTC se esquecer (achado da Fase 2).
- Vocabulário em constante compartilhada, nunca string solta; colunas de vocabulário fechado
  têm CHECK no banco.
- Auditoria: `auditarAgencia(...)` nas ações; cron só audita quando houve efeito; códigos novos
  entram em `lib/audit/actions.ts`.
- Senha nunca em claro fora de `lib/agencia/cofre/cofre.ts`; o vocabulário que a tela usa
  fica em arquivo separado (`cofre/vocabulario.ts`) para a chave de cifra não ir ao navegador.
- Rota pública: entrada em `lib/auth/public-paths.ts` (o proxy só reconhece cookie) + limite
  de tentativas (`checkRateLimit` de `lib/ai/dispatcher/rate-limit.ts`). Webhooks externos
  ficam em `app/api/v1/webhooks/` (já público e já isento da cerca de suporte).
- Host de terceiro novo no código → declarar em `HOSTS_DECLARADOS` de `tests/unit/branding.test.ts`.
- Tailwind 4: nada de `rounded` puro (use `rounded-sm`/`rounded-md`); aba escolhida com fundo
  `bg-accent` precisa de `text-accent-foreground`.
- Textos em português do Brasil; a área da agência está isenta do espanhol
  (`tests/unit/i18n-espanhol-cobre-a-tela.test.ts`).

---

## 5. Como trabalhar (ambiente)

### 5.1 Máquinas e pastas

- **PC do dono (Windows)**: o worktree acima. O dono **não quer Docker no PC** — todo teste de
  banco e toda prova de navegador rodam **na VPS**.
- **Checkout principal** `F:\Área de Trabalho\SITES CLIENTES\CRM TESTE\DeskcommCRM` é usado por
  **outro chat** (com arquivos sujos dele). **Não mexer nele.**
- **VPS**: `root@82.25.66.240` (SSH por chave, `ssh -o BatchMode=yes`).
  - `/docker/deskcommcrm` = **central (produção)** — não tocar.
  - `/docker/deskcommcrm-teste` = **teste** — onde se publica. `.env` com
    `APP_IMAGE/WORKER_IMAGE/SCHEDULER_IMAGE = deskcomm-teste-*:local` (construídas do fork).
  - `/root/agencia-ci` = cópia do worktree para rodar `test:db` e as provas.
  - `/root/agencia-deploy` = scripts e pacotes de publicação, cópias de segurança
    `antes-fN-<TS>.tgz`, logs `publicar-fN.log`, `build-fN-*.log`.
  - `/root/agencia-ci/prova/` = scripts Playwright das provas (`prova-faseN.mjs`), sessão
    salva do membro de teste (`sessao-membro.json`) e a credencial dele
    (`credenciais-membro-teste.txt`, só na VPS — nunca copiar para chat ou repositório).

### 5.2 Comandos do dia a dia (no worktree)

```bash
NODE_OPTIONS=--max-old-space-size=7168 npx tsc --noEmit -p tsconfig.typecheck.json   # typecheck (4 GB não basta)
npx eslint <arquivos da fase>
npx vitest run tests/unit/agencia-*.test.ts
```

No Git Bash do Windows, `tar` precisa de `--force-local`; se um `tar | ssh` falhar com "This
does not look like a tar archive", gere o `.tar` em arquivo e mande com `scp`.

### 5.3 Banco (test:db) na VPS

Mande os arquivos de schema e o invariante novo para `/root/agencia-ci` (tar + scp) e rode:

```bash
ssh root@82.25.66.240 'cd /root/agencia-ci && bash rodar-test-db.sh > testdb.log 2>&1; grep -aE "install ok|update ok|Test Files|Tests " testdb.log'
```

`rodar-test-db.sh` sobe um contêiner `node:22` com o docker.sock da VPS e roda
`scripts/test-db.sh` com a lista de invariantes da agência (acrescente o arquivo da fase nova
com `sed`, como nas fases anteriores).

### 5.4 Publicar no teste

Script genérico: `/root/agencia-deploy/publicar-fase.sh` na VPS — cópia versionada em
[`scripts/publicar-fase.sh`](scripts/publicar-fase.sh) (e `scripts/trocar-arquivos.sh`; um
exemplo de prova completa em `scripts/prova-fase5.mjs`). Ele confere o md5
dos arquivos da agência contra a fase anterior, aplica o patch dos arquivos COMPARTILHADOS,
extrai os arquivos da agência, insere o apêndice no `baseline.sql` do teste, aplica o SQL no
banco do teste, marca tags de rollback, **espera qualquer build em andamento na VPS** (o outro
chat constrói a central na mesma máquina) e reconstrói app e worker.

Preparar no worktree (troque `B` pelo commit da fase anterior e `COMP` pelos arquivos
compartilhados que a fase tocou — os que NÃO são da agência, ex.: `lib/audit/actions.ts`):

```bash
B=<commit-anterior>; COMP="lib/audit/actions.ts ..."
git diff $B -- $COMP > fN-compartilhados.patch
{ git diff --name-only $B; git ls-files --others --exclude-standard; } | grep -vE '^(docs/|tests/|evidence/|supabase/baseline.sql|<COMP>)' | sort -u > fN-proprios.txt
tar --force-local -czf fN-proprios.tgz -T fN-proprios.txt
# md5 do que o teste TEM que ter antes (versão do commit anterior de cada arquivo modificado):
git diff --name-only $B | grep -vE '^(docs/|tests/|evidence/|supabase/|<COMP>)' | while read f; do echo "$(git show "$B:$f" | md5sum | cut -d' ' -f1)  $f"; done > fN-md5-antes.txt
```

Mandar (`scp`) para `/root/agencia-deploy/` e rodar **em segundo plano** (o build leva ~10 min
e a conexão SSH cai antes):

```bash
ssh root@82.25.66.240 'cd /root/agencia-deploy && (nohup bash publicar-fase.sh N supabase/migrations/<arquivo>.sql "Área da agência, fase N: <título>" "<COMP>" > publicar-fN.log 2>&1 < /dev/null &)'
# acompanhar: grep -E "PRONTO|FALHOU" /root/agencia-deploy/publicar-fN.log
```

Depois de publicar: `/` deve dar **200** e `/app` **307** em `https://teste.emmovimento.tech`.
Para trocar só alguns arquivos e reconstruir só o app: `/root/agencia-deploy/trocar-arquivos.sh`.
**Worker**: quando a fase mexe em `lib/` usado pelo dreno do `event_log` (WhatsApp, avisos),
reconstruir também o worker (o `publicar-fase.sh` já faz).

### 5.5 Provar pela tela

Playwright **na VPS**, imagem `mcr.microsoft.com/playwright:v1.63.0-noble`:

```bash
ssh root@82.25.66.240 'docker run --rm --network host -v /root/agencia-ci:/app:ro -v /root/agencia-ci/prova:/prova mcr.microsoft.com/playwright:v1.63.0-noble node /prova/prova-faseN.mjs'
```

- Use `storageState: "/prova/sessao-membro.json"` (o "Membro Teste Agência", id
  `f49cbbe8-933c-4164-91fb-dbac2b18a791`, Videomaker + Editor, na equipe do cliente "Empresa
  Modelo (Testes)", id `8a49b809-3320-40d0-8e18-c3be9b53f0c8`).
- Para permissões que o membro não tem, crie uma **função temporária** pelo SQL no banco do
  teste (`docker exec -i deskcommcrm-teste-supabase-db-1 psql -U postgres -d postgres`) e
  **apague no fim** — veja `prova/f5-funcao-temporaria.sql` como exemplo.
- Cron do teste: `curl -H "Authorization: Bearer $INTERNAL_CRON_SECRET"` (lido do `.env` do teste)
  em `https://teste.emmovimento.tech/api/v1/cron/agencia-prazos`.
- Lições de seletor: `getByText(titulo, { exact: true })` para achar linha pelo título;
  modal que carrega depois de aberto precisa de espera pelo conteúdo; o painel do navegador
  do app (Claude Browser) **não está logado** — não digitar a senha do dono.
- Medidas de layout por ferramenta (`scrollWidth > clientWidth`), nunca a olho.

---

## 6. Memória do projeto

Os arquivos de memória do assistente ficam em
`C:\Users\foxga\.claude\projects\F---rea-de-Trabalho-SITES-CLIENTES-CRM-TESTE-DeskcommCRM\memory\`
(`modulo-agencia-painel-admin.md`, `agencia-fases-sem-aprovacao.md` e outros). Atualize ao
fechar cada fase.

---

## 6b. ⚠️ Colisão de numeração de migration com o outro chat

Medido em 26/10/2026 no checkout principal (`F:\...\DeskcommCRM`): o outro chat criou
`supabase/migrations/20261024180000_9003_aumentar_limite_fotos_catalogo_10.sql`. Ele colide
com este módulo em DUAS coisas:

- o **número** 9003 é o da Fase 1 da agência (`20261023190000_9003_agencia_equipe_e_avisos.sql`);
- o **timestamp** `20261024180000` é o mesmo da Fase 3 (`20261024180000_9005_agencia_calendario.sql`).

No teste nada quebra (cada SQL foi aplicado pelo conteúdo). Mas, quando as branches da agência
e a do outro chat se encontrarem na `main`, `tests/unit/manifest-x-migrations.test.ts` reprova
(número e carimbo repetidos). **Antes de juntar**, uma das duas tem de ser renumerada (com o
apêndice do `baseline.sql` acompanhando o novo número) — decisão do dono, porque a do outro
chat pode já ter sido aplicada na central. Os números da agência são 9003–9012; para novas, use
**9013 em diante** e confira os dois checkouts antes.

## 7. Falhas de teste que NÃO são do módulo (já existiam no fork)

Quem rodar as cercas vai ver vermelho que **não** é da agência — não "conserte" sem falar com o dono:

- `suporte-cobertura-de-efeitos`: rotas do **Bling** sem `requireSupportWrite`.
- `manifest-x-migrations`: migration **0654** duplicada (social insights × agenda).
- `branding`: arquivos do fork com a marca (`deskcomm` em inbox/catálogo/bling) e hosts do
  fork (bling, youtube, facebook, sualoja/minhaloja).
- `tailwind-tokens`: `rounded` puro e contraste em componentes do fork (ex.: `ProductPickerDialog`).
- `i18n-espanhol-cobre-a-tela`: textos do fork sem espanhol (insights, automações, produtos).
- Testes de caminho no Windows e `rls-completude` (bling/social_insights).

Confira sempre se alguma linha cita `agencia` — essas sim são do módulo.

---

## 8. Lições aprendidas (não repetir)

1. **Typecheck antes de todo commit e de toda publicação.** Na Fase 4 uma mudança pequena em
   Configurações foi publicada sem typecheck; o build do teste falhou (o app ficou na imagem
   anterior, sem queda) e o código-fonte do teste ficou com o arquivo quebrado até ser corrigido.
2. **Outro chat usa a mesma VPS** e constrói a central (`/docker/deskcommcrm`). Nunca construir
   o teste em paralelo; o `publicar-fase.sh` espera, mas confira com
   `pgrep -fa "[b]uildx bake"` (o `[b]` evita o grep achar a si mesmo).
3. **Arquivos compartilhados** do teste (fora de `agencia`) podem ter mudanças do outro chat:
   mande só o **diff** (patch), nunca o arquivo inteiro.
4. **Comentário com aspas** dentro de `CRONS="…"` em `docker/scheduler/entrypoint.sh` derrubou o
   agendador por 10 min na Fase 2. Não use aspas duplas ali.
5. Zod 4: objeto com padrão que passa pelo parse usa `.prefault({})`, não `.default({})`.
6. `"use server"` só exporta funções assíncronas (e tipos).
7. Cliente sem perfil de membro não recebe aviso: o dono precisa ativar o perfil.
8. **SQL com `$$` nunca entra por `String.replace` do JavaScript** (o `$$` da substituição vira `$`).
   Insira o apêndice por fatia (`s.slice(0, i) + bloco + s.slice(i)`) ou pelo Python do
   `publicar-fase.sh`. O `test:db` pegou isso no install da Fase 9.
9. **"Variável presente" não é "variável com valor"**: o `.env` do teste tem as chaves de IA com
   `""`. Confira o comprimento (`${#v}`), nunca imprima o valor.
10. **Antes de qualquer prova que publique fora**, confira se a organização tem conexão real. A
    "Empresa Modelo (Testes)" tem Meta real conectada.
11. Depois de um pedido ao servidor que muda a tarefa, o formulário aberto precisa **reler**; senão
    o próximo Salvar desfaz a mudança (achado da Fase 9).
12. No Git Bash, o Node do Windows não enxerga o `/tmp` do Bash (lê `F:\tmp`): use a pasta de
    rascunho ou `cygpath -w`.

---

## 9. Checklist rápido para a próxima IA

- [ ] Ler este arquivo, o `CLAUDE.md` e o `mapa-de-capacidades.md`.
- [ ] No worktree: `git status` e `git log -8` na `feat/agencia-fase-9`.
- [ ] Ver o §1 › "O que falta" e o §2 (pendências do dono).
- [ ] Nunca: push, central, Docker no PC, senha em chat, mexer no checkout principal.
