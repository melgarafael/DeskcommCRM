-- 0321 — o recibo de idempotência ganha o estado "em curso" (issue #778)
--
-- O PROBLEMA. `lib/api/idempotency.ts` lê o recibo, e SÓ DEPOIS deixa o efeito
-- acontecer. Entre a leitura e a gravação existe uma janela em que a chave não
-- está gravada em lugar nenhum: duas requisições SIMULTÂNEAS com o mesmo
-- `Idempotency-Key` leem vazio as duas e o efeito acontece DUAS vezes. A tabela
-- não podia fechar a janela porque não sabia representar "esta chave está em
-- curso": `status_code` e `response_body` eram `not null`, então só existia
-- recibo terminal — escrito depois do efeito. Sem estado de reserva não há o
-- que gravar antes do efeito, e sem gravar não há o que colidir.
--
-- A ESCOLHA (entre fechar no schema ou fechar por RPC em cada rota) está medida
-- no PR da issue #778. Em resumo: o caminho reutilizável é o de efeito em
-- CÓDIGO de aplicação, e código não cabe na transação do recibo — lá a única
-- forma de serializar é a linha existir antes.
--
-- O DESENHO. A linha da chave passa a ter dois estados, e um `check` diz qual é
-- qual:
--   * RESERVA   — `status_code` e `response_body` nulos. Gravada ANTES do
--                 efeito por quem ganhou a corrida do índice único
--                 (`idempotency_keys_organization_id_key_endpoint_key`); é ela
--                 que faz o segundo pedido colidir com 23505 em vez de
--                 reexecutar. `expires_at` vale como prazo da reserva (curto,
--                 `JANELA_DA_RESERVA_MS`): reserva vencida é de quem chegar
--                 depois, então processo que morreu no meio não tranca a chave.
--   * RECIBO    — os dois preenchidos. Estado terminal, com a resposta gravada
--                 e `expires_at` de 24h. É o que já existia.
-- O `check` `(status_code is null) = (response_body is null)` existe para não
-- sobrar meia-linha: recibo sem corpo ou reserva com status não são estados, e
-- um dia alguém vai escrever um deles por engano. `status_code` continua sendo a
-- coluna que responde "esta chave já produziu efeito?", então o caminho de
-- replay não muda: recibo vencido continua não contando (a leitura filtra
-- `expires_at > now()`).
--
-- O QUE MUDOU PARA QUEM JÁ TINHA LINHA. Nada: todas as linhas existentes têm as
-- duas colunas preenchidas, então passam no `check` sem backfill. É por isso
-- que a nulidade sai e o `check` entra na MESMA migration — entre uma coisa e
-- outra o banco teria um estado que o produto não usa.
--
-- RLS, policies e grants desta tabela não mudam: a travinha
-- `idempotency_platform_creation_server_only` segue recusando o caminho
-- privilegiado a `anon`/`authenticated`, e a policy de tenant segue igual. Esta
-- migration não cria tabela, não cria coluna e não mexe em `organization_id` —
-- nada aqui depende de rodar antes da varredura de travas de suporte.
--
-- Derivada em `supabase/baseline.sql`: as colunas já nascem nuláveis no `create
-- table` do modo install, e o apêndice "o recibo de idempotência ganha o estado
-- em curso (migration 0321)" reconverge banco já instalado. Os dois são o mesmo
-- SQL idempotente que está aqui, para instalação nova e segunda passada
-- chegarem ao mesmo conjunto.

alter table public.idempotency_keys
  alter column status_code drop not null;

alter table public.idempotency_keys
  alter column response_body drop not null;

-- `drop ... if exists` antes do `add`: a primeira passada cria, a segunda passa
-- por cima sem 42710, e um banco que já tenha a constraint da versão anterior
-- do desenho não fica com duas.
alter table public.idempotency_keys
  drop constraint if exists idempotency_keys_recibo_ou_reserva;

alter table public.idempotency_keys
  add constraint idempotency_keys_recibo_ou_reserva
  check ((status_code is null) = (response_body is null));

notify pgrst, 'reload schema';
