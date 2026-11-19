---
impacto: nada_mudou
secao: corrigido
titulo: A nota de voz gravada no Chrome do celular não é mais recusada pelo número oficial do WhatsApp
---

Parte das notas de voz gravadas pelo Chrome do celular aparecia como "falhou" no número oficial (API da Meta), com o erro `131053 — Media upload error`, e o "Tentar de novo" falhava outra vez. O Chrome às vezes começa a gravação alguns milissegundos antes do zero, o CRM levava esse início negativo para o arquivo, e a Meta recusa o áudio assim. Agora o som é regravado em opus mono, com quadros de 20 ms e começando exatamente no zero, o mesmo formato que o WhatsApp usa nas próprias notas de voz. De quebra, o arquivo fica bem menor: uma nota de 1 minuto passa de cerca de 1 MB para cerca de 200 KB.

Os áudios que já falharam continuam guardados no formato antigo, e o "Tentar de novo" neles volta a falhar: é preciso gravar de novo.
