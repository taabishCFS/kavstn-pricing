# KAVESTONE Table Configurator

A server-side pricing and order API for the KAVSTN "Build Your Own Dining Table" Shopify configurator.

Customers build a custom table by choosing shape, size, material, base, finish and edge profile directly on the storefront. This Node.js server validates every selection against Shopify metaobjects, calculates the correct ex-VAT price, and creates or updates a Shopify Draft Order — all server-side, so no price logic lives in the browser.

---

## How it works

```
Browser (Shopify storefront)
  │
  │  POST /verify-and-price   (metaobject IDs + quantity)
  │
  ▼
Node.js API (this repo)
  │
  ├── Fetches metaobjects from Shopify Admin GraphQL
  ├── Validates cross-option compatibility (e.g. base finish ↔ base material)
  ├── Calculates total price from base price + adjustments
  └── Creates / updates a Shopify Draft Order
  │
  ▼
Shopify Admin API
```

**Why server-side?** Prices and compatibility rules live in Shopify metaobjects. Doing the calculation in the browser would expose your pricing logic and allow customers to tamper with values. The server reads the authoritative data and signs the Draft Order, so what the customer sees is always what they actually pay.

---

## Tech stack

- **Runtime:** Node.js 18+
- **Framework:** Express
- **Auth:** Shopify `client_credentials` OAuth (server-to-server, no user token required)
- **Data source:** Shopify Admin GraphQL API (metaobjects)
- **Hosting:** Render (or any Node.js host)
- **Storefront:** Shopify Liquid theme section (`kavstn-table-configurator.liquid`)

---

## Project structure

```
├── index.js                          # Express API server — the entire backend
├── kavstn-table-configurator.liquid  # Shopify theme section (upload to theme)
├── package.json
└── README.md
```

> **Important:** The Liquid file is uploaded manually to the Shopify theme editor. It is never pushed programmatically. See the [Deployment](#deployment) section.

---

## Shopify metaobject types

The configurator reads the following metaobject types from your Shopify store. All must be created in the Shopify admin under **Settings → Custom data → Metaobjects** before the configurator will work.

| Metaobject type      | Purpose                                      |
|----------------------|----------------------------------------------|
| `table_shape`        | Shape options (rectangle, square, round…)    |
| `dimension_preset`   | Size presets per shape (width × depth in mm) |
| `table_material`     | Top surface material options                 |
| `base_design`        | Base frame style options                     |
| `base_material`      | Material the base is made from               |
| `material_finish`    | Finish for the table top                     |
| `edge_profile`       | Edge profile style options                   |
| `table_thickness`    | Top thickness options                        |
| `surface_treatment`  | Surface treatment options                    |
| `base_finish`        | Finish for the base (linked to base_material)|

Each metaobject entry has a `price_adj` field (positive or negative number) that is added to the base price. The `base_finish` type has a `base_material` reference field — the server enforces that the selected base finish is compatible with the selected base material.

---

## Environment variables

Set these on your hosting platform (e.g. Render's Environment tab). **Never commit these to Git.**

| Variable                | Required | Description                                                      |
|-------------------------|----------|------------------------------------------------------------------|
| `SHOPIFY_STORE_DOMAIN`  | ✅        | Your `.myshopify.com` domain, e.g. `u1gvxy-18.myshopify.com`   |
| `SHOPIFY_CLIENT_ID`     | ✅        | Client ID from your Shopify Custom App                           |
| `SHOPIFY_CLIENT_SECRET` | ✅        | Client Secret from your Shopify Custom App                       |
| `ALLOWED_ORIGINS`       | optional | Comma-separated list of allowed CORS origins. Defaults to `https://kavstn.co.uk,https://www.kavstn.co.uk,https://kavstn.myshopify.com` |
| `PORT`                  | optional | Port to listen on. Defaults to `3000`                            |

> **`SHOPIFY_STORE_DOMAIN` must be your originating `.myshopify.com` domain**, not a custom domain alias. The Admin API token endpoint only responds on the `.myshopify.com` URL.

---

## Local development

```bash
# 1. Clone the repo
git clone https://github.com/your-org/kavstn-table-configurator.git
cd kavstn-table-configurator

# 2. Install dependencies
npm install

# 3. Create a .env file (never commit this)
cp .env.example .env
# Fill in your values in .env

# 4. Start the server
node index.js
# Server runs on http://localhost:3000
```

### .env.example

```
SHOPIFY_STORE_DOMAIN=your-store.myshopify.com
SHOPIFY_CLIENT_ID=your_client_id
SHOPIFY_CLIENT_SECRET=your_client_secret
ALLOWED_ORIGINS=http://localhost:3000
```

---

## API endpoints

### `POST /verify-and-price`

Validates a full table configuration, calculates the price, and creates or updates a Draft Order.

**Request body**

```json
{
  "tableShape":        "gid://shopify/Metaobject/123",
  "dimension":         "gid://shopify/Metaobject/456",
  "tableMaterial":     "gid://shopify/Metaobject/789",
  "baseDesign":        "gid://shopify/Metaobject/101",
  "baseMaterial":      "gid://shopify/Metaobject/112",
  "materialFinish":    "gid://shopify/Metaobject/131",
  "edgeProfile":       "gid://shopify/Metaobject/415",
  "tableThickness":    "gid://shopify/Metaobject/161",
  "surfaceTreatment":  "gid://shopify/Metaobject/718",
  "baseFinish":        "gid://shopify/Metaobject/192",
  "quantity":          1,
  "draftOrderId":      null
}
```

All GID values are Shopify metaobject global IDs. `draftOrderId` is `null` on first call; pass the returned ID on subsequent calls to update the existing Draft Order rather than creating a new one.

**Success response — 200**

```json
{
  "ok":          true,
  "totalExVat":  2450.00,
  "draftOrderId": "gid://shopify/DraftOrder/99887766",
  "draftOrderUrl": "https://kavstn.myshopify.com/admin/draft_orders/99887766"
}
```

**Error response — 400**

```json
{
  "ok":    false,
  "error": "Base finish is not compatible with this configuration."
}
```

### `GET /health`

Returns `{ "ok": true }`. Used by Render and uptime monitors to confirm the server is running.

---

## Deployment (Render)

1. Push this repo to GitHub.
2. In the [Render dashboard](https://render.com), create a new **Web Service** and connect the repo.
3. Set the build command to `npm install` and the start command to `node index.js`.
4. Add all required environment variables in the **Environment** tab.
5. Deploy. Render will provide a public URL like `https://kavstn-api.onrender.com`.
6. Copy that URL and update the `API_BASE_URL` constant at the top of `kavstn-table-configurator.liquid`.

---

## Deploying the Liquid section

The storefront section is **not** deployed from this repo — it is uploaded manually to keep changes controlled and reviewed.

1. Open your Shopify admin → **Online Store → Themes**.
2. Find the duplicate theme named **KAVSTN TABLE CONFIGURATOR** (never the live theme).
3. Click **Customize → Edit code**.
4. Under **Sections**, find or create `kavstn-table-configurator.liquid`.
5. Paste in the contents of the file from this repo.
6. Save. Preview the theme before publishing.

> Only publish to the live theme after the configurator has been fully tested on desktop and mobile.

---

## Shopify Custom App setup

The server uses Shopify's `client_credentials` OAuth flow, which requires a **Custom App** in your store.

1. Shopify admin → **Settings → Apps and sales channels → Develop apps**.
2. Create a new app (e.g. "KAVSTN Configurator API").
3. Under **Configuration**, grant these Admin API access scopes:
   - `read_metaobjects`
   - `write_draft_orders`
   - `read_draft_orders`
4. Install the app on your store.
5. Copy the **Client ID** and **Client Secret** into your environment variables.

---

## Compatibility rules enforced server-side

The server validates that selections make sense together before creating a Draft Order:

- **Base finish → Base material:** Each base finish is linked to one specific base material via a Shopify metaobject reference field. The server rejects any combination where the selected base finish does not reference the selected base material.
- **All required fields present:** All 10 configuration fields must be supplied. Missing any one returns a 400 error.

The Liquid section also enforces these rules in the UI — base finish cards are hidden when they don't belong to the selected base material — so customers should never reach the server with an invalid combination under normal use.

---

## Making changes

The code is written to be readable and easy to modify without assistance.

- **Adding a new configuration option:** Add its metaobject type to the `selectionSchema` array in `index.js`. Add the corresponding card markup to `kavstn-table-configurator.liquid`.
- **Changing a compatibility rule:** Edit the `verifyAndPrice()` function in `index.js`. Each `requireReference()` call is one compatibility check — the parameters and intent are commented inline.
- **Changing the 2D preview:** The preview is an SVG drawn inside `updateTablePreview()` in the `<script>` block of the Liquid file. Shape, dimensions, and colour are all set there.
- **Changing visible labels or colours in the theme:** Most section settings are Shopify theme editor blocks — open the theme customiser and edit them without touching code.

---

## Security notes

- Price calculation happens entirely server-side. The browser never sends a price — only metaobject IDs.
- The Admin API credentials are never exposed to the browser or the Liquid section.
- CORS is restricted to the domains listed in `ALLOWED_ORIGINS`.
- Request bodies are capped at 32 KB to prevent abuse.
- The Admin token is cached and reused for its lifetime, reducing API calls.

---

## License

Private — all rights reserved. Not for redistribution.
