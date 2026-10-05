const express = require("express");
const crypto = require("crypto");
const axios = require("axios");
const fs = require("fs");

const app = express();

const {
  PORT = 3000,
  SHOPIFY_STORE,
  SHOPIFY_API_KEY,
  SHOPIFY_API_SECRET,
  SHOPIFY_CLIENT_SECRET,
  SHOPIFY_ACCESS_TOKEN,
  WHATSAPP_TOKEN,
  WHATSAPP_PHONE_ID,
  VERIFY_TOKEN,
  FALLBACK_IMAGE_URL,
  CRON_SECRET,
  INBOX_SECRET,
} = process.env;

const SHOPIFY_API_VERSION = "2025-01";
const GRAPH_VERSION = "v21.0";
const TEMPLATE_NAME = "order_confirmation";
const TEMPLATE_LANG = "en";

const REMINDER_TEMPLATE = "delivery_reminder";
const REMINDER_LANG = "en";

// Fulfill ke kitne din baad reminder (default 3)
const REMINDER_DAYS = Number(process.env.REMINDER_DAYS ?? 3);

const processedOrders = new Set();
const remindedOrders = new Set();
let reminderRunning = false;

// ---------- Inbox storage ----------

const INBOX_FILE = "inbox-data.json";
const conversations = new Map();

try {
  const saved = JSON.parse(fs.readFileSync(INBOX_FILE, "utf8"));
  for (const [k, v] of Object.entries(saved)) conversations.set(k, v);
} catch (e) {}

let saveTimer = null;
function saveInbox() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(INBOX_FILE, JSON.stringify(Object.fromEntries(conversations)));
    } catch (e) {}
  }, 1000);
}

function addMessage(phone, dir, text, name) {
  let c = conversations.get(phone);
  if (!c) {
    c = { name: "", messages: [] };
    conversations.set(phone, c);
  }
  if (name) c.name = name;
  c.messages.push({ dir, text: String(text).slice(0, 2000), time: Date.now() });
  if (c.messages.length > 200) c.messages = c.messages.slice(-200);
  saveInbox();
}

function describeMessage(msg) {
  if (msg.type === "text") return msg.text?.body || "";
  if (msg.type === "button") return `[Button] ${msg.button?.text || ""}`;
  if (msg.type === "interactive")
    return `[Button] ${msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || ""}`;
  return `[${msg.type}]`;
}

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtTime(t) {
  return new Date(t).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ---------- Helpers ----------

function cleanPhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, "");
  if (digits.length < 10) return null;
  return "91" + digits.slice(-10);
}

function cleanText(text, maxLen = 300) {
  return String(text || "")
    .replace(/[\r\n\t]+/g, ", ")
    .replace(/\s{2,}/g, " ")
    .replace(/(,\s*){2,}/g, ", ")
    .trim()
    .slice(0, maxLen);
}

function formatAddress(a) {
  if (!a) return "Address available nahi";
  const parts = [a.name, a.address1, a.address2, a.city, a.province, a.zip]
    .filter(Boolean)
    .map((p) => cleanText(p));
  return cleanText(parts.join(", "), 400) || "Address available nahi";
}

function formatTotal(order) {
  const symbol = order.currency === "INR" ? "₹" : order.currency + " ";
  return `${symbol}${order.total_price}`;
}

let cachedToken = null;
let tokenExpiresAt = 0;

async function getShopifyToken() {
  const clientSecret = (SHOPIFY_CLIENT_SECRET || "").trim();
  if (!clientSecret) return SHOPIFY_ACCESS_TOKEN;

  if (cachedToken && Date.now() < tokenExpiresAt - 60000) return cachedToken;

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: (SHOPIFY_API_KEY || "").trim(),
    client_secret: clientSecret,
  });
  const res = await axios.post(
    `https://${SHOPIFY_STORE}/admin/oauth/access_token`,
    body
  );
  cachedToken = res.data.access_token;
  tokenExpiresAt = Date.now() + (res.data.expires_in || 86400) * 1000;
  console.log("Naya Shopify token mil gaya");
  return cachedToken;
}

async function shopifyHeaders() {
  return {
    "X-Shopify-Access-Token": await getShopifyToken(),
    "Content-Type": "application/json",
  };
}

async function getProductImage(productId) {
  if (!productId) return FALLBACK_IMAGE_URL || null;
  try {
    const url = `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}/products/${productId}.json?fields=id,image`;
    const res = await axios.get(url, { headers: await shopifyHeaders() });
    return res.data?.product?.image?.src || FALLBACK_IMAGE_URL || null;
  } catch (err) {
    console.error("Product image error:", err.response?.data || err.message);
    return FALLBACK_IMAGE_URL || null;
  }
}

async function shopifyGraphQL(query, variables) {
  const url = `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
  const res = await axios.post(url, { query, variables }, { headers: await shopifyHeaders() });
  if (res.data?.errors) console.error("Shopify GraphQL error:", JSON.stringify(res.data.errors));
  return res.data;
}

async function addTags(orderId, tags) {
  const q = `mutation($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) { userErrors { field message } }
  }`;
  await shopifyGraphQL(q, { id: `gid://shopify/Order/${orderId}`, tags });
}

async function removeTags(orderId, tags) {
  const q = `mutation($id: ID!, $tags: [String!]!) {
    tagsRemove(id: $id, tags: $tags) { userErrors { field message } }
  }`;
  await shopifyGraphQL(q, { id: `gid://shopify/Order/${orderId}`, tags });
}

async function sendWhatsApp(body) {
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${WHATSAPP_PHONE_ID}/messages`;
  return axios.post(
    url,
    { messaging_product: "whatsapp", ...body },
    { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
  );
}

async function sendText(to, text) {
  try {
    await sendWhatsApp({ to, type: "text", text: { body: text } });
  } catch (err) {
    console.error("sendText error:", err.response?.data || err.message);
  }
}

// ---------- Shopify webhook: orders/create ----------

app.post(
  "/webhooks/orders-create",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const hmacHeader = req.get("X-Shopify-Hmac-Sha256") || "";
    const secret = (SHOPIFY_API_SECRET || "").trim();
    const digest = crypto
      .createHmac("sha256", secret)
      .update(req.body)
      .digest("base64");

    const a = Buffer.from(digest);
    const b = Buffer.from(hmacHeader);
    const valid = a.length === b.length && crypto.timingSafeEqual(a, b);

    if (!valid) {
      console.warn(
        `Invalid Shopify HMAC | secret length: ${secret.length} | header present: ${hmacHeader.length > 0}`
      );
      return res.status(401).send("Unauthorized");
    }

    res.status(200).send("OK");

    try {
      const order = JSON.parse(req.body.toString("utf8"));
      if (processedOrders.has(order.id)) return;
      processedOrders.add(order.id);

      const phone = cleanPhone(
        order.shipping_address?.phone ||
          order.phone ||
          order.customer?.phone ||
          order.billing_address?.phone
      );
      if (!phone) {
        console.warn(`Order ${order.name}: valid phone nahi mila`);
        await addTags(order.id, ["wa-no-phone"]);
        return;
      }

      const customerName = cleanText(
        order.shipping_address?.first_name || order.customer?.first_name || "Customer",
        60
      );

      const items = cleanText(
        (order.line_items || [])
          .map((i) => {
            const v =
              i.variant_title && i.variant_title !== "Default Title"
                ? ` - ${i.variant_title}`
                : "";
            return `${i.quantity}x ${i.title}${v}`;
          })
          .join(", "),
        300
      );

      const imageUrl = await getProductImage(order.line_items?.[0]?.product_id);

      const components = [
        {
          type: "body",
          parameters: [
            { type: "text", text: customerName },
            { type: "text", text: String(order.name) },
            { type: "text", text: items || "-" },
            { type: "text", text: formatTotal(order) },
            { type: "text", text: formatAddress(order.shipping_address) },
          ],
        },
        {
          type: "button",
          sub_type: "quick_reply",
          index: "0",
          parameters: [{ type: "payload", payload: `CONFIRM_${order.id}` }],
        },
        {
          type: "button",
          sub_type: "quick_reply",
          index: "1",
          parameters: [{ type: "payload", payload: `CANCEL_${order.id}` }],
        },
      ];

      if (imageUrl) {
        components.unshift({
          type: "header",
          parameters: [{ type: "image", image: { link: imageUrl } }],
        });
      }

      const waRes = await sendWhatsApp({
        to: phone,
        type: "template",
        template: {
          name: TEMPLATE_NAME,
          language: { code: TEMPLATE_LANG },
          components,
        },
      });

      console.log("Meta response:", JSON.stringify(waRes.data));
      await addTags(order.id, ["wa-pending"]);
      console.log(`Order ${order.name}: WhatsApp bhej diya -> ${phone}`);
    } catch (err) {
      console.error("orders-create error:", err.response?.data || err.message);
    }
  }
);

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ---------- Meta webhook: verify ----------
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// ---------- Meta webhook: customer replies + delivery status ----------
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const entries = req.body?.entry || [];
    for (const entry of entries) {
      for (const change of entry.changes || []) {
        for (const st of change.value?.statuses || []) {
          console.log("STATUS:", st.status, JSON.stringify(st.errors || ""));
        }

        const messages = change.value?.messages || [];
        for (const msg of messages) {
          const profileName = (change.value?.contacts || []).find(
            (c) => c.wa_id === msg.from
          )?.profile?.name;
          addMessage(msg.from, "in", describeMessage(msg), profileName);

          let payload = null;
          if (msg.type === "button") payload = msg.button?.payload;
          if (msg.type === "interactive") payload = msg.interactive?.button_reply?.id;
          if (!payload) continue;

          const [action, orderId] = String(payload).split("_");
          if (!orderId) continue;

          if (action === "CONFIRM") {
            await addTags(orderId, ["wa-confirmed"]);
            await removeTags(orderId, ["wa-pending", "wa-cancelled"]);
            await sendText(
              msg.from,
              "Thanks! 🙏✅ Aapka order confirm ho gaya hai.\n\nHum jaldi hi ise dispatch karenge 🚚\nBazoora chunne ke liye dhanyavaad 😊"
            );
          } else if (action === "CANCEL") {
            await addTags(orderId, ["wa-cancelled"]);
            await removeTags(orderId, ["wa-pending", "wa-confirmed"]);
            await sendText(
              msg.from,
              "Hello! 🙏 Aapka cancel request humne note kar liya hai, aur hamari team jaldi ise process kar degi 😊\n\nUmeed hai future mein hum aapki seva kar paayenge 🛍️✨\nBazoora chunne ke liye Thank you! ❤️"
            );
          }
          console.log(`Reply: ${action} order ${orderId}`);
        }
      }
    }
  } catch (err) {
    console.error("webhook POST error:", err.response?.data || err.message);
  }
});

// ---------- Inbox page ----------

function inboxAuth(req, res) {
  const key = req.query.key || req.body?.key;
  if (!INBOX_SECRET || key !== INBOX_SECRET) {
    res.status(403).send("Forbidden");
    return null;
  }
  return key;
}

function page(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
body{font-family:Arial,sans-serif;margin:0;background:#f3f0ff;color:#222}
.top{background:#8a2be2;color:#fff;padding:14px;font-weight:bold}
.top a{color:#fff;text-decoration:none}
.wrap{padding:12px}
.card{display:block;background:#fff;border-radius:10px;padding:12px;margin-bottom:8px;text-decoration:none;color:#222;box-shadow:0 1px 3px rgba(0,0,0,.1)}
.card small{color:#777;display:block;margin-top:4px}
.msg{max-width:80%;padding:8px 10px;border-radius:10px;margin:6px 0;white-space:pre-wrap;word-wrap:break-word;font-size:14px}
.in{background:#fff;margin-right:auto}
.out{background:#d9fdd3;margin-left:auto}
.msg small{display:block;color:#777;font-size:10px;margin-top:3px}
textarea{width:100%;box-sizing:border-box;padding:10px;border-radius:8px;border:1px solid #ccc;font-size:15px}
button{background:#8a2be2;color:#fff;border:0;padding:12px 18px;border-radius:8px;font-size:15px;margin-top:6px}
.warn{background:#fff3cd;padding:8px;border-radius:8px;margin:8px 0;font-size:13px}
.err{background:#f8d7da;padding:8px;border-radius:8px;margin:8px 0;font-size:13px}
</style></head><body>${body}</body></html>`;
}

app.get("/inbox", (req, res) => {
  const key = inboxAuth(req, res);
  if (!key) return;
  const k = encodeURIComponent(key);
  const phone = req.query.c;

  if (!phone) {
    const list = [...conversations.entries()]
      .map(([p, c]) => ({ p, c, last: c.messages[c.messages.length - 1] }))
      .filter((x) => x.last)
      .sort((a, b) => b.last.time - a.last.time);
    const items = list.length
      ? list
          .map(
            (x) => `<a class="card" href="/inbox?key=${k}&c=${encodeURIComponent(x.p)}">
<b>${esc(x.c.name || "Customer")}</b> (+${esc(x.p)})
<small>${x.last.dir === "in" ? "" : "Aap: "}${esc(x.last.text.slice(0, 60))}</small>
<small>${fmtTime(x.last.time)}</small></a>`
          )
          .join("")
      : `<div class="card">Abhi koi message nahi aaya.</div>`;
    return res.send(
      page(
        "Bazoora Inbox",
        `<div class="top">Bazoora Inbox</div><div class="wrap">${items}</div>`
      )
    );
  }

  const c = conversations.get(phone);
  if (!c)
    return res
      .status(404)
      .send(page("Inbox", `<div class="wrap">Chat nahi mili. <a href="/inbox?key=${k}">Wapas</a></div>`));

  const lastIn = [...c.messages].reverse().find((m) => m.dir === "in");
  const within24 = lastIn && Date.now() - lastIn.time < 24 * 3600 * 1000;
  const bubbles = c.messages
    .map((m) => `<div class="msg ${m.dir}">${esc(m.text)}<small>${fmtTime(m.time)}</small></div>`)
    .join("");
  const err = req.query.err ? `<div class="err">Reply nahi gaya: ${esc(req.query.err)}</div>` : "";
  const warn = within24
    ? ""
    : `<div class="warn">Customer ke aakhri message ko 24 ghante se zyada ho gaye. Reply shayad na jaye.</div>`;

  res.send(
    page(
      "Chat",
      `<div class="top"><a href="/inbox?key=${k}">&larr; Inbox</a> &nbsp; ${esc(c.name || "Customer")} (+${esc(phone)})</div>
<div class="wrap">${bubbles}${err}${warn}
<form method="POST" action="/inbox/reply">
<input type="hidden" name="key" value="${esc(key)}">
<input type="hidden" name="phone" value="${esc(phone)}">
<textarea name="text" rows="3" placeholder="Reply likho..." required></textarea>
<button type="submit">Bhejo</button>
</form></div>`
    )
  );
});

app.post("/inbox/reply", async (req, res) => {
  const key = inboxAuth(req, res);
  if (!key) return;
  const k = encodeURIComponent(key);
  const phone = String(req.body.phone || "");
  const text = String(req.body.text || "").trim();
  if (!phone || !text) return res.redirect(303, `/inbox?key=${k}`);

  try {
    await sendWhatsApp({ to: phone, type: "text", text: { body: text } });
    addMessage(phone, "out", text);
    res.redirect(303, `/inbox?key=${k}&c=${encodeURIComponent(phone)}`);
  } catch (err) {
    const e = err.response?.data?.error;
    const msg = e ? `${e.code}: ${e.message}` : err.message;
    console.error("inbox reply error:", msg);
    res.redirect(
      303,
      `/inbox?key=${k}&c=${encodeURIComponent(phone)}&err=${encodeURIComponent(msg)}`
    );
  }
});

// ---------- Delivery reminder (roz cron-job.org se chalega) ----------

async function runReminders() {
  if (reminderRunning) {
    console.log("Reminder check pehle se chal raha hai, ye skip");
    return;
  }
  reminderRunning = true;

  try {
    const since = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const search = `fulfillment_status:fulfilled -tag:wa-reminded -tag:wa-cancelled created_at:>=${since}`;
    const q = `query($q: String!) {
      orders(first: 200, query: $q) {
        nodes {
          legacyResourceId
          name
          phone
          customer { firstName phone }
          shippingAddress { firstName name address1 address2 city province zip phone }
          fulfillments(first: 5) {
            createdAt
            trackingInfo {
              url
              number
            }
          }
        }
      }
    }`;

    const data = await shopifyGraphQL(q, { q: search });
    const orders = data?.data?.orders?.nodes || [];
    console.log(`Reminder check: ${orders.length} fulfilled order(s) mile (REMINDER_DAYS=${REMINDER_DAYS})`);

    for (const o of orders) {
      const orderId = o.legacyResourceId;
      if (remindedOrders.has(orderId)) continue;

      const fulfillments = o.fulfillments || [];
      const times = fulfillments.map((f) => new Date(f.createdAt).getTime());
      if (!times.length) continue;
      const days = (Date.now() - Math.min(...times)) / 86400000;
      if (days < REMINDER_DAYS) continue;

      const phone = cleanPhone(
        o.shippingAddress?.phone || o.phone || o.customer?.phone
      );
      if (!phone) {
        console.warn(`Reminder ${o.name}: phone nahi mila`);
        remindedOrders.add(orderId);
        await addTags(orderId, ["wa-reminded", "wa-no-phone"]);
        continue;
      }

      // Shopify fulfillment se tracking URL detect karna
      const validFulfillment = fulfillments.find((f) => f.trackingInfo && f.trackingInfo.url);
      const trackingUrl = validFulfillment?.trackingInfo?.url || "Tracking link available nahi";

      remindedOrders.add(orderId);
      try {
        const name = cleanText(
          o.shippingAddress?.firstName || o.customer?.firstName || "Customer",
          60
        );
        const waRes = await sendWhatsApp({
          to: phone,
          type: "template",
          template: {
            name: REMINDER_TEMPLATE,
            language: { code: REMINDER_LANG },
            components: [
              {
                type: "body",
                parameters: [
                  { type: "text", text: name },
                  { type: "text", text: String(o.name) },
                  { type: "text", text: formatAddress(o.shippingAddress) },
                  { type: "text", text: trackingUrl }, // {{4}} me tracking link jayega
                ],
              },
            ],
          },
        });
        console.log("Reminder Meta response:", JSON.stringify(waRes.data));
        await addTags(orderId, ["wa-reminded"]);
        console.log(`Reminder bheja: ${o.name} -> ${phone}`);
      } catch (err) {
        remindedOrders.delete(orderId);
        console.error(`Reminder error ${o.name}:`, JSON.stringify(err.response?.data || err.message));
      }
    }
  } finally {
    reminderRunning = false;
  }
}

app.get("/cron/reminders", (req, res) => {
  if (!CRON_SECRET || req.query.key !== CRON_SECRET) {
    return res.status(403).send("Forbidden");
  }
  res.status(200).send("Reminder check shuru ho gaya");
  runReminders().catch((err) => {
    reminderRunning = false;
    console.error("runReminders error:", err.response?.data || err.message);
  });
});

// ---------
