-- manifest: **O teto diário do número pode contar só a abordagem, por canal (#3851).** Até aqui o teto de warm-up e o `daily_message_limit` mediam todo DISPARO — a resposta a quem escreveu já saiu do teto na 9061, mas o follow-up de quem já foi abordado continuava gastando e esperando o teto, e era ele quem empurrava a próxima conversa para o dia seguinte. `channel_knobs.teto_so_abordagem` (NULL = desligado) liga a régua nova **por número**: com a opção ligada, o teto conta e barra só a 1ª mensagem a pessoa nova, e o follow-up de quem já foi abordado sai sem gastar nem esperar o teto — intervalo mínimo, janela horária, opt-out e os demais gates seguem valendo para todo envio. Para distinguir os dois casos no ledger, `pacing_ledger.abordagem` (boolean not null default **true**) marca a linha da abordagem; `loadPacingState` passa a contar as abordagens do dia ao lado da contagem de disparos, e `decidePacing` escolhe a contagem pelo knob. Default `true` e knob `NULL` = comportamento de hoje, byte a byte: toda linha antiga e todo escritor que não classifica conta no teto. Idempotente; espelho no apêndice do `baseline.sql`.
-- 9216 — o teto do dia pode contar só a abordagem (opção por canal, #3851).
--
-- Duas colunas, nenhuma função: não há grant a revogar nem SECURITY DEFINER
-- novo, então este bloco pode ficar depois da VARREDURA anon no apêndice.
--
-- `teto_so_abordagem` nasce NULL (não `false`) de propósito: NULL é "o canal não
-- escolheu", e é o que a ficha Anti-ban grava quando o Switch está no default
-- (`valorDeOverride`). Um `false` gravado por omissão congelaria a decisão de
-- hoje para quem só abriu a tela para declarar o aquecimento — foi exatamente o
-- defeito medido no `allow_sunday`.
alter table public.channel_knobs
  add column if not exists teto_so_abordagem boolean;
comment on column public.channel_knobs.teto_so_abordagem is
  'true = o teto diário (warm-up e daily_message_limit) conta só a 1ª mensagem a pessoa nova; follow-up de quem já foi abordado não gasta nem espera o teto. NULL/false = régua de sempre (conta todo disparo). Resposta nunca passa pelo teto (9061). Opção POR CANAL (#3851).';

-- `abordagem` nasce `true` (default) e não `false`: linha antiga não sabe se foi
-- abordagem ou follow-up, e a direção segura é CONTAR — o teto fica mais justo,
-- nunca mais frouxo, para quem ligar a opção depois. Só o gate de envio, que lê
-- o `send_ledger`, declara `false` com certeza.
alter table public.pacing_ledger
  add column if not exists abordagem boolean not null default true;
comment on column public.pacing_ledger.abordagem is
  'true = 1ª mensagem a pessoa nova (abordagem). false = follow-up de quem já foi abordado. Só a coluna `teto_so_abordagem` do canal faz o teto do dia ler isto; resposta é marcada por `resposta` e nunca conta (#3851).';
