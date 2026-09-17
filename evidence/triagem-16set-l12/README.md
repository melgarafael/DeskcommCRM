# Prova em tela do lote 12 da triagem — 16/set/2026

Integração `integracao/triagem-15set-l12`, testada no SHA
**`778d1dcb27bff20fd465659b12de339ae419a0ca`** (`778d1dcb2`, "Merge
triagem/lote-12-g5: os consertos do grupo G5 no lote 12"), num worktree próprio
`qa/lote-12`. Dezesseis PRs no lote; o que segue diz, item a item, o que foi
PROVADO pela tela, o que FALHOU e o que ficou NÃO MEDIDO — e por quê.

## Ambiente, o mais perto possível de uma VPS recém-instalada
## Ambiente, o mais perto possível de uma VPS recém-instalada

- Worktree próprio `qa/lote-12` em `/Users/rafaelmelgaco/wt/qa-l12`, criado de
  `origin/integracao/triagem-15set-l12`. O checkout de trabalho de outra sessão
  não foi tocado.
- Supabase local **Postgres 17.6**, projeto próprio `qa-l12` (portas **6232x**),
  CLI 2.95.4. Banco montado **só pelo `supabase/baseline.sql`** — a pasta
  `supabase/migrations/` saiu do caminho antes do `supabase start`, como o CI
  faz, e voltou ao lugar no fim.
- **`psql -v ON_ERROR_STOP=1 -f supabase/baseline.sql` → exit 0, zero linha de
  ERROR/FATAL, em 7 min 48 s** (a máquina estava em load 80; numa VPS ociosa é
  ordem de minuto). 129 tabelas em `public` depois dele.
- Chave de cifra semeada em `private.app_secrets` (`nuvemshop_oauth_key`, 64
  chars), como o `ensure_encryption_key` do `hostgator-setup-kit/_common.sh`.
- Dono criado por `scripts/bootstrap-owner.ts` (`dona.l12@qa.local`, org
  "Clinica Bem Viver"). As jornadas do lote correm na organização de teste que
  `scripts/seed-e2e-credentials.ts` semeia, porque quatro delas precisam da
  matriz de papéis (`admin`, `manager`, `agent`, `viewer`) — é o mesmo caminho
  do job `e2e` do CI.
- **Sem WhatsApp, sem chave de IA, sem Resend, sem Google, sem Redis.** O
  servidor anuncia isso no boot: *"Nenhuma chave de IA configurada … o agente vai
  pular toda resposta com reason='ai_gateway_key_missing'"*. É o estado de um
  primeiro deploy, de propósito.
- `.env.e2e` escrito **à mão** para ESTE stack. O `scripts/gerar-env-e2e.sh` não
  serviria: ele grava `SUPABASE_DB_URL=…@127.0.0.1:54322`, que é o banco de
  outra sessão.
- `pnpm e2e:build` → **exit 0**, com o controle positivo do próprio script:
  *"OK (controle): o host local (127.0.0.1:62321) ESTÁ no bundle — o grep está
  vivo."* `next start` na porta **3052**.

### Três coisas do ambiente que valem para quem repetir (nenhuma é do lote)

1. **`drop schema public cascade` derruba as extensões junto.** A primeira
   aplicação do baseline morreu pela metade (o `psql` de fundo foi morto pelo
   harness), e limpar para recomeçar levou `vector`, `citext` e `pg_trgm`, que
   moram em `public`. O baseline seguinte parou em
   `ERROR: type public.vector does not exist` — o baseline **não cria** as
   extensões (é um `pg_dump --schema-only`); quem as cria é o prelude do
   `scripts/test-db.sh` (linhas 204-212). Recriá-las antes resolveu.
2. **A máquina estava saturada** (load 80-120, 33 contêineres de outras sessões,
   3,3 GiB de teto no Docker). O efeito não é "lento": o PostgREST deste stack
   perdia a conexão com o Postgres e respondia **503 `PGRST002`** por ~5 s
   enquanto recarregava o cache de schema, e o GoTrue devolvia `login_failed` com
   `could not translate host name`. Isso derruba preparo de fixture e faz a
   sessão medir o VIZINHO em vez do lote. A saída foi **reenvio no preparo e no
   login** (nenhuma asserção do lote passa por ali) e parar os contêineres
   próprios que não eram usados (`studio`, `pg_meta`, `inbucket`, `realtime`).
   **Consequência declarada: nada aqui exercita o Realtime.**
3. **O `webServer` do Playwright tem 120 s de teto e eles não bastaram.** O
   `next start` levou mais que isso para responder na porta e o run inteiro
   morria antes do primeiro teste (`Timed out waiting 120000ms from
   config.webServer`). Para esta sessão o teto virou
   `Number(process.env.E2E_WEBSERVER_TIMEOUT_MS ?? 120_000)` — **revertido antes
   do commit**, e `git status` do `playwright.config.ts` está limpo.

**Todas as medições brutas desta sessão estão em `medicoes.txt`**, na ordem em
que foram feitas: status HTTP, corpo de requisição e resposta, leitura no
Postgres, `scrollWidth`/`clientWidth`, opacidade computada. Nenhuma afirmação
deste documento sai de olhar a imagem — a imagem é o lastro, o número é a régua.

---

## O quadro do funil — #935/#938, #948, #911, #919

### #938 — marcar como perdido pelo MENU do card oferece os motivos DO FUNIL

Funil próprio com `settings.lost_reasons = ["Sem orçamento","Fora do perfil"]` —
nenhum deles canônico, que é o que os distingue do padrão do produto.

- `938-01-menu-motivos-do-funil.png` — a janela "Marcar como perdido" aberta
  pelo menu do card. Os `value` dos rádios, lidos por ferramenta:
  `["Sem orçamento","Fora do perfil","other"]`. O padrão do produto não sobra:
  "Falha no pagamento" tem contagem **0** na tela.
- `938-02-menu-card-perdido.png` — depois de escolher "Sem orçamento" e
  confirmar: `POST /leads/{id}/lose` = **200**, e o banco no mesmo instante diz
  `{"status":"lost","lost_reason":"Sem orçamento"}`.

### #938 — "Outro" com e sem detalhe

- `938-03-outro-texto-recusado.png` — "Outro motivo" com o texto livre
  *"Mudou de ideia"*: a tela recusa **antes do clique**, com
  *"Esse motivo de perda não está na lista deste funil — escolha um dos motivos
  configurados."* e `Confirmar` **desabilitado** (`isEnabled() === false`). A
  janela ainda diz onde cadastrar: *"Para usar um motivo que não está aqui,
  cadastre em Configurações › Funis."* — sem essa frase "Outro" seria beco sem
  saída.
- `938-04-outro-vazio-gravado.png` — "Outro" **sem** detalhe: `Confirmar`
  habilitado (`isEnabled() === true`), `POST` = **200**, banco
  `{"status":"lost","lost_reason":"other"}`. É o escape que o trigger aceita em
  qualquer funil, e é deliberado: cadastrar motivo novo é admin-only.

### #935 — os outros dois caminhos RECUSAM, e não movem nada

- `935-05-arrasto-recusado-com-aviso.png` — arrasto (pelo teclado do
  `@hello-pangea/dnd`, o **mesmo `onDragEnd` do mouse**) da coluna "Entrada"
  para "Perdido": `POST /leads/{id}/move` = **422**
  `{"error":{"code":"lost_reason_required","message":"Informe o motivo da perda."}}`.
  O card **volta** para "Entrada" na tela e o banco fica intacto
  (`status=open`, `stage_id` = o de origem, `lost_reason=null`).
- `935-06-lote-dois-selecionados.png` e `935-07-lote-recusado.png` — dois cards
  selecionados (`data-lote-selecionados="2"`), "Mover para… › Perdido":
  `POST /leads/bulk` = **422** e a recusa **nomeia os dois cards ofensores** em
  `details.lead_ids`. Os dois seguem `open` na etapa de origem — a transação não
  chegou a ser tentada.

> **Ressalva medida, e ela é do produto, não do teste.** O aviso que o operador
> lê nos dois caminhos é só *"Informe o motivo da perda."* (mais `ID: <requestId>`
> como descrição). O fragmento `.changes/etapa-de-perda-exige-motivo.md` promete
> *"a recusa de negócio, **com o que fazer**"* e, na prosa dele, diz que o
> caminho é *"use 'Marcar como perdido' no menu do próprio card"*. **Esse segundo
> pedaço não está na tela.** Quem arrastou o card vê a recusa e não recebe o
> caminho. Reportado, não consertado: o texto é do servidor e serve aos três
> caminhos (arrasto, lote e agente), o slot de descrição do toast já está ocupado
> pelo id da requisição, e decidir qual das duas informações fica é decisão de
> produto.

### #948 — tag em lote oferece as tags que já existem

- `948-08-tags-existentes-no-menu.png` — com dois cards selecionados, o menu
  "Tag…" lista as tags dos leads do quadro. **Este é o caso que a J4.39 pedia e
  faltava**: o quadro tem **13 tags distintas** e o menu oferece **10** — o teto
  do `.slice(0, 10)`, medido contra a conta real do banco, não contra um número
  escrito à mão.
- `948-09-typeahead-nao-rouba-o-foco.png` — **a prova do conserto**: com `vip` na
  lista, digitar `verão` deixa o campo com **`"verão"` inteiro**
  (`inputValue() === "verão"`), e a lista filtra para `["verão"]`. Sem o conserto
  o typeahead do menu do Radix levava o foco para `vip` já na primeira tecla.
- `948-10-tag-aplicada.png` — o `Enter` envia
  `{"action":"tag","lead_ids":[…2…],"params":{"add":["verão"]}}` → **200**, e o
  banco fica `["vip","google ads","verão"]` e `["orçamento","verão"]`. **A tag do
  MENU não foi aplicada a ninguém** — que era o outro lado do defeito.

### #911 — excluir pelo menu do próprio card, inclusive no toque

- `911-11-excluir-aviso-destrutivo.png` — o menu do card (manager) traz
  `["Editar","Responsável","Marcar como ganho","Marcar como perdido","Excluir"]`,
  e "Excluir" abre o `AlertDialog` da doutrina destrutiva, que nomeia o card e o
  que vai junto: *"O card sai do funil com o histórico de atividades. O contato e
  as conversas continuam. Esta ação não pode ser desfeita."*
- `911-12-card-excluido.png` — confirmar envia
  `{"action":"delete","lead_ids":[…],"params":{}}` → **200**; o card some da tela
  e o banco devolve `[]` para aquele id.
- `911-13-toque-botao-visivel.png` e `911-14-toque-menu-com-excluir.png` — em
  390×844 com `hasTouch`, **sem nenhum hover**, a **opacidade COMPUTADA** do
  botão "Ações do lead" é **`1`** (não a string do `className`), e o menu traz
  "Excluir".
- `911-15-quadro-400px-escuro.png` — o quadro em 400 px no tema escuro:
  `scrollWidth=400`, `clientWidth=400` — **não rola na horizontal**. Em 390 px, o
  mesmo: `390` contra `390`.

### #919 — arrastar o MESMO card duas vezes seguidas

Provado pela spec que o próprio lote trouxe,
`tests/e2e/kanban-owner-filter.spec.ts` (bloco *"arrastar o mesmo card duas
vezes seguidas (#916)"*), rodada neste ambiente. Ela é a medição honesta porque
**segura o refetch do quadro em 15 s** (`page.route` sobre
`/api/v1/pipelines/<id>/board`) antes do primeiro arrasto: numa rede rápida o
refetch fecha a janela do defeito e o teste fica verde mesmo com o conserto
revertido. Evidência versionada pela própria spec em
`evidence/arrastar-duas-vezes/`.

---

## O painel do contato no Inbox — #909, #944, #946

### #909 — o botão tem o MESMO nome do diálogo que abre

`909-01-painel-com-botao-novo-lead.png` e `909-02-dialogo-mesmo-nome.png` — o
botão da fileira lê **"Novo Lead"**; o título do diálogo que ele abre lê
**"Novo Lead"**. Medido pelo texto dos dois elementos, não a olho.

### #944 — "Leads recentes" diz Funil · Etapa, e o desfecho é Ganho/Perdido

`944-03-leads-recentes-funil-e-etapa.png`. O contato tem **dois leads de mesmo
título** em etapas diferentes do mesmo funil (era o caso que ficava `"open · —"`
duas vezes) e **um terceiro num funil ARQUIVADO**. A seção, lida por ferramenta:

```
Leads recentes
Proposta <n>
Funil de Vendas Consultivas B2B Enterprise <n> · Fechado
Ganho · —
Proposta <n>
Funil de Vendas Consultivas B2B Enterprise <n> · Proposta enviada ao comitê
Aberto · —
```

- O lead do funil arquivado **não aparece** (contagem 0 do título dele).
- O desfecho é **"Ganho"**, e a palavra "Pago" tem contagem **0** — apesar de o
  `crm_pipelines.vocabulary` daquele funil, lido no banco no mesmo instante, ser
  `{"won":"Pago","lost":"Cancelado","lead":"Cliente",…}`. **A tela ignora a
  coluna de propósito**, e é isso que impede uma clínica recém-instalada de ler
  "Pago" ao lado de "Consulta marcada".

### L12.G2.1 — `GET /api/v1/contact-tags` responde 200, e não um 400 do PostgREST

Este era o caso que a seção "Lote 12 · G2" do mapa de jornadas marcava
**NÃO MEDIDO**, e a razão estava escrita: `.neq("tags", "{}")` sobre coluna
`text[]` é sintaxe que só o PostgREST decide, e o dublê de
`tests/unit/tags-do-contato-rota.test.ts` a define ele mesmo.

Medido numa organização com contato **SEM** tag e contatos **COM** tag, pela
tela (a rota só é pedida quando o editor de tags monta, no clique em "Tag"):

```
L12.G2.1 · GET /api/v1/contact-tags = 200 · corpo = {"data":["obra","obra…-renomeada","reforma…","vip"]}
```

**200, com corpo.** A sintaxe é aceita.

### #946 — a sugestão colapsa caixa mista e duplicata

`946-04-sugestao-de-tags.png` e `946-05-tag-gravada-normalizada.png`. Três
contatos vizinhos carregam `"VIP"`, `"vip "` e `"vip"`; o contato da conversa já
tem `"VIP"` em caixa alta.

- Os chips oferecidos vêm **todos em minúscula** e **sem repetição** — as três
  grafias de `vip` colapsam numa só.
- **`+ vip` NÃO é oferecido**, porque o contato já a tem — e a rota conhece
  `vip` (ela está no corpo acima), o que separa *"não oferece"* de *"não existe"*.
- Clicar em `+ obra` grava a **forma normalizada**: `PATCH /contacts/{id}` e o
  banco passa a ter `obra` em minúscula.

### L12.G2.2 e L12.G2.3 — o encaixe, medido por ferramenta

| medida | régua | resultado |
|---|---|---|
| L12.G2.2 · painel do Inbox em **400 px, tema escuro** | `documentElement.scrollWidth` × `clientWidth` | **400 × 400** — não rola na horizontal |
| L12.G2.3 · a linha "Funil · Etapa" com nome de funil longo, 1440 px | `scrollWidth` × `clientWidth` do `div.line-clamp-2` | **245 × 245** — não transborda |

`g2-06-inbox-400px-escuro.png` é a foto do primeiro.

---

## Etiquetas — #955, a tela que foi para o lote sem ninguém clicar nela

A seção **J24** do mapa de jornadas registra que a tela de Configurações ›
Tags entrou "sem ninguém ter clicado nos botões uma vez". Os três botões foram
clicados aqui, numa organização com três contatos etiquetados e **uma regra de
automação que escreve a etiqueta**.

- `955-01-porta-em-configuracoes.png` — **a porta existe e é alcançável pela
  navegação**, não pela URL: o cartão em `/app/settings` aponta para
  `/app/settings/tags` com o texto "Tags · O vocabulário de etiquetas da empresa:
  onde cada uma é usada e como renomear, juntar ou excluir."
- `955-02-lista-com-contagens.png` — a lista com as contagens. A linha da
  etiqueta `obra…` traz **2** contatos e **1** regra de agente, e a linha oferece
  os três botões: "Renomear", "Juntar", "Excluir".
- `955-03-renomear-formulario.png` e `955-04-renomeada-na-tela.png` —
  **J24.1 pela tela**: renomear devolve **200** e, no mesmo instante, o banco
  mostra os contatos com o nome novo **e a regra de automação também**
  (`actions:[{"type":"add_tag","config":{"tags":["obra…-renomeada"]}}]`), com
  **todas** as suas ações preservadas.
- `955-05-juntar-formulario.png` e `955-06-juntadas.png` — **J24.2 pela tela**:
  o `<select>` "Etiqueta de destino" lista as etiquetas existentes; juntar
  devolve `{"acao":"juntar","contatos":1,"alterou":true,…}` e o contato que tinha
  as DUAS fica com a de destino **uma única vez** — nada de `{VIP, VIP}`.
- `955-07-excluir-aviso-de-regras.png` — **J24.4, que ninguém tinha visto**: o
  aviso lido por ferramenta é

  > Excluir obra…-renomeada de 2 contato(s), 0 lead(s) e 0 conversa(s).
  > **Atenção:** 1 regra(s) de agente continuam escrevendo esta etiqueta. Excluir
  > aqui não apaga a regra — o agente vai recriar a etiqueta no próximo
  > atendimento.

- `955-08-excluida.png` — confirmar devolve **200** e a regra **continua no
  banco**, intacta. O aviso diz a verdade.
- `955-09-viewer-recusado.png` e `955-09-agent-recusado.png` — **J24.5**:
  `viewer` e `agent` que abrem `/app/settings/tags` param em
  `http://localhost:3052/403`, e a porta em `/app/settings` tem contagem **0**
  para os dois. Não há botão que devolva 403 depois do clique.

> **NÃO MEDIDO em #955:** o painel em **espanhol** (J24.6) e o aviso de teto com
> **≥500 etiquetas**. O primeiro tem guarda em
> `tests/unit/tags-vocabulario-painel-em-espanhol.test.tsx`; o segundo exigiria
> semear 500 etiquetas distintas, o que mede o `limit 500` da função e não o
> conserto do lote.

---

## Radar — #941, e o nome escolhido (#907) nele

`941-10-radar-sem-funil-arquivado.png`. Dois funis, um **ativo** e um
**arquivado**, cada um com um lead aberto e frio (`last_activity_at` de 30 dias
atrás), os dois ligados ao MESMO contato — que tem `display_name` do WhatsApp
*"Ze do Pix …"* e `name` escolhido *"Maria Escolhida …"*.

| pergunta | medida na tela |
|---|---|
| o lead do funil **ativo** aparece? | **sim** |
| o lead do funil **arquivado** aparece? | **não** |
| o radar chama o contato pelo nome **escolhido**? | **sim** |
| o nome do perfil do WhatsApp sobra em algum canto? | **não** (contagem 0) |

---

## Levar o negócio para outro funil — #936

**Não há botão, e isso é declarado pelo próprio lote.** O fragmento
`.changes/negocio-para-outro-funil.md` diz: *"por enquanto pela API (`POST
/api/v1/leads/[id]/clone`); o botão no quadro vem na fatia seguinte"*. O que a
tela responde, então, são os EFEITOS — e a chamada sai do **navegador logado**,
com o cookie de sessão, que é o mesmo caminho que o botão vai usar.

- `936-01-origem-antes.png` — o card no funil de origem, com
  `custom_fields = {orcamento: "R$ 42.000", bairro: "Savassi"}`.
- `POST /api/v1/leads/{id}/clone` → **201**, e o clone nasce com
  `custom_fields` **inteiro**: `{"bairro":"Savassi","orcamento":"R$ 42.000"}`.
- `936-02-destino-com-o-card.png` — o card no funil de **destino**, na primeira
  etapa aberta.
- `936-03-linha-do-tempo-do-clone.png` — o dossiê do clone, lido por ferramenta:

  > LINHA DO TEMPO · **Veio de outro funil** · *Veio do funil Troca Origem …*

  e os **campos personalizados** com os valores copiados, lidos pelo `value` dos
  `<input>` (o `innerText` não os enxerga — rótulo não é valor).
- `936-04-linha-do-tempo-da-origem.png` — a origem fica `status = "lost"`, com
  a atividade que nomeia o funil de destino, e `source_metadata` guardando o
  ponteiro para onde o negócio foi. **Não é uma perda comum.**

### A fronteira, e uma frase que não é para um leigo

Arrastar um card para a etapa de OUTRO funil devolve **422**:

```json
{"error":{"code":"pipeline_immutable_use_clone",
 "message":"Move cross-pipeline não é permitido. Use POST /api/v1/leads/[id]/clone para levar o negócio a outro funil.",
 "details":{"use":"/api/v1/leads/{id}/clone"}}}
```

**Reportado, não consertado, e com a ressalva que muda a leitura.** A frase é
jargão de desenvolvedor num campo `message` que o `ApiErrorToast` mostra cru
(não há entrada para este código no `COPY`, então o toast cai em
`toast.error(t(err.message))`). A `main` já dizia *"Move cross-pipeline não é
permitido. Clone o lead para o pipeline alvo."* — o lote **manteve o jargão e
acrescentou o verbo HTTP e a rota**. Só que **não consegui alcançá-la pela
tela**: o quadro desenha as etapas de UM funil, então nenhum arrasto produz um
`stage_id` de outro. Ou seja, hoje ela é mensagem de consumidor de API, e é por
isso que fica como observação e não como defeito de tela. Quando o botão da
fatia seguinte chegar, essa frase passa a ser lida por gente.

---

## Agenda — #931/#933 e #915

### #931/#933 — a ida ao Google

`931-01-agenda-sem-google.png` — **numa instalação sem Google**, que é o estado
deste ambiente e o de um primeiro deploy, a tela **não oferece** o botão
"Conectar Google" (contagem **0** de `[data-testid="conectar-google"]`) e mostra
o endereço de retorno para registrar no console do Google:
`http://localhost:3052/api/v1/agenda/google/callback`. Não há botão que não leve
a lugar nenhum.

**NÃO MEDIDO — e é a metade que interessa ao #933:** a URL de autorização com
`prompt=consent select_account` e `login_hint`. Ela exige `GOOGLE_CALENDAR_CLIENT_ID`
e `GOOGLE_CALENDAR_CLIENT_SECRET` configurados, e semear credencial de app do
Google numa instalação que não tem nenhuma mede a configuração, não o conserto.
O que o CRM ENVIA está preso por `tests/unit/agenda-google-connect-route.test.ts`
(sobre o header `Location` de verdade) e `tests/unit/agenda-google-oauth.test.ts`;
o elo tela→rota, por `tests/unit/agenda-cartao-conexao-google.test.tsx`.
**E que o Google DESENHE o seletor com duas contas segue sendo dedução** — é a
dívida nº 1 já declarada no mapa de jornadas para este grupo, e ela continua de pé.

### #915 — o compromisso que cruza a borda da janela

`915-04-agenda-com-bloco-ocupado.png`. Evento do Google semeado de **ontem
23:30 até hoje 00:30** (`02:30Z → 03:30Z`), com o título sensível
`"SEGREDO <n>"`, numa conexão `healthy` com cobertura de sincronização.

| pergunta | medida |
|---|---|
| a rota devolve o bloco? | **sim** — `{"titulo":"Ocupado","origem":"google_sync","situacao":"confirmed",…}` |
| a tela desenha "Ocupado"? | **sim** |
| o título do evento chega à TELA? | **não** (contagem 0) |
| o título do evento chega à ROTA? | **não** |

O corpo traz só `id`, `titulo: "Ocupado"`, `donoId` e os dois instantes — nunca o
conteúdo do evento, que é a promessa do #897 e continua valendo depois do #915.

> **Ressalva que muda a leitura, e eu só a vi porque medi a janela junto.** A
> tela abre na visão **Semana** e pediu `de=2026-09-13T03:00Z` ate
> `2026-09-20T03:00Z`. O evento (16/09 `02:30Z→03:30Z`) cai **inteiro dentro**
> dessa janela — logo **o RECORTE não foi exercitado aqui**. O que esta prova
> mostra é que um evento que atravessa a meia-noite **aparece** e que o título
> nunca vaza; a promessa do fragmento de que "o instante de começo nunca é
> anterior ao período" continua presa por
> `tests/unit/agenda-recorte-do-google-atravessa-o-limite.test.ts`, não por esta
> tela. Exercitá-la exigiria abrir a visão **Dia** do dia seguinte, onde a janela
> tem 24 h e a borda cai no meio do evento. **NÃO MEDIDO.**

---

## Contatos — #907, o nome editado vence o nome do perfil do WhatsApp

`907-05-ficha-com-nome-do-whatsapp.png` e `907-06-ficha-com-nome-escolhido.png`
e `907-07-inbox-com-nome-escolhido.png`.

Contato nascido **só** com `display_name = "Ze do Pix <n>"` (o nome do perfil do
WhatsApp), com uma conversa aberta. Depois de editar **pela tela** (Editar
contato › Nome › Salvar, `PATCH` = 200), o banco mantém as DUAS colunas
preenchidas — `{"name":"Maria Silva <n>","display_name":"Ze do Pix <n>"}` — e é
a precedência que decide o que se lê:

| superfície | "Maria Silva" (escolhido) | "Ze do Pix" (WhatsApp) |
|---|---|---|
| ficha do contato, depois de recarregar | presente | ausente |
| Inbox (lista, cabeçalho e painel) | presente | **ausente em canto nenhum** |
| `GET /api/v1/conversations` — a MESMA linha que o título da notificação lê | presente | ausente |
| Radar de risco | presente | ausente |

> **Sobre a notificação do navegador.** `useInboundMessageAlerts` monta o título
> com `nomeDoContato(row)` sobre a linha que `GET /api/v1/conversations` devolve
> — a mesma medida na tabela. Medir a linha é medir o título; encenar a permissão
> de notificação do Chrome não acrescentaria régua nenhuma, e a afirmação ficaria
> mais fraca, não mais forte.

---

## Agente de IA — #942, a ferramenta que confere e marca na mesma chamada

`942-00-pacotes-do-agente.png` e `942-01-capacidade-na-tela-do-agente.png`.

**O COMPORTAMENTO é NÃO MEDIDO, e o que faltou tem nome:** a chave de IA. Esta
instalação não tem `AI_GATEWAY_API_KEY`, `ANTHROPIC_API_KEY` nem
`OPENROUTER_API_KEY` — de propósito, é o estado de um primeiro deploy — e o
servidor anuncia no boot que *"o agente vai pular toda resposta com
reason='ai_gateway_key_missing'"*. Sem ela não há turno de agente, logo não há
como ver o agente conferir um horário e reservá-lo numa conversa.

O que a tela responde, e foi medido:

- O caminho padrão da tela é o **pacote**: "Vender e mover o funil" está lá, com
  a explicação e a contagem `0 de 22 capacidades ligadas`.
- A capacidade individual mora atrás de **"Escolher uma a uma (modo avançado)"**
  — um leigo precisa desse clique para chegar nela.
- Depois dele, a caixa **"Ver se o horário está livre e já marcar"** existe
  (contagem 1), com a explicação *"Confere o horário que o cliente pediu e, se
  estiver livre, já reserva na mesma conversa…"*, marcada como
  `data-risco="atencao"`.
- Nesta instalação ela **nasce desligada** (`isChecked() === false`), e o agente
  semeado consome `0 de 25` do teto — logo não é o teto que a segura.
- **Ligar funciona**, medido como `admin`: `data-marcada=nao`,
  `caixa desabilitada = false`, e depois do clique
  `a capacidade está ligada = true`. Foto em `942-02-capacidade-ligada.png`.

> **O papel importa, e a primeira medição errou por isso.** Como `manager` a
> mesma caixa aparece e vem `disabled` — a porta de "Agentes" é
> `minRole: "manager"`, mas `app/app/ai/agents/[id]/page.tsx:68` faz
> `readOnly = ROLE_RANK[role] < ROLE_RANK.admin`. Está escrito aqui porque essa
> primeira leitura parecia defeito do lote e era papel errado na medição.

---

## Placar — jornada por jornada

| PR | o que o lote promete | estado | prova |
|---|---|---|---|
| **#938** | marcar como perdido oferece os motivos DO FUNIL | **PROVADO** | `938-01-menu-motivos-do-funil.png`, `938-02-menu-card-perdido.png` |
| **#938** | "Outro" com detalhe fora da lista é recusado ANTES do clique; sem detalhe passa | **PROVADO** | `938-03-outro-texto-recusado.png`, `938-04-outro-vazio-gravado.png` |
| **#935** | arrasto para etapa de perda recusa 422 e não move nada | **PROVADO** | `935-05-arrasto-recusado-com-aviso.png` |
| **#935** | lote para etapa de perda recusa 422 nomeando os cards | **PROVADO** | `935-06-lote-dois-selecionados.png`, `935-07-lote-recusado.png` |
| **#935** | a recusa diz **o que fazer** | **FALHOU** (observação, não conserto) | a tela diz só "Informe o motivo da perda."; ver a ressalva acima |
| **#919** | arrastar o mesmo card duas vezes seguidas | **PROVADO** | `evidence/arrastar-duas-vezes/` (spec do próprio lote, com o refetch segurado) |
| **#911** | excluir pelo menu do card, com aviso destrutivo | **PROVADO** | `911-11-excluir-aviso-destrutivo.png`, `911-12-card-excluido.png` |
| **#911** | o menu do card alcançável no TOQUE | **PROVADO** | `911-13-toque-botao-visivel.png`, `911-14-toque-menu-com-excluir.png` |
| **#948** | tag em lote oferece as tags existentes (13 no quadro, 10 no menu) e o typeahead não rouba o foco | **PROVADO** | `948-08-tags-existentes-no-menu.png`, `948-09-typeahead-nao-rouba-o-foco.png`, `948-10-tag-aplicada.png` |
| **#936** | o negócio chega ao outro funil com os campos, e as duas linhas do tempo contam | **PROVADO** (pela API, efeitos na tela — não há botão) | `936-01-origem-antes.png`, `936-02-destino-com-o-card.png`, `936-03-linha-do-tempo-do-clone.png`, `936-04-linha-do-tempo-da-origem.png` |
| **#941** | radar sem leads de funil arquivado | **PROVADO** | `941-10-radar-sem-funil-arquivado.png` |
| **#909** | o botão que cria o lead tem o nome do diálogo | **PROVADO** | `909-01-painel-com-botao-novo-lead.png`, `909-02-dialogo-mesmo-nome.png` |
| **#944** | "Leads recentes" diz Funil · Etapa, e Ganho/Perdido | **PROVADO** | `944-03-leads-recentes-funil-e-etapa.png` |
| **L12.G2.1** | `GET /api/v1/contact-tags` responde 200 | **PROVADO** (era NÃO MEDIDO) | corpo em `medicoes.txt` |
| **L12.G2.2/G2.3** | o painel cabe em 400 px e a linha Funil · Etapa não transborda | **PROVADO** | `g2-06-inbox-400px-escuro.png` + as duas réguas |
| **#946** | sugestão de tags com caixa mista e duplicata | **PROVADO** | `946-04-sugestao-de-tags.png`, `946-05-tag-gravada-normalizada.png` |
| **#955** | a tela de etiquetas: renomear, juntar, excluir | **PROVADO** (J24.1 a J24.5, pela tela) | `955-01`…`955-09` |
| **#955** | o painel em espanhol (J24.6) e o aviso de teto com ≥500 etiquetas | **NÃO MEDIDO** | guarda em `tests/unit/tags-vocabulario-painel-em-espanhol.test.tsx` |
| **#931/#933** | a instalação sem Google não oferece botão sem destino | **PROVADO** | `931-01-agenda-sem-google.png` |
| **#931/#933** | a URL de autorização com `prompt=consent select_account` | **NÃO MEDIDO** — exige credencial de app do Google | `tests/unit/agenda-google-connect-route.test.ts` |
| **#915** | o compromisso que atravessa a meia-noite aparece, e o título nunca sai | **PROVADO** | `915-04-agenda-com-bloco-ocupado.png` |
| **#915** | o RECORTE na borda, pela tela | **NÃO MEDIDO** — a visão Semana não cruza a borda; ver a ressalva | `tests/unit/agenda-recorte-do-google-atravessa-o-limite.test.ts` |
| **#907** | o nome editado vence o do WhatsApp na tela, na notificação e no radar | **PROVADO** | `907-05`…`907-07`, `941-10-radar-sem-funil-arquivado.png` |
| **#942** | a capacidade que confere e marca na mesma chamada | **PARCIAL** — a configuração está provada na tela; o COMPORTAMENTO é **NÃO MEDIDO** por falta de chave de IA | `942-00-pacotes-do-agente.png`, `942-01-capacidade-na-tela-do-agente.png` |

---

## O que esta sessão achou — e o que fez com cada coisa

### 1. A recusa da perda não diz ONDE informar o motivo (no lote · REPORTADO)

**Passo a passo.** Quadro do funil › arrastar um card para a coluna de perda.
**O que acontece.** O card volta para a coluna de origem e sobe o aviso
*"Informe o motivo da perda."*, com `ID: <requestId>` como descrição. Nada mais.
**Por que é achado.** `.changes/etapa-de-perda-exige-motivo.md` diz que agora a
resposta é *"a recusa de negócio, **com o que fazer**"*, e o texto do fragmento
completa: *"use 'Marcar como perdido' no menu do próprio card, que já pede o
motivo"*. **Esse complemento não existe na tela.** Quem arrastou sabe que falta
um motivo e não sabe por onde dar.
**Prova.** `935-05-arrasto-recusado-com-aviso.png` e a linha `#935 arrasto` de
`medicoes.txt`.
**Por que não consertei.** O texto é do SERVIDOR
(`MOTIVO_DA_PERDA_OBRIGATORIO`, em `lib/leads/motivo-da-perda.ts`) e serve aos
TRÊS caminhos — arrasto, lote e agente —, e o caminho de saída é diferente em
cada um. O slot de descrição do toast já está ocupado pelo id da requisição.
Qual informação fica e onde é **decisão de produto**, não conserto mecânico.

### 2. `Move cross-pipeline … Use POST /api/v1/leads/[id]/clone` (no lote · REPORTADO com ressalva)

Frase de desenvolvedor num campo `message` que o `ApiErrorToast` mostra cru. A
`main` já dizia *"Move cross-pipeline não é permitido. Clone o lead para o
pipeline alvo."*; o lote manteve o jargão e **acrescentou o verbo HTTP e a
rota**. **A ressalva que muda a leitura:** não consegui alcançá-la pela tela — o
quadro desenha as etapas de UM funil, então nenhum arrasto produz `stage_id` de
outro. Hoje é mensagem de API. Quando o botão da fatia seguinte chegar, ela passa
a ser lida por gente.

### 3. `Display name` em inglês na ficha do contato (ANTERIOR ao lote · REPORTADO)

**Passo a passo.** Contatos › abrir um contato › o bloco de dados.
**O que se vê.** Duas etiquetas lado a lado: **"NOME"** e **"DISPLAY NAME"** — a
segunda em inglês, crua, sem passar por `t()`, num produto que serve pt-BR e es.
**Prova.** `907-06-ficha-com-nome-escolhido.png`; a linha está em
`app/app/contacts/[id]/_client.tsx:148`.
**Por que não consertei.** Está igual na `main`
(`git show origin/main:app/app/contacts/[id]/_client.tsx | grep "Display name"`),
logo é anterior ao lote — e é um rótulo de tela, não um defeito de
comportamento do lote.

### 4. O papel que a tela do agente exige para ESCREVER (medido, não é defeito)

A porta de "Agentes" é `minRole: "manager"`, mas
`app/app/ai/agents/[id]/page.tsx:68` faz
`readOnly = ROLE_RANK[role] < ROLE_RANK.admin`. **Medido nos dois papéis:** como
`manager`, a caixa da capacidade nova aparece e vem `disabled`
(`caixa desabilitada = true`), com `0 de 25` do teto usado — ou seja não é o
teto; como `admin` (entrando pelo segundo fator com o TOTP da semente), a mesma
caixa vem habilitada e o clique a liga (`está ligada = true`).

Fica registrado porque foi o que fez a primeira medição de #942 parecer defeito
do lote e não era: a medição estava com o papel errado. É também o antídoto para
quem repetir — medir capacidade de escrita com papel de leitura mede o papel.

---

## Nada foi consertado neste worktree

Os três achados acima ou dependem de decisão de produto, ou são anteriores ao
lote, ou não são defeito. **Nenhum conserto de produto saiu desta sessão** — o
que sai é prova, medição e o que ficou de fora.

O que mudou no disco, além desta pasta: as specs `tests/e2e/qa-l12-*.spec.ts`
(o instrumento desta sessão) e `supabase/config.toml` (projeto e portas do stack
próprio, **não commitado**). O `playwright.config.ts` foi tocado durante a sessão
para afrouxar o teto do `webServer` e **revertido antes do commit**.

---

## As specs desta sessão

`tests/e2e/qa-l12-comum.ts` (helpers) e cinco arquivos:

| arquivo | cobre |
|---|---|
| `tests/e2e/qa-l12-funil.spec.ts` | #935, #938, #948, #911 (desktop e toque) |
| `tests/e2e/qa-l12-inbox.spec.ts` | #909, #944, #946, L12.G2.1/2/3 |
| `tests/e2e/qa-l12-tags-radar.spec.ts` | #955 (J24.1-J24.5), #941, #907 no radar |
| `tests/e2e/qa-l12-troca-de-funil.spec.ts` | #936 e a recusa de fronteira |
| `tests/e2e/qa-l12-agenda-contatos.spec.ts` | #931/#933, #915, #907 |
| `tests/e2e/qa-l12-agente-ia.spec.ts` | #942 (configuração) |

**Elas NÃO são gate.** Nenhuma está em `SPECS_PARTE_*` do `e2e.yml`, e nenhuma
deve entrar: são o instrumento de UMA sessão de QA, com fixtures que semeiam e
apagam na organização de teste. O que vigia cada conserto a cada PR continua
sendo o teste de unidade/invariante que o próprio grupo trouxe — e é por isso que
`tests/unit/e2e-cobertura-completa.test.ts` as exige declaradas em `FORA_DO_CI`
**com motivo escrito** se um dia forem para `tests/e2e/` de forma permanente.

Duas coisas nelas existem **contra a INFRA e nunca contra o produto**, e nenhuma
asserção do lote passa por ali: o reenvio de `insere()` (o PostgREST deste stack
respondia 503 `PGRST002` sob carga) e o reenvio de `login()` (o GoTrue devolvia
`login_failed` com falha de resolução de nome). As duas registram cada tentativa
em `medicoes.txt` com o prefixo `[ambiente]`, para que ninguém confunda lentidão
de máquina com comportamento do produto.

Última rodada verde, com tudo já corrigido do lado do instrumento: **12 casos,
12 verdes** (`qa-l12-agente-ia` + `qa-l12-funil` + `qa-l12-inbox`), mais
`qa-l12-tags-radar` 6/6, `qa-l12-troca-de-funil` 2/2,
`qa-l12-agenda-contatos` 3/3 e `kanban-owner-filter` 2/2.
