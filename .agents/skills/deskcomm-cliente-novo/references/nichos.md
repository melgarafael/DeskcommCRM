# Pacotes por nicho — o ponto de partida que a triagem completa

Cada pacote traz: funil (as etapas que o onboarding já oferece, com o passo do agente), vocabulário,
esqueleto de prompt preenchido, agentes e intenções do roteador (quando vale ter mais de um),
follow-ups, perguntas de FAQ para pedir à pessoa, itens de memória, capacidades e promessas, e o
roteiro de teste. **Nada aqui é regra de negócio do cliente** — preço, prazo, política e horário
vêm da triagem e dos documentos. Onde está entre chaves, preencha; onde não couber, corte.

Capacidades: o pacote **vender** (o padrão do onboarding) já inclui agenda (marcar, remarcar,
confirmar), consulta ao catálogo e ao conhecimento, notas e movimentação no funil. As capacidades
**críticas** (enviar mensagem avulsa, cancelar agenda, fechar caso) nunca entram por pacote — ligue
uma a uma, explicando o que cada uma permite ao agente fazer sozinho. Skills do produto
`agendamento` e `objecao-preco` já valem para toda organização; "instalar" só serve para
personalizar o texto.

---

## Clínica, consultório ou salão

**Funil "Agendamentos"**: Novo contato (novo) → Já respondi (contatado) → Entendendo o caso
(qualificando) → Quer agendar (qualificado) → Escolhendo horário (negociando) → Consulta marcada
(ganhou) → Não vai marcar (perdeu). **Vocabulário**: cliente = *paciente*, negócio = *consulta*,
ganhou = *marcada*, perdeu = *não marcou*.

**Prompt (preencha):**

```markdown
# Quem você é
Você atende os pacientes de {clínica}, que é: {especialidades, em uma frase}. Seu nome é {nome}.
Fale com calma e acolhimento; muita gente chega com dor ou ansiedade.

# O que você faz primeiro
Entenda, uma pergunta por vez: qual é a necessidade (consulta, retorno, exame, procedimento);
se é para a própria pessoa ou para outra; se tem convênio ou é particular; urgência.

# Como você decide o próximo passo
- Quer marcar e você sabe o serviço: ofereça horários disponíveis e confirme nome completo e telefone.
- Dúvida sobre serviço, preço ou convênio: consulte os materiais; sem resposta lá, diga que a
  recepção confirma e registre a pergunta.
- Sintoma grave ou pedido de orientação médica: não oriente; diga que uma pessoa da equipe vai
  falar agora e passe o atendimento.

# Situações
- Retorno: pergunte a data da última consulta e o profissional.
- Faltou ou quer remarcar: ofereça o próximo horário; nada de cobrar tom de culpa.
- Preço: só o que está nos materiais; particular × convênio muda a resposta.

# Limites
Você não dá diagnóstico, não interpreta exame, não confirma cobertura de convênio sem material.
Chama uma pessoa quando: sintoma grave, reclamação, pedido de laudo/atestado, menor de idade sem responsável.

# Estilo
Curto, uma pergunta por vez, sem termos técnicos. Emoji: não.
```

**Agentes e roteador**: um agente "Recepção" resolve a maioria. Com dois (ex.: "Recepção" e
"Comercial de procedimentos"), intenções: *agendar/remarcar* ("quero marcar", "remarcar minha
consulta", "tem horário amanhã?") → Recepção; *procedimento estético/orçamento* ("quanto custa o
botox", "quero fazer clareamento") → Comercial; fallback = Recepção; grudado = sim.

**Follow-ups**: não monte à mão — em *IA › Follow-ups* clique **Começar de um modelo** e instale
os quatro de clínica (consulta, exame, cirurgia, falta), que já trazem os prazos e os textos
escritos. Quantas mensagens cada um manda e por quanto tempo acompanha está no próprio cartão
da galeria — calculado do fluxo, então não envelhece. Instale só os que o cliente vai usar: clínica que não opera não precisa do de cirurgia.
Depois de instalar, **publique** e ligue cada um no agente (campo *follow-ups que arma*) — sem
isso o gatilho automático não dispara. Lembrete de consulta é a agenda, não follow-up.

**FAQ para pedir**: convênios aceitos; preço de consulta particular; como funciona o retorno;
preparo para exames; endereço, estacionamento, horário; política de cancelamento; formas de
pagamento; documentos necessários.

**Memória**: horário de funcionamento; profissionais e dias de cada um; convênios; "não atendemos
urgência — indicar pronto-atendimento X".

**Promessas**: piso de preço de consulta; desconto máximo (se houver). **Capacidades**: vender
(inclui agenda). **Teste**: "tem horário essa semana?", "aceita Unimed?", "quanto é a consulta?",
"estou com dor forte agora", "preciso remarcar amanhã".

---

## Imobiliária ou corretor

**Funil "Interessados"**: Novo interessado → Já respondi → Entendendo o que procura →
Sei o que oferecer → Visitando imóveis → Fechou negócio → Desistiu. **Vocabulário**: cliente =
*interessado*, negócio = *negócio*, ganhou = *fechou*, perdeu = *desistiu*.

**Prompt**: identidade ("Você atende os interessados de {imobiliária}, que é: {compra, venda,
locação, região}"); diagnóstico: comprar ou alugar; região; faixa de valor; quartos/vagas; prazo;
financiamento ou à vista (para compra: renda aproximada e entrada — sem insistir). Decisão: com o
perfil claro, apresente até 3 opções dos materiais e ofereça visita; sem opção, registre o perfil
e diga que um corretor retorna. Situações: "só olhando" (registre, combine retorno em 7 dias);
documentação e financiamento (só o que está nos materiais). Limites: não promete aprovação de
financiamento, não negocia valor de imóvel de terceiro, chama corretor para proposta e visita.

**Agentes e roteador**: "Locação" e "Vendas" no mesmo número é comum — intenções por *alugar*
("quero alugar", "tem apartamento para locar") e *comprar* ("financiar", "comprar", "MCMV");
*proprietário quer anunciar* → humano. **Follow-ups**: silêncio 48 h em "Sei o que oferecer";
depois da visita, 24 h: "o que achou?". **FAQ**: taxas e comissão; documentos para alugar;
fiador/seguro-fiança; prazos; regiões atendidas. **Memória**: regiões, horário de visitas, quem
atende cada região. **Teste**: "procuro 2 quartos até 400 mil na zona sul", "quero alugar", "tenho
um imóvel para anunciar", "vocês financiam?", "posso visitar sábado?".

---

## Serviços, agência ou obra

**Funil "Orçamentos"**: Pedido novo → Já respondi → Entendendo o projeto → Orçamento enviado →
Negociando → Fechou → Não fechou. **Vocabulário**: cliente = *cliente*, negócio = *orçamento*,
ganhou = *fechou*, perdeu = *não fechou*.

**Prompt**: identidade com os serviços; diagnóstico: o que precisa, para quando, onde, o que já
tentou, orçamento aproximado (perguntar com naturalidade); decisão: com o projeto claro, registre e
diga que o orçamento chega em {prazo}; escopo fora do que a empresa faz → indique e encerre com
educação. Situações: "só quero uma ideia de preço" (faixa dos materiais, se houver; senão, o que
compõe o preço); urgência (o que é possível). Limites: não fecha valor, não promete prazo de obra,
chama uma pessoa para orçamento e visita técnica.

**Roteador**: geralmente um agente só; com "Comercial" e "Suporte/pós-venda", intenção *problema
com serviço já contratado* → Suporte. **Follow-ups**: 3 dias após "Orçamento enviado" sem
resposta: "ficou alguma dúvida?"; 7 dias: última tentativa e registrar motivo. **FAQ**: o que está
incluso; prazo médio; garantia; pagamento; área de atendimento. **Memória**: serviços que não
fazem; região; prazo padrão de orçamento. **Promessas**: desconto máximo; parcelas. **Teste**:
"quanto custa reformar um banheiro?", "vocês fazem em {cidade vizinha}?", "preciso para semana que
vem", "mandei o orçamento e não responderam", "aceita cartão?".

---

## Curso, mentoria ou infoproduto

**Funil "Matrículas"**: Novo interessado → Já respondi → Tirando dúvidas → Quer entrar →
Fechando condições → Matriculado → Desistiu. **Vocabulário**: cliente = *aluno*, negócio =
*matrícula*, ganhou = *matriculado*, perdeu = *desistiu*.

**Prompt**: identidade com o que o curso entrega e para quem; diagnóstico: objetivo da pessoa,
nível atual, tempo disponível, o que já tentou; decisão: objetivo bate com o curso → explique o
caminho e as condições dos materiais e ofereça o link de matrícula; não bate → seja honesto e
indique o que serve. Situações: "está caro" (valor entregue, condições dos materiais; sem desconto
fora da tabela); "funciona para mim?" (pergunte antes de afirmar); garantia e cancelamento (só o
que está escrito). Limites: não promete resultado, não altera condições, chama uma pessoa para
negociação especial e suporte de aluno.

**Roteador**: "Vendas" e "Suporte ao aluno" no mesmo número — intenção *já sou aluno* ("não
consigo acessar", "meu login") → Suporte. **Follow-ups**: silêncio 24 h em "Quer entrar" (link +
uma dúvida a mais?); 3 dias; fim de turma/lote como gatilho manual. **FAQ**: conteúdo e carga
horária; certificado; acesso e prazo; garantia; formas de pagamento; suporte. **Memória**: datas
de turma, bônus vigentes, política de reembolso. **Promessas**: desconto máximo; parcelas
máximas. **Teste**: "serve para iniciante?", "tem certificado?", "quanto custa e parcela?", "sou
aluno e não consigo entrar", "tem desconto?".

---

## Loja — online ou de rua

**Funil "Vendas"**: Novo contato → Já respondi → Escolhendo o produto → Vai levar → Aguardando
pagamento → Pedido pago → Não comprou. **Vocabulário**: cliente = *cliente*, negócio = *pedido*,
ganhou = *pago*, perdeu = *não comprou* (é o padrão do produto).

**Prompt**: identidade com o que a loja vende; diagnóstico: o que procura, para quem, tamanho/
modelo/quantidade, prazo; decisão: consulte o **catálogo** para disponibilidade e preço (nunca de
cabeça), monte o pedido, explique pagamento e entrega dos materiais; produto em falta → alternativa
do catálogo ou registrar interesse. Situações: troca e devolução (política dos materiais); prazo
de entrega por região; "tem desconto?" (tabela). Limites: não confirma estoque sem o catálogo, não
altera preço, chama uma pessoa para troca aprovada e problema com pedido pago.

**Roteador**: "Vendas" e "Pós-venda" — intenção *pedido já feito* ("cadê meu pedido", "quero
trocar") → Pós-venda. **Follow-ups**: "Aguardando pagamento" há 2 h: lembrete com o link; 24 h:
última; "Escolhendo o produto" em silêncio 24 h: "ficou alguma dúvida sobre o {produto}?". **FAQ**:
frete e prazo; troca/devolução; formas de pagamento; horário e endereço da loja física. **Memória**:
prazo de despacho, transportadoras, regiões sem entrega. **Promessas**: desconto máximo; frete
grátis a partir de X. **Teste**: "tem o {produto} no tamanho M?", "quanto fica o frete para
{cidade}?", "posso trocar se não servir?", "fiz o pedido e não chegou", "tem desconto no pix?".

---

## Escritório de advocacia

**Funil "Consultas"**: Novo contato → Já respondi → Entendendo o caso → Consulta agendada →
Consulta realizada → Contrato assinado (ganhou) → Não avançou (perdeu). **Vocabulário**:
cliente = *cliente*, negócio = *caso*, ganhou = *contrato assinado*, perdeu = *não avançou*.

**Prompt (preencha):**

```markdown
# Quem você é
Você atende quem procura {escritório}, especializado em {área(s) do direito}. Seu nome é
{nome}. Fale com clareza e sem juridiquês; quem escreve muitas vezes está preocupado ou
inseguro sobre uma situação pessoal.

# O que você faz primeiro
Antes de oferecer qualquer coisa, entenda, uma pergunta por vez:
- Qual é a situação, em poucas palavras?
- Quando aconteceu (ou quando terminou, se for vínculo empregatício)?
- Já existe processo aberto sobre isso, ou é a primeira vez que procura orientação?
- Tem documentos à mão que ajudem a entender o caso?

# Como você decide o próximo passo
- Situação identificada e dentro da área que {escritório} atende: ofereça horário de consulta
  inicial e confirme nome completo e telefone.
- Prazo apertado, situação em andamento (risco, urgência) ou pedido explícito de urgência:
  ofereça o horário mais próximo disponível E chame uma pessoa da equipe agora — isso não
  espera a data marcada.
- Fora da área de atuação do escritório: diga com educação que não atuam nisso e, se souber,
  oriente o tipo de profissional que ajudaria.

# Situações
- "Quanto eu tenho direito a receber?" / "vou ganhar a causa?": não estime valor nem chance —
  isso é análise de caso; diga que o advogado avalia na consulta.
- "Vou pensar": pergunte o que falta para decidir e ofereça registrar o horário sem compromisso.
- Pergunta sobre prazo (prescrição, recurso): não afirme prazo específico — diga que quanto
  antes melhor e ofereça o horário mais próximo.

# Limites
Você não dá parecer jurídico, não estima indenização ou valor de causa, não promete resultado
de processo. Chama uma pessoa da equipe quando: urgência de prazo, situação de risco, ou
pedido explícito de falar com um advogado.

# Estilo
Mensagens curtas, uma pergunta por vez, sem termos jurídicos sem explicação. Emoji: não.
```

**Atenção — três coisas que este nicho quebra se você copiar de outro sem ajustar:**

1. **O gate jurídico fixo (G4) NÃO vale para o agente publicado — não planeje em cima dele.** Existe
   um regex de termos jurídicos (`G4_LEGAL_REGEX` em `lib/ai/handoff/regex.ts`, aplicado por
   `checkG4Legal`) que passa a conversa para humano antes de qualquer LLM, mas quem o chama é só o
   worker **legado** (`workers/ai-response-worker.ts`). Esse worker só alcança o G4 quando a
   organização não tem nenhum agente publicado, e nessa situação a IA já não responde
   (`elegivelParaWorkerLegado()` em `lib/ai/agents/no-ar.ts` devolve `false` desde a v1.17.0). O
   agente que você monta com esta skill é publicado e roda no agent-engine, que não chama o G4. Para
   um escritório de advocacia, onde "advogado", "processo" e "justiça" são o vocabulário normal do
   cliente, o que passa a conversa para humano no agente publicado é:
   - **pedido explícito de pessoa** (`detectHumanHandoffRequest` em
     `lib/agent-engine/agent/human-handoff.ts`): regex conservador e sempre ligado. Casa "falar com
     um atendente/humano/pessoa/responsável"; **não** casa "falar com o advogado";
   - **palavras de passagem do agente** (`handoff_keywords`, tela do agente › "Passar para uma
     pessoa"; padrão "falar com humano", "atendente", "pessoa real"): comparação por trecho de
     texto. Não acrescente "advogado" ou "processo" aqui neste nicho, senão quase toda conversa passa;
   - **a ferramenta `request_human_handoff`**, que o próprio modelo aciona. A descrição dela
     (`AGENT_TOOL_DEFS` em `lib/agent-engine/agent/inbound-turn.ts`) cita "questão
     jurídica/financeira sensível", então o modelo pode passar a conversa por assunto jurídico. O
     lugar de corrigir isso é o prompt: diga que, neste escritório, assunto jurídico é o atendimento
     normal, e quando chamar a equipe (o exemplo acima faz isso). Desligar o interruptor "Deixar o
     agente chamar uma pessoa…" desliga TODAS as passagens pedidas pelo modelo, não só as jurídicas.
   Não existe hoje chave para desligar a passagem "por assunto jurídico" no agente publicado. Se o
   escritório pedir isso, é questão de produto (issue), não algo para contornar com SQL.
2. **"Agendar com o advogado responsável pela área" não é o agente escolhendo um nome** —
   `crm_list_team_members` deliberadamente não devolve nome/e-mail ao modelo. O roteamento certo é
   por **tipo de atendimento** (Agenda › Tipos de atendimento), um por área, cada um com
   `default_owner_user_id` = o advogado daquela área; o agente lê `crm_list_event_types` e casa a
   área diagnosticada com o tipo certo.
3. **Sigilo profissional entre áreas não é resolvido pelo produto hoje.** `user_pipeline_access`
   (permissão por pipeline) não está no MVP — qualquer `agent`/`manager` com acesso ao funil
   "Consultas" enxerga os casos de todas as áreas, não só a sua. Avise o escritório disso antes de
   publicar; não é algo para contornar com RLS/SQL fora de migration.

**Campos do funil** (`Configurações › Funis` → campos personalizados, não pede migration):
`area_direito` (select, com as áreas que o escritório atende), `urgencia` (select: Alta/Média/
Baixa), `numero_processo` (text, se já houver processo aberto). `type: date` (ex. um prazo
processual) pode virar alerta automático pelo gatilho de campo de data do funil já existente.

**Agentes e roteador**: um agente resolve a maioria dos escritórios (uma área de atuação). Com
mais de uma área (ex. trabalhista e cível), use o **Roteador de Intenção** — cada área um agente,
prompt e tipo de atendimento padrão próprios; senão o mesmo agente tenta cobrir áreas que
não conhece direito. **Follow-ups**: silêncio 24 h em "Entendendo o caso"; no-show de consulta
agendada. **FAQ para pedir**: áreas que atendem de fato; se cobram pela consulta inicial e
quanto; documentos que a pessoa deve levar; como funciona o processo, em linhas gerais; forma de
cobrança (fixo x êxito), se aplicável. **Memória**: áreas que NÃO atendem; horário de
atendimento; "sigilo profissional: nunca peça documento sensível por aqui, isso é na consulta".
**Promessas**: valor da consulta inicial, se houver — nunca estimativa de indenização/êxito.
**Capacidades**: vender (agenda, conhecimento, notas, funil) **+ a capacidade crítica "casos"
ligada e explicada ao escritório** — é o que torna "urgência alta" acionável de verdade (abre
fila humana), não um rótulo solto no lead. **Teste**: "fui demitido sem justa causa semana
passada", "quanto eu tenho direito a receber?", "sofri um acidente e estou afastado do
trabalho", "quero falar direto com o advogado", pergunta fora da área que o escritório atende.

*Nuance fora da doutrina do CRM, mas que vale avisar quem monta o prompt:* a OAB restringe
captação de clientela e proíbe prometer resultado em publicidade (Provimento 205/2021 e Código
de Ética) — o escopo do prompt acima já evita isso, mas o advogado responsável deve revisar o
texto final antes de publicar; o CRM não valida conteúdo jurídico.

---

## Outro tipo de negócio (genérico)

**Funil "Clientes"**: Novo contato → Já respondi → Entendendo a necessidade → Proposta enviada →
Negociando → Fechou → Não fechou. Use o esqueleto de `prompt-do-agente.md`, o roteador só se houver
dois papéis claros, follow-up de silêncio 24 h/72 h, FAQ com as 10 perguntas mais frequentes que a
pessoa listar, memória com horário, região e o que não fazem.

---

## Roteiro de teste — como ler o resultado do botão Testar

Para cada mensagem do nicho: o texto respondeu à pergunta **sem** inventar dado que não está nos
materiais? Fez **uma** pergunta por vez? Tentou a ação certa (oferecer horário, consultar catálogo,
registrar, chamar humano)? Algum portão vetou — e o veto veio do prompt (jargão, promessa)? Anote
o que ajustar no `pacote-<cliente>.md` antes de publicar.
