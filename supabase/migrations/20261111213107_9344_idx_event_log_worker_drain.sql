-- manifest: Índice de drenagem assíncrona do worker em event_log ordenado por created_at asc com status pending

create index if not exists idx_event_log_worker_drain
  on public.event_log (created_at asc)
  where (status = 'pending'::text);
