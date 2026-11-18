# ADR-0008 — Fila como dono da conversa e como destino de entrada

- **Status:** proposto
- **Data:** 2026-11-18
- **Contexto medido em:** `11c0206ba` (`main`, release 1.118.0)
- **Relacionado:** #3817 (setores como destino, fatia 1), #3876 (fila no ⋯), #3881 (setor pela IA e pela automação), #4060 (atendente vê o próprio setor)
- **Origem:** operação real de escola e de clínica (ver §Motivação)

---

## Motivação

Duas operações reais, o mesmo defeito:

**Escola.** O número institucional é um só. Quem responde primeiro é a Secretaria — mas o pai
que pede "quero falar com a Pedagogia" precisa que a conversa vá para a **Pedagogia**, e que
**qualquer** pedagoga possa assumir, não uma pessoa escolhida a dedo pelo nome. Hoje o gesto
possível é transferir para uma pessoa; se ela está em aula, a conversa fica parada com ela.

**Clínica.** A recepção atende no número geral; o financeiro tem outro número. Nada garante que
o número geral "entre" na Recepção, e nada impede que a conversa de uma paciente sobre exame
apareça para a equipe do financeiro.

Nenhum dos dois casos é exótico: é o vocabulário de **fila / departamento** que o mercado inteiro
usa como unidade de trabalho. No Deskcomm, o setor já existe e já é respeitado pelo motor —
o que não existe é ele **possuir** a conversa.

## Estado medido

| Peça | Onde | O que faz hoje |
|---|---|---|
| Setores e vínculo N:N | `attendant_sectors`, `attendant_sector_members` (0801; PK `(org, user, sector)` desde a 9062) | agrupam pessoas; uma pessoa em vários setores |
| Setor na conversa | `conversations.sector_id` (9062, FK composta, `on delete set null (sector_id)`) | grava o destino |
| Elegibilidade | `fn_channel_routing_claim` | se a conversa tem setor, candidato fora do setor recebe `candidate_not_in_sector` |
| Distribuição por canal | `channel_routing_policies` (`distribution_mode` `manual`/`round_robin`/`load`, `default_assignee_user_id`, `ai_wait_minutes`) + `channel_routing_responsibles` | escolhe entre **pessoas** — nunca entre setores |
| Quem enxerga | policy `conversations_select` | cinco portas: `org_wide` (viewer/manager/admin ou `visibility_mode='all'`), dono, **sem dono** (mode `own_and_unassigned`), participante e **membro do setor** (`fn_conversation_sector_scope`) |
| Escopos de visibilidade | `lib/auth/types.ts:105`, migração **9214** (#4022), tela em `app/app/settings/atendimento/_form.tsx:119` | **existem os quatro** — `all`, `own_and_unassigned`, `own`, `own_and_sector`. O último já restringe o atendente ao próprio setor via `fn_conversation_sector_scope`, aplicado por `conversations_select` |
| Transferência | `components/inbox/ReassignDialog.tsx` | abas `Atendente` e `Número`; destino é sempre uma **pessoa** |
| Mover de fila | `components/inbox/MoverParaFila.tsx` (menu ⋯) → `PUT /api/v1/conversations/[id]/sector` | grava o setor; **não** mexe no dono |
| Automação/IA | `lib/automation/actions/define-sector.ts` (#3881) | conseguem definir o setor — é a única forma de "entrada" hoje |
| Tela de distribuição | `app/app/settings/atendimento` | modo + responsáveis (pessoas) por número |

### Os três buracos

1. **Setor não é destino de entrada.** Nada define `sector_id` na chegada; a política do canal
   lista pessoas. Efeito: o número geral distribui entre 17 pessoas em vez de entregar na
   Secretaria — e a "fila" só existe se alguém lembrar de marcar.
2. **Setor não pode ser dono.** A conversa pertence a uma pessoa ou a ninguém. Não existe
   "esta conversa é da Pedagogia, qualquer pedagoga assume" — que é exatamente o caso da escola.
3. **Privacidade por setor existe — e hoje é perigosa sozinha.** `own_and_sector` (9214) já restringe o
   atendente ao próprio setor, mas nesse modo `sees_unassigned` é falso: uma conversa **sem setor e sem
   dono** não aparece para atendente nenhum (só gestor vê). Ou seja, o modo que protege é justamente o
   que faz a conversa sem fila sumir da vista de quem deveria pegá-la — e é por isso que a privacidade
   depende da fila de entrada existir (D1), não de mais uma permissão.

## O que o mercado faz (medido, com fonte)

| Produto | Como o grupo/fila é tratado | Fonte |
|---|---|---|
| **Zendesk** | *"tickets can be assigned to a group only, or to a group and an agent"*. Todo agente pertence a ≥1 grupo e pode estar em vários; existe **grupo padrão** da conta e **grupo padrão por agente**; o roteamento usa o **grupo do ticket** para decidir quem é elegível | support.zendesk.com/hc/en-us/articles/4408886146842 e /4409149119514 |
| **Freshdesk** | Omniroute: grupos + **filas por canal** + carga por agente; atribuição passa por grupo antes de virar pessoa | support.freshdesk.com/support/solutions/articles/238979 |
| **Chatwoot** | round-robin **por inbox**, ligado por padrão; times (grupos de agentes) como destino; sem gente disponível → `Unassigned` | chatwoot.help/hc/user-guide/articles/1677696868 |
| **Whaticket** | transferência "para uma pessoa específica **ou para um departamento**"; distribuição automática por departamento; *"quando a conversa já tem responsável, ela sai da fila dos outros"* | whaticket.com/pt/blog/transferir-conversas-entre-atendentes e help.whaticket.com |

Conclusão da comparação: em todos, a fila é **entidade de trabalho**, não filtro. Agentes × grupos é
N:N com grupo padrão, e a atribuição pode parar no grupo (dono-fila) antes de virar pessoa. O
Deskcomm é o único da lista em que a fila não pode possuir nada — e o substrato já está pago
(`conversations.sector_id`, claim com escopo, RLS por setor, automação `define_sector`).

## Decisões propostas

### D1 — Fila de entrada por canal (opt-in, NULL = hoje)

`channel_routing_policies.sector_id` (nullable, FK composta `(organization_id, sector_id)`).
Quando preenchido, a conversa nasce com aquele setor e a distribuição passa a escolher **entre os
membros da fila**. Sem preencher, o comportamento é exatamente o de hoje.

Escolha por **canal**, não por organização: escola tem um número e uma secretaria; clínica tem
número de recepção e número de financeiro, com filas e horários diferentes. É a mesma razão pela
qual o Zendesk permite grupo padrão por conta **e** por agente, e o Freshdesk fala de "filas por
canal".

### D2 — O dono é a FILA; a pessoa é o responsável do momento

Duas palavras, duas coisas — e misturá-las é o que faz a operação perder o controle:

| Papel | Quem é | Quem define |
|---|---|---|
| **Dono** | o **setor** (`conversations.sector_id`) | **a administração geral** (admin/manager) — na política do canal (D1) ou no gesto de transferir de fila (D3) |
| **Responsável** | a pessoa que está atendendo agora (`assigned_to_user_id`) | qualquer membro do setor **do próprio setor**, pelo `claim`/assumir; e a administração, ao transferir |

Consequência de desenho: **`assigned_to_user_id IS NULL` deixa de ser "conversa de ninguém"** e passa a
ser "conversa da fila, aguardando alguém do setor assumir". Não é coluna nova: o estado já existe; o
que muda é a leitura que o produto faz dele.

E o limite de permissão que vem daí: **atendente não escolhe o dono**. Ele assume e devolve dentro dos
setores **a que pertence**; **mover a conversa para um setor de fora da sua lista é gesto de
administração** (admin/manager), igual ao que já vale para a política de distribuição do canal. Sem
isso, "o setor é o dono" vira ficção no primeiro dia em que um atendente mover a conversa de
Pedagogia para Secretaria para se livrar do atendimento.

**Pertencer a mais de um setor é o caso normal, não a exceção** — e ele já está resolvido no banco:
`attendant_sector_members` é N:N desde a 9062, e `fn_conversation_sector_scope` devolve **uma linha por
(organização, setor)** do chamador. Na escola: a mesma pessoa cobre Secretaria e Pedagogia; ela vê e
assume nas duas, e continua sem ver Direção. É por isso que a regra certa não é "atendente vê um
setor" nem "vê a organização", e sim **"vê os seus setores"**.

### D3 — "Transferir para fila" no diálogo de transferência

Terceira aba no `ReassignDialog`: `Atendente` · `Número` · **`Fila`**, visível para **admin/manager**
(mover de fila é gesto de administração — ver D2). Escolher fila grava o setor
(`PUT /conversations/[id]/sector`) e, num segundo passo explícito, **libera o responsável**
(`release`) — as duas rotas já existem e já auditam (`conversation.sector_changed`,
`conversation.released`). O motivo continua sendo campo único para as três abas.

Isso resolve o caso da escola em **um gesto**: Secretaria atendeu, pai pediu Pedagogia → transferir
para a fila Pedagogia; a próxima pedagoga disponível assume.

### D4 — Rodízio dentro da fila

Com fila definida na conversa, os elegíveis são **membros do setor** ∩ abertura ∩ disponibilidade ∩
folga (o mesmo `loadEligibleAttendants` de hoje). `channel_routing_responsibles` continua valendo
como **subconjunto explícito** — quem está na lista do canal e no setor recebe; quem só está na
lista do canal não recebe conversa de fila.

### D5 — Privacidade por setor: usar o modo que já existe, sem inventar permissão

`own_and_sector` (migração 9214, #4022) já entrega a resposta para "usuários de um setor não veem as
mensagens de outro": o atendente vê o que é dele **e** o que é do setor dele, e mais nada; gestor
(viewer/manager/admin) continua org-wide. **Esta proposta não cria modo novo.**

O que falta não é permissão — é o par dela:

1. a dependência medida acima (sem setor e sem dono ⇒ invisível para atendente), que **D1 fecha** ao
   dar fila de entrada a toda conversa nova;
2. a tela de Distribuição passa a dizer o que o modo faz, inclusive esse caso — hoje o texto do
   "Atendente só vê o setor" não menciona a conversa órfã;
3. pergunta aberta ao mantenedor: a restrição vale por **organização** (como os outros modos) ou pode
   ser por **setor** (`attendant_sectors.restrito`), permitindo um setor fechado e outro aberto na
   mesma empresa?

### D6 — (fora desta fatia) fila padrão por pessoa

O Zendesk tem *default group por agente*. Aqui isso vira `user_organizations` → setor padrão, útil
para orientar o "Assumir" de quem está em três setores. Fica registrado, não implementado.

## Quem pode o quê (proposta)

| Gesto | viewer | agent | manager | admin |
|---|---|---|---|---|
| Assumir conversa da **sua** fila | — | ✅ | ✅ | ✅ |
| Devolver para a fila (release) | — | ✅ | ✅ | ✅ |
| **Mover entre os setores de que a pessoa é membro** | — | ✅ (proposta) | ✅ | ✅ |
| **Mover para um setor de fora da lista da pessoa** | — | — | ✅ | ✅ |
| Definir a **fila de entrada** do canal | — | — | — | ✅ |
| Trocar o responsável por outra pessoa | — | — | ✅ | ✅ |
| Ver conversas dos setores a que **pertence** (N:N) | — | ✅ | ✅ | ✅ |
| Ver conversas de setor em que **não** é membro | — | — | ✅ (org-wide) | ✅ |

Leitura: quanto mais a fila vira dono, mais o "assumir/devolver" é do atendente e menos o "classificar"
é dele. É o inverso do que acontece hoje, em que qualquer `agent` move a fila pelo ⋯ e nenhum gestor
define qual fila recebe o quê — e em que o multi-setor não muda nada, porque a fila nunca foi dono.

As duas linhas de "mover" são a mesma régua vista de dois lados: **a lista de setores da pessoa
é o limite do que ela pode fazer sozinha**. Quem cobre Secretaria e Pedagogia transita entre as
duas; para mandar à Direção, chama a administração.

## Consequências

**O que melhora**

- Escola: número geral → Secretaria → qualquer secretária assume; transferir para Pedagogia é uma
  escolha de fila, não uma caça ao nome de uma pessoa.
- Clínica: cada número entra na sua fila; financeiro e recepção não compartilham conversa.
- Auditoria fica melhor, não pior: as duas rotas usadas já gravam evento com "de qual setor para
  qual" e com autor.

**O que pode dar errado (e como fechamos)**

| Risco | Fechamento proposto |
|---|---|
| Conversa "da fila" fica parada porque ninguém disponível | fica visível na fila com motivo (`no_eligible`/`out_of_schedule`) — não desaparece nem é redistribuída fora do horário |
| Quem transfere "solta" a conversa para se livrar do atendimento | o release é passo explícito na mesma ação, entra no histórico com autor e motivo; e a fila continua com dono (a própria fila) |
| Fila sem membro | a tela recusa salvar a política de entrada em fila vazia (validação na rota, não só no cliente) |
| Módulo `setores` desligado | 404 em todas as rotas novas, igual às existentes |
| Instalação que não quer nada disso | `sector_id` NULL e `visibility_mode` como está ⇒ comportamento idêntico ao de hoje |

## Fatiamento

| Fatia | Entrega | Muda política? |
|---|---|---|
| **1** | `ReassignDialog` com aba **Fila** (setor + liberar responsável) e o cabeçalho mostrando `Fila: Pedagogia · sem responsável` | não — usa rotas existentes |
| **2** | `channel_routing_policies.sector_id` + tela de Distribuição + claim/rodízio por fila + invariante de banco | sim, opt-in |
| **3** | texto e guarda do `own_and_sector` (9214 já implementado): aviso da conversa órfã + opção por setor, se o mantenedor quiser | sim, opt-in |
| **4** | Fila padrão por pessoa (D6) | opt-in |

A fatia 1 é a que fecha a dor relatada e não decide nada no núcleo; as fatias 2 e 3 são as que
mexem em **disparo e fila** — e por isso estão aqui como proposta, não como código.

## Perguntas numeradas (para o mantenedor)

1. **Dono-fila sem coluna nova**: `assigned_to_user_id IS NULL` + `sector_id` preenchido é estado
   suficiente para "a conversa é da fila", ou você prefere um `owner_kind` explícito
   (`user` | `sector`)?
2. **Transferir para fila**: mantém o responsável anterior até alguém do setor assumir (proposta —
   evita conversa "solta" e o histórico diz quem entregou) ou libera na hora? E o atendente pode
   mover para **outro** setor, ou só a administração (a coluna "mover para outra fila" da tabela
   acima)?
3. **Rodízio**: `channel_routing_responsibles` vira subconjunto da fila (proposta) ou é ignorado
   quando há fila definida?
4. **Privacidade**: `own_and_sector` já existe por organização. Vale abrir a opção **por setor**
   (`attendant_sectors.restrito`), para um setor fechado e outro aberto na mesma empresa, ou manter
   só o modo da organização?
5. **Multi-setor**: pertencer a vários setores deve liberar o atendente a **mover entre eles**
   (proposta, por analogia com "assumir"), ou mover é sempre da administração, mesmo entre setores
   da própria pessoa?
6. **Nome de produto**: manter **Setor** (o que já está em tela, módulo e endpoints), ou renomear
   para **Fila**/**Departamento** como o mercado? É PR de rótulo, sem migração.
7. **Escopo desta proposta**: seguir o fatiamento acima (1 já como código, 2–3 depois da sua
   decisão) ou você prefere uma fatia só com as quatro decisões juntas?

## O que este ADR NÃO propõe

- Não muda `GRANT`, RLS de outra tabela, nem permissão de papel.
- Não altera o comportamento de nenhuma conversa existente: toda coluna nova é nullable e toda
  mudança de leitura é por configuração.
- Não substitui o módulo `setores`; ele continua opcional e desligado por padrão.
