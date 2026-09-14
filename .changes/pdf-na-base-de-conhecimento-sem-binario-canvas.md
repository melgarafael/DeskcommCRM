---
impacto: nada_mudou     # nada_mudou | capacidade_nova | exige_acao
secao: corrigido        # adicionado | alterado | corrigido
titulo: PDF na base de conhecimento de IA volta a ser lido
---

Enviar um PDF como material de conhecimento da IA (ou receber um PDF por
WhatsApp) falhava sempre, com "Extração de PDF indisponível: o binário nativo
@napi-rs/canvas não foi instalado nesta plataforma" — mesmo em instalações
que nunca tocaram em `--no-optional`. A imagem de produção (build
`standalone` do Next.js) não copiava o binário nativo que o `pdfjs-dist`
precisa: o rastreador de arquivos do build não segue o `require()` que o
`@napi-rs/canvas` resolve em runtime (conforme a plataforma), então o
binário ficava fora do `.next/standalone` mesmo estando corretamente
instalado durante o build.
