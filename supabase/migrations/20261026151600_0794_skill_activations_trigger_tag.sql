-- manifest: A ativação de skill ganha o motivo `tag` (entrou pela etiqueta do contato ou do negócio, e não pela palavra da mensagem), para o traço e a telemetria dizerem por onde a skill entrou (spec 27, fatia 4). A CHECK de `skill_activations.trigger` passa a aceitar `tag`; sem isso o banco recusaria a gravação do match por etiqueta.

-- 0794 — `skill_activations.trigger` aceita `tag` (spec 27, fatia 4).
--
-- O motor passa a gravar `trigger = 'tag'` quando a skill entrou pela etiqueta (`any_tags`) e
-- não pela palavra-chave. A CHECK antiga só aceitava `hard` e `probe`, então a gravação seria
-- recusada e a telemetria por etiqueta ficaria invisível.
--
-- Só AMPLIA o vocabulário: as linhas que já existem (`hard`, `probe`) continuam válidas.
-- Idempotente: derruba a CHECK pelo nome (que o Postgres dá à CHECK inline da 0068) e recria com
-- o vocabulário novo. Psql puro, sem BEGIN/COMMIT.

alter table skill_activations
  drop constraint if exists skill_activations_trigger_check;

alter table skill_activations
  add constraint skill_activations_trigger_check check (trigger in ('hard', 'probe', 'tag'));
