-- manifest: remove FK redundante em calendar_service_professionals para sanar ambiguidade PGRST201 (closes #3219)
alter table public.calendar_service_professionals 
  drop constraint if exists calendar_service_professionals_organization_id_fkey;
