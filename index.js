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

let cachedAdminToken = null;
let adminTokenExpiresAt = 0;

async function getShopifyAdminToken() {
  if (
    cachedAdminToken &&
    Date.now() < adminTokenExpiresAt - 60_000
  ) {
    return cachedAdminToken;
  }

  const shop = process.env.SHOPIFY_STORE_DOMAIN;
  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;

  if (!shop || !clientId || !clientSecret) {
    throw new Error(
      'Missing SHOPIFY_STORE_DOMAIN, SHOPIFY_CLIENT_ID or SHOPIFY_CLIENT_SECRET'
    );
  }

  const response = await fetch(
    `https://${shop}/admin/oauth/access_token`,
    {
      method: 'POST',

      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded'
      },

      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret
      })
    }
  );

  const responseText = await response.text();

  if (!response.ok) {
    throw new Error(
      `Shopify token request failed (${response.status}): ${responseText}`
    );
  }

  let data;

  try {
    data = JSON.parse(responseText);
  } catch {
    throw new Error(
      `Shopify returned a non-JSON token response: ${responseText.slice(0, 300)}`
    );
  }

  if (!data.access_token) {
    throw new Error(
      `Shopify did not return an access token: ${responseText}`
    );
  }

  cachedAdminToken = data.access_token;

  adminTokenExpiresAt =
    Date.now() + (Number(data.expires_in) || 86400) * 1000;

  return cachedAdminToken;
}

app.get('/auth/status', async (req, res) => {
  try {
    await getShopifyAdminToken();

    return res.json({
      authenticated: true,
      token_cached: Boolean(cachedAdminToken),
      expires_at: new Date(adminTokenExpiresAt).toISOString()
    });

  } catch (error) {
    console.error('[SHOPIFY AUTH TEST]', error);

    return res.status(500).json({
      authenticated: false,
      error: error.message
    });
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
  const numericPrice = Number(req.body.price);

  if (!Number.isFinite(numericPrice) || numericPrice <= 0) {
    return res.status(400).json({
      error: 'A valid positive price is required'
    });
  }

  const shop = process.env.SHOPIFY_STORE_DOMAIN;
  const productId = process.env.SHOPIFY_PRODUCT_ID;
  const variantId = process.env.SHOPIFY_VARIANT_ID;

  if (!shop || !productId || !variantId) {
    return res.status(500).json({
      error:
        'Missing SHOPIFY_STORE_DOMAIN, SHOPIFY_PRODUCT_ID or SHOPIFY_VARIANT_ID'
    });
  }

  try {
    const token = await getShopifyAdminToken();

    const query = `
      mutation UpdateConfiguredVariantPrice(
        $productId: ID!
        $variants: [ProductVariantsBulkInput!]!
      ) {
        productVariantsBulkUpdate(
          productId: $productId
          variants: $variants
        ) {
          productVariants {
            id
            price
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const response = await fetch(
      `https://${shop}/admin/api/2026-07/graphql.json`,
      {
        method: 'POST',

        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': token
        },

        body: JSON.stringify({
          query,

          variables: {
            productId: `gid://shopify/Product/${productId}`,

            variants: [
              {
                id: `gid://shopify/ProductVariant/${variantId}`,
                price: numericPrice.toFixed(2)
              }
            ]
          }
        })
      }
    );

    const responseText = await response.text();

    if (!response.ok) {
      throw new Error(
        `Shopify Admin API returned ${response.status}: ${responseText}`
      );
    }

    let data;

    try {
      data = JSON.parse(responseText);
    } catch {
      throw new Error(
        `Shopify returned invalid JSON: ${responseText.slice(0, 300)}`
      );
    }

    if (data.errors?.length) {
      return res.status(400).json({
        error: 'Shopify GraphQL error',
        details: data.errors
      });
    }

    const result = data.data?.productVariantsBulkUpdate;
    const userErrors = result?.userErrors || [];

    if (userErrors.length) {
      return res.status(400).json({
        error: 'Shopify rejected the price update',
        details: userErrors
      });
    }

    const updatedVariant = result?.productVariants?.[0];

    return res.json({
      success: true,
      variant_id: updatedVariant?.id,
      price: updatedVariant?.price
    });

  } catch (error) {
    console.error('[KAVSTN SET PRICE]', error);

    return res.status(500).json({
      error: error.message
    });
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