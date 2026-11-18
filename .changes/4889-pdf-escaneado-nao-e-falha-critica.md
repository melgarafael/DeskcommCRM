---
impacto: nada_mudou
secao: corrigido
titulo: PDF escaneado não vira mais falha crítica da leitura de mídia
---

Quando um cliente mandava um PDF escaneado — sem camada de texto —, a leitura
da mídia falhava cinco vezes, o agente respondia como se tivesse lido o
arquivo e a Central abria um aviso de falha de processamento. Esse evento
morto ocupava a única vaga de aviso da organização e escondia a próxima falha
de verdade, como uma credencial de IA recusada.

Agora a derivação reconhece o PDF sem texto selecionável e encerra na primeira
tentativa: a mensagem fica marcada como lida sem sucesso, com a razão "o PDF
não tem texto selecionável (é escaneado ou só imagem)" visível na conversa, e
nada é enviado à Central. A leitura por imagem (OCR) continua fora deste
recorte, e erro de infraestrutura — chave errada, modelo sem visão, download
que falhou — continua sendo tentado de novo e avisado como antes.
