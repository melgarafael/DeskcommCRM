-- manifest: **O entregue e o lido da API oficial chegam ao destinatário da campanha (issue #2937).** `fn_campanha_sincroniza_ack` saía cedo quando `new.status is not distinct from old.status` e o gatilho escutava só `after update of status`: na API oficial o webhook de entrega/leitura mantém `messages.status = 'sent'` e grava apenas `delivered_at`/`read_at` (`lib/channels/meta/status-update.ts:23-31`), então o gatilho nem disparava ou saía no primeiro `if` — `campaign_recipients.delivered_at`/`read_at` ficavam nulos para sempre e as taxas de entrega/leitura da campanha, zeradas. A função passa a derivar o "status efetivo" dos carimbos quando o canal não muda o `status`, e o gatilho passa a escutar exatamente as três colunas que aquele ack toca (`status`, `delivered_at`, `read_at`). O caminho do canal não oficial (o `status` chega `delivered`/`read`, `lib/waha/ingest.ts`), a regra de "status analítico nunca retrocede" e o caminho de `failed` seguem idênticos. Gate: `tests/invariants/ack-da-api-oficial-alcanca-o-destinatario.test.ts` (vermelho na main, verde aqui).

-- ---- o ack da API oficial alcança o destinatário da campanha (migration 0678, issue #2937) ----
-- ─── O defeito, medido ──────────────────────────────────────────────────────
--
-- O gatilho nasceu (0375) casando a TRANSIÇÃO de `messages.status` com o estado
-- do destinatário: o canal não oficial muda o `status` a cada ack (`ack >= 2`
-- grava `delivered_at` E avança o status; `ack >= 3` idem para `read`), então
-- `after update of status` bastava.
--
-- O canal oficial não muda o `status`. `statusUpdate` mantém o domínio colapsado
-- em `sent | failed` de propósito — é o que o resto do produto lê — e joga a
-- informação fina nas colunas de carimbo. Consequência: `update ... set
-- status='sent', delivered_at=now()` não está entre as colunas escutadas pelo
-- gatilho (não dispara), e quando o `status` entra na lista de escrita sem mudar
-- de valor o primeiro `if` da função devolve `new` sem tocar em nada.
--
-- Medido no banco, com a definição anterior: mensagem de campanha em `sent`,
-- `update public.messages set status='sent', delivered_at=now()` e depois
-- `... read_at=now()` deixam `campaign_recipients` em `sent` com os dois
-- carimbos nulos — exatamente o que a issue relata na tela.
--
-- ─── O conserto ─────────────────────────────────────────────────────────────
--
-- 1. O "status efetivo" sai dos carimbos quando eles existem: `read_at` presente
--    (ou `status='read'`) vale `read`; `delivered_at` presente (ou
--    `status='delivered'`) vale `delivered`; `failed` continua decidindo sozinho,
--    porque uma falha não é desfeita por um carimbo anterior. O corpo do `update`
--    não muda: o que muda é a variável que ele lê.
-- 2. A guarda de saída passa a olhar os TRÊS fatos que o gatilho escuta — só
--    retorna cedo quando `status`, `delivered_at` e `read_at` vierem os três
--    inalterados. É ela que impede o trabalho à toa num `update` que reescreve o
--    mesmo `status` sem carimbo novo.
-- 3. O gatilho passa a escutar `status, delivered_at, read_at` — a lista MÍNIMA
--    do ack, e não `update` sem lista: um `update of` só dispara quando a coluna
--    aparece na escrita, então mexer em `body`, `metadata` ou `updated_at` segue
--    sem custo nenhum.
--
-- Nada mais muda: mesma assinatura, mesmos grants, mesma regra de precedência do
-- status analítico (`replied`/`opted_out`/`cancelled` nunca retrocedem) e o
-- caminho do canal não oficial continua entrando pela porta do `status`.
create or replace function public.fn_campanha_sincroniza_ack() returns trigger
  language plpgsql
  security definer
  set search_path to 'public'
as $$
declare
  -- O canal oficial mantém `status = 'sent'` e só preenche os carimbos: o
  -- "status efetivo" sai deles quando existem. `failed` vem primeiro porque uma
  -- falha não é desfeita por entrega anterior.
  v_status text := case
    when new.status = 'failed' then 'failed'
    when new.read_at is not null or new.status = 'read' then 'read'
    when new.delivered_at is not null or new.status = 'delivered' then 'delivered'
    else new.status end;
begin
  if new.status is not distinct from old.status
     and new.delivered_at is not distinct from old.delivered_at
     and new.read_at is not distinct from old.read_at then
    return new;
  end if;

  update public.campaign_recipients r
     set delivered_at = case
           when v_status in ('delivered', 'read')
             then coalesce(r.delivered_at, new.delivered_at, now())
           else r.delivered_at end,
         read_at = case
           when v_status = 'read' then coalesce(r.read_at, new.read_at, now())
           else r.read_at end,
         sent_at = case
           when v_status in ('sent', 'delivered', 'read')
             then coalesce(r.sent_at, new.sent_at, now())
           else r.sent_at end,
         status = case
           when r.status in ('replied', 'opted_out', 'cancelled') then r.status
           when v_status = 'read' then 'read'
           when v_status = 'delivered' and r.status in ('queued', 'sending', 'sent') then 'delivered'
           when v_status = 'sent' and r.status in ('queued', 'sending') then 'sent'
           when v_status = 'failed' and r.status in ('queued', 'sending', 'sent') then 'failed'
           else r.status end,
         last_error_code = case
           when v_status = 'failed' then coalesce(new.error_code, r.last_error_code)
           else r.last_error_code end,
         last_error_detail = case
           when v_status = 'failed' then coalesce(new.error_message, r.last_error_detail)
           else r.last_error_detail end,
         updated_at = now()
   where r.message_id = new.id;

  return new;
end
$$;

comment on function public.fn_campanha_sincroniza_ack() is
  'Trigger de messages: leva o ack do canal (sent/delivered/read/failed) ao campaign_recipients daquela mensagem. Deriva o status efetivo dos carimbos delivered_at/read_at, porque o canal oficial não muda messages.status. Status analítico nunca retrocede.';

-- Doutrina 9: as duas origens de EXECUTE, com os mesmos grants da definição anterior.
revoke execute on function public.fn_campanha_sincroniza_ack() from public, anon, authenticated;
grant execute on function public.fn_campanha_sincroniza_ack() to service_role;

drop trigger if exists trg_messages_sincroniza_campanha on public.messages;
create trigger trg_messages_sincroniza_campanha
  after update of status, delivered_at, read_at on public.messages
  for each row
  when (new.direction = 'outbound')
  execute function public.fn_campanha_sincroniza_ack();
