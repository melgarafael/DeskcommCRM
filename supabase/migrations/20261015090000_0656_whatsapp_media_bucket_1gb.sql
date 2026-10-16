-- manifest: atualiza o teto do bucket whatsapp-media para 1GB para permitir uploads e envios de videos pesados
update storage.buckets
   set file_size_limit = 1073741824
 where id = 'whatsapp-media';
