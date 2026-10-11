# Revisão de resposta pelo JEV com reserva

O ponto `promise_semantic` pode perguntar ao JEV, em uma requisição, se há compromisso comercial não autorizado, compromisso operacional/de retorno e retorno exclusivo do assistente. A candidata, evidências de consultas reais e contexto curado são os mesmos que a revisão de linguagem usa. Histórico explica referências/perfil, não autoriza política comercial; evidência não comprova execução de uma operação. As instruções de classificação são compartilhadas e preservam convites, descrição do serviço, autoria e pedidos ao cliente.

## Escolha e autorização

Tarefa `revisao_resposta`, alcance conversa, nasce desligada mesmo quando o JEV já está ligado. Escolha explícita em `organizations.settings.jev.tarefas.revisao_resposta`, com estados desligada/observando/decidindo. `contexto_revisao` tem aceite próprio `{em,por,versao:1}`; autorização de mensagem ou roteador não a substitui. A rota administrativa exige papel admin, organização da sessão, chave validada ao ligar o interruptor e IA de reserva ao ativar esta tarefa. Revogação conserva a escolha gravada, mas o estado efetivo vira desligada. A busca de chave verifica novamente o consentimento antes da rede.

O corpo externo inclui somente mensagem, título/conteúdo/origem das evidências e contexto curado (resumo, mensagens, momento/fuso e indicação de limite). Referências internas das fontes ficam de fora. `scrubMessage` oculta PII reconhecida; não promete anonimização completa. O contexto já vem limitado pelo chamador do agente, com teto adicional de 100 mensagens/48 mil caracteres e resumo de 4 mil caracteres. O aceite informa o conteúdo enviado à TypeSafe AI nos Estados Unidos, sem ampliar outras tarefas.

## Decisão e reserva

`noul` estima probabilidade de sim. Até20% = não; a partir80% = sim; faixa intermediária chama a reserva. Estes limites iniciais são regra operacional a validar, não calibração de precisão. A autoria do retorno só interfere se existe retorno, mas os três campos devem ter tipo e faixa válidos. Ausência, tipo errado, NaN/fora de0–1, modelo inesperado ou falha/timeout também chamam a reserva. Versão nativa fixada do fornecedor, credencial empresarial, allowlist e disjuntor existentes.

Em observação, a reserva decide sempre. Em decisão, o JEV decide quando a classificação é suficiente. Reserva é o modelo do binding `promise_semantic`; o ponto opcional `human_return_confirmation` só confirma o sinal humano positivo e conserva o comercial. Não herda o modelo do agente. Falha da reserva não gera aprovação artificial. Orçamento nativo aplicado pelo chamador antes da rede; seu bloqueio não pode ser contornado com outro fornecedor.

O detector léxico permanece em OU com o sinal semântico. `casePromiseGate` exige caso efetivo para compromisso de equipe/retaguarda; para retorno exclusivamente do assistente aceita follow-up executado, sem alvo humano explícito. Convites/consentimento/aviso solicitado ao cliente não viram casos. Uma transferência meramente proposta pela prévia não prova operação de produção; esta funcionalidade não muda a execução de casos.

## Auditoria, tela e continuidade

Uma conta em `llm_calls` por chamada JEV, três linhas de verificações em `jev_observacoes`, sem candidata, evidência ou histórico nesses registros. Vocabulário aberto da tarefa reutiliza schema/RLS/retensão existentes; `message_id` não é criado artificialmente. Rótulos têm prefixo comercial/retorno/so_assistente. Só há comparação quando a reserva respondeu, e concordância entre modelos não é acurácia. Origem `jev`, `jev_observacao` ou `reserva_do_jev`; evento estruturado `jev_review_fallback` explica dúvida/campo/falha sem texto do cliente. Chamada JEV contabilizada mesmo se a reserva falhar. Falhas sem credencial/disjuntor não geram conta fictícia.

Painel nativo mostra autorização revogável, estado da tarefa e últimos três percentuais dos últimos30 dias. Casos, catálogo, agentes e regras locais permanecem nas respectivas instalações. Rollback de imagem desconhece a nova tarefa e volta à revisão convencional; não restaurar banco por consequência. Sem autorização específica não há chamada ou custo JEV adicional.

## Living System Checklist

1. Entrada: `classifyPromise`, antes da cadeia síncrona e fora do lock do número.
2. Regra: `decidirRevisao` e `revisarRespostaComJev`; orçamento nativo pelo chamador.
3. Registro: aceite/escolha em `api_audit_log`, custo em `llm_calls`, verificações em `jev_observacoes`.
4. Tela/porta: IA > Provedores, `CartaoDoJev` e ponto `promise_semantic`.
5. Continuidade: desligamento, revogação e falha usam a IA configurada; disjuntor limita falhas repetidas.
6. Retorno: percentuais/concordância sem texto privado orientam observar, decidir ou pausar. Detector e prova operacional continuam ativos.

Testar os três sinais, faixas de dúvida, falhas, orçamento, contexto/PII, isolamento organizacional, aceite/revogação entre leituras, painel e gates com/sem caso/follow-up. A contribuição é independente do roteamento JEV e não resolve por si a dependência contratual externa.
