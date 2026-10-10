-- 0149 — a mensagem editada e a mensagem apagada, do lado de fora.
--
-- ─── O que estava invisível ────────────────────────────────────────────────
--
-- O cliente edita o que escreveu no WhatsApp, ou apaga. O atendente do CRM
-- continua lendo a versão velha — ou lendo uma mensagem que, do lado do
-- cliente, não existe mais. Não há erro em lugar nenhum: o evento chega ao
-- webhook (quando assinado), o parser não o reconhece, a rota responde 200, e a
-- linha do banco fica como estava.
--
-- Relatado olhando a tela: o dono editou uma mensagem no celular e ela seguiu
-- com o texto antigo no inbox.
--
-- Isso é pior que uma falha visível. Combinar preço, prazo ou endereço a partir
-- de um texto que o cliente já corrigiu leva a um erro que ninguém consegue
-- rastrear depois — os dois lados juram ter lido coisas diferentes, e os dois
-- estão certos.
--
-- ─── Por que duas colunas, e não uma de estado ─────────────────────────────
--
-- Editada e apagada são coisas DIFERENTES para quem lê: a editada continua
-- valendo e o texto novo é o que conta; a apagada deixou de valer e o texto não
-- pode mais ser mostrado. Uma coluna `estado text` colapsaria as duas e obrigaria
-- a UI a perguntar "qual dos dois?" antes de decidir o que renderizar.
--
-- Guardam TIMESTAMP e não booleano porque a pergunta que aparece depois é
-- "quando?" — "editada agora" e "editada ontem" pedem leituras diferentes numa
-- negociação, e um booleano joga fora a resposta antes de alguém perguntar.
--
-- ─── O corpo é sobrescrito, e o original não é guardado ────────────────────
--
-- Deliberado. O que o CRM mostra tem que ser o que o cliente vê AGORA — é essa
-- a divergência que este arquivo existe para fechar. Guardar as versões
-- anteriores é outra feature (histórico de edição), com tela e política de
-- retenção próprias; fazê-la pela metade aqui deixaria dado pessoal acumulado
-- num campo que ninguém mostra e que a anonimização LGPD não conhece.
--
-- Idempotente e aditiva: só acrescenta colunas nulas. Nenhuma linha existente
-- passa a violar nada, e re-aplicar não duplica efeito.

alter table public.messages
  add column if not exists edited_at timestamptz;

comment on column public.messages.edited_at is
  'Quando o AUTOR editou esta mensagem no aplicativo (evento do canal). NULL = nunca editada. O corpo em `body` já é a versão nova; esta coluna existe para a tela poder dizer que houve edição, o que muda a leitura de um combinado.';

alter table public.messages
  add column if not exists revoked_at timestamptz;

comment on column public.messages.revoked_at is
  'Quando o AUTOR apagou esta mensagem no aplicativo ("apagar para todos"). NULL = no ar. A linha NÃO é removida: sumir com ela apagaria o contexto das mensagens vizinhas e o histórico de quem atendeu. A tela mostra o lugar vazio, não o texto.';
