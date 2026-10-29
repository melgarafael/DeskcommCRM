-- manifest: Persiste no run a intenção restrita de refazer uma atualização; o default falso preserva pedidos antigos.
-- Forward nova: não altera a migration autoral de runtime_confirmation.
alter table public.system_update_runs
  add column if not exists force_requested boolean not null default false;
comment on column public.system_update_runs.force_requested is
  'Pedido restrito de reaplicar a atualização pelo agente do host; ausência ou false preserva o caminho normal.';
