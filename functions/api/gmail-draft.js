export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type' } });
  if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  const clientId = env.GOOGLE_CLIENT_ID;
  const clientSecret = env.GOOGLE_CLIENT_SECRET;

  try {
    const { refreshToken, drafts } = await request.json();
    if (!refreshToken) return new Response(JSON.stringify({ error: 'No refresh token' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    if (!drafts || !drafts.length) return new Response(JSON.stringify({ error: 'No drafts provided' }), { status: 400, headers: { 'Content-Type': 'application/json' } });

    // Refresh access token
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret, grant_type: 'refresh_token' })
    });
    const tokenData = await tokenRes.json();
    if (tokenData.error) return new Response(JSON.stringify({ error: tokenData.error_description || tokenData.error }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    const accessToken = tokenData.access_token;

    // Create each draft
    const results = await Promise.all(drafts.map(async (d) => {
      try {
        // Build RFC 2822 message — only include non-empty header lines
        const headers = [
          d.to  ? `To: ${d.to}`   : null,
          d.cc  ? `Cc: ${d.cc}`   : null,
          `Subject: ${d.subject || '(no subject)'}`,
          'Content-Type: text/plain; charset=UTF-8',
          'MIME-Version: 1.0',
        ].filter(Boolean);
        const raw = [...headers, '', d.body || ''].join('\r\n');

        // base64url encode using TextEncoder — handles all Unicode (incl. box-drawing chars)
        const bytes = new TextEncoder().encode(raw);
        const binaryStr = Array.from(bytes, b => String.fromCharCode(b)).join('');
        const encoded = btoa(binaryStr)
          .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

        const draftRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/drafts', {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: { raw: encoded } })
        });
        const draftData = await draftRes.json();
        if (draftData.error) return { ok: false, to: d.to, error: draftData.error.message };
        return { ok: true, to: d.to, draftId: draftData.id };
      } catch(e) {
        return { ok: false, to: d.to, error: e.message };
      }
    }));

    const created = results.filter(r => r.ok).length;
    return new Response(JSON.stringify({ created, total: drafts.length, results }), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  } catch(e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
  }
}
