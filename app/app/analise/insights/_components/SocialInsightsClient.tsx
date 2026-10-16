"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  ArrowSquareOut,
  ArrowsClockwise,
  ChartBar,
  ChartLineUp,
  ChatCircle,
  Eye,
  FacebookLogo,
  Gear,
  Heart,
  InstagramLogo,
  PlugsConnected,
  Sparkle,
  Users,
} from "@/lib/ui/icons";
import { useT } from "@/hooks/i18n/useT";
import {
  useDisconnectSocial,
  useSaveSocialConnection,
  useSocialInsights,
  useSocialInsightsConnection,
  useSyncSocialInsights,
} from "@/hooks/insights/useSocialInsights";
import type { SocialPlatformFilter } from "@/lib/social-insights/types";

interface Props {
  podeGerenciar: boolean;
}

export function SocialInsightsClient({ podeGerenciar }: Props) {
  const t = useT();
  const [platform, setPlatform] = useState<SocialPlatformFilter>("all");
  const [diasPeriodo, setDiasPeriodo] = useState<number>(30);
  const [modalConexaoAberto, setModalConexaoAberto] = useState(false);

  // Calcula datas
  const { de, ate } = useMemo(() => {
    const hoje = new Date();
    const dataFim = hoje.toISOString().slice(0, 10);
    const dataInicio = new Date(hoje.getTime() - diasPeriodo * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    return { de: dataInicio, ate: dataFim };
  }, [diasPeriodo]);

  const { data: dados, isLoading, refetch } = useSocialInsights(platform, de, ate);
  const { data: conexao } = useSocialInsightsConnection();
  const syncMutation = useSyncSocialInsights();
  const saveConnMutation = useSaveSocialConnection();
  const disconnectMutation = useDisconnectSocial();

  // Formulário do modal de conexão
  const [formPageId, setFormPageId] = useState("");
  const [formPageName, setFormPageName] = useState("");
  const [formIgId, setFormIgId] = useState("");
  const [formIgUser, setFormIgUser] = useState("");
  const [formToken, setFormToken] = useState("");

  const abrirModalConexao = () => {
    if (conexao) {
      setFormPageId(conexao.facebook_page_id ?? "");
      setFormPageName(conexao.facebook_page_name ?? "");
      setFormIgId(conexao.instagram_business_id ?? "");
      setFormIgUser(conexao.instagram_username ?? "");
    }
    setFormToken("");
    setModalConexaoAberto(true);
  };

  const salvarConexao = async (e: React.FormEvent) => {
    e.preventDefault();
    await saveConnMutation.mutateAsync({
      facebook_page_id: formPageId.trim() || null,
      facebook_page_name: formPageName.trim() || null,
      instagram_business_id: formIgId.trim() || null,
      instagram_username: formIgUser.trim() || null,
      access_token: formToken.trim() || null,
    });
    toast.success(t("Credenciais de redes sociais salvas com sucesso!"));
    setModalConexaoAberto(false);
  };

  const handleSincronizar = async () => {
    try {
      await syncMutation.mutateAsync();
      toast.success(t("Métricas sincronizadas com a Meta!"));
      await refetch();
    } catch {
      // Erro tratado via toast global
    }
  };

  const handleDesconectar = async () => {
    if (!confirm(t("Deseja realmente desconectar as contas de redes sociais?"))) return;
    await disconnectMutation.mutateAsync();
    toast.success(t("Contas desconectadas."));
    setModalConexaoAberto(false);
  };

  const summary = dados?.summary ?? {
    total_impressions: 0,
    total_reach: 0,
    total_new_followers: 0,
    total_followers: 0,
    total_interactions: 0,
    total_profile_views: 0,
  };

  const timeline = dados?.timeline ?? [];
  const recentPosts = dados?.recentPosts ?? [];

  // Encontra valores máximos para os gráficos SVG
  const maxReach = useMemo(() => {
    return Math.max(...timeline.map((p) => p.reach), 10);
  }, [timeline]);

  const maxImpressions = useMemo(() => {
    return Math.max(...timeline.map((p) => p.impressions), 10);
  }, [timeline]);

  return (
    <div className="flex flex-col gap-6" data-testid="social-insights-root">
      {/* Barra de Filtros e Ações */}
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border bg-card p-4 shadow-sm">
        <div className="flex flex-wrap items-center gap-3">
          {/* Seletor de Plataforma */}
          <div className="flex items-center rounded-lg border bg-muted/40 p-1">
            <button
              type="button"
              onClick={() => setPlatform("all")}
              className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                platform === "all"
                  ? "bg-background text-foreground shadow-xs"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <Sparkle className="size-3.5" />
              {t("Todas")}
            </button>
            <button
              type="button"
              onClick={() => setPlatform("facebook")}
              className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                platform === "facebook"
                  ? "bg-blue-600 text-white shadow-xs"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <FacebookLogo className="size-3.5" />
              {t("Facebook")}
            </button>
            <button
              type="button"
              onClick={() => setPlatform("instagram")}
              className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                platform === "instagram"
                  ? "bg-gradient-to-r from-amber-500 via-rose-500 to-purple-600 text-white shadow-xs"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <InstagramLogo className="size-3.5" />
              {t("Instagram")}
            </button>
          </div>

          {/* Seletor de Período */}
          <div className="flex items-center rounded-lg border bg-muted/40 p-1 text-xs">
            {[7, 14, 30, 90, 365].map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setDiasPeriodo(d)}
                className={`rounded-md px-2.5 py-1.5 font-medium transition-colors ${
                  diasPeriodo === d
                    ? "bg-background text-foreground shadow-xs"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {d === 365 ? t("1 ano") : `${d} ${t("dias")}`}
              </button>
            ))}
          </div>
        </div>

        {/* Botões de Ação */}
        <div className="flex items-center gap-2">
          {podeGerenciar ? (
            <Button
              variant="outline"
              size="sm"
              onClick={abrirModalConexao}
              className="gap-1.5"
            >
              <Gear className="size-4" />
              {conexao?.has_token ? t("Configurar Contas") : t("Conectar Redes")}
            </Button>
          ) : null}

          <Button
            variant="default"
            size="sm"
            onClick={handleSincronizar}
            disabled={syncMutation.isPending || !conexao?.has_token}
            className="gap-1.5"
          >
            <ArrowsClockwise
              className={`size-4 ${syncMutation.isPending ? "animate-spin" : ""}`}
            />
            {syncMutation.isPending ? t("Sincronizando…") : t("Sincronizar")}
          </Button>
        </div>
      </div>

      {/* Alerta de Conexão Não Configurada */}
      {!conexao?.has_token && (
        <Card className="border-amber-500/30 bg-amber-50/50 p-4 dark:bg-amber-950/20">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <PlugsConnected className="size-6 text-amber-600" />
              <div>
                <h3 className="font-semibold text-sm text-amber-900 dark:text-amber-200">
                  {t("Conecte suas contas do Instagram e Facebook")}
                </h3>
                <p className="text-xs text-amber-700/80 dark:text-amber-400">
                  {t(
                    "Insira o ID da Página do Facebook e da conta comercial do Instagram para puxar dados em tempo real da Meta Graph API.",
                  )}
                </p>
              </div>
            </div>
            {podeGerenciar && (
              <Button size="sm" onClick={abrirModalConexao} className="shrink-0">
                {t("Conectar Agora")}
              </Button>
            )}
          </div>
        </Card>
      )}

      {/* Dica de Período se o intervalo selecionado não tiver novos posts */}
      {summary.total_reach === 0 && summary.total_impressions === 0 && recentPosts.length > 0 && diasPeriodo < 365 && (
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 rounded-lg border border-blue-500/20 bg-blue-50/50 p-3 text-xs text-blue-900 dark:bg-blue-950/20 dark:text-blue-300">
          <span>
            💡 <strong>Nenhuma nova publicação nos últimos {diasPeriodo} dias.</strong> As métricas de seguidores estão atualizadas em tempo real. Para visualizar o alcance e histórico de publicações anteriores, selecione <strong>1 ano</strong>.
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setDiasPeriodo(365)}
            className="h-7 text-xs border-blue-300 dark:border-blue-700 shrink-0"
          >
            {t("Visualizar 1 ano")}
          </Button>
        </div>
      )}

      {/* Cards de Métricas Principais (KPIs) */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {/* Card 1: Alcance / Visualizações */}
        <Card className="p-4 transition-shadow hover:shadow-md">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              {t("Alcance Único")}
            </span>
            <div className="rounded-full bg-blue-500/10 p-2 text-blue-600 dark:text-blue-400">
              <Eye className="size-4" />
            </div>
          </div>
          <div className="mt-3">
            <span className="text-3xl font-bold tracking-tight">
              {summary.total_reach.toLocaleString()}
            </span>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("Contas únicas que visualizaram seus posts")}
            </p>
          </div>
        </Card>

        {/* Card 2: Total de Impressões */}
        <Card className="p-4 transition-shadow hover:shadow-md">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              {t("Total de Impressões")}
            </span>
            <div className="rounded-full bg-purple-500/10 p-2 text-purple-600 dark:text-purple-400">
              <ChartBar className="size-4" />
            </div>
          </div>
          <div className="mt-3">
            <span className="text-3xl font-bold tracking-tight">
              {summary.total_impressions.toLocaleString()}
            </span>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("Vezes que suas publicações apareceram na tela")}
            </p>
          </div>
        </Card>

        {/* Card 3: Seguidores */}
        <Card className="p-4 transition-shadow hover:shadow-md">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              {summary.total_followers > 0 ? t("Total de Seguidores") : t("Novos Seguidores")}
            </span>
            <div className="rounded-full bg-emerald-500/10 p-2 text-emerald-600 dark:text-emerald-400">
              <Users className="size-4" />
            </div>
          </div>
          <div className="mt-3">
            <span className="text-3xl font-bold tracking-tight text-emerald-600 dark:text-emerald-400">
              {summary.total_followers > 0
                ? summary.total_followers.toLocaleString()
                : `+${summary.total_new_followers.toLocaleString()}`}
            </span>
            <p className="mt-1 text-xs text-muted-foreground">
              {summary.total_followers > 0
                ? `${t("Novos no período:")} +${summary.total_new_followers}`
                : t("Ganho de seguidores orgânicos no período")}
            </p>
          </div>
        </Card>

        {/* Card 4: Interações / Visitas */}
        <Card className="p-4 transition-shadow hover:shadow-md">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              {t("Interações & Engajamento")}
            </span>
            <div className="rounded-full bg-amber-500/10 p-2 text-amber-600 dark:text-amber-400">
              <ChartLineUp className="size-4" />
            </div>
          </div>
          <div className="mt-3">
            <span className="text-3xl font-bold tracking-tight">
              {(summary.total_interactions + summary.total_profile_views).toLocaleString()}
            </span>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("Curtidas, comentários e visitas ao perfil")}
            </p>
          </div>
        </Card>
      </div>

      {/* Gráfico Temporal SVG */}
      <Card className="p-5">
        <CardHeader className="p-0 pb-4">
          <CardTitle className="text-base font-semibold">
            {t("Evolução Diária de Alcance e Impressões")}
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            {t("Comparativo diário de visualizações no período selecionado.")}
          </p>
        </CardHeader>
        <CardContent className="p-0 pt-2">
          {timeline.length === 0 ? (
            <div className="flex h-56 items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
              {t("Nenhum dado registrado para o período selecionado. Clique em Sincronizar.")}
            </div>
          ) : (
            <div className="h-64 w-full">
              <div className="flex h-48 items-end gap-1 sm:gap-2 pt-6">
                {timeline.map((item, idx) => {
                  const hReach = Math.max(Math.round((item.reach / maxReach) * 100), 4);
                  const hImp = Math.max(Math.round((item.impressions / maxImpressions) * 100), 4);
                  return (
                    <div
                      key={item.date}
                      className="group relative flex flex-1 flex-col items-center justify-end h-full"
                    >
                      {/* Tooltip no hover */}
                      <div className="pointer-events-none absolute bottom-full mb-2 hidden rounded-md bg-popover p-2 text-[10px] text-popover-foreground shadow-lg border z-10 group-hover:block whitespace-nowrap">
                        <p className="font-semibold">{item.date}</p>
                        <p className="text-blue-500">{t("Alcance:")} {item.reach.toLocaleString()}</p>
                        <p className="text-purple-500">{t("Impressões:")} {item.impressions.toLocaleString()}</p>
                        <p className="text-emerald-500">{t("Seguidores:")} +{item.new_followers}</p>
                        <p className="text-amber-500">{t("Interações:")} {item.interactions}</p>
                      </div>

                      <div className="flex items-end gap-0.5 sm:gap-1 w-full justify-center h-full">
                        <div
                          style={{ height: `${hReach}%` }}
                          className="w-1.5 sm:w-3 rounded-t-sm bg-blue-500 transition-all hover:opacity-80"
                        />
                        <div
                          style={{ height: `${hImp}%` }}
                          className="w-1.5 sm:w-3 rounded-t-sm bg-purple-500/80 transition-all hover:opacity-80"
                        />
                      </div>
                      <span className="mt-2 text-[9px] text-muted-foreground truncate w-full text-center">
                        {idx % 4 === 0 || idx === timeline.length - 1 ? item.date.slice(5) : ""}
                      </span>
                    </div>
                  );
                })}
              </div>

              {/* Legenda do Gráfico */}
              <div className="mt-4 flex items-center justify-center gap-6 text-xs text-muted-foreground">
                <div className="flex items-center gap-1.5">
                  <div className="size-3 rounded-xs bg-blue-500" />
                  <span>{t("Alcance Único")}</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <div className="size-3 rounded-xs bg-purple-500" />
                  <span>{t("Impressões")}</span>
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Comparativo de Plataformas: Facebook vs Instagram */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {/* Facebook Box */}
        <Card className="p-4 border-l-4 border-l-blue-600">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <FacebookLogo className="size-5 text-blue-600" />
              <h3 className="font-semibold text-sm">{t("Desempenho no Facebook")}</h3>
            </div>
            {conexao?.facebook_page_name && (
              <Badge variant="secondary" className="text-xs">
                {conexao.facebook_page_name}
              </Badge>
            )}
          </div>
          <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
            <div className="rounded-md bg-muted/30 p-2.5">
              <span className="text-xs text-muted-foreground">{t("Total Seguidores")}</span>
              <p className="text-lg font-bold text-blue-600">
                {dados?.facebookSummary.total_followers.toLocaleString() ?? 0}
              </p>
            </div>
            <div className="rounded-md bg-muted/30 p-2.5">
              <span className="text-xs text-muted-foreground">{t("Impressões")}</span>
              <p className="text-lg font-bold">
                {dados?.facebookSummary.total_impressions.toLocaleString() ?? 0}
              </p>
            </div>
            <div className="rounded-md bg-muted/30 p-2.5">
              <span className="text-xs text-muted-foreground">{t("Novos Seguidores")}</span>
              <p className="text-lg font-bold text-emerald-600">
                +{dados?.facebookSummary.total_new_followers.toLocaleString() ?? 0}
              </p>
            </div>
            <div className="rounded-md bg-muted/30 p-2.5">
              <span className="text-xs text-muted-foreground">{t("Interações")}</span>
              <p className="text-lg font-bold">
                {dados?.facebookSummary.total_interactions.toLocaleString() ?? 0}
              </p>
            </div>
          </div>
        </Card>

        {/* Instagram Box */}
        <Card className="p-4 border-l-4 border-l-rose-500">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <InstagramLogo className="size-5 text-rose-500" />
              <h3 className="font-semibold text-sm">{t("Desempenho no Instagram")}</h3>
            </div>
            {conexao?.instagram_username && (
              <Badge variant="secondary" className="text-xs font-mono">
                @{conexao.instagram_username}
              </Badge>
            )}
          </div>
          <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
            <div className="rounded-md bg-muted/30 p-2.5">
              <span className="text-xs text-muted-foreground">{t("Total Seguidores")}</span>
              <p className="text-lg font-bold text-rose-600">
                {dados?.instagramSummary.total_followers.toLocaleString() ?? 0}
              </p>
            </div>
            <div className="rounded-md bg-muted/30 p-2.5">
              <span className="text-xs text-muted-foreground">{t("Impressões")}</span>
              <p className="text-lg font-bold">
                {dados?.instagramSummary.total_impressions.toLocaleString() ?? 0}
              </p>
            </div>
            <div className="rounded-md bg-muted/30 p-2.5">
              <span className="text-xs text-muted-foreground">{t("Novos Seguidores")}</span>
              <p className="text-lg font-bold text-emerald-600">
                +{dados?.instagramSummary.total_new_followers.toLocaleString() ?? 0}
              </p>
            </div>
            <div className="rounded-md bg-muted/30 p-2.5">
              <span className="text-xs text-muted-foreground">{t("Visitas ao Perfil")}</span>
              <p className="text-lg font-bold">
                {dados?.instagramSummary.total_profile_views.toLocaleString() ?? 0}
              </p>
            </div>
          </div>
        </Card>
      </div>

      {/* Seção: Publicações Recentes & Engajamento */}
      {recentPosts.length > 0 && (
        <Card className="p-5">
          <CardHeader className="p-0 pb-4">
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-base font-semibold">
                  {t("Publicações Recentes & Engajamento")}
                </CardTitle>
                <p className="text-xs text-muted-foreground">
                  {t("Últimas postagens sincronizadas das suas contas com curtidas e comentários.")}
                </p>
              </div>
              <Badge variant="outline" className="text-xs">
                {recentPosts.length} {t("publicações")}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="p-0 pt-2">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {recentPosts.slice(0, 9).map((post) => (
                <div
                  key={post.id}
                  className="flex flex-col justify-between rounded-lg border bg-muted/20 p-3.5 transition-all hover:bg-muted/40 hover:shadow-xs"
                >
                  <div>
                    <div className="flex items-center justify-between gap-2 mb-2">
                      <div className="flex items-center gap-1.5">
                        {post.platform === "facebook" ? (
                          <FacebookLogo className="size-4 text-blue-600" />
                        ) : (
                          <InstagramLogo className="size-4 text-rose-500" />
                        )}
                        <span className="text-[11px] font-medium capitalize text-muted-foreground">
                          {post.platform}
                        </span>
                      </div>
                      <span className="text-[10px] text-muted-foreground">
                        {new Date(post.timestamp).toLocaleDateString()}
                      </span>
                    </div>

                    <p className="text-xs text-foreground/90 line-clamp-3 leading-relaxed mb-3">
                      {post.caption || t("Sem legenda")}
                    </p>
                  </div>

                  <div className="flex items-center justify-between pt-2 border-t text-xs text-muted-foreground">
                    <div className="flex items-center gap-3">
                      <span className="flex items-center gap-1 text-rose-600 dark:text-rose-400 font-medium">
                        <Heart className="size-3.5" />
                        {post.like_count}
                      </span>
                      <span className="flex items-center gap-1 text-blue-600 dark:text-blue-400 font-medium">
                        <ChatCircle className="size-3.5" />
                        {post.comments_count}
                      </span>
                    </div>

                    {post.permalink && (
                      <a
                        href={post.permalink}
                        target="_blank"
                        rel="noreferrer"
                        className="flex items-center gap-1 text-[11px] text-primary hover:underline"
                      >
                        {t("Abrir")}
                        <ArrowSquareOut className="size-3" />
                      </a>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Modal de Configuração de Contas */}
      <Dialog open={modalConexaoAberto} onOpenChange={setModalConexaoAberto}>
        <DialogContent className="sm:max-w-md">
          <form onSubmit={salvarConexao}>
            <DialogHeader>
              <DialogTitle>{t("Conexão com Redes Sociais")}</DialogTitle>
              <DialogDescription>
                {t(
                  "Conecte sua Página do Facebook e Conta Profissional do Instagram via Meta Graph API.",
                )}
              </DialogDescription>
            </DialogHeader>

            <div className="grid gap-4 py-4 text-xs">
              <div className="grid gap-1.5">
                <Label htmlFor="fb-page-id">{t("ID da Página do Facebook")}</Label>
                <Input
                  id="fb-page-id"
                  placeholder="Ex: 1488415074508819"
                  value={formPageId}
                  onChange={(e) => setFormPageId(e.target.value)}
                />
              </div>

              <div className="grid gap-1.5">
                <Label htmlFor="fb-page-name">{t("Nome da Página (Opcional)")}</Label>
                <Input
                  id="fb-page-name"
                  placeholder="Ex: Churrasqueando"
                  value={formPageName}
                  onChange={(e) => setFormPageName(e.target.value)}
                />
              </div>

              <div className="grid gap-1.5">
                <Label htmlFor="ig-id">{t("ID do Instagram Business (Graph API)")}</Label>
                <Input
                  id="ig-id"
                  placeholder="Ex: 17841404219987198"
                  value={formIgId}
                  onChange={(e) => setFormIgId(e.target.value)}
                />
              </div>

              <div className="grid gap-1.5">
                <Label htmlFor="ig-user">{t("Nome de Usuário do Instagram (@)")}</Label>
                <Input
                  id="ig-user"
                  placeholder="Ex: lojachurrasqueando"
                  value={formIgUser}
                  onChange={(e) => setFormIgUser(e.target.value)}
                />
              </div>

              <div className="grid gap-1.5">
                <Label htmlFor="meta-token">{t("Token de Acesso da Meta")}</Label>
                <Input
                  id="meta-token"
                  type="password"
                  placeholder={conexao?.has_token ? t("•••••••• (deixe em branco para manter)") : t("Cole seu token permanente da Meta")}
                  value={formToken}
                  onChange={(e) => setFormToken(e.target.value)}
                />
                <p className="text-[10px] text-muted-foreground">
                  {t(
                    "O token é armazenado com criptografia forte no banco de dados e utilizado para consultas de relatórios.",
                  )}
                </p>
              </div>
            </div>

            <DialogFooter className="flex items-center justify-between sm:justify-between w-full">
              {conexao?.has_token ? (
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  onClick={handleDesconectar}
                  disabled={disconnectMutation.isPending}
                >
                  {t("Desconectar")}
                </Button>
              ) : <div />}

              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setModalConexaoAberto(false)}
                >
                  {t("Cancelar")}
                </Button>
                <Button type="submit" size="sm" disabled={saveConnMutation.isPending}>
                  {saveConnMutation.isPending ? t("Salvando…") : t("Salvar")}
                </Button>
              </div>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
