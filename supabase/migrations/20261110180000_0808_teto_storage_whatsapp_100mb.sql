-- manifest: storage: expande teto de upload dos buckets whatsapp-media e internal-media para 100MB
--
-- 0808 — eleva file_size_limit de 50MB (52428800) para 100MB (104857600),
-- alinhando o storage ao teto oficial de documentos do WhatsApp.
update storage.buckets
   set file_size_limit = 104857600
 where id in ('whatsapp-media', 'internal-media');
