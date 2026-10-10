-- 0384 — o banco de dados externo vira MÓDULO OPCIONAL da instalação, desligado
-- por padrão (decisão do dono, doc 37, 18/09).
--
-- ─── O que faltava ──────────────────────────────────────────────────────────
-- O #1372 (recorte do #1130, de @vgamkt) entrou como "sem conexão cadastrada,
-- nada acontece": a tela de cadastrar banco externo aparecia para TODA empresa,
-- e não havia chave da instalação. O doc 37 pede o contrário — desligado, e quem
-- administra o servidor liga na tela de admin (doc 24: sem `.env`).
--
-- ─── Onde a chave mora ──────────────────────────────────────────────────────
-- Uma linha em `platform_config` (0341): chave `MODULO_BANCO_EXTERNO`, valor
-- `ligado` ou `desligado`. Linha ausente = DESLIGADO (lib/instalacao/modulos.ts).
-- Não é coluna de `platform_settings` de propósito: criar a linha daquele
-- singleton faria `signup_mode` nascer `'aberto'` pelo default e vencer o
-- `SIGNUP_MODE` do `.env` — ligar o módulo reabriria o cadastro.
--
-- ─── A ATUALIZAÇÃO não desliga ninguém calado ───────────────────────────────
-- Instalação que JÁ cadastrou conexão estava usando o módulo. Para ela, a chave
-- nasce LIGADA aqui; para todas as outras, nasce `desligado`, e o módulo some.
--
-- A linha é gravada SEMPRE, ligada ou desligada — nunca "só se houver conexão".
-- O `update.sh` reaplica o baseline a cada atualização; se esta primeira vez não
-- deixasse linha, uma conexão gravada depois (o admin de UMA empresa escreve em
-- `external_db_connections` direto pelo PostgREST, com o módulo desligado)
-- ligaria o módulo para a instalação inteira na atualização seguinte, passando
-- por cima de quem administra o servidor.
--
-- `on conflict do nothing`, e não `do update`: da primeira aplicação em diante a
-- linha existe, e nenhuma reaplicação a reescreve — nem a que a tela gravou.
-- Idempotente, e só a tela muda a escolha.

insert into public.platform_config (chave, valor, eh_segredo, semeado_do_env)
select 'MODULO_BANCO_EXTERNO',
       case when exists (select 1 from public.external_db_connections)
            then 'ligado' else 'desligado' end,
       false, false
on conflict (chave) do nothing;
