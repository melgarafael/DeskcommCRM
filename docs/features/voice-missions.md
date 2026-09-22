# Ligações pontuais com contexto

Entrada: `ConversationHeader` → `VoiceMissionDialog` → rota autenticada `voice-missions`.
Saída: worker → WA Calls/WebRTC PCM16k ↔ OpenAI Realtime 2.1 PCM24k → resultado no painel e nota interna no atendimento.

A sessão usa `OPENAI_API_KEY` já configurada no servidor, sem chave por cliente e sem token no navegador. O transporte usa a configuração de chamadas existente. Publicação do agente e ativação de voz continuam explícitas; instruções são lidas da versão publicada. Objetivo livre não concede ferramentas de escrita: compromissos que exigirem alterações externas voltam como pendências. Não há campanhas, novas mensagens ou rediscagem automática.

O piloto limita uma chamada ativa por empresa, 20 inícios por 24h e cinco minutos de conversa. Esses limites são guardas operacionais do piloto, não limites comerciais do plano. Pedido salvo incompleto é permitido; iniciar requer número pareado, agente publicado, contato permitido e worker vivo. Pedido enfileirado expira após dois minutos. Falha do processo torna a execução incerta e exige conferência; o mesmo ID nunca disca novamente.

Cancelamento, bloqueio do contato, anonimização, fechamento da conversa, desativação de voz e perda de permissão interrompem o processamento. A ponte de chamadas manuais separa o prefixo interno `ai:` para não oferecer o áudio da IA ao microfone do navegador. Áudio é transmitido, não gravado. Contexto e transcrição seguem a anonimização do contato. Custos usam os tokens medidos por modalidade; falta de evidência conserva a reserva para conferência, sem fabricar custo zero.

## Validação

`pnpm exec vitest run lib/voice/missions/pcm.test.ts`; `pnpm test:db tests/invariants/voice-missions.test.ts`; typecheck e lint. QA de navegador exercita rascunho, recuperação, validação, mobile e acessibilidade. Prova com serviço real: saudação, áudio de cliente sintético via WebRTC, transcrição, despedida e resultado estruturado. Nenhum telefone de cliente é usado nessa prova. A validação final pelo transporte WhatsApp depende da seleção e confirmação do contato de teste no painel.

## Sistema vivo

1. Alimentado pelo objetivo autenticado e histórico recente do atendimento.
2. Alimenta `conversation_notes` e histórico em `VoiceMissionDialog`.
3. Rota emite `voice.mission_requested`; worker registra execução e uso na missão.
4. Entrada no cabeçalho da conversa; não exige página nova.
5. Salvar rascunho não liga. O destinatário fica visível e Ligar agora é a confirmação explícita.
6. Prazo de fila, duração máxima, heartbeat e reconciliação evitam pedidos esquecidos.
7. Agente, número e contato são escolhidos no painel; falta de conexão aponta para Conexões.
8. Humano dá objetivo/contexto; IA devolve resumo e pendências para a equipe.
9. Falha conserva o histórico e impede retry automático; equipe revê o objetivo antes de novo pedido.
10. Mapa `docs/architecture/voice-missions.json` registra entrada, voz e retorno.

## Pedido simplificado

O pedido mostra a última mensagem recebida como referência e duas sugestões opcionais: continuar o assunto ou combinar o próximo passo. São atalhos baseados no texto visível, não inferências sobre intenção ou sentimento. Selecionar uma sugestão apenas preenche o objetivo, sem iniciar a ligação; texto já escrito não é substituído em atualizações. Sem mensagem recebida, os atalhos não aparecem. A consulta é limitada à empresa e ao atendimento e exclui mensagens revogadas.

Na voz, a orientação pede o nome cadastrado (saudação neutra se ele for incerto), uma retomada breve do assunto e respeito ao que já foi respondido, recusado ou combinado. O contexto é montado no início da execução; quando atinge o limite, preserva as mensagens mais recentes, em ordem cronológica e JSON válido.

O objetivo é o único campo aberto de início. Abrir o pedido e clicar em Ligar agora são os dois cliques do caminho já conectado; não há uma revisão intermediária. Novos pedidos usam o cliente do atendimento como destinatário, sempre exibido antes da confirmação. Se houver exatamente um agente pronto e um canal conectado, as escolhas vêm preenchidas e aparecem no resumo de Ajustes da ligação. O agente ativo no atendimento tem preferência, seguido do agente padrão publicado ou da única opção pronta. Ambiguidade exige escolha explícita. Rascunhos preservam escolhas concretas; lacunas recebem os padrões disponíveis. Um teste antigo sem destinatário deixa de bloquear o pedido: o cliente do atendimento aparece como destino. Testes com destinatário escolhido são preservados. Teste com outro contato permanece disponível nos ajustes.

O worker monta uma orientação padrão de conversa natural com objetivo, instruções publicadas e contexto recente. A IA se identifica como assistente virtual, verifica disponibilidade, escuta sem atropelar e confirma o próximo passo. Não há edição de prompt no pedido nem mudanças nas permissões de execução. Se não houver número de voz pareado, o pedido oferece conectar ali mesmo, sem formulário vazio nem tentativa de discagem. O painel reaproveita os controles de ativação e QR Code, com autorização de administrador no servidor. Pareamento inicial exige o celular e acontece uma vez; não conta como ligação nem é declarado concluído sem confirmação.
