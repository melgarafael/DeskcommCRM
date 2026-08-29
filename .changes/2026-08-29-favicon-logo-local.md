---
impacto: capacidade_nova
secao: adicionado
titulo: A aba do navegador pode mostrar o logo de verdade, não só cor + inicial
---

`APP_LOGO_URL` (arquivo `.env`) agora também aceita um caminho raiz-relativo
para um arquivo dentro de `public/` (ex.: `/minha-marca.png`), além de
qualquer URL pública já aceita antes. Quando configurado assim, o ícone da aba
do navegador passa a mostrar o arquivo de verdade, em vez do ladrilho de cor +
inicial gerado automaticamente. Nenhuma ação é necessária para quem já
configurou `APP_LOGO_URL` com uma URL: o comportamento da aba continua sendo
cor + inicial, exatamente como antes.
