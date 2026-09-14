# Atualização segura e a agenda que falta — spec

**Data:** 2026-09-12 · **Origem:** incidente em instalação de produção + quatro pedidos do dono do produto

Duas frentes independentes, na mesma spec porque a segunda **depende** da primeira:
enquanto atualizar puder apagar regra de segurança, publicar recurso novo é
aumentar a exposição.

---

## PARTE A — Atualizar não pode apagar regra de segurança

### A.1 O que aconteceu, medido

Numa instalação real, depois de atualizar, **o funil apareceu vazio**. Os dados
estavam todos no banco. O que tinha sumido eram duas regras de acesso:
`crm_leads_select` e `crm_leads_update`.

Sem a regra de leitura e com a segurança por linha ligada, o Postgres nega **em
silêncio**. A tela mostra lista vazia — indistinguível de "não há nada aqui". E
a atualização tinha reportado `success`.

No mesmo dia, uma segunda atualização derrubou **dez** regras diferentes, entre
elas `conversations_select` — nenhuma conversa visível para ninguém.

### A.2 A causa, medida três vezes

O `baseline.sql` aplica cada regra como `drop policy if exists` seguido de
`create policy` — é o único caminho portável, porque o Postgres não tem
`create or replace policy`. E o `update.sh` roda **sem `ON_ERROR_STOP`**, de
propósito, para um clone bagunçado conseguir se curar.

Com o sistema **em funcionamento**, essas operações disputam a tabela com o
tráfego normal e o Postgres mata uma das pontas para desempatar:

| como o banco foi aplicado | travamentos mútuos (`deadlock detected`) |
|---|---|
| sistema inteiro no ar — **o que a atualização faz hoje** | **113** |
| CRM parado (`app`, `worker`, `scheduler`), Supabase no ar | **60** |
| **tudo parado**, incluindo `supabase-rest`, `realtime`, `studio` | **0** |

Três medições, mesma máquina, mesmo dia, mesmo arquivo. Quando o travamento
mata o comando **entre** o `drop` e o `create`, a regra desaparece.

E o sorteio é diferente a cada passada: a segunda reaplicação devolveu
`conversations_select` e levou embora `conversations_agent_insert`. **Reaplicar
não converge** — conserta umas e quebra outras.

**Por que parar só o CRM não basta:** o PostgREST recarrega o mapa do banco a
cada mudança de estrutura. Ele reage ao próprio `drop`/`create` que está sendo
aplicado, e entra na fila contra ele. Medido: `WITH -- Recursively get the base
types of domains` esperando `Lock` com o CRM já parado.

### A.3 O que existe hoje, medido

Antes de propor, o que foi conferido no código e no servidor:

| pergunta | resposta medida |
|---|---|
| existe modo manutenção? | **não** — zero ocorrências em `app/`, `lib/`, `components/`; **não há `middleware.ts`** |
| o `baseline.sql` usa transação? | **não** — zero `BEGIN` |
| o `update.sh` usa `--single-transaction`? | **não** |
| o Supabase é parte do nosso compose? | **não** — `docker-compose.prod.yml` não tem um serviço Supabase sequer |
| quanto custa parar e subir? | **stop 10,3s + start 6,0s ≈ 16s**, medido na instalação real |

A quarta linha é a que decide o desenho: **parar `supabase-rest` só é possível
onde o Supabase é local.** Nesta instalação são 11 contêineres Supabase, mas o
produto também roda contra o Supabase hospedado — e lá não há o que parar. Um
conserto que dependa de parar o PostgREST **não é portável**.

### A.4 Transação única: medida, e o que ela resolve

`psql --single-transaction` com `\set ON_ERROR_ROLLBACK on` cria um ponto de
retorno por comando. Medido num Postgres descartável, com um erro benigno
plantado no meio:

```
psql:/t.sql:6: ERROR:  relation "t_a" already exists     ← o erro benigno
CREATE POLICY                                            ← e os seguintes CONTINUAM
policies sobreviventes: p_um, p_dois
```

**Resolve:** aplicar tudo numa transação sem que "já existe" derrube o resto —
que era o motivo de o `update.sh` rodar sem `ON_ERROR_STOP`.

**NÃO resolve sozinha:** o ponto de retorno é por comando, então um travamento
no `create policy` reverte só ele — e o `drop policy` anterior, que já passou,
permanece. A regra some do mesmo jeito.

### A.5 O conserto — dois caminhos, porque um só não é portável

**Caminho 1 — instalação com Supabase local (detectável).** Parar app, worker,
scheduler **e** `supabase-rest`, `realtime`, `studio`. Medido: **zero
travamentos**. Custo: ~16s a mais, e o CRM fora do ar durante o banco.

**Caminho 2 — instalação com Supabase hospedado.** Não há o que parar do lado do
Supabase, e **a parada fica de fora por decisão do dono do produto**: *"a
manutenção é pra quem usa local"*.

⚠️ **O que essa decisão deixa descoberto, escrito para ninguém descobrir depois:**
o instalador padrão do produto **cria o banco na nuvem da Supabase**
(`install.sh:1083`, via Management API). A instalação que originou esta spec é a
exceção — Supabase local, montado fora do nosso compose. Quem segue o caminho
padrão continua exposto à perda de regra.

**O que vale para os dois, e é o que impede o silêncio:** a **conferência** (A.6,
passo 4) não depende de parar nada. Ela não evita a perda — mas transforma
"a atualização diz que deu certo e o funil fica vazio por horas" em "a
atualização reprova e diz qual regra falta". Foi o silêncio, não a perda, que
custou o dia.

E a peça que **converge**: recriar exatamente as que faltam, nunca reaplicar o
arquivo inteiro.

**Por que recriar as que faltam, e não reaplicar tudo:** medido nesta
instalação, reaplicar **não converge**. A segunda passada devolveu
`conversations_select` e levou embora `conversations_agent_insert`; a terceira
trocou o conjunto de novo. Cada passada sorteia. Recriar só o que falta é um
punhado de comandos rápidos, com muito menos superfície para travar.

⚠️ **Isto corrige a versão anterior desta spec**, que mandava "reaplicar uma vez
e conferir de novo". Aquilo era o que eu tinha feito no servidor, e a medição
mostrou que não fecha.

### A.6 O conserto, em passos

1. **Congelar as telas.** Antes de tocar no banco, o sistema entra em modo
   manutenção: quem estiver com o CRM aberto vê um aviso de atualização em
   curso, em vez de clicar em algo que vai falhar. É o que evita que a pessoa
   "descubra" a atualização por um erro.
2. **Parar quem fala com o banco** — `app`, `worker`, `scheduler` **e** as peças
   do Supabase que reagem a mudança de estrutura (`supabase-rest`,
   `realtime`, `studio`). É a diferença entre 60 travamentos e zero.
3. **Aplicar o banco**, guardando a saída inteira em `.deskcomm-banco.log` (já
   feito — foi esse log que permitiu achar a causa; antes era descartado).
4. **Conferir as 92 regras** contra o que o `baseline.sql` declara, **antes** de
   subir os serviços — é enquanto tudo está parado que dá para consertar sem
   disputa. Faltando alguma, **recriar exatamente as que faltam** (A.5), e
   conferir de novo. Só então subir.
5. **Se ainda faltar depois disso, parar e gritar em vermelho** — dizendo o
   efeito em português ("as telas aparecem vazias"), listando o que falta e
   apontando o log e o `restore.sh`. O sistema **não** volta ao ar dizendo
   "concluída": um CRM sem regra de isolamento é pior que um CRM fora do ar.

⚠️ O passo 4 acontece **com os serviços ainda parados**, e isso é deliberado. A
versão anterior desta spec conferia depois de subir — o que recria exatamente a
disputa que causou o problema, no pior momento possível.

**A régua da conferência vale a ÚLTIMA operação de cada regra no arquivo.** O
baseline cria e depois apaga a mesma regra de propósito (uma regra antiga vira
três novas). Contar toda criação daria falso positivo em cima de decisão
deliberada — e alarme que toca sem motivo é pior que alarme nenhum: quem o vê
tocar à toa aprende a ignorá-lo. Medido contra a instalação real: **92 regras
esperadas, zero falso positivo.**

### A.7 Critérios de aceite

- [ ] Uma atualização numa instalação **em uso** termina com **zero** travamentos
- [ ] As 92 regras estão presentes ao fim, conferidas pela própria atualização
- [ ] Com uma regra removida de propósito antes do fim, a atualização **reprova**
      e diz qual falta (sabotagem obrigatória)
- [ ] Quem está com o CRM aberto vê o aviso de manutenção, não um erro
- [ ] O sistema volta sozinho — nenhum passo manual
- [ ] O tempo total não piora: o que se perde parando, ganha-se sem disputa

---

## PARTE B — A agenda

Quatro pedidos. **Dois deles não precisam de banco nem de API** — a capacidade
já existe e só a tela não oferece. Isso foi medido, não presumido.

### B.1 Um campo só para escolher o cliente

**Hoje:** `components/agenda/VinculoDaMarcacao.tsx` tem **dois** campos em
sequência — "Buscar cliente" (texto) e "Quem será atendido" (lista). O segundo
dá a impressão de que vai abrir algo ao digitar, e o primeiro parece não fazer
nada até a lista mudar.

**Proposta:** um campo único com busca embutida — digita e a lista filtra ali
mesmo, com "Compromisso pessoal, sem cliente" como primeira opção e padrão.

**Cuidado medido:** o padrão **tem de continuar sendo o vazio**. Um seletor que
abre com o primeiro contato da lista marca compromisso no nome de outra pessoa —
defeito que já aconteceu nesta instalação e foi consertado em 2026-09-12 (o
cliente ficava herdado da abertura anterior).

### B.2 Observações do compromisso

**Decidido pelo dono do produto:** é **uma observação por compromisso**, escrita
por quem está marcando — o que precisa lembrar para aquela call, aquela reunião.
**Não** é histórico de várias anotações de várias pessoas.

⚠️ Registrado porque eu propus o contrário e estava errado: cheguei a desenhar
uma tabela `appointment_notes` espelhando `conversation_notes` (com autor e
data). Ele corrigiu — *"o agendamento é individual"*. A tabela nova resolveria um
problema que ninguém tem, e custaria migration, rota e tela.

**Medido:** `calendar_appointments.notes` existe (`text`) e a API já a aceita —
`app/api/v1/agenda/agendamentos/route.ts:84`, `z.string().max(2000)`, no POST
**e** no PATCH.

**Ou seja: zero banco, zero rota. Só tela** — o campo no painel de marcação e a
exibição no detalhe do compromisso.

**E ela fica interna, sem decisão adicional a tomar:** medido em
`lib/agenda/google/evento.ts:330`, o que viaja para o convite do Google é
`description`. `notes` **não** viaja. O comportamento que ele pediu já é o
comportamento da coluna.

### B.3 O e-mail do convidado vem preenchido

**Medido:** `contacts.email` existe (`text`). Hoje o campo "E-mail do convidado"
nasce vazio, e quem marca digita à mão um endereço que o sistema já tem.

**Proposta:** ao escolher o cliente, o campo é preenchido com o e-mail dele —
**editável**, e apagável. Contato sem e-mail deixa o campo vazio, como hoje.

**Cuidado:** preencher **só** quando o campo estiver intocado. Sobrescrever o
que alguém digitou é o mesmo defeito do cliente herdado, pelo avesso.

### B.4 Mandar o compromisso ao cliente pelo WhatsApp

**Medido:** existe o mecanismo — `job_queue.kind = 'transactional_delivery'`, o
mesmo que entrega o link do Google Meet. Ele já resolve fila, canal, fronteira
de atendimento e autorização.

**Proposta:** reusar essa entrega para mandar os dados do compromisso.

**O molde já existe, medido** — `lib/agent-engine/agent/meet-delivery.ts:168`:

```ts
meetingDeliveryBody(startsAt, timeZone, url, idioma)
// "Sua reunião está marcada para 24/09/26 09:30 (America/Sao_Paulo).
//  Link do Google Meet: …"
```

Ele já resolve o que costuma dar errado: formata no **fuso do compromisso** (não
no do servidor) e traduz para o **idioma do contato** (não o de quem marcou).
A mensagem do compromisso é uma variação disso — mesma função, sem o link quando
não houver, e com o tipo e o local no lugar dele.

**Restrição herdada, e ela não é negociável:** a entrega exige **atendimento
aberto** naquela conversa. Foi exatamente essa regra que recusou o envio do link
do Meet hoje (`meet_conversation_stale`). A tela precisa dizer isso **antes** do
clique, não depois — botão desabilitado com o motivo à vista.

**Opt-out:** contato com `is_blocked` não recebe. Marcar consulta não é
consentir em receber mensagem — a doutrina do produto já decide isso, e esta
funcionalidade não a contorna.

### B.5 Critérios de aceite (todos pela tela)

- [ ] Escolher cliente num campo só, com "Compromisso pessoal" como padrão
- [ ] Abrir o painel depois de fechar outro **não** herda cliente nenhum
- [ ] Anotação escrita aparece no detalhe do compromisso e sobrevive a remarcar
- [ ] E-mail do convidado chega preenchido e continua editável
- [ ] E-mail digitado à mão **não** é sobrescrito ao trocar de cliente
- [ ] Compartilhar por WhatsApp chega na conversa, com atendimento aberto
- [ ] Sem atendimento aberto, o botão está **desabilitado e explicado**
- [ ] Remarcar um compromisso já enviado faz o cliente receber a **correção**,
      com o horário novo e uma frase que diz que mudou
- [ ] Arrastar o compromisso várias vezes seguidas manda **uma** mensagem só
- [ ] Editar só o título **não** manda nada
- [ ] O botão deixa de ficar preso em "Link já enviado": vira "Enviar de novo",
      com confirmação
- [ ] Clique duplo em "Enviar link ao cliente" continua mandando **uma** vez

---

### B.6 Remarcar depois de enviar deixa o cliente com o horário errado

**Medido no código, 2026-09-12.** A pergunta era: o cliente recebeu "Sua reunião
está marcada para 24/09 às 09:30"; alguém remarca para 25/09. O sistema manda de
novo, corrige, ou fica calado? **Fica calado** — e pior, tranca quem tentaria
corrigir à mão.

A cadeia inteira, medida peça por peça:

| Peça | O que faz | Medido em |
|---|---|---|
| gatilho de remarcar | sobe `revision`, zera `confirmation_next_at`. **Não toca em `meeting_delivery`** | `…0224_presenca_e_recuperacao.sql:63-66` |
| gatilho de enfileirar entrega | só enfileira quando o estado é `waiting_for_link`. Depois de enviar o estado é `sent` → **sai sem fazer nada** | `…0226_meet_e_entrega_transacional.sql:270` |
| `fn_meet_action('deliver')` | com a mesma conversa e o mesmo atendimento e estado `sent`, **devolve `false`** e não reenfileira | `…0226…sql:407` |
| a tela | `alreadyAuthorized` fica `true` → botão **desabilitado**, escrito *"Link já enviado"* | `components/agenda/MeetDoCompromisso.tsx:40-42,158-166` |

Nenhuma varredura cobre o buraco: `fn_appointment_confirmation_sweep` só age
**depois** que o compromisso termina, e o que ela cria é um aviso interno na
Central — nunca uma mensagem ao cliente (`baseline.sql:20236-20256`).

**O que JÁ funciona, e não precisa de conserto:** se a remarcação acontece
**antes** de o trabalhador enviar, a mensagem sai com o horário **novo**. O texto
não é congelado no momento de autorizar — é montado na hora do envio, de um
`select a.starts_at` fresco (`lib/agent-engine/agent/meet-delivery.ts:66-110`).
Só o caso "já saiu" é que fica órfão.

**O tamanho do estrago:** o cliente tem no WhatsApp uma data que não existe mais,
o operador vê um botão que diz *"Link já enviado"*, e nada na tela informa que o
horário enviado não é o horário marcado. A pessoa aparece no dia errado.

**A decisão do dono do produto: os DOIS.** O sistema corrige sozinho, **e** quem
opera continua podendo mandar de novo pela tela. Não são a mesma coisa: o
automático cobre quem remarcou e foi embora; o manual cobre o caso em que a
correção automática não saiu (atendimento mudou, cliente bloqueado, canal fora)
e alguém precisa agir.

#### B.6.1 A correção automática

Quando `starts_at` **ou** `time_zone` mudarem num compromisso cujo link já foi
enviado, a entrega volta ao estado "aguardando link" com geração nova,
preservando o atendimento, o canal e **quem autorizou** o envio original. O
gatilho que já existe reenfileira sozinho.

**Por que só esses dois campos:** são os únicos que entram no texto da mensagem
(`meetingDeliveryBody(startsAt, timeZone, url, idioma)`). Guardar por "qualquer
`update` na linha" faria uma edição de título reenviar link ao cliente.

**As proteções são as que já existem — medidas, não inventadas:**

| Situação | O que acontece | Por quê |
|---|---|---|
| o atendimento mudou de dono | **não envia**, abre aviso na Central | `fn_meet_boundary_current` é reconferido no envio |
| quem autorizou não é mais o responsável | **não envia** | a vigência exige `authorized_by.id = owner_user_id` |
| quem autorizou perdeu o papel | **não envia** | o papel é reconferido no envio, não no clique |
| contato anonimizado ou bloqueado | **não envia** | já está na checagem de vigência |
| compromisso cancelado | **não envia** | o gatilho de enfileirar mata o job |
| a entrega anterior ficou órfã | **não atrapalha** | `current_intent` impede o job velho de escrever estado |

**Antirrepetição:** arrastar o compromisso cinco vezes na grade não pode virar
cinco mensagens. A correção entra na fila com **2 minutos** de espera; uma
remarcação nova dentro da janela substitui a anterior (a geração muda, e o job
velho reprova na vigência e se cancela sozinho). Só a última sai. Os 2 minutos
são escolha minha, não medição — o critério foi "maior que um arrasto
atrapalhado, menor que a paciência de quem espera confirmação".

**O texto precisa dizer que é correção.** Hoje a frase é *"Sua reunião está
marcada para…"*, e recebê-la duas vezes com datas diferentes e sem explicação é
pior que o silêncio. A correção usa frase própria: diz que **mudou**, e diz o
horário novo.

#### B.6.2 O botão destravado

O botão para de ficar preso em *"Link já enviado"*. Ele vira **"Enviar de
novo"**, e leva confirmação antes de disparar.

**Por que uma ação NOVA e não reaproveitar a de enviar:** hoje `fn_meet_action`
devolve `false` quando o estado é `sent`, e esse `false` **é a proteção contra
clique duplo** — é ele que impede a mesma mensagem de sair duas vezes por um
clique nervoso. Se eu simplesmente deixar o botão habilitado e mudar esse
`false`, ganho o reenvio e perco a proteção. Então o reenvio explícito é uma
terceira ação (`resend`), irmã de `retry` e `deliver`, com rota própria no mesmo
molde das duas que já existem — e a de `deliver` continua devolvendo `false`
para clique repetido, como hoje.

Sem atendimento aberto na conversa, o botão fica **desabilitado e explicado** —
mesma regra de B.4.

---

## PARTE C — Uma correção que apareceu no caminho

### C.1 O observador de risco aborta a cada passada

**Medido no log de produção, 2026-09-12:**

```
[risk-watcher] org falhou — new row for relation "crm_lead_risk_states"
violates check constraint "crm_lead_risk_states_since_no_passado"
```

A regra do banco é `check (since <= detected_at)`.

⚠️ **A versão anterior desta seção culpava a causa errada**, e está corrigida
aqui. Eu havia escrito que o `detected_at` congelava no UPDATE porque o `upsert`
o omite. **Medido, é falso:** existe o gatilho
`trg_crm_lead_risk_states_detected_at`, que é `before insert **or update**` e
carimba `detected_at := now()` em toda escrita (migration 0081). **E ele está
presente e ligado na instalação real** — conferido no `pg_trigger` da produção.
Omitir `detected_at` no `upsert` é correto, e o comentário no código está certo.

**A causa real, provada com as próprias funções.** Se `detected_at` é sempre
`now()`, então violar `since <= detected_at` exige `since` **no futuro**. E ele
pode nascer no futuro:

`classifyRisk` (`lib/leads/risk-radar.ts:70-90`) tem **dois atalhos da agenda**
que atribuem balde **sem que limiar nenhum tenha sido cruzado**:

| condição | balde | limiar cruzado? |
|---|---|---|
| `agenda.adiar` | `em_voo` | **não** — entra por adiamento |
| `agenda.motivo = 'presenca_vencida'` | `critico` | **não** — entra por falta |

Mas `sinceDoBucket` (`lib/leads/risk-since.ts:23-40`) devolve **o instante do
cruzamento do limiar** daquele balde: `lastActivityAt + coldHours` para
`em_voo`, `lastActivityAt + criticalHours` para `critico`. Num negócio que foi
tocado há pouco, esse instante ainda **não chegou**.

Rodado contra as duas funções de verdade, com janela de 72h/168h e um negócio
tocado **uma hora antes**:

```
balde: em_voo   | since: 2026-09-15T21:00Z | agora: 2026-09-12T22:00Z | FUTURO? true
balde: critico  | since: 2026-09-19T21:00Z | agora: 2026-09-12T22:00Z | FUTURO? true
CONTROLE — negócio realmente frio:
balde: critico  | since: 2026-09-08T22:00Z | FUTURO? false
```

**O controle é o que fecha o argumento:** no caminho normal — negócio que esfriou
de verdade — o `since` nasce no passado e nada quebra. Só os dois atalhos da
agenda produzem data futura. Por isso o defeito só apareceu depois que a agenda
passou a alimentar o risco.

**Consequência medida:** `risk-worker.ts:120` faz `throw` no erro da gravação,
dentro do laço — então **o observador inteiro para para aquela organização**, na
primeira travessia com data futura, e as demais nem são avaliadas.

### C.2 O conserto — e por que não é decisão de produto

A seção anterior terminava dizendo que a escolha era do dono do produto. **Não
é**, e a medição é que mostra por quê: o `upsert` só é executado quando o balde
**mudou** (`risk-worker.ts:103`, `if (de === e.bucket) continue`). Uma travessia
percebida agora começou, no mais tardar, **agora** — então limitar o `since` a
`now` não escolhe significado nenhum: escreve o que já é verdade.

**O conserto:** `sinceDoBucket` recebe `now` e nunca devolve instante posterior a
ele. No caminho normal nada muda (o cruzamento está no passado); nos dois
atalhos da agenda, o `since` passa a ser o instante da travessia — que é
exatamente o que a coluna promete.

**O que NÃO fazer, e o motivo:** afrouxar a constraint. Ela é a única peça que
percebeu o defeito. Trocá-la por tolerância transformaria "o observador para e
grita" em "o observador grava data futura em silêncio", e a tela passaria a
dizer que um negócio está em risco desde uma data que ainda não aconteceu.

### C.3 Critérios de aceite

- [ ] Negócio tocado há uma hora, com adiamento na agenda, grava `since` **não
      posterior a agora**
- [ ] Mesmo caso com `presenca_vencida`
- [ ] CONTROLE: negócio realmente frio continua com `since` no passado — o
      instante do cruzamento, não `now`
- [ ] Uma gravação que falha **não** derruba a avaliação das outras da mesma
      organização
- [ ] A constraint continua de pé, sem afrouxar

---

## Quanto a atualização passa a custar — medido

**11 atualizações reais desta instalação**, do registro `system_update_runs`
(`dispatched_at` → `finished_at`, que é o relógio do operador: do clique ao fim):

| | segundos |
|---|---|
| mais rápida (v1.17.9 → .10) | 100,2 |
| mediana das 11 | **308,0** |
| média das 11 | 398,9 |
| mais lenta (v1.17.13 → .14) | 885,4 |

O modo seguro acrescenta **16,3s** (parar 10,3s + subir 6,0s, medidos). Sobre a
mediana isso é **+5,3%**; sobre a média, +4,1%.

**A comparação que decide não é essa, é esta:** a variação natural entre duas
atualizações da mesma instalação foi de **785 segundos** (100,2 → 885,4). Os
16,3s do modo seguro são **2% dessa variação** — ficam abaixo do ruído que já
existe. Em troca, os travamentos caem de 113 para 0, que é o que apagou as
regras de isolamento e esvaziou o funil.

Uma ressalva honesta sobre o número: as 11 rodadas terminaram todas em
`success`, e pelo menos uma delas (12/09 15:36, 669,7s) é justamente uma das que
apagou regra e **mesmo assim reportou sucesso**. O tempo medido é o tempo de uma
atualização que pode ter destruído coisa — não o de uma atualização correta.

---

## A conferência das regras contra o Supabase hospedado — medido

A dúvida era se a conferência das 92 regras funcionaria numa instalação que usa
o Supabase na nuvem em vez do banco local. Duas coisas foram medidas:

**1. A conexão não é local.** `url_do_schema()` devolve o que está no `.env`
(`SUPABASE_DB_ADMIN_URL`, e na falta dela `SUPABASE_DB_URL`) —
`hostgator-setup-kit/_common.sh:416-418`. Não há endereço fixo no script. Quem
instalou apontando para a nuvem já conferiria contra a nuvem.

**2. Ler `pg_policy` não exige privilégio nenhum.** Era o risco real: no Supabase
hospedado a conexão **não é de superusuário**. Medido num Postgres 17
descartável — papel sem superusuário, que não é dono da tabela e não tem grant
nenhum nela:

```console
$ psql -U semnada -c "select current_user, rolsuper from pg_roles where rolname=current_user"
semnada|f
$ psql -U semnada -c "select p.polname, c.relname from pg_policy p join pg_class c ..."
t_select|t                      ← vê a regra
$ psql -U semnada -c "select count(*) from public.t"
ERROR:  permission denied for table t     ← e NÃO pode ler a tabela
```

O controle é a última linha: o mesmo papel que enxerga a regra é barrado na
tabela. A visibilidade do catálogo não vem de privilégio, então a conferência
não depende dele.

---

## Nada ficou sem medição

Esta seção já se chamou *"O que esta spec NÃO mediu"* e teve **seis** itens,
depois **três**, depois **um**. Está vazia, e o motivo de ter encolhido três
vezes vale mais que a lista: em todas elas o que me travava era **não ter a
coisa**, e o que precisava ser medido nunca era a coisa — era o **mecanismo**.
Não tenho um Supabase hospedado; mas o que falha num Supabase hospedado é
privilégio e rede, e os dois estão aqui.

O último item, fechado com controle:

**A conferência funciona contra o Supabase hospedado.** Quatro elos, cada um
medido:

1. **O `.env` de uma instalação na nuvem não pode ter a conexão IPv6.** O
   `install.sh` **recusa** a *Direct connection* e manda copiar a do *Session
   pooler* (`install.sh:301-302`), e há teste de validador cobrando essa recusa
   (`test-validators.sh:152`).
2. **O pooler é IPv4.** `aws-0-us-east-1.pooler.supabase.com` resolve só para
   endereço IPv4 (a forma `::ffff:` é IPv4 mapeado, não AAAA de verdade).
3. **E ele é alcançável de dentro do container que o kit usa** — medido com
   credencial falsa de propósito, de um `postgres:17-alpine` nesta VPS:

   ```console
   $ psql "postgresql://prova_sem_conta:sem_senha@aws-0-us-east-1.pooler.supabase.com:5432/postgres?sslmode=require"
   psql: error: connection to server at "aws-0-...pooler.supabase.com" (52.45.94.125), port 5432 failed: FATAL: …
   ```

   **O `FATAL` é a prova.** Quem respondeu foi o Postgres do outro lado,
   recusando a senha: para recusar, ele precisou ser alcançado.

4. **CONTROLE — a sonda sabe distinguir "alcançou e recusou" de "não alcançou".**
   O mesmo comando contra um destino que só existe em IPv6:

   ```console
   $ psql "postgresql://x:y@ipv6.google.com:5432/postgres"
   psql: error: ... (2800:3f0:4001:80b::200e), port 5432 failed: Network unreachable
   ```

   Frase diferente, e ela confirma de quebra que este container **não tem IPv6** —
   que é exatamente por que o elo 1 existe.

Somado ao que já estava medido (ler `pg_policy` não exige privilégio nenhum:
papel sem superusuário, sem posse e sem grant vê a regra e é barrado na tabela),
a conferência das 92 regras funciona na nuvem pelo mesmo caminho que funciona
aqui.
