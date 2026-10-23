# Prospecção: escolher quando a saída ("responda PARAR") é oferecida

> Spec de design + plano de implementação. Medido em `origin/main` = `e593c58b0` (19/10/2026).
> Destino: **núcleo** (é um modo da prospecção nativa, que é núcleo; sem ninguém mexer, nada muda).

> **Nota da triagem (20/10/2026).** Esta spec é do autor e fica como ele a escreveu; duas partes
> dela NÃO viraram código, e estão marcadas no lugar:
>
> - **Modo da 3ª mensagem (`third_message`)** — **[removido por decisão do mantenedor (doc 170 = B, 20/10): só 1ª e 2ª]**. Motivo: no
>   modo da 3ª, até duas mensagens a um desconhecido saem sem a saída (inclusive um follow-up a quem
>   não respondeu), e a única coisa que segura a oferta nelas é a instrução ao modelo (§12). Marcado
>   em §1, §3, §4.2, §4.3, §6, §8 e §10–§11.
> - **Modo desligado (`off`, "não oferecer nunca", com aceite de risco)** — **[não implementado neste PR; depende de decisão do mantenedor]**.
>   O autor o anunciou para um pedido separado. Marcado em §1, §2.3, §3, §4.1, §4.2, §4.3, §5, §6, §7, §8, §10 e §11.

## 1. O problema

Hoje toda primeira mensagem da prospecção sai com a saída colada no fim, sem opção:

```
Oi, tudo bem? Aqui é da Padaria Central?

Se não quiser mais receber mensagens, responda PARAR.
```

Quem monta isso é `comSaida()` (`lib/prospecting/rodape-de-saida.ts`), chamado em um único lugar,
`lib/prospecting/worker.ts:291` (`body: comSaida(generated.texto, locale)`), e vigiado por
`tests/unit/prospeccao-oferece-saida-e-a-saida-funciona.test.ts`.

A frase certa no momento certo depende da **estratégia de abordagem** de quem prospecta, e o
produto hoje só conhece uma. Três estratégias reais:

1. **Abertura direta com oferta** — a primeira mensagem já apresenta o serviço. A saída tem de ir
   nela. É o comportamento de hoje, e continua o padrão.
2. **Abertura em degraus** — a primeira só cumprimenta e confirma o contato ("oi, tudo bem? é da
   [empresa]?"); a segunda (ou a terceira — **[removido por decisão do mantenedor (doc 170 = B, 20/10): só 1ª e 2ª]**) apresenta quem fala e pede permissão; a oferta vem
   depois. Para quem prospecta por WhatsApp não oficial (WAHA), a primeira mensagem é a de maior
   risco: um "responda PARAR" na primeira linha faz a mensagem **parecer disparo em massa**, e a
   experiência de operação (relato de uso real, não medido no produto) é que a abertura humana e
   curta recebe resposta — e a resposta da pessoa é o que mais protege o número.
3. **[não implementado neste PR; depende de decisão do mantenedor]** **Sem frase de saída** — o operador conduz a conversa de modo que pedir para parar seja natural
   (ou atende um público em que a frase atrapalha) e assume o risco. Hoje isso é impossível sem
   editar código.

## 2. O que não muda, em nenhum modo

1. **O bloqueio por "PARAR" vale desde a primeira mensagem, nos três modos — inclusive no
   desligado.** Ele não depende do rodapé: a ingestão (`lib/channels/pos-entrada.ts`,
   `ehPedidoDeOptOut` de `lib/opt-out/deteccao.ts`) roda em **toda** mensagem recebida. Quem
   responder "PARAR" ou "pare de me mandar mensagem" é bloqueado igual a hoje. O que se escolhe é
   **se e quando o produto oferece a palavra**, nunca se ela funciona.
2. **O padrão é a saída na primeira mensagem.** Configuração gravada antes desta chave existir
   segue igual, sem ninguém editar nada (`.default()` no Zod).
3. **[não implementado neste PR; depende de decisão do mantenedor]** **Desligar exige uma pessoa que aceite o risco por escrito, e fica registrado.** Iniciar
   campanha já é só de `admin` e só pela tela — por token é recusado
   (`app/api/v1/prospecting/route.ts:120-125`). O aceite grava quem e quando, entra em
   `api_audit_log` e aparece no painel da campanha enquanto ela existir.
4. **Antes da saída, nada de oferta.** Nos modos atrasados, o worker acrescenta à instrução fixa da
   abertura que ela **não apresenta serviço, preço nem proposta** — só cumprimenta e confirma se
   falou com a empresa certa; e o contexto do agente diz o mesmo para as mensagens anteriores à que
   leva a saída. É isso que torna o atraso defensável: as mensagens sem saída não são comerciais; a
   primeira comercial leva a saída. **Limite declarado:** nas respostas do agente isso é instrução
   de prompt, não trava mecânica (ver §12).

## 3. Comportamento

Configuração nova da campanha: `exit_offer`.

| valor | na tela | onde vai a saída |
|---|---|---|
| `first_message` (**padrão**) | "Na primeira mensagem (recomendado)" | na abertura — **igual a hoje** |
| `second_message` | "Atrasar para a 2ª mensagem" | na 2ª mensagem automática para aquela pessoa |
| `third_message` | "Atrasar para a 3ª mensagem" | na 3ª mensagem automática para aquela pessoa — **[removido por decisão do mantenedor (doc 170 = B, 20/10): só 1ª e 2ª]** |
| `off` | "Não oferecer (eu assumo o risco)" | em nenhuma; exige o aceite da §6 — **[não implementado neste PR; depende de decisão do mantenedor]** |

**Como se conta "mensagem".** A abertura é a 1ª. Conta como mensagem automática cada envio que sai
por um destes dois caminhos — **um envio, não uma bolha** (uma resposta fatiada em três bolhas é
uma mensagem):

- **o agente respondendo a pessoa** (`send_message` em `lib/agent-engine/agent/inbound-turn.ts`);
- **um follow-up automático** (`lib/agent-engine/agent/followup-turn.ts`) — o caso em que a pessoa
  **não** respondeu e o operador ligou um follow-up na etapa. Sem contá-lo, a 2ª mensagem a quem
  nunca respondeu sairia sem saída, que é o caso de maior risco.

A saída vai na mensagem cujo número **chega ou passa** do alvo e ainda não a levou (`>=`, não `=`):
se a mensagem do alvo não podia levá-la (ver casos de borda), a seguinte leva. Uma vez só.

Regra que resume os modos atrasados: **nenhuma mensagem automática depois do alvo sai sem a saída
já ter sido oferecida.**

A saída é a mesma de hoje (`rodapeDeSaida(locale)`: PARAR / BAJA / STOP pelo idioma da
organização), colada no fim do texto pelo mesmo `comSaida()` — determinística, nunca escrita pelo
modelo (as duas razões estão no cabeçalho de `rodape-de-saida.ts` e continuam valendo).

### Casos de borda (decididos)

| caso | o que acontece |
|---|---|
| a pessoa responde "PARAR" a qualquer mensagem, em qualquer modo | bloqueada pela ingestão, como hoje; não sai mais nada |
| o agente manda 2 mensagens no mesmo turno | cada uma conta; a saída vai na que atinge o alvo, uma vez só (reserva atômica, §4.2) |
| a resposta sai em várias bolhas | a saída é colada antes do fatiamento (`sendInBubbles`): vai no fim do texto, na última bolha |
| o guardrail veta a mensagem do agente | não conta nem reserva: a contagem só acontece dentro do `send`, depois da cadeia aprovar |
| o envio falha depois de contar | a contagem e a reserva são desfeitas |
| um atendente responde pelo Inbox | **não conta** e o produto não escreve na mensagem do humano. A tela mostra "Saída ainda não oferecida" para quem assumiu (§6) |
| aviso de escalação ao lead (`aviso-de-escalacao.ts`) | não conta nem leva (aviso operacional, não abordagem) |
| follow-up por modelo oficial da Meta (`template`) | não conta nem leva: o corpo do modelo aprovado não se altera. A prospecção hoje sai por texto (`type: "text"` no worker) |
| agente em modo assistido (`approved-reply.ts`) | não conta nem leva: o texto aprovado não pode mudar depois da aprovação (`reply_body_changed_reapproval_required`). O worker já exige `operation_mode='automatic'` para abordar |
| o modelo já escreveu "responda PARAR" no fim | `comSaida()` é idempotente: não duplica |
| modo `off` **[não implementado neste PR; depende de decisão do mantenedor]** | nada é contado para a saída; o contexto do agente não ganha a frase do sistema, mas segue com "respeite recusa e opt-out" (`context.ts`, hoje) |
| campanha antiga, sem a chave | `first_message` — nada muda |

## 4. Dados

### 4.1 Configuração da campanha (sem migration)

> No código entrou só `z.enum(["first_message", "second_message"])`: `third_message` **[removido por decisão do mantenedor (doc 170 = B, 20/10): só 1ª e 2ª]**; `off`,
> `exit_offer_risk_accepted` e os campos `_by`/`_at` **[não implementado neste PR; depende de decisão do mantenedor]**.

`prospecting_campaigns.config` é `jsonb` validado por `campaignConfigSchema`
(`lib/prospecting/schema.ts`). Acrescenta-se:

```ts
// QUANDO a saída ("responda PARAR") é oferecida — depende da estratégia de abordagem.
// `first_message`: na abertura (o padrão, o de sempre). `second_message`/`third_message`: as
// mensagens antes dela não fazem oferta. `off`: nunca — só com o aceite de risco abaixo.
// Em TODOS os modos a palavra continua bloqueando (lib/channels/pos-entrada.ts).
exit_offer: z.enum(["first_message", "second_message", "third_message", "off"]).default("first_message"),
// Obrigatório e `true` quando `exit_offer = "off"`; proibido nos outros (refine).
exit_offer_risk_accepted: z.literal(true).optional(),
```

E, gravados **pelo servidor** no `start` (nunca aceitos do corpo — o `.strict()` recusa):
`exit_offer_risk_accepted_by` (`auth.actor.id`, sempre um usuário, porque `start` por token é
recusado) e `exit_offer_risk_accepted_at`. O corpo só diz "aceito"; quem aceitou sai da sessão.

A configuração não se edita depois de iniciada (só `adjust_pace` existe), então o modo é fixo por
campanha — trocar no meio deixaria parte da fila com uma promessa e parte com outra.

### 4.2 Contagem e reserva (migration)

Duas colunas novas em `prospecting_candidates`:

```sql
alter table public.prospecting_candidates
  add column if not exists automatic_sends smallint not null default 0,
  add column if not exists exit_offered_at timestamptz;
```

Por que colunas e não inferência pelas mensagens: contar outbound na tabela `messages` conta bolha
como mensagem e mistura o humano do Inbox; procurar o texto do rodapé depende de redação. As
colunas são a **reserva** que torna "uma vez só" segura contra dois turnos ou duas chamadas
concorrentes. A contagem e a reserva acontecem num único `update` atômico:

```sql
-- contar este envio e, se for a vez, reservar a saída (devolve se ESTE envio leva a saída)
update public.prospecting_candidates p
   set automatic_sends = p.automatic_sends + 1,
       exit_offered_at = case
         when p.exit_offered_at is null
          and p.automatic_sends + 1 >= (case c.config->>'exit_offer'
                                          when 'second_message' then 2
                                          when 'third_message'  then 3 end)
         then now() else p.exit_offered_at end,
       updated_at = now()
  from public.prospecting_campaigns c
 where p.organization_id = $1 and p.conversation_id = $2
   and p.status in ('sending','sent')
   and c.organization_id = p.organization_id and c.id = p.campaign_id
   and c.config->>'exit_offer' in ('second_message','third_message')
returning p.id, p.campaign_id, p.exit_offered_at,
          (p.exit_offered_at = now()) as leva_a_saida;

-- desfazer (envio falhou): devolve a contagem e, se ESTE envio tinha reservado, a reserva
update public.prospecting_candidates
   set automatic_sends = greatest(automatic_sends - 1, 0),
       exit_offered_at = case when exit_offered_at = $3 then null else exit_offered_at end
 where organization_id = $1 and id = $2;
```

> `when 'third_message' then 3` e o `'third_message'` do filtro **[removido por decisão do mantenedor (doc 170 = B, 20/10): só 1ª e 2ª]**:
> no código o filtro é `c.config->>'exit_offer' = 'second_message'`.

(`now()` é o mesmo instante dentro da transação, por isso `exit_offered_at = now()` identifica a
reserva feita por este `update`; a implementação pode devolver um booleano calculado antes, se a
triagem preferir não depender disso.)

No modo `first_message` o worker grava `automatic_sends = 1` e `exit_offered_at = now()` junto do
`status='sent'`; nos atrasados e no `off` (**[não implementado neste PR; depende de decisão do mantenedor]**), só `automatic_sends = 1`. A tela diz a mesma coisa em
todos. **Sem backfill:** linhas antigas ficam `0`/`null` porque o produto não sabe se elas levaram
o rodapé; afirmar que levaram seria inventar sinal que o banco não guarda. O `update` de contagem
filtra pelo modo da campanha, então linha antiga nunca é tocada (campanha antiga é
`first_message`).

O filtro `status in ('sending','sent')` é o mesmo de `prospectingConversationContext`
(`lib/prospecting/context.ts`). O índice que serve a busca já existe
(`prospecting_conversation (organization_id, conversation_id)`).

**Isolamento:** as consultas filtram `organization_id` vindo da linha do job / da campanha (fonte
confiável), nunca de corpo de requisição. Nenhuma policy nova: as colunas entram numa tabela que já
tem RLS.

### 4.3 Tripla da migration

- `supabase/migrations/<timestamp>_<NNNN>_prospeccao_saida_configuravel.sql` com
  `-- manifest: prospecting_candidates.automatic_sends + exit_offered_at — saída da prospecção na 1ª, 2ª, 3ª mensagem ou desligada`.
  (No código: "na 1ª ou na 2ª mensagem" — 3ª **[removido por decisão do mantenedor (doc 170 = B, 20/10): só 1ª e 2ª]**; desligada **[não implementado neste PR; depende de decisão do mantenedor]**.)
  **Número:** o maior `NNNN` da `main` medido hoje é `0703`; o número real se tira na hora com
  `pnpm checar:colisao-de-migration` (há PRs de schema em voo).
- Apêndice idempotente no fim de `supabase/baseline.sql`:
  `-- ---- prospecção: saída configurável (migration NNNN) ----` + os mesmos `add column if not exists`.
  `not null default 0` em `add column` preenche as linhas existentes sem passo de dados.
- Nenhuma função nova em `public` (as consultas são SQL parametrizado no código), então a regra 9
  de revogar `EXECUTE` não se aplica.

## 5. Código — pontos medidos

| arquivo | mudança |
|---|---|
| `lib/prospecting/schema.ts` | `exit_offer` + `exit_offer_risk_accepted` com `superRefine` (§4.1) — o aceite e o `superRefine` **[não implementado neste PR; depende de decisão do mantenedor]** |
| `lib/prospecting/rodape-de-saida.ts` | funções iguais; o cabeçalho ganha um parágrafo sobre os modos e por que desligar exige aceite registrado |
| `lib/prospecting/saida-configuravel.ts` (novo) | `contarEnvioAutomatico(db, org, conversationId)` → `{ candidatoId, campanhaId, levaASaida, reservadaEm, locale } \| null` e `desfazerContagem(db, org, candidatoId, reservadaEm)`. Lê `organizations.locale` (mesma fonte do worker) |
| `lib/prospecting/worker.ts` | `body`: `comSaida(...)` só em `first_message`; nos atrasados, a instrução fixa ganha a frase da §2.4; grava `automatic_sends`/`exit_offered_at` (§4.2) |
| `lib/prospecting/store.ts` **[não implementado neste PR; depende de decisão do mantenedor]** | no `start`: com `exit_offer = "off"`, grava `exit_offer_risk_accepted_by/_at` a partir do ator e emite a auditoria `prospecting.exit_offer_disabled` |
| `lib/prospecting/context.ts` | modos atrasados com a saída pendente: "Antes da mensagem que leva a instrução de saída, não apresente serviço, preço nem proposta: apresente-se e peça permissão. O sistema acrescenta a instrução de saída sozinho; não a escreva." |
| `lib/agent-engine/agent/inbound-turn.ts` | no `send: (finalBody) => …` do `send_message` (hoje ~linha 3660): fora de prévia, `contarEnvioAutomatico` → se `levaASaida`, `finalBody = comSaida(finalBody, locale)` antes de `corposEnviados.push` e do `enviarComFotos`; se o envio lançar ou não confirmar, `desfazerContagem` |
| `lib/agent-engine/agent/followup-turn.ts` | no `send: (finalBody) => channel.send(…)` (~linha 1221), o mesmo, **pulando** quando `modelo !== undefined` (template) |
| `app/api/v1/prospecting/route.ts` | o `select` dos candidatos traz `p.automatic_sends`, `p.exit_offered_at` e `ct.is_blocked` (join em `contacts` pelo `contact_id`, com `organization_id`) |
| `app/app/prospecting/_client.tsx` | §6 |
| `lib/audit/actions.ts` | `prospecting.exit_offered` e `prospecting.exit_offer_disabled` (este **[não implementado neste PR; depende de decisão do mantenedor]**) |
| `lib/i18n/dicionario.ts` | as strings novas da tela, com `es` |

**Custo dentro do lock do número:** o `send` do `inbound-turn` roda com o
`pg_advisory_xact_lock` do canal na mão (issue #654). A contagem acrescenta **um** `update`
indexado ali — em conversa de prospecção em modo atrasado ele acha a linha; nas outras, não acha
nada. Alternativa, se a triagem preferir: contar em `esperaForaDoLock` e desfazer no veto. A spec
fica com o `send` por ser o único ponto em que "vai sair" é verdade.

**Relação com o PR #2680** (@webtecnica, aberto, mexe em `worker.ts` e no mesmo teste-cerca: o
corpo da abertura passa a sair em bolhas, `const corpo = comSaida(generated.texto, locale)`). As
duas mudanças são compatíveis — a deste PR vira
`const corpo = cfg.exit_offer === "first_message" ? comSaida(…) : generated.texto`. Quem entrar
depois resolve o conflito lendo os dois lados; não reescrever o trabalho dele.

## 6. Tela

Em **Prospecção › 2. Preparar a abordagem**, logo abaixo de "Quando a empresa entra no funil", um
`fieldset` "Quando oferecer a opção de parar de receber", com o mesmo desenho (rádios), nascendo
marcado em **Na primeira mensagem**:

- **Na primeira mensagem (recomendado)** — "A abertura já diz como parar: Se não quiser mais
  receber mensagens, responda PARAR." A frase depois dos dois-pontos é `rodapeDeSaida()` no
  idioma da ORGANIZAÇÃO (`organizations.locale`, o mesmo do envio), nunca no da interface.
- **Atrasar para a 2ª mensagem** — "A abertura só cumprimenta e confirma se é a empresa certa, sem
  oferta. A instrução para parar vai na mensagem seguinte."
- **[removido por decisão do mantenedor (doc 170 = B, 20/10): só 1ª e 2ª]** **Atrasar para a 3ª mensagem** — "As duas primeiras mensagens não fazem oferta: cumprimentar,
  depois apresentar-se e pedir permissão. A instrução para parar vai na terceira."
- **[não implementado neste PR; depende de decisão do mantenedor]** **Não oferecer** — ao marcar, abre uma caixa de aviso (cor de alerta, não de erro):

  > **Você está desligando a instrução para parar de receber.** Sem ela, quem não quer as suas
  > mensagens costuma usar **Denunciar spam** no WhatsApp — o sistema não fica sabendo, e denúncias
  > levam ao bloqueio do número desta conexão. Responder PARAR continua bloqueando o contato, mas a
  > pessoa não vai saber disso. Esta escolha fica registrada em seu nome.
  >
  > ☐ Entendo o risco e quero iniciar sem oferecer a opção de parar.

  O botão de iniciar fica desabilitado até a caixa ser marcada; o servidor recusa `off` sem
  `exit_offer_risk_accepted: true` (422), então a regra não depende da tela.

Nos dois modos atrasados, um exemplo aparece abaixo do campo de instrução (texto de ajuda, não
preenchido sozinho), p. ex. para a 2ª: "Na primeira mensagem, só cumprimente e pergunte se é da
empresa. Quando a pessoa responder, apresente-se e peça permissão para mostrar o serviço."

No painel da campanha:

- ao lado de "Responderam", um número novo **"Pediram para parar"** (`is_blocked` dos contatos da
  campanha);
- o modo escolhido, por extenso; no `off` (**[não implementado neste PR; depende de decisão do mantenedor]**), "Sem opção de parar — risco aceito por <nome> em
  <data>";
- na linha de cada empresa abordada nos modos atrasados: "Saída oferecida" / "Saída ainda não
  oferecida".

## 7. Living System Checklist

1. **Quem me alimenta?** O administrador, pelo rádio em `/app/prospecting` → `config.exit_offer`;
   a contagem é alimentada pelos dois caminhos de envio automático (`inbound-turn`,
   `followup-turn`).
2. **Quem eu alimento?** `comSaida()` → o corpo que vai ao canal; `exit_offered_at` → a tela da
   campanha e o contexto do agente (`context.ts`).
3. **Que registro emito?** Em `api_audit_log`: `prospecting.exit_offered` (metadata `campaign_id`,
   `candidate_id`, `conversation_id`, `message_number`, `via: inbound_turn | followup`; sem texto
   nem telefone, como o `prospecting.approach_sent`) e `prospecting.exit_offer_disabled` no início
   da campanha em `off` (ator = quem aceitou) — este **[não implementado neste PR; depende de decisão do mantenedor]**.
4. **Onde apareço na tela?** Na conversa do Inbox (a mensagem com a saída), no painel e nas linhas
   de `/app/prospecting` (§6).
5. **Por qual porta?** `/app/prospecting`, já no catálogo de navegação. Nenhuma tela nova.
6. **Anti-morte?** Nos atrasados, a saída pendente não morre: a reserva só se consome quando a
   mensagem sai, volta se o envio falha, e o `>=` faz a próxima levar se a do alvo não pôde. No
   `off` (**[não implementado neste PR; depende de decisão do mantenedor]**), nenhum — por escolha registrada do administrador.
7. **Onde se configura?** O rádio da §6, por campanha. Sem configuração = o padrão de hoje.
8. **Continuidade IA↔humano?** Quem assume vê na linha da empresa se a saída já foi oferecida e, no
   painel, se a campanha está em `off`; o agente vê no contexto que não deve fazer oferta antes da
   saída nem redigi-la.
9. **Laço de retorno?** "Pediram para parar" ao lado de "Responderam", por campanha: o
   administrador compara campanhas nos quatro modos e vê o efeito da estratégia. **Dívida
   declarada:** denúncia de spam e banimento não chegam ao sistema (o WhatsApp não avisa), então o
   laço mede o que dá para medir, não o risco inteiro.
10. **Mapa:** `docs/architecture/prospeccao-nativa.architecture.json` ganha a peça
    `saida-configuravel` com as arestas `inbound-turn → saida-configuravel`,
    `followup-turn → saida-configuravel`, `saida-configuravel → prospecting_candidates`.

## 8. Testes (e a sabotagem de cada um)

| teste | o que prova | sabotagem que tem de ficar vermelha |
|---|---|---|
| `tests/unit/prospeccao-oferece-saida-e-a-saida-funciona.test.ts` (atualizado) | `first_message` segue mandando `comSaida`; config antiga parseia como `first_message` | trocar o padrão do Zod |
| `lib/prospecting/schema` (casos novos) **[não implementado neste PR; depende de decisão do mantenedor]** | `off` sem aceite → recusado; aceite em modo não-`off` → recusado; `exit_offer_risk_accepted_by` no corpo → recusado (`.strict()`) | tirar o `superRefine` |
| `tests/unit/prospecting-worker.test.ts` (casos novos) | atrasados: corpo é o texto cru **e** a instrução tem a frase "sem oferta"; `off`: texto cru sem a frase; padrão: `exit_offered_at` gravado | tirar a frase da instrução; tirar o `comSaida` do ramo padrão |
| `lib/prospecting/saida-configuravel.test.ts` | 2ª: o 1º envio automático depois da abertura leva, o seguinte não; 3ª: só o 2º depois da abertura (**[removido por decisão do mantenedor (doc 170 = B, 20/10): só 1ª e 2ª]**); `>=` cobre o alvo que não pôde levar; desfazer devolve contagem e reserva; `first_message` e `off` não contam | trocar `>=` por `=`; remover `exit_offered_at is null` |
| `inbound-turn` (caso novo) | em conversa de prospecção na 2ª, a 1ª `send_message` sai com a saída e a 2ª do mesmo turno não; prévia não conta | **remover a chamada** em `inbound-turn.ts` (sabotar a ligação, não só o helper) |
| `followup-turn` (caso novo) | follow-up de texto conta e leva; de template não | remover a chamada em `followup-turn.ts` |
| `store`/rota (caso novo) **[não implementado neste PR; depende de decisão do mantenedor]** | `start` em `off` grava `_by` = ator da sessão e emite `prospecting.exit_offer_disabled` | gravar `_by` a partir do corpo |
| `tests/invariants/` (novo, `pnpm test:db`) | as colunas existem depois de install e update do baseline; o `update` de contagem com `organization_id` da org B não toca linha da org A | trocar `p.organization_id = $1` por nada |
| `tests/e2e/` (caso na spec de prospecção, se houver, ou spec nova em `SPECS_PARTE_N`) | o rádio nasce em "Na primeira mensagem"; "Não oferecer" sem marcar a caixa deixa o botão desabilitado; marcada, a campanha inicia e o painel mostra "risco aceito por" | — |

**Prova em par (o caminho passa por agente):** pela tela, uma campanha na 2ª com conexão de teste —
a abertura sai sem "PARAR", a pessoa responde "sim", a resposta do agente sai com "PARAR" no fim;
**e** `contarEnvioAutomatico` chamada direto para a mesma conversa devolve `levaASaida: false` (já
oferecida). Repetir para a 3ª (**[removido por decisão do mantenedor (doc 170 = B, 20/10): só 1ª e 2ª]**). Os dois lados têm de concordar.

## 9. Fora do escopo

- Escrever a saída em mensagem de humano no Inbox, ou contá-la.
- Trava mecânica (guardrail) contra oferta antes da saída — hoje é instrução de prompt (§12).
- Mudar a frase fixa da abertura no modo padrão ("os dados vieram de pesquisa pública…").
- Campanhas de envio em lote (`lib/campanhas/`), que têm regra própria de opt-out.

## 10. Entrega

- Fragmento `.changes/prospeccao-saida-configuravel.md`: `impacto: capacidade_nova`,
  `secao: adicionado`, título "A prospecção deixa escolher quando oferecer a opção de parar de
  receber: na 1ª, 2ª ou 3ª mensagem, ou não oferecer". `pnpm release:conferir`.
  (Entrou: "… na 1ª ou na 2ª mensagem" — 3ª **[removido por decisão do mantenedor (doc 170 = B, 20/10): só 1ª e 2ª]**; não oferecer **[não implementado neste PR; depende de decisão do mantenedor]**.)
- `docs/features/prospeccao-nativa.md`: parágrafo dos modos, do aceite e dos casos de borda.
- Destino declarado no PR: **núcleo** — sem ninguém mexer no rádio, a operação comum continua
  idêntica.
- **Commits separados por modo**, para a triagem poder aceitar uma parte e discutir outra: (1)
  tripla + contagem + modos atrasados; (2) modo `off` com aceite e auditoria — **[não implementado neste PR; depende de decisão do mantenedor]**. O `off` é o ponto em
  que o mantenedor pode discordar, e não deve arrastar o resto.

## 11. Plano de implementação (ordem)

1. **Branch** de `origin/main` (esta: `spec/prospeccao-saida-depois-da-resposta`); `git fetch` e
   `pnpm checar:colisao-de-migration` para tirar o número.
2. **Tripla da migration** (§4.3) num commit só (o pre-commit cobra).
3. **Schema + helper** (`schema.ts`, `saida-configuravel.ts` + teste) — teste primeiro, vermelho,
   depois o código.
4. **Worker** (ramos por modo, instrução, colunas) + teste-cerca atualizado. Se o #2680 já tiver
   entrado, partir da forma dele.
5. **Ligações**: `inbound-turn.ts`, `followup-turn.ts` e `context.ts`, com os testes de ligação.
   Commitar, depois sabotar cada ponto de chamada e anotar "N vermelho(s) de M, o previsto".
6. **Auditoria** (`actions.ts` + `prospecting.exit_offered`, fire-and-forget).
7. **API + tela + i18n** dos modos atrasados (`route.ts`, `_client.tsx`, `dicionario.ts`).
8. **[não implementado neste PR; depende de decisão do mantenedor]** **Commit separado do modo `off`**: refine, `store.ts` (aceite pelo ator),
   `prospecting.exit_offer_disabled`, caixa de aviso na tela, testes.
9. **Docs + mapa + fragmento.**
10. **Pré-voo** (`bash .agents/skills/deskcomm-contribuir/scripts/pre-voo.sh`) e os gates do CI pelo
    PR interno do fork (nesta máquina não se roda Docker de teste).
11. **Prova em tela** numa instalação de teste — abertura sem PARAR; resposta; 2ª (ou 3ª — **[removido por decisão do mantenedor (doc 170 = B, 20/10): só 1ª e 2ª]**) com
    PARAR; "PARAR" respondido à abertura bloqueando; "Não oferecer" exigindo o aceite (**[não implementado neste PR; depende de decisão do mantenedor]**) — com
    evidência em `evidence/prospeccao-saida/`; só depois o PR ao produto.

## 12. Limites declarados

- **O efeito real sobre banimento e denúncia não é medível pelo produto:** é relato de operação, e
  o WhatsApp não avisa denúncia. O PR apresenta isso como a estratégia do operador, e o contador
  "Pediram para parar" é o que o produto consegue observar.
- **"Sem oferta antes da saída" é instrução de prompt nas respostas do agente**, não trava: um
  modelo pode desobedecer. Na abertura, a instrução fixa é do worker; nas seguintes, do contexto.
  Uma trava mecânica pediria um classificador de "isto é oferta", que é outra entrega (§9).

Medido e fechado: nenhum teste fixa o texto da instrução da abertura
(`git grep "primeira abordagem curta"` só acha `worker.ts`), então acrescentar a frase dos modos
atrasados não quebra cerca existente.
