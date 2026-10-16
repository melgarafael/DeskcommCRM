import urllib.request
import json
import subprocess

def query_sql(sql):
    cmd = ["docker", "exec", "-i", "supabase-db", "psql", "-U", "postgres", "-d", "postgres", "-t", "-A", "-c", sql]
    return subprocess.check_output(cmd).decode().strip()

token = query_sql("select fn_decrypt_oauth(access_token_encrypted::bytea) from social_insights_connections limit 1;")
ig_id = query_sql("select instagram_business_id from social_insights_connections limit 1;")
fb_id = query_sql("select facebook_page_id from social_insights_connections limit 1;")
org_id = query_sql("select organization_id from social_insights_connections limit 1;")

print(f"Token len: {len(token)}, IG: {ig_id}, FB: {fb_id}")

posts = []

# Instagram
try:
    url = f"https://graph.facebook.com/v21.0/{ig_id}/media?fields=id,caption,media_type,permalink,timestamp,like_count,comments_count&limit=25&access_token={token}"
    req = urllib.request.Request(url)
    with urllib.request.urlopen(req) as resp:
        data = json.loads(resp.read().decode())
        for p in data.get('data', []):
            posts.append({
                'id': p.get('id'),
                'platform': 'instagram',
                'caption': p.get('caption', ''),
                'media_type': p.get('media_type', 'IMAGE'),
                'permalink': p.get('permalink'),
                'timestamp': p.get('timestamp'),
                'like_count': p.get('like_count', 0),
                'comments_count': p.get('comments_count', 0)
            })
except Exception as e:
    print('Erro IG:', e)

# Facebook Page
try:
    page_token_res = json.loads(urllib.request.urlopen(f"https://graph.facebook.com/v21.0/{fb_id}?fields=access_token&access_token={token}").read().decode())
    page_token = page_token_res.get('access_token')
    if page_token:
        feed_url = f"https://graph.facebook.com/v21.0/{fb_id}/feed?fields=id,message,created_time,shares,reactions.summary(total_count),comments.summary(total_count)&limit=15&access_token={page_token}"
        req = urllib.request.Request(feed_url)
        with urllib.request.urlopen(req) as resp:
            data = json.loads(resp.read().decode())
            for p in data.get('data', []):
                posts.append({
                    'id': p.get('id'),
                    'platform': 'facebook',
                    'caption': p.get('message', 'Publicação no Facebook'),
                    'media_type': 'POST',
                    'permalink': f"https://facebook.com/{p.get('id')}",
                    'timestamp': p.get('created_time'),
                    'like_count': p.get('reactions', {}).get('summary', {}).get('total_count', 0),
                    'comments_count': p.get('comments', {}).get('summary', {}).get('total_count', 0)
                })
except Exception as e:
    print('Erro FB:', e)

posts.sort(key=lambda x: x['timestamp'], reverse=True)
posts_json = json.dumps(posts).replace("'", "''")

sql = f"UPDATE social_insights_connections SET recent_posts = '{posts_json}'::jsonb WHERE organization_id = '{org_id}';"
subprocess.run(['docker', 'exec', '-i', 'supabase-db', 'psql', '-U', 'postgres', '-d', 'postgres', '-c', sql], check=True)
print(f"Salvos {len(posts)} posts em recent_posts com sucesso!")
