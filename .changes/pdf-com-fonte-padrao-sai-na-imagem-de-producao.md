---
impacto: nada_mudou
secao: corrigido
titulo: PDFs voltam a ser gerados na instalação em Docker
---

Exportar uma conversa em PDF e gerar a prévia ou o envio de uma proposta falhavam na imagem de produção com «Cannot find module … pdfkit/js/standard-fonts/Helvetica.cjs»: as fontes padrão do PDF não acompanhavam o build. Agora acompanham. Crédito: @berrub00.
