require("dotenv").config();
const express = require("express");
const crypto = require("crypto");
const app = express();

const {
  PORT = 3000, META_VERIFY_TOKEN = "", META_APP_SECRET = "",
  WHATSAPP_PHONE_NUMBER_ID = "", WHATSAPP_ACCESS_TOKEN = "",
  MESSENGER_PAGE_ACCESS_TOKEN = "", AIRTABLE_API_KEY = "", AIRTABLE_BASE_ID = "",
  SUPABASE_URL = "", SUPABASE_SERVICE_ROLE_KEY = "",
  GEMINI_API_KEY = "", GEMINI_MODEL = "gemini-2.5-flash"
} = process.env;

const VALID_INTENTS = new Set(["greeting","menu","menu_1","menu_2","menu_3","diagnostics","pricing","booking","booking_yes","tone_reset","general"]);
const PAYMENT = { bank: "UBA Bank", account: "2137886638", name: "Emmanuel Uche David", status: "Pending UBA Verification" };
const seen = new Set();

app.use(express.json({ limit: "5mb", verify: (req, _res, buf) => { req.rawBody = buf; } }));

function verifySig(req) {
  if (!META_APP_SECRET) return true;
  const sig = req.get("X-Hub-Signature-256") || "";
  const exp = "sha256=" + crypto.createHmac("sha256", META_APP_SECRET).update(req.rawBody || Buffer.from("")).digest("hex");
  return sig.length === exp.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(exp));
}

function normPhone(raw) {
  const d = String(raw || "").replace(/\D/g, "");
  if (!d) return null;
  return d.startsWith("0") && d.length === 11 ? "234" + d.slice(1) : d;
}

function esc(v) { return String(v).replace(/\\/g, "\\\\").replace(/"/g, "\\\""); }
function fmtNgn(n) { return "₦" + Math.round(Number(n || 0)).toLocaleString("en-NG"); }

async function isDup(eventId, channel, senderId) {
  if (!eventId) return false;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    if (seen.has(eventId)) return true;
    seen.add(eventId);
    return false;
  }
  const url = SUPABASE_URL.replace(/\/+$/, "") + "/rest/v1/processed_webhook_events";
  const res = await fetch(url, {
    method: "POST",
    headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: "Bearer " + SUPABASE_SERVICE_ROLE_KEY, "Content-Type": "application/json", Prefer: "return=minimal,resolution=ignore-duplicates" },
    body: JSON.stringify([{ event_id: eventId, channel, sender_id: String(senderId) }])
  });
  if (res.status === 201) return false;
  if (res.status === 409) return true;
  const chk = await fetch(url + "?event_id=eq." + encodeURIComponent(eventId) + "&select=event_id&limit=1", {
    headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: "Bearer " + SUPABASE_SERVICE_ROLE_KEY }
  });
  const rows = chk.ok ? await chk.json() : [];
  return Array.isArray(rows) && rows.length > 0;
}

async function auditSupa(row) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return;
  await fetch(SUPABASE_URL.replace(/\/+$/, "") + "/rest/v1/autocraft_message_audit", {
    method: "POST",
    headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: "Bearer " + SUPABASE_SERVICE_ROLE_KEY, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify([row])
  }).catch((e) => console.error("Supabase audit error:", e.message));
}

async function atReq(table, method = "GET", suffix = "", body = null) {
  if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) return null;
  const url = "https://api.airtable.com/v0/" + AIRTABLE_BASE_ID + "/" + encodeURIComponent(table) + suffix;
  const res = await fetch(url, {
    method,
    headers: { Authorization: "Bearer " + AIRTABLE_API_KEY, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json();
  if (!res.ok) throw new Error("Airtable " + table + " error: " + JSON.stringify(data));
  return data;
}

function parseMsg(text) {
  const s = String(text || "");
  const yr = (s.match(/\b(199\d|20[0-2]\d)\b/) || [])[1] || null;
  const dtc = (s.toUpperCase().match(/\b([PBCU]\d{4})\b/) || [])[1] || null;
  const vip = (s.toUpperCase().match(/\b(SILVER|GOLD|PLATINUM)\b/) || [])[1] || null;
  const payClaim = /\b(paid|transfer|receipt|sent money|alert)\b/i.test(s);
  const lga = (s.match(/\b(Okota|Ago|Lekki|Surulere|Ikeja|Yaba|Ajah|Ikorodu|Abuja|Port Harcourt|Owerri|Enugu|Ibadan)\b/i) || [])[1] || null;
  const makes = ["Toyota","Lexus","Mercedes-Benz","Mercedes","Benz","BMW","Range Rover","Honda","Nissan","Hyundai","Kia","Ford","Chevrolet"];
  const make = makes.find((m) => new RegExp("\\b" + m + "\\b", "i").test(s)) || null;
  let intent = "general";
  if (dtc || /\b(dtc|scan|check engine|code)\b/i.test(s)) intent = "diagnostics";
  else if (/^(hi|hello|hey|good morning|good afternoon|good evening)\b/i.test(s.trim())) intent = "greeting";
  else if (/^1\b/.test(s.trim())) intent = "menu_1";
  else if (/^2\b/.test(s.trim())) intent = "menu_2";
  else if (/^3\b/.test(s.trim())) intent = "menu_3";
  else if (/\b(price|pricing|quote|cost|how much|vip)\b/i.test(s)) intent = "pricing";
  else if (/\b(book|booking|schedule|appointment)\b/i.test(s)) intent = "booking";
  return { intent, yr: yr ? Number(yr) : null, dtc, vip, payClaim, lga, make };
}

async function sendMeta(channel, to, body) {
  if (!to || !body) return;
  if (channel === "WhatsApp" && WHATSAPP_PHONE_NUMBER_ID && WHATSAPP_ACCESS_TOKEN) {
    await fetch("https://graph.facebook.com/v21.0/" + WHATSAPP_PHONE_NUMBER_ID + "/messages", {
      method: "POST",
      headers: { Authorization: "Bearer " + WHATSAPP_ACCESS_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body } })
    }).catch((e) => console.error("WA send error:", e.message));
  } else if (channel === "Messenger" && MESSENGER_PAGE_ACCESS_TOKEN) {
    await fetch("https://graph.facebook.com/v21.0/me/messages?access_token=" + encodeURIComponent(MESSENGER_PAGE_ACCESS_TOKEN), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recipient: { id: to }, messaging_type: "RESPONSE", message: { text: body } })
    }).catch((e) => console.error("MSG send error:", e.message));
  }
}

async function processEv(ev) {
  if (await isDup(ev.event_id, ev.channel, ev.sender_id)) return;
  const p = parseMsg(ev.message);
  const phone = ev.phone || (ev.channel === "WhatsApp" ? normPhone(ev.sender_id) : String(ev.sender_id));
  const vehicleLabel = [p.yr, p.make].filter(Boolean).join(" ") || null;

  let custId = null;
  let vehId = null;
  if (AIRTABLE_API_KEY && AIRTABLE_BASE_ID) {
    const formula = ev.channel === "WhatsApp" && phone ? "{WhatsApp} = \"" + esc(phone) + "\"" : "{Messenger Sender ID} = \"" + esc(ev.sender_id) + "\"";
    const found = await atReq("CUSTOMERS", "GET", "?maxRecords=1&filterByFormula=" + encodeURIComponent(formula));
    const cFields = { "Preferred Channel": ev.channel };
    if (ev.customer_name) cFields["Customer Name"] = ev.customer_name;
    else if (!found?.records?.length) cFields["Customer Name"] = ev.channel + " Client";
    if (phone) cFields["WhatsApp"] = phone;
    if (ev.channel !== "WhatsApp") cFields["Messenger Sender ID"] = String(ev.sender_id);
    if (p.lga) cFields["LGA"] = p.lga;
    const custRec = found?.records?.length
      ? await atReq("CUSTOMERS", "PATCH", "/" + found.records[0].id, { fields: cFields })
      : (await atReq("CUSTOMERS", "POST", "", { records: [{ fields: cFields }] }))?.records?.[0];
    custId = custRec?.id || null;

    if (vehicleLabel) {
      const vFields = { Vehicle: vehicleLabel };
      if (custId) vFields["Owner"] = [custId];
      if (p.make) vFields["Make/Model"] = p.make;
      if (p.yr) vFields["Year"] = p.yr;
      if (p.lga) vFields["LGA"] = p.lga;
      const vRec = (await atReq("VEHICLES", "POST", "", { records: [{ fields: vFields }] }))?.records?.[0];
      vehId = vRec?.id || null;
    }
  }

  let reply = "";
  let status = null;
  if (p.payClaim) {
    status = PAYMENT.status;
    reply = "Payment notice logged under *" + PAYMENT.status + "*.\nFinal clearance happens only after Uche personally confirms funds inside " + PAYMENT.bank + " (" + PAYMENT.account + " - " + PAYMENT.name + ").\nDeposits: 50% for service bookings, 100% for VIP plans.";
  } else if (p.dtc) {
    reply = "DTC *" + p.dtc + "* received" + (vehicleLabel ? " for *" + vehicleLabel + "*" : "") + ".\nWe will verify live data, circuit/sensor/module faults, and give an exact quote.\nPay to " + PAYMENT.bank + ": " + PAYMENT.account + " (" + PAYMENT.name + ") — stays *" + PAYMENT.status + "* until verified.";
  } else if (p.intent === "greeting") {
    reply = "Welcome to AutoCraft Car Care Center! Diagnosis. Parts. Mobility. Trust.\nReply 1: Diagnosis & DTC | 2: Inspection | 3: Spare Parts | 4: Mobility/Booking | 5: VIP Plans\nOr send: Car Year, Make/Model, Location (LGA), and Service needed.";
  } else {
    reply = "Thanks for contacting AutoCraft Car Care Center. Please share:\n1. Car Year & Make/Model\n2. Location (LGA)\n3. Service needed (Diagnosis, Inspection, Parts, Mobility/Booking, or VIP)\n" + PAYMENT.bank + ": " + PAYMENT.account + " (" + PAYMENT.name + ").";
  }

  const finalIntent = VALID_INTENTS.has(p.intent) ? p.intent : "general";
  let leadId = null;
  if (AIRTABLE_API_KEY && AIRTABLE_BASE_ID) {
    const lFields = {
      Phone: phone || String(ev.sender_id),
      "Sender ID": String(ev.sender_id),
      Channel: ev.channel,
      Message: ev.message,
      Intent: finalIntent,
      Reply: reply,
      Timestamp: ev.timestamp || new Date().toISOString()
    };
    if (ev.customer_name) lFields["Customer Name"] = ev.customer_name;
    if (vehicleLabel) lFields["Vehicle"] = vehicleLabel;
    if (status) lFields["Booking Status"] = status;
    if (custId) lFields["Customer Record"] = [custId];
    if (vehId) lFields["Vehicle Record"] = [vehId];
    const leadRec = (await atReq("WhatsApp Leads & Bookings", "POST", "", { records: [{ fields: lFields }] }))?.records?.[0];
    leadId = leadRec?.id || null;
  }

  await auditSupa({
    event_id: ev.event_id, channel: ev.channel, sender_id: String(ev.sender_id), phone,
    customer_name: ev.customer_name || null, lga: p.lga, vehicle_label: vehicleLabel,
    intent: finalIntent, inbound_message: ev.message, bot_reply: reply,
    payment_status: status, airtable_customer_id: custId, airtable_vehicle_id: vehId, airtable_lead_id: leadId
  });

  await sendMeta(ev.channel, ev.sender_id, reply);
}

app.get("/webhook", (req, res) => {
  if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] && req.query["hub.verify_token"] === META_VERIFY_TOKEN) {
    return res.status(200).send(req.query["hub.challenge"]);
  }
  return res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  if (!verifySig(req)) return res.sendStatus(401);
  res.sendStatus(200);
  const body = req.body || {};
  const events = [];
  if (body.object === "whatsapp_business_account") {
    for (const e of body.entry || []) {
      for (const ch of e.changes || []) {
        const contacts = ch.value?.contacts || [];
        for (const m of ch.value?.messages || []) {
          const c = contacts.find((x) => x.wa_id === m.from);
          const txt = m.type === "text" ? m.text?.body : m.interactive?.button_reply?.title || m.interactive?.list_reply?.title || ("[" + (m.type || "media") + "]");
          events.push({ event_id: "wa:" + m.id, channel: "WhatsApp", sender_id: m.from, phone: normPhone(m.from), customer_name: c?.profile?.name || null, message: txt || "", timestamp: m.timestamp ? new Date(Number(m.timestamp) * 1000).toISOString() : new Date().toISOString() });
        }
      }
    }
  } else if (body.object === "page") {
    for (const e of body.entry || []) {
      for (const item of e.messaging || []) {
        if (item.message?.is_echo) continue;
        const txt = item.message?.text || item.postback?.title;
        if (!txt || !item.sender?.id) continue;
        events.push({ event_id: item.message?.mid ? "msg:" + item.message.mid : "msg:" + item.sender.id + ":" + (item.timestamp || Date.now()), channel: "Messenger", sender_id: String(item.sender.id), phone: String(item.sender.id), customer_name: null, message: txt, timestamp: item.timestamp ? new Date(Number(item.timestamp)).toISOString() : new Date().toISOString() });
      }
    }
  }
  for (const ev of events) {
    try { await processEv(ev); } catch (err) { console.error("Event error:", err); }
  }
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, supabaseConfigured: Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY), airtableConfigured: Boolean(AIRTABLE_API_KEY && AIRTABLE_BASE_ID), timestamp: new Date().toISOString() });
});

app.listen(PORT, () => console.log("AutoCraft Meta Webhook running on port " + PORT));
