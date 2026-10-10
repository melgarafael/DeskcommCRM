-- manifest: **A cor da marca pode ser diferente no tema escuro (#2482), do mesmo jeito que o logo já era par.** `platform_branding` tem UMA cor (`accent_hex`) e a `derivarMarca` deriva os DOIS temas dela, então marca muito escura ou muito clara força um dos temas a um tom que a marca não usa e o cliente não tem como corrigir sem perder o outro (medido na issue: com `#1C261D`, o escuro saía `#8a948b`, fora da paleta). Coluna OPCIONAL `accent_dark_hex`, mesmo CHECK `^#[0-9a-f]{6}$` de `accent_hex`: `null` = os dois temas seguem derivando da cor principal, byte a byte — a retrocompatibilidade mora na AUSÊNCIA do dado, não em ramo de código. Apêndice idêntico no `supabase/baseline.sql` (o `update.sh` aplica ele antes da imagem; sem a coluna, o `select` de `lib/branding/instalacao.ts` é tudo-ou-nada e a instalação cai no `.env`, com aviso). Hex inválido é recusado pela action antes de gravar; a segunda semente nunca derruba a primeira — vira `motivo` e o escuro volta a derivar do claro.
-- #2482 — a COR DA MARCA NO TEMA ESCURO, o par que faltava.
--
-- `platform_branding` tem UMA cor (`accent_hex`) e a `derivarMarca` deriva os
-- DOIS temas dela. Marca muito escura ou muito clara força um dos temas a um
-- tom que a marca não usa, e o cliente não tem como corrigir sem perder o
-- outro (medido na issue: `#1c261d` no claro dá `#8a948b` no escuro, fora da
-- paleta). A tela `/admin/marca` já tinha o par de LOGO; este é o par de cor.
--
-- Coluna OPCIONAL: `null` = os dois temas continuam derivando de `accent_hex`,
-- byte a byte como antes. Retrocompatibilidade por ausência de dado, não por
-- código especial — o leitor velho não enxerga a coluna (`.catchall` do
-- envelope e a regra "campo novo que o leitor velho ignora não bumpa formato",
-- `lib/branding/schema.ts`).
--
-- MESMO CHECK de `accent_hex` (`^#[0-9a-f]{6}$`): duas definições de "hex
-- válido" divergem, e a que perde é sempre a que ninguém olha. A action já
-- normaliza antes de gravar (`#FFF` → `#ffffff`), então o CHECK é a rede, não
-- o caminho normal.
alter table public.platform_branding
  add column if not exists accent_dark_hex text;

alter table public.platform_branding
  drop constraint if exists platform_branding_accent_dark_hex;

alter table public.platform_branding
  add constraint platform_branding_accent_dark_hex check (
    accent_dark_hex is null or accent_dark_hex ~ '^#[0-9a-f]{6}$'
  );

comment on column public.platform_branding.accent_dark_hex is
  'Segunda semente da marca (#2482), só para o tema ESCURO: o bloco [data-theme=dark] deriva dela pela mesma derivarMarca, com os mesmos pisos de contraste. NULL = os dois temas derivam de accent_hex, como sempre. --color-brand continua sendo accent_hex (e-mail e logo nao tem tema). Lida/escrita so server-side (service_role), como o resto da tabela.';
