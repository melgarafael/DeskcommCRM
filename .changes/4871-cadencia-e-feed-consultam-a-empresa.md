---
impacto: capacidade_nova
secao: adicionado
titulo: Catálogo por feed vira módulo por empresa
---

O Catálogo por feed passou a ser um módulo por empresa: em `/admin/sistema`, na tela de módulos por empresa, aparece a linha **Catálogo sincronizado por feed**, e a empresa que a desliga deixa de ter as fontes lidas pelo trabalho de fundo.

O cron do catálogo por feed roda sozinho a cada 2 horas e percorre as fontes de várias empresas na mesma execução. Agora cada fonte é decidida com o `organization_id` dela: a que desligou não é lida, nada sai para a internet e nenhum campo da fonte é tocado, enquanto as demais seguem sendo sincronizadas na mesma rodada. O servidor continua sendo o teto; empresa sem linha herda a instalação; e se a leitura da linha por empresa falhar, aquela fonte não é processada em vez de ser processada às cegas.

O worker de cadência passa a levar a empresa à pergunta do módulo, mas a resposta não muda hoje: cadência é módulo de tabela, e o que a empresa desliga continua sendo a cadência nas configurações dela. Nada muda no banco nem no payload dos jobs. Contribuição de @webtecnica (issue #4871).
