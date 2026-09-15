---
impacto: capacidade_nova
secao: adicionado
titulo: Os guias do assistente passam a funcionar em qualquer pasta, e dois deixam de ser descartados
---
Um comando só (`curl -fsSL https://raw.githubusercontent.com/melgarafael/DeskcommCRM/main/scripts/instalar-guias.sh | bash`) liga os guias `/deskcomm-instalar`, `/deskcomm-cliente-novo`, `/deskcomm-metricas`, `/deskcomm-prompt`, `/deskcomm-contribuir` e `/deskcomm-doutrina` nas pastas globais do Claude Code, Codex, Cursor, OpenCode e Antigravity — antes eles só existiam com o assistente aberto dentro de um clone atualizado, o que deixava de fora justamente quem ainda não instalou. Rodar de novo atualiza; `--remover` desfaz. O cabeçalho de dois guias trazia um erro de formato que assistentes mais rigorosos descartavam sem avisar, e foi corrigido.
