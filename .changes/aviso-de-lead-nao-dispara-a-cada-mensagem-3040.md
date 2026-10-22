---
impacto: nada_mudou
secao: corrigido
titulo: "Lead atribuído a você" volta a avisar só quando o responsável muda de verdade
---

A notificação de negócio atribuído (e as de ganho e perdido) comparava o responsável com o `old` do evento do Realtime. Como nenhuma tabela deste schema tem `REPLICA IDENTITY FULL`, esse `old` traz apenas a chave primária: o código lia "sem responsável" em toda atualização e avisava sempre. Com o carimbo de atividade em cada resposta do vendedor, o negócio que já era dele notificava uma vez por mensagem enviada. Agora o aviso sai só quando o responsável (ou o status) muda em relação ao último estado visto daquele negócio — e, sem histórico conhecido, o aviso não sai: prefere o silêncio a notificar por engano. Nada a fazer na atualização.

Contribuição de @webtecnica (#3183).
