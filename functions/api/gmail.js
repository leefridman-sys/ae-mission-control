export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
  const clientId = env.GOOGLE_CLIENT_ID; const clientSecret = env.GOOGLE_CLIENT_SECRET;
  try {
    const { refreshToken } = await request.json();
    if (!refreshToken) return new Response(JSON.stringify({ error: 'No refresh token' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret, grant_type: 'refresh_token' }) });
    const tokenData = await tokenRes.json();
    if (tokenData.error) return new Response(JSON.stringify({ error: tokenData.error_description }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    const accessToken = tokenData.access_token;
    const listRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=is:unread&maxResults=40`, { headers: { Authorization: `Bearer ${accessToken}` } });
    const listData = await listRes.json();
    if (listData.error) return new Response(JSON.stringify({ error: listData.error.message }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    const messages = listData.messages || [];
    if (!messages.length) return new Response(JSON.stringify([]), { headers: { 'Content-Type': 'application/json' } });
    const emails = await Promise.all(messages.slice(0, 30).map(async (msg) => {
      const msgRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`, { headers: { Authorization: `Bearer ${accessToken}` } });
      const msgData = await msgRes.json();
      const headers = (msgData.payload && msgData.payload.headers) || [];
      const get = (name) => (headers.find(h => h.name === name) || {}).value || '';
      const snippet = msgData.snippet ? msgData.snippet.replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"').slice(0, 140) : '';
      const fromRaw = get('From'); const fromName = fromRaw.replace(/<[^>]+>/, '').trim().replace(/^"|"$/g, '').trim();
      const labels = msgData.labelIds || []; const isStarred = labels.includes('STARRED');
      const dateRaw = get('Date'); let dateFormatted = '';
      try { const d = new Date(dateRaw); const now = new Date(); const today2 = new Date(now.getFullYear(), now.getMonth(), now.getDate()); const msgDate = new Date(d.getFullYear(), d.getMonth(), d.getDate()); const diffDays = Math.round((today2 - msgDate) / 86400000); if (diffDays === 0) dateFormatted = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }); else if (diffDays === 1) dateFormatted = 'Yesterday'; else if (diffDays < 7) dateFormatted = d.toLocaleDateString('en-US', { weekday: 'short' }); else dateFormatted = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); } catch(e) { dateFormatted = dateRaw; }
      return { id: msg.id, subject: get('Subject'), from: fromName, date: dateFormatted, snippet, isStarred };
    }));
    return new Response(JSON.stringify(emails), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
  } catch(e) { return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json' } }); }
}
