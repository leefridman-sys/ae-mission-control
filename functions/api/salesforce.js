export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type' } });
  if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  const { clientId, clientSecret, username, password, instanceUrl, action, accessToken: preToken } = await request.json();
  if (!instanceUrl) return new Response(JSON.stringify({ error: 'Missing instance URL' }), { status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });

  let at;

  if (preToken) {
    // Use pre-provided access token (e.g. extracted from Workbench session)
    at = preToken;
  } else {
    // Get access token via username-password flow
    if (!username || !password) return new Response(JSON.stringify({ error: 'Missing credentials (username/password or accessToken required)' }), { status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });

    const cid = clientId || env.SALESFORCE_CLIENT_ID;
    const csecret = clientSecret || env.SALESFORCE_CLIENT_SECRET;

    const loginUrl = instanceUrl.includes('sandbox') ? 'https://test.salesforce.com' : 'https://login.salesforce.com';
    const tokenRes = await fetch(`${loginUrl}/services/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: cid,
        client_secret: csecret,
        username: username,
        password: password
      })
    });
    const tokenData = await tokenRes.json();
    if (tokenData.error) return new Response(JSON.stringify({ error: tokenData.error_description || tokenData.error, error_code: tokenData.error, login_url: loginUrl }), { status: 401, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
    at = tokenData.access_token;
  }
  const inst = instanceUrl.replace(/\/$/, '');
  const h = { Authorization: `Bearer ${at}`, 'Content-Type': 'application/json' };
  const apiBase = `${inst}/services/data/v58.0`;

  try {
    if (action === 'opportunities') {
      // Fetch open opportunities
      const soql = encodeURIComponent(
        `SELECT Id, Name, AccountId, Account.Name, StageName, Amount, CloseDate, Description, NextStep, LastActivityDate, CreatedDate,
         (SELECT Id, Subject, ActivityDate, Description FROM ActivityHistories ORDER BY ActivityDate DESC LIMIT 3)
         FROM Opportunity
         WHERE IsClosed = false
         ORDER BY CloseDate ASC NULLS LAST
         LIMIT 100`
      );
      const res = await fetch(`${apiBase}/query/?q=${soql}`, { headers: h });
      const data = await res.json();
      // Salesforce returns errors as either an object {errorCode,message} or an array [{errorCode,message}]
      const errObj = Array.isArray(data) ? data[0] : data;
      if (errObj && errObj.errorCode) return new Response(JSON.stringify({ error: errObj.message || errObj.errorCode }), { status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });

      const deals = (data.records || []).map(opp => {
        // Calculate days in stage using LastModifiedDate heuristic
        const created = new Date(opp.CreatedDate);
        const now = new Date();
        const daysInStage = Math.round((now - created) / 86400000);

        // Get last activity
        const activities = opp.ActivityHistories ? opp.ActivityHistories.records || [] : [];
        const lastActivity = activities[0];

        return {
          id: opp.Id,
          name: opp.Name,
          account: opp.Account ? opp.Account.Name : '',
          accountId: opp.AccountId,
          stage: opp.StageName,
          amount: opp.Amount || 0,
          closeDate: opp.CloseDate,
          nextStep: opp.NextStep || '',
          lastActivityDate: opp.LastActivityDate,
          daysInStage: daysInStage,
          lastActivity: lastActivity ? { subject: lastActivity.Subject, date: lastActivity.ActivityDate } : null
        };
      });

      return new Response(JSON.stringify({ deals }), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
    }

    if (action === 'accounts') {
      const soql = encodeURIComponent(
        `SELECT Id, Name, Website, Industry, NumberOfEmployees, BillingCity, BillingState
         FROM Account
         WHERE Type IN ('Prospect', 'Customer')
         ORDER BY LastModifiedDate DESC
         LIMIT 50`
      );
      const res = await fetch(`${apiBase}/query/?q=${soql}`, { headers: h });
      const data = await res.json();
      if (data.errorCode) return new Response(JSON.stringify({ error: data.message }), { status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });

      const accounts = (data.records || []).map(a => ({
        id: a.Id,
        name: a.Name,
        website: a.Website || '',
        industry: a.Industry || '',
        employees: a.NumberOfEmployees || null
      }));

      return new Response(JSON.stringify({ accounts }), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
    }

    if (action === 'contacts') {
      const { accountId } = await request.clone().json().catch(() => ({}));
      const soql = encodeURIComponent(
        `SELECT Id, Name, Title, Email, Phone, LastModifiedDate FROM Contact WHERE AccountId = '${accountId}' LIMIT 20`
      );
      const res = await fetch(`${apiBase}/query/?q=${soql}`, { headers: h });
      const data = await res.json();
      const contacts = (data.records || []).map(c => ({ id: c.Id, name: c.Name, title: c.Title, email: c.Email }));
      return new Response(JSON.stringify({ contacts }), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
    }

    return new Response(JSON.stringify({ error: 'Unknown action: ' + action }), { status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });

  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
  }
}
