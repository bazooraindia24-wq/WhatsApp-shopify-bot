const express = require("express");
const crypto = require("crypto");
const axios = require("axios");

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
} = process.env;

const SHOPIFY_API_VERSION = "2025-01";
const GRAPH_VERSION = "v21.0";
const TEMPLATE_NAME = "order_confirmation";
const TEMPLATE_LANG = "en";

// Shopify retry kare to dobara message na jaye
const processedOrders = new Set();

// ---------- Helpers ----------

function cleanPhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, "");
  if (digits.length < 10) return null;
  return "91" + digits.slice(-10);
}

// WhatsApp template param me newline/tab/4+ spaces allowed nahi
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

// Shopify token khud fetch hota hai (client credentials), 24 ghante me expire hota hai
let cachedToken = null;
let tokenExpiresAt = 0;

async function getShopifyToken() {
  const clientSecret = (SHOPIFY_CLIENT_SECRET || "").trim();
  // Agar client secret set nahi hai to purana SHOPIFY_ACCESS_TOKEN use hoga
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
  const errors = res.data?.errors || res.data?.data?.tagsAdd?.userErrors;
  if (errors && errors.length) console.error("Shopify GraphQL issue:", JSON.stringify(errors));
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
// Raw body zaroori hai HMAC ke liye, isliye express.json() se PEHLE

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

    // Shopify ko turant 200 do, kaam baad me
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
        (order.line_items || []).map((i) => `${i.quantity}x ${i.title}`).join(", "),
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

      await sendWhatsApp({
        to: phone,
        type: "template",
        template: {
          name: TEMPLATE_NAME,
          language: { code: TEMPLATE_LANG },
          components,
        },
      });

      await addTags(order.id, ["wa-pending"]);
      console.log(`Order ${order.name}: WhatsApp bhej diya -> ${phone}`);
    } catch (err) {
      console.error("orders-create error:", err.response?.data || err.message);
    }
  }
);

// ---------- Baaki routes JSON use karenge ----------
app.use(express.json());

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

// ---------- Meta webhook: customer replies ----------
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const entries = req.body?.entry || [];
    for (const entry of entries) {
      for (const change of entry.changes || []) {
        const messages = change.value?.messages || [];
        for (const msg of messages) {
          let payload = null;
          if (msg.type === "button") payload = msg.button?.payload;
          if (msg.type === "interactive") payload = msg.interactive?.button_reply?.id;
          if (!payload) continue; // normal chat Business Suite Inbox me handle hogi

          const [action, orderId] = String(payload).split("_");
          if (!orderId) continue;

          if (action === "CONFIRM") {
            await addTags(orderId, ["wa-confirmed"]);
            await removeTags(orderId, ["wa-pending", "wa-cancelled"]);
            await sendText(msg.from, "Shukriya! ✅ Aapka order confirm ho gaya hai. Jaldi hi dispatch karenge.");
          } else if (action === "CANCEL") {
            await addTags(orderId, ["wa-cancelled"]);
            await removeTags(orderId, ["wa-pending", "wa-confirmed"]);
            await sendText(msg.from, "Theek hai, aapka cancel request mil gaya hai. Hamari team jaldi aapse sampark karegi.");
          }
          console.log(`Reply: ${action} order ${orderId}`);
        }
      }
    }
  } catch (err) {
    console.error("webhook POST error:", err.response?.data || err.message);
  }
});

// ---------- Health check (pinger ke liye) ----------
app.get("/", (req, res) => res.send("Bazoora WhatsApp bot chal raha hai ✅"));

app.listen(PORT, () => console.log(`Server port ${PORT} par chal raha hai`));
        
