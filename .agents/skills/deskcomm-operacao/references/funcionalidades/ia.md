# Funcionalidades — Agente de IA

O que há aqui: agentes, follow-ups, fluxos, roteadores, conhecimento e supervisão.
Extraído do CHANGELOG até a 1.79.0 e conferido contra o menu e o código em 2026-10-10.
O menu e o código mandam sobre este arquivo; para ver o que mudou depois, use
`bash scripts/buscar.sh <palavra>` (a pasta é a da skill).

### Agente de IA → Agentes

- **Passagem por assunto jurídico por agente** — No cartão "Passar para uma pessoa", um interruptor novo (padrão ligado, só admin muda) desliga a passagem quando o cliente fala de assunto jurídico (Procon, advogado, processo) — para escritório onde esse é o vocabulário normal. O pedido explícito de pessoa e as palavras de passagem seguem valendo. Onde: Agente de IA → Agentes → Passar para uma pessoa. _(desde 1.79.0)_
- **Teste diz quando o provedor bloqueia** — A prévia do Teste do agente diz quando o provedor bloqueou o conteúdo, separado de saldo, credencial e veto de promessas. Onde: Agente de IA → Agentes → Teste. _(desde 1.79.0)_
- **Agente pela assinatura fecha o turno** — Com "OpenAI pela assinatura (ChatGPT)", a fita da resposta chega ao fechamento na prévia e no WhatsApp, e as sugestões com ferramenta (propostas, "preencher com a conversa") passam a funcionar. Onde: Agente de IA → Agentes → Teste. _(desde 1.79.0)_
- **Modelos Gemini** — O seletor de modelos do Google traz o Gemini 3.5 Flash-Lite, com ferramentas e visão (ampliada na 1.78.0: 3.1 Flash-Lite e 3.6, 3.7 e 3.8 Flash). _(desde 1.77.0)_
- **Bloqueio de afirmação clínica** — Proteção que barra diagnóstico, remédio e garantia de resultado; abre caso se insistir. Onde: Agente de IA → Agentes → Segurança. _(desde 1.74.0)_
- **Aviso fora do horário** — Dá para configurar um texto de aviso para quem escreve fora do atendimento. Onde: Agente de IA → Agentes → gatilho de horário. _(desde 1.72.0)_
- **Limiar de sentimento na tela** — O agente ganha cartão de limiar; o medidor passa a medir hostilidade no atendimento. _(desde 1.71.0)_
- **Promessa olha condições** — A proteção contra promessas considera as condições comerciais consultadas. Onde: Agente de IA → Agentes → Segurança. _(desde 1.70.0)_
- **Espera de rajada por agente** — Dá para ajustar quanto o agente espera juntar mensagens em partes antes de responder. Onde: Agente de IA → Agentes → Freios. _(desde 1.67.0)_
- **Trava de novos retornos** — Cada agente pode impedir retornos novos sem desligar os acompanhamentos. _(desde 1.54.0)_
- **Testar consulta banco externo** — O Teste executa leitura do banco conectado como o atendimento real. Onde: Agente de IA → Agentes → Teste. _(desde 1.49.0)_
- **Liga e desliga pelo celular** — Atendente pausa e devolve o automático digitando #off e #on no celular. Onde: Agente de IA → Agentes → Comandos. _(desde 1.49.0)_
- **Catálogo visual de ferramentas** — O modal lista as telas em cards por categoria com filtro e busca. Onde: Agente de IA → Agentes → ferramentas. _(desde 1.48.0)_
- **Banco externo no agente** — O agente lê o banco conectado para responder com o dado real, só leitura. Onde: Agente de IA → Agentes → capacidades. _(desde 1.43.0)_
- **Ajuste de travessão no envio** — A empresa liga a troca determinística de travessões antes das verificações. Onde: Agente de IA → Agentes → estilo. _(desde 1.41.0)_
- **Horário próprio de follow-up** — Cada agente limita follow-ups a dias e horas sem calar as respostas. Onde: Agente de IA → Agentes → follow-up. _(desde 1.40.0)_
- **Confere e marca junto** — Ferramenta confere e marca na mesma chamada com reserva e aprovação. Onde: Agente de IA → Agentes → capacidade. _(desde 1.31.0)_
- **Modelo digitável sem catálogo** — Sem catálogo do provedor, o campo aceita o identificador digitado. Onde: Agente de IA → Agentes → Modelo. _(desde 1.29.0)_
- **IA espera digitando** — Primeira resposta acende digitando e espera conforme o tamanho. (também no número oficial desde 1.70.0). Onde: Agente de IA → Agentes → comportamento. _(desde 1.18.0)_
- **Assistente sugere antes** — Agente prepara rascunho para revisar, editar e aprovar sem aplicar nada. Onde: Agente de IA → Agentes → teste. _(desde 1.17.0)_
- **Agente marca na conversa** — Com capacidades ligadas, ele sabe a data, lista tipos e fecha horário. Onde: Agente de IA → Agentes → capacidades. _(desde 1.11.0)_
- **Três papéis no agente** — Conversador, Operador e Segurança com disparo imposto pelo sistema. Onde: Agente de IA → Agentes → papéis. _(desde 1.2.0)_
- **Agente com lugar próprio** — Publicado fica entre atendente e gerente com ida e volta na timeline. Onde: Agente de IA → Agentes → lugar. _(desde 1.2.0)_
- **Capacidades declaradas** — Você escolhe, vê uso e recebe aviso em vez de falha calada. Onde: Agente de IA → Agentes → capacidades. _(desde 1.2.0)_
- **Escopo de funil no agente** — Você marca os funis em que ele pode escrever e nada além. Onde: Agente de IA → Agentes → escopo. _(desde 1.2.0)_
- **Clima medido na conversa** — Cada mensagem ganha leitura de irritação para chamar gente. Onde: Agente de IA → Agentes → clima. _(desde 1.0.0)_
- **IA sob as mesmas regras** — O agente obedece fileira, permissão e auditoria como gente. Onde: Agente de IA → Agentes → regras. _(desde 1.0.0)_
- **Sete checagens no envio** — Cada saída passa por descadastro, LGPD, ritmo, promessa e aviso. Na 1.79.0 o revisor passa a reconhecer ofertas com palavras acentuadas (matrícula, grátis, demonstração), a considerar o contexto (oferecer transferência não vira promessa) e a manter explícitas as gratuidades aprovadas na base; promessa sem respaldo segue vetada, sem nada a configurar. Onde: Agente de IA → Agentes → Segurança. _(desde 1.0.0)_

### Agente de IA → Alertas

- **Pausa de conexão avisa equipe** — Pausar uma conexão abre um aviso na Central com canal, quem pausou e quando; some ao retomar. _(desde 1.77.0)_
- **Pedido em áudio vira aviso** — PARAR ou pedir humano em áudio abre aviso na Central após a transcrição. _(desde 1.71.0)_
- **Central ordena por gravidade** — Abertos mostra críticos, atenção e informativos; resolvidos seguem por data. Onde: Agente de IA → Alertas → Abertos. _(desde 1.52.0)_
- **Aviso de processo desistido** — Falha após cinco tentativas abre crítico na Central, no máximo dois. _(desde 1.27.0)_
- **Resolver tudo de uma vez** — Abertos ganha Marcar todos resolvidos em lote com auditoria. Onde: Agente de IA → Alertas → Abertos. _(desde 1.18.0)_
- **Aviso abre o contexto** — Central abre conversa, contato, negócio ou config sem link quebrado. Onde: Agente de IA → Alertas → contexto. _(desde 1.17.0)_
- **Aviso de presa na fila** — Tarefa detecta enviando parado e abre aviso em vez de calar. _(desde 1.2.0)_

### Agente de IA → Aviso no WhatsApp

- **Aviso no WhatsApp da equipe** — Tela escolhe número, apelida, testa e lista entregas com motivo em português. _(desde 1.38.0)_

### Agente de IA → Casos

- **Trechos do acervo nos casos** — O chat de casos mostra os trechos do acervo ligados à pergunta, ao lado. Onde: Agente de IA → Casos → chat. _(desde 1.70.0)_
- **Casos e Fila viram contadores** — Casos entra no menu com número vermelho; Inbox ganha o da Fila; Roteadores vai ao hub. Onde: Agente de IA → Casos → contadores. _(desde 1.60.0)_
- **Caso no sino na hora** — O caso aberto pela IA aparece na Central na hora e sai sozinho ao fechar. Onde: Agente de IA → Casos → sino. _(desde 1.57.0)_
- **Perguntar à IA sobre o caso** — Dá para perguntar à IA do caso sem mover nada; a conversa fica guardada. Onde: Agente de IA → Casos → chat. _(desde 1.38.0)_
- **Assunto na lista** — Cada atendimento abre dizendo o assunto para triar a fila. Onde: Agente de IA → Casos → assunto. _(desde 1.23.0)_
- **Espera cobra passagem** — Atendimento parado um dia abre aviso na Central e no sino, até três. Onde: Agente de IA → Casos → espera. _(desde 1.22.0)_
- **Parada manda para a fila** — No limite, conversas vão ao humano com aviso e volta manual. Onde: Agente de IA → Casos → fila. _(desde 1.4.0)_
- **Passagem com resumo** — Trava vira caso com resumo auditado em vez de conversa crua. _(desde 1.0.0)_

### Agente de IA → Conhecimento

- **Base preparada pelo Google** — O acervo aceita chave Google para preparar e consultar; trocar refaz a base. _(desde 1.62.0)_
- **OpenRouter prepara o acervo** — O acervo aceita chave OpenRouter para indexar e consultar quando não há OpenAI. _(desde 1.60.0)_
- **Base reprepara o que mudou** — Botão Preparar tudo pula o que não mudou; cartão mostra prontos e falhas. _(desde 1.49.0)_
- **CSV no acervo** — Acervo lê CSV linha a linha; Excel ganha mensagem que ensina exportar. _(desde 1.35.0)_
- **Quem consulta cada material** — Documento sem leitor aparece marcado como gasto sem efeito. _(desde 1.8.0)_
- **Ver o que ele aprendeu** — Botão mostra os trechos que o agente procura antes de responder. _(desde 1.8.0)_
- **Enviar arquivo ao acervo** — PDF, Markdown ou texto até 20 MB ou texto colado direto. Onde: Agente de IA → Conhecimento → enviar. _(desde 1.8.0)_
- **Acervo da empresa** — Material pertence à org; cada agente marca o que consulta. _(desde 1.8.0)_
- **Base que responde** — Material vira resposta com análise de clima junto. _(desde 1.0.0)_

### Agente de IA → Credenciais
- **ChatGPT por assinatura com login próprio** — A conexão usa o "Sign in with ChatGPT" e a lista de modelos é por empresa; quem conectou antes precisa conectar de novo. Na 1.79.0 a lista passa a ser buscada no serviço do Codex (se a busca falhar, o seletor mostra o motivo); se a lista não vier, declare `CODEX_CLIENT_VERSION` no `.env` (ex.: `0.160.1`). Onde: Agente de IA → Credenciais. _(desde 1.78.0)_

- **Login ChatGPT por assinatura** — Com interruptor da instalação, cada empresa conecta a assinatura no Credenciais. _(desde 1.74.0)_
- **Provedor personalizado OpenAI** — Credenciais aceita endpoint próprio com teste de conexão antes de salvar. _(desde 1.50.0)_
- **Requesty como provedora** — Requesty entra na lista com chave, modelos e escolha do mais barato. _(desde 1.49.0)_
- **DeepSeek no catálogo** — Provedora entra com chave, modelos e escolha do mais barato sozinho. _(desde 1.39.0)_
- **Chave editável** — Botão Editar troca chave e nome sem recriar; recusa ensina o caminho. Onde: Agente de IA → Credenciais → Editar. _(desde 1.33.0)_
- **OpenRouter completa** — Uma chave com catálogo que se atualiza sozinho na origem. _(desde 1.2.0)_
- **Catálogo em dia** — Modelos atuais sem pagar mais por geração passada. Onde: Agente de IA → Credenciais → catálogo. _(desde 1.2.0)_

### Agente de IA → Execuções

- **Tela de Execuções** — Mostra o feito e, na falha, o que houve e o que fazer. _(desde 1.2.0)_
- **Falha de IA deixa rastro** — Erro no caminho vira registro em vez de sumir no log. _(desde 1.2.0)_

### Agente de IA → Fluxos de atendimento

- **Roteiro não recomeça sozinho** — Roteiro concluído não recomeça; cada um pode ligar Pode recomeçar se quiser. _(desde 1.61.0)_
- **Roteiros ligáveis com editor** — Módulo liga Fluxos com gatilhos, perguntas e respostas na ficha do cliente. _(desde 1.47.0)_

### Agente de IA → Follow-ups

- **Texto fixo respeita janela e faixa** — O follow-up de texto fixo respeita a janela de disparo do canal e a faixa do agente; fora delas, o envio espera a próxima abertura em vez de sair de madrugada. Onde: Agente de IA → Follow-ups. _(desde 1.79.0)_
- **Mover card e tag no follow-up** — O editor ganha caixas de mover lead no funil e editar tag do lead. Onde: Agente de IA → Follow-ups → editor. _(desde 1.70.0)_
- **Silêncio espera para recomeçar** — O fluxo de silêncio pode esperar antes de recomeçar para quem já passou por ele. _(desde 1.70.0)_
- **Pausa conta do último envio** — A pausa do gatilho de silêncio pode contar a partir do último envio do fluxo. _(desde 1.70.0)_
- **Silêncio com prazo máximo** — O gatilho aceita um máximo: o fluxo só começa com silêncio recente. _(desde 1.70.0)_
- **Lembrete interno e gatilhos** — Automação ganha Criar tarefa; follow-up ganha nó interno e gatilhos por tempo. Onde: Agente de IA → Follow-ups → Lembrete interno. _(desde 1.59.0)_
- **Follow-up usa modelo aprovado** — Passo de mensagem oferece modelos aprovados e usa como plano B fora da janela. _(desde 1.53.0)_
- **Gatilho Cliente voltou** — Fluxo dispara quando o cliente volta após o tempo parado, com filtro de etiqueta. _(desde 1.43.0)_
- **Duplicar e renomear fluxo** — Cada fluxo ganha Duplicar e Renomear; a cópia nasce rascunho sem publicar. _(desde 1.43.0)_
- **Gatilho Lead criado** — Contato entra no fluxo quando o negócio nasce, menos importado de planilha. _(desde 1.43.0)_
- **Fluxo fixo sem agente** — Fluxo só de texto fixo dispara sem agente publicado nem chave de modelo. _(desde 1.43.0)_
- **Aviso de follow-up parado** — Central avisa fluxo publicado sem agente ligado e resolve sozinho ao ligar. _(desde 1.36.0)_
- **Modelos de follow-up de clínica** — Começar de um modelo instala consulta, exame, cirurgia ou falta em rascunho. Onde: Agente de IA → Follow-ups → modelos. _(desde 1.36.0)_
- **Espera longa no fluxo** — Espera de 24h ou mais tem opção de não encurtar e mostra Aguardando a data. Onde: Agente de IA → Follow-ups → espera. _(desde 1.35.0)_
- **Organizar e excluir no canvas** — Editor ganha Organizar, Excluir nó e aresta e zoom no tema. Onde: Agente de IA → Follow-ups → editor. _(desde 1.19.0)_
- **Follow-up nasce sozinho** — Etapa ou caso abre acompanhamento; fechar o caso o encerra. _(desde 1.2.0)_
- **Ramos nomeados no canvas** — Publicar exige cobertura por ramo com o descoberto nomeado. Onde: Agente de IA → Follow-ups → canvas. _(desde 1.2.0)_
- **Pausar sem matar** — Pausa, retoma, adia e pula o acompanhamento sem encerrar. _(desde 1.2.0)_
- **Tempo adaptativo** — A IA escolhe o intervalo e a tela mostra valor e limite. _(desde 1.2.0)_
- **Dossiê do follow-up** — Mostra o tentado com o que o motor fez, em português sem código. Onde: Agente de IA → Follow-ups → dossiê. _(desde 1.2.0)_

### Agente de IA → Provedores

- **Jev confere afirmações** — O Jev confere dados da resposta (hora, preço, endereço) contra o material consultado. Onde: Agente de IA → Provedores → cartão do Jev. _(desde 1.76.0)_
- **Jev percebe risco represado** — Em mensagem adiada pelo teto de envio, o Jev avalia risco à saúde e sugere avisar. Onde: Agente de IA → Provedores → cartão do Jev. _(desde 1.76.0)_
- **Jev confere campo gravado** — Antes de gravar campo personalizado, o valor é conferido no que o cliente disse. Onde: Agente de IA → Provedores → cartão do Jev. _(desde 1.71.0)_
- **Jev avisa área da saúde** — O cartão do Jev avisa quem é da saúde sobre dado sensível. Onde: Agente de IA → Provedores → cartão do Jev. _(desde 1.70.0)_
- **Pino com rua e cidade** — O pino do WhatsApp pode chegar com rua e cidade, com chave do Google em Mapas. Onde: Agente de IA → Provedores → Mapas. _(desde 1.70.0)_
- **Jev lê resposta do follow-up** — O Jev observa a resposta ao passo Classificar e compara a saída com a da sua IA. Onde: Agente de IA → Provedores → cartão do Jev. _(desde 1.69.0)_
- **Jev percebe pedidos de pessoa e PARAR** — O Jev percebe pedido de humano ou de parada onde a regra não viu; avisar é opcional. Onde: Agente de IA → Provedores → cartão do Jev. _(desde 1.68.0)_
- **Idioma e modelo da transcrição** — Dá para declarar idioma dos áudios e trocar o modelo usando a chave da empresa. Onde: Agente de IA → Provedores → transcrição. _(desde 1.53.0)_
- **Jev escolhe qual agente** — O Jev observa qual agente deve atender ao lado do roteador de intenção. Onde: Agente de IA → Provedores → cartão do Jev. _(desde 1.52.0)_
- **Jev percebe manipulação** — O Jev confere tentativa de enganar o agente em paralelo com a sua IA. Onde: Agente de IA → Provedores → cartão do Jev. _(desde 1.52.0)_
- **Cartão do Jev por tarefa** — Cada tarefa mostra Só observa ou Decide com botão próprio e confirmação. Onde: Agente de IA → Provedores → cartão do Jev. _(desde 1.52.0)_
- **Jev onda um no cartão** — Cartão novo liga o Jev que mede irritação; observando até você deixar decidir. Onde: Agente de IA → Provedores → cartão do Jev. _(desde 1.48.0)_
- **Chave em endereço próprio** — Ponto sem chave da empresa abre aviso crítico com prazo de recusa futura. _(desde 1.38.0)_
- **Modelo padrão com tela** — Padrão da empresa aparece em Provedores e troca com conferência. Onde: Agente de IA → Provedores → padrão. _(desde 1.20.0)_
- **Painel de Provedores** — Tela escolhe qual inteligência atende cada uma das 23 partes. _(desde 1.2.0)_

### Agente de IA → Roteadores

- **Jev escolhe agente sozinho** — Dá para deixar o Jev escolher o agente, com a IA de sempre só de reserva. _(desde 1.74.0)_
- **Roteador leva ao funil** — Cada intenção pode levar o negócio ao funil e etapa do time certo. _(desde 1.73.0)_
- **Roteador por número** — Um WhatsApp atende vários assuntos com modelo e provedor à escolha. _(desde 1.2.0)_

### Agente de IA → Skills

- **Aviso de versão nova com diff** — A cópia avisa quando o catálogo publica versão nova, mostra o que mudou e deixa adotar. _(desde 1.64.0)_
- **Editar skill na tela** — Skill ganha Editar com histórico e Restaurar; pacote com arquivos segue por zip. _(desde 1.44.0)_

### Agente de IA → Uso e orçamento
- **Ligações do agente de voz em Uso de IA** — Cada ligação grava tokens e duração; o custo em dinheiro ainda não é calculado e não entra no limite de gasto. Onde: Agente de IA → Uso e orçamento. _(desde 1.78.0)_

- **Gasto com foto e áudio no Uso** — Descrever foto, ler vídeo e transcrever áudio passam a somar no gasto do mês. _(desde 1.77.0)_
- **Uso conta o período inteiro** — A tela passa a somar todas as chamadas e separa chamadas de turnos, com cartões novos. _(desde 1.77.0)_
- **Teto que vale em etapas** — Limite nasce desligado e só arma em Só acompanhar, Avisar e Parar. _(desde 1.4.0)_
- **Teto de gasto mensal** — Organização limita quanto a IA pode gastar antes de calar. _(desde 1.0.0)_
