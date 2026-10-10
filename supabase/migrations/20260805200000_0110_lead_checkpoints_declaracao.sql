-- 0110 — a DECLARAÇÃO do turno em lead_checkpoints (spec 16 §5).
--
-- A fronteira declarada entre FALAR e OPERAR. O Conversador fecha o turno
-- dizendo, em linguagem de negócio, o que a pessoa quer e o que foi prometido a
-- ela; quem traduz isso em operação é outra camada.
--
-- NULLABLE DE PROPÓSITO, e não é descuido:
--   NULL                      → o modelo não declarou (fechamento incompleto)
--   {"nada_a_declarar": true} → o modelo avaliou e não havia nada
-- São estados diferentes. Um `not null default '{}'` colapsaria os dois e faria
-- "o modelo esqueceu" parecer "não havia nada" — apagando o esquecimento
-- exatamente onde o sistema vivo (invariante 4) exige que ele apareça.
--
-- Sem CHECK de shape: a validação real é o Zod `.strict()` de
-- lib/agent-engine/agent/declaracao.ts, e um CHECK de jsonb aqui só duplicaria a
-- regra num lugar que não sabe ensiná-la de volta ao modelo.
alter table lead_checkpoints
  add column if not exists declaracao jsonb;

comment on column lead_checkpoints.declaracao is
  'Declaração do turno (spec 16 §5): {intencoes[], promessas[], nada_a_declarar}. '
  'NULL = o modelo não declarou; {"nada_a_declarar":true} = avaliou e não havia nada. '
  'Os dois estados são distintos por desenho.';
