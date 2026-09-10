# Serviço agendável — quem atende, quanto custa, quando tem

> Desenho de 2026-09-10, **revisado no mesmo dia** depois de medir o modelo de
> profissionais. Duas entregas: `feat/quem-atende-cada-servico` e
> `feat/servico-agendavel`.
>
> Medido contra `origin/main` em `856e16ee` (release 1.18.0 em preparo, PR #684).
> Consome: [`docs/doctrine/sistema-vivo.md`](../../doctrine/sistema-vivo.md),
> [`CLAUDE.md`](../../../CLAUDE.md), [`CONTRIBUTING.md`](../../../CONTRIBUTING.md).

---

## 1. O problema

O CRM se vende como multi-nicho, e "serviços" está no roadmap declarado
([`docs/current-state.md:131`](../../current-state.md)). Para quem vende serviço,
hoje faltam **duas** coisas — e a segunda é mais grave que a primeira.

### 1.1 O catálogo e a agenda não se falam

| Tela | Tabela | Preço? | Duração e regra de horário? |
|---|---|---|---|
| **Produtos** | `catalog_products` | ✅ | ❌ |
| **Tipos de agendamento** | `calendar_event_types` | ❌ | ✅ |

A cliente pergunta *"quanto custa e quando tem?"* — uma pergunta — e o agente
tem duas ferramentas que não compartilham nada.

### 1.2 Um serviço alcança um profissional só — e isso é o buraco maior

**Não existe, em lugar nenhum do schema, a informação "quem atende este
serviço".** O tipo de agendamento tem `default_owner_user_id`: **uma** pessoa.

A consequência, no caso concreto de uma clínica com três dermatologistas: o
agente sempre oferecerá a agenda da mesma pessoa. **Os outros dois são invisíveis
para o atendimento automático.** A clínica tem três agendas e vende como se
tivesse uma.

E quando essa pessoa sai da empresa, `on delete set null` apaga o vínculo em
silêncio — o serviço inteiro para de ser agendável sem que ninguém edite nada nem
seja avisado.

---

## 2. As regras do dono do produto

Ditadas no brainstorm, e são a régua deste desenho:

1. **Serviços diferentes com profissionais diferentes** podem ocupar o mesmo
   horário.
2. **Serviços diferentes com o mesmo profissional**, não.
3. **O mesmo serviço com profissionais diferentes** pode ocupar o mesmo horário.

O modelo do banco **já obedece as três**, porque quem ocupa horário é a agenda da
pessoa (`attendant_availability`), não o serviço. As regras 1 e 2 funcionam hoje.
**A regra 3 não funciona pelo agente** — é o buraco da §1.2.

Duas decisões que vieram junto, e fecham o modelo:

4. **Mesmo serviço, mesmo preço ⇒ UM cadastro**, com vários profissionais
   marcados dentro. Preço diferente ⇒ é outro serviço.
5. **O agente oferece o horário mais próximo entre todos os profissionais** e diz
   com quem seria. A cliente **pode** pedir um profissional específico, e aí ele
   respeita — mas não fica perguntando toda vez.

> A regra 4 é o que impede a duplicação de aparecer para a cliente. Sem ela, a
> clínica contornaria a falta da lista criando três cadastros de "Consulta
> dermatologia" com o mesmo preço — e a busca do agente devolveria três
> resultados idênticos com `empate: true`, obrigando a paciente a escolher entre
> três coisas que ela vê como iguais.

---

## 3. Evidência medida

Tudo abaixo foi lido em 2026-09-10, contra `origin/main` em `856e16ee`.

### 3.1 Não existe vínculo profissional × serviço

```bash
# Só existe a agenda individual. Nenhuma tabela de vínculo.
grep -o "create table if not exists public\.[a-z_]*" supabase/baseline.sql | grep -i attend
# → attendant_availability, e mais nada
```

### 3.2 O agente não recebe o dono, e nem saberia o nome

- O coletor `listaTiposDeAtendimento` **tem** `donoPadraoId`
  ([`lib/agenda/consulta.ts:616`](../../../lib/agenda/consulta.ts)) e **não
  filtra** por ele.
- A tool descarta o campo no `map`
  ([`lib/mcp/tools/agendamento.ts:126`](../../../lib/mcp/tools/agendamento.ts)).
  O modelo recebe "Limpeza de pele, 50 min" sem saber se dá para marcar.
- `crm_find_free_slots` aceita `owner_user_id`, então tecnicamente dá para marcar
  com outra pessoa. **Mas o agente não tem de onde tirar esse identificador para
  este fim.**

**A saída aparente não serve.** Existe `crm_list_available_attendants`
([`lib/mcp/tools/escalacao.ts:62`](../../../lib/mcp/tools/escalacao.ts)), que
devolve `user_id`. Duas razões para não usá-la:

1. Ela responde *"quem pode assumir uma conversa agora"* — filtra por
   `is_available`, `capacity`, `current_load`. A própria descrição diz *"Use
   ANTES de escalar"*. Usada aqui, ofereceria a recepcionista para uma consulta
   de dermatologia.
2. **Ela não devolve nome.** O roster busca `select("user_id, role")`
   ([`lib/escalacao/atendentes.ts:50`](../../../lib/escalacao/atendentes.ts)). O
   agente diria *"prefere com o profissional 7f3a-2b91…?"*.

### 3.3 A recusa existe e é boa; o silêncio é do outro lado

`crm_find_free_slots` recusa com `sem_responsavel`
([`consulta.ts:170`](../../../lib/agenda/consulta.ts)) e o texto ao modelo é
correto: *"Não invente horários: avise que alguém da equipe confirma"*
([`agendamento.ts:395`](../../../lib/mcp/tools/agendamento.ts)).

**Ninguém avisa quem administra.** O aviso amarelo existe só numa tela
([`_client.tsx:366`](../../../app/app/settings/tenant/agenda/_client.tsx)) que a
dona não tem motivo para abrir.

### 3.4 `calendar_appointments` não guarda valor

Tem `event_type_id`, `starts_at`, `contact_id`, sincronização Google — e
**nenhuma coluna de dinheiro** ([`baseline.sql:15182`](../../../supabase/baseline.sql)).

### 3.5 A função de horários é construída em cima de UMA pessoa

`horariosLivresDaOrg` tem **200 linhas**
([`consulta.ts:120`](../../../lib/agenda/consulta.ts)): resolve **um** `donoId` e
lê a agenda dele. Isto molda a decisão §4.3.

---

## 4. Decisões de desenho

### 4.1 A lista de quem atende é tabela de vínculo, e o `default_owner_user_id` NÃO morre

Tabela nova `calendar_event_type_attendants` (`event_type_id`, `user_id`),
muitos-para-muitos.

O campo antigo permanece com o papel que sempre teve e que o nome diz: **o
padrão** — quem entra quando ninguém escolheu. Não é "quem tem permissão de
atender". São coisas diferentes, e confundi-las foi o defeito da primeira versão
deste desenho.

**Compatibilidade:** organização que nunca abrir a tela nova continua com o
comportamento de hoje. A leitura é `lista ∪ {default_owner}` — o padrão entra
sozinho, sem backfill e sem migration de dados.

### 4.2 Sem responsável continua sendo escolha legítima — decidido pelo mantenedor, não por mim

A primeira versão deste desenho ia **perguntar** se convinha exigir responsável na
criação. A pergunta já tem resposta, escrita no código em 2026-09-10
([`_client.tsx:167`](../../../app/app/settings/tenant/agenda/_client.tsx)):

> *"O default vive AQUI e não no POST de propósito: forçar o criador na rota
> transformaria 'Definir depois' num controle decorativo, e deixar um tipo sem
> dono continua sendo escolha legítima de quem opera."*

O contexto importa: a tela **fabricava** tipos órfãos por acidente (`VAZIO`
mandava string vazia, o POST omitia, a coluna não tem default) — foi assim que
"Call Estratégica" nasceu inútil na instalação do próprio dono do produto. O
conserto foi **semear o usuário atual na tela**, mantendo "Definir depois".

**Este desenho segue o mesmo padrão** e não propõe o contrário: a tela semeia,
a rota não força, e a falha vira aviso (§5.3) em vez de bloqueio. Pergunta
retirada da lista ao mantenedor.

### 4.3 A varredura de várias agendas NÃO reescreve as 200 linhas

`horariosLivresDaOrg` é chamada **uma vez por profissional**, e os resultados são
mesclados e ordenados por horário.

**Por quê.** Toda a lógica delicada — buffers, antecedência mínima, janela de
agendamento, fuso, colisão com compromissos existentes — fica **intacta**, e os
testes que hoje a protegem continuam protegendo. Reescrever o miolo de uma função
de 200 linhas no coração da agenda, para ganhar uma otimização que ninguém pediu,
é risco sem comprador.

**O custo, declarado:** N profissionais ⇒ N execuções. Uma clínica tem 3 a 10.
**O número de consultas ao banco por execução não foi medido** — medir antes de
implementar, e se passar de ~10 profissionais, considerar carregar as agendas em
lote. Não otimizar antes de medir.

### 4.4 O agente recebe o NOME do profissional — e o precedente já existe

A regra 5 (§2) exige que o agente diga *"seria com a Dra. Ana"*. Isso obriga o
nome a cruzar para o modelo, o que hoje nenhuma ferramenta de agenda faz.

O precedente está em `crm_list_leads`, que já entrega `owner_user_name` com a
régua escrita ao lado: *"só o nome do dono, sem email/telefone"*
([`lib/mcp/tools/leads.ts:29`](../../../lib/mcp/tools/leads.ts)).

**A régua adotada é a mesma:** nome sim, contato não. Nenhum e-mail, nenhum
telefone, e o `user_id` só quando o modelo precisar devolvê-lo numa chamada.

### 4.5 O que cruza para o modelo, e a régua que o mantenedor acabou de escrever

Ao ligar o lembrete de compromisso (2026-09-10), ele deixou escrito por que
aqueles campos **não** vão ao modelo
([`consulta.ts:625`](../../../lib/agenda/consulta.ts)):

> *"a IA não dispara lembrete nem tem o que fazer com a antecedência dele. Estão
> aqui porque quem administra precisa LER o estado antes de mudá-lo."*

A régua: **só cruza para o modelo o que o modelo consegue acionar.**

Conferindo cada campo novo contra ela:

| Campo | Vai ao modelo? | Por quê |
|---|---|---|
| `pode_marcar` | **sim** | muda o que o agente promete à cliente |
| nome do profissional | **sim** | a regra 5 exige que ele diga com quem seria |
| `preco` do serviço | **sim** | é a resposta à pergunta que originou tudo |
| `user_id` do profissional | **sim, contido** | é o que ele devolve em `crm_find_free_slots`; nunca sozinho, sempre ao lado do nome |
| buffers, antecedência, lembrete | **não** | o modelo não os aciona — régua dele, mantida |

### 4.6 O catálogo é o dono do preço; a ligação é 1:1

Um item de catálogo aponta para no máximo um tipo, e vice-versa.

A regra 4 (§2) é o que torna 1:1 correto: a multiplicidade mora nos
profissionais, não em cadastros duplicados. Um serviço, um preço, um cadastro,
N pessoas dentro.

Isto é a opção **Referenciar** da doutrina DIRC: cada dado continua com um dono
só. Alternativa recusada: tabela `catalog_services`, que duplicaria código, nome,
preço, ativo e moeda — anti-pattern nº 2 do `CLAUDE.md`.

### 4.7 O compromisso guarda CÓPIA do preço

Se a clínica reajustar amanhã, o que foi combinado ontem não muda. Preço em
compromisso passado é registro, não consulta. `_cents` + `moeda` ISO-4217.

### 4.8 `pode_marcar` é derivado, nunca armazenado

```
pode_marcar = tipo.is_active
           && (existe ao menos um vínculo em calendar_event_type_attendants
               OU tipo.default_owner_user_id != null)
```

Coluna armazenada precisaria de sincronização — anti-pattern nº 5. Derivado, o
`on delete set null` se auto-cura: a última pessoa sai, e no instante seguinte o
agente para de prometer horário.

### 4.9 A entrega é dividida em duas

**A — "Quem atende cada serviço"** vale sozinha: conserta os três dermatologistas
para toda clínica que já usa a agenda hoje, sem depender de catálogo. É melhoria
de algo que já está no ar.

**B — "Serviço agendável"** depende de A, porque `agendavel` do catálogo deriva de
`pode_marcar`.

O conserto do serviço órfão **mora dentro de A** — a conta de "dá para marcar?" é
a mesma pergunta que "tem alguém na lista?".

Tamanho estimado: A ~15 arquivos, B ~12. Os merges recentes do repo ficam entre 3
e 19 arquivos (`#640` com 3, `#634` com 10, `#615` com 19). Junto passaria de 25 —
acima da faixa observada.

---

## 5. Entrega A — Quem atende cada serviço

`feat/quem-atende-cada-servico`

### 5.1 Schema

Número: **conferir `ls supabase/migrations/` na hora de criar.** Medido hoje na
`origin/main`: o último é `0232` (`nome_de_sessao_waha`), e **`0231` foi pulado**
na numeração upstream. O próximo livre é `0233`.

> ⚠️ Há uma colisão de `0232` viva no fork (`0232_politica_de_cadastro` da PR
> #682 × `0232_nome_de_sessao_waha` da main). O gate
> `tests/unit/manifest-x-migrations.test.ts` reprova número repetido — medido,
> falha. Não é desta entrega, mas quem numerar aqui precisa saber.

```sql
create table if not exists public.calendar_event_type_attendants (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  event_type_id uuid not null references public.calendar_event_types(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (event_type_id, user_id)
);

create index if not exists cal_event_type_attendants_org_tipo_idx
  on public.calendar_event_type_attendants (organization_id, event_type_id);
```

`on delete cascade` no `user_id`, e **não** `set null`: aqui a linha inteira
significa "esta pessoa atende isto". Sem a pessoa, a linha não tem sentido —
diferente do `default_owner_user_id`, onde o tipo sobrevive ao dono.

**RLS obrigatória:** tabela tenant-aware nova ⇒ `alter table ... enable row level
security` + policy `tenant_isolation_calendar_event_type_attendants_all` via
`fn_user_org_ids()`. O teste de isolamento cobre uma **lista fixa** de tabelas — a
nova **não entra sozinha**, é preciso acrescentá-la.

**Tripla obrigatória:** `migrations/` + apêndice idempotente no `baseline.sql` +
linha no `MANIFEST.md`.

### 5.2 Leitura e varredura

- Coletor: `listaTiposDeAtendimento` passa a trazer `atendentes: {id, nome}[]`,
  resolvidos como `vínculos ∪ {default_owner}`.
- `crm_list_event_types` ganha `pode_marcar` e `profissionais: [{nome}]`.
- `crm_find_free_slots` sem `owner_user_id` varre **todos** e devolve os horários
  mais próximos, cada um com `profissional: {user_id, nome}`. Com
  `owner_user_id`, comportamento de hoje.
- A `description` da tool ensina a regra 5: ofereça o mais próximo e diga com
  quem; só pergunte o profissional se a pessoa demonstrar preferência.

### 5.3 O aviso, com o título honesto

Novo `kind` `agenda_sem_responsavel` na Central de Avisos.

**Onde dispara:** no handler da tool MCP, **não** em `consulta.ts` — a função de
leitura também serve a tela, e abrir aviso a cada visualização seria ruído.

**Dedup:** um item aberto por tipo, padrão do `handoff`
([`human-handoff.ts:175`](../../../lib/agent-engine/agent/human-handoff.ts)).

**`ref_kind: 'conversation'`** — leva à conversa onde a cliente pediu.

**Redação.** A primeira versão deste desenho propunha o título *"Um cliente pediu
um atendimento que ninguém pode marcar"*. Está errado: lê-se como "ninguém na
clínica faz isso", o que é falso. O correto nomeia a configuração, não a
capacidade da empresa:

- **Título:** *"Um serviço está sem ninguém que o atenda"*
- **Orientação:** *"Marque quem atende esse serviço em Configurações › Tipos de
  agendamento. Enquanto a lista estiver vazia, o assistente não consegue oferecer
  horário — e um cliente já pediu."*

Três arquivos acompanham o `kind`, e o vocabulário exige o conjunto:
[`repository.ts`](../../../lib/agent-engine/db/repository.ts) (a união),
[`agent-inbox-copy.ts`](../../../lib/ai/agent-inbox-copy.ts) (o título),
[`inbox-destino.ts`](../../../lib/ai/inbox-destino.ts) (`refs` + orientação). O
CHECK do banco é reconstruído em **UM bloco só** (`drop constraint if exists` +
`add constraint`, [`baseline.sql:10034`](../../../supabase/baseline.sql)) — N
blocos quebram o `update.sh` de um clone com vocabulário posterior, lição do #159.

### 5.4 Tela

`app/app/settings/tenant/agenda/_client.tsx` (525 linhas hoje).

Multi-seleção de profissionais no cadastro do tipo, **semeada com o usuário
atual**, seguindo o padrão da §4.2. Lista vazia é permitida e mostra o aviso que
já existe, com o texto ajustado para falar de lista e não de "responsável".

⚠️ O formulário de **edição** tem menos campos que o de criação. Campo novo
precisa entrar nos dois, ou vira controle decorativo.

`app/api/v1/agenda/tipos/route.ts` recebe o array no Zod.

---

## 6. Entrega B — Serviço agendável

`feat/servico-agendavel`. Depende de A.

### 6.1 Schema

```sql
alter table public.catalog_products
  add column if not exists event_type_id uuid
    references public.calendar_event_types(id) on delete set null;

create unique index if not exists catalog_products_event_type_key
  on public.catalog_products (event_type_id) where event_type_id is not null;

alter table public.calendar_appointments
  add column if not exists preco_cents bigint,
  add column if not exists moeda text;

alter table public.calendar_appointments
  add constraint calendar_appointments_preco_nao_negativo
    check (preco_cents is null or preco_cents >= 0);
```

Tudo nullable e aditivo — instalação existente não sente nada. `on delete set
null` e não `restrict` porque a tela de tipos **desativa**, não apaga; quando o
delete ocorrer, o item continua como produto e deixa de ser agendável, que é a
semântica correta.

### 6.2 Ferramentas

| Tool | Ganha |
|---|---|
| `crm_search_products` | `agendavel` + `event_type_slug` |
| `crm_list_event_types` | `preco` |
| `crm_book_appointment` | grava `preco_cents`/`moeda`, cópia do item ligado |

`agendavel = item.event_type_id != null && pode_marcar(tipo)` — derivado, §4.8.

**A moeda não vem do modelo nem do corpo.** O servidor a copia de quem é dono da
unidade — `moedaDaOrganizacao()`
([`lib/catalogo/moeda-da-org.ts:30`](../../../lib/catalogo/moeda-da-org.ts)) — ou
do item ligado. Corpo não decide unidade, como não decide escopo.

⚠️ **A paginação de `crm_search_products` é frágil por bom motivo.** Ela distingue
"não achei no que varri" de "a loja não tem" (`varreduraParcial`, issue #480). O
join **não pode** alterar contagem nem a ordem estável por `codigo`. Usar `select`
embutido do PostgREST na mesma consulta, nunca uma segunda ida ao banco.
`tests/unit/catalogo-nao-corta-cego.test.ts` tem de continuar verde.

### 6.3 Telas

**Produtos** (382 linhas): bloco *"Este item se marca por horário?"*. Ao ligar,
escolhe um tipo ainda não reivindicado, ou cria inline com nome herdado, duração
e a lista de profissionais (semeada com o usuário atual, §4.2).

**Tipos de agendamento:** mostra o preço quando ligado, com link ao catálogo.
**Não edita preço aqui** — fonte única é o catálogo.

**Compromisso:** o valor aparece, e na linha do tempo do contato. Sem isso,
gravar o preço reprova no invariante 5 — *"um número que não muda uma decisão é
ruído"*.

**Navegação:** nenhuma tela nova ⇒ nenhuma porta nova. O rótulo "Produtos" passa
a mentir para uma clínica; proposta "Produtos e serviços", **sem** mudar a URL.
Pergunta ao mantenedor (§9).

---

## 7. Living System Checklist

```
Living System Checklist — Serviço agendável (A + B)

[x] Quem me alimenta?
    Tela de Tipos de agendamento (quem atende, duração, horário) e tela de
    Produtos (o item e o preço).

[x] Quem eu alimento?
    crm_list_event_types, crm_find_free_slots, crm_search_products (o agente
    na conversa); crm_book_appointment (o compromisso); a linha do tempo do
    contato.

[x] Que atividade/log eu emito?
    api_audit_log nas mutações das rotas; agent_inbox_items kind
    'agenda_sem_responsavel'; o compromisso marcado já gera atividade.

[x] Onde eu apareço na tela?
    Tipos de agendamento, Produtos, Agenda, Central de Avisos.

[x] Por qual porta se chega até mim?
    lib/navigation/catalogo.ts:212 (Produtos) e :235 (Tipos). Ambas existem.

[x] Qual meu mecanismo anti-morte?
    O aviso agenda_sem_responsavel. Serviço que ninguém atende deixa de morrer
    em silêncio e vira item com dono.

[x] Onde se CONFIGURA o que eu uso?
    As duas telas. Lista vazia vira item de inbox, nunca um return mudo.

[x] Qual a continuidade IA↔humano?
    IA → humano: o aviso carrega a conversa onde a cliente pediu.
    Humano → IA: marcar um profissional faz pode_marcar virar true na leitura
    seguinte — o agente volta a oferecer horário sem reprocessar nada.

[~] Qual meu LAÇO DE RETORNO?
    PARCIAL, declarado como dívida.
    FECHA para "ninguém atende": recusa → aviso → ação → comportamento muda.
    NÃO FECHA para "preço desatualizado": nada descobre que a clínica
    reajustou e esqueceu de atualizar. O agente responderá o preço velho com
    confiança. Detectar exigiria fonte externa de verdade sobre preço, que não
    existe num self-host. Mitigação futura possível: idade do updated_at virar
    aviso depois de N meses.

[x] Atualizei o mapa vivo?
    docs/architecture/servico-agendavel.architecture.json, com as arestas
    catalog_products → calendar_event_types → calendar_event_type_attendants
    → attendant_availability, e catalog_products → crm_search_products.
```

---

## 8. Prova

A doutrina de QA Visual manda provar **pela tela**, como um leigo faria, em
ambiente fresco estilo VPS. `curl` não conta.

### 8.1 Unit

| Arquivo | O que trava |
|---|---|
| `agenda-quem-atende.test.ts` | lista vazia + sem padrão ⇒ `pode_marcar: false`; só padrão ⇒ `true`; vínculos ⇒ `true`; a união não duplica quando o padrão também está na lista |
| `agenda-varredura-multipla.test.ts` | N profissionais ⇒ N execuções, mescladas e ordenadas por horário; `owner_user_id` explícito volta ao caminho de hoje |
| `agenda-nome-sem-contato.test.ts` | a saída traz nome; **não** traz e-mail nem telefone |
| `inbox-agenda-sem-responsavel.test.ts` | abre uma vez; segunda recusa no mesmo tipo não duplica |
| `catalogo-agendavel.test.ts` | `agendavel` falso sem ligação, com tipo inativo, e com lista vazia |
| `catalogo-nao-corta-cego.test.ts` (**existe**) | continua verde: o join não muda contagem, ordem nem `varreduraParcial` |

### 8.2 Banco (`pnpm test:db`)

- `baseline.sql` em modo **install** (`ON_ERROR_STOP=1`) e **update** (re-aplicar).
- RLS da tabela nova: duas organizações não se enxergam. **Acrescentar a tabela à
  lista fixa do teste de isolamento** — ela não entra sozinha.
- O índice único impede dois itens de catálogo no mesmo tipo.

### 8.3 Tela (`pnpm test:e2e`)

`tests/e2e/quem-atende-cada-servico.spec.ts` (A) e
`tests/e2e/servico-agendavel.spec.ts` (B):

1. Marcar três profissionais num serviço; conferir que a busca de horário devolve
   os três, ordenados por proximidade.
2. Pedir um profissional específico; conferir que só aquela agenda é oferecida.
3. Esvaziar a lista; conferir o aviso na tela **e** o item na Central de Avisos.
4. (B) Cadastrar o serviço com preço, marcar, e conferir o valor no compromisso.

Medidas de layout por ferramenta (`getBoundingClientRect`/`getComputedStyle`),
nunca a olho. Evidência em `.superpowers/evidence/`.

Registrar em [`docs/testing/user-journey-map.md`](../../testing/user-journey-map.md)
e declarar as specs em `SPECS_PARTE_*` do `.github/workflows/e2e.yml` — senão
`tests/unit/e2e-cobertura-completa.test.ts` reprova.

### 8.4 Gates antes de abrir cada PR

```bash
pnpm typecheck && pnpm lint && pnpm lint:channels && pnpm test:unit && pnpm build
pnpm test:db
```

⚠️ `pnpm test:unit` **sem caminho**. O script é `vitest run` sem argumento e
alcança o repositório inteiro. `vitest run tests/unit` produz um verde menor e
mais fácil **sem avisar que produziu**.

⚠️ Não cortar a saída com `| tail`. O rodapé (`Tests N failed`) é a autoridade; o
`grep FAIL` pode devolver vazio **com** falhas. Comparar os dois.

⚠️ Vermelho local que não é seu: `lib/ai/dispatcher/rate-limit.test.ts` falha
quando o `.env.local` aponta para um Redis fora do ar; e nesta instalação Windows
há falhas de separador de caminho. Comparar com a base:
`git stash push --include-untracked && npx vitest run <arquivos> ; git stash pop`

---

## 9. Perguntas ao mantenedor

Vão na issue, antes do código. **Eram quatro; são duas** — o próprio código dele
respondeu uma (§4.2) e a regra 4 do dono do produto resolveu outra (§4.6).

1. **A tabela de vínculo é o modelo certo**, ou ele prefere resolver o
   multi-profissional de outra forma? É a decisão estrutural da entrega A.
2. **Renomear o rótulo** "Produtos" para "Produtos e serviços"? URL não muda.

Respondidas e retiradas:

- ~~Exigir responsável na criação?~~ Ele decidiu em código: não, e forçar na rota
  seria controle decorativo (§4.2).
- ~~1:1 ou 1:N entre catálogo e tipo?~~ 1:1, porque a multiplicidade mora nos
  profissionais (§4.6).

---

## 10. Riscos e dívidas

**Dívida 1 — sem laço de retorno para preço desatualizado.** Justificativa
escrita em §7.

**Risco 1 — número de migration.** `0231` foi pulado upstream, `0232` está usado,
e há colisão viva no fork. Conferir na hora (§5.1).

**Risco 2 — a varredura N vezes.** Consultas por execução **não medidas**. Medir
antes de implementar; acima de ~10 profissionais, considerar carga em lote.

**Risco 3 — o join na busca de produtos.** Segunda consulta em vez de `select`
embutido reintroduz o defeito da issue #480 (§6.2).

**Risco 4 — RLS da tabela nova não entra sozinha** no teste de isolamento (§8.2).

**Risco 5 — o formulário de edição de tipos tem menos campos que o de criação.**

**Não-risco:** o tamanho de cada PR, medido contra a história de merges (§4.9).

---

## 11. Documentação a atualizar

- `.changes/` — um fragmento por entrega. A: `secao: corrigido` **ou**
  `adicionado` (ela conserta e amplia; declarar `capacidade_nova`). B:
  `adicionado`, `capacidade_nova`. **Nenhuma é `exige_acao`** — tudo aditivo,
  nada pede ação de quem opera uma VPS.
- `docs/architecture/servico-agendavel.architecture.json`
- `docs/testing/user-journey-map.md`
- `supabase/migrations/MANIFEST.md`
- `.github/workflows/e2e.yml`

**Fora de escopo:** relatório de faturamento agendado; renomear a URL
`/app/products`; preço por profissional (a regra 4 diz que isso é outro serviço);
templates de nicho.

---

## 12. Fluxo

1. **Abrir a issue** com o problema medido (§3) e as duas perguntas (§9).
2. Comentar "pego esta"; aguardar atribuição ou 48h.
3. Branch a partir da `main` **do upstream**, nunca do `main` do fork.
4. Entrega A primeiro. B depois de A mergear.
5. Gates da §8.4. PR do fork para `melgarafael/DeskcommCRM`, com evidência visual.

Pela `nossa-regra.md`, é **Jeito 1** — melhoria que toda instalação quer, custo de
manutenção zero depois do merge.
