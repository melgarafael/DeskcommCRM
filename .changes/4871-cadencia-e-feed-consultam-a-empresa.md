---
impacto: nada_mudou
secao: corrigido
titulo: O catálogo por feed e a cadência respeitam o módulo que a empresa desligou
---

O cron do catálogo por feed roda sozinho a cada 2 horas e percorre as fontes de várias empresas na mesma execução. Até aqui ele perguntava o módulo uma vez, sem a empresa: uma empresa que desligasse o Catálogo por feed em Módulos por empresa continuava tendo o endereço buscado e o preço do catálogo reescrito, porque o interruptor do servidor estava ligado. Agora cada fonte é decidida com o `organization_id` dela: a que desligou não é lida, nada sai para a internet e nenhum campo da fonte é tocado, enquanto as demais seguem sendo sincronizadas na mesma rodada. O servidor continua sendo o teto; empresa sem linha herda a instalação; e se a leitura da linha por empresa falhar, aquela fonte não é processada em vez de ser processada às cegas.

O worker de cadência já pulava a empresa que desligou a cadência nas configurações dela — o que faltava era a organização chegar também à pergunta do módulo, e agora chega. A rodada continua lendo a fila inteira e decidindo por inscrição: a empresa que desligou não recebe sequência, a que está ligada recebe na mesma execução, e a instalação desligada não deixa nada rodar. Não muda nada de banco, de tela nem de payload de job. Contribuição de @webtecnica (issue #4871).
