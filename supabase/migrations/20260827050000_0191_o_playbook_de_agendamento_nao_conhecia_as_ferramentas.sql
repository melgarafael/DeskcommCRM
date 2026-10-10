-- 0191 — o playbook `agendamento` falava de marcar/remarcar sem conhecer as ferramentas.
--
-- O corpo semeado pela 0069 é anterior às ferramentas de agenda, e no passo 5 manda o
-- CONTRÁRIO da `description` de `crm_reschedule_appointment` (cancelar-e-remarcar). Os dois
-- textos chegam ao modelo na MESMA janela — `serializeStablePrefix` serializa `tools` E
-- `system`, e o `system` é o corpo do playbook —, então não dá para prever qual vence.
--
-- ⚠️ POR QUE ESTE BLOCO NÃO COPIA A FORMA DA 0069. Aquela migration publica assim:
--
--     if not exists (select 1 from skill_pointers where organization_id is null and name = '...')
--
-- Para um SEED isso é correto e o cabeçalho dela chama de feature — com razão. Para
-- PUBLICAR VERSÃO NOVA é o pior desfecho possível: o ponteiro já existe em todo clone
-- instalado, o bloco inteiro vira no-op, a migration passa VERDE e ninguém recebe o corpo
-- novo. É o defeito que este projeto já pagou ("o prompt vem da versão publicada"): editar
-- a fonte não muda nada porque o ponteiro não andou. Um bloco que vira no-op e não reclama
-- é indistinguível de um que funcionou.
--
-- Então a idempotência aqui é por CONTEÚDO, não pelo nome do ponteiro:
--   1. `skill_versions` não tem índice único — insert repetido DUPLICA, e o `update.sh` do
--      self-host re-aplica este baseline inteiro a cada atualização. A guarda é o md5 do
--      corpo.
--   2. O md5 é constante escrita à mão, então ele pode divergir do corpo. Por isso o bloco
--      CONFERE o hash do que acabou de inserir e levanta exceção se não bater: quem editar
--      o corpo sem trocar o md5 recebe erro ruidoso, não uma segunda linha silenciosa.
--   3. O repointe roda SEMPRE — update, e insert só se não achou linha. Nunca
--      `if not exists`: é justamente o passo que tem de rodar toda vez.
--
-- `skill_versions` é imutável por trigger (`trg_skill_versions_immutable`): versão publicada
-- não se edita, publica-se outra e repointa-se. É o que este bloco faz.
--
-- ⚠️ A FORMA `values (null, '<nome>', ..., $body$...$body$, ...)` NÃO É ESTILO. O gate
-- `tests/unit/playbook-cita-a-ferramenta.test.ts` extrai os corpos semeados por esse padrão
-- exato. Trocar o delimitador ou mover o corpo para uma variável faz a varredura não achar
-- este playbook — e o gate fica VERDE por vacuidade, que é o pior verde que existe.

do $pub$
declare
  -- md5 do corpo abaixo. Conferido logo após o insert — ver item 2 do cabeçalho.
  v_md5 constant text := 'c2022f05f5b5d9451e727cf0f4187f8a';
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
      'Playbook pra marcar/remarcar horário (consulta, visita, sessão) — consulta a agenda real pelas ferramentas quando elas existem, nunca inventa disponibilidade, e confirma por escrito antes de fechar.',
      $body$# Playbook: marcar horário/agendamento

## Quando usar
O lead pede pra marcar um horário, consulta, visita, demonstração ou sessão —
qualquer compromisso com data/hora. Comum em clínicas, imobiliárias (visitas),
serviços e consultorias.

## Regra de ouro: consulte a agenda, não adivinhe
Você tem acesso à agenda **se, e somente se**, a ferramenta `crm_find_free_slots`
estiver disponível para você. Não julgue isso por intuição — chame e leia a resposta.
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

**2. Ofereça opções fechadas, não uma pergunta aberta**
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
