-- A credencial de enfeite não derruba a leitura: `fn_decrypt_oauth` para de estourar.
--
-- O DEFEITO (issue #754)
--
-- `POST /rest/v1/rpc/fn_decrypt_oauth` devolvendo 500 entre 10% e 30% das
-- chamadas, continuamente, o dia inteiro — medido em 24h de log do Supabase
-- numa instalação self-host: 2 a 12 erros por hora contra ~18 sucessos.
--
-- A função era isto:
--
--   declare k text := private.fn_oauth_key();
--   begin return pgp_sym_decrypt(ciphertext, k); end
--
-- Ou seja: `pgp_sym_decrypt` em QUALQUER bytea. E o schema grava bytea de
-- enfeite onde ainda não há credencial — as colunas cifradas são NOT NULL
-- (`channel_sessions.webhook_secret_encrypted`, baseline:1300/1819), então
-- "ainda não configurado" virou `Buffer.from([0])` — um byte só para satisfazer
-- a coluna. O próprio repo já documenta isso em `lib/waha/webhook-auth.ts`
-- ("as duas rotas que criam sessão gravam `webhook_secret_encrypted:
-- Buffer.from([0])` — um byte de enfeite —, esse 'caso de exceção' era o estado
-- PERMANENTE de toda instalação").
--
-- MEDIDO NESTA VPS (PG 16, baseline aplicado, chave presente), antes do fix:
--
--   `\x00` (a sentinela)            => EXCEÇÃO sqlstate=39000 "Wrong key or corrupt data"
--   bytea vazio                     => EXCEÇÃO 39000
--   pacote pgp de verdade            => decifra (controle positivo)
--   NULL                             => NULL, sem erro
--
-- A taxa de 10-30% é a heterogeneidade das linhas, não da chave: chave errada
-- falharia ~100% das chamadas. Falha quem cai no registro de enfeite.
--
-- POR QUE NINGUÉM VIU NA TELA
--
-- Quem lê trata erro como "sem credencial" — `lib/webhooks/secrets.ts` devolve
-- null em `error || !data`, o contrato declarado no cabeçalho dele ("decrypt que
-- falha retorna null ... nunca 500"). O estrago é o outro lado: um erro
-- permanente no log, em cima dos MESMOS registros, indistinguível de chave
-- trocada ou dado corrompido. Quem opera aprende a ignorar o alarme.
--
-- O QUE ESTA MIGRATION FAZ
--
-- Guarda de FORMA antes de decifrar: só tenta o que PODE ser uma cifra deste par.
--
--   1. `ciphertext is null`                      => null (já era o comportamento)
--   2. `octet_length(ciphertext) < 66`            => null
--   3. `get_byte(ciphertext, 0) < 128`            => null
--
-- O 66 é medido, não escolhido: o MENOR pacote que `fn_encrypt_oauth` produz
-- (texto vazio, aes256) tem 66 bytes; um token de 32 chars dá 85. E um pacote
-- PGP sempre começa com o bit 7 ligado — o real medido começa em 0xC3. Sem as
-- duas condições, "JSON em claro na coluna" (111 bytes, também medido) passaria
-- pelo tamanho e voltaria a estourar.
--
-- A ORDEM DAS LINHAS IMPORTA, e foi medida: `get_byte()` em bytea vazio estoura
-- (`index 0 out of valid range, 0..-1`). Por isso as três guardas são `if`s
-- separados com `return` — nada aqui depende de curto-circuito de `or`.
--
-- O QUE ELA NÃO FAZ (de propósito)
--
--   - Não engole o que É cifra e não abre. Pacote de verdade com a chave trocada
--     continua levantando, agora distinguível: isso é misconfiguração de
--     instalação, com conserto do lado de quem opera, e é o único caso em que um
--     500 aqui diz a verdade. Silenciar isso transformaria uma chave perdida em
--     "nenhuma credencial cadastrada" — mentira mais cara que o erro.
--   - Não toca nas linhas. O byte de enfeite continua onde está: com a guarda ele
--     já não derruba nada, e reescrever coluna cifrada de instalação alheia para
--     ganhar zero de comportamento seria risco de graça.
--   - Não muda ACL: continua service_role, como a 0041 e a 0116 deixaram. A
--     função é alcançável pela anon key se alguém conceder — e o bloco de
--     varredura anon do baseline segue sendo o que fecha isso.
--
-- A CLASSE INTEIRA
--
-- `pgp_sym_decrypt` aparece DUAS vezes no baseline (a definição do dump e o
-- forward-fix da 0041), e as duas dentro desta mesma função. Não há segundo
-- caminho de decifra para consertar — a guarda num lugar só cobre todo leitor
-- (webhooks WAHA/Nuvemshop, credencial do Google, tokens da agenda, Zernio,
-- Meta, rag-indexer, call-webhook). `tests/unit/credencial-de-enfeite-nao-derruba-a-leitura.test.ts`
-- cobra isso: toda chamada a `pgp_sym_decrypt` no baseline tem de viver dentro
-- de uma definição de `fn_decrypt_oauth` — e a última delas (a que fica
-- instalada) tem de ter as três guardas antes da chamada.
--
-- Idempotente: `create or replace function` + os mesmos `revoke`/`grant`.

-- ---- Credencial de enfeite não derruba a leitura (migration 0240) ----
--
-- Racional completo no cabeçalho desta migration. Em uma linha: não tente
-- decifrar o que não pode ser cifra — devolva null, que é o contrato que os
-- leitores já tratam.
create or replace function public.fn_decrypt_oauth(ciphertext bytea) returns text
    language plpgsql security definer
    set search_path to 'public', 'private', 'extensions', 'pg_temp'
    as $$
declare
  k text := private.fn_oauth_key();
begin
  -- 1. Sem valor não há credencial (comportamento que a função já tinha).
  if ciphertext is null then
    return null;
  end if;

  -- 2. Curto demais para ser pacote deste par: o menor que fn_encrypt_oauth
  --    produz (texto vazio, aes256) tem 66 bytes — medido. Abaixo disso é
  --    sentinela (`\x00`, o byte de enfeite das rotas de sessão), bytea vazio,
  --    lixo ou truncamento.
  if octet_length(ciphertext) < 66 then
    return null;
  end if;

  -- 3. Pacote PGP começa com o bit 7 ligado (o real medido: 0xC3). Sem cara de
  --    pacote é JSON em claro, hex ou texto — e o tamanho sozinho não pega isso.
  --    Esta linha vem DEPOIS da de tamanho de propósito: `get_byte()` em bytea
  --    vazio estoura com `index 0 out of valid range, 0..-1` — medido.
  if get_byte(ciphertext, 0) < 128 then
    return null;
  end if;

  -- Daqui para baixo só chega pacote de verdade: se não abrir, é chave mestra
  -- trocada ou dado corrompido, e isso tem de aparecer.
  return pgp_sym_decrypt(ciphertext, k);
end$$;

-- Mesma ACL da 0041/0116: só service_role. Não há motivo para reabrir, e a
-- função lê a chave mestra.
revoke all on function public.fn_decrypt_oauth(bytea) from public, anon, authenticated;
grant execute on function public.fn_decrypt_oauth(bytea) to service_role;

notify pgrst, 'reload schema';
