# Prova em tela do encaixe pela porta do painel (#858) — 15/set/2026

A QA do lote 8 marcou o #858 como **FALHOU EM TELA**: o servidor aceitava que uma
pessoa da equipe marcasse fora da grade, e nenhuma tela chegava lá
(`evidence/triagem-15set-l8/858-02-painel-oferece-so-hora-cheia.png`). Esta pasta é
a prova da porta que faltava: "Outro horário" no painel de marcar.

Branch `triagem/lote-8-encaixe-na-tela`, testada no SHA **`0c71973d4`** (worktree
limpo fora desta pasta, que ainda não estava versionada).

**Ambiente, o mais perto possível de uma VPS recém-instalada:**

- Supabase local em **Postgres 17**, projeto próprio (`l8-encaixe`, portas 5832x),
  banco zerado (`supabase db reset`) e montado **só pelo `supabase/baseline.sql`**
  (`ON_ERROR_STOP=1`), sem as migrations. Realtime e PostgREST reiniciados depois do
  baseline, como no CI.
- Chave de cifra semeada em `private.app_secrets`, como o `install.sh` faz.
- Dona criada por `scripts/bootstrap-owner.ts`; onboarding concluído **pela tela**,
  pulando o opcional. Jornada publicada pela tela (Equipe › Atendimento: segunda,
  08:00–18:00, `America/Sao_Paulo`) e tipo "Consulta de 1 hora" (60 min) criado em
  Configurações › Agenda. Com 60 minutos, a grade de segunda é de hora cheia.
- `next build` com o `.env.e2e` (exit 0) + `next start` na porta 3031. **Sem Google,
  sem chave de IA, sem Resend.**
- Chromium do Playwright com `timezoneId: America/Sao_Paulo`, `locale: pt-BR` e
  `--lang=pt-BR` (é o idioma da interface do navegador que formata o
  `<input type="time">`; sem ele o campo aparecia como "10:30 AM"). Os scripts
  recusavam rodar se o Supabase não fosse `127.0.0.1:58321`.
- Medidas por ferramenta (`getBoundingClientRect`, `scrollWidth`), nunca a olho.
  Hoje é terça, 15/set; os dias usados são **segunda 21** (com grade) e **domingo 20**
  (sem horário publicado).

## A jornada, como a dona do negócio faria (1440×900, tema claro)

- `02-painel-oferece-outro-horario.png` — Novo agendamento › segunda 21: o painel
  lista só horas cheias (08:00 a 17:00, dez horários) e, abaixo delas, "Outro
  horário" (dentro do painel e da janela: 827–863px contra o painel em 468–876). O
  domingo 20 está clicável. Na grade, medido no mesmo passo, o bloco das 10:30 segue
  desabilitado e o das 10:00 livre: a grade não mudou.
- `03-outro-horario-1030-confirmando.png` — "Outro horário" › 10:30 › Usar: a mesma
  confirmação de sempre, "segunda-feira, 21 de setembro às 10:30". O botão Confirmar
  termina em 875px, dentro do painel (876).
- `04-marcado-1030.png` — Confirmar: `POST` com `starts_at` `2026-09-21T13:30:00.000Z`
  → `201`, e "Marcado." No banco: `10:30-11:30`, `confirmed`, `created_by_kind=user`,
  `source=ui` (lido em `America/Sao_Paulo`).
- `05-grade-mostra-o-encaixe-1030.png` — "Ver na agenda": o card "Consulta de 1 hora,
  10:30 às 11:30" começa na mesma altura do bloco das 10:30 (728,5px nos dois; o das
  10:00 está em 704,5).
- `06-recusa-por-cima-do-encaixe.png` — outro encaixe, 10:45, por cima do das 10:30:
  `422 agenda_horario_indisponivel`. O painel continua em "confirmando", não diz
  "Marcado.", e mostra acima do Confirmar a frase da rota: "Este horário já está
  ocupado na agenda de quem atende — por outro compromisso ou pelo Google Agenda." O
  campo continua com 10:45. Recusa em 777–831px e Confirmar em 843–875, os dois
  dentro do painel. No banco segue um compromisso só no dia.
- `07-domingo-sem-grade-encaixe-0915.png` — com o painel ainda aberto, domingo 20: sem
  lista de horários (0), o aviso "Nenhum horário publicado neste dia." e o campo já
  aberto no topo da coluna, com o 10:45 que ela tinha digitado. Trocado para 09:15 e
  confirmado: `201`, banco `09:15-10:15`.
- `08-remarcar-para-outro-horario-1115.png` — Próximos › Remarcar no compromisso das
  10:30: o painel "Remarcar agendamento" é o mesmo, com "Outro horário" › 11:15.
- `09-grade-mostra-remarcado-1115.png` — Confirmar: `PATCH` com `starts_at`
  `2026-09-21T14:15:00.000Z` → `200`; o card "11:15 às 12:15" na grade e o banco com
  `11:15-12:15`.

## 400px, tema escuro

- `10-400px-escuro-outro-horario.png` — o painel empilhado, campo "Outro horário"
  aberto com 12:30. `document.scrollWidth` 400 = `clientWidth` 400, diálogo 399 = 399,
  nenhum elemento fora da tela, `data-theme="dark"`.
- `11-400px-escuro-confirmando-1230.png` — Usar: a confirmação é levada até a vista
  (Confirmar em 387–431px numa janela de 860), 400/400 de novo.

## Quem não pode marcar

- `12-somente-leitura-sem-outro-horario.png` — uma pessoa com papel `viewer` ("Somente
  leitura") no mesmo painel: "Outro horário" 0, campo de hora 0, domingo desabilitado,
  e os horários da grade continuam lá. **Preparo, não prova:** essa pessoa foi criada
  pela API admin do Supabase local e vinculada por `INSERT` em `user_organizations`; o
  convite por e-mail não estava sob teste.

## O botão Confirmar fora do alcance — achado pela prova, e consertado

Na primeira rodada (SHA `25d09e34d`, com o encaixe e sem o conserto) a recusa saía
cortada. Medido escolhendo um horário da lista: o botão Confirmar estava **inteiro
fora do painel** em 1280×800 (começava em 840px, painel terminando em 776) e em
1366×768 (821 contra 744), e cortado em 1440×900 (857–889 contra 876). O defeito é
anterior ao encaixe e vale para toda marcação: o painel tem a altura do Sheet, que não
rola, e o `overflow-hidden` cortava sem barra.

Depois do conserto (`0c71973d4`), com um encaixe recusado na tela, nas seis larguras:

| janela | Confirmar termina / painel termina | coluna de horários antes → depois da recusa | painel / Sheet (direita) | clique no Confirmar |
|---|---|---|---|---|
| 1024×800 | 775 / 776 | 726 → 726 | 1007 / 1024 | aceito |
| 1280×800 | 775 / 776 | 966 → 966 | 1247 / 1280 | aceito |
| 1366×768 | 743 / 744 | 1052 → 1052 | 1333 / 1366 | aceito |
| 1440×900 | 875 / 876 | 1126 → 1126 | 1407 / 1440 | aceito |
| 1920×1080 | 955 / 1056 | 1606 → 1606 | 1887 / 1920 | aceito |
| 900×800 (empilhado) | 426 / 981 | 158 → 158 | 876 / 900 | aceito |

"Clique aceito" é o `click({ trial: true })` do Playwright, que confere se o ponto
recebe o clique. `document.scrollWidth` = `clientWidth` nas seis. Numa versão
intermediária a coluna de horários pulava 9px para a direita quando a recusa
aparecia; a coluna "antes → depois" é a medida de que não pula mais.

## O que estas imagens NÃO provam

- **Evento do Google Agenda ocupando o encaixe** — sem Google real.
- **Navegador num fuso diferente do fuso da jornada.** A hora digitada vira instante
  pelo fuso que o painel mostra (coberto por `tests/unit/agenda-encaixe-no-painel.test.tsx`,
  com São Paulo e Tóquio perto da meia-noite). Mas o painel e a grade escrevem os
  horários no fuso do **navegador** — isso é anterior a esta entrega. Com os dois
  fusos diferentes, a confirmação mostraria outra hora que a digitada; aqui os dois
  eram `America/Sao_Paulo`.
- Jornada não publicada e consulta de horários com erro escondendo a opção: só por
  teste de componente.
- Papel Atendente (`agent`) e acompanhamento de suporte: a regra da tela é
  `papel >= agent`, igual ao piso da rota; só o dono (admin) e o `viewer` foram vistos.
- Arrastar um compromisso para fora da grade: continua sem porta, de propósito.
