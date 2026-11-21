---
impacto: capacidade_nova
secao: adicionado
titulo: Catálogo por feed vira módulo por empresa
---

O Catálogo por feed passou a ser um módulo por empresa: em `admin/sistema`, na tela de módulos por empresa, aparece a linha **Catálogo por feed**, e a empresa que a desliga deixa de ter as fontes lidas.

O cron do catálogo por feed roda sozinho a cada 2 horas e percorre as fontes de várias empresas na mesma execução. Agora cada fonte é decidida com o `organization_id` dela: a que desligou não é lida, nada sai para a internet e nenhum campo da fonte é tocado, enquanto as demais seguem sendo sincronizadas na mesma rodada. O servidor continua sendo o teto; empresa sem linha herda a instalação; e se a leitura da linha por empresa falhar, aquela fonte não é processada em vez de ser processada às cegas.

O worker de cadência já pulava a empresa que desligou a cadência nas configurações dela — o que faltava era a organização chegar também à pergunta do módulo, e agora chega. A rodada continua lendo a fila inteira e decidindo por inscrição. Nada muda no banco nem no payload dos jobs. Contribuição de @webtecnica (issue #4871).
