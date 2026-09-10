---
impacto: nada_mudou
secao: corrigido
titulo: Conectar um novo WhatsApp deixa de falhar sempre
---

Toda tentativa de conectar um novo número de WhatsApp fora do fluxo de onboarding falhava —
sempre, sem exceção. O nome de sessão gerado internamente passava do limite que o WAHA aceita
(69 caracteres contra um teto de 54), e nenhuma sessão chegava a existir do lado dele. Agora o
nome fica bem abaixo do limite, e a conexão segue normalmente.
