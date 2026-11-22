---
impacto: capacidade_nova
secao: adicionado
titulo: Dá para enviar o arquivo da primeira abordagem pela tela da Prospecção, inclusive vídeo e PDF
---

Na configuração da campanha, o campo **Arquivo da primeira abordagem** passou a aceitar um arquivo novo enviado do computador: imagem (JPG, PNG ou WEBP, até 5 MB), vídeo (MP4, 3GP ou MOV, até 16 MB) ou PDF (até 50 MB). Antes, a tela só oferecia as imagens que já estavam nas respostas rápidas; vídeo e PDF exigiam a API da campanha. O envio é conferido pelos BYTES do arquivo — o tipo declarado pelo navegador não decide nada —, e a régua de tipo e tamanho é a mesma do envio (`classificarMidiaDaAbordagem`), então a tela não aceita nada que a abordagem recusaria.

O arquivo fica no mesmo lugar que o motor lê, `whatsapp-media` sob `{org}/prospecting/`, e o que a tela grava na configuração é exatamente o caminho que o worker assina na hora de mandar. Escolher um arquivo já existente no CRM continua funcionando, e o campo segue permitindo remover o arquivo antes de iniciar a campanha.

O aviso de risco e o teto de 30 abordagens com arquivo por número por dia não mudaram: acima do teto, as abordagens do dia saem só com texto. Como o resto da configuração, o arquivo fica fixo depois de a campanha começar, e apagar o arquivo do CRM pausa a campanha com o motivo na tela.
