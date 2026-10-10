-- 0069: seed de skills de plataforma (organization_id null) — catálogo inicial do
-- marketplace de skills (Fase 2 do épico harness). Duas skills de fábrica, qualidade
-- sobre quantidade: `objecao-preco` (vendas/genérico) e `agendamento` (clínicas/
-- serviços). Visíveis em toda org via a policy catalog_read_* da migration 0068.
--
-- Idempotente: cada bloco só insere versão+ponteiro se o ponteiro de plataforma
-- ainda não existir pra aquele nome — evita versão órfã (skill_versions é imutável,
-- sem UPDATE possível) e respeita o unique index uniq_skill_pointers_platform em
-- re-run.

do $seed$
declare
  v_id uuid;
begin
  if not exists (
    select 1 from skill_pointers where organization_id is null and name = 'objecao-preco'
  ) then
    insert into skill_versions (organization_id, name, description, body, matcher)
    values (
      null,
      'objecao-preco',
      'Playbook pra contornar objeção de preço no WhatsApp — diagnostica o motivo real por trás do "caro" antes de reagir, sem ceder desconto não autorizado.',
      $body$# Playbook: contornar objeção de preço

## Quando usar
O lead reagiu ao preço/valor com resistência — direta ("tá caro") ou indireta (pediu
desconto, comparou com concorrente, sumiu depois de saber o valor). Objetivo: entender
a objeção real por trás do "caro" antes de reagir, e nunca ceder desconto que a
organização não autorizou.

## Diagnóstico primeiro — "caro" quase nunca é sobre o número
Antes de responder, identifique QUAL objeção está por trás:

1. **Orçamento real insuficiente** — "não tenho esse valor agora", "tá fora do meu orçamento"
2. **Não enxergou o valor ainda** — "por que custa isso?", silêncio após o preço, comparação vaga
3. **Comparação com concorrente/opção mais barata** — "vi mais barato em [X]", "achei um mais em conta"
4. **Tática de negociação** — pede desconto de cara, sem ter perguntado nada sobre o produto antes
5. **Timing** — "vou pensar", "deixa eu ver com [sócio/cônjuge]" disfarçado de objeção de preço

Se não der pra diagnosticar pela mensagem, PERGUNTE antes de argumentar: "Só pra eu
te ajudar melhor — é o valor em si, ou você tava esperando algo diferente do que
ofereci?"

## If-then por diagnóstico

**SE orçamento real insuficiente:**
- Não insista no preço cheio. Ofereça: parcelamento, plano de entrada, versão
  reduzida — SÓ o que já estiver documentado como opção legítima na base de
  conhecimento do tenant.
- NUNCA invente parcelamento ou desconto que não está documentado — se não souber a
  política, faça handoff.
- Não deprecie o lead por não ter orçamento. Trate como informação, não como recusa.

**SE não enxergou valor ainda:**
- Não repita o preço. Reforce o resultado concreto que o cliente ganha (não a lista
  de features).
- Use um número ou prova social real se a base de conhecimento tiver ("cliente X
  reduziu Y em Z semanas").
- Pergunta de reengajamento: "Faz sentido pra você o que isso resolve, ou ficou
  alguma dúvida sobre o que está incluso?"

**SE comparação com concorrente:**
- Não ataque o concorrente. Pergunte o que ele viu de diferente ("o que tinha nessa
  outra opção?") — geralmente revela se é preço mesmo ou outro critério (prazo,
  suporte, garantia).
- Destaque o diferencial real do tenant (o que a base de conhecimento tiver de
  posicionamento), não genérico.

**SE tática de negociação (pediu desconto sem contexto):**
- Não ceda automaticamente. Pergunte o que faria sentido fechar hoje — muitas vezes
  revela o número real que o lead tem em mente.
- Desconto SÓ se a organização tiver uma política documentada na base de
  conhecimento (RAG) pra esse cenário. Sem isso, handoff — decisão de preço fora do
  script é gate humano.

**SE for timing disfarçado ("vou pensar"):**
- Não pressione. Pergunte objetivamente o que falta pra decidir ("o que te ajudaria
  a decidir com mais segurança agora?").
- Agende um follow-up explícito (data/hora), não deixe em aberto — lead que "vai
  pensar" sem follow-up marcado esfria.

## Regras duras
- Nunca prometa desconto, brinde ou condição especial que não esteja na base de
  conhecimento do tenant (RAG) ou explicitamente configurada no agente.
- Nunca minta sobre "promoção que acaba hoje" ou crie urgência falsa.
- Se o lead ficar hostil, ameaçar cancelar ou pedir falar com humano — handoff
  imediato, sem insistir mais uma vez.
- Se depois de 2 trocas de mensagem a objeção não resolver, ofereça handoff
  explicitamente: "Quer que eu chame alguém do time pra fechar os detalhes com
  você?"

## Exemplos de resposta (tom, não copiar literal)
- "Entendo — antes de eu te passar mais opção, me conta: é o valor em si ou esperava
  algo diferente do que te mostrei?"
- "Faz sentido. Sobre o valor, hoje temos [opção documentada]. Isso ajudaria a caber
  no seu momento?"
- "Show, deixa eu confirmar contigo: o que faria sentido fechar hoje pra você?"

## O que NÃO fazer
- Não despeje a lista de preços de novo sem contexto.
- Não ignore a objeção e mude de assunto.
- Não use frases de pressão tipo "só até hoje" sem essa condição existir de verdade.
$body$,
      '{"any_keywords": ["caro", "tá caro", "está caro", "muito caro", "desconto", "abaixar o preço", "mais barato", "achei mais barato", "fora do meu orçamento", "não cabe no orçamento", "valor alto", "preço alto"], "probe_keywords": ["quanto custa", "qual o valor", "quanto é", "parcelamento", "condições de pagamento", "forma de pagamento"]}'::jsonb
    )
    returning id into v_id;

    insert into skill_pointers (organization_id, name, version_id)
    values (null, 'objecao-preco', v_id);
  end if;
end
$seed$;

do $seed$
declare
  v_id uuid;
begin
  if not exists (
    select 1 from skill_pointers where organization_id is null and name = 'agendamento'
  ) then
    insert into skill_versions (organization_id, name, description, body, matcher)
    values (
      null,
      'agendamento',
      'Playbook pra marcar/remarcar horário (consulta, visita, sessão) — oferece opções concretas de agenda real, nunca inventa disponibilidade, confirma por escrito antes de fechar.',
      $body$# Playbook: marcar horário/agendamento

## Quando usar
O lead pede pra marcar um horário, consulta, visita, demonstração ou sessão —
qualquer compromisso com data/hora. Comum em clínicas, imobiliárias (visitas),
serviços e consultorias.

## Regra de ouro: nunca invente disponibilidade
Se o agente não tiver acesso confirmado à agenda real do tenant (integração/consulta
de disponibilidade), NÃO ofereça horário específico. Diga que vai confirmar e faça
handoff, ou pergunte a preferência do lead e sinalize que a confirmação virá em
seguida. Prometer um horário que depois não existe quebra confiança e gera
reagendamento forçado.

## Fluxo padrão (if-then)

**1. Identifique o serviço/motivo antes de oferecer horário**
- SE o lead só disse "quero agendar" sem contexto → pergunte o motivo/serviço
  primeiro. Agendar sem saber o quê gera erro de encaixe (ex.: consulta de 20min
  marcada num slot de 1h de procedimento).

**2. Ofereça opções fechadas, não uma pergunta aberta**
- SE tiver acesso à agenda real → ofereça 2-3 horários concretos ("tenho terça 14h
  ou quarta 10h, qual funciona?"). Pergunta aberta tipo "qual horário você prefere?"
  gera ida e volta desnecessária e trava a conversa.
- SE não tiver acesso à agenda → não invente. Diga algo como "vou confirmar a
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
- SE o lead pedir pra remarcar → trate como novo agendamento: pergunte novo horário
  disponível, e cancele/substitua o anterior explicitamente (não deixe os dois
  marcados).
- SE o lead pedir pra cancelar → confirme o cancelamento e pergunte se quer remarcar
  pra outra data, sem pressionar.

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

## Exemplos de resposta (tom, não copiar literal)
- "Pra eu te encaixar certo: é pra qual serviço/motivo?"
- "Tenho quinta às 15h ou sexta às 9h — qual fica melhor pra você?"
- "Confirmado: consulta dia 28/07 às 15h, na unidade Centro. Pode confirmar pra
  mim?"

## O que NÃO fazer
- Não pergunte "qual horário você prefere?" sem oferecer opções concretas quando
  você tem a agenda.
- Não confirme agendamento sem resposta explícita do lead.
- Não invente disponibilidade que você não checou.
$body$,
      '{"any_keywords": ["agendar", "marcar horário", "marcar consulta", "marcar uma visita", "agenda", "que horas vocês", "horário disponível", "remarcar", "reagendar", "cancelar o horário", "desmarcar"], "probe_keywords": ["que horas", "qual dia", "tem vaga", "disponibilidade"]}'::jsonb
    )
    returning id into v_id;

    insert into skill_pointers (organization_id, name, version_id)
    values (null, 'agendamento', v_id);
  end if;
end
$seed$;
