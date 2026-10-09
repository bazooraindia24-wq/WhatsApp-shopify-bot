Const express = require("express");
Const crypto = require("crypto");
Const axios = require("axios");
Const fs = require("fs");

Const app = express();

Const {
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
  GEMINI_API_KEY,
} = process.env;

const SHOPIFY_API_VERSION = "2025-01";
Const GRAPH_VERSION = "v21.0";
Const TEMPLATE_NAME = "order_confirmation";
Const TEMPLATE_LANG = "en";

Const REMINDER_TEMPLATE = "delivery_reminder";
Const REMINDER_LANG = "en";

// Fulfill ke kitne din baad reminder (default 3)
Const REMINDER_DAYS = Number(process.env.REMINDER_DAYS ?? 3);

Const processedOrders = new Set();
Const remindedOrders = new Set();
Let reminderRunning = false;

// ---------- Gemini AI Helper ----------

async function askGemini(promptText) {
  If (!GEMINI_API_KEY) return null;
  Try {
    Const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;
    Const res = await axios.post(url, {
      Contents: [{ parts: [{ text: promptText }] }]
    });
    Return res.data?.candidates?.[0]?.content?.parts?.[0]?.text || null;
  } catch (err) {
    Console.error("Gemini API error:", err.response?.data || err.message);
    Return null;
  }
}

// ---------- Inbox storage ----------

Const INBOX_FILE = "inbox-data.json";
Const conversations = new Map();

Try {
  Const saved = JSON.parse(fs.readFileSync(INBOX_FILE, "utf8"));
  For (const [k, v] of Object.entries(saved)) conversations.set(k, v);
} catch (e) {}

Let saveTimer = null;
Function saveInbox() {
  ClearTimeout(saveTimer);
  SaveTimer = setTimeout(() => {
    Try {
      Fs.writeFileSync(INBOX_FILE, JSON.stringify(Object.fromEntries(conversations)));
    } catch (e) {}
  }, 1000);
}

Function addMessage(phone, dir, text, name) {
  Let c = conversations.get(phone);
  If (!c) {
    C = { name: "", messages: [] };
    Conversations.set(phone, c);
  }
  If (name) c.name = name;
  C.messages.push({ dir, text: String(text).slice(0, 2000), time: Date.now() });
  If (c.messages.length > 200) c.messages = c.messages.slice(-200);
  SaveInbox();
}

Function describeMessage(msg) {
  If (msg.type === "text") return msg.text?.body || "";
  If (msg.type === "button") return `[Button] ${msg.button?.text || ""}`;
  If (msg.type === "interactive")
    Return `[Button] ${msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || ""}`;
  Return `[${msg.type}]`;
}

Function esc(s) {
  Return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

Function fmtTime(t) {
  Return new Date(t).toLocaleString("en-IN", {
    TimeZone: "Asia/Kolkata",
    Day: "2-digit",
    Month: "short",
    Hour: "2-digit",
    Minute: "2-digit",
  });
}

// ---------- Helpers ----------

Function cleanPhone(raw) {
  If (!raw) return null;
  Const digits = String(raw).replace(/\D/g, "");
  If (digits.length < 10) return null;
  Return "91" + digits.slice(-10);
}

Function cleanText(text, maxLen = 300) {
  Return String(text || "")
    .replace(/[\r\n\t]+/g, ", ")
    .replace(/\s{2,}/g, " ")
    .replace(/(,\s*){2,}/g, ", ")
    .trim()
    .slice(0, maxLen);
}

Function formatAddress(a) {
  If (!a) return "Address available nahi";
  Const parts = [a.name, a.address1, a.address2, a.city, a.province, a.zip]
    .filter(Boolean)
    .map((p) => cleanText(p));
  Return cleanText(parts.join(", "), 400) || "Address available nahi";
}

Function formatTotal(order) {
  Const symbol = order.currency === "INR" ? "₹" : order.currency + " ";
  Return `${symbol}${order.total_price}`;
}

Let cachedToken = null;
Let tokenExpiresAt = 0;

async function getShopifyToken() {
  Const clientSecret = (SHOPIFY_CLIENT_SECRET || "").trim();
  If (!clientSecret) return SHOPIFY_ACCESS_TOKEN;

  If (cachedToken && Date.now() < tokenExpiresAt - 60000) return cachedToken;

  Const body = new URLSearchParams({
    Grant_type: "client_credentials",
    Client_id: (SHOPIFY_API_KEY || "").trim(),
    Client_secret: clientSecret,
  });
  Const res = await axios.post(
    `https://${SHOPIFY_STORE}/admin/oauth/access_token`,
    Body
  );
  CachedToken = res.data.access_token;
  TokenExpiresAt = Date.now() + (res.data.expires_in || 86400) * 1000;
  Console.log("Naya Shopify token mil gaya");
  Return cachedToken;
}

async function shopifyHeaders() {
  Return {
    "X-Shopify-Access-Token": await getShopifyToken(),
    "Content-Type": "application/json",
  };
}

async function getProductImage(productId) {
  If (!productId) return FALLBACK_IMAGE_URL || null;
  Try {
    Const url = `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}/products/${productId}.json?fields=id,image`;
    Const res = await axios.get(url, { headers: await shopifyHeaders() });
    Return res.data?.product?.image?.src || FALLBACK_IMAGE_URL || null;
  } catch (err) {
    Console.error("Product image error:", err.response?.data || err.message);
    Return FALLBACK_IMAGE_URL || null;
  }
}

async function shopifyGraphQL(query, variables) {
  Const url = `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
  Const res = await axios.post(url, { query, variables }, { headers: await shopifyHeaders() });
  If (res.data?.errors) console.error("Shopify GraphQL error:", JSON.stringify(res.data.errors));
  Return res.data;
}

async function addTags(orderId, tags) {
  Const q = `mutation($id: ID!, $tags: [String!]!) {
    TagsAdd(id: $id, tags: $tags) { userErrors { field message } }
  }`;
  Await shopifyGraphQL(q, { id: `gid://shopify/Order/${orderId}`, tags });
}

async function removeTags(orderId, tags) {
  Const q = `mutation($id: ID!, $tags: [String!]!) {
    TagsRemove(id: $id, tags: $tags) { userErrors { field message } }
  }`;
  Await shopifyGraphQL(q, { id: `gid://shopify/Order/${orderId}`, tags });
}

async function sendWhatsApp(body) {
  Const url = `https://graph.facebook.com/${GRAPH_VERSION}/${WHATSAPP_PHONE_ID}/messages`;
  Return axios.post(
    Url,
    { messaging_product: "whatsapp", ...body },
    { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
  );
}

async function sendText(to, text) {
  Try {
    Await sendWhatsApp({ to, type: "text", text: { body: text } });
  } catch (err) {
    Console.error("sendText error:", err.response?.data || err.message);
  }
}

// ---------- Shopify webhook: orders/create ----------

App.post(
  "/webhooks/orders-create",
  Express.raw({ type: "application/json" }),
  async (req, res) => {
    Const hmacHeader = req.get("X-Shopify-Hmac-Sha256") || "";
    Const secret = (SHOPIFY_API_SECRET || "").trim();
    Const digest = crypto
      .createHmac("sha256", secret)
      .update(req.body)
      .digest("base64");

    Const a = Buffer.from(digest);
    Const b = Buffer.from(hmacHeader);
    Const valid = a.length === b.length && crypto.timingSafeEqual(a, b);

    If (!valid) {
      Console.warn(
        `Invalid Shopify HMAC | secret length: ${secret.length} | header present: ${hmacHeader.length > 0}`
      );
      Return res.status(401).send("Unauthorized");
    }

    Res.status(200).send("OK");

    Try {
      Const order = JSON.parse(req.body.toString("utf8"));
      If (processedOrders.has(order.id)) return;
      ProcessedOrders.add(order.id);

      Const phone = cleanPhone(
        Order.shipping_address?.phone ||
          Order.phone ||
          Order.customer?.phone ||
          Order.billing_address?.phone
      );
      If (!phone) {
        Console.warn(`Order ${order.name}: valid phone nahi mila`);
        Await addTags(order.id, ["wa-no-phone"]);
        Return;
      }

      // AI Address Validation Check
      Const rawAddr = formatAddress(order.shipping_address);
      Let addressWarning = "";
      If (GEMINI_API_KEY) {
        Const aiPrompt = `Analyze this e-commerce shipping address: "${rawAddr}". Check if there are dummy entries like "123" for house numbers or severe State/Pincode mismatch. If everything is fine, reply with "OK". If there is a clear error or fake data, reply with a short warning in Hindi/English under 15 words.`;
        Const aiRes = await askGemini(aiPrompt);
        If (aiRes && !aiRes.trim().toUpperCase().startsWith("OK")) {
          AddressWarning = `\n⚠️ Note: ${aiRes.trim()}`;
        }
      }

      Const customerName = cleanText(
        Order.shipping_address?.first_name || order.customer?.first_name || "Customer",
        60
      );

      Const items = cleanText(
        (order.line_items || [])
          .map((i) => {
            Const v =
              I.variant_title && i.variant_title !== "Default Title"
                ? ` - ${i.variant_title}`
                : "";
            Return `${i.quantity}x ${i.title}${v}`;
          })
          .join(", "),
        300
      );

      Const imageUrl = await getProductImage(order.line_items?.[0]?.product_id);

      Const components = [
        {
          Type: "body",
          Parameters: [
            { type: "text", text: customerName },
            { type: "text", text: String(order.name) },
            { type: "text", text: items || "-" },
            { type: "text", text: formatTotal(order) },
            { type: "text", text: rawAddr + addressWarning },
          ],
        },
        {
          Type: "button",
          Sub_type: "quick_reply",
          Index: "0",
          Parameters: [{ type: "payload", payload: `CONFIRM_${order.id}` }],
        },
        {
          Type: "button",
          Sub_type: "quick_reply",
          Index: "1",
          Parameters: [{ type: "payload", payload: `CANCEL_${order.id}` }],
        },
      ];

      If (imageUrl) {
        Components.unshift({
          Type: "header",
          Parameters: [{ type: "image", image: { link: imageUrl } }],
        });
      }

      Const waRes = await sendWhatsApp({
        To: phone,
        Type: "template",
        Template: {
          Name: TEMPLATE_NAME,
          Language: { code: TEMPLATE_LANG },
          Components,
        },
      });

      Console.log("Meta response:", JSON.stringify(waRes.data));
      Await addTags(order.id, ["wa-pending"]);
      Console.log(`Order ${order.name}: WhatsApp bhej diya -> ${phone}`);
    } catch (err) {
      Console.error("orders-create error:", err.response?.data || err.message);
    }
  }
);

App.use(express.json());
App.use(express.urlencoded({ extended: false }));

// ---------- Meta webhook: verify ----------
app.get("/webhook", (req, res) => {
  Const mode = req.query["hub.mode"];
  Const token = req.query["hub.verify_token"];
  Const challenge = req.query["hub.challenge"];
  If (mode === "subscribe" && token === VERIFY_TOKEN) {
    Return res.status(200).send(challenge);
  }
  Res.sendStatus(403);
});

// ---------- Meta webhook: customer replies + delivery status ----------
app.post("/webhook", async (req, res) => {
  Res.sendStatus(200);

  Try {
    Const entries = req.body?.entry || [];
    For (const entry of entries) {
      For (const change of entry.changes || []) {
        For (const st of change.value?.statuses || []) {
          Console.log("STATUS:", st.status, JSON.stringify(st.errors || ""));
        }

        Const messages = change.value?.messages || [];
        For (const msg of messages) {
          Const profileName = (change.value?.contacts || []).find(
            (c) => c.wa_id === msg.from
          )?.profile?.name;
          Const textContent = describeMessage(msg);
          AddMessage(msg.from, "in", textContent, profileName);

          Let payload = null;
          If (msg.type === "button") payload = msg.button?.payload;
          If (msg.type === "interactive") payload = msg.interactive?.button_reply?.id;
          
          If (payload) {
            Const [action, orderId] = String(payload).split("_");
            If (!orderId) continue;

            If (action === "CONFIRM") {
              Await addTags(orderId, ["wa-confirmed"]);
              Await removeTags(orderId, ["wa-pending", "wa-cancelled"]);
              Await sendText(
                Msg.from,
                "Thanks! 🙏✅ Aapka order confirm ho gaya hai.\n\nHum jaldi hi ise dispatch karenge 🚚\nBazoora chunne ke liye dhanyavaad 😊"
              );
            } else if (action === "CANCEL") {
              Await addTags(orderId, ["wa-cancelled"]);
              Await removeTags(orderId, ["wa-pending", "wa-confirmed"]);
              Await sendText(
                Msg.from,
                "Hello! 🙏 Aapka cancel request humne note kar liya hai, aur hamari team jaldi ise process kar degi 😊\n\nUmeed hai future mein hum aapki seva kar paayenge 🛍️✨\nBazoora chunne ke liye Thank you! ❤️"
              );
            }
            Console.log(`Reply: ${action} order ${orderId}`);
          } else if (msg.type === "text" && GEMINI_API_KEY) {
            // Agar customer ne normal text message bheja hai toh AI auto-reply karega
            Const userText = msg.text?.body || "";
            Const prompt = `You are a helpful customer support chatbot for an e-commerce brand named Bazoora. Reply politely in Hinglish/Hindi to the customer query: "${userText}". Keep it short, friendly, and helpful.`;
            Const aiReply = await askGemini(prompt);
            If (aiReply) {
              Await sendText(msg.from, aiReply.trim());
              AddMessage(msg.from, "out", aiReply.trim());
            }
          }
        }
      }
    }
  } catch (err) {
    Console.error("webhook POST error:", err.response?.data || err.message);
  }
});

// ---------- Inbox page ----------

Function inboxAuth(req, res) {
  Const key = req.query.key || req.body?.key;
  If (!INBOX_SECRET || key !== INBOX_SECRET) {
    Res.status(403).send("Forbidden");
    Return null;
  }
  Return key;
}

Function page(title, body) {
  Return `<!doctype html><html><head><meta charset="utf-8">
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

App.get("/inbox", (req, res) => {
  Const key = inboxAuth(req, res);
  If (!key) return;
  Const k = encodeURIComponent(key);
  Const phone = req.query.c;

  If (!phone) {
    Const list = [...conversations.entries()]
      .map(([p, c]) => ({ p, c, last: c.messages[c.messages.length - 1] }))
      .filter((x) => x.last)
      .sort((a, b) => b.last.time - a.last.time);
    Const items = list.length
      ? list
          .map(
            (x) => `<a class="card" href="/inbox?key=${k}&c=${encodeURIComponent(x.p)}">
<b>${esc(x.c.name || "Customer")}</b> (+${esc(x.p)})
<small>${x.last.dir === "in" ? "" : "Aap: "}${esc(x.last.text.slice(0, 60))}</small>
<small>${fmtTime(x.last.time)}</small></a>`
          )
          .join("")
      : `<div class="card">Abhi koi message nahi aaya.</div>`;
    Return res.send(
      Page(
        "Bazoora Inbox",
        `<div class="top">Bazoora Inbox</div><div class="wrap">${items}</div>`
      )
    );
  }

  Const c = conversations.get(phone);
  If (!c)
    Return res
      .status(404)
      .send(page("Inbox", `<div class="wrap">Chat nahi mili. <a href="/inbox?key=${k}">Wapas</a></div>`));

  Const lastIn = [...c.messages].reverse().find((m) => m.dir === "in");
  Const within24 = lastIn && Date.now() - lastIn.time < 24 * 3600 * 1000;
  Const bubbles = c.messages
    .map((m) => `<div class="msg ${m.dir}">${esc(m.text)}<small>${fmtTime(m.time)}</small></div>`)
    .join("");
  Const err = req.query.err ? `<div class="err">Reply nahi gaya: ${esc(req.query.err)}</div>` : "";
  Const warn = within24
    ? ""
    : `<div class="warn">Customer ke aakhri message ko 24 ghante se zyada ho gaye. Reply shayad na jaye.</div>`;

  Res.send(
    Page(
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

App.post("/inbox/reply", async (req, res) => {
  Const key = inboxAuth(req, res);
  If (!key) return;
  Const k = encodeURIComponent(key);
  Const phone = String(req.body.phone || "");
  Const text = String(req.body.text || "").trim();
  If (!phone || !text) return res.redirect(303, `/inbox?key=${k}`);

  Try {
    Await sendWhatsApp({ to: phone, type: "text", text: { body: text } });
    AddMessage(phone, "out", text);
    Res.redirect(303, `/inbox?key=${k}&c=${encodeURIComponent(phone)}`);
  } catch (err) {
    Const e = err.response?.data?.error;
    Const msg = e ? `${e.code}: ${e.message}` : err.message;
    Console.error("inbox reply error:", msg);
    Res.redirect(
      303,
      `/inbox?key=${k}&c=${encodeURIComponent(phone)}&err=${encodeURIComponent(msg)}`
    );
  }
});

// ---------- Delivery reminder (roz cron-job.org se chalega) ----------

async function runReminders() {
  If (reminderRunning) {
    Console.log("Reminder check pehle se chal raha hai, ye skip");
    Return;
  }
  ReminderRunning = true;

  Try {
    Const since = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    Const search = `fulfillment_status:fulfilled -tag:wa-reminded -tag:wa-cancelled created_at:>=${since}`;
    Const q = `query($q: String!) {
      Orders(first: 200, query: $q) {
        Nodes {
          LegacyResourceId
          Name
          Phone
          Customer { firstName phone }
          ShippingAddress { firstName name address1 address2 city province zip phone }
          Fulfillments(first: 5) {
            CreatedAt
            TrackingInfo {
              Url
              Number
            }
          }
        }
      }
    }`;

    Const data = await shopifyGraphQL(q, { q: search });
    Const orders = data?.data?.orders?.nodes || [];
    Console.log(`Reminder check: ${orders.length} fulfilled order(s) mile (REMINDER_DAYS=${REMINDER_DAYS})`);

    For (const o of orders) {
      Const orderId = o.legacyResourceId;
      If (remindedOrders.has(orderId)) continue;

      Const fulfillments = o.fulfillments || [];
      Const times = fulfillments.map((f) => new Date(f.createdAt).getTime());
      If (!times.length) continue;
      Const days = (Date.now() - Math.min(...times)) / 86400000;
      If (days < REMINDER_DAYS) continue;

      Const phone = cleanPhone(
        O.shippingAddress?.phone || o.phone || o.customer?.phone
      );
      If (!phone) {
        Console.warn(`Reminder ${o.name}: phone nahi mila`);
        RemindedOrders.add(orderId);
        Await addTags(orderId, ["wa-reminded", "wa-no-phone"]);
        Continue;
      }

      // Shopify fulfillment se tracking URL detect karna
      Const validFulfillment = fulfillments.find((f) => f.trackingInfo && f.trackingInfo.url);
      Const trackingUrl = validFulfillment?.trackingInfo?.url || "Tracking link available nahi";

      RemindedOrders.add(orderId);
      Try {
        Const name = cleanText(
          O.shippingAddress?.firstName || o.customer?.firstName || "Customer",
          60
        );
        Const waRes = await sendWhatsApp({
          To: phone,
          Type: "template",
          Template: {
            Name: REMINDER_TEMPLATE,
            Language: { code: REMINDER_LANG },
            Components: [
              {
                Type: "body",
                Parameters: [
                  { type: "text", text: name },
                  { type: "text", text: String(o.name) },
                  { type: "text", text: formatAddress(o.shippingAddress) },
                  { type: "text", text: trackingUrl },
                ],
              },
            ],
          },
        });
        Console.log("Reminder Meta response:", JSON.stringify(waRes.data));
        Await addTags(orderId, ["wa-reminded"]);
        Console.log(`Reminder bheja: ${o.name} -> ${phone}`);
      } catch (err) {
        RemindedOrders.delete(orderId);
        Console.error(`Reminder error ${o.name}:`, JSON.stringify(err.response?.data || err.message));
      }
    }
  } finally {
    ReminderRunning = false;
  }
}

App.get("/cron/reminders", (req, res) => {
  If (!CRON_SECRET || req.query.key !== CRON_SECRET) {
    Return res.status(403).send("Forbidden");
  }
  Res.status(200).send("Reminder check shuru ho gaya");
  RunReminders().catch((err) => {
    ReminderRunning = false;
    Console.error("runReminders error:", err.response?.data || err.message);
  });
});

// ---------- Health check ----------
app.get("/", (req, res) => res.send("Bazoora WhatsApp bot chal raha hai ✅"));

app.listen(PORT, () => console.log(`Server port ${PORT} par chal raha hai`));
