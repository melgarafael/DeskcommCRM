-- O tipo de evento ganha preço.
--
-- `sale_items.event_type_id` aponta para `calendar_event_types` desde a 0351,
-- com a decisão explícita de não criar uma tabela de serviços ao lado: o
-- catálogo de serviços JÁ é o de tipos de agendamento. Só que o tipo não tinha
-- preço, e a consequência estava em dois lugares:
--
--   - **no balcão**, o valor era digitado a cada item, mesmo para o serviço que
--     custa o mesmo há dois anos. Digitar preço é onde o erro de dinheiro entra;
--   - **no faturamento em lote**, era impossível. Abrir a comanda de um
--     atendimento que já aconteceu exige saber quanto ele custa, e sem o preço
--     no catálogo não há de onde tirar.
--
-- ═══ NULLABLE, E ISSO É A DECISÃO ═══
--
-- Sem default e podendo ficar vazio, porque nem todo negócio tem preço fixo:
-- consultoria cobra por hora, clínica cobra por procedimento com variação, e um
-- preço obrigatório os obrigaria a inventar um número. Vazio significa "digite
-- na hora", que é exatamente o comportamento de antes desta migration — por
-- isso ela não muda nada para quem já usa.
--
-- É PREÇO PADRÃO, nunca preço final: o item da comanda continua guardando o seu
-- próprio `unit_price_cents`, congelado na inclusão. Reajustar a tabela amanhã
-- não mexe no que foi vendido ontem, e é isso que o `default_` no nome promete.

alter table public.calendar_event_types
  add column if not exists default_price_cents bigint
  check (default_price_cents is null or default_price_cents >= 0);

comment on column public.calendar_event_types.default_price_cents is
  'Preço padrão do serviço, em centavos. Vazio = digite na hora. É SEMENTE do item da comanda, nunca o preço dele: o item guarda o seu próprio unit_price_cents, congelado na inclusão.';
