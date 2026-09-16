-- 0269 · Stories entra como terceiro destino do post preparado.
--
-- Stories não tem legenda (a API do Instagram não aceita `caption` nesse
-- destino) — a coluna `caption` continua `not null`, mas para stories o
-- valor gravado é string vazia, decisão do chamador (`lib/mcp/tools/instagram.ts`),
-- não deste schema.

alter table public.instagram_pending_posts
  drop constraint if exists instagram_pending_posts_destino_check;

alter table public.instagram_pending_posts
  add constraint instagram_pending_posts_destino_check
  check (destino in ('feed', 'reels', 'stories'));
