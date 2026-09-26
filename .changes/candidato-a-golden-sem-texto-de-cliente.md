---
impacto: nada_mudou
secao: corrigido
titulo: Candidato a golden set não grava o texto do cliente como ele chegou
---

Os arquivos de curadoria que o matcher de skills e o classificador de etapa gravam em
`lib/agent-engine/golden-candidates/` levavam a mensagem do cliente como ela chegou — CPF,
telefone e e-mail junto. A mensagem agora passa pelo mesmo redator da telemetria antes de
tocar o disco, e a pasta saiu do git: as duas portas por onde um `git add -A` publicava
conversa de cliente. Os candidatos que já estavam versionados foram removidos. Nada muda na
operação de quem já roda o sistema.
