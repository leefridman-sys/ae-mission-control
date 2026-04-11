export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
  const { refreshToken, mode, personalColorId } = await request.json();
  if (!refreshToken) return new Response(JSON.stringify({ error: 'No token' }), { status: 400, headers: { 'Content-Type': 'application/json' } });

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ refresh_token: refreshToken, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, grant_type: 'refresh_token' })
  });
  const tokenData = await tokenRes.json();
  if (tokenData.error) return new Response(JSON.stringify({ error: tokenData.error_description }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  const at = tokenData.access_token;
  const h = { Authorization: `Bearer ${at}`, 'Content-Type': 'application/json' };

  try {
    // Get calendar list to map colorIds and filter out subscribed calendars
    const calListRes = await fetch('https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=50', { headers: h });
    const calListData = await calListRes.json();
    const calColorMap = {};
    const ownedCalIds = new Set();
    const subscribedCalIds = new Set();
    (calListData.items || []).forEach(cal => {
      if (cal.colorId) calColorMap[cal.id] = String(cal.colorId);
      // Own calendars: primary, or ones you own/created
      if (cal.accessRole === 'owner' || cal.accessRole === 'writer' || cal.primary) {
        ownedCalIds.add(cal.id);
      } else {
        // Subscribed/read-only calendars (holidays, other people's cals, etc)
        subscribedCalIds.add(cal.id);
      }
    });

    // Build time bounds in PST-aware format
    const now = new Date();
    const tzOffset = -7; // PDT; use -8 for PST
    function toTZ(d) {
      const local = new Date(d.getTime() + tzOffset * 60 * 60 * 1000);
      return local.toISOString().replace('Z', (tzOffset < 0 ? '-' : '+') + String(Math.abs(tzOffset)).padStart(2,'0') + ':00');
    }

    let startDt, endDt;
    const todayLocal = new Date(now.getTime() + tzOffset * 60 * 60 * 1000);
    todayLocal.setUTCHours(0,0,0,0);
    const dayMs = 86400000;

    if (mode === 'today') {
      startDt = new Date(todayLocal.getTime() - tzOffset * 3600000);
      endDt = new Date(startDt.getTime() + dayMs - 1);
    } else if (mode === 'tomorrow') {
      startDt = new Date(todayLocal.getTime() - tzOffset * 3600000 + dayMs);
      endDt = new Date(startDt.getTime() + dayMs - 1);
    } else if (mode === 'prevweek') {
      const dow = todayLocal.getUTCDay();
      const monday = new Date(todayLocal.getTime() - tzOffset * 3600000 - (dow === 0 ? 6 : dow - 1) * dayMs - 7 * dayMs);
      startDt = monday;
      endDt = new Date(monday.getTime() + 7 * dayMs - 1);
    } else if (mode === 'nextweek') {
      const dow = todayLocal.getUTCDay();
      const monday = new Date(todayLocal.getTime() - tzOffset * 3600000 - (dow === 0 ? 6 : dow - 1) * dayMs + 7 * dayMs);
      startDt = monday;
      endDt = new Date(monday.getTime() + 7 * dayMs - 1);
    } else {
      // This week
      const dow = todayLocal.getUTCDay();
      const monday = new Date(todayLocal.getTime() - tzOffset * 3600000 - (dow === 0 ? 6 : dow - 1) * dayMs);
      startDt = monday;
      endDt = new Date(monday.getTime() + 7 * dayMs - 1);
    }

    const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${startDt.toISOString()}&timeMax=${endDt.toISOString()}&singleEvents=true&orderBy=startTime&maxResults=100&fields=items(id,summary,start,end,location,conferenceData,description,attachments,colorId,organizer,attendees,htmlLink)`;
    const res = await fetch(url, { headers: h });
    const data = await res.json();
    if (data.error) return new Response(JSON.stringify({ error: data.error.message }), { status: 400, headers: { 'Content-Type': 'application/json' } });

    const MONTH_MAP = {jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11};
    const events = (data.items || [])
      .filter(ev => {
        // Filter declined events
        if (ev.attendees) {
          const self = ev.attendees.find(a => a.self);
          if (self && self.responseStatus === 'declined') return false;
        }
        return true;
      })
      .map(ev => {
        const isAllDay = !ev.start.dateTime;
        const startD = new Date(ev.start.dateTime || ev.start.date + 'T00:00:00');
        const endD = new Date(ev.end.dateTime || ev.end.date + 'T00:00:00');
        const localStart = new Date(startD.getTime() + tzOffset * 3600000);

        let time = 'All day';
        if (!isAllDay) {
          let h12 = localStart.getUTCHours();
          const ampm = h12 >= 12 ? 'PM' : 'AM';
          h12 = h12 % 12 || 12;
          const mm = String(localStart.getUTCMinutes()).padStart(2, '0');
          time = `${h12}:${mm} ${ampm}`;
        }

        const diffMs = endD - startD;
        const diffMins = Math.round(diffMs / 60000);
        const duration = diffMins < 60 ? diffMins + ' min' : (diffMins % 60 === 0 ? diffMins/60 + ' hr' : Math.floor(diffMins/60) + 'h ' + (diffMins%60) + 'm');

        const dateStr = localStart.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });

        let meetingLink = null;
        if (ev.conferenceData?.entryPoints) {
          const vp = ev.conferenceData.entryPoints.find(ep => ep.entryPointType === 'video');
          if (vp) meetingLink = vp.uri;
        }
        if (!meetingLink && ev.description) {
          const m = ev.description.match(/https?:\/\/(zoom\.us|meet\.google\.com|teams\.microsoft\.com|webex\.com)[^\s"<>]*/);
          if (m) meetingLink = m[0];
        }
        if (!meetingLink && ev.location) {
          const m = ev.location.match(/https?:\/\/(zoom\.us|meet\.google\.com|teams\.microsoft\.com|webex\.com)[^\s"<>]*/);
          if (m) meetingLink = m[0];
        }

        const evColorId = ev.colorId ? String(ev.colorId) : (calColorMap[ev.organizer?.email] || null);
        const isPersonal = evColorId === personalColorId;
        const hasMeeting = !!meetingLink || !!ev.conferenceData;
        const lowerTitle = (ev.summary || '').toLowerCase();
        const type = isPersonal ? 'personal' : isAllDay ? 'allday' : lowerTitle.includes('focus') || lowerTitle.includes('block') ? 'focus' : hasMeeting ? 'meeting' : 'event';
        const desc = ev.description ? ev.description.replace(/<[^>]*>/g, '').replace(/https?:\/\/\S+/g, '').trim().slice(0, 100) : null;
        const attachments = (ev.attachments || []).map(a => ({ title: a.title || 'Attachment', url: a.fileUrl || null })).filter(a => a.url);

        return {
          gid: ev.id,
          title: ev.summary || '(No title)',
          time, duration, dateStr, type, isPersonal, isAllDay, hasMeeting,
          meetingLink, calendarLink: ev.htmlLink || null,
          description: desc || null,
          location: ev.location && !ev.location.match(/^https?:\/\//) ? ev.location : null,
          attachments, colorId: evColorId
        };
      });

    return new Response(JSON.stringify(events), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
  } catch(e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}
