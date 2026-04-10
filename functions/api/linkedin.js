export async function onRequest(context) {
  const { request } = context;
  if (request.method === 'OPTIONS') return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type' } });
  if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  const { accessToken, name, domain, linkedinUrl } = await request.json();
  if (!accessToken) return new Response(JSON.stringify({ error: 'Missing LinkedIn access token' }), { status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });

  const h = {
    'Authorization': `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'X-Restli-Protocol-Version': '2.0.0'
  };

  try {
    // LinkedIn Sales Navigator API — People Search
    // NOTE: Sales Navigator API requires special access. This implements the v2 people search.
    // If Sales Navigator API is not available, we fall back to returning a search URL.

    let searchQuery = '';
    if (name) searchQuery += name;
    if (domain) searchQuery += ' ' + domain.replace(/^www\./, '').split('.')[0];

    // Try Sales Navigator People Search API
    const searchRes = await fetch(
      `https://api.linkedin.com/v2/people?q=search&keywords=${encodeURIComponent(searchQuery)}&count=1`,
      { headers: h }
    );

    if (!searchRes.ok) {
      // Sales Navigator not available — return a search URL for manual lookup
      const searchUrl = `https://www.linkedin.com/sales/search/people?query=(keywords:${encodeURIComponent(name + (domain ? ' ' + domain : ''))})`;
      return new Response(JSON.stringify({
        fallback: true,
        searchUrl,
        message: 'Sales Navigator API not accessible. Use the search link to find the profile manually.'
      }), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
    }

    const searchData = await searchRes.json();
    const person = searchData.elements && searchData.elements[0];

    if (!person) {
      return new Response(JSON.stringify({ profile: null }), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
    }

    // Fetch profile details
    const profileId = person.entityUrn ? person.entityUrn.split(':').pop() : null;
    let profile = {
      name: person.localizedFirstName ? `${person.localizedFirstName} ${person.localizedLastName}` : name,
      headline: person.localizedHeadline || '',
      location: person.localizedLocation || '',
      linkedinUrl: profileId ? `https://www.linkedin.com/in/${profileId}` : null,
      summary: person.summary || null
    };

    // Try to get more details if we have an ID
    if (profileId) {
      try {
        const detailRes = await fetch(`https://api.linkedin.com/v2/people/${profileId}`, { headers: h });
        const detail = await detailRes.json();
        if (detail.summary) profile.summary = detail.summary;
      } catch (e) { /* skip */ }
    }

    return new Response(JSON.stringify({ profile }), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });

  } catch (e) {
    // Fallback: return search URL
    const searchUrl = `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(name + ' ' + (domain || ''))}`;
    return new Response(JSON.stringify({
      fallback: true,
      searchUrl,
      error: e.message
    }), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
  }
}
