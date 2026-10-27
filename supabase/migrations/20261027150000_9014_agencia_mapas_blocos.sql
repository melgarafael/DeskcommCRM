-- manifest: área da agência, mapas no estilo do Fluxo — a espécie de cada bloco (a paleta: Apresentação, Gravação, Edição, Publicação, Aviso…), configuração por bloco, novos efeitos no motor (aviso ao cliente, publicação, esperar data, nota) e o vínculo do bloco com o envio e o post que ele criou
--
-- Spec: docs/agencia/plano-ajustes-2026-10-27.md, item 5.

alter table public.agencia_mapa_blocos add column if not exists especie text not null default 'tarefa';
alter table public.agencia_mapa_blocos add column if not exists config jsonb not null default '{}'::jsonb;
alter table public.agencia_mapa_blocos add column if not exists envio_id uuid references public.agencia_aprovacoes(id) on delete set null;
alter table public.agencia_mapa_blocos add column if not exists publicacao_id uuid references public.agencia_publicacoes(id) on delete set null;
create index if not exists agencia_mapa_blocos_envio on public.agencia_mapa_blocos (envio_id) where envio_id is not null;
create index if not exists agencia_mapa_blocos_publicacao on public.agencia_mapa_blocos (publicacao_id) where publicacao_id is not null;

-- Blocos antigos (Fase 8a): marco continua marco; o resto é tarefa livre.
update public.agencia_mapa_blocos set especie = 'marco' where tipo = 'marco' and especie = 'tarefa';

alter table public.agencia_mapa_blocos drop constraint if exists agencia_mapa_blocos_tipo;
alter table public.agencia_mapa_blocos add constraint agencia_mapa_blocos_tipo
  check (tipo in ('tarefa','marco','aviso','publicacao','espera','nota'));
alter table public.agencia_mapa_blocos drop constraint if exists agencia_mapa_blocos_especie;
alter table public.agencia_mapa_blocos add constraint agencia_mapa_blocos_especie
  check (especie in ('apresentacao','proposta','fechamento','contrato','assinatura','grupo','formulario','ativacao','remarketing','pautas_ia','roteiro','storyboard','gravacao','subir_material','edicao','fotos','arte','legenda_ia','aprovacao','aviso','publicacao','identidade','perfis','arvore','acesso_crm','campanha','relatorio','site','automacao','assessoria','tarefa','marco','espera','nota'));
alter table public.agencia_mapa_blocos drop constraint if exists agencia_mapa_blocos_config;
alter table public.agencia_mapa_blocos add constraint agencia_mapa_blocos_config check (jsonb_typeof(config) = 'object');
