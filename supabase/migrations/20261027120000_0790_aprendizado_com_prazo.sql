-- manifest: org_memory_entries ganha valid_until (data no fuso da organização): a leitura do turno ignora a entrada vencida, em vez de depender de alguém arquivar à mão
--
-- 0790 — programação semanal e cardápio do dia (#2369).
--
-- O conteúdo que o restaurante atualiza toda semana JÁ mora em
-- `org_memory_entries` (0067) — é o "Aprendizado" da Memória da IA, que entra
-- no prefixo de todo turno. O que faltava era PRAZO: o único jeito de uma
-- entrada parar de valer era `status = 'archived'`, manual e um por um, depois
-- que alguém percebia. Na prática, a atração de sexta continuava sendo
-- anunciada na terça seguinte.
--
-- Anulável de propósito: `NULL` = vale para sempre, que é o estado de TODA
-- entrada existente. Nenhum comportamento atual muda; quem quiser prazo,
-- marca.
--
-- A data é de CALENDÁRIO (date), não instante: a entrada vale até o fim desse
-- dia no fuso da organização (`organizations.timezone`) — a mesma régua do
-- `valid_until` de proposta (D8). Sem CHECK de futuro: registrar a programação
-- da semana passada é histórico legítimo, e ela nasce vencida de propósito.
--
-- Sem índice novo: a leitura é por (organization_id, status), já indexada em
-- 0067, e a memória de uma organização são punhados de linhas — o filtro de
-- data é resíduo, não a busca.
alter table public.org_memory_entries
  add column if not exists valid_until date;

do $$
begin
  -- `comment on column` numa tabela ausente derruba o `db reset` de quem está
  -- num clone anterior a 0067; a guarda mantém a migration reaplicável.
  if to_regclass('public.org_memory_entries') is not null then
    execute $c$comment on column public.org_memory_entries.valid_until is
      'Último dia em que a entrada vale, no fuso da organização (NULL = sem prazo). A leitura do turno ignora a entrada depois desta data — programação semanal, promoção do mês, cardápio do dia.'$c$;
  end if;
end $$;
