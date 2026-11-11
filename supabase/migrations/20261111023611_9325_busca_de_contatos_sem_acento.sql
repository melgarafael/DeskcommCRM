-- manifest: A busca de CONTATOS, do seletor e da ferramenta do agente passam a usar a coluna gerada `contacts.busca_sem_acento` (9098/#3924) — a MESMA régua do inbox —, e o `lib/contacts/busca-regex.ts` (#1835) é aposentado (issue #3918, fatia 2). O `imatch` daquela régua casava acento por classe de caracteres (`[aáàâãä]`), uma segunda regra que só cobria português e divergiria da coluna do banco no primeiro ajuste. Falta uma coluna porque a busca do agente DURANTE a conversa (`crm_search_contacts`, `soContato`) não pode casar o nome da agenda do celular (#2439): ele é rótulo interno da equipe, e a ferramenta responder ao modelo se ele contém o termo digitado levaria o rótulo ao cliente aos pedaços. `busca_sem_acento` carrega display_name + name + address_book_name; `busca_sem_acento_sem_agenda` (esta migration) é `display_name` + `name` e nada mais, gerada pela MESMA `public.f_unaccent` imutável. SEM índice de propósito: a única consulta que a usa já vem presa a um `id` (`query.eq("id", soContato)`), então o Postgres avalia UMA linha — um GIN de trigrama aí só pagaria escrita em todo insert/update de contato. A coluna é GERADA (não gatilho) pelo mesmo motivo da 9098: a anonimização LGPD zera os nomes e o recálculo vem junto. Idempotente (`if not exists`) e dependente de `public.f_unaccent`, que a 9098/9100 garantem em install e update.
alter table public.contacts
  add column if not exists busca_sem_acento_sem_agenda text
  generated always as (
    lower(public.f_unaccent(
      coalesce(display_name, '') || ' ' || coalesce(name, '')
    ))
  ) stored;

notify pgrst, 'reload schema';
