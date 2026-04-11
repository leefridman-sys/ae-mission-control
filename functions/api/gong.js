export async function onRequest(context) {
  const { request } = context;
  if (request.method === 'OPTIONS') return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type' } });
  if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  const { accessKey, accessSecret, action, callId, email } = await request.json();
  if (!accessKey || !accessSecret) return new Response(JSON.stringify({ error: 'Missing Gong credentials' }), { status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });

  // Gong uses Basic auth: base64(accessKey:accessSecret)
  const credentials = btoa(`${accessKey}:${accessSecret}`);
  const h = {
    'Authorization': `Basic ${credentials}`,
    'Content-Type': 'application/json'
  };

  try {
    if (action === 'recentCalls') {
      // Fetch recent calls (last 30 days)
      const fromDate = new Date();
      fromDate.setDate(fromDate.getDate() - 30);
      const fromIso = fromDate.toISOString();

      const callsRes = await fetch('https://api.gong.io/v2/calls?fromDateTime=' + encodeURIComponent(fromIso) + '&limit=10', { headers: h });
      const callsData = await callsRes.json();

      if (callsData.errors) {
        return new Response(JSON.stringify({ error: callsData.errors[0]?.message || 'Gong API error' }), { status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
      }

      const rawCalls = (callsData.calls || []);

      // For each call, try to get a brief summary/highlights
      const calls = await Promise.all(rawCalls.slice(0, 10).map(async (call) => {
        let summary = null;
        let risk = null;

        // Try to get call highlights
        try {
          const hRes = await fetch(`https://api.gong.io/v2/calls/${call.id}/highlights`, { headers: h });
          const hData = await hRes.json();
          const keyPoints = hData.highlights?.keyPoints || [];
          const risks = hData.highlights?.risks || [];
          if (keyPoints.length) summary = keyPoints.slice(0, 2).map(k => k.text || k).join(' | ');
          if (risks.length) risk = risks[0].text || risks[0];
        } catch (e) { /* highlights not available */ }

        // Duration formatting
        const dur = call.duration ? Math.round(call.duration / 60) + ' min' : null;

        // Format date
        const callDate = call.started ? new Date(call.started).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';

        return {
          id: call.id,
          title: call.title || call.name || 'Call',
          account: (call.parties || []).find(p => p.affiliation === 'External')?.name || call.account || '',
          date: callDate,
          duration: dur,
          summary,
          risk
        };
      }));

      // Extract unlogged next steps (simplified — in prod would cross-ref Salesforce)
      const nextSteps = calls
        .filter(c => c.summary && c.summary.toLowerCase().includes('next'))
        .slice(0, 5)
        .map(c => ({ text: c.summary, account: c.account, date: c.date }));

      return new Response(JSON.stringify({ calls, nextSteps }), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
    }

    if (action === 'callsByEmail') {
      // Find calls by participant email
      if (!email) return new Response(JSON.stringify({ error: 'email required' }), { status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
      const res = await fetch(`https://api.gong.io/v2/calls?participantEmail=${encodeURIComponent(email)}&limit=5`, { headers: h });
      const data = await res.json();
      const calls = (data.calls || []).map(c => ({
        id: c.id,
        title: c.title || c.name || 'Call',
        date: c.started ? new Date(c.started).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '',
        duration: c.duration ? Math.round(c.duration / 60) + ' min' : null
      }));
      return new Response(JSON.stringify({ calls }), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
    }

    return new Response(JSON.stringify({ error: 'Unknown action' }), { status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });

  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
  }
}
