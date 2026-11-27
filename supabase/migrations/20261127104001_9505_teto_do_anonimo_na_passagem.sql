-- manifest: **Motivo e origem novos na passagem para humano: o teto do visitante anônimo do chat no site (Spec 36, F4).** O CHECK de `passagens_de_atendimento.motivo_codigo` aceita `teto_do_visitante_anonimo`, e o de `origem` aceita `teto_do_anonimo`, gravados quando a IA chega ao limite de respostas para um visitante que não deixou telefone nem e-mail: o visitante recebe uma frase pedindo o contato e a conversa vai para a equipe, com aviso na Central. Antes a IA só parava, em silêncio. Só alarga o vocabulário: nenhuma linha existente viola os CHECKs novos. Par de `MOTIVOS_DA_PASSAGEM`/`FRASE_DO_MOTIVO`/`ORIGENS_DA_PASSAGEM` em `lib/escalacao/passagem.ts`, cobrado por `tests/invariants/vocabulario-banco-x-typescript.test.ts`. No `baseline.sql`, os valores entram nos blocos únicos das duas constraints (e nos CHECKs inline do `create table`); o apêndice só registra isso em comentário.

-- MOTIVO E ORIGEM NOVOS NA PASSAGEM: `teto_do_visitante_anonimo` / `teto_do_anonimo`
--
-- O chat no site responde visitante sem cadastro, e cada resposta pode custar
-- uma chamada à IA. Por isso há um teto por conversa (padrão 20) enquanto o
-- visitante não deixa telefone nem e-mail. Passado o teto, a conversa vai para
-- a equipe pela mesma escolta do teto de gasto, e o cartão precisa dizer o que
-- houve: o cliente NÃO pediu uma pessoa.
--
-- Par obrigatório de `lib/escalacao/passagem.ts`: TS e banco mudam no MESMO
-- commit, ou o INSERT falha com 23514 no caminho pouco exercitado.
--
-- Drop e add num bloco DO: o update.sh aplica sem ON_ERROR_STOP e em
-- autocommit; soltos, um add que falhasse deixaria a tabela sem a constraint.

do $$
begin
  alter table public.passagens_de_atendimento
    drop constraint if exists passagens_de_atendimento_origem_check;
  alter table public.passagens_de_atendimento
    add constraint passagens_de_atendimento_origem_check
    check (origem in (
      'pedido_explicito','opt_out_provavel','ferramenta_do_modelo',
      'teto_de_gasto','teto_do_anonimo','caso_escalado','sentimento','legado_pedido',
      'legado_juridico','legado_etapa','legado_confianca','legado_teto',
      'mcp_externo','runtime_nativo'));

  alter table public.passagens_de_atendimento
    drop constraint if exists passagens_de_atendimento_motivo_codigo_check;
  alter table public.passagens_de_atendimento
    add constraint passagens_de_atendimento_motivo_codigo_check
    check (motivo_codigo in (
      'requested_human','suspected_optout','orcamento_de_ia','teto_do_visitante_anonimo',
      'low_sentiment','low_confidence','critical_stage','legal_mention','refund_mention',
      'caso_escalado','verificacao_manual','restricao_comercial'));
end $$;

notify pgrst, 'reload schema';
