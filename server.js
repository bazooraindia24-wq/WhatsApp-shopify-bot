const express = require('express');
const axios = require('axios');
const app = express();

app.use(express.json());

const {
  SHOPIFY_API_KEY,
  SHOPIFY_API_SECRET,
  SHOPIFY_STORE,
  VERIFY_TOKEN
} = process.env;

// Main App Route
app.get('/', (req, res) => {
  res.send('WhatsApp Order Automation is Active!');
});

// STEP A: Start OAuth - Shopify se auth shuru karna
app.get('/auth', (req, res) => {
  const scopes = 'read_orders,write_orders,read_customers,read_products,read_fulfillments,write_fulfillments';
  const redirectUri = `https://${req.get('host')}/auth/callback`;
  const installUrl = `https://${SHOPIFY_STORE}/admin/oauth/authorize?client_id=${SHOPIFY_API_KEY}&scope=${scopes}&redirect_uri=${redirectUri}`;
  res.redirect(installUrl);
});

// STEP B: Callback - yaha token milega
app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;

  if (!code) {
    return res.status(400).send('Missing code');
  }

  try {
    const tokenResponse = await axios.post(`https://${SHOPIFY_STORE}/admin/oauth/access_token`, {
      client_id: SHOPIFY_API_KEY,
      client_secret: SHOPIFY_API_SECRET,
      code: code
    });

    const accessToken = tokenResponse.data.access_token;

    console.log('=================================');
    console.log('ACCESS TOKEN:', accessToken);
    console.log('=================================');

    res.send(`App installed successfully! Access Token: ${accessToken} (isko copy karke apne pass safe rakh lein)`);
  } catch (error) {
    console.error('OAuth Error:', error.response ? error.response.data : error.message);
    res.status(500).send('OAuth failed: ' + (error.response ? JSON.stringify(error.response.data) : error.message));
  }
});

// Meta Webhook Verification (GET Route)
app.get('/api/webhooks', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Meta Webhook Verified Successfully!');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// Shopify Webhook Endpoint (Order Creation - POST Route)
app.post('/api/webhooks', async (req, res) => {
  try {
    const order = req.body;
    const customerPhone = order.phone || (order.shipping_address && order.shipping_address.phone);
    const customerName = order.customer ? order.customer.first_name : 'Customer';
    const orderId = order.name;
    const totalPrice = order.total_price;

    console.log(`New Order Received: ${orderId} for ${customerName}`);

    if (customerPhone) {
      await sendWhatsAppMessage(customerPhone, customerName, orderId, totalPrice);
    }

    res.status(200).send('Webhook Processed');
  } catch (error) {
    console.error('Webhook Error:', error.message);
    res.status(500).send('Error');
  }
});

async function sendWhatsAppMessage(phone, name, orderId, amount) {
  console.log(`Sending WhatsApp message to ${phone}: Hello ${name}, order ${orderId} worth Rs.${amount} confirmed!`);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
