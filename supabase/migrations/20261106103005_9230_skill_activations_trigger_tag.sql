-- manifest: A ativação de skill ganha o motivo `tag` (entrou pela etiqueta da conversa ou do contato, e não pela palavra da mensagem), para o traço e a telemetria dizerem por onde a skill entrou (spec 27, fatia 4). A CHECK de `skill_activations.trigger` passa a aceitar `tag`; sem isso o banco recusaria a gravação do match por etiqueta.

-- 9230 — `skill_activations.trigger` aceita `tag` (spec 27, fatia 4).
--
-- O motor passa a gravar `trigger = 'tag'` quando a skill entrou pela etiqueta (`any_tags`) e
-- não pela palavra-chave. A CHECK antiga só aceitava `hard` e `probe`, então a gravação seria
-- recusada e a telemetria por etiqueta ficaria invisível.
--
-- Só AMPLIA o vocabulário: as linhas que já existem (`hard`, `probe`) continuam válidas.
-- Idempotente e num bloco só: o `update.sh` roda sem ON_ERROR_STOP, e um `add` solto que falhasse
-- deixaria a tabela sem CHECK. Psql puro, sem BEGIN/COMMIT.

do $skill_trigger_tag$
begin
  alter table public.skill_activations
    drop constraint if exists skill_activations_trigger_check;
  alter table public.skill_activations
    add constraint skill_activations_trigger_check check (trigger in ('hard', 'probe', 'tag'));
end $skill_trigger_tag$;
