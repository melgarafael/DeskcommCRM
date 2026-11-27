---
impacto: nada_mudou
secao: corrigido
titulo: Os cabeçalhos Email, In-app e Push das preferências de Notificações acompanham o idioma da tela
---

Na tela de Configurações › Notificações, as colunas "Email", "In-app" e "Push" estavam escritas direto no código e só a coluna "Categoria" seguia o idioma: com a instalação em espanhol, a tabela misturava "Categoría" com os três títulos em português. Agora as três passam pela mesma tradução e aparecem como "Correo" e "En la app" em espanhol, sem mudança no português. Corrige a issue #4755.
