---
impacto: nada_mudou
secao: corrigido
titulo: Novas conexões de WhatsApp usam nomes aceitos pelo serviço
---

A reserva de conexão gerava nomes de 69 caracteres, mas o WAHA 2026.7.2
aceita até 54. O serviço rejeitava a criação antes de gerar o QR code.
As novas reservas usam 45 caracteres e preservam o UUID aleatório completo,
os controles de acesso e a política de teste do canal. Identidades existentes
não são renomeadas pela atualização, pois podem existir em outro servidor.
