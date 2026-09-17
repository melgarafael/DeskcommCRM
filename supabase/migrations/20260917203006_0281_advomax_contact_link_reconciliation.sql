-- 0245 — preserva o e-mail do atendente que criou um vínculo pending.
-- A reconciliação precisa repetir a autorização no Advomax com a identidade
-- original; um usuário técnico global poderia atravessar escritórios.
alter table public.advomax_contact_links
  add column if not exists created_by_email text;

create index if not exists idx_advomax_contact_links_pending
  on public.advomax_contact_links (updated_at asc)
  where status = 'pending';

notify pgrst, 'reload schema';
