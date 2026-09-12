---
impacto: nada_mudou
secao: corrigido
titulo: O nome da sessão do WhatsApp nasce num lugar só e cabe no limite
---

O botão "Conectar novo WhatsApp", na Central de Conexões, falhava sempre com "Falha na comunicação
com o WhatsApp (WAHA)". O identificador interno que o CRM manda para o WAHA saía com 69
caracteres, e o WAHA recusa acima de 54, então a sessão nem chegava a ser criada do outro lado e o
card ficava em "Parado" pedindo reparo. O onboarding não tinha o problema porque montava o
identificador curto por conta própria, num segundo lugar do código.

Agora o formato curto é um só, usado pelas duas telas — onboarding e Conexões —, e o CRM confere o
limite antes de falar com o WAHA: acima de 54 caracteres a conexão para aqui, com motivo próprio e
sem criar nada do outro lado, no lugar de um erro de comunicação que não dizia o que havia de
errado.

Nada muda para quem já tem número conectado.
