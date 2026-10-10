-- ============================================================================
-- 0177 — O PRODUTO SABE QUANDO VOLTAR A FALAR, MAS NÃO SABE QUE HORA FOI
--        COMBINADA COM O CLIENTE
--
-- Hoje o DeskcommCRM sabe agendar um RETORNO — o sistema volta a falar com o
-- lead daqui a X — e isso mora em `cron_jobs` (kind='at', job_kind=
-- 'followup_turn'), escrito por `lib/followup/retorno-crm.ts`. É uma decisão
-- interna: o cliente não sabe, ninguém combinou nada com ele, e não ocupa a
-- hora de ninguém.
--
-- O que não existe é o oposto disso: DUAS PESSOAS COMBINARAM ESTAR JUNTAS ÀS
-- 14h DE QUINTA. A consulta da clínica, a visita do corretor, a call da
-- agência. Tem hora, tem dono, ocupa a agenda de um atendente, e o cliente
-- sabe — porque foi combinado com ele. Um dono de clínica que instala este
-- produto hoje marca consulta no caderno.
--
-- ─── Por que NÃO reusar `cron_jobs` nem `followup_enrollments` ─────────────
-- Já medi as duas e nenhuma responde a pergunta desta tabela.
--   * `cron_jobs` guarda "dispare tal coisa neste instante". Um compromisso
--     não é um disparo: ele existe entre o momento em que foi marcado e o
--     momento em que aconteceu, tem estado próprio (aguardando confirmação,
--     confirmado, realizado, faltou) e sobrevive ao instante que o dispara.
--   * `followup_enrollments` é lead sendo nutrido por um fluxo. Não tem hora
--     marcada com ninguém e não ocupa agenda.
-- Fundir os dois daria ao produto DUAS agendas cegas uma para a outra — a IA
-- marcando retorno num lugar e compromisso noutro, sem tela que mostre a
-- outra. Ficam separados, e a aresta entre eles está desenhada abaixo, no
-- índice `calendar_appointments_org_vivos_idx`.
--
-- ─── Por que NENHUMA tabela de jornada semanal ─────────────────────────────
-- Porque ela já existe: `attendant_availability.schedule` guarda
-- {timezone, windows[{dow,start,end}]}, é validada por `availabilityScheduleSchema`
-- (lib/schemas/routing.ts), é lida pelo roteamento de conversa
-- (`isWithinSchedule`, lib/routing/eligibility.ts) e tem tela em
-- app/app/team/_components/AttendantsClient.tsx. Duplicá-la faria o dono de
-- clínica configurar o horário do funcionário em DOIS lugares — anti-pattern
-- nº 2 do CLAUDE.md. A agenda LÊ aquela coluna; não escreve outra.
--
-- ⚠️ E lê com OUTRA RÉGUA, de propósito: para o roteamento, `windows` vazio
-- significa 24/7 (mensagem chega a qualquer hora); para a agenda, significa
-- "esta pessoa não publicou horário" ⇒ zero slots. Agenda 24/7 por omissão
-- deixaria marcar consulta às 3h da manhã. `isWithinSchedule` NÃO é tocada.
--
-- ─── DIRC, coluna a coluna onde houve dúvida ───────────────────────────────
--   * `lead_id` — REFERENCIAR, e o ponteiro já existe: `crm_lead_links`
--     aceita `target_kind='appointment'` desde antes desta migration
--     (baseline.sql, CHECK `crm_lead_links_target_kind_enum`). Coluna própria
--     seria um segundo mecanismo de vínculo para o mesmo fato — anti-pattern
--     nº 8. Não existe aqui.
--   * `contact_id` — INTEGRAR, com FK real: é QUEM VAI SER ATENDIDO e quem
--     recebe o lembrete. Precisa de integridade, e contato não é lead:
--     `crm_lead_links.lead_id` é NOT NULL, então um agendamento de contato que
--     ainda não virou lead não teria vínculo nenhum se dependesse só do link.
--   * campos do Google — DUPLICAR, deliberado e 1:1. Um agendamento tem no
--     máximo um evento espelho lá fora; tabela à parte para uma relação 1:1
--     seria um join em toda leitura da grade.
--   * duração/buffers/aviso — no MOLDE (`calendar_event_types`), não na cópia:
--     mudar "consulta passa a durar 50min" não pode reescrever o passado.
--
-- ─── Por que NÃO há constraint de sobreposição de horário ──────────────────
-- A ferramenta certa seria `exclude using gist (owner_user_id with =,
-- tstzrange(starts_at, ends_at) with &&)`. Medido: `btree_gist` NÃO está
-- disponível — nem no baseline (só `pgcrypto`), nem no prelude de
-- `scripts/test-db.sh` (uuid-ossp, pgcrypto, vector, citext, pg_trgm). A
-- constraint quebraria o `install` de todo clone. E, mesmo disponível, ela
-- proibiria o encaixe deliberado que uma recepção faz todo dia. Quem impede
-- overbooking acidental é o motor de slots, que é onde a regra pode ter
-- exceção; o banco guarda o fato.
--
-- ─── RLS ───────────────────────────────────────────────────────────────────
-- Org-flat nas cinco tabelas de agenda: a agenda de uma clínica é vista por
-- quem trabalha nela, e esconder o compromisso do colega quebraria o produto
-- (o requisito é filtro POR pessoa, não sigilo entre pessoas).
--
-- `calendar_connections` é a exceção e leva GATE: ela guarda token OAuth. Os
-- tokens são `bytea` cifrado por `fn_encrypt_oauth` (inúteis sem a chave, que
-- só `service_role` alcança), mas a linha diz de quem é a conta do Google e
-- qual o e-mail dela. Quem lê: o DONO da conexão, ou `manager`+. Defesa em
-- profundidade — a rota HTTP não é a única porta, o PostgREST também serve
-- esta tabela com a anon key + o JWT do usuário.
--
-- Aditiva e idempotente: seis tabelas NOVAS e uma coluna nova, nullable, numa
-- tabela existente. Nenhuma linha atual passa a violar nada — não há o que
-- deduplicar antes.
-- ============================================================================

-- ────────────────────────────────────────────────────────────────────────────
-- 1 · o molde: que tipos de compromisso esta organização marca
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.calendar_event_types (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,

  name text not null,
  -- Identificador legível e estável. NÃO é para URL pública (auto-agendamento
  -- ficou fora do escopo): serve para (a) impedir dois "Consulta" iguais na
  -- mesma organização e (b) dar à IA um handle que ela não alucina, ao
  -- contrário de um uuid. Renomear o tipo não muda o slug.
  slug text not null,
  description text,

  category text not null default 'outro',
  duration_minutes int not null default 30,
  buffer_before_minutes int not null default 0,
  buffer_after_minutes int not null default 0,
  minimum_notice_minutes int not null default 120,
  -- null = a grade anda de duração em duração. Preenchido, permite oferecer
  -- 09:00/09:15/09:30 para um serviço de 30min.
  slot_interval_minutes int,
  booking_window_days int not null default 60,

  color text,
  location_kind text not null default 'in_person',
  location_details text,
  requires_confirmation boolean not null default false,
  is_active boolean not null default true,

  -- ─── o lembrete, e por que ele é COLUNA e não detalhe de implementação ───
  -- Em canal oficial (meta_cloud, zernio) texto livre fora da janela de 24h é
  -- recusado — e o lembrete cai exatamente aí: a pessoa marca na terça, o
  -- lembrete sai na quinta, e ela não mandou mensagem desde então, que é o
  -- normal de quem já marcou. Medido em lib/channels/capabilities.ts:
  -- `freeformOutsideWindow` é true só para `waha`; meta_cloud e zernio exigem
  -- template, e o gate de envio (guardrails/before-send.ts) só abre a porta
  -- para `isTemplate === true`.
  --
  -- ⚠️ O que torna isto grave não é a recusa, é a FORMA dela: a API responde
  -- 200 com wamid e a Meta recusa a ENTREGA depois, pelo webhook (131047,
  -- re-engagement). Quem lê o 200 como "enviado" acha que funcionou. Sem esta
  -- coluna, num canal oficial, o lembrete NÃO SAI e o sistema ACHA QUE SAIU —
  -- o cliente falta à consulta e não há erro nenhum para investigar.
  --
  -- O mecanismo de mandar template já existe (`sendTemplateForSession`). O que
  -- não existia é o DADO que diz qual template este tipo de compromisso usa.
  reminder_enabled boolean not null default true,
  -- 1440 = 24h antes. É quanto tempo ANTES do compromisso o lembrete sai.
  reminder_minutes_before int not null default 1440,
  -- NULL = texto livre, que basta em WAHA. Preenchido, é o nome do template
  -- aprovado no provedor oficial. Cadastro e escolha de template são tela de
  -- outra wave; o que não podia era a coluna faltar.
  reminder_template_name text,

  -- `numeric`, NUNCA `int`: a lista é arrastável e o repo usa fractional
  -- indexing (CLAUDE.md § Modelagem, mesma razão de crm_leads.position_in_stage).
  position numeric not null default 1000,
  default_owner_user_id uuid references auth.users(id) on delete set null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint calendar_event_types_category_check check (category in (
    'consulta','procedimento','retorno','visita','vistoria',
    'reuniao','call','orcamento','demonstracao','outro'
  )),
  constraint calendar_event_types_location_kind_check check (location_kind in (
    'in_person','phone','whatsapp','video_link','google_meet'
  )),
  -- Mesma forma de crm_stages_color_format, e a mesma tolerância a maiúscula.
  -- (platform_branding.accent_hex exige minúscula; é cor de MARCA, outra régua.)
  constraint calendar_event_types_color_format
    check (color is null or color ~ '^#[0-9a-fA-F]{6}$'),
  constraint calendar_event_types_duracao_sensata
    check (duration_minutes between 5 and 1440),
  constraint calendar_event_types_intervalo_sensato
    check (slot_interval_minutes is null or slot_interval_minutes between 5 and 1440),
  constraint calendar_event_types_lembrete_sensato
    check (reminder_minutes_before between 0 and 43200),
  constraint calendar_event_types_buffers_nao_negativos
    check (buffer_before_minutes >= 0 and buffer_after_minutes >= 0
           and minimum_notice_minutes >= 0 and booking_window_days > 0)
);

create unique index if not exists calendar_event_types_org_slug_key
  on public.calendar_event_types (organization_id, slug);
create index if not exists calendar_event_types_org_ativos_idx
  on public.calendar_event_types (organization_id, position)
  where is_active;

comment on table public.calendar_event_types is
  'O MOLDE de um compromisso: quanto dura, com que folga, com que antecedência mínima se marca. Distinto de calendar_appointments, que é o compromisso marcado — mudar o molde não reescreve o que já foi combinado.';
comment on column public.calendar_event_types.slug is
  'Handle estável e legível dentro da organização. Não é URL pública: serve para a IA referenciar o tipo sem inventar uuid, e para impedir dois tipos com o mesmo nome.';
comment on column public.calendar_event_types.minimum_notice_minutes is
  'Antecedência mínima para marcar. 120 = ninguém marca para daqui a meia hora. É o que impede a agenda de aceitar um encaixe que o atendente não tem como cumprir.';
comment on column public.calendar_event_types.slot_interval_minutes is
  'De quanto em quanto tempo a grade oferece horário. NULL = de duração em duração.';
comment on column public.calendar_event_types.reminder_template_name is
  'Nome do template aprovado no provedor, para o lembrete. NULL = texto livre, que basta em WAHA. Em canal oficial (meta_cloud, zernio) texto livre fora da janela de 24h é aceito com 200 e tem a ENTREGA recusada depois pelo webhook — sem template, o lembrete não sai e o sistema acha que saiu.';
comment on column public.calendar_event_types.reminder_minutes_before is
  'Quantos minutos ANTES do compromisso o lembrete sai. 1440 = 24h.';
comment on column public.calendar_event_types.category is
  'consulta/procedimento/retorno = clínica; visita/vistoria = imobiliária; reuniao/call = serviços e agência; orcamento = obra e serviço; demonstracao = loja e software; outro = qualquer. Espelha os nichos de lib/onboarding/pacotes-de-funil.ts.';

-- ────────────────────────────────────────────────────────────────────────────
-- 2 · o compromisso marcado
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.calendar_appointments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,

  -- `set null`: apagar o molde não pode apagar o histórico do que já aconteceu.
  event_type_id uuid references public.calendar_event_types(id) on delete set null,

  title text not null,
  description text,

  starts_at timestamptz not null,
  ends_at timestamptz not null,
  -- O fuso em que a pessoa MARCOU. Guardado porque "quinta às 14h" é o que foi
  -- combinado; o instante UTC sozinho não sabe dizer isso depois de uma virada
  -- de horário de verão. Sem CHECK: a validação de fuso é do Intl, e o repo já
  -- tem o lugar dela — `fusoValido` em lib/tempo/fusos.ts, aplicado no Zod.
  time_zone text not null default 'America/Sao_Paulo',

  status text not null default 'confirmed',

  -- O ATENDENTE dono. `set null` e não cascade: o compromisso aconteceu mesmo
  -- que a pessoa saia da empresa depois.
  owner_user_id uuid references auth.users(id) on delete set null,

  -- QUEM VAI SER ATENDIDO. `restrict` acompanha conversations.contact_id e
  -- messages.contact_id — as duas únicas FKs RESTRICT do schema, e existem
  -- pela mesma razão: apagar um contato não pode apagar o histórico dele. Na
  -- prática a LGPD deste produto anonimiza em vez de apagar (CLAUDE.md § LGPD),
  -- então o RESTRICT nunca é o caminho normal — é o cinto.
  contact_id uuid references public.contacts(id) on delete restrict,
  conversation_id uuid references public.conversations(id) on delete set null,

  location_kind text not null default 'in_person',
  location_details text,
  meeting_url text,
  notes text,

  cancellation_reason text,
  cancelled_at timestamptz,
  -- A cadeia de remarcações. `set null` porque a remarcação sobrevive ao
  -- sumiço do compromisso original.
  rescheduled_from_id uuid references public.calendar_appointments(id) on delete set null,

  -- QUEM MARCOU. O par `created_by_*` espelha `created_by_user_id`, que já
  -- existe em crm_leads e crm_lead_links.
  -- ⚠️ Os VALORES seguem crm_lead_activities.actor_kind ('user','ai','system',
  -- 'rule','contact') e não o par 'human'/'agent' que a outra tabela usa,
  -- porque é na timeline do lead que esta autoria vai ser RENDERIZADA: gravar
  -- 'human' aqui e 'user' lá faria a tela mostrar duas palavras para a mesma
  -- pessoa. 'sync' é o único acréscimo, e não é ator do produto: significa que
  -- a linha nasceu de um evento que já existia na agenda externa.
  created_by_kind text not null default 'user',
  created_by_user_id uuid references auth.users(id) on delete set null,
  created_by_agent_id uuid references public.ai_agents(id) on delete set null,
  source text not null default 'ui',

  -- Lembrete: idempotência do lado do dado. Quem DISPARA é a fila
  -- (`cron_jobs` kind='at' agenda; `job_queue` executa), e o envio passa pela
  -- MESMA cadeia de saída do produto — janela horária, espaçamento, opt-out.
  -- Nenhum caminho novo de saída: esta base já pagou por uma automação com
  -- janela paralela.
  reminder_sent_at timestamptz,

  -- Espelho do Google. 1:1 e por isso mora aqui (DIRC: duplicar).
  google_connection_id uuid,
  google_calendar_id text,
  google_event_id text,
  google_ical_uid text,
  google_sequence int not null default 0,
  google_synced_at timestamptz,
  google_sync_error text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint calendar_appointments_status_check check (status in (
    'pending','confirmed','cancelled','completed','no_show'
  )),
  constraint calendar_appointments_location_kind_check check (location_kind in (
    'in_person','phone','whatsapp','video_link','google_meet'
  )),
  constraint calendar_appointments_created_by_kind_check check (created_by_kind in (
    'user','ai','system','contact','sync'
  )),
  constraint calendar_appointments_source_check check (source in (
    'ui','mcp','google_sync','public_page'
  )),
  constraint calendar_appointments_periodo_valido check (ends_at > starts_at),
  -- Regra de negócio em constraint SEPARADA da de vocabulário, de propósito:
  -- duas constraints casando `col in (...)` na mesma coluna fazem o extrator
  -- do invariante de vocabulário se recusar a escolher. É a mesma convivência
  -- de crm_leads.status com crm_leads_closed_at_consistency.
  constraint calendar_appointments_cancelamento_coerente check (
    (status <> 'cancelled' and cancelled_at is null)
    or (status = 'cancelled' and cancelled_at is not null)
  )
);

-- A grade: "o que há entre terça e domingo".
create index if not exists calendar_appointments_org_periodo_idx
  on public.calendar_appointments (organization_id, starts_at);
-- O filtro por pessoa, que é o requisito explícito da tela.
create index if not exists calendar_appointments_org_dono_idx
  on public.calendar_appointments (organization_id, owner_user_id, starts_at)
  where owner_user_id is not null;
-- A ARESTA COM O FOLLOW-UP (e com o Radar de Risco): "este lead tem consulta
-- marcada?". Quem tem compromisso vivo no futuro NÃO é lead parado, e cobrar
-- "ainda tem interesse?" de quem marcou para amanhã é o tipo de erro que faz
-- desinstalar o produto. Parcial nos dois estados vivos porque cancelado e
-- realizado não seguram ninguém. A consulta canônica, já que o vínculo com o
-- lead é polimórfico:
--   select 1 from crm_lead_links l join calendar_appointments a on a.id = l.target_id
--    where l.lead_id = $1 and l.target_kind = 'appointment'
--      and a.organization_id = $2 and a.status in ('pending','confirmed')
--      and a.starts_at > now();
create index if not exists calendar_appointments_org_vivos_idx
  on public.calendar_appointments (organization_id, starts_at)
  where status in ('pending','confirmed');
create index if not exists calendar_appointments_contato_idx
  on public.calendar_appointments (contact_id, starts_at desc)
  where contact_id is not null;
-- Idempotência do sync: o mesmo evento do Google não vira dois agendamentos.
-- O parceiro disto no código é a captura de `23505` no INSERT (CLAUDE.md
-- § Idempotência), não um SELECT-antes-de-inserir.
create unique index if not exists calendar_appointments_google_evento_key
  on public.calendar_appointments (organization_id, google_connection_id, google_event_id)
  where google_event_id is not null;

comment on table public.calendar_appointments is
  'O compromisso COMBINADO: hora marcada, com alguém, ocupando a agenda de um atendente. Distinto do RETORNO agendado (cron_jobs kind=at, job_kind=followup_turn), que é decisão interna do sistema, não ocupa agenda de ninguém e o cliente não sabe.';
comment on column public.calendar_appointments.time_zone is
  'O fuso em que foi marcado. "Quinta às 14h" é o que se combinou — o instante UTC sozinho não reconstrói isso depois de uma virada de horário de verão.';
comment on column public.calendar_appointments.created_by_kind is
  'user = pessoa da equipe pela tela; ai = agente de IA; system = o próprio produto; contact = o cliente (auto-agendamento, quando existir); sync = a linha nasceu de evento que já estava na agenda externa. Valores alinhados a crm_lead_activities.actor_kind, que é onde esta autoria aparece na tela.';
comment on column public.calendar_appointments.reminder_sent_at is
  'Carimbo de que o lembrete SAIU — idempotência do lado do dado, para remarcação ou reprocesso não avisarem duas vezes. Quem agenda o disparo é cron_jobs (kind=at); quem envia é a cadeia de saída do produto, com janela, espaçamento e opt-out.';
comment on column public.calendar_appointments.google_sequence is
  'O `sequence` do evento no Google. Ele exige que uma atualização venha com sequence >= o que está lá; guardar o nosso evita sobrescrever uma edição feita do lado de lá.';

-- ────────────────────────────────────────────────────────────────────────────
-- 3 · a exceção por data — a ÚNICA tabela nova de disponibilidade
-- ────────────────────────────────────────────────────────────────────────────
-- `attendant_availability.schedule` sabe dizer "atendo de segunda a sexta, das
-- 9h às 18h". Não sabe dizer "no dia 12 eu não atendo" nem "neste sábado, das
-- 9h ao meio-dia, atendo". Isso é informação NOVA — inflar o jsonb com ela é
-- que seria o lock-in do anti-pattern nº 6.
create table if not exists public.calendar_availability_exceptions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,

  exception_date date not null,
  -- true = este pedaço do dia NÃO tem atendimento (o caso comum: feriado,
  -- férias, congresso). false = tem atendimento AQUI mesmo que a jornada
  -- semanal diga que não (o sábado excepcional).
  is_unavailable boolean not null default true,

  -- Minutos desde 00:00, NO MESMO FUSO da jornada da pessoa
  -- (`attendant_availability.schedule.timezone`). Minutos inteiros e não
  -- `time`: elimina a classe inteira de bug de fuso que um `time` carrega.
  --
  -- ⚠️ NOT NULL com default, e não nullable, e a razão é uma armadilha de
  -- Postgres: numa UNIQUE, NULL não colide com NULL. Com `start_minute`
  -- nullable, dois "dia 12 bloqueado o dia todo" para a mesma pessoa passariam
  -- os dois, em silêncio, e a tela mostraria a exceção duplicada. Dia inteiro
  -- é (0, 1440) — que é a mesma coisa e colide como deve.
  start_minute int not null default 0,
  end_minute int not null default 1440,
  reason text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint calendar_exceptions_faixa_valida
    check (start_minute >= 0 and end_minute <= 1440 and end_minute > start_minute)
);

create unique index if not exists calendar_exceptions_pessoa_dia_faixa_key
  on public.calendar_availability_exceptions (organization_id, user_id, exception_date, start_minute);
create index if not exists calendar_exceptions_org_dia_idx
  on public.calendar_availability_exceptions (organization_id, exception_date);

comment on table public.calendar_availability_exceptions is
  'O que a jornada semanal não sabe dizer: "neste dia não atendo" e "neste sábado atendo". A jornada continua morando em attendant_availability.schedule — esta tabela não a duplica, a excepciona.';
comment on column public.calendar_availability_exceptions.start_minute is
  'Minutos desde 00:00 no fuso da JORNADA da pessoa (attendant_availability.schedule.timezone), não em UTC. Dia inteiro = 0..1440.';
comment on column public.calendar_availability_exceptions.is_unavailable is
  'true = bloqueia esta faixa; false = ABRE esta faixa mesmo fora da jornada semanal.';

-- ────────────────────────────────────────────────────────────────────────────
-- 4 · a agenda conectada (BYO) — uma por PESSOA, não por organização
-- ────────────────────────────────────────────────────────────────────────────
-- `tenant_integrations` foi desenhada para OAuth com refresh e serviria — não
-- fosse a cardinalidade: ela tem UNIQUE (organization_id, provider), uma
-- conexão por organização. A agenda do Google é de cada atendente. Mudar
-- aquela unique reescreveria o contrato de uma tabela viva para servir outro
-- caso.
--
-- O que É reusado dela, porque é mecanismo e não modelo: a cifra
-- (`fn_encrypt_oauth`/`fn_decrypt_oauth`, pgp_sym AES-256 com a chave em
-- `private.fn_oauth_key()`, EXECUTE só para service_role), os nomes das
-- colunas de token, e o vocabulário de `status` — os SETE valores de
-- `tenant_integrations_status_check`, incluindo `rate_limited`, que é
-- justamente o estado que uma API de calendário mais produz.
create table if not exists public.calendar_connections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,

  provider text not null default 'google_calendar',
  account_email text not null,

  -- `bytea`, como as nove colunas cifradas do repo. Passe o valor CRU de
  -- fn_encrypt_oauth (com o `\x`); tirar o prefixo é regra de quem guarda
  -- cifrado dentro de jsonb, e aqui não é o caso.
  oauth_access_token_encrypted bytea,
  oauth_refresh_token_encrypted bytea,
  token_expires_at timestamptz,
  scopes text[] not null default array[]::text[],

  status text not null default 'connecting',
  last_sync_at timestamptz,
  last_sync_error text,
  -- Sync incremental da CONTA. O do calendário individual mora na tabela de
  -- baixo, porque o Google versiona por calendário.
  sync_token text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint calendar_connections_provider_check check (provider in ('google_calendar')),
  constraint calendar_connections_status_check check (status in (
    'connecting','healthy','token_expired','scope_missing','disconnected','rate_limited','error'
  ))
);

create unique index if not exists calendar_connections_conta_key
  on public.calendar_connections (organization_id, user_id, provider, account_email);
-- A varredura do worker de renovação: quem está para vencer. Parcial porque
-- conexão desconectada não se renova.
create index if not exists calendar_connections_renovacao_idx
  on public.calendar_connections (token_expires_at)
  where status in ('healthy','rate_limited') and token_expires_at is not null;
create index if not exists calendar_connections_org_pessoa_idx
  on public.calendar_connections (organization_id, user_id);

comment on table public.calendar_connections is
  'A conta de agenda externa que UMA PESSOA conectou. Uma por atendente, e por isso não cabe em tenant_integrations, que é uma por organização e por provedor.';
comment on column public.calendar_connections.status is
  'connecting = o OAuth começou e ainda não voltou; healthy = renovando e sincronizando; token_expired = o refresh falhou com invalid_grant e SÓ a pessoa resolve, reconectando; scope_missing = conectou sem a permissão de calendário; rate_limited = o Google recusou por volume e vale tentar depois; disconnected = a pessoa desligou; error = falha que não se encaixa nas anteriores. Vocabulário idêntico ao de tenant_integrations.status — mesma pergunta, mesma palavra.';
comment on column public.calendar_connections.oauth_access_token_encrypted is
  'Cifrado por public.fn_encrypt_oauth (pgp_sym AES-256). NUNCA em claro. A chave vive em private.fn_oauth_key() e só service_role executa a decifragem.';
comment on column public.calendar_connections.token_expires_at is
  'Quando o access_token vence (~1h no Google). É o que o worker de renovação varre. Sem esse worker a integração morre em uma hora — e é por isso que o índice calendar_connections_renovacao_idx existe desde o primeiro dia, e não depois.';

-- ────────────────────────────────────────────────────────────────────────────
-- 5 · quais agendas daquela conta contam
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.calendar_connection_calendars (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  connection_id uuid not null references public.calendar_connections(id) on delete cascade,

  external_calendar_id text not null,
  name text not null,
  is_primary boolean not null default false,
  -- O que este produto pergunta a cada agenda de fora: "você ocupa o horário
  -- desta pessoa?" e "você recebe o que eu marcar?". São perguntas diferentes:
  -- a agenda de aniversários ocupa nada e recebe nada; a pessoal ocupa e não
  -- recebe; a de trabalho faz as duas.
  counts_for_conflicts boolean not null default true,
  is_destination boolean not null default false,
  sync_token text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists calendar_connection_calendars_key
  on public.calendar_connection_calendars (organization_id, connection_id, external_calendar_id);
-- Só UM destino por conexão: se dois calendários recebessem, o mesmo
-- compromisso apareceria duas vezes na agenda da pessoa.
create unique index if not exists calendar_connection_calendars_um_destino_key
  on public.calendar_connection_calendars (connection_id)
  where is_destination;

comment on table public.calendar_connection_calendars is
  'As agendas dentro de uma conta conectada, e o que cada uma faz por nós: ocupar horário (counts_for_conflicts) e/ou receber o que marcamos (is_destination). São perguntas independentes.';

-- ────────────────────────────────────────────────────────────────────────────
-- 6 · o que veio de fora e ocupa a hora
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.calendar_external_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  connection_id uuid not null references public.calendar_connections(id) on delete cascade,

  external_calendar_id text not null,
  external_event_id text not null,
  title text,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  is_all_day boolean not null default false,
  status text not null default 'confirmed',
  -- O vocabulário é do próprio Google: `opaque` ocupa o horário, `transparent`
  -- não. Um evento marcado como livre lá não pode bloquear horário aqui.
  transparency text not null default 'opaque',
  external_updated_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint calendar_external_events_status_check check (status in (
    'confirmed','tentative','cancelled'
  )),
  constraint calendar_external_events_transparency_check check (transparency in (
    'opaque','transparent'
  )),
  constraint calendar_external_events_periodo_valido check (ends_at > starts_at)
);

create unique index if not exists calendar_external_events_key
  on public.calendar_external_events (organization_id, connection_id, external_calendar_id, external_event_id);
-- A pergunta do motor de slots: "o que ocupa esta janela?". Parcial, porque
-- evento cancelado ou marcado como livre não ocupa nada e só engordaria o
-- índice.
create index if not exists calendar_external_events_ocupam_idx
  on public.calendar_external_events (organization_id, external_calendar_id, starts_at)
  where status <> 'cancelled' and transparency = 'opaque';

comment on table public.calendar_external_events is
  'Espelho, somente-leitura, do que já existe na agenda conectada. Ocupa horário e aparece na grade, mas não é compromisso NOSSO: não tem lead, não tem estado de atendimento e nunca é reescrito por nós.';
comment on column public.calendar_external_events.transparency is
  'opaque = ocupa o horário; transparent = a pessoa marcou como livre lá, e não bloqueia nada aqui. É o vocabulário do próprio Google.';

-- ────────────────────────────────────────────────────────────────────────────
-- 7 · a cor da pessoa, na tabela de membros
-- ────────────────────────────────────────────────────────────────────────────
-- A cor é DA PESSOA NAQUELA ORGANIZAÇÃO, e por isso mora em user_organizations
-- e não em auth.users: quem trabalha em duas organizações pode ser verde numa
-- e azul na outra, e a cor de uma não vaza para a outra.
alter table public.user_organizations
  add column if not exists calendar_color text;

alter table public.user_organizations
  drop constraint if exists user_organizations_calendar_color_format;
alter table public.user_organizations
  add constraint user_organizations_calendar_color_format
  check (calendar_color is null or calendar_color ~ '^#[0-9a-fA-F]{6}$');

comment on column public.user_organizations.calendar_color is
  'Cor desta pessoa na grade da Agenda, nesta organização. NULL = a tela deriva uma cor estável do user_id, para ninguém nascer sem cor. ⚠️ A policy de SELECT desta tabela é self-OU-manager+: um `agent` NÃO lê a linha dos colegas pelo PostgREST. A tela recebe as cores pela rota que já monta o roster com service role (GET /api/v1/team), não por leitura direta.';

-- ────────────────────────────────────────────────────────────────────────────
-- 8 · o cascade que o polimórfico não tem
-- ────────────────────────────────────────────────────────────────────────────
-- O vínculo com o lead vai por `crm_lead_links` (target_kind='appointment'), e
-- `target_id` é polimórfico: não pode ter FK, logo não tem ON DELETE. Apagar
-- um agendamento deixaria o vínculo apontando para o nada.
--
-- O caminho NORMAL é que agendamento não se apague: cancela-se (`status`
-- 'cancelled'), porque o cancelamento é informação de negócio e a aba
-- Histórico existe para mostrá-lo. Mas "ninguém deveria apagar" é prosa, e
-- prosa não é guarda. Este trigger é o mecanismo.
create or replace function public.fn_limpar_vinculos_do_agendamento()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  delete from public.crm_lead_links
   where organization_id = old.organization_id
     and target_kind = 'appointment'
     and target_id = old.id;
  return old;
end;
$$;

-- Função de trigger não exige EXECUTE de quem dispara o DELETE, então revogar
-- das três origens não a quebra — e mantém a função fora da lista de exceções
-- do invariante de hardening, que é congelada.
revoke execute on function public.fn_limpar_vinculos_do_agendamento() from public, anon, authenticated;
grant  execute on function public.fn_limpar_vinculos_do_agendamento() to service_role;

drop trigger if exists trg_limpar_vinculos_do_agendamento on public.calendar_appointments;
create trigger trg_limpar_vinculos_do_agendamento
  after delete on public.calendar_appointments
  for each row
  execute function public.fn_limpar_vinculos_do_agendamento();

-- ────────────────────────────────────────────────────────────────────────────
-- 9 · updated_at
-- ────────────────────────────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array[
    'calendar_event_types','calendar_appointments','calendar_availability_exceptions',
    'calendar_connections','calendar_connection_calendars','calendar_external_events'
  ]
  loop
    execute format('drop trigger if exists trg_%s_updated_at on public.%I', t, t);
    execute format(
      'create trigger trg_%s_updated_at before update on public.%I
         for each row execute function public.fn_set_updated_at()', t, t);
  end loop;
end
$$;

-- ────────────────────────────────────────────────────────────────────────────
-- 10 · tenancy E PAPEL
-- ────────────────────────────────────────────────────────────────────────────
-- A primeira versão deste bloco dava `for all` só-tenancy às cinco tabelas de
-- agenda, e o invariante `rbac-config-ia-canais` reprovou as cinco. Ele estava
-- certo, e não é allowlist: `DIVIDA_RBAC_CONHECIDA` é uma CATRACA — a lista
-- congelada das tabelas que JÁ nasceram só-tenancy antes da migration 0150. O
-- teste se chama "a dívida de RBAC não cresce", e pôr tabela nova ali é
-- exatamente o movimento que ele existe para impedir.
--
-- A razão de fundo (migration 0150): `requireRole()` na rota Next NÃO é a única
-- porta. O PostgREST é exposto ao browser por construção — URL e anon key vão no
-- bundle — e um usuário logado fala com ele direto, com o próprio JWT. Uma
-- policy `for all` só-tenancy significa que o papel mais fraco do tenant escreve
-- tudo o que a organização tem.
--
-- Por tabela, e cada uma tem uma razão diferente:
--
--   event_types            lê membro · escreve manager+   é CONFIGURAÇÃO do
--     negócio: quanto dura uma consulta, que folga tem, quando se pode marcar.
--     O atendente usa; quem define é quem responde pelo negócio.
--
--   appointments           lê membro · escreve agent+     é a OPERAÇÃO do dia.
--     Marcar, remarcar e cancelar é o trabalho do atendente. O `viewer` vê a
--     agenda e não mexe nela.
--
--   availability_exceptions lê membro · escreve o DONO ou manager+
--     "No dia 12 eu não atendo" é da pessoa. Ela mesma escreve a sua, sem
--     depender de ninguém; manager+ escreve a dos outros porque escala é
--     trabalho de quem coordena.
--
--   connection_calendars   acompanha a conexão · escreve ninguém
--     Ele é filho de `calendar_connections` e herda o escopo dela, como
--     `crm_lead_links` herda o do lead. Quem escreve é o callback do OAuth.
--
--   external_events        lê membro · escreve NINGUÉM além de service_role
--     Vem do sync e é espelho. Escrita humana aqui só teria um caso de uso:
--     corromper a fonte de conflito, fazendo a agenda marcar em cima de
--     compromisso real. Ausência de policy de escrita é a decisão.
--
-- Nenhuma leva `for all` só-tenancy, e por isso nenhuma precisa entrar na
-- catraca.

-- ─── os tipos de agendamento: configuração do negócio ─────────────────────
alter table public.calendar_event_types enable row level security;
drop policy if exists tenant_isolation_calendar_event_types_all on public.calendar_event_types;
drop policy if exists calendar_event_types_select on public.calendar_event_types;
create policy calendar_event_types_select on public.calendar_event_types
  for select using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );
drop policy if exists calendar_event_types_write on public.calendar_event_types;
create policy calendar_event_types_write on public.calendar_event_types
  using (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  )
  with check (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  );
revoke all on public.calendar_event_types from anon;

-- ─── os compromissos: a operação do dia ───────────────────────────────────
alter table public.calendar_appointments enable row level security;
drop policy if exists tenant_isolation_calendar_appointments_all on public.calendar_appointments;
drop policy if exists calendar_appointments_select on public.calendar_appointments;
create policy calendar_appointments_select on public.calendar_appointments
  for select using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );
drop policy if exists calendar_appointments_write on public.calendar_appointments;
create policy calendar_appointments_write on public.calendar_appointments
  using (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'agent'))
  )
  with check (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'agent'))
  );
revoke all on public.calendar_appointments from anon;

-- ─── as exceções: a agenda é de quem a vive ───────────────────────────────
alter table public.calendar_availability_exceptions enable row level security;
drop policy if exists tenant_isolation_calendar_availability_exceptions_all on public.calendar_availability_exceptions;
drop policy if exists calendar_availability_exceptions_select on public.calendar_availability_exceptions;
create policy calendar_availability_exceptions_select on public.calendar_availability_exceptions
  for select using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );
drop policy if exists calendar_availability_exceptions_write on public.calendar_availability_exceptions;
create policy calendar_availability_exceptions_write on public.calendar_availability_exceptions
  using (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and (user_id = auth.uid() or public.fn_role_at_least(organization_id, 'manager')))
  )
  with check (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and (user_id = auth.uid() or public.fn_role_at_least(organization_id, 'manager')))
  );
revoke all on public.calendar_availability_exceptions from anon;

-- ─── os calendários da conexão: herdam o escopo do pai ────────────────────
alter table public.calendar_connection_calendars enable row level security;
drop policy if exists tenant_isolation_calendar_connection_calendars_all on public.calendar_connection_calendars;
drop policy if exists calendar_connection_calendars_select on public.calendar_connection_calendars;
create policy calendar_connection_calendars_select on public.calendar_connection_calendars
  for select using (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and exists (
          select 1 from public.calendar_connections c
           where c.id = connection_id
             and (c.user_id = auth.uid()
                  or public.fn_role_at_least(c.organization_id, 'manager'))
        ))
  );
revoke all on public.calendar_connection_calendars from anon;

-- ─── o espelho do Google: leitura de todos, escrita de ninguém ────────────
alter table public.calendar_external_events enable row level security;
drop policy if exists tenant_isolation_calendar_external_events_all on public.calendar_external_events;
drop policy if exists calendar_external_events_select on public.calendar_external_events;
create policy calendar_external_events_select on public.calendar_external_events
  for select using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );
revoke all on public.calendar_external_events from anon;

alter table public.calendar_connections enable row level security;

drop policy if exists tenant_isolation_calendar_connections_all on public.calendar_connections;
drop policy if exists calendar_connections_dono_ou_manager_read on public.calendar_connections;
create policy calendar_connections_dono_ou_manager_read on public.calendar_connections
  for select using (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and (user_id = auth.uid() or public.fn_role_at_least(organization_id, 'manager')))
  );

-- Escrita não tem policy: quem conecta e desconecta é o callback do OAuth e o
-- worker de renovação, ambos com service role, e ambos filtram organization_id
-- de fonte confiável. Uma policy de escrita aqui só abriria caminho para
-- gravar token pelo PostgREST.
revoke all on public.calendar_connections from anon;

notify pgrst, 'reload schema';
