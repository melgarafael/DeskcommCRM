---
impacto: nada_mudou
secao: corrigido
titulo: O Inbox para de dar erro de hidratação quando a contagem das abas chega durante o carregamento
---

O número ao lado do nome das abas do Inbox é buscado no servidor de dados e só existe no navegador. Quando essa resposta chegava enquanto a página ainda estava sendo montada, o contador aparecia numa etapa em que a tela ainda era a do servidor — e o React acusava a divergência (o erro `#418`), com a página recarregando a árvore. Agora o contador só entra depois que a página terminou de montar, e a contagem continua aparecendo normalmente. Medido em build de produção: 543 cargas, 3 erros antes do conserto; o caso virou teste — HTML do servidor e hidratação de verdade. Contribuição de @webtecnica (#3736).
