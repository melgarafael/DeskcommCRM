-- manifest: **Campanha com envio rápido pelo número oficial.** `campaigns` ganha `velocidade` (`gradual` | `rapida`). `gradual` é o ritmo de sempre: uma mensagem por número a cada rodada do cron (uma por minuto). `rapida` manda em rajada, várias por segundo, dentro do limite de requisições do provedor e do nível diário da plataforma — só com modelo aprovado (número oficial), porque o número por QR é banido por volume.
--
-- ═══ Por que a campanha precisa de duas velocidades ═══
--
-- O despacho manda uma mensagem por número a cada rodada do cron. Para o número
-- por QR é a proteção contra banimento; para o oficial, onde o limite é da
-- plataforma (nível diário de contatos únicos e mensagens por segundo), uma
-- campanha de 500 pessoas levava 9 horas. Quem opera loja quer avisar a base
-- inteira de uma vez — uma oferta que vale "só hoje" não pode chegar à noite.
--
-- O gradual continua o padrão: é o mais seguro para a qualidade do número (a
-- campanha para sozinha no primeiro erro grave antes de alcançar todo mundo).
--
-- ═══ Por que o CHECK amarra rápida a modelo ═══
--
-- Rajada por QR é o caminho mais curto para o número ser banido. A regra vive
-- no banco além da API: uma campanha editada por fora (script, SQL) não escapa.
-- Antes do CHECK, a auto-cura devolve a `gradual` qualquer linha que o violaria.
--
-- Idempotente: `add column if not exists`, constraints recriadas por nome.

alter table public.campaigns
  add column if not exists velocidade text not null default 'gradual';

alter table public.campaigns drop constraint if exists campaigns_velocidade_check;
alter table public.campaigns
  add constraint campaigns_velocidade_check check (velocidade in ('gradual', 'rapida'));

update public.campaigns
   set velocidade = 'gradual'
 where velocidade = 'rapida'
   and message_mode <> 'template';

alter table public.campaigns drop constraint if exists campaigns_rapida_so_com_modelo;
alter table public.campaigns
  add constraint campaigns_rapida_so_com_modelo check (velocidade = 'gradual' or message_mode = 'template');

comment on column public.campaigns.velocidade is
  'gradual = uma mensagem por número a cada rodada (uma por minuto); rapida = rajada de várias por segundo, só com modelo aprovado (número oficial). Migration 0711.';
