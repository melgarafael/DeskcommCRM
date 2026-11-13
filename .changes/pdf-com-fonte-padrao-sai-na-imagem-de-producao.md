---
impacto: nada_mudou
secao: corrigido
titulo: PDFs saem também em imagem construída com webpack
---

Quem constrói a própria imagem com `next build --webpack` tinha os PDFs (exportar conversa, prévia e envio de proposta) falhando com «Cannot find module … pdfkit/js/standard-fonts/Helvetica.cjs»: as fontes padrão do PDF não acompanhavam esse build. Agora acompanham. A imagem oficial, construída com o Turbopack, já as levava e não muda. Crédito: @berrub00.
