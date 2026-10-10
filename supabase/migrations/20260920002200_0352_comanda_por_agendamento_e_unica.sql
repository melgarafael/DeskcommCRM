-- Uma comanda por agendamento, garantido pelo banco.
--
-- A rota que abre comanda a partir de um agendamento consulta antes se já
-- existe, e essa consulta resolve o caso comum (o toque repetido) devolvendo a
-- comanda que já está lá. O que ela NÃO resolve é a corrida: duas requisições
-- simultâneas passam pelas duas consultas antes de qualquer insert, e nascem
-- duas comandas para o mesmo atendimento.
--
-- Duas comandas abertas para o mesmo agendamento não dão erro nenhum. Elas são
-- faturadas separadamente, e o cliente paga o atendimento duas vezes.
--
-- PARCIAL, e as duas condições importam:
--   - `appointment_id is not null` porque comanda avulsa é a maioria, e elas
--     não se excluem entre si;
--   - `status <> 'cancelled'` porque uma comanda cancelada deixa de valer. Sem
--     isso, cancelar por engano trancaria o agendamento para sempre — o erro
--     não teria conserto pela tela.

-- A ordem da doutrina: corrigir os dados ANTES de criar a constraint. Um clone
-- que já tenha rodado a rota sem o índice pode ter o par duplicado, e aí o
-- `update.sh` quebraria no meio. Fica a MAIS ANTIGA de cada agendamento, que é
-- a que tem chance de ter itens lançados.
update public.sales s
   set appointment_id = null
 where s.appointment_id is not null
   and s.status <> 'cancelled'
   and exists (
     select 1 from public.sales anterior
      where anterior.appointment_id = s.appointment_id
        and anterior.organization_id = s.organization_id
        and anterior.status <> 'cancelled'
        and (anterior.created_at, anterior.id) < (s.created_at, s.id)
   );

create unique index if not exists sales_agendamento_unico_idx
  on public.sales (organization_id, appointment_id)
  where appointment_id is not null and status <> 'cancelled';
