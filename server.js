const express = require('express');
const axios = require('axios');
const app = express();

app.use(express.json());

// Main App Route
app.get('/', (req, res) => {
  res.send('WhatsApp Order Automation is Active!');
});

// 1. Meta Webhook Verification (GET Route) - YE NAYA ADD HUAA HAI
app.get('/api/webhooks/orders-create', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
    console.log('Meta Webhook Verified Successfully!');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// 2. Shopify Webhook Endpoint (Order Creation - POST Route)
app.post('/api/webhooks/orders-create', async (req, res) => {
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
  } code (error) {
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
