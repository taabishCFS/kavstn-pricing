const express = require('express');
const app = express();
app.use(express.json());

app.post('/price', (req, res) => {
  // Stage 5: full pricing logic goes here
  res.json({ total: 0, breakdown: {} });
});

app.listen(process.env.PORT || 3000);