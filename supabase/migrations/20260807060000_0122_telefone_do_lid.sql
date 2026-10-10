-- 0122 — o telefone do contato @lid, que sempre chegou e nunca foi lido
--
-- ═══ O QUE FOI MEDIDO ═══
--
-- Produção, 2026-08-06: 22 de 31 contatos ativos (71%) sem telefone, e TODOS os
-- 22 com identidade `lid:`. A leitura corrente era "o WhatsApp não entrega o
-- número de quem está em modo privacidade, então o campo fica nulo".
--
-- É falso. Varrendo `webhook_events_log` (1000 eventos reais, 438 mensagens):
--
--   "_data": { "key": {
--       "remoteJid":    "70192801575156@lid",
--       "remoteJidAlt": "558183647258@s.whatsapp.net",
--       "addressingMode": "lid" } }
--
-- **76 de 76** payloads `@lid` com `_data.key` trazem o telefone em
-- `remoteJidAlt`. O número sempre esteve no webhook que já recebemos — ninguém
-- olhava. Nenhuma chamada extra, nenhum endpoint novo, nenhum NOWEB Store.
--
-- ═══ POR QUE NÃO BASTA GRAVAR O TELEFONE ═══
--
-- `contacts.wa_identity` é GERADA e dá precedência ao telefone (0027):
--
--   phone_number is not null      -> 'phone:' || phone_number
--   source_metadata->>'waha_lid'  -> 'lid:'   || <digitos>
--
-- e o `on conflict` do upsert casa por ela. Preencher `phone_number` num contato
-- nascido `lid` muda a identidade de `lid:X` para `phone:+Y`; o próximo webhook
-- com o MESMO `@lid` deixa de casar e **nasce um contato duplicado** — o defeito
-- que a 0027 veio matar, reintroduzido pela porta dos fundos.
--
-- Por isso esta migration acrescenta `wa_lid`: uma chave de correlação do
-- WhatsApp que NÃO depende do telefone. `wa_identity` continua sendo a
-- identidade canônica; `wa_lid` é como se reencontra a mesma conversa.
--
-- ═══ E O ENVIO NÃO MUDA DE CANAL ═══
--
-- `resolveWahaChatId` (lib/waha/send.ts) prefere telefone: um contato @lid que
-- ganhasse número passaria a receber por `@c.us`. Trocar o endereço de uma
-- conversa que funciona é o pior defeito possível num CRM de atendimento — se o
-- `@c.us` não for endereçável, paramos de responder o cliente. O telefone entra
-- para o CRM (identificar, buscar, ligar, deduplicar); o ENVIO continua indo por
-- onde a conversa veio. A troca de precedência acompanha esta migration no
-- código, não no schema.

-- ---- 1 · wa_lid: a correlação que sobrevive ao telefone ----
-- Gerada, e não escrita à mão, pelo mesmo motivo de `wa_identity`: valor
-- derivado que alguém precisa lembrar de atualizar é valor que diverge. O
-- `nullif` no fim evita que contato sem lid vire string vazia e colida no índice
-- único com todos os outros contatos sem lid.
alter table public.contacts
  add column if not exists wa_lid text
  generated always as (
    nullif(regexp_replace(coalesce(source_metadata->>'waha_lid', ''), '@.*$', ''), '')
  ) stored;

-- ---- 2 · deduplicar ANTES da constraint (auto-curativo) ----
-- Um clone pode ter dois contatos com o mesmo lid — nasceram antes da 0027, ou
-- de uma janela em que o upsert ainda fazia check-then-act. Criar o índice único
-- sem tratar isso quebraria o `update.sh` do clone, que é exatamente o que a
-- doutrina de migrations proíbe.
--
-- O sobrevivente é o mais ANTIGO (é dele o histórico); os outros são marcados
-- como fundidos e suas referências repontadas — mesma mecânica do bloco B1 da
-- 0027, que já existe no baseline.
with ranked as (
  select id,
         first_value(id) over (
           partition by organization_id,
             nullif(regexp_replace(coalesce(source_metadata->>'waha_lid', ''), '@.*$', ''), '')
           order by created_at asc, id asc
         ) as canonical_id
    from public.contacts
   where is_merged_into is null
     and nullif(regexp_replace(coalesce(source_metadata->>'waha_lid', ''), '@.*$', ''), '') is not null
)
update public.contacts c
   set is_merged_into = r.canonical_id, merged_at = now()
  from ranked r
 where c.id = r.id and r.id <> r.canonical_id;

update public.conversations       t set contact_id = c.is_merged_into from public.contacts c where t.contact_id = c.id and c.is_merged_into is not null;
update public.messages            t set contact_id = c.is_merged_into from public.contacts c where t.contact_id = c.id and c.is_merged_into is not null;
update public.ai_agent_runs       t set contact_id = c.is_merged_into from public.contacts c where t.contact_id = c.id and c.is_merged_into is not null;
update public.crm_lead_activities t set contact_id = c.is_merged_into from public.contacts c where t.contact_id = c.id and c.is_merged_into is not null;
update public.crm_leads           t set contact_id = c.is_merged_into from public.contacts c where t.contact_id = c.id and c.is_merged_into is not null;
update public.lgpd_requests       t set contact_id = c.is_merged_into from public.contacts c where t.contact_id = c.id and c.is_merged_into is not null;
update public.orders              t set contact_id = c.is_merged_into from public.contacts c where t.contact_id = c.id and c.is_merged_into is not null;

create unique index if not exists uniq_contacts_org_wa_lid
  on public.contacts (organization_id, wa_lid)
  where wa_lid is not null and is_merged_into is null;

-- ---- 3 · o upsert passa a reencontrar por LID, e a completar o que falta ----
-- A versão de 6 parâmetros tinha DOIS buracos, além do telefone:
--   (a) no conflito só mexia em `display_name`, com `coalesce(existente, novo)` —
--       um nome ruim gravado uma vez congelava para sempre e nenhum dado
--       descoberto depois entrava;
--   (b) casava só por `wa_identity`, então não reencontrava o contato cuja
--       identidade mudou.
--
-- A regra nova é "completar, nunca sobrescrever": o que já está preenchido
-- vence, o que está vazio é preenchido. Assim um telefone descoberto no 5º
-- webhook entra, e um nome que o atendente corrigiu à mão não é desfeito pelo
-- pushName do WhatsApp.
create or replace function public.fn_upsert_wa_contact(
  p_org uuid, p_kind text, p_phone text, p_lid text, p_chat_id text, p_notify text
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
  v_conflito text;
  v_lid text := nullif(regexp_replace(coalesce(p_lid, ''), '@.*$', ''), '');
  v_phone text := nullif(p_phone, '');
begin
  -- ⚠️ A ASSINATURA NÃO MUDA, e não é economia de digitação.
  --
  -- A primeira versão desta migration acrescentava um 7º parâmetro
  -- (`p_phone_alt`) para o telefone vindo de `_data.key.remoteJidAlt`. Isso
  -- criava uma função nova aos olhos do Postgres, obrigava a dropar a de 6 e
  -- forçava a edição de DOIS invariantes de hardening que citam a assinatura —
  -- que o hook do repo (com razão) congela.
  --
  -- Quem sabe QUAL telefone usar é o chamador: `lib/waha/ingest.ts` já resolve o
  -- chatId e agora também lê o `remoteJidAlt`. Ele manda um telefone só, em
  -- `p_phone`. Menos superfície, mesma capacidade, e os grants existentes
  -- continuam valendo — a catraca levou ao desenho menor.

  -- 1 · pela correlação do WhatsApp, que NÃO depende do telefone.
  --     `wa_identity` é gerada com o telefone na frente do lid: um contato @lid
  --     que ganha número passa a valer `phone:+Y` e o `on conflict` antigo
  --     deixava de reencontrá-lo — nascia um contato por mensagem.
  if v_lid is not null then
    select id into v_id from public.contacts
     where organization_id = p_org and wa_lid = v_lid and is_merged_into is null
     limit 1;
  end if;

  -- 2 · pelo telefone — é aqui que a pessoa que já existia por número (import,
  --     formulário, pedido) deixa de virar um segundo contato ao escrever no
  --     WhatsApp. Sem este passo, descobrir o telefone criaria o gêmeo em vez de
  --     evitá-lo.
  if v_id is null and v_phone is not null then
    select id into v_id from public.contacts
     where organization_id = p_org and phone_number = v_phone and is_merged_into is null
     limit 1;
  end if;

  -- 3 · COMPLETA o que falta, nunca sobrescreve.
  --     A versão anterior só mexia em `display_name` no conflito, com
  --     `coalesce(existente, novo)`: um nome ruim gravado uma vez congelava para
  --     sempre, e telefone ou lid descobertos depois NUNCA entravam.
  -- O telefone descoberto só sobe para a coluna ÚNICA se ainda não for de outro
  -- contato vivo da org. Sem esta guarda o caso "contato @lid sem telefone + a
  -- mesma pessoa já cadastrada por número" (import, pedido, formulário) estoura
  -- `uniq_contacts_org_phone`; `lib/waha/ingest.ts:343` transforma a exceção em
  -- `return null` e `:459` descarta a mensagem com o webhook respondendo 200 — a
  -- mensagem do cliente some, e some de novo a cada mensagem seguinte daquele
  -- contato. Medido na triagem; não acontece na `main`, é regressão desta
  -- migration. A etapa 2 (busca por telefone) não protege: ela só roda quando a
  -- etapa 1 NÃO achou.
  --
  -- Fundir os dois contatos seria o desfecho semanticamente certo — é a mesma
  -- pessoa, e o `remoteJidAlt` é justamente quem afirma isso. Mas fusão é
  -- IRREVERSÍVEL, e a regra do tempo da doutrina proíbe consumar irreversível no
  -- tempo da máquina, dentro de um webhook. Aqui o dado não se perde: vai para
  -- `source_metadata.telefone_em_conflito`, que não é único, e a decisão de
  -- fundir fica para quem opera.
  if v_id is not null and v_phone is not null and exists (
    select 1 from public.contacts
     where organization_id = p_org and phone_number = v_phone
       and is_merged_into is null and id <> v_id
  ) then
    v_conflito := v_phone;
    v_phone := null;
  end if;

  if v_id is not null then
    update public.contacts set
      phone_number = coalesce(phone_number, v_phone),
      display_name = coalesce(display_name, nullif(p_notify, '')),
      source_metadata = source_metadata
        || case when v_lid is not null then jsonb_build_object('waha_lid', v_lid) else '{}'::jsonb end
        || case when p_chat_id is not null then jsonb_build_object('waha_chat_id', p_chat_id) else '{}'::jsonb end
        || case when nullif(p_notify, '') is not null then jsonb_build_object('notify_name', p_notify) else '{}'::jsonb end
        || case when v_conflito is not null then jsonb_build_object('telefone_em_conflito', v_conflito) else '{}'::jsonb end,
      updated_at = now()
    where id = v_id;
    return v_id;
  end if;

  insert into public.contacts (organization_id, phone_number, source, consent, tags, source_metadata, display_name)
  values (p_org, v_phone, 'whatsapp', '{}'::jsonb, '{}'::text[],
    case when v_lid is not null
      then jsonb_build_object('waha_lid', v_lid, 'waha_chat_id', p_chat_id, 'notify_name', nullif(p_notify, ''))
      else jsonb_build_object('waha_chat_id', p_chat_id, 'notify_name', nullif(p_notify, '')) end,
    nullif(p_notify, ''))
  returning id into v_id;
  return v_id;
end; $$;

-- Os grants da assinatura de 6 já existem desde a 0027 e continuam valendo — por
-- isso não há `drop function` aqui, e por isso os invariantes de hardening não
-- precisaram ser tocados.

-- ---- 4 · o rótulo técnico legado sai ----
-- Medido na produção: 3 linhas com `Contato 543134@lid` e `Contato 900928` —
-- duas formas, porque duas versões do código antigo os escreveram. Nenhum código
-- vivo produz isso hoje (o produtor morreu no commit c890b403); é resíduo, e o
-- passo seguinte da spec 17 vai LER o nome do contato para o título do card, o
-- que faria o resíduo vazar para o kanban.
--
-- ⚠️ `and is_anonymized = false` NÃO é zelo: `Contato Anonimizado #<id>` também
-- começa com "Contato " e é gravado deliberadamente pela rota de LGPD. Sem esta
-- guarda, o backfill REVERTERIA anonimizações — violação direta da regra L-04,
-- cuja exceção é "Nenhuma".
--
-- Vira NULL, e não um rótulo novo: quem decide o que mostrar quando não há nome
-- é a tela. Gravar texto de exibição no banco foi o que criou este problema.
update public.contacts
   set display_name = null, updated_at = now()
 where display_name ~ '^Contato [0-9]+(@lid)?$'
   and is_anonymized = false;
