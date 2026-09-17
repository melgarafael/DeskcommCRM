# Prova em tela do lote 10 da triagem — 15/set/2026

PRs #882 e #883 de @webtecnica (issues #878 e #879), na integração
`integracao/triagem-15set-l10`, testada no SHA **`ca13073ea`** (worktree limpo; esta
pasta é a única coisa nova). Controle na `origin/main` **`a0c88136a`**, num worktree
detached próprio, removido ao fim.

**Ambiente, o mais perto possível de uma VPS recém-instalada:**

- Supabase local em **Postgres 17.6**, projeto próprio `qa-l10` (portas 6032x), CLI
  2.95.4 (o CI pina 2.117.0). Banco montado **só pelo `supabase/baseline.sql`**
  (`ON_ERROR_STOP=1`, exit 0), sem as migrations. PostgREST e Realtime reiniciados
  depois do baseline. As duas funções da migration 0260 existem, `security definer`,
  com EXECUTE só para `authenticated`, `service_role` e `postgres`.
- Chave de cifra semeada em `private.app_secrets`, como `ensure_encryption_key` do kit.
- Dona criada por `scripts/bootstrap-owner.ts`; onboarding concluído **pela tela**,
  pulando o opcional. **Sem Google, sem IA, sem Resend.**
- `next build` com um `.env.e2e` escrito à mão para este stack (**exit 0**, 112 s) +
  `next start` na 3041. A `main` foi buildada do mesmo jeito (**exit 0**, 132 s) e
  servida na 3042 contra o MESMO banco — ela não chama as funções novas, então o banco
  com o apêndice da 0260 não muda o caminho dela.
- Chromium do Playwright com `timezoneId: America/Sao_Paulo`, `locale: pt-BR`,
  `--lang=pt-BR`, 1440×900, tema claro. Os scripts recusavam rodar se o `.env.e2e`
  não apontasse para `127.0.0.1:60321`. Medidas por ferramenta (contagem de
  `data-testid`, `aria-label`, corpo do GET, `getBoundingClientRect`), nunca a olho.
- Hoje é terça, 15/set. Dias usados: **quinta 17** (folga), **sexta 18** (controle),
  **segunda 21** (evento do Google).

## Preparo pela tela

- `00-jornada-ate-23h.png` — Equipe › Atendimento › Editar horário de Dono: segunda a
  sexta, 08:00–23:00, `America/Sao_Paulo`. **Declarado:** o script de preparo rodou
  duas vezes por engano e a segunda passada acrescentou cinco janelas "Seg 08:00–18:00"
  (é o que a tabela ao fundo ainda mostra). Elas foram removidas pela lixeira do
  próprio diálogo antes desta captura; o `PATCH` devolveu `200` e o banco ficou com as
  cinco janelas de 08:00–23:00 e nada mais.
- Configurações › Agenda › Novo tipo: "Sessão de 30 minutos", 30 min, quem atende Dono
  (`201`). Com 30 minutos, a noite tem 21:00, 21:30, 22:00 e 22:30.
- `882-01-folga-quinta-17-o-dia-todo.png` — Dias sem atendimento › 17/09 › "folga" ›
  Fechar este dia: `201`, banco `2026-09-17`, `0..1440`, `is_unavailable = true`, na
  agenda da dona.
- `883-01-convite-atendente-link-na-tela.png` — Equipe › Convidar membros, papel
  `agent`: `201`, e sem Resend a tela mostra o link copiável. O link foi aberto num
  navegador sem sessão › "Ainda não tenho conta" › Criar conta › e-mail de confirmação
  lido na caixa local do Supabase › link › a Atendente cai no Inbox. Banco:
  `atendente.l10@qa.local` com `role = agent` na mesma organização. **Nenhum passo por
  script ou SQL.**
- `883-preparo-google-do-dono.sql` — o SQL que simula o Google da dona (não há Google
  real): uma `calendar_connections` `healthy` com `last_sync_at = now()`, uma
  `calendar_connection_calendars` que conta para conflito com cobertura de 01/09 a
  31/12, e um `calendar_external_events` `confirmed`/`opaque` de **segunda 21, 10:00–11:00**
  com o título sensível "Cardiologista particular - exame de esforco". Antes de cada
  rodada, `last_sync_at` das duas tabelas foi renovado para `now()`, porque
  `fn_google_coverage` marca cobertura parcial depois de 30 minutos. Nas rodadas o GET
  devolveu `google_cobertura_parcial: false`, `fontes_defasadas: []`,
  `agenda_externa_nunca_lida: false`.

## #882 — dia de folga não oferece horário à noite

- `882-02-quinta-17-folga-sem-horario.png` — Agenda › Novo agendamento › Sessão de 30
  minutos › quinta 17: `data-disponivel="false"`, lista de horários com **0** botões,
  "Nenhum horário publicado neste dia." e o campo "Outro horário" já aberto (o encaixe
  da equipe continua existindo, por desenho). No GET do mês, **0** horários caem no dia
  17 local.
- `882-03-sexta-18-controle-oferece-21h.png` — sexta 18, no mesmo painel: 30 horários,
  de 08:00 a 22:30, e o botão 21:00 existe (GET: `21:00` = `2026-09-19T00:00Z`, já no
  dia UTC seguinte).
- **O painel de dia não discrimina o conserto.** A mesma jornada na `main` dá a mesma
  tela: `main-882-02-quinta-17-folga-sem-horario.png` (0 horários na quinta) e
  `main-882-03-sexta-18-controle-oferece-21h.png` (30 na sexta). A causa é medida no
  GET: o painel pede o mês a partir de AGORA (`de=2026-09-15T11:04Z`), e a busca pela
  data UTC de `de` já alcança a exceção do dia 17. O defeito só aparece quando a janela
  começa **depois** de 00:00Z do dia seguinte ao bloqueado.
- **O caso que discrimina, pela tela:** a dona abre o painel **às 21:05 do próprio dia
  de folga** (relógio do navegador em 17/09 21:05 −03:00; o do servidor segue o real,
  e os horários da noite do dia 17 estão no futuro para os dois). O GET sai com
  `de=2026-09-18T00:05Z`.
  - `main-882-04-quinta-17-folga-aberto-as-2105.png` — na `main`, a quinta 17 aparece
    como dia com vaga: **21:30, 22:00 e 22:30** oferecidos, num dia inteiro fechado.
    É o defeito do #878.
  - `882-04-lote-quinta-17-folga-aberto-as-2105.png` — no lote, a mesma quinta: **0**
    horários, "Nenhum horário publicado neste dia.". Sexta 18 continua com 30 e com
    21:00, nas duas árvores.

## #883 — a Atendente enxerga a ocupação do Google da dona

- `883-02-atendente-segunda-21-sem-10h.png` — logada como Atendente, Novo agendamento ›
  Sessão de 30 minutos (tipo cuja responsável é a dona) › segunda 21: 28 horários;
  entre 09:00 e 11:30 aparecem 09:00, 09:30, 11:00 e 11:30 — **10:00 e 10:30 não**
  (contagem 0 dos dois `data-testid`). O GET do mês confirma: nada entre 10:00 e 11:00.
- `883-02-atendente-encaixe-1015-recusado.png` — "Outro horário" › 10:15 › Usar ›
  Confirmar: `POST` com `starts_at 2026-09-21T13:15:00.000Z` → **`422
  agenda_horario_indisponivel`**. Acima do Confirmar: "Este horário já está ocupado na
  agenda de quem atende — por outro compromisso ou pelo Google Agenda." A recusa ocupa
  777–831 px e o Confirmar 843–875, dentro do painel (876). "Marcado." não aparece. A
  frase **não** cita o título (busca por "cardiolog"/"esfor" na recusa e na página
  inteira: falso).
- `883-03-dona-segunda-21-sem-10h.png` e `883-03-dona-encaixe-1015-recusado.png` —
  logada como dona, a mesma resposta: 10:00 e 10:30 fora da lista, encaixe 10:15 com o
  mesmo `422` e a mesma frase.
- **Controle na `main`**, logada como Atendente:
  - `main-883-atendente-segunda-21-oferece-10h.png` — segunda 21 oferece **10:00 e
    10:30** (GET: `10:00` = `13:00Z`, `10:30` = `13:30Z`), por cima do evento da dona.
  - `main-883-atendente-encaixe-1015-marcado.png` — o encaixe 10:15 é **aceito**:
    `201`, "Marcado.", e o banco ganha `21/09 10:15–10:45`, criado pela Atendente, na
    agenda da dona, em cima do compromisso pessoal dela. É o defeito do #879.

## Privacidade (issue #892) — só medido, nada consertado

- `892-01-atendente-semana-20-26.png` — Agenda como Atendente, semana 20–26: **0**
  ocorrências de "Ocupado", e o título do evento não está nem no texto nem no HTML da
  página (incluindo atributos e payload do servidor). O mesmo nas visões Dia e Mês. O
  `GET /api/v1/agenda/agendamentos` da semana devolve **0** itens para ela.
- `892-02-dona-semana-20-26.png` — como dona: **1** bloco "Ocupado 10:00" na segunda
  21, sem título no texto nem no HTML; o GET devolve 1 item com `titulo: "Ocupado"`.
- `892-03-atendente-grade-segunda-21-10h.png` e `892-04-dona-grade-segunda-21-10h.png`
  — a grade "Horários livres de" na segunda 21: os blocos 10:00 e 10:30 estão travados
  para as duas, mas o motivo difere. Dona: "já há um compromisso neste horário".
  Atendente: **"fora dos horários que você publicou"** — frase errada duas vezes: a
  jornada não é dela, e 10:00 está dentro da jornada publicada.
- **Diagnóstico por API, não prova de tela:** com a chave anon e o token de sessão da
  Atendente (os dois vivem no navegador dela), `GET /rest/v1/calendar_external_events`
  e `GET /rest/v1/calendar_selected_external_events` devolvem o **título**
  "Cardiologista particular - exame de esforco". `calendar_connections` devolve `[]`.
  A RPC nova `fn_agenda_ocupacao_google_do_dono` devolve só início, fim,
  `transparency`, `status` e `connection_status`; chamada só com a chave anon, `42501
  permission denied`. Ou seja: a tela não vaza o título, a REST vaza — para qualquer
  membro da organização.

## Regressão rápida

- `regr-01-dona-encaixe-1115-marcado.png` — como dona, "Outro horário" › 11:15 na
  segunda 21 (livre): `201`, "Marcado.", "com Dono"; banco `21/09 11:15–11:45`,
  `confirmed`, `created_by_kind = user`, `source = ui`, na agenda da dona.
- `regr-02-admin-meta-carrega.png` — `/admin/meta` como platform admin: `200` em
  1649 ms, "API Oficial da Meta desta instalação", "Nunca configurado por aqui.",
  nenhuma resposta 5xx. **Aberta digitando a URL** (a porta pelo menu foi provada no
  lote 8).

## Defeitos achados — nenhum no código do lote

1. **A Atendente abre "Novo agendamento" e a tela diz que ela não tem permissão, e que
   o compromisso é com "Você".** `GET /api/v1/team` responde `403` para o papel
   `agent`; a lista de pessoas da Agenda fica vazia e o painel cai no reserva
   `{ nome: "Você" }` (`app/app/agenda/_client.tsx:670-671`). O toast "Você não tem
   permissão para esta ação." aparece ao abrir a Agenda. A marcação vai para a agenda
   da dona (a rota resolve o dono pelo tipo) — só a tela mente sobre com quem. Igual
   na `main`. Visível em `883-02-atendente-segunda-21-sem-10h.png` e
   `main-883-atendente-segunda-21-oferece-10h.png`.
2. **A grade da Atendente não desenha a ocupação do Google da dona, e explica o bloco
   travado com a frase errada** (item acima, `892-03-atendente-grade-segunda-21-10h.png`).
   É a mesma causa do #879 em dois leitores que o lote não tocou: a semente de
   `app/app/agenda/page.tsx` e `GET /api/v1/agenda/agendamentos`
   (`app/api/v1/agenda/agendamentos/route.ts`) ainda chegam aos eventos pelo embed
   `calendar_connections!inner`, que a RLS esconde de `agent`. Consertar é decidir o
   que a Atendente pode ver da agenda pessoal da dona — a pergunta do #892 —, então
   fica reportado, não consertado. A frase na `main` **não foi medida** (lá o 10:00
   estava livre para ela).
3. **Copy imprecisa num dia fechado:** a quinta de folga diz "Nenhum horário publicado
   neste dia." — a dona publicou; ela fechou o dia. Anterior ao lote.

## O que estas imagens NÃO provam

- Google Agenda real (OAuth, sincronização, evento vindo do Google): a ocupação foi
  semeada por SQL.
- O caminho do agente de IA (ferramenta MCP) e a validação de escrita para quem não é
  pessoa, onde o #878 também morava: só a tela da equipe foi exercitada.
- Gerente (`manager`), `viewer`, 400 px e tema escuro.
- A caixa de e-mail local renderiza `__APP_NAME__` no corpo da confirmação — é
  o template cru do Supabase local; o kit da VPS não foi exercitado aqui.
