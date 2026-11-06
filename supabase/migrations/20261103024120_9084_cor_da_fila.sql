-- manifest: attendant_sectors.color — a cor de identificação da fila (`#rrggbb`) ou nula quando a fila não tem cor; o CHECK recusa fora do formato, então a forma vale mesmo para quem escreve fora da rota.
--
-- 9084 — a cor da fila (#3876, fatia F3).
--
-- ─── Por que esta coluna existe ────────────────────────────────────────────
--
-- A fila já tem nome, descrição, horário (9062) e membros — e nenhum sinal
-- visual. Numa instalação com cinco filas, a lista de conversas mostra o nome
-- do setor como texto e quem atende procura a mesma palavra em toda linha.
-- Cor é o que o resto do produto já usa para isso (etiqueta, #1271/#2373), com
-- a régua de contraste do repo decidindo a frente do texto.
--
-- ─── Por que o CHECK mora aqui, e não só no Zod ────────────────────────────
--
-- O Zod (`corDaFilaSchema`, `lib/schemas/routing.ts`) recusa antes, com mensagem
-- para a pessoa. Mas `attendant_sectors` também é escrita por instalação,
-- restauração e script — e uma cor malformada não quebra a tela, ela pinta
-- errado em silêncio. O CHECK é a segunda porta e a única que vale fora da rota;
-- as duas réguas são comparadas grafia por grafia em
-- `tests/invariants/setores-cor-da-fila.test.ts`.
--
-- `null` é estado legítimo e é o DEFAULT de fato: fila sem cor continua com o
-- visual de antes desta fatia, byte a byte. Não há `default` no banco de
-- propósito — sem cor não é "cor zero", é ausência de escolha.
--
-- Idempotente: `if not exists` na coluna, e o CHECK é inline (entra junto com
-- ela, então reaplicar não tenta recriar constraint nenhuma).
alter table public.attendant_sectors
  add column if not exists color text
  check (color is null or color ~ '^#[0-9a-fA-F]{6}$');

comment on column public.attendant_sectors.color is
  'Cor de identificação da fila (migration 9084): #rrggbb, ou NULL = sem cor (o visual de antes da fatia). O CHECK guarda a FORMA; a paleta oferecida é a da tela (PALETA_DE_ETIQUETAS), e a pertinência a ela não se valida no banco. Lida por GET /api/v1/attendants/sectors e gravada por PATCH /api/v1/attendants/sectors/[id] (manager+).';
