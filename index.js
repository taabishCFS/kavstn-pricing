/**
 * KAVSTN Pricing API — server.js
 * ════════════════════════════════════════════════════════════
 * Hosted on Render.com. Auto-deploys when pushed to GitHub.
 *
 * Endpoint: POST /price
 *
 * HOW PRICING WORKS:
 *  1. The Shopify section reads all prices from metaobjects
 *  2. It sends those prices here (not just IDs)
 *  3. We calculate area, apply rates, sum adjustments, add VAT
 *  4. Return { total, subtotal, vat, breakdown }
 *
 * This keeps things simple — no Shopify API calls needed here.
 *
 * TO DEPLOY: push this file to your GitHub repo.
 * Render will auto-redeploy within ~60 seconds.
 * ════════════════════════════════════════════════════════════
 */

const express = require('express');
const cors    = require('cors');

const app  = express();
const PORT = process.env.PORT || 3000;

// Allow requests from any origin (your Shopify storefront)
app.use(cors());
app.use(express.json());


// ── Health check ─────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    service: 'KAVSTN Pricing API',
    version: '1.0.0',
    status:  'running',
  });
});


// ── POST /price ───────────────────────────────────────────────
/**
 * Expected request body:
 * {
 *   shape:                  "rectangle" | "oval" | "round" | "square" | "racetrack"
 *   width_mm:               number   (not needed for pure circles)
 *   depth_mm:               number   (not needed for pure circles)
 *   diameter_mm:            number   (only for round shape)
 *
 *   material_base_price:    number   (from table_material.base_price)
 *   material_price_per_sqm: number   (from table_material.price_per_sqm)
 *
 *   base_material_adj:      number   (from base_material.price_adjustment)
 *   mat_finish_adj:         number   (from material_finish.price_adjustment)
 *   edge_adj:               number   (from edge_profile.price_adjustment)
 *   thickness_adj:          number   (from table_thickness.price_adjustment)
 *   surface_adj:            number   (from surface_treatment.price_adjustment)
 *   base_finish_adj:        number   (from base_finish.price_adjustment)
 * }
 */
app.post('/price', (req, res) => {

  const {
    shape         = 'rectangle',
    width_mm,
    depth_mm,
    diameter_mm,

    // Material pricing (loaded from Shopify metaobjects by the Liquid section)
    material_base_price    = 0,
    material_price_per_sqm = 0,

    // Price adjustments from each step's selection
    base_material_adj = 0,
    mat_finish_adj    = 0,
    edge_adj          = 0,
    thickness_adj     = 0,
    surface_adj       = 0,
    base_finish_adj   = 0,
  } = req.body;


  // ── STEP 1: Calculate table top surface area ──────────────
  //
  //  Different shapes use different area formulas:
  //    Rectangle / Square / Racetrack  →  W × D
  //    Oval                            →  π × (W/2) × (D/2)
  //    Round (circle)                  →  π × r²
  //
  let area_sqm = 0;

  if (shape === 'round' && diameter_mm) {
    // Circle: π × radius²
    const radius_m = (Number(diameter_mm) / 2) / 1000;
    area_sqm = Math.PI * radius_m * radius_m;

  } else if (shape === 'oval' && width_mm && depth_mm) {
    // Ellipse: π × semi-major × semi-minor
    const a = (Number(width_mm)  / 2) / 1000;
    const b = (Number(depth_mm) / 2) / 1000;
    area_sqm = Math.PI * a * b;

  } else if (width_mm && depth_mm) {
    // Rectangle, Square, Racetrack — simple W × D
    area_sqm = (Number(width_mm) / 1000) * (Number(depth_mm) / 1000);
  }

  // Round area to 3 decimal places
  area_sqm = Math.round(area_sqm * 1000) / 1000;


  // ── STEP 2: Top material cost ─────────────────────────────
  //
  //  Cost = base price + (price per sqm × area)
  //  Example: base £2200 + (£800/sqm × 1.8sqm) = £3640
  //
  const top_material_cost =
    Number(material_base_price) +
    (Number(material_price_per_sqm) * area_sqm);


  // ── STEP 3: Sum all option price adjustments ──────────────
  const adjustments =
    Number(base_material_adj) +
    Number(mat_finish_adj)    +
    Number(edge_adj)          +
    Number(thickness_adj)     +
    Number(surface_adj)       +
    Number(base_finish_adj);


  // ── STEP 4: Subtotal (ex. VAT) ────────────────────────────
  const subtotal = top_material_cost + adjustments;


  // ── STEP 5: VAT ───────────────────────────────────────────
  //
  //  ⚠️  TODO: Confirm VAT treatment before going live.
  //  Currently set to 20% UK standard rate.
  //  Options to discuss with accountant:
  //    - Show price inc. VAT (standard B2C)
  //    - Show price ex. VAT + VAT line (B2B / trade)
  //    - Show both
  //
  const VAT_RATE = 0.20;
  const vat      = subtotal * VAT_RATE;
  const total    = subtotal + vat;


  // ── STEP 6: Round all figures to 2 decimal places ─────────
  const round2 = (n) => Math.round(n * 100) / 100;


  // ── STEP 7: Return result ─────────────────────────────────
  return res.json({
    total:    round2(total),
    subtotal: round2(subtotal),
    vat:      round2(vat),

    // Breakdown shown in the summary step of the configurator
    breakdown: {
      area_sqm,
      top_material:  round2(top_material_cost),
      adjustments: {
        base_material:     round2(Number(base_material_adj)),
        material_finish:   round2(Number(mat_finish_adj)),
        edge_profile:      round2(Number(edge_adj)),
        thickness:         round2(Number(thickness_adj)),
        surface_treatment: round2(Number(surface_adj)),
        base_finish:       round2(Number(base_finish_adj)),
      },
      subtotal:  round2(subtotal),
      vat_rate:  `${VAT_RATE * 100}%`,
      vat:       round2(vat),
      total:     round2(total),
    },
  });

});


// ── Start server ──────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`KAVSTN Pricing API running on port ${PORT}`);
});