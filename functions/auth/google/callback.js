// Handles Google OAuth callback — exchanges code for tokens, passes refresh token to frontend
export async function onRequest(context) {
  const { env, request } = context;
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error || !code) {
    return new Response(`<html><body><script>
      alert("Google auth failed: ${error || 'No code returned'}");
      window.location.href = '/';
    </script></body></html>`, { headers: { 'Content-Type': 'text/html' } });
  }

  const redirectUri = `${url.origin}/auth/google/callback`;

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code'
    })
  });

  const tokenData = await tokenRes.json();

  if (tokenData.error || !tokenData.refresh_token) {
    return new Response(`<html><body><script>
      alert("Token exchange failed: ${tokenData.error_description || tokenData.error || 'No refresh token'}");
      window.location.href = '/';
    </script></body></html>`, { headers: { 'Content-Type': 'text/html' } });
  }

  // Pass the refresh token to the frontend via URL param (localStorage set in JS)
  const rt = encodeURIComponent(tokenData.refresh_token);
  return Response.redirect(`/?google_rt=${rt}`, 302);
}
