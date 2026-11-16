---
impacto: nada_mudou
secao: corrigido
titulo: Keep scheduled messages pending when the connection lookup fails
---
A scheduled message is no longer canceled as if its number were disconnected when the database fails to return the connection state. It remains pending for a later scheduler run, using the existing claim timeout. A confirmed disconnection still follows the chosen wait or cancel policy. Credit: @samirhvbr.
