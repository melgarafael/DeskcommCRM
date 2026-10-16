#!/bin/bash
docker exec -i supabase-db psql -U postgres -d postgres -c "select platform, date, impressions, reach, interactions from social_insights_daily where date < '2026-03-01' order by date desc limit 10;"
