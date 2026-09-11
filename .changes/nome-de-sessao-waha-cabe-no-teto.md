---
impacto: nada_mudou
secao: corrigido
titulo: Conectar um número de WhatsApp voltou a funcionar
---

Conectar um número de WhatsApp novo — no onboarding ou pela Central de Conexões — e reconectar
um número que caiu falhavam com "Falha na comunicação com o WhatsApp (WAHA)" (`waha_create_400`),
e o canal ficava preso em "Parado" pedindo reparo.

A causa: o identificador interno que o sistema gera para a sessão no WAHA tinha 69 caracteres, e
a versão do WAHA que o kit usa recusa identificadores com mais de 54 — então nenhuma sessão nova
chegava a ser criada do outro lado. O identificador passou a ter 45 caracteres.

Canais que já ficaram presos por causa disso são consertados na atualização (o identificador é
regravado no formato novo); nenhum número já pareado é tocado. Depois de atualizar, quem estava
travado é só clicar em Conectar/Reconectar de novo.
