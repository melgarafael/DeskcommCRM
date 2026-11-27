-- manifest: o TikTok entra como canal de conversa (A21): `conversations.channel` passa a aceitar `tiktok`, o mesmo valor que o catálogo de redes (`SOCIAL_NETWORKS`, `inbox: true`) oferece. Sem isso, a primeira mensagem direta do TikTok morreria no INSERT com 23514 e o provedor reentregaria o webhook para sempre.
--
-- ─── O que entra ───────────────────────────────────────────────────────────
--
--   1. `'tiktok'` em `conversations_channel_check`. É a ÚNICA mudança de schema:
--      o contato usa `social_identity` (`tiktok:<conta>:<participante>`, a mesma
--      forma das outras redes) e a sessão já é `zernio_social` com
--      `metadata.social_platform = 'tiktok'`, então `channel_sessions` não muda.
--   2. Nenhuma coluna, função ou política nova. As regras do TikTok (janela de
--      48 h, teto de 10 respostas, uma imagem OU texto) vivem em código, nos
--      gates de envio — não no banco.
--
-- O teste `canal-da-conversa-banco-x-catalogo` exige que o CHECK e o catálogo
-- andem juntos: por isso `inbox: true` e esta migration saem no mesmo PR.
--
-- ─── Reaplicação ───────────────────────────────────────────────────────────
--
-- drop + add dentro de um bloco `do` (o `update.sh` roda sem `ON_ERROR_STOP`: um
-- drop solto sem o add deixaria a tabela sem guarda). Todo valor que existe hoje
-- em `conversations.channel` está na lista nova, então o `add` não reprova dado
-- antigo.

do $x$
begin
  alter table public.conversations drop constraint if exists conversations_channel_check;
  alter table public.conversations add constraint conversations_channel_check
    check (channel in ('whatsapp', 'instagram', 'facebook', 'telegram', 'webchat', 'tiktok'));
end
$x$;
