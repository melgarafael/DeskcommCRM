#!/bin/bash
docker exec -i supabase-db psql -U postgres -d postgres -c "select platform, date, impressions, reach, interactions, new_followers, followers_count from social_insights_daily where platform = 'facebook' order by date desc limit 25;"
echo "=== INSTAGRAM ==="
docker exec -i supabase-db psql -U postgres -d postgres -c "select platform, date, impressions, reach, interactions, new_followers, followers_count from social_insights_daily where platform = 'instagram' order by date desc limit 25;"
