-- 0486 — o playbook `agendamento` passa a ensinar os DOIS passos da cadeia (#1019).
--
-- A 0191 publicou um corpo que já falava das ferramentas, mas começava o meio da
-- cadeia: "você tem acesso à agenda se, e somente se, `crm_find_free_slots` estiver
-- disponível" e "SE `crm_find_free_slots` respondeu com horários → ofereça 2-3". O
-- PRIMEIRO passo — `crm_list_event_types`, que é de onde vem o `event_type_slug` que
-- a segunda ferramenta EXIGE — não aparecia em lugar nenhum do texto (medido:
-- `grep -rn crm_list_event_types supabase/` devolve ZERO antes desta migration).
--
-- O relato da issue #1019 é esse desfecho: 7 chamadas de `crm_list_event_types` com
-- sucesso e ZERO de `crm_find_free_slots` no `api_audit_log`. O bloco residente do
-- turno ensina a cadeia desde a #1038; este playbook é o OUTRO texto residente que
-- chega ao modelo na mesma janela (keyword "agendar"/"horário disponível"), e ele
-- ensinava só o meio — pior: o passo 2 mandava responder "vou confirmar e te retorno"
-- com handoff quando a ferramenta não respondia, que é a frase do relato.
--
-- ⚠️ A RÉGUA É A MESMA dos blocos residentes: todo nome de ferramenta novo entra
-- DENTRO de uma condição ("se `crm_list_event_types` também estiver na sua mão", "SE
-- você ainda não tem o `slug`"). Nomear ferramenta que o agente não tem faz o modelo
-- tentar chamá-la — e este texto é org-wide, servido por keyword, sem saber quais
-- capacidades o agente tem ligadas.
--
-- ⚠️ MESMA FORMA da 0191, e pelo mesmo motivo: `tests/unit/playbook-cita-a-ferramenta.test.ts`
-- extrai os corpos semeados pelo padrão exato `values (null, '<nome>', ..., $body$...$body$)`.
-- Trocar o delimitador ou mover o corpo para uma variável faz a varredura não achar
-- este playbook — e o gate fica VERDE por vacuidade.
--
-- Idempotência por CONTEÚDO (md5 do corpo), reponte SEMPRE — a 0191 explica os três
-- itens; esta migration os repete porque ela publica outra versão pelo mesmo caminho.

do $pub$
declare
  -- md5 do corpo abaixo. Conferido logo após o insert — ver item 2 do cabeçalho.
  v_md5 constant text := '73c66800b7d64797252795b708b26cb3';
  v_id  uuid;
begin
  select id into v_id
    from skill_versions
   where organization_id is null and name = 'agendamento' and md5(body) = v_md5
   limit 1;

  if v_id is null then
    insert into skill_versions (organization_id, name, description, body, matcher)
    values (
      null,
      'agendamento',
      'Playbook pra marcar/remarcar horário (consulta, visita, sessão) — consulta a agenda real em dois passos (tipos e depois horários) pelas ferramentas quando elas existem, nunca inventa disponibilidade, e confirma por escrito antes de fechar.',
      $body$# Playbook: marcar horário/agendamento

## Quando usar
O lead pede pra marcar um horário, consulta, visita, demonstração ou sessão —
qualquer compromisso com data/hora. Comum em clínicas, imobiliárias (visitas),
serviços e consultorias.

## Regra de ouro: consulte a agenda, não adivinhe
Você tem acesso à agenda **se, e somente se**, a ferramenta `crm_find_free_slots`
estiver disponível para você. Não julgue isso por intuição — chame e leia a resposta.
Se `crm_list_event_types` também estiver na sua mão, a consulta é de DOIS passos, e os
dois no MESMO TURNO: ela devolve os tipos de atendimento da empresa com o `slug` de cada
um, e só então `crm_find_free_slots` consulta horários DESSE tipo, com o `event_type_slug`
que veio da lista. Parar depois da lista e responder "vou verificar" é o defeito — a lista
é o começo da conversa com a agenda, não a resposta. Nunca invente nem traduza um `slug`:
se o tipo que o lead pediu não está na lista, diga o que existe em vez de verificar o que
não existe.
- Voltou com horários → ofereça 2 ou 3 deles, concretos.
- Voltou `publicou_horarios: false` → o atendente ainda não publicou os horários de
  trabalho dele. Isso NÃO é "está lotado" e NÃO é "não tem vaga": não invente horário,
  não diga que a agenda está cheia, e avise que alguém da equipe confirma.
- Voltou com `motivo` → leia a `mensagem` e faça o que ela manda. Ela foi escrita para
  o cliente ouvir.
- Voltou `fuso_suposto: true` → o fuso da agenda veio do padrão e ninguém confirmou.
  Ofereça pedindo confirmação — "consigo terça às 14h; confere se esse horário bate aí
  pra você?" — em vez de afirmar.
- Você não tem essa ferramenta → aí sim: não ofereça horário nenhum, diga que vai
  confirmar a disponibilidade e sinalize handoff para quem tem acesso.
Prometer um horário que depois não existe quebra confiança e gera reagendamento
forçado. Inventar é pior do que demorar um instante a mais para responder.

## Fluxo padrão (if-then)

**1. Identifique o serviço/motivo antes de oferecer horário**
- SE o lead só disse "quero agendar" sem contexto → pergunte o motivo/serviço
  primeiro. Agendar sem saber o quê gera erro de encaixe (ex.: consulta de 20min
  marcada num slot de 1h de procedimento).
- SE você ainda não tem o `slug` desse serviço e `crm_list_event_types` está na sua mão →
  chame-a e escolha o tipo pelo que o lead descreveu; é dela que sai o `event_type_slug` do
  passo seguinte.

**2. Ofereça opções fechadas, não uma pergunta aberta**
- SE o tipo já está na lista mas horário nenhum foi consultado ainda → chame
  `crm_find_free_slots` com o `event_type_slug` dele ANTES de responder.
- SE `crm_find_free_slots` respondeu com horários → ofereça 2-3 concretos ("tenho terça
  14h ou quarta 10h, qual funciona?"). Pergunta aberta tipo "qual horário você prefere?"
  gera ida e volta desnecessária e trava a conversa.
- SE você não tem a ferramenta → não invente. Diga algo como "vou confirmar a
  disponibilidade e te retorno em instantes" e sinalize handoff/task pra quem tem
  acesso.

**3. Colete os dados obrigatórios antes de confirmar**
- Nome completo do lead (ou confirme o que já está no CRM).
- Serviço/motivo específico.
- Unidade/local, se o tenant tiver mais de uma (clínica com filiais, imobiliária com
  múltiplos imóveis).
- Se for reagendamento, o horário anterior a ser substituído.

**4. Confirme por escrito antes de encerrar**
- SE o lead escolheu um horário e `crm_book_appointment` está na sua mão → grave de verdade
  com ela, usando o `starts_at` que `crm_find_free_slots` devolveu, sem reescrever, e SÓ ENTÃO
  repita por escrito. Horário oferecido e não marcado não é reserva — é ele que gera
  reagendamento forçado.
- SE o lead aceitar um horário → repita de volta por escrito: "Confirmado:
  [serviço] dia [data] às [hora], em [local]. Confirma pra mim?"
- Só considere o agendamento fechado depois do "sim"/confirmação explícita do lead —
  silêncio ou "ok" vago não é confirmação suficiente pra compromissos com custo de
  no-show alto (ex. consulta médica, visita a imóvel).

**5. Reagendamento e cancelamento**
- SE o lead pedir pra remarcar E você tem `crm_reschedule_appointment` → use ela.
  NÃO cancele e marque de novo: é o MESMO compromisso mudando de hora. O histórico
  continua um só e o lembrete é refeito sozinho para o horário novo.
- SE o lead pedir pra remarcar e você NÃO tem essa ferramenta → então cancelar e marcar
  de novo é o único caminho, e ele tem um custo que você precisa administrar: o cliente
  pode receber dois avisos seguidos e contraditórios ("desmarcado" e depois "marcado").
  Antes de fazer, diga a ele em uma frase o que vai acontecer — "vou desmarcar o horário
  antigo e já marcar o novo, você pode receber dois avisos" — e nunca deixe os dois
  compromissos de pé ao mesmo tempo.
- SE o lead pedir pra cancelar → use `crm_cancel_appointment` se você a tiver, informe o
  motivo, e pergunte se quer remarcar pra outra data, sem pressionar. Cancelar libera
  aquele horário para outra pessoa e não dá para desfazer: confirme antes.

**6. Risco de no-show**
- Se o negócio tiver política de confirmação D-1 documentada na base de
  conhecimento, siga-a (ex.: mensagem de lembrete automática). Se não houver, não
  invente política — apenas confirme o agendamento normalmente.

## Regras duras
- Nunca confirme horário sem ter checado disponibilidade real (ou sem sinalizar que
  ainda vai confirmar).
- Nunca marque dois compromissos conflitantes pro mesmo lead sem avisar.
- Se o lead pedir um horário fora do funcionamento do negócio (ex. domingo,
  madrugada) e isso não estiver nas regras do tenant, não confirme — explique a
  janela real de atendimento.
- Dado sensível (endereço completo, documento) só é coletado se o fluxo do tenant
  realmente exigir — não peça informação a mais que o agendamento precisa.
- Marcar consulta e agendar retorno são coisas DIFERENTES. `crm_book_appointment` é para
  hora combinada COM o cliente, que ele reservou e vai comparecer — alguém espera por ele.
  `crm_schedule_followup` é decisão interna nossa de voltar a falar: o cliente não fica
  sabendo e nada é reservado na agenda de ninguém. Se ele ESCOLHEU um horário para ser
  atendido, é a primeira.

## Exemplos de resposta (tom, não copiar literal)
- "Pra eu te encaixar certo: é pra qual serviço/motivo?"
- "Tenho quinta às 15h ou sexta às 9h — qual fica melhor pra você?"
- "Confirmado: consulta dia 28/07 às 15h, na unidade Centro. Pode confirmar pra
  mim?"

## O que NÃO fazer
- Não pergunte "qual horário você prefere?" sem oferecer opções concretas quando
  você tem a agenda.
- Não confirme agendamento sem resposta explícita do lead.
- Não invente disponibilidade que você não checou.$body$,
      '{"any_keywords": ["agendar", "marcar horário", "marcar consulta", "marcar uma visita", "agenda", "que horas vocês", "horário disponível", "remarcar", "reagendar", "cancelar o horário", "desmarcar"], "probe_keywords": ["que horas", "qual dia", "tem vaga", "disponibilidade"]}'::jsonb
    )
    returning id into v_id;

    if (select md5(body) from skill_versions where id = v_id) is distinct from v_md5 then
      raise exception 'playbook agendamento: o md5 declarado (%) nao corresponde ao corpo inserido. Recalcule antes de publicar.', v_md5;
    end if;
  end if;

  -- Repointe SEMPRE. O ponteiro global e unico por nome (uniq_skill_pointers_platform,
  -- parcial em organization_id is null), entao update-senao-insert e seguro e nao depende
  -- de inferencia de conflito sobre indice parcial.
  update skill_pointers
     set version_id = v_id, updated_at = now()
   where organization_id is null and name = 'agendamento';

  if not found then
    insert into skill_pointers (organization_id, name, version_id)
    values (null, 'agendamento', v_id);
  end if;
end
$pub$;
