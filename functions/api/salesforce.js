export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type' } });
  if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  const { clientId, clientSecret, username, password, instanceUrl, action, accessToken: preToken, sfAccountId, accountName, contactName, contactTitle, contactEmail } = await request.json();
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
    // Get current user ID so we can filter to owned records
    const userInfoRes = await fetch(`${inst}/services/oauth2/userinfo`, { headers: h });
    const userInfoText = await userInfoRes.text();
    if (!userInfoText.startsWith('{') && !userInfoText.startsWith('[')) {
      return new Response(JSON.stringify({ error: 'Salesforce session expired — paste a fresh access token in Settings.' }), { status: 401, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
    }
    const userInfo = JSON.parse(userInfoText);
    const userId = userInfo.user_id;

    if (action === 'opportunities') {
      // Fetch open opportunities owned by the current user
      // Try fetching opps owned by the token user first; if 0 results, fall back without owner filter
      // (token user_id may not match OwnerId if connected via service account or different auth method)
      const soqlOwned = encodeURIComponent(
        `SELECT Id, Name, AccountId, Account.Name, StageName, Amount, CloseDate, Description, NextStep, LastActivityDate, CreatedDate
         FROM Opportunity
         WHERE IsClosed = false AND OwnerId = '${userId}'
         ORDER BY CloseDate ASC NULLS LAST
         LIMIT 100`
      );
      const soqlAll = encodeURIComponent(
        `SELECT Id, Name, AccountId, Account.Name, StageName, Amount, CloseDate, Description, NextStep, LastActivityDate, CreatedDate
         FROM Opportunity
         WHERE IsClosed = false
         ORDER BY CloseDate ASC NULLS LAST
         LIMIT 100`
      );
      let res = await fetch(`${apiBase}/query/?q=${soqlOwned}`, { headers: h });
      let data = await res.json();
      let errObj = Array.isArray(data) ? data[0] : data;
      if (errObj && errObj.errorCode) return new Response(JSON.stringify({ error: errObj.message || errObj.errorCode }), { status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
      // If owner-filtered query returns nothing, the token user_id doesn't match OwnerId — fetch without filter
      if ((data.records || []).length === 0) {
        res = await fetch(`${apiBase}/query/?q=${soqlAll}`, { headers: h });
        data = await res.json();
        errObj = Array.isArray(data) ? data[0] : data;
        if (errObj && errObj.errorCode) return new Response(JSON.stringify({ error: errObj.message || errObj.errorCode }), { status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
      }

      // Compute opp age the same way Salesforce does: date-only diff, no time/timezone math
      const todayStr = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD" in UTC
      const todayDate = new Date(todayStr);

      const deals = (data.records || []).map(opp => {
        // CreatedDate from SF is like "2026-02-27T17:33:00.000+0000"
        // Slice to date-only to match Salesforce's Opportunity Age formula: TODAY() - DATEVALUE(CreatedDate)
        const createdDateStr = opp.CreatedDate ? opp.CreatedDate.slice(0, 10) : null;
        const createdDate = createdDateStr ? new Date(createdDateStr) : null;
        const oppAge = createdDate ? Math.round((todayDate - createdDate) / 86400000) : null;

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
          createdDate: createdDateStr,
          oppAge: oppAge
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
      const accountId = sfAccountId || '';
      const soql = encodeURIComponent(
        `SELECT Id, Name, Title, Email, Phone, LastModifiedDate FROM Contact WHERE AccountId = '${accountId}' LIMIT 20`
      );
      const res = await fetch(`${apiBase}/query/?q=${soql}`, { headers: h });
      const data = await res.json();
      const contacts = (data.records || []).map(c => ({ id: c.Id, name: c.Name, title: c.Title, email: c.Email }));
      return new Response(JSON.stringify({ contacts }), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
    }

    if (action === 'opp_history') {
      const whereClause = sfAccountId
        ? `AccountId = '${sfAccountId}'`
        : `Account.Name LIKE '${(accountName||'').replace(/'/g,"\\'")}%'`;

      // Fetch closed opps
      const oppSoql = encodeURIComponent(
        `SELECT Id, Name, StageName, CloseDate, Amount, Description, NextStep
         FROM Opportunity
         WHERE ${whereClause} AND IsClosed = true
         ORDER BY CloseDate DESC LIMIT 20`
      );
      const oppRes = await fetch(`${apiBase}/query/?q=${oppSoql}`, { headers: h });
      const oppData = await oppRes.json();
      const oppErr = Array.isArray(oppData) ? oppData[0] : oppData;
      if (oppErr && oppErr.errorCode) return new Response(JSON.stringify({ error: oppErr.message || oppErr.errorCode }), { status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
      const opps = (oppData.records || []).map(o => ({
        id: o.Id, name: o.Name, stage: o.StageName,
        closeDate: o.CloseDate, amount: o.Amount || 0, description: o.Description || '', nextStep: o.NextStep || ''
      }));

      // Fetch contacts on the account
      const contSoql = encodeURIComponent(
        sfAccountId
          ? `SELECT Id, Name, Title, Email FROM Contact WHERE AccountId = '${sfAccountId}' ORDER BY LastModifiedDate DESC LIMIT 30`
          : `SELECT Id, Name, Title, Email FROM Contact WHERE Account.Name LIKE '${(accountName||'').replace(/'/g,"\\'")}%' ORDER BY LastModifiedDate DESC LIMIT 30`
      );
      const contRes = await fetch(`${apiBase}/query/?q=${contSoql}`, { headers: h });
      const contData = await contRes.json();
      const contacts = (contData.records || []).map(c => ({ id: c.Id, name: c.Name, title: c.Title || '', email: c.Email || '' }));

      return new Response(JSON.stringify({ opps, contacts }), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
    }

    if (action === 'events_upcoming') {
      // Fetch Events for today + tomorrow linked to a Contact (WhoId != null = prospect-facing, not internal)
      const soql = encodeURIComponent(
        `SELECT Id, Subject, StartDateTime, EndDateTime, WhoId, Who.Name, WhatId, What.Name, What.Type, Description, Location
         FROM Event
         WHERE OwnerId = '${userId}'
         AND StartDateTime >= TODAY
         AND StartDateTime <= NEXT_N_DAYS:2
         AND WhoId != null
         ORDER BY StartDateTime ASC
         LIMIT 20`
      );
      const res = await fetch(`${apiBase}/query/?q=${soql}`, { headers: h });
      const data = await res.json();
      const errObj = Array.isArray(data) ? data[0] : data;
      if (errObj && errObj.errorCode) return new Response(JSON.stringify({ error: errObj.message || errObj.errorCode }), { status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });

      const todayStr = new Date().toISOString().slice(0, 10);
      const tomorrowStr = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

      const events = (data.records || []).map(ev => {
        const start = ev.StartDateTime ? new Date(ev.StartDateTime) : null;
        const end   = ev.EndDateTime   ? new Date(ev.EndDateTime)   : null;
        const dateStr = start ? start.toISOString().slice(0, 10) : '';
        const timeStr = start ? start.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/Toronto' }) : '';
        const durMins = (start && end) ? Math.round((end - start) / 60000) : null;
        const durStr  = durMins ? (durMins >= 60 ? Math.floor(durMins / 60) + 'h' + (durMins % 60 ? ' ' + (durMins % 60) + 'm' : '') : durMins + 'm') : '';
        const isToday = dateStr === todayStr;
        const isTomorrow = dateStr === tomorrowStr;
        return {
          id: ev.Id,
          subject: ev.Subject || '',
          date: dateStr,
          time: timeStr,
          startTs: start ? start.getTime() : 0,
          duration: durStr,
          isToday,
          isTomorrow,
          whoName: ev.Who ? ev.Who.Name : '',
          whatName: ev.What ? ev.What.Name : '',
          whatType: ev.What ? ev.What.Type : '',
          description: ev.Description || ''
        };
      });

      return new Response(JSON.stringify({ events }), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
    }

    if (action === 'tasks_week') {
      const soql = encodeURIComponent(
        `SELECT Id, Subject, Type, Status, ActivityDate, WhatId, What.Name, WhoId, Who.Name
         FROM Task
         WHERE OwnerId = '${userId}'
         AND ActivityDate = THIS_WEEK
         ORDER BY ActivityDate DESC
         LIMIT 200`
      );
      const res = await fetch(`${apiBase}/query/?q=${soql}`, { headers: h });
      const data = await res.json();
      const errObj2 = Array.isArray(data) ? data[0] : data;
      if (errObj2 && errObj2.errorCode) return new Response(JSON.stringify({ error: errObj2.message || errObj2.errorCode }), { status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
      const tasks = (data.records || []).map(t => ({
        id: t.Id, subject: t.Subject || '', type: t.Type || '', status: t.Status || '',
        date: t.ActivityDate, accountName: t.What ? t.What.Name : '', contactName: t.Who ? t.Who.Name : ''
      }));
      return new Response(JSON.stringify({ tasks }), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
    }

    if (action === 'tasks_account') {
      if (!sfAccountId) return new Response(JSON.stringify({ tasks: [] }), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
      const soql = encodeURIComponent(
        `SELECT Id, Subject, Type, Status, ActivityDate, WhoId, Who.Name, Description
         FROM Task
         WHERE WhatId = '${sfAccountId}'
         ORDER BY ActivityDate DESC
         LIMIT 50`
      );
      const res = await fetch(`${apiBase}/query/?q=${soql}`, { headers: h });
      const data = await res.json();
      const errObj3 = Array.isArray(data) ? data[0] : data;
      if (errObj3 && errObj3.errorCode) return new Response(JSON.stringify({ error: errObj3.message || errObj3.errorCode }), { status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
      const tasks = (data.records || []).map(t => ({
        id: t.Id, subject: t.Subject || '', type: t.Type || '', status: t.Status || '',
        date: t.ActivityDate, contactName: t.Who ? t.Who.Name : '', description: t.Description || ''
      }));
      return new Response(JSON.stringify({ tasks }), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
    }

    if (action === 'upsert_contact') {
      if (!contactEmail && !contactName) return new Response(JSON.stringify({ error: 'contactName or contactEmail required' }), { status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });

      // 1. Check if contact already exists by email
      if (contactEmail) {
        const checkSoql = encodeURIComponent(`SELECT Id, Name FROM Contact WHERE Email = '${contactEmail.replace(/'/g,"\\'")}' LIMIT 1`);
        const checkRes = await fetch(`${apiBase}/query/?q=${checkSoql}`, { headers: h });
        const checkData = await checkRes.json();
        const checkErr = Array.isArray(checkData) ? checkData[0] : checkData;
        if (checkErr && checkErr.errorCode) return new Response(JSON.stringify({ error: checkErr.message || checkErr.errorCode }), { status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
        if (checkData.records && checkData.records.length > 0) {
          const existing = checkData.records[0];
          return new Response(JSON.stringify({ exists: true, contactId: existing.Id, contactName: existing.Name }), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
        }
      }

      // 2. Resolve Account ID if not provided
      let resolvedAccountId = sfAccountId || '';
      if (!resolvedAccountId && accountName) {
        const acctSoql = encodeURIComponent(`SELECT Id FROM Account WHERE Name LIKE '${(accountName).replace(/'/g,"\\'")}%' LIMIT 1`);
        const acctRes = await fetch(`${apiBase}/query/?q=${acctSoql}`, { headers: h });
        const acctData = await acctRes.json();
        if (acctData.records && acctData.records.length > 0) resolvedAccountId = acctData.records[0].Id;
      }

      // 3. Split name into first/last
      const nameParts = (contactName || '').trim().split(' ');
      const firstName = nameParts.length > 1 ? nameParts.slice(0, -1).join(' ') : '';
      const lastName = nameParts[nameParts.length - 1] || contactName || 'Unknown';

      // 4. Create the contact
      const contactBody = { LastName: lastName, Email: contactEmail || '' };
      if (firstName) contactBody.FirstName = firstName;
      if (contactTitle) contactBody.Title = contactTitle;
      if (resolvedAccountId) contactBody.AccountId = resolvedAccountId;

      const createRes = await fetch(`${apiBase}/sobjects/Contact/`, {
        method: 'POST',
        headers: h,
        body: JSON.stringify(contactBody)
      });
      const createData = await createRes.json();
      const createErr = Array.isArray(createData) ? createData[0] : createData;
      if (createErr && createErr.errorCode) return new Response(JSON.stringify({ error: createErr.message || createErr.errorCode }), { status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
      return new Response(JSON.stringify({ created: true, contactId: createData.id, accountId: resolvedAccountId || null }), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
    }

    return new Response(JSON.stringify({ error: 'Unknown action: ' + action }), { status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });

  } catch (e) {
    const msg = e.message && e.message.includes('Bad_OAuth_Token') ? 'Salesforce session expired — paste a fresh access token in Settings.' : e.message;
    return new Response(JSON.stringify({ error: msg }), { status: 500, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
  }
}
