-- 0055: bucket privado whatsapp-media — binários de mídia do WhatsApp
-- (Onda 0 do épico inbox-multimodal). O acesso é exclusivamente via service
-- role (upload pelo worker, signed URL pelo endpoint) — sem policies de
-- storage.objects para anon/authenticated.
insert into storage.buckets (id, name, public, file_size_limit)
values ('whatsapp-media', 'whatsapp-media', false, 52428800)
on conflict (id) do update set file_size_limit = excluded.file_size_limit;
