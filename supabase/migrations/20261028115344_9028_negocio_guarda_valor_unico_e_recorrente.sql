-- manifest: **O negócio guarda o valor ÚNICO e o RECORRENTE (#3602, fatia 1).** `crm_leads.value_cents` continua sendo o valor único (setup, implantação, matrícula) e ganha três vizinhos: `recurring_value_cents` (bigint em centavos, MESMA régua do valor único), `recurring_period` (a v1 conhece `monthly`) e `recurring_months` (duração; nulo = sem prazo). Nada é somado: as três colunas nascem nulas, então todo negócio de valor único fica idêntico ao de antes — o card e o painel só desenham o segundo trecho quando há recorrência. Os CHECKs recusam mensalidade negativa, periodicidade fora de `monthly`, duração fora de 1..600 e o trio órfão (recorrente nulo exige periodicidade e duração nulas; recorrente presente exige periodicidade). Painéis, previsão do funil, Meta de vendas, Desempenho e relatório de carteira ficam para as fatias seguintes desta issue. Idempotente.
-- ---- valor recorrente do negócio (migration 9028) ----
--
-- Issue #3602, FATIA 1 — só o NEGÓCIO guarda os dois valores.
--
-- ─── A dor ────────────────────────────────────────────────────────────────
--
-- Num contrato de setup + mensalidade (agência, clínica, escola, software),
-- o negócio guardava UM número. Quem vendia R$ 3.000 de implantação e R$ 500
-- por mês tinha duas saídas ruins: gravar só o setup — e o contrato parece 6×
-- menor do que é — ou somar tudo — e ninguém sabe quanto entra todo mês. O
-- segundo caso é o pior: o número passa a existir, mas perde as duas
-- grandezas que o formavam, e nenhum relatório consegue separá-las depois.
--
-- ─── A decisão ────────────────────────────────────────────────────────────
--
-- `value_cents` NÃO muda de significado: continua sendo o valor ÚNICO da
-- fatia #3172 (moeda do negócio, ×100 em qualquer moeda — inclusive guarani).
-- A recorrência ganha colunas PRÓPRIAS, e nenhuma delas é derivada da outra.
-- A regra que o produto assume é a mais simples que responde as duas
-- perguntas que importam ("quanto entrou?" e "quanto entra todo mês?"):
--
--   recurring_value_cents bigint — a mensalidade, em centavos, `>= 0`;
--   recurring_period      text   — `monthly` na v1 (vocabulário aberto, mas o
--                                  CHECK fecha em `monthly`: aceitar texto
--                                  livre deixaria "yearly" gravado sem
--                                  nenhuma régua que o multiplique);
--   recurring_months      integer — duração em meses, `1..600`; NULO = sem
--                                  prazo, que é diferente de "12 meses".
--
-- `bigint` e não `integer`: é a mesma largura do `value_cents`. Um contrato em
-- guarani passa de R$ 21 milhões em centavos, e a coluna irmã não pode ser
-- menor que a que ela acompanha.
--
-- ─── A coerência do trio é do BANCO, não da tela ──────────────────────────
--
-- O CHECK `crm_leads_recorrencia_coerente` fecha as duas metades do trio:
-- recorrente NULO exige periodicidade e duração nulas (senão sobra duração de
-- um contrato que não existe); recorrente PRESENTE exige periodicidade (senão
-- ninguém sabe contra o quê multiplicar). A coluna "sem prazo" continua nula
-- de propósito: é assim que ela não mente.
--
-- A escrita que vem da tela já respeita isso pela régua pura
-- (`lib/leads/valor-recorrente.ts`), e o CHECK existe para quem escreve por
-- fora — psql, importação, integração, MCP de terceiro.

alter table public.crm_leads
  add column if not exists recurring_value_cents bigint,
  add column if not exists recurring_period      text,
  add column if not exists recurring_months      integer;

-- Auto-cura para o clone que já tenha rodado uma versão anterior desta
-- migration e por isso perdeu uma das colunas.
alter table public.crm_leads add column if not exists recurring_value_cents bigint;
alter table public.crm_leads add column if not exists recurring_period      text;
alter table public.crm_leads add column if not exists recurring_months      integer;

-- ── CHECKs (idempotentes: Postgres não tem `add constraint if not exists`) ─

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.crm_leads'::regclass
       and conname  = 'crm_leads_recurring_value_cents_nao_negativo'
  ) then
    alter table public.crm_leads
      add constraint crm_leads_recurring_value_cents_nao_negativo
      check (recurring_value_cents is null or recurring_value_cents >= 0);
  end if;

  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.crm_leads'::regclass
       and conname  = 'crm_leads_recurring_period_conhecido'
  ) then
    alter table public.crm_leads
      add constraint crm_leads_recurring_period_conhecido
      check (recurring_period is null or recurring_period = 'monthly');
  end if;

  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.crm_leads'::regclass
       and conname  = 'crm_leads_recurring_months_no_prazo'
  ) then
    alter table public.crm_leads
      add constraint crm_leads_recurring_months_no_prazo
      check (recurring_months is null or recurring_months between 1 and 600);
  end if;

  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.crm_leads'::regclass
       and conname  = 'crm_leads_recorrencia_coerente'
  ) then
    alter table public.crm_leads
      add constraint crm_leads_recorrencia_coerente
      check (
        (recurring_value_cents is null
          and recurring_period is null
          and recurring_months is null)
        or (recurring_value_cents is not null and recurring_period is not null)
      );
  end if;
end
$$;

-- ── Comentários (guardados por `to_regclass`: o baseline reaplica este bloco) ─

do $$
begin
  if to_regclass('public.crm_leads') is not null then
    comment on column public.crm_leads.recurring_value_cents is
      'Mensalidade do negócio em centavos (fatia 1 da #3602), separada do value_cents, que continua sendo o valor único (setup, implantação, matrícula). Nula = negócio sem recorrência.';
    comment on column public.crm_leads.recurring_period is
      'Periodicidade da recorrência; a v1 conhece monthly. Preenchida sempre que recurring_value_cents não é nulo (o CHECK crm_leads_recorrencia_coerente exige).';
    comment on column public.crm_leads.recurring_months is
      'Duração do contrato em meses (1..600). Nula = sem prazo, que NÃO é 12 meses: é contrato aberto.';
  end if;
end
$$;

-- ── Privilégio ────────────────────────────────────────────────────────────
-- Coluna nova herda o GRANT da TABELA, e `crm_leads` já tem o ACL no baseline;
-- o corte de 30/10 só tira o grant automático de tabela NOVA. Restate explícito
-- para quem lê a migration não precisar caçar o ACL no baseline — sem abrir
-- nada que já não estivesse aberto (e sem tocar no grant legado de `anon`, que
-- esta fatia não tem por que mexer).
grant select, insert, update, delete on public.crm_leads to authenticated;
grant all on public.crm_leads to service_role;

-- ── Travas de suporte (migration 0274) ────────────────────────────────────
-- DEPOIS das colunas: a trava nasce vendo a tabela como ela é agora. Chamada
-- antes, ela fixaria a lista de colunas sem as três desta migration e o
-- suporte voltaria a alcançar dado que não deveria.
do $f$ begin perform public.fn_aplicar_travas_de_suporte(); end $f$;
