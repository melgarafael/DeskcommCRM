export type SocialPlatform = "facebook" | "instagram";
export type SocialPlatformFilter = "all" | "facebook" | "instagram";

export interface SocialMetricPoint {
  date: string;
  impressions: number;
  reach: number;
  followers_count: number;
  new_followers: number;
  profile_views: number;
  interactions: number;
}

export interface SocialInsightsSummary {
  total_impressions: number;
  total_reach: number;
  total_new_followers: number;
  total_followers: number;
  total_interactions: number;
  total_profile_views: number;
}

export interface SocialRecentPost {
  id: string;
  platform: SocialPlatform;
  caption: string;
  media_type: string;
  permalink?: string;
  timestamp: string;
  like_count: number;
  comments_count: number;
}

export interface SocialConnectionInfo {
  facebook_page_id: string | null;
  facebook_page_name: string | null;
  instagram_business_id: string | null;
  instagram_username: string | null;
  status: string;
  last_synced_at: string | null;
  has_token: boolean;
  recent_posts?: SocialRecentPost[];
}

export interface SocialInsightsResponse {
  summary: SocialInsightsSummary;
  timeline: SocialMetricPoint[];
  recentPosts: SocialRecentPost[];
  facebookSummary: SocialInsightsSummary;
  instagramSummary: SocialInsightsSummary;
  hasConnection: boolean;
  connection?: SocialConnectionInfo;
}

export interface SaveSocialConnectionInput {
  facebook_page_id?: string | null;
  facebook_page_name?: string | null;
  instagram_business_id?: string | null;
  instagram_username?: string | null;
  access_token?: string | null;
}
