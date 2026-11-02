---
title: "Spec Técnica 31 — A ficha guarda vários telefones, e o repetido aparece também pelo nome"
parent: 00-prd-master.md
type: spec
scope: contatos, fusão, recebimento de mensagem, prospecção
status: draft
version: 0.3.0
owner: arquitetura
created_at: 2026-10-28
related:
  - 02-spec-customer-360.md
  - 26-spec-prospeccao-preenche-a-ficha.md
---

# Spec 31 — A ficha guarda vários telefones, e o repetido aparece também pelo nome

Status: **PROPOSTA**. O código citado é o da `main` em `f13d26f6b` (28/10/2026).
O estado foi medido nesse dia, em uma instalação em produção: consultas só de leitura,
sempre filtradas por `organization_id`, em uma organização que tem 260 contatos ativos,
256 deles vindos da prospecção.

## O problema, em duas frases

1. A mesma empresa entra no CRM com **dois telefones**: a prospecção acha um número
   (o fixo, ou o de uma das páginas da empresa no Google) e a pessoa responde por outro.
   A ficha só guarda **um** telefone, e por isso nascem duas fichas.
2. A tela **Duplicados** só junta fichas com o mesmo telefone ou o mesmo e-mail. As duas
   fichas não aparecem como repetidas, e a tela também não deixa juntar duas fichas
   escolhidas à mão. Quem junta pela API perde o segundo número: a ficha que fica mantém
   o telefone dela, e a próxima mensagem do número absorvido abre uma **terceira** ficha.

## O que foi medido

### No código

| # | Fato | Onde |
|---|---|---|
| C1 | Os únicos motivos de repetido são `"telefone" \| "email" \| "telefone_em_conflito"` | `lib/contacts/duplicados.ts`, tipo `MotivoDeDuplicidade` |
| C2 | A varredura lê os 2.000 contatos mais antigos (`TETO_DE_VARREDURA = 2000`) e não lê nome parecido, site, endereço nem rede social | `app/api/v1/contacts/duplicates/route.ts` |
| C3 | A tela só mostra os grupos que a varredura achou. Não há busca para escolher outra ficha | `components/contacts/MergeDialog.tsx` (`GrupoDeDuplicados`) |
| C4 | A API de fusão **já aceita** um principal e de 1 a 20 fichas escolhidas por id | `lib/schemas/contacts.ts`, `contactsMergeSchema`; `app/api/v1/contacts/merge/route.ts` (`requireRole("manager")`, audit `contact.merged`) |
| C5 | A fusão herda o telefone da absorvida **só se o principal não tiver nenhum**: `phone_number = coalesce(phone_number, v_telefone)`. E herda só o primeiro, mesmo que haja várias absorvidas | última definição de `fn_mesclar_contatos` no `supabase/baseline.sql` (achar com `grep -n "FUNCTION public.fn_mesclar_contatos" supabase/baseline.sql` e usar a última) |
| C6 | A própria fusão já resolveu o mesmo problema para o identificador do WhatsApp (`waha_lid`). O comentário dela diz: sem herdar, "o WhatsApp do perdedor fica órfão", porque `fn_upsert_wa_contact` filtra `is_merged_into is null` e criaria uma ficha nova. Para o **telefone** a herança não acontece | mesma função, comentário antes de `select c.source_metadata->>'waha_lid' into v_lid` |
| C7 | A fusão **não junta `custom_fields`**: o que estava na ficha absorvida fica só na lápide | mesma função: o `update public.contacts set` não cita `custom_fields` |
| C8 | Quem casa a mensagem que chega procura o telefone **só** em `contacts.phone_number` de fichas vivas | `fn_upsert_wa_contact` (última definição no baseline); `lib/channels/contato-por-telefone.ts`; `lib/wacalls/events-bridge.ts`; `lib/voip/resolve-caller.ts` |
| C9 | A prospecção decide "esse contato já existe no CRM" também só por `contacts.phone_number` | `lib/prospecting/store.ts`, `triarCandidato` |
| C10 | Um telefone pertence a no máximo uma ficha viva: índice `uniq_contacts_org_phone` em `(organization_id, phone_number) where phone_number is not null and is_merged_into is null` | `supabase/baseline.sql` |
| C11 | Não existe lugar para um segundo telefone. `people` (B2B) não tem telefone; `contact_field_proposals` é a fila de propostas da IA; `wa_identity`/`wa_lid` são colunas geradas, uma por ficha | `git grep -n -E "additional_phone\|secondary_phone\|contact_phones" origin/main` não devolve nada |
| C12 | O que a prospecção acha (site, e-mail, redes, endereço, categoria) fica em `prospecting_candidates.data`. A ficha recebe só `campaign_id`, `place_id` e `maps_url` em `source_metadata` | `lib/prospecting/store.ts`, `criarPegadaDoCandidato` |
| C13 | Anonimizar zera `phone_number` e `source_metadata` da ficha | última definição de `fn_lgpd_cascade_redact_contact` no baseline |
| C14 | A tabela `merge_queue` existe no baseline com `status in ('pending','resolved','discarded')` e RLS para gestor, e **nada a lê nem escreve** | `git grep -n merge_queue origin/main -- app lib components hooks workers` só devolve comentários e `database.types.ts` |
| C15 | Ao achar a ficha, `fn_upsert_wa_contact` **sobrescreve** `source_metadata.waha_lid` com o identificador de quem escreveu, e o envio do WhatsApp usa `wa_lid` antes do telefone (`resolveWahaChatId`). A verificação de conflito só compara `phone_number` das outras fichas | `supabase/baseline.sql`, última `fn_upsert_wa_contact` (`update public.contacts set ... source_metadata = source_metadata \|\| ... 'waha_lid'`); `lib/waha/send.ts`, `resolveWahaChatId` |
| C16 | A fusão aponta para a ficha que fica **toda** chave estrangeira que referencia `contacts`, tirada do catálogo; o que colide com índice único fica na absorvida e entra em `nao_repontado` | última `fn_mesclar_contatos`, passo que lê `pg_constraint` |
| C17 | A leitura de `merge_queue` exige gestor (`merge_queue_manager_select`); `prospecting_candidates` não tem grant para `authenticated` (só `service_role`) | `supabase/baseline.sql` |
| C18 | A anonimização calcula as variantes do telefone **só** de `phone_number`, e com elas apaga candidatos da prospecção e mensagens de grupo; a exportação busca mensagens de grupo só pelo principal | última `fn_lgpd_cascade_redact_contact`; `fn_redigir_conversas_ao_anonimizar`; `lib/lgpd/export-collector.ts` |

### No banco (uma organização, 28/10/2026)

| # | Medição | Resultado |
|---|---|---|
| B1 | Pares reais de mesma empresa com dois telefones, conferidos à mão | **2**. Caso 1: duas fichas da prospecção, com o mesmo nome comercial e páginas diferentes no Google. Caso 2: a prospecção falou com o fixo e a empresa respondeu pelo celular; a segunda ficha nasceu do WhatsApp com o nome que a empresa usa lá ("Comercial - " + nome) |
| B2 | Grupos que "mesmo endereço" formaria | 7 grupos, 15 fichas, **nenhum** par real (salas do mesmo prédio comercial) |
| B3 | Grupos que "mesma rede social" formaria | 5 grupos, 26 fichas, **nenhum** real (`facebook.com/brand`, `bitly` e outros endereços genéricos que o site da empresa carrega) |
| B4 | Grupos que "mesmo domínio de site" formaria (sem Instagram e Facebook) | 3 grupos, 11 fichas, **nenhum** real (`bit.ly`, sites de diretório) |
| B5 | Similaridade de nome por trigramas (`pg_trgm`) | ≥ 0,5: 86 pares; ≥ 0,6: 11 pares. O caso 1 tem **menos de 0,35**: a palavra do nicho pesa mais que o nome |
| B6 | "Dividem 2 ou mais palavras raras" (rara = aparece em até 3 fichas da organização; fora `de/da/do/e/dr/dra/...`) | 4 pares, 1 real (caso 1) |
| B7 | "Um nome inteiro, de 6 letras ou mais, está dentro do outro" | 7 pares, 1 real (caso 2) |
| B8 | Dados que a prospecção tem por candidato com ficha (de 256) | endereço 249, site 152, rede 88, e-mail 26 |
| B9 | No caso 1, uma das fichas não tem site, endereço, rede nem e-mail: o que liga as duas é **só o nome** | — |

Leitura dos números: site, endereço e rede **sozinhos** não apontam repetido (B2–B4: 0 de 52
fichas). O nome pega os dois casos reais (B6 + B7), mas como sugestão: 2 de 11 pares. Por isso
o nome **sugere**, os outros dados **aparecem lado a lado** para quem decide, e juntar é sempre
decisão de uma pessoa.

## O que muda

### PR A — O repetido aparece também pelo nome, e dá para juntar à mão (sem migration)

1. **Novo motivo `nome_parecido`** na varredura de duplicados. O nome de cada ficha é o primeiro
   não vazio entre `name`, `display_name` e `address_book_name` (a ficha que nasce do WhatsApp pode
   não ter `name`). A varredura hoje não lê `address_book_name`
   (`app/api/v1/contacts/duplicates/route.ts`, lista de colunas): passa a ler. Normaliza caixa e acento e ignora palavras de ligação e títulos (`de`, `da`,
   `do`, `das`, `dos`, `e`, `em`, `a`, `o`, `dr`, `dra`). Um par entra quando:
   - os dois nomes dividem **2 ou mais palavras raras** — rara = aparece em **até 3** fichas
     varridas (a régua medida em B6; base maior dá menos pares, nunca mais); ou
   - um nome inteiro, com 6 letras ou mais, aparece **dentro** do outro (B7).

   O par por nome **não entra** no agrupamento dos motivos fortes (telefone, e-mail): aparece numa
   seção própria, **"Parecidos — confira"**.
2. **A comparação mostra as provas**, lado a lado: nome, telefones, categoria, endereço, site,
   redes, link do Maps, origem da ficha, conversas e negócios. Os dados da prospecção vêm de
   `prospecting_candidates`, que só o `service_role` lê (C17): a leitura usa o cliente
   administrador, com `organization_id` da sessão (nunca do pedido), e só para ids que pertencem a
   essa organização. **Não** se dá grant novo à tabela. Endereço, site e rede **não criam**
   sugestão (B2–B4).
3. **"Não são a mesma empresa"** dispensa o par, gravado em `merge_queue` (C14): `status =
   'discarded'`, `reason = 'nao_sao_a_mesma'`, `candidates` = os dois ids **em ordem crescente**.
   - Só gestor dispensa (como só gestor junta), com `requireSupportWrite`, Zod e audit
     `contact.duplicate_dismissed` (código novo no fim de `lib/audit/actions.ts`).
   - Idempotente: dispensar o mesmo par de novo, inclusive ao mesmo tempo, não grava segunda
     linha. Sem índice novo (este PR não tem migration): a gravação confere e grava sob trava por
     organização e par.
   - Só par `nome_parecido` pode ser dispensado; mesmo telefone e mesmo e-mail, não.
   - `candidates` não tem chave estrangeira. Na leitura, cada id da dispensa é trocado pela ficha
     viva em que ele virou (`is_merged_into`): depois de uma fusão, a dispensa continua valendo
     para o par.
   - Os dois ids precisam ser fichas da organização da sessão; id de outra organização → 404.
   - A lista de dispensas é lida pelo servidor (cliente administrador, filtrado pela organização
     da sessão), porque a policy de leitura exige gestor (C17): o par dispensado some para
     **todos** os papéis que veem a lista.
4. **Juntar à mão, a partir da ficha.** "Juntar com outra ficha": busca por nome ou telefone, abre
   a mesma comparação e chama o `POST /api/v1/contacts/merge` que já existe (C4), com a
   confirmação que nomeia quem fica e quem é absorvida. Papel: gestor.
5. Fica igual: `viewer` pode **ver** a lista; o teto de 2.000 e o aviso `varreu_tudo` continuam.

### PR C — Spec 26 (a prospecção preenche a ficha)

Já escrita em `docs/specs/26-spec-prospeccao-preenche-a-ficha.md`. Entra entre A e B: com site,
redes e e-mail na ficha, a comparação fica mais completa, e o PR B preserva esses campos na
fusão (item B5).

### PR B — A ficha guarda vários telefones, cada um com seu tipo (com migration)

1. **Telefones extras, com tipo.** A ficha continua com **um telefone principal**
   (`contacts.phone_number`, que os consumidores de hoje seguem lendo sem mudança) e ganha uma
   lista de **telefones extras**, numa tabela tenant-aware nova (`organization_id not null`, RLS
   `tenant_isolation_<tabela>_all`, cascade a partir do contato). Todo número — o principal e cada
   extra — leva:
   - **tipo**: `fixo`, `celular` ou `outro` (`text` + `CHECK`);
   - **WhatsApp**: `sim`, `nao` ou `nao_sei` (`text` + `CHECK`) — separado do tipo, porque
     celular nem sempre tem WhatsApp e há fixo com WhatsApp Business;
   - no extra: rótulo livre opcional, origem (`manual`, `fusao`, `importacao`, `prospeccao`,
     `whatsapp`), o identificador do WhatsApp daquele número quando houver (`lid`) e quando entrou.

   O principal ganha as **duas** colunas (tipo e WhatsApp), anuláveis, em `contacts`.

   **Preenchimento automático**, no banco (vale para todo escritor de hoje sem mudar nenhum), e
   sempre editável pela pessoa. Só para `+55` com 12 ou 13 dígitos; fora disso → `outro`:
   - 13 dígitos, primeiro dígito depois do DDD `9` → `celular`;
   - 12 dígitos, primeiro dígito depois do DDD `6`–`9` → `celular` (grafia antiga, sem o nono
     dígito — a mesma leitura de `fn_upsert_wa_contact`); `2`–`5` → `fixo`.
   - Quando o número muda, tipo e WhatsApp são recalculados; quando a pessoa edita tipo ou
     WhatsApp, o valor dela fica até o número mudar.
   - Mensagem **recebida** (não `fromMe`) por canal WhatsApp a partir do número → `WhatsApp = sim`.
     Sem sinal → `nao_sei`.

   **Migration (genérica, sem id de tenant):** o principal de toda ficha ganha o tipo pela regra
   acima, e `WhatsApp = sim` quando a ficha tem ao menos uma mensagem recebida (não `fromMe`) em
   conversa de canal WhatsApp (WAHA ou Meta WhatsApp); senão `nao_sei`. O preenchimento **não**
   mexe em `updated_at` das fichas (a ordem das listas não pode mudar).
2. **Um número, uma ficha viva.** Entre as fichas **vivas** (`is_merged_into is null`) da mesma
   organização, um número — comparado pelas variantes com e sem o nono dígito — é principal **ou**
   extra de **uma** ficha só. Lápide não conta (a fusão deixa o `phone_number` na absorvida).
   - Vale em **todo** escritor de `phone_number` e de extra: PATCH/POST de contato,
     `fn_upsert_wa_contact` (inclusive o insert), ingestão Zernio e Meta, cron `contact-phones`,
     importações, prospecção, agenda do celular, `fn_mesclar_contatos`.
   - Garantida no banco, com trava por organização e pela **forma canônica** do número
     (`canonicalPhoneBR` / as variantes de `phoneLookupVariants`, em `lib/channels/phone-variants`),
     para que duas gravações ao mesmo tempo — inclusive em grafias diferentes — não passem as duas.
   - Hoje o índice compara o texto exato (C10), e já existem pares "gêmeos" (o mesmo número com e
     sem o nono dígito; `idsDoContatoEGemeos` em `lib/channels/contato-por-telefone.ts`). A
     migration **não** os corrige nem os recusa: a regra vale para gravação nova; os pares que já
     existem aparecem em Duplicados pelo motivo `telefone`, que já compara pela forma canônica.
   - O identificador do WhatsApp (`lid`) segue a mesma regra: um `lid` é de uma ficha viva só,
     seja o da ficha ou o de um extra dela.
   - A recusa usa o código **23505** (`unique_violation`), o mesmo de `uniq_contacts_org_phone`
     (C10): é ele que `fn_upsert_wa_contact` e as rotas já tratam (409 na API, nova busca na
     ingestão).
3. **A mensagem que chega procura também nos extras**, nesta ordem: `lid` (o da ficha **e** o dos
   extras) → principal → extra, com as variantes do nono dígito. Quando a ficha é achada **pelo
   extra**:
   - o `wa_lid`/`waha_lid` do principal **não** é sobrescrito (C15); o identificador de quem
     escreveu fica guardado com o extra;
   - o número não é promovido a principal, nem gravado de novo como extra;
   - a verificação de conflito passa a olhar principal **e** extras das outras fichas: número que
     já é de outra ficha viva vira `telefone_em_conflito`, como hoje.

   Vale para todos os pontos que casam ou decidem "já existe" por telefone:
   `fn_upsert_wa_contact`; `lib/channels/contato-por-telefone.ts`; `lib/wacalls/events-bridge.ts`;
   `lib/voip/resolve-caller.ts`; `lib/agent-engine/edge/crm/session-reconciler.ts`;
   `lib/prospecting/store.ts` (`triarCandidato`); `lib/contacts/agenda-do-celular.ts`;
   `app/api/v1/contacts/import/route.ts`; `app/api/v1/leads/import/route.ts`;
   `lib/crm-b2b/import-process.ts`; `components/inbox/PainelIniciarConversa.tsx`;
   `app/api/v1/cron/task-reminder/route.ts` (que hoje nem filtra `is_merged_into`). E a busca por
   telefone em `app/api/v1/contacts/_handler.ts`, `app/api/v1/conversations/_handler.ts` e
   `app/api/v1/ai/followups/queue/route.ts`.
4. **Para onde vai a resposta.** Hoje o envio usa o `wa_lid` da ficha e, sem ele, o telefone
   principal (`resolveWahaChatId`, C15). Com dois números na mesma ficha, isso responderia no
   número errado. A regra nova:
   - **WAHA:** a resposta numa conversa vai para o endereço da **última mensagem recebida** (não
     `fromMe`) daquela conversa. O endereço já está gravado na própria mensagem: o
     `external_id` do recebido traz o chat (`chatIdFromWaMessageId`, usado hoje por
     `enderecoDaMensagem` em `lib/channels/adapters/waha.ts`). Nada novo é guardado. Sem mensagem
     recebida na conversa → a regra de hoje (`wa_lid`, depois principal).
   - Precisam seguir essa regra, **todos iguais**: `lib/waha/send.ts` (`resolveWahaChatId`),
     `lib/ai/runtime/agent.ts`, `app/api/v1/messages/_handler.ts`, `app/api/v1/messages/[id]/route.ts`,
     `lib/messaging/presenca.ts` e o reenvio de `lib/agent-engine/edge/crm/session-reconciler.ts`
     (que hoje copia a regra e diz que as duas precisam continuar iguais). `cron/contact-avatars`
     segue no principal (a foto é da ficha).
   - **Meta e Zernio:** seguem como hoje (pelo principal). A conversa mostra por qual número a
     última mensagem chegou; se for um extra, mostra o aviso "a resposta sai pelo principal" e o
     atalho "Tornar principal".
   - A conversa mostra para qual número a resposta vai sair. Conversa **nova**, aberta pelo
     operador, vai para o principal; para falar por outro número, "Tornar principal". Escolher o
     número por mensagem fica fora (ver "Fora desta spec").
5. **A fusão guarda os números e os campos.**
   - **Antes** do repontamento do catálogo (C16), a fusão apaga os extras da absorvida que repetem
     um número (ou `lid`) que a ficha que fica já tem. Os demais passam pelo repontamento. Assim o
     repetido não cai no `unique_violation` do laço e não é contado em `nao_repontado` — não é
     registro perdido, é o mesmo número.
   - O principal de cada absorvida vira extra da ficha que fica (origem `fusao`), **com** tipo,
     WhatsApp e o `lid` dela (`source_metadata.waha_lid`), salvo se já for da ficha que fica.
   - Se a ficha que fica **não tem** principal: o principal da primeira absorvida (por
     `created_at, id`, a ordem de hoje) vira o principal, com o `lid` dela; os outros viram extras.
   - A verificação de conflito com uma terceira ficha olha principal, extras e `lid`.
   - `custom_fields` passa a ser herdado: chave que não existe na ficha que fica entra; em chave
     repetida vence a ficha que fica, e entre absorvidas vence a primeira (por `created_at, id`)
     (C7).
6. **"Tornar principal"** troca um extra pelo principal numa operação só: o antigo principal vira
   extra, levando tipo, WhatsApp e `lid`; o extra promovido leva os dele para a ficha. Extra
   adicionado numa ficha **sem** principal vira principal. O principal não pode ser removido
   enquanto houver extras (primeiro "Tornar principal" em outro).
7. **Tela e API.** A ficha mostra "Telefones": cada número com tipo, WhatsApp e rótulo; adicionar,
   editar tipo/WhatsApp/rótulo, remover e "Tornar principal". Papel `agent` ou acima, como o
   PATCH de contato (`app/api/v1/contacts/[id]/route.ts`, `requireRole("agent")`).
   - `GET /api/v1/contacts/{id}` devolve `phone_type`, `phone_whatsapp` e `additional_phones`
     (`[{ phone_number, type, whatsapp, label, origin, created_at }]`).
   - Rotas de adicionar, editar, remover e tornar principal: Zod, `requireSupportWrite`, audit
     `contact.extra_phone_added`, `contact.extra_phone_updated`, `contact.extra_phone_removed`,
     `contact.primary_phone_changed` (no fim de `lib/audit/actions.ts`; **não** reusar
     `contact.phone_added`, que é o evento de `event_log` "a ficha vazia ganhou telefone" do
     #3315 e tem consumidores próprios).
   - As rotas novas **não** aceitam bearer, como `/api/v1/contacts/[id]` hoje
     (`lib/auth/public-paths.ts`): sem entrada nova lá.
   - Nenhum evento novo de webhook. `contact.phone_added` (evento público,
     `lib/schemas/webhooks.ts`) continua só para "a ficha vazia ganhou o principal".
8. **LGPD.** Anonimizar apaga os extras, os `lid` deles, o tipo e o WhatsApp. As variantes dos
   extras entram — lidas **antes** de apagar — nos três pontos que hoje usam só o principal
   (C18): apagar candidatos da prospecção, redigir mensagens de grupo e a busca de mensagens de
   grupo da exportação. A exportação do titular inclui os extras com tipo, WhatsApp, rótulo e
   `lid` (junto das colunas da ficha que `lib/lgpd/export-collector.ts` já exporta).
9. **IA.** `crm_get_contact` (`lib/mcp/tools/contacts.ts`) devolve os números com tipo e
   WhatsApp. A ferramenta de proposta de dado (`contact_field_proposals`) **não** ganha telefone
   extra nesta spec.

Schema: migration nova, apêndice idempotente no `supabase/baseline.sql` e linha `-- manifest:`.
Função nova em `public` com `revoke execute ... from public, anon`. O número da migration sai de
`pnpm checar:colisao-de-migration`. Cada PR leva o seu fragmento em `.changes/`.

## Fora desta spec (de propósito)

- Juntar automaticamente, sem uma pessoa decidir. A fusão não tem desfazer, e o nome acerta 2
  de 11 (B6, B7).
- Usar endereço, site ou rede como gatilho de sugestão (0 de 52, B2–B4).
- Enviar a mesma mensagem para vários números, ou escolher o número por mensagem.
- Resposta pelo número extra nos canais Meta e Zernio (seguem pelo principal, com aviso na tela).
- Extra de e-mail (a mesma ideia vale, mas não há caso medido).
- Desfazer fusão.

## Como provar

**PR A**
- Unidade (`lib/contacts/duplicados.ts`):
  - par com 2 palavras raras em comum entra; nome contido entra; par por nome não se junta ao
    grupo de telefone;
  - par que só divide a palavra do nicho **não** entra — o teste monta **4 ou mais** fichas com
    essa palavra, para que ela não seja rara. **Sabotagem:** trocar a régua de raridade por
    "qualquer palavra" deixa este teste vermelho;
  - ficha com `name` nulo e o nome só em `display_name` entra no par. **Sabotagem:** ler só
    `name` deixa vermelho.
- Rota:
  - dispensar sem ser gestor → 403;
  - dispensar duas vezes, ou com o par invertido → 1 linha só;
  - sessão da organização A dispensando ids de fichas da organização B → 404 e nenhuma linha
    gravada. **Sabotagem:** tirar o filtro de organização deixa vermelho;
  - par dispensado some da lista também para `viewer`. **Sabotagem:** ler `merge_queue` com a
    sessão do usuário deixa vermelho.
- Tela (Playwright, banco do `baseline.sql`): duas fichas com nomes como os do caso 1 aparecem em
  "Parecidos — confira"; "Juntar com outra ficha" junta as duas, e as duas conversas ficam na que
  ficou.

**PR B**
- Banco (`tests/invariants`):
  - a ficha que fica tem telefone **e** `wa_lid` próprios; a absorvida tinha outro número; depois
    da fusão, mensagem só com o número da absorvida (sem lid) cai na ficha que ficou e **não**
    cria ficha nova. **Sabotagem:** tirar o passo "extra" da busca deixa vermelho. O mesmo caso
    pelos canais Meta e Zernio e pela ligação de voz;
  - mensagem pelo extra não troca o `wa_lid` do principal. **Sabotagem:** voltar a sobrescrever
    deixa vermelho;
  - o mesmo número (também na grafia sem o nono dígito) como extra de duas fichas vivas → 23505;
    como extra de uma e principal de outra → 23505, nas duas ordens; o número da lápide **não**
    bloqueia;
  - duas gravações concorrentes do mesmo número em fichas diferentes, uma com e outra sem o nono
    dígito → uma passa, a outra 23505. **Sabotagem:** travar pelo texto exato deixa vermelho;
  - mensagem só com `lid` (sem telefone) de um extra já conhecido cai na ficha dele.
    **Sabotagem:** procurar `lid` só em `contacts` deixa vermelho;
  - fusão em que a ficha que fica **e** a absorvida têm `lid` próprio: depois, mensagem com o `lid`
    da absorvida cai na ficha que ficou. **Sabotagem:** não levar o `lid` junto com o extra deixa
    vermelho;
  - fusão com extra repetido: `nao_repontado` = 0 e o extra repetido não fica na lápide;
  - WAHA: a pessoa escreve pelo extra; a resposta da IA e a do operador saem para o chat do extra,
    e o reenvio de mensagem presa também. **Sabotagem:** voltar o envio para `wa_lid` da ficha
    deixa vermelho;
  - o preenchimento da migration não muda `updated_at` de nenhuma ficha;
  - isolamento de 2 organizações: o extra de A não casa mensagem de B;
  - anonimizar apaga os extras **e** apaga o candidato da prospecção e as mensagens de grupo
    casadas pelo número extra. **Sabotagem:** calcular as variantes só do principal deixa
    vermelho;
  - `custom_fields` herdado sem sobrescrever a ficha que fica;
  - tipo automático: `+551533334444` → `fixo`, `+5515999998888` → `celular`, `+551599998888`
    (grafia antiga) → `celular`, `+14155550100` → `outro`.
- Tela: adicionar um extra `celular` com `WhatsApp = sim`, mandar mensagem por ele (receiver real),
  ver cair na mesma ficha e a resposta sair pelo mesmo número.

## Destino

**Núcleo.** Telefone e fusão de ficha servem a todo nicho; nenhuma extensão consegue mudar o
recebimento de mensagem. Teste da régua: se ninguém usar telefone extra, a operação comum continua
igual, porque o principal segue sendo `contacts.phone_number`.

## Perguntas ao mantenedor

1. O passo novo de busca nos extras fica dentro de `fn_upsert_wa_contact`, ou num helper que todos
   os pontos do item B3 chamam? A spec pede o comportamento, não o lugar.
2. Usar `merge_queue` para guardar a dispensa (C14) está de acordo, ou você prefere uma tabela
   própria?
