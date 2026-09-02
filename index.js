/**
 * KAVSTN Pricing API — server.js
 * ════════════════════════════════════════════════════════════
 * Hosted on Render.com. Push to GitHub to auto-deploy.
 *
 * Endpoints:
 *   GET  /                    Health check
 *   POST /price               Calculate price from configuration
 *   POST /auth/exchange-token Exchange shpss_ → shpat_ (run ONCE)
 *   POST /set-price           Update Shopify variant price before cart
 *
 * REQUIRED ENVIRONMENT VARIABLES ON RENDER:
 *   SHOPIFY_STORE_DOMAIN   e.g. kavstn.myshopify.com
 *   SHOPIFY_API_KEY        from your Shopify app (API key)
 *   SHOPIFY_API_SECRET     from your Shopify app (API secret key)
 *   SHOPIFY_ADMIN_TOKEN    shpat_xxxx — filled in AFTER running /auth/exchange-token once
 *   SHOPIFY_VARIANT_ID     57237357494438
 * ════════════════════════════════════════════════════════════
 */

const express = require('express');
const cors    = require('cors');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());


// ── Health check ──────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    service: 'KAVSTN Pricing API',
    version: '2.0.0',
    status:  'running',
  });
});


// ── POST /auth/exchange-token ─────────────────────────────────
/**
 * ONE-TIME SETUP ONLY — run this once to get your shpat_ token.
 *
 * Shopify now issues shpss_ (session tokens) instead of shpat_ directly.
 * This endpoint exchanges the shpss_ for a permanent offline shpat_ token.
 *
 * HOW TO USE:
 *   1. Get your shpss_ token from Shopify (shown after creating the custom app)
 *   2. POST to https://kavstn-pricing.onrender.com/auth/exchange-token
 *      Body: { "shop": "kavstn.myshopify.com", "session_token": "shpss_xxxx" }
 *   3. Copy the returned access_token (shpat_xxxx)
 *   4. Add it to Render env vars as SHOPIFY_ADMIN_TOKEN
 *   5. You never need to run this again
 *
 * curl example:
 *   curl -X POST https://kavstn-pricing.onrender.com/auth/exchange-token \
 *        -H "Content-Type: application/json" \
 *        -d '{"shop":"kavstn.myshopify.com","session_token":"shpss_xxxx"}'
 */
app.post('/auth/exchange-token', async (req, res) => {
  const { shop, session_token } = req.body;

  if (!shop || !session_token) {
    return res.status(400).json({ error: 'shop and session_token are required' });
  }

  try {
    const response = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id:     process.env.SHOPIFY_API_KEY,
        client_secret: process.env.SHOPIFY_API_SECRET,

        // Token exchange grant — converts shpss_ into a permanent offline shpat_
        grant_type:           'urn:ietf:params:oauth:grant-type:token-exchange',
        subject_token:        session_token,
        subject_token_type:   'urn:ietf:params:oauth:token-type:id_token',
        requested_token_type: 'urn:shopify:params:oauth:token-type:offline-access-token',
      }),
    });

    const data = await response.json();

    if (!response.ok || !data.access_token) {
      return res.status(400).json({
        error:   'Token exchange failed',
        details: data,
      });
    }

    // Return the shpat_ token — copy this to Render env var SHOPIFY_ADMIN_TOKEN
    return res.json({
      success:      true,
      access_token: data.access_token,
      scope:        data.scope,
      instruction:  'Add access_token to Render env vars as SHOPIFY_ADMIN_TOKEN. Do not call this endpoint again.',
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});


// ── POST /set-price ───────────────────────────────────────────
/**
 * Called by the configurator just before "Add to Cart".
 * Updates the Shopify product variant price so the cart and
 * checkout show the real configured price, not £0.
 *
 * Body: { "price": 3640.00 }
 *
 * NOTE: For a bespoke furniture brand with low order volume,
 * race conditions are not a concern. If you later have concurrent
 * orders, consider switching to Draft Orders instead.
 *
 * NOTE on VAT: Shopify uses the price you set here as-is.
 * If your store has "Prices include tax" ON → set the inc-VAT price.
 * If "Prices include tax" OFF → set the ex-VAT price (Shopify adds tax).
 * Check: Shopify Admin → Settings → Taxes → "Include tax in prices".
 */
app.post('/set-price', async (req, res) => {
  const { price } = req.body;

  if (!price || isNaN(price)) {
    return res.status(400).json({ error: 'price (number) is required' });
  }

  const shop      = process.env.SHOPIFY_STORE_DOMAIN;
  const token     = process.env.SHOPIFY_ADMIN_TOKEN;
  const variantId = process.env.SHOPIFY_VARIANT_ID;

  if (!shop || !token || !variantId) {
    return res.status(500).json({
      error: 'Missing env vars: SHOPIFY_STORE_DOMAIN, SHOPIFY_ADMIN_TOKEN, or SHOPIFY_VARIANT_ID',
    });
  }

  try {
    const response = await fetch(
      `https://${shop}/admin/api/2024-10/variants/${variantId}.json`,
      {
        method:  'PUT',
        headers: {
          'Content-Type':          'application/json',
          'X-Shopify-Access-Token': token,
        },
        body: JSON.stringify({
          variant: {
            id:    variantId,
            price: parseFloat(price).toFixed(2),
          },
        }),
      }
    );

    const data = await response.json();

    if (!response.ok || !data.variant) {
      return res.status(response.status).json({
        error:   'Shopify API error',
        details: data,
      });
    }

    return res.json({
      success: true,
      price:   data.variant.price,
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});


// ── POST /price ───────────────────────────────────────────────
/**
 * Calculates the table price from the configuration.
 * All price data is sent from the Liquid section (read from metaobjects).
 *
 * Body: {
 *   shape, width_mm, depth_mm, diameter_mm,
 *   material_base_price, material_price_per_sqm,
 *   base_material_adj, mat_finish_adj, edge_adj,
 *   thickness_adj, surface_adj, base_finish_adj
 * }
 */
app.post('/price', (req, res) => {
  const {
    shape          = 'rectangle',
    width_mm, depth_mm, diameter_mm,
    material_base_price    = 0,
    material_price_per_sqm = 0,
    base_material_adj = 0,
    mat_finish_adj    = 0,
    edge_adj          = 0,
    thickness_adj     = 0,
    surface_adj       = 0,
    base_finish_adj   = 0,
  } = req.body;

  // 1. Calculate area in sqm
  let area_sqm = 0;
  if (shape === 'round' && diameter_mm) {
    const r = (Number(diameter_mm) / 2) / 1000;
    area_sqm = Math.PI * r * r;
  } else if (shape === 'oval' && width_mm && depth_mm) {
    const a = (Number(width_mm)  / 2) / 1000;
    const b = (Number(depth_mm) / 2) / 1000;
    area_sqm = Math.PI * a * b;
  } else if (width_mm && depth_mm) {
    area_sqm = (Number(width_mm) / 1000) * (Number(depth_mm) / 1000);
  }
  area_sqm = Math.round(area_sqm * 1000) / 1000;

  // 2. Material cost
  const top_material_cost =
    Number(material_base_price) + (Number(material_price_per_sqm) * area_sqm);

  // 3. Adjustments
  const adjustments =
    Number(base_material_adj) + Number(mat_finish_adj) + Number(edge_adj) +
    Number(thickness_adj) + Number(surface_adj) + Number(base_finish_adj);

  // 4. Subtotal + VAT
  const subtotal = top_material_cost + adjustments;
  const VAT_RATE = 0.20;
  const vat      = subtotal * VAT_RATE;
  const total    = subtotal + vat;

  const round2 = n => Math.round(n * 100) / 100;

  return res.json({
    total:    round2(total),
    subtotal: round2(subtotal),
    vat:      round2(vat),
    breakdown: {
      area_sqm,
      top_material: round2(top_material_cost),
      adjustments: {
        base_material:     round2(Number(base_material_adj)),
        material_finish:   round2(Number(mat_finish_adj)),
        edge_profile:      round2(Number(edge_adj)),
        thickness:         round2(Number(thickness_adj)),
        surface_treatment: round2(Number(surface_adj)),
        base_finish:       round2(Number(base_finish_adj)),
      },
      subtotal:  round2(subtotal),
      vat_rate: `${VAT_RATE * 100}%`,
      vat:       round2(vat),
      total:     round2(total),
    },
  });
});


// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`KAVSTN Pricing API running on port ${PORT}`);
});