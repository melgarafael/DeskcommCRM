-- 0081 — `detected_at` deixa de ser dado do cliente e vira CARIMBO do banco
--
-- O DEFEITO, encontrado rodando o observador de travessia (peça 5) e não por
-- inspeção: `since` deriva de `last_activity_at`, que o trigger carimba com o
-- `now()` do BANCO. `detected_at` vinha do processo Node. Medido nesta máquina:
-- **o banco está 2 segundos à frente**. Um negócio tocado no instante anterior à
-- passada do worker produzia `since > detected_at`, violava
-- `crm_lead_risk_states_since_no_passado`, e o worker INTEIRO abortava.
--
-- Omitir a coluna no `upsert` NÃO resolve, e é o detalhe que engana: o default
-- só se aplica no INSERT. No UPDATE — que é o caminho de toda travessia depois
-- da primeira — a coluna mantém o valor ANTIGO, e aí o `since` novo fica maior
-- que um `detected_at` de dias atrás. Pior que o caso do relógio: acontece
-- SEMPRE, não só na janela de dois segundos.
--
-- A constraint estava certa e pegou o que eu não teria visto. O conserto não é
-- afrouxá-la: é tirar do cliente a chance de errar. `detected_at` passa a ser
-- carimbado pelo banco em TODA escrita, como `updated_at` — quem escreve não
-- decide quando percebeu, o banco decide.
--
-- ⚠️ A LIÇÃO É MAIOR QUE A COLUNA: `since` e `detected_at` são comparados por um
-- CHECK, então TÊM de vir do mesmo relógio. O relógio do processo continua
-- classificando (`classifyRisk` compara janelas de HORAS, onde segundos não
-- mudam bucket); o CHECK compara INSTANTES, onde mudam. Grandezas diferentes
-- toleram precisões diferentes, e confundir as duas foi exatamente o defeito.

create or replace function public.fn_carimba_detected_at()
  returns trigger
  language plpgsql
  set search_path to 'public', 'pg_temp'
as $function$
begin
  new.detected_at := now();
  new.updated_at := now();
  return new;
end$function$;

comment on function public.fn_carimba_detected_at() is
  'detected_at é quando o BANCO percebeu, nunca quando o processo achou que percebeu. Ver migration 0081: com o valor vindo do cliente, a deriva de relógio violava o CHECK since <= detected_at e derrubava o worker inteiro.';

drop trigger if exists trg_crm_lead_risk_states_detected_at on public.crm_lead_risk_states;
create trigger trg_crm_lead_risk_states_detected_at
  before insert or update on public.crm_lead_risk_states
  for each row
  execute function public.fn_carimba_detected_at();
