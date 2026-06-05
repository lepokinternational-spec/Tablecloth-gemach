const ORIGIN = "https://tcgemach.co.uk";
const MAIN_ADMIN_EMAIL = "linencollection29@gmail.com";
const MIRI_ADMIN_EMAIL = "linencollection11@gmail.com";

const DEFAULT_ADMINS = [
  { name: "Shifra Koppel", email: "linencollection29@gmail.com", role: "super", envPassword: "ADMIN_TOKEN" },
  { name: "Miri Grossnass", email: MIRI_ADMIN_EMAIL, role: "admin", envPassword: "MIRI_ADMIN_TOKEN" },
];

const DEFAULT_OWNERS = {
  whitechaircovers: MIRI_ADMIN_EMAIL,
  goldchargers: MAIN_ADMIN_EMAIL,
};

const EMAIL_ALIASES = {
  "mirikoppel10@gmail.com": MIRI_ADMIN_EMAIL,
  "linencollection11@gmail.com": MIRI_ADMIN_EMAIL,
};

export default {
  async fetch(request, env) {
    const cors = {
      "Access-Control-Allow-Origin": ORIGIN,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Admin-Token, X-Admin-Email",
    };

    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    const url = new URL(request.url);
    const action = url.searchParams.get("action") || "";

    try {
      if (request.method === "GET" && action === "availability") {
        const bookings = await getBookings(env);
        return json({
          bookings: bookings
            .filter(b => b.status !== "cancelled" && b.status !== "declined")
            .map(publicBooking),
        }, 200, cors);
      }

      if (request.method === "GET" && action === "list") {
        const admin = await requireAdmin(request, env);
        if (!admin) return json({ error: "unauthorized" }, 401, cors);

        const bookings = await getBookings(env);
        const owners = await getOwners(env);
        return json({
          me: publicAdmin(admin),
          bookings: bookings.filter(b => bookingBelongsToAdmin(b, admin.email, owners)),
        }, 200, cors);
      }

      if (request.method === "GET" && action === "adminConfig") {
        const admin = await requireAdmin(request, env);
        if (!admin) return json({ error: "unauthorized" }, 401, cors);
        return json({
          me: publicAdmin(admin),
          admins: (await getAdmins(env)).map(publicAdmin),
          owners: await getOwners(env),
        }, 200, cors);
      }

      if (request.method !== "POST") return json({ error: "method" }, 405, cors);
      const body = await request.json().catch(() => ({}));

      if (action === "create") {
        if (body.website) return json({ ok: true }, 200, cors);

        const b = normalizeBooking(body.booking);
        if (!b || !b.id || !b.email) return json({ error: "bad booking" }, 400, cors);

        await upsertBooking(env, b);

        const owners = await getOwners(env);
        await sendNewRequestEmails(env, b, body.approveUrl);
        await sendEmail(env, b.email, "We received your tablecloth request", ackHtml(b, contactEmailsForBooking(b, owners)));

        return json({ ok: true }, 200, cors);
      }

      if (action === "update") {
        const admin = await requireAdmin(request, env);
        if (!admin) return json({ error: "unauthorized" }, 401, cors);

        const b = normalizeBooking(body.booking);
        if (!b || !b.id) return json({ error: "bad booking" }, 400, cors);

        const owners = await getOwners(env);
        if (!body.adminCreate && !bookingBelongsToAdmin(b, admin.email, owners)) {
          return json({ error: "not your tablecloths" }, 403, cors);
        }

        await upsertBooking(env, b);

        if (body.sendApproval && b.email) {
          await sendEmail(env, b.email, "Your tablecloth booking is approved", approvalHtml(b, [admin.email], collectionAddressesForBooking(b, owners, admin.email)));
        }

        return json({ ok: true }, 200, cors);
      }

      if (action === "cancel") {
        const bookings = await getBookings(env);
        const b = bookings.find(x => x.id === body.id);
        if (!b) return json({ error: "not found" }, 404, cors);

        const admin = await requireAdmin(request, env);
        if (!admin && b.token !== body.token) return json({ error: "unauthorized" }, 401, cors);

        if (admin) {
          const owners = await getOwners(env);
          if (!bookingBelongsToAdmin(b, admin.email, owners)) {
            return json({ error: "not your tablecloths" }, 403, cors);
          }
        }

        b.status = "cancelled";
        await upsertBooking(env, b);
        return json({ ok: true }, 200, cors);
      }

      if (action === "wipeall") {
        const admin = await requireAdmin(request, env);
        if (!admin || admin.role !== "super") return json({ error: "unauthorized" }, 401, cors);
        await saveBookings(env, []);
        return json({ ok: true }, 200, cors);
      }

      if (action === "resetPassword") {
        const admin = await requireAdmin(request, env);
        if (!admin) return json({ error: "unauthorized" }, 401, cors);

        const password = String(body.password || "").trim();
        if (password.length < 8) return json({ error: "password too short" }, 400, cors);

        const targetEmail = admin.role === "super" && body.email ? normalizeEmail(body.email) : admin.email;
        await env.SETTINGS.put(passwordKey(targetEmail), password);
        return json({ ok: true }, 200, cors);
      }

      if (action === "saveOwners") {
        const admin = await requireAdmin(request, env);
        if (!admin || admin.role !== "super") return json({ error: "unauthorized" }, 401, cors);

        const owners = body.owners && typeof body.owners === "object" ? body.owners : {};
        const clean = {};
        for (const [clothId, email] of Object.entries(owners)) {
          if (clothId && email) clean[clothId] = normalizeEmail(email);
        }
        await env.SETTINGS.put("TABLECLOTH_OWNERS", JSON.stringify(clean));
        return json({ ok: true }, 200, cors);
      }

      if (action === "saveAdmins") {
        const admin = await requireAdmin(request, env);
        if (!admin || admin.role !== "super") return json({ error: "unauthorized" }, 401, cors);

        const incoming = Array.isArray(body.admins) ? body.admins : [];
        const admins = mergeAdmins(incoming.map(a => ({
          name: String(a.name || "").trim(),
          email: normalizeEmail(a.email),
          role: a.role === "super" ? "super" : "admin",
        })).filter(a => a.email));
        await env.SETTINGS.put("ADMINS", JSON.stringify(admins));
        return json({ ok: true }, 200, cors);
      }

      if (action === "runReminders") {
        const admin = await requireAdmin(request, env);
        if (!admin || admin.role !== "super") return json({ error: "unauthorized" }, 401, cors);
        const date = body.date || todayISO(env);
        const result = await sendDailyReminders(env, date);
        return json({ ok: true, ...result }, 200, cors);
      }

      if (!action && body.email && body.id) {
        await sendEmail(env, body.email, "Your tablecloth booking is approved", approvalHtml(body, [MAIN_ADMIN_EMAIL], collectionAddressesForBooking(body, {}, MAIN_ADMIN_EMAIL)));
        return json({ ok: true }, 200, cors);
      }

      return json({ error: "unknown action" }, 400, cors);
    } catch (e) {
      return json({ error: String(e && e.message ? e.message : e) }, 500, cors);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(sendDailyReminders(env, todayISO(env)));
  },
};

async function sendDailyReminders(env, dateISO) {
  const bookings = (await getBookings(env)).filter(b =>
    b.status === "approved" && b.status !== "cancelled" && b.status !== "declined"
  );
  const owners = await getOwners(env);
  const adminDigest = new Map();
  let customerEmails = 0;

  for (const b of bookings) {
    const events = [];
    if (b.pickup === dateISO) events.push("pickup");
    if (b.ret === dateISO) events.push("return");
    if (!events.length) continue;

    const customerKey = "REMINDER_SENT:" + dateISO + ":customer:" + b.id + ":" + events.join("-");
    if (!(await env.SETTINGS.get(customerKey))) {
      await sendEmail(env, b.email, customerReminderSubject(events), customerReminderHtml(b, events, dateISO, contactEmailsForBooking(b, owners), collectionAddressesForBooking(b, owners)));
      await env.SETTINGS.put(customerKey, "1", { expirationTtl: 60 * 60 * 24 * 45 });
      customerEmails++;
    }

    for (const eventName of events) {
      const grouped = groupItemsByOwner(b.items || [], owners);
      for (const [adminEmail, items] of grouped.entries()) {
        if (!adminDigest.has(adminEmail)) adminDigest.set(adminEmail, []);
        adminDigest.get(adminEmail).push({ eventName, booking: b, items });
      }
    }
  }

  let adminEmails = 0;
  for (const [adminEmail, entries] of adminDigest.entries()) {
    const key = "REMINDER_SENT:" + dateISO + ":admin:" + adminEmail;
    if (await env.SETTINGS.get(key)) continue;
    await sendEmail(env, adminEmail, "Today's Linen Collection pickups and returns", adminDigestHtml(entries, dateISO));
    await env.SETTINGS.put(key, "1", { expirationTtl: 60 * 60 * 24 * 45 });
    adminEmails++;
  }

  return { date: dateISO, customerEmails, adminEmails };
}

async function sendNewRequestEmails(env, b, approveUrl) {
  const owners = await getOwners(env);
  const grouped = groupItemsByOwner(b.items || [], owners);

  for (const [adminEmail, items] of grouped.entries()) {
    const copy = { ...b, items };
    await sendEmail(env, adminEmail, "New tablecloth request - " + b.id, adminRequestHtml(copy, approveUrl));
  }
}

function groupItemsByOwner(items, owners) {
  const grouped = new Map();
  for (const item of items || []) {
    const ownerEmail = normalizeEmail(owners[item.id] || MAIN_ADMIN_EMAIL);
    if (!grouped.has(ownerEmail)) grouped.set(ownerEmail, []);
    grouped.get(ownerEmail).push(item);
  }
  return grouped;
}

function contactEmailsForBooking(b, owners) {
  return [...groupItemsByOwner(b.items || [], owners).keys()];
}

function collectionAddressForEmail(email) {
  return normalizeEmail(email) === normalizeEmail(MIRI_ADMIN_EMAIL) ? "11 francklyn gardens" : "29 Broadfields avenue";
}

function collectionAddressesForBooking(b, owners, fallbackEmail) {
  const grouped = new Map();
  for (const item of b.items || []) {
    const ownerEmail = normalizeEmail((item.id && owners && owners[item.id]) || fallbackEmail || MAIN_ADMIN_EMAIL);
    if (!grouped.has(ownerEmail)) grouped.set(ownerEmail, []);
    grouped.get(ownerEmail).push(item);
  }
  const addresses = [];
  const seen = new Set();

  for (const [email, items] of grouped.entries()) {
    const cleanEmail = normalizeEmail(email);
    const address = collectionAddressForEmail(cleanEmail);
    const key = cleanEmail + "|" + address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    addresses.push({ email: cleanEmail, address, items });
  }

  if (!addresses.length) {
    addresses.push({ email: MAIN_ADMIN_EMAIL, address: collectionAddressForEmail(MAIN_ADMIN_EMAIL), items: [] });
  }

  return addresses;
}

function bookingBelongsToAdmin(b, adminEmail, owners) {
  const email = normalizeEmail(adminEmail);
  return (b.items || []).some(item => normalizeEmail(owners[item.id] || MAIN_ADMIN_EMAIL) === email);
}

async function getBookings(env) {
  const raw = await env.SETTINGS.get("BOOKINGS");
  if (!raw) return [];
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

async function saveBookings(env, bookings) {
  await env.SETTINGS.put("BOOKINGS", JSON.stringify(bookings));
}

async function upsertBooking(env, booking) {
  const bookings = await getBookings(env);
  const idx = bookings.findIndex(x => x.id === booking.id);
  if (idx >= 0) bookings[idx] = booking;
  else bookings.push(booking);
  await saveBookings(env, bookings);
}

async function getOwners(env) {
  const raw = await env.SETTINGS.get("TABLECLOTH_OWNERS");
  if (!raw) return { ...DEFAULT_OWNERS };
  try {
    const owners = JSON.parse(raw);
    return owners && typeof owners === "object" ? normalizeOwnerMap({ ...DEFAULT_OWNERS, ...owners }) : { ...DEFAULT_OWNERS };
  } catch {
    return { ...DEFAULT_OWNERS };
  }
}

function normalizeOwnerMap(owners) {
  const clean = {};
  for (const [clothId, email] of Object.entries(owners || {})) {
    if (clothId && email) clean[clothId] = normalizeEmail(email);
  }
  return clean;
}

async function getAdmins(env) {
  const raw = await env.SETTINGS.get("ADMINS");
  let stored = [];
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      stored = Array.isArray(parsed) ? parsed : [];
    } catch {
      stored = [];
    }
  }
  return mergeAdmins(stored);
}

function mergeAdmins(stored) {
  const byEmail = new Map();
  for (const admin of DEFAULT_ADMINS.concat(stored || [])) {
    const email = normalizeEmail(admin.email);
    if (!email) continue;
    const existing = byEmail.get(email) || {};
    byEmail.set(email, {
      ...existing,
      ...admin,
      email,
      name: admin.name || existing.name || email,
      role: admin.role || existing.role || "admin",
    });
  }
  return [...byEmail.values()];
}

async function requireAdmin(request, env) {
  const token = request.headers.get("X-Admin-Token") || "";
  const requestedEmail = normalizeEmail(request.headers.get("X-Admin-Email") || MAIN_ADMIN_EMAIL);
  const admins = await getAdmins(env);
  const admin = admins.find(a => normalizeEmail(a.email) === requestedEmail) || admins.find(a => normalizeEmail(a.email) === MAIN_ADMIN_EMAIL);
  if (!admin) return null;

  const password = await getAdminPassword(env, admin);
  if (!password || token !== password) return null;
  return { ...admin, email: normalizeEmail(admin.email) };
}

async function getAdminPassword(env, admin) {
  const saved = await env.SETTINGS.get(passwordKey(admin.email));
  if (saved) return saved;
  if (admin.envPassword && env[admin.envPassword]) return env[admin.envPassword];
  if (normalizeEmail(admin.email) === normalizeEmail(MAIN_ADMIN_EMAIL)) return env.ADMIN_TOKEN;
  return "";
}

function passwordKey(email) {
  return "ADMIN_PASSWORD:" + normalizeEmail(email);
}

async function sendEmail(env, to, subject, html) {
  if (!to || !env.RESEND_API_KEY || !env.FROM_EMAIL) return;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + env.RESEND_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: env.FROM_EMAIL,
      to: [to],
      subject,
      html,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error("Resend failed: " + text);
  }
}

function normalizeBooking(b) {
  if (!b || typeof b !== "object") return null;
  return {
    ...b,
    id: String(b.id || "").trim(),
    name: String(b.name || "").trim(),
    email: String(b.email || "").trim(),
    phone: String(b.phone || "").trim(),
    address: String(b.address || "").trim(),
    note: String(b.note || ""),
    customerNote: String(b.customerNote || ""),
    careInstructions: String(b.careInstructions || ""),
    careInstructionsList: Array.isArray(b.careInstructionsList) ? b.careInstructionsList : [],
    items: Array.isArray(b.items) ? b.items.map(it => ({
      id: String(it.id || "").trim(),
      name: String(it.name || "").trim(),
      qty: Number(it.qty || 0),
    })).filter(it => it.id || it.name) : [],
    start: String(b.start || b.pickup || "").trim(),
    pickup: String(b.pickup || b.start || "").trim(),
    ret: String(b.ret || b.start || b.pickup || "").trim(),
    status: String(b.status || "pending").trim(),
    token: String(b.token || "").trim(),
    created: String(b.created || new Date().toISOString()),
  };
}

function publicBooking(b) {
  return {
    id: b.id,
    name: b.name,
    items: b.items,
    start: b.start,
    pickup: b.pickup,
    ret: b.ret,
    status: b.status,
  };
}

function publicAdmin(a) {
  return { name: a.name, email: normalizeEmail(a.email), role: a.role || "admin" };
}

function todayISO(env) {
  const tz = env.TIMEZONE || "Europe/London";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = type => parts.find(p => p.type === type).value;
  return get("year") + "-" + get("month") + "-" + get("day");
}

function fmtDate(s) {
  if (!s) return "";
  const d = new Date(s + "T12:00:00Z");
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

function customerReminderSubject(events) {
  if (events.includes("pickup") && events.includes("return")) return "Reminder: pickup and return today";
  if (events.includes("return")) return "Reminder: return your tablecloths today";
  return "Reminder: pickup today";
}

function eventLabel(eventName) {
  return eventName === "return" ? "Return due today" : "Pickup today";
}

function itemsHtml(items) {
  return (items || []).map(it =>
    '<tr><td style="padding:10px 0;border-bottom:1px solid #E5D9C4">' +
    esc(it.qty || 1) + " x " + esc(it.name) +
    "</td></tr>"
  ).join("");
}

function careHtml(b) {
  const rows = [];
  if (b.customerNote) rows.push("<p><b>Note:</b><br>" + nl2br(esc(b.customerNote)) + "</p>");
  if (b.careInstructions) rows.push("<p><b>Care instructions:</b><br>" + nl2br(esc(b.careInstructions)) + "</p>");
  if (Array.isArray(b.careInstructionsList) && b.careInstructionsList.length) {
    rows.push("<p><b>Item care:</b><br>" + b.careInstructionsList.map(x =>
      esc(x.name || "Tablecloth") + ": " + esc(x.text || "")
    ).join("<br>") + "</p>");
  }
  return rows.join("");
}

function adminRequestHtml(b, approveUrl) {
  const button = approveUrl
    ? '<p style="margin:24px 0 6px"><a href="' + esc(approveUrl) + '" style="' + buttonStyle() + '">Approve</a></p>'
    : "";

  return emailShell(
    "New tablecloth request",
    "Request " + esc(b.id),
    '<p style="font-size:16px;margin:0 0 18px"><b>' + esc(b.name) + "</b><br>" +
    esc(b.phone) + "<br>" + esc(b.email) + "</p>" +
    infoBox(
      '<b>Address</b><br>' + esc(b.address || "") +
      '<br><br><b>Dates</b><br>' + esc(fmtDate(b.pickup || b.start)) + " to " + esc(fmtDate(b.ret || b.start)) +
      (b.note ? '<br><br><b>Customer note</b><br>' + nl2br(esc(b.note)) : "")
    ) +
    tableBlock(b.items) +
    button
  );
}

function ackHtml(b, contactEmails) {
  return emailShell(
    "We received your request",
    "Request received",
    '<p style="font-size:16px;margin:0 0 18px">Hi ' + esc(b.name) + ', we have your request <b>' + esc(b.id) + "</b> and will confirm by email shortly.</p>" +
    tableBlock(b.items) +
    contactButtonsHtml(contactEmails, "Question about request " + b.id)
  );
}

function approvalHtml(b, contactEmails, collectionAddresses) {
  return emailShell(
    "Your booking is approved",
    "Your linens are confirmed",
    '<p style="font-size:16px;margin:0 0 18px">Hi ' + esc(b.name) + ', your reservation <b>' + esc(b.id) + "</b> is approved.</p>" +
    infoBox("<b>Pickup</b><br>" + esc(fmtDate(b.pickup)) + "<br><br><b>Return by</b><br>" + esc(fmtDate(b.ret))) +
    collectionAddressHtml(collectionAddresses) +
    suggestedDonationHtml() +
    tableBlock(b.items) +
    careHtml(b) +
    contactButtonsHtml(contactEmails, "Question about booking " + b.id)
  );
}

function suggestedDonationHtml() {
  return infoBox(
    "<b>Suggested donation</b><br>&pound;5<br><br>" +
    "<b>Bank details</b><br>" +
    "The Linen Collection<br>" +
    "Sort code: 04-00-06<br>" +
    "Account number: 67852631<br><br>" +
    "If the tablecloths are returned late you undertake to pay a late fee."
  );
}

function collectionAddressHtml(addresses) {
  if (!addresses || !addresses.length) return "";
  return infoBox(
    "<b>Collection address</b><br>" +
    addresses.map(a =>
      esc(a.address) +
      (a.items && a.items.length
        ? '<br><span style="font-size:13px;color:#6B665B">' + a.items.map(it => esc(it.name)).join(", ") + "</span>"
        : "")
    ).join("<br><br>")
  );
}

function customerReminderHtml(b, events, dateISO, contactEmails, collectionAddresses) {
  const eventCopy = events.map(eventLabel).join(" and ");
  return emailShell(
    "Reminder",
    eventCopy,
    '<p style="font-size:16px;margin:0 0 18px">Hi ' + esc(b.name) + ", this is your reminder for today, " + esc(fmtDate(dateISO)) + ".</p>" +
    infoBox("<b>Pickup</b><br>" + esc(fmtDate(b.pickup)) + "<br><br><b>Return by</b><br>" + esc(fmtDate(b.ret))) +
    collectionAddressHtml(collectionAddresses) +
    (events.includes("return") ? suggestedDonationHtml() : "") +
    tableBlock(b.items) +
    careHtml(b) +
    contactButtonsHtml(contactEmails, "Question about booking " + b.id)
  );
}

function adminDigestHtml(entries, dateISO) {
  const rows = entries.map(({ eventName, booking, items }) =>
    '<div style="border:1px solid #E5D9C4;border-radius:12px;padding:16px;margin:0 0 14px;background:#FFFCF6">' +
    '<div style="font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:#A27A2E;font-weight:700">' + esc(eventLabel(eventName)) + "</div>" +
    '<h3 style="margin:6px 0 8px;font-size:20px;color:#1F4A45">' + esc(booking.name) + "</h3>" +
    '<p style="margin:0 0 12px;line-height:1.5">' +
    esc(booking.phone) + "<br>" + esc(booking.email) + "<br>" + esc(booking.address || "") +
    "</p>" +
    '<p style="margin:0 0 12px"><b>Pickup:</b> ' + esc(fmtDate(booking.pickup)) + "<br><b>Return:</b> " + esc(fmtDate(booking.ret)) + "</p>" +
    tableBlock(items) +
    (booking.note ? '<p style="margin:12px 0 0"><b>Customer note:</b><br>' + nl2br(esc(booking.note)) + "</p>" : "") +
    "</div>"
  ).join("");

  return emailShell(
    "Today's schedule",
    "Pickups and returns for " + esc(fmtDate(dateISO)),
    rows || "<p>No bookings today.</p>"
  );
}

function tableBlock(items) {
  return '<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin:16px 0">' +
    itemsHtml(items) +
    "</table>";
}

function infoBox(inner) {
  return '<div style="background:#F6F0E3;border:1px solid #E5D9C4;border-radius:12px;padding:16px;margin:16px 0;line-height:1.5">' + inner + "</div>";
}

function emailShell(preheader, title, body) {
  return '<div style="margin:0;padding:0;background:#F7F2E8">' +
    '<div style="display:none;max-height:0;overflow:hidden">' + esc(preheader) + "</div>" +
    '<div style="max-width:620px;margin:0 auto;padding:24px 14px;font-family:Arial,Helvetica,sans-serif;color:#26231F">' +
    '<div style="background:#1F4A45;color:#fff;border-radius:16px 16px 0 0;padding:24px">' +
    '<div style="font-size:13px;letter-spacing:.1em;text-transform:uppercase;opacity:.8">The Linen Collection</div>' +
    '<h1 style="margin:8px 0 0;font-size:28px;line-height:1.15">' + title + "</h1>" +
    "</div>" +
    '<div style="background:#fff;border:1px solid #E5D9C4;border-top:0;border-radius:0 0 16px 16px;padding:24px">' +
    body +
    '<p style="margin:24px 0 0;color:#80786B;font-size:14px">The Linen Collection</p>' +
    "</div></div></div>";
}

function contactButtonsHtml(emails, subject) {
  const clean = [...new Set((emails || []).map(normalizeEmail).filter(Boolean))];
  if (!clean.length) clean.push(MAIN_ADMIN_EMAIL);
  return '<div style="margin:22px 0 4px"><a href="mailto:' + esc(clean.join(",")) + '?subject=' + encodeURIComponent(subject || "Question about my booking") + '" style="' + secondaryButtonStyle() + '">Contact us</a></div>';
}

function buttonStyle() {
  return "display:inline-block;background:#1F4A45;color:#fff;text-decoration:none;font-weight:700;padding:13px 22px;border-radius:10px";
}

function secondaryButtonStyle() {
  return "display:inline-block;background:#F6F0E3;border:1px solid #D7C8AC;color:#1F4A45;text-decoration:none;font-weight:700;padding:12px 18px;border-radius:10px;margin:0 8px 8px 0";
}

function json(o, s, c) {
  return new Response(JSON.stringify(o), {
    status: s,
    headers: { ...c, "Content-Type": "application/json" },
  });
}

function normalizeEmail(s) {
  const email = String(s || "").trim().toLowerCase();
  return EMAIL_ALIASES[email] || email;
}

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

function nl2br(s) {
  return String(s || "").replace(/\n/g, "<br>");
}
