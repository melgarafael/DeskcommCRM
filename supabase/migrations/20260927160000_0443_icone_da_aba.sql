-- 0443 — Ícone da aba (favicon) opcional da instalação, subido em /admin/marca.
-- Aditiva: sem arquivo, a aba segue com o ícone desenhado por `app/icon.tsx`
-- (cor + inicial). Rollback de imagem não exige apagar coluna nem arquivo: o
-- código anterior não lê a coluna e volta ao ícone desenhado.
-- Só a instalação tem ícone: a aba é a mesma para todas as organizações, e o
-- login (anterior a qualquer organização) também a mostra.
-- Somente a rota `/api/v1/marca/logo` escreve o caminho, no mesmo bucket
-- `brand-logos` e sob o mesmo prefixo `platform/` do logo.

alter table public.platform_branding add column if not exists favicon_path text;
update public.platform_branding set favicon_path = null
 where favicon_path is not null
   and favicon_path !~ '^platform/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg)$';
alter table public.platform_branding drop constraint if exists platform_branding_favicon_path;
alter table public.platform_branding add constraint platform_branding_favicon_path check (
  favicon_path is null or
  favicon_path ~ '^platform/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg)$'
);
comment on column public.platform_branding.favicon_path is
  'Ícone da aba do navegador, subido pela tela. Caminho em brand-logos; null mantém o ícone desenhado (cor + inicial).';
