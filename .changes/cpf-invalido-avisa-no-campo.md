---
impacto: nada_mudou
secao: corrigido
titulo: CPF inválido impede criar o contato até ser corrigido
---

O aviso de CPF inválido embaixo do campo já existia desde a 1.93.0, mas os botões "Criar contato" e "Salvar e iniciar conversa" seguiam clicáveis enquanto ele estava na tela. Agora os dois ficam desabilitados enquanto o aviso estiver visível, e corrigir o número os libera na hora. O campo continua opcional: vazio cria o contato como antes. O servidor não mudou. Nada muda na VPS. Contribuição de @webtecnica (#3621).
