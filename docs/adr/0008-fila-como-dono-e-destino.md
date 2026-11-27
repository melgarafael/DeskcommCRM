# ADR-0008 — Fila como dono da conversa e como destino de entrada

- **Status:** aceito em 2026-11-26 pelo mantenedor (@melgarafael), na resposta ao documento de decisão do PR #4952, com as quatro respostas recomendadas (ver §Respostas do mantenedor); proposto por @webtecnica em 2026-11-18, na issue #4950
- **Data:** 2026-11-18
- **Contexto medido em:** `11c0206ba` (`main`, release 1.118.0); os caminhos de código citados foram reconferidos em `ea624436b` (`main`, 26/11/2026)
- **Relacionado:** #3817 (setores como destino, fatia 1), #3876 (fila no ⋯), #3881 (setor pela IA e pela automação), #4060 (atendente vê o próprio setor), #4953 (fatia 1 desta ADR: aba Fila na transferência)
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

## Decisões

As decisões abaixo foram propostas em 18/11 e aceitas em 26/11. Onde a resposta do mantenedor
fixou um ponto que o texto deixava aberto, a decisão já está escrita com a resposta.

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
| **Dono** | o **setor** (`conversations.sector_id`) | a administração, na política do canal (D1); e **quem atende**, no gesto de transferir de fila (D3) |
| **Responsável** | a pessoa que está atendendo agora (`assigned_to_user_id`) | qualquer membro do setor, pelo `claim`/assumir; ou a pessoa escolhida por quem transfere |

Consequência de desenho: **`assigned_to_user_id IS NULL` deixa de ser "conversa de ninguém"** e passa a
ser "conversa da fila, aguardando alguém do setor assumir". Não é coluna nova: o estado já existe; o
que muda é a leitura que o produto faz dele. **Decidido (resposta 1): não entra `owner_kind` nem outra
coluna de dona.** "Tem fila e não tem pessoa" já diz que a conversa é da fila; uma coluna a mais seria
a mesma informação em dois lugares, e um dia os dois discordariam.

E o limite de permissão vem do que **já existe**, não de um degrau novo: transferir conversa é gesto de
quem atende. `PUT /api/v1/conversations/[id]/sector` exige papel mínimo `agent`, e o diálogo de
transferência para pessoa já está aberto para `agent` hoje. Mover para fila segue a mesma régua —
**qualquer atendente move, para qualquer fila**, inclusive para um setor de que não é membro, porque é
exatamente o que ele já faz quando transfere para um colega de outro time.

Endurecer aqui seria criar uma assimetria que o produto não tem: "transfira para a Maria, da Direção,
que ela muda de fila" — o caminho mais curto para a gambiarra e para o registro perdido. O que a
administração define é a **fila de entrada do canal** (D1), que é configuração, não fluxo do dia a dia.

**Pertencer a mais de um setor é o caso normal, não a exceção** — e ele já está resolvido no banco:
`attendant_sector_members` é N:N desde a 9062, e `fn_conversation_sector_scope` devolve **uma linha por
(organização, setor)** do chamador. Na escola: a mesma pessoa cobre Secretaria e Pedagogia; ela vê e
assume nas duas, e continua sem ver Direção. É por isso que a regra certa não é "atendente vê um
setor" nem "vê a organização", e sim **"vê os seus setores"**.

### D3 — "Transferir para fila" no diálogo de transferência

Terceira aba no `ReassignDialog`: `Atendente` · `Número` · **`Fila`**, para `agent` em diante — mesma
régua do `PUT /conversations/[id]/sector` (papel mínimo `agent`). Escolher fila grava o setor
(`PUT /conversations/[id]/sector`) e, num segundo passo explícito, **libera o responsável**
(`release`) — as duas rotas já existem e já auditam (`conversation.sector_changed`,
`conversation.released`). O motivo continua sendo campo único para as três abas.

**Decidido (resposta 2): ao transferir para a fila, a pessoa sai por padrão, com um interruptor para
ficar.** O motivo é o `claim`: ele só vence quando a conversa está sem pessoa
(`app/api/v1/conversations/[id]/claim/route.ts`), então, se quem transferiu continuasse responsável,
a próxima pedagoga não assumiria com um clique e o caso da escola não se resolveria. O interruptor só
existe quando a conversa está com quem transfere — o `release` recusa quem não é o responsável
atual —, e conversa que já estava sem pessoa volta para a distribuição ao mudar de fila. É o que o
#4953 implementa.

Isso resolve o caso da escola em **um gesto**: Secretaria atendeu, pai pediu Pedagogia → transferir
para a fila Pedagogia; a próxima pedagoga disponível assume.

### D4 — Rodízio dentro da fila (já existe desde o #3817)

**Esta decisão já está na `main`:** `lib/routing/eligibles.ts`, no ramo `scope.kind === "sector"`
(migração 9062, PR #3817), faz exatamente a interseção descrita abaixo — e a pergunta 3 ficou
respondida pelo código, do jeito que este texto propunha. Fica registrada aqui como parte do desenho.

Com fila definida na conversa, os elegíveis são **membros do setor** ∩ abertura ∩ disponibilidade ∩
folga (o mesmo `loadEligibleAttendants` de hoje). `channel_routing_responsibles` continua valendo
como **subconjunto explícito** — quem está na lista do canal e no setor recebe; quem só está na
lista do canal não recebe conversa de fila.

### D5 — Privacidade por setor: usar o modo que já existe, sem inventar permissão

`own_and_sector` (migração 9214, #4022) já entrega a resposta para "usuários de um setor não veem as
mensagens de outro": o atendente vê o que é dele **e** o que é do setor dele, e mais nada; gestor
(viewer/manager/admin) continua org-wide. **Esta ADR não cria modo novo.**

O que falta não é permissão — é o par dela:

1. a dependência medida acima (sem setor e sem dono ⇒ invisível para atendente), que **D1 fecha** ao
   dar fila de entrada a toda conversa nova;
2. a tela de Distribuição passa a dizer o que o modo faz, inclusive esse caso — hoje o texto do
   "Atendente só vê o setor" não menciona a conversa órfã;
3. **Decidido (resposta 3): a restrição continua valendo só por organização, por agora**, como os
   outros modos. A opção por **setor** (`attendant_sectors.restrito`, um setor fechado e outro aberto
   na mesma empresa) é mais uma regra de quem vê o quê, e ninguém pediu ainda; se pedirem, vira
   pedido próprio.

### D6 — (fora desta ADR) fila padrão por pessoa

O Zendesk tem *default group por agente*. Aqui isso vira `user_organizations` → setor padrão, útil
para orientar o "Assumir" de quem está em três setores. **Decidido (resposta 4): fica só anotado**,
sem fatia nem implementação prevista.

## Quem pode o quê

| Gesto | viewer | agent | manager | admin |
|---|---|---|---|---|
| Assumir conversa da **sua** fila | — | ✅ | ✅ | ✅ |
| Devolver para a fila (release) | — | ✅ | ✅ | ✅ |
| **Mover a conversa para qualquer fila** | — | ✅ | ✅ | ✅ |
| Definir a **fila de entrada** do canal | — | — | — | ✅ |
| Transferir a conversa para outra pessoa | — | ✅ | ✅ | ✅ |
| Ver conversas dos setores a que **pertence** (N:N) | — | ✅ | ✅ | ✅ |
| Ver conversas de setor em que **não** é membro | — | — | ✅ (org-wide) | ✅ |

Nenhuma linha desta tabela muda permissão: transferir para pessoa já é `agent`
(`POST /api/v1/conversations/[id]/transfer`, `requireRole("agent")`), e mover de fila também
(`PUT /conversations/[id]/sector`). A única linha nova é a fila de entrada do canal, que é
configuração e fica com `admin`, como o resto da tela de Distribuição.

Leitura: quanto mais a fila vira dono, mais o "assumir/devolver" é do atendente, e o "classificar" —
qual fila recebe o quê na entrada — passa a ter dono na administração. Hoje qualquer `agent` move a
fila pelo ⋯, e isso continua; o que falta é alguém definir a fila de entrada, e o multi-setor não muda
nada porque a fila nunca foi dono.

Quem pertence a vários setores vê e assume em todos eles — e pode mover a conversa para qualquer
fila, como já pode transferir para qualquer colega. A diferença que a fila como dono introduz não é
de permissão, é de **registro**: a passagem fica no histórico como troca de fila, com autor e
motivo, em vez de sumir num acordo entre duas pessoas.

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

**Decidido (resposta 4): um pedido por parte**, cada um com a sua própria medição.

| Fatia | Entrega | Muda política? | Onde está |
|---|---|---|---|
| **1** | `ReassignDialog` com aba **Fila** (setor + liberar responsável) e o cabeçalho mostrando `Fila: Pedagogia · sem responsável` | não — usa rotas existentes | PR #4953 |
| **2** | `channel_routing_policies.sector_id` + tela de Distribuição + claim por fila + invariante de banco (o rodízio por fila já existe, D4) | sim, opt-in | pedido próprio, com migração e prova pela tela |
| **3** | texto e guarda do `own_and_sector` (9214 já implementado): aviso da conversa órfã | sim, opt-in | pedido próprio; a opção por setor fica de fora (resposta 3) |
| **4** | Fila padrão por pessoa (D6) | opt-in | só anotada |

A fatia 1 é a que fecha a dor relatada e não decide nada no núcleo; as fatias 2 e 3 são as que
mexem em **disparo e fila** — e por isso estão aqui como decisão, não como código.

## Respostas do mantenedor (26/11/2026)

As seis perguntas que esta ADR fazia, com o que as respondeu:

1. **Dono-fila sem coluna nova** — `assigned_to_user_id IS NULL` + `sector_id` preenchido basta, ou
   um `owner_kind` explícito? **Basta; sem coluna nova** (resposta 1, em D2).
2. **Transferir para fila** — o responsável anterior fica ou sai? **Sai por padrão, com interruptor
   para ficar** (resposta 2, em D3). E o atendente move para **qualquer** fila: **sim**, já decidido
   na aprovação do #3817.
3. **Rodízio** — `channel_routing_responsibles` vira subconjunto da fila? **Sim, e já é assim na
   `main`** desde o #3817 (D4).
4. **Privacidade** — opção **por setor** ou só o modo da organização? **Só o da organização, por
   agora** (resposta 3, em D5).
5. **Nome de produto** — **Setor** continua, já decidido na aprovação do #3817.
6. **Escopo** — fatiamento ou fatia única? **Um pedido por parte** (resposta 4, em §Fatiamento).

## O que este ADR NÃO propõe

- Não muda `GRANT`, RLS de outra tabela, nem permissão de papel.
- Não altera o comportamento de nenhuma conversa existente: toda coluna nova é nullable e toda
  mudança de leitura é por configuração.
- Não substitui o módulo `setores`; ele continua opcional e desligado por padrão.
