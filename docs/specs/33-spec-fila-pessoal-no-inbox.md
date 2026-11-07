# Spec 33 — Fila "Pessoal": esconder da operação sem tornar o contato inalcançável

> Doutrina: [`sistema-vivo.md`](../doctrine/sistema-vivo.md) (invariantes 3, 4 e 7: log visível, nada fora do radar, todo laço se fecha).
>
> Revisa a [spec 21](./21-spec-conversa-pessoal-sai-da-operacao.md) — **§2 decisão 3**, **§3.3** e **§5 (fora de escopo)** ficam superados por esta spec. O resto da spec 21 continua valendo, inteiro.
> Decisão do dono da instalação, 06/11/2026: _comunicação chega por um canal só — e nenhum contato fica inalcançável por decisão interna._

---

## 1. O problema

A spec 21 resolveu um problema real: quem usa o mesmo número para vender e para viver entregava os dois
mundos para a mesma operação — IA assumindo conversa de família, funil ganhando card que nunca foi
oportunidade, inbox misturando trabalho com vida.

A solução foi **esconder o pessoal de tudo**. E, junto com o esconder, veio um efeito que nunca foi
pedido: o contato pessoal ficou **inutilizável dentro do CRM** — nem lista, nem busca, nem contagem, nem
**envio**, em nenhum papel, nem manual, nem de gerente, nem de dono.

Duas coisas diferentes foram implementadas como uma só:

|                          | o que é                                                                     | quem decide | deve continuar?             |
| ------------------------ | --------------------------------------------------------------------------- | ----------- | --------------------------- |
| **esconder da operação** | funil, IA, campanha, follow-up, métricas, RAG, busca da equipe, badges, MCP | a operação  | **sim, inalterado**         |
| **tornar inalcançável**  | nenhum caminho humano lê ou responde aquele contato                         | a operação  | **não** — isso é do titular |

O efeito prático: marcar um familiar como pessoal **fecha a conversa e solta do atendente** (é o que tira
da operação), e a partir daí não há tela, link, aba ou botão que permita responder aquela pessoa pelo CRM.
Quem quer falar com a mãe precisa de outro aparelho — o que é exatamente o que o CRM deveria evitar.

### Por que isto é retenção, não conveniência

Nas instalações pequenas o dono usa o mesmo número para vender e para viver — e usa o CRM **como o
WhatsApp dele**. Quando o sistema diz "este contato você não responde por aqui", a resposta dele não é
abrir uma exceção: é abrir o WhatsApp Web ao lado (ou voltar para o celular) e, com o tempo, trocar de
ferramenta. Ele não perde uma aba; perde o motivo de manter a operação dentro do CRM.

Ou seja: tornar o pessoal inalcançável não protege a operação — **expulsa o usuário dela**. A separação
que a spec 21 queria continua de pé (o pessoal não contamina nada); o que sai é o efeito colateral que
nunca foi pedido e que custa cliente.

### Medido no código (base `origin/main`, 06/11/2026)

| fato                                                          | onde                                                                    |
| ------------------------------------------------------------- | ----------------------------------------------------------------------- |
| a lista subtrai os ids pessoais ANTES de todo filtro opcional | `app/api/v1/conversations/_handler.ts` (`.not("contact_id","in", …)`)   |
| a busca fixa `is_personal = false` em nome, telefone e prévia | mesma `_handler.ts`                                                     |
| a contagem nasce da mesma exclusão                            | `app/api/v1/conversations/counts/route.ts` (`countExact`)               |
| o link direto responde 404                                    | `getConversationHandler`                                                |
| o envio recusa **tudo**, sem exceção de papel                 | `app/api/v1/messages/_handler.ts` (`403 Contato marcado como pessoal.`) |
| o push de entrada pessoal é cortado na origem                 | `lib/notifications/push.handler.ts`                                     |
| as abas do Inbox são seis — não há "Pessoal"                  | `components/inbox/InboxFilters.tsx` (`INBOX_TABS`)                      |
| marcar fecha as conversas e solta do atendente                | `app/api/v1/contacts/[id]/personal/route.ts` (efeito 6)                 |
| a marca é da ORGANIZAÇÃO: não há registro de quem marcou      | `contacts.is_personal`, sem coluna de dono                              |
| o único caminho que lista pessoal é a lista de Contatos       | `app/api/v1/contacts/_handler.ts` (`?pessoais=true`)                    |

---

## 2. Decisões

> Decididas em 06/11/2026 pelo dono da instalação. Não se reabre sem ele.

| #     | decisão                                                  | consequência                                                                                                                                                               |
| ----- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1** | **esconder da operação continua valendo, inteiro**       | IA, automação, campanha, follow-up, funil, RAG, métricas, webhook, distribuição, busca da equipe e badges seguem sem pessoal. Os cortes da spec 21 §3.4/§3.5 não se tocam. |
| **2** | **nenhum contato fica inalcançável por decisão interna** | o único veto de envio que o CRM mantém por conta própria é o do **titular** (`is_blocked`, STOP/descadastro). `is_personal` nunca mais se comporta como bloqueio.          |
| **3** | **quem responde é uma PESSOA, na conversa dela**         | IA, automação, `api_token` (MCP) e `ai_agent` continuam recusados. O MCP **não** ganha acesso a pessoal: a spec 21 §6.1 permanece.                                         |
| **4** | **o pessoal tem dono**                                   | nova coluna `contacts.personal_owner_user_id`; marca quem marcou. Sem ela, a aba só existiria publicando a conversa de família de um gerente para os outros.               |
| **5** | **`admin` enxerga todo pessoal**                         | garante a decisão 2 quando o dono sai de férias, é desligado ou perde acesso. `manager` vê só o próprio.                                                                   |
| **6** | **marcar continua fechando a conversa**                  | fechar é o que tira da operação; a aba Pessoal lista **sem filtro de status**, então conversa fechada aparece lá normalmente.                                              |
| **7** | **discrição preservada**                                 | push e alerta de operação continuam cortados para pessoal. O aviso é o badge da própria aba. Notificação com prévia é assunto separado (fora de escopo).                   |

---

## 3. O que muda, por camada

### 3.1 Banco (migration `9238`)

- `contacts.personal_owner_user_id uuid references auth.users(id) on delete set null`
- índice parcial `(organization_id, personal_owner_user_id) where is_personal`
- apêndice idempotente no `supabase/baseline.sql` (`pnpm test:db` sobe só o baseline)
- `on delete set null`: usuário removido não apaga contato nem histórico; a linha fica órfã (`null`) e
  volta a aparecer para o `admin`. **Preenchida só pela rota de marcar**, com quem marcou; `DELETE` zera.

### 3.2 Contrato

| rota                                  | antes                   | depois                                                                         |
| ------------------------------------- | ----------------------- | ------------------------------------------------------------------------------ |
| `GET /api/v1/conversations`           | pessoal sempre fora     | `?pessoais=true` **inverte**: só o pessoal visível ao ator, em qualquer status |
| `GET /api/v1/conversations/[id]`      | 404 para pessoal        | 404 só para **quem não é dono** (mesma mensagem, sem revelar existência)       |
| `GET /api/v1/conversations/counts`    | 6 contagens sem pessoal | + `pessoal`, com o **mesmo conjunto** da aba; as outras 6 seguem sem pessoal   |
| `POST /api/v1/messages`               | 403 para pessoal        | 403 só para origem não-humana e para quem não é dono/admin                     |
| `POST/DELETE /contacts/[id]/personal` | marca/desmarca          | grava/limpa o dono; quem marca um legado **adota**                             |

A régua do envio usa o que o repo já tinha: `origemDaMensagem(actor)` devolve `user | ai | automation |
system`. Não há parâmetro novo, e não é falsificável pela tela.

### 3.3 Tela

- aba **Pessoal** no fim da faixa do Inbox (depois de "Arquivadas": é o fora-da-operação);
- `visibleInboxTabs` a esconde de `agent` — a mesma régua de quem pode marcar (`manager`+);
- `tabToFilter("pessoal") → { pessoais: true }`, com deep-link `?filter=pessoal`;
- badge próprio, alimentado pela contagem `pessoal`;
- busca funciona **dentro** da aba (procurar "Mãe" tem de achar) — e só dentro dela.

---

## 4. Invariantes preservados (o que este PR NÃO reabre)

1. IA não responde, não sugere, não resume e não pontua conversa pessoal.
2. Campanha, prospecção, follow-up e distribuição nunca incluem contato pessoal.
3. Funil, relatórios, métricas e webhooks não contam pessoal.
4. RAG não ingere conversa pessoal.
5. MCP (`crm_*`) não lê nem escreve pessoal — ator `api_token`/`ai_agent` é recusado por `podeVerPessoal`.
6. Push e alertas de operação continuam cortados.
7. Isolamento entre organizações continua valendo em toda query nova.

## 5. Fora de escopo

- Sincronizar com o celular, ler o WhatsApp pessoal, apagar ou bloquear no WhatsApp.
- Notificação de pessoal com prévia de mensagem (opt-in futuro; hoje o aviso é o badge).
- Compartilhar o pessoal entre usuários ("ver o pessoal do colega") — só `admin`, pela decisão 5.
- Regra automática para adivinhar quem é pessoal (continua proibida, spec 21 §5).
- Devolver para a operação em um clique (desmarcar + reabrir + atribuir) — hoje é desmarcar na ficha.

## 6. Prova

`tests/unit/fila-pessoal-no-inbox.test.ts` cobre a régua (`podeVerPessoal`), a inversão da lista, a
contagem, o envio, a tela e a migration. As catracas da spec 21 (`contato-pessoal-*.test`) continuam
verdes e foram **reforçadas**: a de busca agora exige que as duas pontas usem o mesmo `querPessoal`, em vez
de fixar `false`.
