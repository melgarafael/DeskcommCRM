---
impacto: capacidade_nova
secao: adicionado
titulo: A interface agora também fala turco, lendo os idiomas de arquivos JSON
---
A interface passa a ler os catálogos de idioma de arquivos JSON (`lib/i18n/traducoes/`) e a servir o turco como idioma completo: todas as telas, os avisos do servidor e o aviso que o lead recebe quando a conversa é passada para uma pessoa aparecem em turco para quem escolhe esse idioma. O português e o espanhol seguem exatamente como estavam, e quem não muda de idioma não vê nenhuma diferença. A cobertura do turco é medida por testes: uma frase nova na tela sem tradução em turco passa a falhar na verificação, como já acontece com o espanhol. Nada a fazer na atualização. — nusretbayindir-stack
