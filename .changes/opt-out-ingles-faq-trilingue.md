---
impacto: capacidade_nova
secao: corrigido
titulo: Descadastro em inglês e marcadores de FAQ nos três idiomas
---

A interface em inglês prometia "reply STOP, EXIT…" mas o detector de descadastro só ouvia palavras em português e espanhol: quem respondia EXIT sozinho continuava recebendo mensagens. Agora "exit", "cancel", "quit" e "end" — sempre como palavra sozinha, a mesma regra do resto — também descadastram. Na ingestão de base de conhecimento, o parser de FAQ só aceitava os marcadores em português (`## Pergunta:` / `## Resposta:`), enquanto as instruções em espanhol e inglês ensinavam `## Pregunta:` / `## Question:`, que eram ignorados em silêncio. O parser agora aceita os marcadores nos três idiomas. Não há ação para quem opera a VPS: a mudança chega na próxima atualização.
