-- manifest: A captação por webhook passa a poder REUSAR o card ABERTO do contato no mesmo funil em vez de abrir outro (`webhook_sources.reuse_open_lead_on_capture`, OPÇÃO POR FONTE desligada por padrão, issue #3101) — o degrau é o mesmo `negocioAbertoDoContato` que a ação `create_or_move_lead` usa desde o #958, e o desfecho da linha de captação é `atualizado`, que a 0683 já aceita.
--
-- 0722: reusar o card aberto do contato é opção da fonte (#3101).
--
-- Detalhe completo no cabeçalho do bloco abaixo; o bloco é o MESMO, letra a
-- letra, no apêndice de `supabase/baseline.sql` — é ele que o `update.sh`
-- reaplica a cada atualização, inclusive em quem nunca vai rodar migrations.

-- ---- reusar o card aberto do contato na captação (migration 0722, #3101) ----
-- A captação por webhook criava card NOVO em todo envio sem `external_id`,
-- mesmo quando o contato casado (por telefone ou e-mail) já tinha negócio
-- ABERTO no MESMO funil. Medido em v1.86.0: um contato chegou a TRÊS cards
-- abertos no mesmo funil, e quem olha três cards do mesmo cliente não sabe qual
-- dos três a equipe está tocando. Com `external_id` o defeito não aparece — ali
-- quem identifica o card é o id do envio (#2316).
--
-- O desenho é o que a issue pediu: reusar o card aberto do contato no mesmo
-- funil passa a ser uma OPÇÃO DA FONTE, e ela nasce DESLIGADA. Quem não liga
-- fica exatamente como estava — cada envio continua virando um card novo.
--
-- ─── Por que não há coluna nova em `crm_leads` ─────────────────────────────
--
-- O card que a captação passa a alcançar é o NEGÓCIO ABERTO DO CONTATO no funil
-- da fonte — o mesmo que a ação `create_or_move_lead` já procura para o gatilho
-- de contato desde o #958 (`lib/leads/negocio-aberto-do-contato.ts`). A consulta
-- é uma só para os dois consumidores, e o índice que a serve já existe
-- (`idx_crm_leads_org_contact`, em `organization_id` + `contact_id`): nenhuma
-- estrutura nova é necessária, e duas implementações da mesma pergunta divergem
-- na primeira mudança de uma delas.
--
-- ─── Ligar a opção exige assinatura na fonte, e a regra mora na BORDA ──────
--
-- Mesma régua da opção irmã (`update_existing_lead_on_capture`, 0683): reescrever
-- um card que já existe é integração entre sistemas, e a opção só liga em fonte
-- com assinatura configurada. A regra é exigida no PATCH da fonte
-- (`opcaoSemAssinatura`, em `lib/webhooks/assinatura-autorizacao.ts`), e não num
-- CHECK, pelo mesmo motivo da 0683: um CHECK impediria REMOVER o segredo de uma
-- fonte com a opção ligada, e a tela promete "desligue primeiro".
--
-- ─── O desfecho, na mesma passada ─────────────────────────────────────────
--
-- `atualizado` já existe no CHECK de `webhook_lead_captures.outcome` desde a
-- 0683 (que o alargou para o #2316): a linha desta captação sai com o mesmo
-- vocabulário do reenvio que atualiza, e a tela "Leads recebidos" não precisa de
-- ponte nenhuma.

alter table public.webhook_sources
  add column if not exists reuse_open_lead_on_capture boolean not null default false;

comment on column public.webhook_sources.reuse_open_lead_on_capture is
  'Opção da fonte (issue #3101), DESLIGADA por padrão: quando um envio NÃO traz external_id e o contato casado já tem card ABERTO no mesmo funil, o card é atualizado (campos e etapa da fonte, só para a frente) em vez de a captação abrir outro. Só liga em fonte com assinatura configurada, como a opção irmã. O desfecho da linha de captação é `atualizado`. Desligada, cada envio continua virando um card novo, como sempre.';

notify pgrst, 'reload schema';
