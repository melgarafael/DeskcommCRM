-- A regra de comissão entra no catálogo, e para isso precisa inativar em vez de
-- sumir.
--
-- ═══ O PROBLEMA QUE ISTO RESOLVE ═══
--
-- `sale_items.commission_percent` é resolvido na inclusão do item, a partir de
-- `commission_rules`. Só que não havia NENHUMA porta para cadastrar uma regra:
-- nem tela, nem rota. Na prática, toda comissão nascia 0% em toda instalação, e
-- a precedência cuidadosamente escrita na 0351 nunca era exercida.
--
-- A saída mais barata é a regra entrar no catálogo financeiro genérico, que já
-- tem rota, tela e auditoria. Ele espera `is_active` porque a remoção ali é
-- SEMPRE inativação.
--
-- ═══ POR QUE INATIVAR É CERTO AQUI, E NÃO SÓ CONVENIENTE ═══
--
-- Apagar de verdade não perderia dinheiro — o percentual aplicado está congelado
-- na linha do item, e nenhuma comissão já gerada muda. O que se perde é a
-- resposta a "por que aquela comanda de março saiu com 35%?". Com a regra
-- inativa a pergunta tem resposta; com a linha apagada, ela vira arqueologia.
--
-- Índice parcial nas ativas: a resolução do percentual só olha regra em vigor, e
-- é a consulta que roda a cada item lançado.

-- `name` é o rótulo que a pessoa lê na lista ("Ana em manicure"). Ele é
-- redundante com os dois alvos, e a redundância é deliberada: o catálogo
-- genérico exige um nome em toda entidade, e derivá-lo no servidor produziria um
-- texto que ninguém pode corrigir quando ficar ambíguo.
alter table public.commission_rules
  add column if not exists name text not null default 'Regra de comissão';

alter table public.commission_rules
  add column if not exists is_active boolean not null default true;

create index if not exists commission_rules_org_ativas_idx
  on public.commission_rules (organization_id, event_type_id, attendant_user_id)
  where is_active;

comment on column public.commission_rules.is_active is
  'Regra em vigor. Inativa em vez de apagar: o percentual já aplicado está congelado no item, e o que se perderia é a resposta a "por que aquela comanda saiu com este percentual".';
