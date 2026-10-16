#!/bin/bash
TOKEN=$(docker exec -i supabase-db psql -U postgres -d postgres -t -A -c "select fn_decrypt_oauth(decode(replace(access_token_encrypted, E'\\\\x', ''), 'hex')) from social_insights_connections limit 1;")
IG_ID=$(docker exec -i supabase-db psql -U postgres -d postgres -t -A -c "select instagram_business_id from social_insights_connections limit 1;")

curl -s "https://graph.facebook.com/v21.0/${IG_ID}?fields=followers_count,follows_count,media_count,name,username&access_token=${TOKEN}"
echo ""
