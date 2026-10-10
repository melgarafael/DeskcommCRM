-- ============================================================================
-- 0175 — A AUTOMAÇÃO PRECISA PODER DIZER "AINDA NÃO".
--
-- `automation_rule_runs.status` aceitava três valores: success, partial,
-- failed. Faltava o quarto estado que o motor JÁ produz e que a tela não tinha
-- como mostrar — o adiado.
--
-- ─── O silêncio que isto conserta ──────────────────────────────────────────
--
-- Quando uma ação de envio pede adiamento (`postponeUntil` — fora da janela
-- horária do número, ou cap diário atingido), `runAutomationForEvent` devolve
-- `{ status: 'retry', retry_at }` e sai SEM GRAVAR LINHA NENHUMA. O evento
-- volta depois, e nesse intervalo a aba Atividade não mostra absolutamente
-- nada: nem sucesso, nem falha, nem espera.
--
-- Para quem montou a automação, "não apareceu nada na Atividade" e "a
-- automação não rodou" são a mesma tela. O relato que originou esta mudança
-- foi exatamente esse — uma regra ligada, um lead entrando, e nenhuma
-- evidência de que alguma coisa tivesse acontecido.
--
-- É o invariante 4 da doutrina do Sistema Vivo (nenhuma demanda sem próximo
-- passo) aplicado a uma espera: a espera É um estado, e um estado que ninguém
-- vê é indistinguível de morte.
--
-- ─── Por que um valor novo, e não reusar `partial` ─────────────────────────
--
-- Porque `partial` significa "algumas ações funcionaram e outras falharam", e
-- a tela pinta de amarelo com o texto "Parcial". Um adiamento não é falha
-- nenhuma: nada foi tentado ainda, e vai ser. Empilhar os dois no mesmo valor
-- faria a tela mentir na direção oposta — assustar sobre uma mensagem que está
-- só esperando o horário.
--
-- ─── Ordem: o CHECK é reconstruído em UM bloco só ──────────────────────────
--
-- Mesma lição do #159 registrada no baseline para `agent_inbox_items_kind_check`:
-- reconstruir a mesma constraint em N blocos quebra o `update.sh` de todo clone
-- que já tenha uma linha com vocabulário posterior — os blocos antigos rodam
-- antes e falham em cadeia. Um bloco por constraint.
--
-- Aditiva: só ALARGA o conjunto aceito, então não há dado existente para
-- deduplicar ou corrigir antes (a regra do item 8 da doutrina de migrations não
-- se aplica — nenhuma linha atual passa a violar).
-- ============================================================================

alter table public.automation_rule_runs
  drop constraint if exists automation_rule_runs_status_check;

alter table public.automation_rule_runs
  add constraint automation_rule_runs_status_check check (status in (
    'success',
    'partial',
    'failed',
    -- (migration 0175) NADA CHEGOU AO CLIENTE, E AINDA PODE CHEGAR. Dois
    -- caminhos produzem este estado, e confundi-los foi um defeito achado em
    -- revisão adversarial:
    --   (a) a regra casou e a primeira ação pediu para esperar antes de
    --       executar (janela horária do número, cap diário) — nada foi tentado;
    --   (b) as ações executaram e ao menos uma terminou em `postponed`: a
    --       mensagem existe, está em `queued`, e não alcançou o cliente.
    -- O caso (b) era gravado como `success` pelo agregador do motor, o que
    -- ressuscitava — um nível acima — exatamente o defeito que esta entrega
    -- veio matar. O `actions_result` carrega o motivo de cada ação.
    'adiado'
  ));

comment on column public.automation_rule_runs.status is
  'success = todas as ações funcionaram; partial = algumas falharam; failed = todas falharam; '
  'adiado = nada chegou ao cliente e ainda pode chegar — a regra espera a janela de envio do '
  'número, ou a mensagem ficou na fila do canal.';
