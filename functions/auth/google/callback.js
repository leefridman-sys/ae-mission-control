// Handles Google OAuth callback — exchanges code for tokens, passes refresh token to frontend
export async function onRequest(context) {
  const { env, request } = context;

  try {
    const url = new URL(request.url);
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');

    if (error || !code) {
      return new Response(`<html><body><script>
        alert("Google auth failed: " + ${JSON.stringify(error || 'No code returned')});
        window.location.href = '/';
      </script></body></html>`, { headers: { 'Content-Type': 'text/html' } });
    }

    const redirectUri = `https://ae-mission-control.pages.dev/auth/google/callback`;

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: env.GOOGLE_CLIENT_ID || 'MISSING_CLIENT_ID',
        client_secret: env.GOOGLE_CLIENT_SECRET || 'MISSING_CLIENT_SECRET',
        redirect_uri: redirectUri,
        grant_type: 'authorization_code'
      })
    });

    const rawText = await tokenRes.text();
    let tokenData;
    try {
      tokenData = JSON.parse(rawText);
    } catch(e) {
      return new Response(`<html><body><script>
        alert("Failed to parse token response: " + ${JSON.stringify(rawText.slice(0, 200))});
        window.location.href = '/';
      </script></body></html>`, { headers: { 'Content-Type': 'text/html' } });
    }

    if (tokenData.error || !tokenData.refresh_token) {
      const msg = tokenData.error_description || tokenData.error || 'No refresh token returned';
      return new Response(`<html><body><script>
        alert("Token exchange failed: " + ${JSON.stringify(msg)});
        window.location.href = '/';
      </script></body></html>`, { headers: { 'Content-Type': 'text/html' } });
    }

    const rt = encodeURIComponent(tokenData.refresh_token);
    return Response.redirect(`/?google_rt=${rt}`, 302);

  } catch(err) {
    return new Response(`<html><body><script>
      alert("Callback exception: " + ${JSON.stringify(String(err))});
      window.location.href = '/';
    </script></body></html>`, { headers: { 'Content-Type': 'text/html' } });
  }
}
