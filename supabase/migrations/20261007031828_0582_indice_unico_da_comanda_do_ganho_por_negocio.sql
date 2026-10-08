-- manifest: **Duas comandas para o MESMO negócio ganho deixam de ser possíveis: índice único parcial em `crm_lead_links` para `link_kind = 'comanda_no_ganho'` (issue #2475, item 2; acompanha o PR #2220).** O drain reivindica `event_log` linha a linha e o `drain-loop` roda em paralelo com o cron — duas linhas `lead.won` do mesmo negócio (fechar, reabrir, fechar) em instâncias diferentes passavam as duas pela trava de leitura do vínculo e cada uma abria sua comanda. O índice que existia, `uniq_crm_lead_links_lead_target_link (lead_id, target_kind, target_id, link_kind)`, tem `target_id` na chave: duas comandas são duas chaves, então ele não segura nada aqui. O índice novo tira `target_id` da conta e põe `organization_id` na frente, cobrindo só o vocabulário desta ligação (`where link_kind = 'comanda_no_ganho'`) — as outras ligações do mesmo lead (conversa, mensagem, appointment, contact, lead, external) continuam livres, porque o CHECK de `target_kind` é o que as delimita e elas podem ter várias por lead. Com ele, a perdedora da corrida recebe `23505` no insert do vínculo, que `comandaDoGanho` trata devolvendo a comanda da vencedora — e como o vínculo foi movido para ANTES do item (mesmo PR), a perdedora entrega uma comanda vazia, que ela mesma cancela (`cancel_reason = 'corrida_do_ganho'`), em vez de uma segunda comanda com o mesmo dinheiro. Idempotente: `create unique index if not exists`, precedido da limpeza das duplicatas que a corrida já deixou (mesmo desenho do apêndice `agent_inbox_midia_nao_lida_aberto_unico`, que apaga as repetidas antes de criar o índice). A limpeza mantém a MAIS ANTIGA por (`organization_id`, `lead_id`) — a comanda que nasceu primeiro é a que o operador provavelmente já viu — e a mais nova perde o vínculo, ficando como comanda aberta sem rastro de origem: cancelável pela tela de sempre, e nenhum dinheiro é apagado (a limpeza só toca `crm_lead_links`, nunca `sales`).

delete from public.crm_lead_links l
 using (
   select id,
          row_number() over (
            partition by organization_id, lead_id
            order by created_at, id
          ) as ordem
     from public.crm_lead_links
    where link_kind = 'comanda_no_ganho'
 ) repetidas
 where l.id = repetidas.id
   and repetidas.ordem > 1;

create unique index if not exists uniq_comanda_do_ganho_por_negocio
  on public.crm_lead_links (organization_id, lead_id)
  where link_kind = 'comanda_no_ganho';
