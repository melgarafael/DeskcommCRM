---
impacto: nada_mudou
secao: corrigido
titulo: A atualização baixa a imagem nova mesmo quando o .env tinha APP_PULL_POLICY=never de uma correção de emergência
---

Quando a imagem do app tinha sido construída na própria VPS, numa correção de emergência, o `.env` ficava com `APP_PULL_POLICY=never` ("não baixe, use a daqui"). Na atualização seguinte, o `update.sh` gravava no `.env` a versão nova com `missing`, mas o `docker compose` continuava obedecendo o `never` antigo, que tinha ficado na memória do script. O app ficava sem a imagem nova, não subia, e o script concluía que precisava construir a imagem na VPS — o que acabava em falta de memória.

Agora, logo depois de gravar as imagens da versão nova, o kit relê do `.env` recém-gravado a regra de download das quatro imagens (app, worker, scheduler e voice-agent). Isso só acontece quando há versão nova para instalar: numa execução de "nada a atualizar", o `never` do operador continua valendo. Nada a fazer na atualização. Obrigado a @webtecnica, que mediu o defeito numa VPS real e escreveu o conserto e o teste. (#5116)
