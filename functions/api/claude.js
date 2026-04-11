export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type' } });
  if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  const { messages, system, stream = true, model = 'claude-sonnet-4-6', max_tokens = 1000 } = await request.json();
  if (!messages || !messages.length) return new Response(JSON.stringify({ error: 'No messages' }), { status: 400, headers: { 'Content-Type': 'application/json' } });

  const body = { model, max_tokens, messages, stream };
  if (system) body.system = system;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(body)
  });

  if (!stream) {
    const data = await res.json();
    return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
  }

  // Stream the response back
  return new Response(res.body, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*'
    }
  });
}
