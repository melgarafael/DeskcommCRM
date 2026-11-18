-- manifest: **Campanha por transmissão do provedor.** `campaigns.velocidade` ganha `transmissao`: o provedor do número oficial recebe a lista inteira e o modelo aprovado, manda a todos de uma vez e devolve o relatório por destinatário. `campaigns.provider_broadcast_id` guarda o id da transmissão — é por ele que o eco de cada mensagem volta à campanha certa. Só com modelo aprovado, e só com variáveis de texto fixo (o provedor não recebe valor por destinatário).
--
-- ═══ Por que uma terceira velocidade ═══
--
-- A rápida (0711) manda em rajada, mas quem dispara é a rodada do cron, uma
-- mensagem por chamada. A transmissão entrega a lista ao provedor numa chamada:
-- a campanha aparece no painel de transmissões dele, com o relatório de cada
-- destinatário (enviado, entregue, lido, falhou e o motivo), e 500 pessoas saem
-- em segundos. Medido em 16/10/2026 com 2 destinatários: entregues em 1 a 3 s.
--
-- ═══ Por que o id da transmissão mora na campanha ═══
--
-- Cada mensagem da transmissão volta pelo webhook como uma saída que o CRM não
-- mandou. Sem o id, a ingestão a lia como "uma pessoa respondeu pelo celular" —
-- e calava o agente naquela conversa — e guardava "[Template: nome]" no lugar
-- do texto, então o agente não sabia o que a pessoa tinha recebido. Com o id, o
-- eco acha a campanha e o destinatário, e a linha nasce com o texto do modelo.
-- Único por organização: dois ecos nunca podem apontar para duas campanhas.
--
-- O CHECK `campaigns_rapida_so_com_modelo` (0711) já cobre a transmissão: tudo
-- que não é `gradual` exige modelo.
--
-- Idempotente: `add column if not exists`, constraint recriada por nome, índice
-- `if not exists`.

alter table public.campaigns
  add column if not exists provider_broadcast_id text;

alter table public.campaigns drop constraint if exists campaigns_velocidade_check;
alter table public.campaigns
  add constraint campaigns_velocidade_check check (velocidade in ('gradual', 'rapida', 'transmissao'));

create unique index if not exists campaigns_provider_broadcast_id_uidx
  on public.campaigns (organization_id, provider_broadcast_id)
  where provider_broadcast_id is not null;

comment on column public.campaigns.velocidade is
  'gradual = uma mensagem por número a cada rodada (uma por minuto); rapida = rajada de várias por segundo; transmissao = a lista inteira entregue ao provedor numa chamada. As duas últimas só com modelo aprovado (número oficial). Migrations 0711 e 0712.';

comment on column public.campaigns.provider_broadcast_id is
  'Id da transmissão no provedor (velocidade = transmissao). O eco de cada mensagem traz este id e volta por ele à campanha e ao destinatário. Migration 0712.';
