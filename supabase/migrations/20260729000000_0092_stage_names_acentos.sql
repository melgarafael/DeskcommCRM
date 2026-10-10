-- 0092 — acentos nas etapas padrão do funil
--
-- O seed do funil "Pedidos" (função de bootstrap de organização) criava duas
-- etapas sem acento: "Em separacao" e "Pos-venda". Elas aparecem no quadro
-- principal, que é a tela mais vista do CRM — e o próprio baseline.sql já as
-- escrevia corretamente nos comentários, então era descuido, não escolha de
-- manter ASCII (o `slug` continua ASCII, como deve ser).
--
-- Só corrige quem ainda está com o nome padrão intacto: se o tenant renomeou a
-- etapa, não há match e nada muda.

update public.crm_stages set name = 'Em separação' where name = 'Em separacao';
update public.crm_stages set name = 'Pós-venda'    where name = 'Pos-venda';
