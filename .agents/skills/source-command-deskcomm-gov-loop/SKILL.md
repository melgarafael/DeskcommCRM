---
name: "source-command-deskcomm-gov-loop"
description: "Executa UMA sessão do gov-loop do DeskcommCRM (uma feature de governança, depois morre)"
---

# source-command-deskcomm-gov-loop

Use this skill when the user asks to run the migrated source command `deskcomm-gov-loop`.

## Command Template

Execute o protocolo do gov-loop — DeskcommCRM (Governança de Atendimento): leia
loop/LOOP.md e siga-o à risca. Lane única: core.

Lembretes que valem antes mesmo de ler o arquivo: uma sessão entrega UMA feature;
o estado vem do disco e volta pro disco; gov-verifier antes de qualquer passes:true
(features.json só muda via node loop/update-feature.ts); você nunca faz git push;
a doutrina de domínio soberana é o AGENTS.md deste repo.
