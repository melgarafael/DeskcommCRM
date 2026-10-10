-- Portas por EMPRESA (issue #1341) — o degrau que faltava na 0221.
--
-- A 0221 escolheu as portas POR VÍNCULO: cada pessoa monta o próprio menu. O que
-- não existia era a escolha da EMPRESA — a instalação inteira ver o mesmo
-- recorte, decidido por quem administra a organização. Sem ela, "cada empresa
-- escolhe as portas que quer ver" só podia ser feito convidado a convidado, e o
-- convite seguinte reabria tudo.
--
-- MESMA FORMA da 0221 (`{preset, destinos?}`) de propósito: é a mesma pergunta,
-- num nível acima. Assim o editor, o schema zod e a leitura tolerante do
-- `lerInterface` valem para os dois níveis sem uma segunda gramática.
--
-- `not null default '{"preset":"completa"}'` é o que impede esta migration de ser
-- uma mudança de comportamento disfarçada: a organização que não mexer em nada
-- continua exatamente como está, e a restrição só aparece quando alguém escolhe.
--
-- Isto é APRESENTAÇÃO, nunca autorização: quem decide o que cada papel alcança
-- continua sendo o papel, na aplicação. A coluna não participa de RLS, de policy
-- nem de função de autorização — de propósito.
alter table public.organizations
  add column if not exists interface_settings jsonb not null
  default '{"preset":"completa"}'::jsonb;

-- Mesmas guardas de forma da 0221, para o jsonb não ser depósito de arbitrário:
-- objeto com `preset` conhecido e, quando houver `destinos`, lista não vazia.
-- (`destinos: []` é recusado aqui porque é a única entrada que a aplicação não
-- consegue distinguir de "nenhuma porta escolhida" — e ela degrada para o menu
-- completo, que é o oposto de quem escolheu zero.)
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.organizations'::regclass
       and conname = 'organizations_interface_settings_shape'
  ) then
    alter table public.organizations
      add constraint organizations_interface_settings_shape
      check (
        jsonb_typeof(interface_settings) = 'object'
        and interface_settings ? 'preset'
        and interface_settings->>'preset' in ('completa', 'simplificada')
        and (
          not interface_settings ? 'destinos'
          or (
            jsonb_typeof(interface_settings->'destinos') = 'array'
            and interface_settings->'destinos' <> '[]'::jsonb
          )
        )
      );
  end if;
end $$;
