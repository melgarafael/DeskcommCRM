-- manifest: Redige somente frases livres nos campos de erro dos recibos históricos de automação (#3267), preservando status, ações, ordem, IDs e metadados de entrega. Vocabulário técnico fechado da serialização atual; não promete remover PII de campos arbitrários. A reaplicação é idempotente e só audita quando há efeito.
-- 9018 — recibos antigos seguem a mesma fronteira dos novos.
-- Reserva root: 9018 @ 20261026221300; nome/carimbo conferidos antes de criar.
-- Não altera a função LGPD nem as decisões de retenção: preserva as linhas.
-- Snapshot dos códigos constantes em resultado-para-recibo.ts, ApiErrorCodes e
-- FRASES_DE_FALHA. As únicas famílias reconhecidas por padrão são HTTP/PGRST,
-- como no serializador; nome, telefone ou token com formato parecido não entram.
-- Os detalhes fora dos campos error/erro/reason/error_code/code/error_type ficam
-- intactos. Isto é uma fronteira de campos, não um sanitizador genérico de PII.

do $recibos_9018$
declare
  v_codigos constant jsonb := '["08000","08006","131026","131047","22P02","23502","23503","23505","23514","42501","42703","42P01","53300","57014","EAI_AGAIN","ECONNREFUSED","ECONNRESET","ETIMEDOUT","acao_alvo_desconhecida","acao_fecharia_laco","ack_error","ads_campo_invalido","ads_cifra_indisponivel","ads_limite_de_chamadas","ads_permissao_insuficiente","ads_sem_conexao","ads_token_invalido","agenda_disponibilidade_invalida","agenda_fora_da_jornada","agenda_horario_indisponivel","agenda_ja_cancelado","agenda_listagem_alvo_nao_e_lead","agenda_listagem_sem_recorte","agenda_sem_responsavel","agenda_tipo_desativado","aguardando_o_canal","ai_decide_desligado_na_empresa","ai_decide_interruptor_ilegivel","ai_provider_error","api_token_teto_atingido","assinatura_viva_no_provedor","auth_in_query_forbidden","aviso_canal_invalido","aviso_nao_configurado","aviso_numero_da_propria_org","aviso_numero_de_cliente","banco_do_roteiro_indisponivel","campanha_agenda_invalida","campanha_base_legal_invalida","campanha_canal_indisponivel","campanha_conteudo_invalido","campanha_estado_invalido","campanha_modelo_inexistente","campanha_modelo_nao_aprovado","campanha_modelo_um_numero","campanha_modelo_variaveis","campanha_modo_do_canal","campanha_nao_editavel","campanha_nao_encontrada","campanha_preparando","campanha_sem_audiencia","campanha_sem_elegiveis","campanha_velocidade_do_canal","canal_da_equipe_nao_encontrado","canal_nao_suportado","canal_sem_chave","channel_archived","channel_disabled","channel_session_not_working","channel_unavailable","channel_without_session","chave_de_outra_conta","chave_recusada","checkout_em_aberto","checkout_em_preparo","commercial_requires_human","commercial_requires_human_sem_passagem","config_invalida","confirmacao_necessaria","consent_declined","contact_blocked","contact_exists","continuacao_exige_outro_funil","cross_pipeline_move_not_allowed","custo_de_token_nao_registrado","daily_limit","documento_invalido","documento_obrigatorio","documento_recusado","dominio_nao_verificado","dono_fora_da_equipe","dono_sem_email","duplicate_external_id","elegibilidade_indeterminada","email_limite_atingido","email_nao_configurado","email_recusado","empresa_sem_email","escolha_ausente","escolha_fora_do_conjunto","event_gone","exclusao_com_assinatura_viva","exclusao_com_cobranca_pendente","external_db_desativada","external_db_destino_bloqueado","external_db_label_em_uso","external_db_sem_chave","falha","fila_vazia","flow_not_active","fora_da_janela_de_envio","fora_da_lista_de_teste","fora_do_pre_go_live","forbidden","forbidden_role","forbidden_scope","forbidden_tenant","ia_indisponivel","idempotency_conflict","idempotency_in_progress","internal_error","invalid_credentials","invalid_cursor","invalid_owner","invalid_request","invalid_state","invalid_state_transition","janela_fechada","jev_exige_aceite","jev_exige_chave_validada","jev_tarefa_so_observa","knowledge_source_type_in_use","lead_already_transferred_in_event","lead_nao_encontrado","lead_not_open","lead_stage_changed_concurrent","lgpd_anonymization_irreversible","lgpd_art12_so_fora_do_brasil","live_enrollment_exists","logo_svg_recusado","lost_reason_invalid","lost_reason_required","low_confidence","membro_fora_da_equipe","membro_indeterminado","membro_sem_email","meta_error","meta_not_configured","mfa_required","missing_config","missing_input","missing_phone_number","missing_url","modulo_desligado","next_action_absent","next_action_changed","ninguem_disponivel","no_actions_to_resend","no_contact","no_email","no_lead_or_contact","no_phone","no_tags","no_target","not_found","numero_de_teste","nuvemshop_error","org_divergente","org_suspended","origin_capture_failed","pagamento_do_periodo_pendente","pagamento_em_andamento","pagamento_pendente","payload_too_large","pipeline_immutable_use_clone","pipeline_no_lost_stage","pipeline_not_found","pipeline_unchanged","pipeline_without_initial_stage","plan_limit_reached","plano_com_assinantes","plano_invalido","plano_nao_encontrado","plano_obrigatorio","prospecting_agent_chat_failed","prospecting_agent_prepare_failed","prospecting_agent_session_failed","prospecting_agent_setup_failed","provedor_com_assinaturas","provedor_indisponivel","provedor_nao_conectado","provedor_recusou","publicacao_requer_confirmacao","rate_limited","reabertura_cria_novo","reabertura_lead_aberto","reenvio_em_curso","reenvio_indisponivel","remetente_recusado","required_fields_missing","resposta_vazia","retry_later","roteiro_nao_iniciado","sem_agente_publicado","sem_alvo","sem_dono","sem_json","sem_link_de_pagamento","sem_membro","sem_numero_de_aviso_cadastrado","sem_portal","sem_rodizio","send_timeout","stage_destino_terminal","stage_pipeline_mismatch","state_conflict","storage_sign_failed","suspensao_de_cobranca","telefone_da_equipe_invalido","tenant_already_exists","texto_vazio","titulo_vazio","token_expired","token_revoked","trigger_kind_not_implemented","uma_vez_por_contato","unauthenticated","unauthorized","unavailable","unknown_action","unprocessable_entity","unsupported_media_type","upstream_unavailable","url_publica_invalida","user_not_in_org","validation_failed","voice_already_paired","voice_assistant_unavailable","voice_desligada_na_organizacao","voice_estado_indeterminado","voice_indisponivel_na_instalacao","voice_risco_nao_aceito","wacalls_error","wacalls_not_connected","waha_error","waha_not_configured","whatsapp_enviado","whatsapp_falhou","won_reason_invalid","zernio_error","zernio_not_configured"]'::jsonb;
  v_frases constant jsonb := '["A conexão de WhatsApp ainda não foi configurada nesta instalação.","A janela de 24 horas fechou. Envie um modelo aprovado ou aguarde o cliente escrever.","Esse número foi excluído da Central de Conexões. Escolha outro número nesta automação.","Este número está desativado. Reative em Conexões para enviar.","Este número não tem WhatsApp.","Não conseguimos falar com o serviço de WhatsApp. Confira se ele está no ar.","Não conseguimos preparar o arquivo para envio.","O WhatsApp Oficial recusou o envio. Confira a conexão em Conexões.","O WhatsApp devolveu um erro para esta mensagem depois de aceitá-la. Pode ser que ela tenha chegado; confira na conversa antes de reenviar.","O WhatsApp não confirmou o envio a tempo. Pode ser que a mensagem tenha chegado.","O canal recusou o envio. Confira a conexão em Conexões.","O contato não tem telefone para receber a mensagem.","O número escolhido não está conectado no momento. Reconecte em Conexões — a mensagem sai sozinha quando ele voltar."]'::jsonb;
  v_tipos constant jsonb := '["Error","TypeError","RangeError","SyntaxError","TimeoutError","AbortError"]'::jsonb;
  v_id uuid;
  v_run record;
  v_erro text;
  v_acoes jsonb;
  v_acao jsonb;
  v_detalhe jsonb;
  v_valor jsonb;
  v_candidato_json jsonb;
  v_candidato text;
  v_codigo text;
  v_chave text;
  v_livre boolean;
  v_alterados integer := 0;
begin
  -- A lista inicial contém só IDs. Os valores são RELIDOS depois de tomar
  -- o lock da linha, na mesma transação: uma atualização de worker que estava
  -- em andamento nunca é sobrescrita por um snapshot anterior à espera.
  for v_id in
    select id from public.automation_rule_runs
     where error is not null or actions_result is distinct from '[]'::jsonb
  loop
    select id, error, actions_result into v_run
      from public.automation_rule_runs where id = v_id for update;
    if not found then continue; end if;
    v_erro := v_run.error;
    if v_erro is not null and v_erro <> ''
       and not (v_codigos ? v_erro or v_frases ? v_erro
                or v_erro ~ '^http_[1-5][0-9]{2}$' or v_erro ~ '^PGRST[0-9]{3}$') then
      v_erro := 'internal_error';
    end if;
    v_acoes := v_run.actions_result;
    if jsonb_typeof(v_acoes) = 'array' then
      v_acoes := '[]'::jsonb;
      for v_acao in
        select value from jsonb_array_elements(v_run.actions_result) with ordinality as a(value, posicao)
         order by posicao
      loop
        if jsonb_typeof(v_acao) = 'object' then
          v_detalhe := case when jsonb_typeof(v_acao -> 'detail') = 'object' then v_acao -> 'detail' else null end;
          v_codigo := 'internal_error';
          -- A causa útil segue a precedência do serializador, sem usar frase
          -- livre nem uma das frases constantes como código novo.
          for v_candidato_json in
            select valor from (values
              (1, v_detalhe -> 'error_code'), (2, v_acao -> 'error'),
              (3, v_detalhe -> 'reason'), (4, v_detalhe -> 'code')
            ) as c(posicao, valor) order by posicao
          loop
            -- JSON número não é código string: 131026 não ganha precedência
            -- sobre reason=http_503; "131026", se conhecido, ganha.
            if jsonb_typeof(v_candidato_json) = 'string' then
              v_candidato := v_candidato_json #>> '{}';
              if v_codigos ? v_candidato or v_candidato ~ '^http_[1-5][0-9]{2}$' or v_candidato ~ '^PGRST[0-9]{3}$' then
                v_codigo := v_candidato;
                exit;
              end if;
            end if;
          end loop;
          v_livre := false;
          v_valor := v_acao -> 'error';
          if v_valor is not null and v_valor not in ('null'::jsonb, '""'::jsonb)
             and not (jsonb_typeof(v_valor) = 'string' and
               (v_codigos ? (v_valor #>> '{}') or v_frases ? (v_valor #>> '{}')
                or (v_valor #>> '{}') ~ '^http_[1-5][0-9]{2}$' or (v_valor #>> '{}') ~ '^PGRST[0-9]{3}$')) then
            v_acao := jsonb_set(v_acao, '{error}', to_jsonb(v_codigo));
            v_livre := true;
          end if;
          if v_detalhe is not null then
            foreach v_chave in array array['error', 'erro', 'reason', 'error_code', 'code'] loop
              v_valor := v_detalhe -> v_chave;
              if v_valor is null or v_valor in ('null'::jsonb, '""'::jsonb) then continue; end if;
              if not (jsonb_typeof(v_valor) = 'string' and
                (v_codigos ? (v_valor #>> '{}') or v_frases ? (v_valor #>> '{}')
                 or (v_valor #>> '{}') ~ '^http_[1-5][0-9]{2}$' or (v_valor #>> '{}') ~ '^PGRST[0-9]{3}$')) then
                v_detalhe := jsonb_set(v_detalhe, array[v_chave], to_jsonb(v_codigo));
                v_livre := true;
              end if;
            end loop;
            if v_detalhe ? 'error_type' and not coalesce(v_tipos ? (v_detalhe ->> 'error_type'), false) then
              v_detalhe := jsonb_set(v_detalhe, '{error_type}', '"Error"'::jsonb);
              v_livre := true;
            end if;
          end if;
          if v_livre then
            if coalesce(v_acao ->> 'error', '') = '' and v_acao ->> 'status' = 'failed' then
              v_acao := jsonb_set(v_acao, '{error}', to_jsonb(v_codigo));
            end if;
            v_detalhe := coalesce(v_detalhe, '{}'::jsonb) || jsonb_build_object('error_code', v_codigo);
          end if;
          if v_detalhe is not null then
            v_acao := jsonb_set(v_acao, '{detail}', v_detalhe);
          end if;
        end if;
        v_acoes := v_acoes || jsonb_build_array(v_acao);
      end loop;
    end if;
    if v_erro is distinct from v_run.error or v_acoes is distinct from v_run.actions_result then
      update public.automation_rule_runs set error = v_erro, actions_result = v_acoes where id = v_run.id;
      v_alterados := v_alterados + 1;
    end if;
  end loop;

  -- Auditoria é saída do efeito, nunca autoridade para pular a limpeza.
  -- Nenhum identificador de pessoa nem frase original vai para esse registro.
  if v_alterados > 0 then
    insert into public.api_audit_log (organization_id, action, resource_type, metadata, bypassed_rls)
    values (null, 'automation.receipts_sanitized_9018', 'automation_rule_runs',
            jsonb_build_object('recibos_alterados', v_alterados), true);
  end if;
end;
$recibos_9018$;
