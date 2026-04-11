export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
  const clientId = env.GOOGLE_CLIENT_ID;
  const clientSecret = env.GOOGLE_CLIENT_SECRET;

  try {
    const { refreshToken, messageId } = await request.json();
    if (!refreshToken || !messageId) return new Response(JSON.stringify({ error: 'Missing refreshToken or messageId' }), { status: 400, headers: { 'Content-Type': 'application/json' } });

    // Refresh access token
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret, grant_type: 'refresh_token' })
    });
    const tokenData = await tokenRes.json();
    if (tokenData.error) return new Response(JSON.stringify({ error: tokenData.error_description || tokenData.error }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    const accessToken = tokenData.access_token;

    // Fetch the specific message
    const msgRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const msg = await msgRes.json();
    if (msg.error) return new Response(JSON.stringify({ error: msg.error.message }), { status: 400, headers: { 'Content-Type': 'application/json' } });

    const headers = (msg.payload && msg.payload.headers) || [];
    const get = (name) => (headers.find(h => h.name.toLowerCase() === name.toLowerCase()) || {}).value || '';

    // Decode base64url to string
    function decodeB64(data) {
      try { return decodeURIComponent(escape(atob(data.replace(/-/g, '+').replace(/_/g, '/')))); }
      catch(e) { try { return atob(data.replace(/-/g, '+').replace(/_/g, '/')); } catch(e2) { return ''; } }
    }

    // Clean up body text — strip inline image refs, mailto links, excess whitespace
    function cleanBody(text) {
      return text
        .replace(/\[cid:[^\]]+\]/gi, '')
        .replace(/<mailto:[^>]+>/gi, '')
        .replace(/https?:\/\/\S+/g, '[link]')
        .replace(/\r\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/_{5,}/g, '---')
        .trim();
    }

    // Recursively extract plain text body from MIME, preferring text/plain
    function extractBody(payload) {
      if (!payload) return '';
      const mime = payload.mimeType || '';
      if (mime === 'text/plain' && payload.body && payload.body.data) return decodeB64(payload.body.data);
      if (mime === 'text/html' && payload.body && payload.body.data) {
        return decodeB64(payload.body.data)
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;/gi, ' ')
          .replace(/&amp;/gi, '&')
          .replace(/&lt;/gi, '<')
          .replace(/&gt;/gi, '>')
          .replace(/\s{2,}/g, ' ')
          .trim();
      }
      if (payload.parts) {
        // Prefer text/plain parts first
        const plain = payload.parts.find(p => p.mimeType === 'text/plain');
        if (plain) { const t = extractBody(plain); if (t) return t; }
        // Then try any other part recursively
        for (const part of payload.parts) { const t = extractBody(part); if (t) return t; }
      }
      if (payload.body && payload.body.data) return decodeB64(payload.body.data);
      return '';
    }

    // Extract headers helper for thread messages
    function getHeader(hdrs, name) {
      return ((hdrs || []).find(h => h.name.toLowerCase() === name.toLowerCase()) || {}).value || '';
    }

    const threadId = msg.threadId;

    // Fetch the full thread to get all messages
    let threadMessages = [];
    try {
      const threadRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/threads/${threadId}?format=full`, {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      const threadData = await threadRes.json();
      if (threadData.messages && Array.isArray(threadData.messages)) {
        threadMessages = threadData.messages.map(m => {
          const h = m.payload && m.payload.headers || [];
          const fromRaw = getHeader(h, 'From');
          const fromName = fromRaw.replace(/<[^>]+>/, '').trim().replace(/^"|"$/g, '').trim() || fromRaw;
          const dateRaw = getHeader(h, 'Date');
          let dateStr = dateRaw;
          try {
            const d = new Date(dateRaw);
            dateStr = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
          } catch(e) {}
          const rawBody = extractBody(m.payload);
          const body = cleanBody(rawBody).slice(0, 3000); // cap each message at 3000 chars
          return { from: fromName, date: dateStr, body };
        });
      }
    } catch(e) {
      // If thread fetch fails, fall back to single message
    }

    // Main message body (cleaned)
    const rawBody = extractBody(msg.payload);
    const body = cleanBody(rawBody).slice(0, 5000);

    // Format sender
    const fromRaw = get('From');
    const fromName = fromRaw.replace(/<[^>]+>/, '').trim().replace(/^"|"$/g, '').trim();
    const fromEmail = (fromRaw.match(/<([^>]+)>/) || [])[1] || fromRaw;

    // Format date
    const dateRaw = get('Date');
    let dateFormatted = dateRaw;
    try {
      const d = new Date(dateRaw);
      dateFormatted = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    } catch(e) {}

    return new Response(JSON.stringify({
      id: msg.id,
      threadId,
      fromName, fromEmail,
      to: get('To'),
      subject: get('Subject'),
      date: dateFormatted,
      body,
      thread: threadMessages  // full thread context
    }), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });

  } catch(e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
  }
}
