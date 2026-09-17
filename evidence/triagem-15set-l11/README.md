# Prova em tela do lote 11 da triagem — 15/set/2026

PRs **#897** (@webtecnica, privacidade do título do Google — issue #892) e **#867**
(@423313, "clientes pela agenda"), na integração `integracao/triagem-15set-l11`,
testada no SHA **`d823662503b993519010b9967748be3febf4e565`**
(`d82366250`, "Merge origin/main (v1.27.3) no lote 11"). Worktree próprio
`qa/lote-11`, limpo fora desta pasta, que ainda não estava versionada.

**Ambiente, o mais perto possível de uma VPS recém-instalada:**

- Supabase local em **Postgres 17.6**, projeto próprio `qa-l11` (portas 6132x), CLI
  2.95.4 (o CI pina 2.117.0). Banco montado **só pelo `supabase/baseline.sql`**
  (`ON_ERROR_STOP=1`, **exit 0**, zero linha de erro no log), sem a cadeia de
  `migrations/` — a pasta saiu do caminho antes do `supabase start`, como o CI faz,
  e voltou ao lugar no fim. PostgREST reiniciado depois do baseline.
- Chave de cifra semeada em `private.app_secrets` (`nuvemshop_oauth_key`, 64 chars),
  como o `ensure_encryption_key` do kit.
- Dona criada por `scripts/bootstrap-owner.ts` (`dona.l11@qa.local`, org
  "Clinica Aurora"); **onboarding concluído pela tela**, pulando o opcional.
  **Sem Google, sem chave de IA, sem Resend, sem Redis** — os envs opcionais
  ausentes, que é o estado de um primeiro deploy.
- `.env.e2e` escrito à mão para ESTE stack (o `scripts/gerar-env-e2e.sh` lê o stack
  de outra sessão). `pnpm e2e:build` → **exit 0 em 399 s**, com o controle positivo
  do próprio script: *"OK (controle): o host local (127.0.0.1:61321) ESTÁ no bundle"*.
  `next start` na porta **3051**.
- Chromium do Playwright com `timezoneId: America/Sao_Paulo`, `locale: pt-BR`,
  `--lang=pt-BR`, 1440×900, tema claro (e uma passada em 400×860, tema escuro).
  O driver **recusava rodar** se o `.env.e2e` não apontasse para `127.0.0.1:61321`.
  Medidas por ferramenta (`aria-checked`, `isEnabled()`, `inputValue()`,
  `getBoundingClientRect`, corpo do POST, leitura no Postgres), nunca a olho.
- Hoje é terça, 15/set (o relógio do servidor virou para 16/set em UTC durante a
  rodada). Dias usados: **quinta 17**, **sexta 18**, **segunda 21** e **terça 22**.

**Duas coisas do ambiente que valem para quem repetir (nenhuma é do lote):**

1. `supabase start` **derruba o stack inteiro** quando um contêiner falha o
   healthcheck — e leva junto o `psql` que estiver aplicando o baseline. Aconteceu
   duas vezes (`storage-api`, depois `realtime`), com os contêineres saindo em
   **exit 137**, que lê como OOM e não era: o log do CLI diz
   `Stopping containers... / supabase_realtime_qa-l11 container is not ready: unhealthy`.
   A saída foi `--ignore-health-check`.
2. Com quatro stacks Supabase na mesma máquina (3,3 GiB no Docker), o Realtime
   **unhealthy** ficou varrendo o WAL e o Postgres passou a responder
   `57014 canceling statement due to statement timeout`, com o GoTrue em `504`.
   Parar o contêiner de Realtime **deste** stack devolveu o login de 3,2 s para
   0,03 s. Consequência declarada: **nada aqui exercita o Realtime**.

## Preparo pela tela

- `00-02-onboarding-boas-vindas.png` e `00-03-onboarding-concluido.png` — o wizard
  do primeiro acesso, do nome do negócio até o Inbox, pulando WhatsApp, IA, teste e
  convites. O passo de convite mostra *"Esta instalação ainda não envia e-mail"* —
  é o `RESEND_API_KEY` ausente, de propósito.
- `01-jornada-seg-a-sex.png` — Equipe › Atendimento › Editar horário de Dono:
  segunda a sexta, 08:00–18:00, `America/Sao_Paulo`. No banco:
  `{"windows":[{"dow":1..5,"start":"08:00","end":"18:00"}],"timezone":"America/Sao_Paulo"}`.
- `897-preparo-google-do-dono.sql` — o SQL que simula o Google da dona (não há
  Google real), adaptado de `evidence/triagem-15set-l10/883-preparo-google-do-dono.sql`:
  conexão `healthy`, uma agenda que conta para conflito com cobertura de 01/09 a
  31/12, e um evento `confirmed`/`opaque` de **segunda 21, 10:00–11:00** com o
  título sensível "Terapia sigilosa as quintas". É o resíduo que uma sincronização
  anterior à v1.17.0 teria deixado — desde a 0225 o sincronizador grava `title` nulo.

## O que o baseline entrega (banco recém-instalado, antes de qualquer jornada)

Medido no Postgres do stack, sem aplicar migration nenhuma:

| pergunta | resposta |
|---|---|
| `contacts` tem as três colunas da 0262 | `client_recognized_at, client_tag_by_system, first_service_at` |
| `crm_pipelines.is_client_pipeline` | existe |
| `fn_definir_cliente_pela_agenda` / `fn_agenda_ocupacao_google_do_dono` / `fn_agenda_conexoes_google_do_dono` | existem, `security definer` |
| gatilhos da 0262 | `trg_agendamento_marca_cliente`, `trg_agendamento_recalcula_cliente`, `trg_agendamento_apagado_recalcula_cliente`, `trg_contato_colunas_de_cliente` |
| a view `calendar_selected_external_events` tem `title`? | **não** |
| `has_column_privilege('authenticated','calendar_external_events','title','SELECT')` | **false** |
| `organizations.settings` recém-criada | `{"llm":{...}}` — **sem** `crm.cliente_pela_agenda`: a regra nasce ausente |

## #867 — o interruptor nasce desligado, e a organização liga quando quiser

### Com a regra DESLIGADA, marcar horário não muda nada

- `867-01-marcado-com-a-regra-desligada.png` — Agenda › Novo agendamento ›
  "Marina Torres" (criada ali mesmo, pelo botão `Criar "Marina Torres"`) › quinta 17
  › 10:00 › Confirmar: **`201`**. Banco: `17/09 10:00 confirmed Marina Torres`.
- `867-02-ficha-sem-etiqueta-regra-desligada.png` — a ficha dela logo depois:
  **não há a linha "Cliente desde"** e TAGS mostra "—". Banco no mesmo instante:
  `tags= | first_service_at=null | client_tag_by_system=null`.
- Mais dois horários, pela mesma tela: **Bruno Salles** (quinta 17, 11:00) e
  **Clara Vidal** (quinta 17, 14:00). Os três contatos seguem sem etiqueta e sem
  `first_service_at` enquanto a regra está desligada.
- `867-03-cancelando-o-unico-horario-do-bruno.png` — Agenda › Próximos › Cancelar no
  horário do Bruno, motivo "Cliente desmarcou". Banco: `17/09 11:00 cancelled`. Ele
  passa a ser o contato cujo **único** horário não conta.

### O caminho até o interruptor, pela navegação

- `867-04-hub-de-configuracoes-tipos-de-agendamento.png` — barra lateral ›
  **Configurações** (`/app/settings`) › seção **SUA EMPRESA** › **"Tipos de
  agendamento"**, com a descrição "O que se pode marcar, quanto dura, onde acontece
  e quem atende.". Um link, achado por papel, não pela URL.
- `867-05-interruptor-nasce-desligado.png` — a seção "Clientes pela agenda" na tela
  de destino: `aria-checked="false"` e a frase *"Desligado: ninguém ganha a etiqueta,
  a ficha não mostra "Cliente desde" e todo contato novo entra pelo funil padrão."*

### Ligar, como admin da organização

- `867-06-confirmacao-antes-de-ligar.png` — o clique no interruptor **pede
  confirmação antes**, e o diálogo diz as três consequências: quem já teve horário
  ganha agora; religar tira a etiqueta que o sistema pôs em quem ficou sem horário
  que conte; desligar depois não tira a etiqueta de ninguém.
- `867-07-ligado-com-o-resultado.png` — "Ligar": `aria-checked="true"`, o estado vira
  *"Ligado: quem marcar horário ganha a etiqueta "cliente" na hora."* e o resultado,
  na própria tela, é **"2 contatos ganharam a etiqueta "cliente"."**
- Banco no mesmo instante — `settings.crm.cliente_pela_agenda = true`, e:

  | contato | tags | `first_service_at` | `client_tag_by_system` |
  |---|---|---|---|
  | Marina Torres | `cliente` | 15/09/2026 | `added` |
  | Clara Vidal | `cliente` | 15/09/2026 | `added` |
  | **Bruno Salles** (só cancelado) | *(vazio)* | `null` | `null` |

- `867-08-ficha-marina-cliente-desde.png` — a ficha da Marina agora tem
  **"CLIENTE DESDE 15/09/2026"** e a etiqueta `cliente`.
- `867-09-ficha-bruno-so-cancelado-sem-etiqueta.png` — a ficha do Bruno, no mesmo
  estado de antes: sem "Cliente desde", TAGS "—". **Cancelado não conta.**
- `867-10-lista-de-contatos-com-a-etiqueta.png` — a lista de Contatos: Marina e
  Clara com a etiqueta `cliente` e o selo "Cliente"; Bruno com "—" e sem selo.

> **A data é a do combinado.** "Cliente desde" saiu **15/09** para horários marcados
> para **17/09**: é `min(least(created_at, starts_at))`, o dia em que se combinou,
> nunca uma data futura. É o que o cabeçalho da 0262 descreve.

### A automação enxerga o que o sistema fez

- `867-14-automacao-quando-ganhar-a-etiqueta.png` — Webhooks › Automações › Nova
  automação: *"Boas-vindas a quem virou cliente"*, gatilho **"Quando um contato
  ganhar uma tag"**, condição **Tag adicionada contém `cliente`**, ação **Adicionar
  tag `recepcao-de-cliente`**. No banco:
  `contact.tag_added | cond=[{"op":"contains","field":"event.added_tags","value":"cliente"}] | acoes=[{"type":"add_tag","config":{"tags":["recepcao-de-cliente"]}}]`.
- `867-16-automacao-ligada.png` — a automação **nasce pausada** e é ligada pelo
  interruptor da linha; a tela passa de "Pausada" para "Ativa" (`is_active=true`).
- `867-17-primeiro-horario-do-diego.png` — **Diego Matos**, contato novo, primeiro
  horário (sexta 18, 15:00): `201`. Na hora, sem cron nenhum, o banco já tem
  `tags=cliente | client_tag_by_system=added | client_recognized_at` preenchido, e
  **uma linha `contact.tag_added` `pending` em `event_log`** — emitida pelo gatilho,
  não por HTTP dentro da transação. O payload é
  `{tags, added_tags, service_origin}`, a mesma forma que
  `app/api/v1/contacts/_handler.ts` emite pelo `emit_event`.
- **Drenado como a VPS drena**, pelo endpoint de cron com o segredo do `.env.e2e`:

  ```console
  $ curl -s -X POST -H "Authorization: Bearer <INTERNAL_CRON_SECRET>" \
      http://localhost:3051/api/v1/cron/event-log-drain
  {"data":{"scanned":7,"done":7,"retried":0,"failed":0,"dead":0,"pulados":[]}}
  ```

- `867-19-historico-da-automacao.png` — Webhooks › Atividade:
  **"Boas-vindas a quem virou cliente · Sucesso · há 1 minuto · Adicionar tag"**.
- `867-18-diego-com-a-etiqueta-da-automacao.png` — a ficha do Diego com
  **`cliente` e `recepcao-de-cliente`**, e "CLIENTE DESDE 15/09/2026". O efeito
  chegou à tela.

> **Ligar a regra NÃO dispara automação por contato** — e a tela avisa isso antes,
> no próprio painel. Medido: Marina e Clara viraram clientes pela ligação e
> **nenhum** `contact.tag_added` saiu por elas; os eventos existentes são do Diego
> (gatilho), da própria ação da automação sobre o Diego, e da Helena (gatilho).

### A etiqueta que a equipe tira à mão não volta

- `867-20-helena-virou-cliente.png` — **Helena Prado**, contato novo com a regra já
  ligada, primeiro horário (sexta 18, 16:00): ficha com `cliente` e "Cliente desde".
- `867-21-tirando-a-etiqueta-a-mao.png` — Editar contato, campo "Tags" esvaziado
  (ele continha exatamente `cliente`).
- `867-22-helena-sem-a-etiqueta.png` — a ficha depois de salvar: TAGS "—". No banco,
  `client_tag_by_system` passou de `added` para **`null`** — o dono da etiqueta
  agora é a equipe.
- `867-23-a-etiqueta-nao-volta.png` — **novo horário para ela** (sexta 18, 17:00,
  `201`, dois horários confirmados no banco): a ficha continua com TAGS "—".
  `tags=` e `client_tag_by_system=null`. **A etiqueta não volta.**

### Desligar não tira etiqueta de ninguém; religar não repõe a que a equipe tirou

- `867-27-desligado-ninguem-perde-a-etiqueta.png` — desligar **não pede confirmação**
  (medido: nenhum `alertdialog` aparece) e a chave vira `false`. A tabela de
  contatos antes e depois é **idêntica, linha a linha** — ninguém perdeu etiqueta.
- `867-28-religado-a-etiqueta-tirada-a-mao-nao-volta.png` — religar devolve
  **"Nenhum contato novo ganhou a etiqueta: 6 contatos já eram clientes."** e a
  tabela **não muda**: Clara e Helena, cujas etiquetas a equipe tirou, seguem sem
  etiqueta (`client_tag_by_system=null`) e com `first_service_at` preservado. Os
  seis são os que têm `first_service_at`, porque a coluna é que manda; a etiqueta é
  de trabalho.

### Quem não é admin não liga

- `867-24-hub-do-atendente.png` — a Atendente (papel `agent`) **vê** "Tipos de
  agendamento" no hub: a tela é de leitura para ela.
- `867-25-atendente-nao-liga-o-interruptor.png` — na tela, a seção aparece, o
  interruptor está **desabilitado** (`isEnabled() === false`) e abaixo dele a frase
  *"Só um administrador pode mudar essa regra."*. Um clique **forçado** por
  ferramenta não muda `aria-checked` nem a chave no banco.

### 400 px, tema escuro

- `867-26-interruptor-400px-tema-escuro.png` — `data-theme="dark"`,
  `documentElement.scrollWidth` **400** = `clientWidth` **400**, **0** elementos
  fora da tela, fundo `rgb(22, 21, 16)`, a seção inteira entre 48 px e 352 px.

## #897 — o título do compromisso pessoal sai do alcance do colega

### A Atendente, criada pela tela do começo ao fim

- `897-01-convite-do-atendente.png` — Equipe › Convidar membros,
  `atendente.l11@qa.local`, papel `agent`.
- `897-02-link-do-convite-na-tela.png` — `201` e, **sem Resend**, a tela mostra o
  link copiável (`email_dispatched: false`).
- `897-03-aceitando-o-convite.png` — o link aberto num navegador **sem sessão**:
  "Você foi convidado… Fazer login / Ainda não tenho conta".
- `897-04-criar-conta-do-atendente.png` — "Ainda não tenho conta" › `/signup?invite=…`
  com o e-mail **já preenchido e travado** pelo convite; nome e senha digitados.
- `897-05-conta-criada-confirme-o-email.png` — "Confirme seu e-mail".
- `897-06-atendente-dentro-do-sistema.png` — o link de confirmação lido **na caixa
  local** (Mailpit do stack, assunto "Confirme seu e-mail — DeskcommCRM") leva ao
  Inbox. Banco: `atendente.l11@qa.local | agent | confirmado=true`. **Nenhum passo
  por script ou SQL.**

### Nenhuma tela mostra o título

Varredura por ferramenta de `document.body.innerText` **e** do
`document.documentElement.outerHTML` inteiro (que carrega o payload do servidor),
procurando `terapia`, `sigilos` e `quintas`:

| tela (logada como Atendente) | vazamento | "Ocupado" no texto |
|---|---|---|
| `897-07-atendente-agenda-semana.png` — Agenda, semana corrente | **nenhum** | 0 |
| Agenda, visão Dia | **nenhum** | 0 |
| Agenda, visão Mês | **nenhum** | 0 |
| `897-08-atendente-semana-do-evento.png` — semana 20–26, onde o evento está | **nenhum** | 0 |
| `897-09-atendente-segunda-21-sem-as-10h.png` — painel de marcar, segunda 21 | **nenhum** | 0 |

### Pela REST, com o token de sessão da Atendente (diagnóstico, não prova de tela)

O token veio de `GET /api/v1/auth/realtime-token` dentro da sessão dela — os dois
(chave anon e token) vivem no navegador de quem está logado.

| consulta | resposta |
|---|---|
| `select=title` em `calendar_external_events` | `42501 permission denied for table calendar_external_events` |
| `select=title` na view `calendar_selected_external_events` | `42703 column calendar_selected_external_events.title does not exist` |
| `select=*` na tabela | `42501 permission denied` |
| `select=*` na view | a linha **sem `title`** — intervalo, `status`, `transparency`, `external_calendar_id`, `external_event_id` |
| **controle positivo**, com a chave de serviço | `[{"title":"Terapia sigilosa as quintas"}]` |
| `anon` sozinha, na view | `42501 permission denied for view` |

O controle positivo é o que impede a leitura otimista: o título **existe** no banco
e mesmo assim nenhum login de usuário o alcança. Logada como **dona**, as mesmas
duas consultas dão as mesmas duas recusas (`42501` e `42703`) — a leitura é fechada
para o dono também, como a migration 0261 declara; e a leitura que a tela dela faz
(`starts_at, ends_at, status, transparency`) continua respondendo.

### Para a dona, nada quebrou

- `897-11-dona-semana-do-evento.png` — semana 20–26 como dona: **1** bloco
  "Ocupado" na segunda 21, e nenhum vazamento do título no texto ou no HTML. O GET
  que a tela dela usa devolve
  `{"titulo":"Ocupado","iniciaEm":"2026-09-21T13:00:00+00:00","situacao":"confirmed","origem":"google_sync"}`.
- `897-12-dona-segunda-21-sem-as-10h.png` — o painel dela na segunda 21 oferece 18
  horários, de 08:00 a 17:30, **sem 10:00 e sem 10:30**, com 11:00 presente.

### A regressão do lote 10 continua de pé

- `897-09-atendente-segunda-21-sem-as-10h.png` — a **Atendente** vê os mesmos 18
  horários na segunda 21: `10:00` e `10:30` **não** são oferecidos, `11:00` é. A
  ocupação do Google da dona não depende de quem consulta.
- `897-10-atendente-encaixe-1015-recusado.png` — "Outro horário" › 10:15 › Usar ›
  Confirmar, como Atendente: **`422 agenda_horario_indisponivel`**, com a frase
  *"Este horário já está ocupado na agenda de quem atende — por outro compromisso ou
  pelo Google Agenda."*. Não diz "Marcado.", **não cita o título** (busca por
  `terapia`/`sigilos`/`quintas` na recusa e na página inteira: falso), e o banco
  segue com **0** agendamentos em 21/09.

## Regressão rápida

- `regr-01-encaixe-1515-marcado.png` — "Outro horário" num encaixe **livre**:
  segunda 21, 15:15, para a Marina: **`201`**, "Marcado.", banco
  `21/09 15:15-15:45 confirmed ui user`. O painel mede 468–876 px numa janela de
  900 — o Confirmar continua alcançável.
- `regr-02-admin-meta-carrega.png` — `/admin/meta` como platform admin: **`200`** em
  4069 ms, "API Oficial da Meta desta instalação", sem 5xx.

## Achados — nenhum no código do lote

1. **O contato criado de dentro do painel de marcar demora a aparecer no seletor, e
   o que a tela mostra enquanto isso é uma escolha ERRADA e plausível.** Ao usar
   `Criar "<nome>"` em Novo agendamento, o contato é criado (`201`) mas o campo
   "Quem será atendido" continua exibindo **"Compromisso pessoal, sem cliente"** até
   a consulta de vínculos voltar — sem nenhuma indicação de carregamento. Medido
   com o relógio, sob a máquina carregada: clique em "Criar contato" em `+18,5 s`,
   requisição `contact_id=…` disparada só em `+21,1 s`, respondida em `+21,9 s`,
   seletor preenchido em `+22,8 s` — **~4 s de janela**. Com o ambiente saudável
   (Realtime parado) a janela caiu para menos de 1,5 s e **não consegui produzir um
   agendamento sem cliente**: as duas tentativas em que confirmei logo depois
   gravaram o contato certo (`contato=Rita Bastos`, `contato=Vera Lins`). Então o
   que está medido é o **estado exibido**, não um desfecho errado — mas a
   combinação "sem estado de carregamento" + "a opção de reserva é uma escolha
   legítima do negócio" é a família do controle decorativo, e com o #867 ligado o
   preço de errar subiu: horário sem contato não faz ninguém virar cliente, em
   silêncio. `components/agenda/VinculoDaMarcacao.tsx`, **não tocado pelo lote**
   (`git log` do intervalo `merge-base..HEAD` nesse arquivo: vazio).
2. **Todo agendamento gera um `crm.activity_write_failed` em `event_log`.** Payload:
   `{"erro":null,"origem":"agenda (sem negócio aberto para ancorar)","activity_type":"appointment_scheduled"}`.
   Contatos criados direto na Agenda não têm negócio aberto, e a atividade de
   timeline não encontra âncora. Anterior ao lote e independente da regra nova (as
   linhas aparecem com a regra desligada).

## O que estas imagens NÃO provam

- Google Agenda real (OAuth, sincronização, evento vindo do Google): a ocupação e o
  título foram semeados por SQL, declarado em `897-preparo-google-do-dono.sql`.
- **Realtime**: o contêiner foi parado no meio da rodada (ver o ambiente, acima).
  Nenhuma tela aqui depende de entrega ao vivo.
- **O funil "de clientes"** do #867 (`crm_pipelines.is_client_pipeline`): a coluna
  existe no baseline, nenhum funil foi marcado e nenhum negócio foi criado por essa
  via. Não exercitado.
- `manager`, `viewer` e acompanhamento de suporte: só `admin` e `agent`.
- O caminho do agente de IA (ferramenta MCP) sobre a regra nova.
- A recusa do SERVIDOR ao `agent` que tentasse ligar a regra: provado só o gate da
  tela (interruptor desabilitado) e o não-efeito no banco; `fn_definir_cliente_pela_agenda`
  não foi chamada diretamente com o token dela.
- WhatsApp, IA e e-mail transacional (Resend): ausentes de propósito.
