-- manifest: Pedidos de plataforma SEM integração nativa (Tray, Loja Integrada, WooCommerce…) entram por uma ORIGEM GENÉRICA — issue #2442. `orders_external_provider_check` só aceitava 'nuvemshop', 'vtex' e 'shopify', e a loja da instalação vende pelo site em Tray: a ponte própria grava direto em `orders` e batia 23514, obrigando a alterar a restrição NA INSTALAÇÃO — com o risco apontado na issue de uma migration futura recriar essa lista sem 'tray' e a atualização para no meio (as linhas já gravadas violam o CHECK novo). A opção 2 da issue (a que o autor prefere): 'external' como origem de quem chega por integração própria, com o NOME DA PLATAFORMA no `payload` (`payload->>'platform'`), para servir qualquer loja sem a lista crescer a cada caso. Alargamento, com um backfill: linha gravada com origem fora da lista por instalação que alargou a restrição à mão (o caso da issue) vira 'external', com a plataforma em `payload->>'platform'` e o `external_id` prefixado ('tray:10231') — sem isso o bloco falha e o update repete o erro, mantendo a restrição que havia; drop, conversão e add formam um bloco DO só, então uma falha no meio nunca deixa a tabela sem guarda; os três conectores nativos seguem idênticos e a guarda continua de pé (valor fora da lista ainda recebe 23514, coberto por `tests/invariants/pedido-de-plataforma-sem-conector.test.ts`). `drop constraint if exists` antes do `add` porque o nome existe desde a definição inicial da tabela no dump do install, e o MESMO bloco entra como apêndice em `supabase/baseline.sql` — é o que o kit self-host aplica (install E update), e este é o bloco único desta constraint, na regra da issue #159.
-- O drop, a conversão e o add vão num bloco SÓ, que é um único comando: se
-- qualquer passo falhar, nada fica feito e a restrição de antes continua de
-- pé. Antes eram três comandos soltos e, como o update.sh aplica o baseline
-- sem ON_ERROR_STOP, um `add` que falhasse deixava a tabela SEM restrição
-- nenhuma. Agora a falha deixa a instalação exatamente como estava, e o erro
-- aparece no update.
--
-- O drop do começo existe porque a restrição alargada à mão (o caso da própria
-- #2442) ainda recusaria 'external' na conversão. A conversão pega a linha que
-- a instalação gravou com uma origem fora da lista ('tray') e a põe no formato
-- que a ponte deve usar daqui em diante: a plataforma vai para
-- `payload->>'platform'` (sem sobrescrever uma que já esteja lá) e o
-- `external_id` ganha o prefixo dela ('tray:10231'). É isso que mantém a chave
-- única NA PRÁTICA: o par (origem, id) já era único, e (external, origem:id)
-- só colide em caso forjado — uma linha 'external' prévia com o mesmo id
-- prefixado, ou ':' dentro da origem ou do id ('tray','a:b' e 'tray:a','b'
-- viram ambos 'tray:a:b'). Nesse caso o bloco inteiro é desfeito e a
-- instalação segue com a restrição que tinha.
-- Idempotente: na segunda passada não sobra linha fora da lista.
do $pedido_sem_conector$
begin
  alter table public.orders
    drop constraint if exists orders_external_provider_check;

  update public.orders
     set payload = jsonb_build_object('platform', external_provider) || payload,
         external_id = external_provider || ':' || external_id,
         external_provider = 'external'
   where external_provider not in ('nuvemshop', 'vtex', 'shopify', 'external');

  alter table public.orders
    drop constraint if exists orders_external_provider_check,
    add constraint orders_external_provider_check check (external_provider in (
      'nuvemshop', 'vtex', 'shopify', 'external'
    ));
end
$pedido_sem_conector$;
