/**
 * KAVSTN secure pricing + Draft Order API
 *
 * The browser sends Shopify metaobject IDs only. This server reads the
 * authoritative values from Shopify, validates relationships, calculates the
 * ex-VAT price, and creates or updates a Draft Order with that verified price.
 */

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const SHOPIFY_API_VERSION = '2026-07';

const defaultOrigins = [
  'https://kavstn.co.uk',
  'https://www.kavstn.co.uk',
  'https://kavstn.myshopify.com',
];

const allowedOrigins = new Set(
  (process.env.ALLOWED_ORIGINS || defaultOrigins.join(','))
    .split(',')
    .map(origin => origin.trim().replace(/\/$/, ''))
    .filter(Boolean)
);

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin.replace(/\/$/, ''))) {
      return callback(null, true);
    }

    return callback(new Error('Origin is not allowed.'));
  },
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type'],
}));

app.use(express.json({ limit: '32kb' }));

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
      'Missing SHOPIFY_STORE_DOMAIN, SHOPIFY_CLIENT_ID or SHOPIFY_CLIENT_SECRET.'
    );
  }

  const response = await fetch(
    `https://${shop}/admin/oauth/access_token`,
    {
      method: 'POST',

      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },

      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
      }),
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
      'Shopify did not return an access token.'
    );
  }

  cachedAdminToken = data.access_token;

  adminTokenExpiresAt =
    Date.now() +
    (Number(data.expires_in) || 86400) * 1000;

  return cachedAdminToken;
}

async function shopifyGraphQL(query, variables = {}) {
  const shop = process.env.SHOPIFY_STORE_DOMAIN;

  if (!shop) {
    throw new Error(
      'Missing SHOPIFY_STORE_DOMAIN.'
    );
  }

  const response = await fetch(
    `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: 'POST',

      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token':
          await getShopifyAdminToken(),
      },

      body: JSON.stringify({
        query,
        variables,
      }),
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
    throw new Error(
      `Shopify GraphQL error: ${data.errors
        .map(error => error.message)
        .join(', ')}`
    );
  }

  return data.data;
}

/*
 * Maps each incoming selection key to the Shopify metaobject type it must
 * resolve to. The type string here must match the `type` field that
 * Shopify's Admin API returns — check your Render logs after the first
 * Add to Order attempt to see what types are actually returned.
 *
 * Common issue: merchant-defined metaobject types may be prefixed in the
 * Admin API (e.g. "custom.table_shape" instead of "table_shape"), even
 * though Liquid lets you query them without the prefix. If your Render
 * logs show "custom.table_shape", change the values below to match.
 */
const selectionSchema = {
  shapeId:            'table_shape',
  dimensionId:        'dimension_preset',
  materialId:         'table_material',
  baseDesignId:       'base_design',
  baseMaterialId:     'base_material',
  materialFinishId:   'material_finish',
  edgeProfileId:      'edge_profile',
  thicknessId:        'table_thickness',
  surfaceTreatmentId: 'surface_treatment',
  baseFinishId:       'base_finish',
};

const pricingMetaobjectsQuery = `
  query GetPricingMetaobjects($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Metaobject {
        id
        type
        displayName
        fields {
          key
          value
        }
      }
    }
  }
`;

class ClientError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

function assertMetaobjectGid(value, key) {
  const gidPattern =
    /^gid:\/\/shopify\/Metaobject\/\d+$/;

  if (
    typeof value !== 'string' ||
    !gidPattern.test(value)
  ) {
    throw new ClientError(
      `Missing or invalid ${key}.`
    );
  }

  return value;
}

function field(metaobject, key) {
  const selectedField =
    metaobject.fields.find(
      item => item.key === key
    );

  return selectedField?.value ?? '';
}

function numberField(metaobject, key) {
  const value = Number(
    field(metaobject, key) || 0
  );

  if (!Number.isFinite(value)) {
    throw new Error(
      `Invalid numeric field ${metaobject.type}.${key}.`
    );
  }

  return value;
}

function listValue(raw) {
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw);

    if (Array.isArray(parsed)) {
      return parsed.map(String);
    }
  } catch {
    // Use the comma-separated fallback.
  }

  return String(raw)
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
}

function referenceIds(metaobject, key) {
  const raw = field(metaobject, key);
  const parsed = listValue(raw);

  if (parsed.length) {
    return parsed.filter(value =>
      value.startsWith('gid://shopify/')
    );
  }

  return raw.startsWith('gid://shopify/')
    ? [raw]
    : [];
}

function textList(metaobject, key) {
  return listValue(field(metaobject, key))
    .map(value => value.toLowerCase());
}

function isUnavailable(metaobject) {
  const available =
    field(metaobject, 'available') ||
    field(metaobject, 'availability');

  const unavailableValues = [
    'false',
    'unavailable',
    'disabled',
    'inactive',
  ];

  return unavailableValues.includes(
    String(available).toLowerCase()
  );
}

function requireReference(
  metaobject,
  key,
  expectedId,
  label
) {
  const references =
    referenceIds(metaobject, key);

  if (
    references.length &&
    !references.includes(expectedId)
  ) {
    throw new ClientError(
      `${label} is not compatible with this configuration.`
    );
  }
}

function requireTextCompatibility(
  metaobject,
  key,
  expectedValue,
  label
) {
  const allowed =
    textList(metaobject, key);

  if (
    allowed.length &&
    !allowed.includes(
      String(expectedValue).toLowerCase()
    )
  ) {
    throw new ClientError(
      `${label} is not compatible with this configuration.`
    );
  }
}

async function verifyAndPrice(selections) {
  if (
    !selections ||
    typeof selections !== 'object'
  ) {
    throw new ClientError(
      'Configuration selections are required.'
    );
  }

  const entries =
    Object.entries(selectionSchema);

  const ids = entries.map(([key]) =>
    assertMetaobjectGid(
      selections[key],
      key
    )
  );

  if (
    new Set(ids).size !== ids.length
  ) {
    throw new ClientError(
      'Each configuration selection must use its own metaobject ID.'
    );
  }

  const data = await shopifyGraphQL(
    pricingMetaobjectsQuery,
    { ids }
  );

  const returnedNodes = (data.nodes || []).filter(Boolean);

  /*
   * ── Debug logging ──────────────────────────────────────────
   * Logs the metaobject types Shopify actually returned so you
   * can verify they match the expected types in selectionSchema.
   * Check your Render service logs after triggering an Add to Order.
   *
   * If the types include a prefix (e.g. "custom.table_shape" instead
   * of "table_shape"), update selectionSchema below to match.
   *
   * Remove these console.logs once everything is working correctly.
   */
  console.log('[KAVSTN] Requested GIDs:', ids);
  console.log('[KAVSTN] Shopify returned metaobjects:', returnedNodes.map(n => ({
    id:          n.id,
    type:        n.type,
    displayName: n.displayName,
  })));

  const byId = new Map(
    returnedNodes.map(node => [node.id, node])
  );

  const selected = {};

  entries.forEach(
    ([key, expectedType]) => {
      const metaobject =
        byId.get(selections[key]);

      if (
        !metaobject ||
        metaobject.type !== expectedType
      ) {
        /*
         * The type mismatch error — check the Render logs above to see
         * what type Shopify actually returned for this metaobject ID.
         * The type logged there must match the value in selectionSchema.
         */
        throw new ClientError(
          `${key} does not reference a valid ${expectedType} option. ` +
          `(actual type: ${metaobject ? metaobject.type : 'not found'})`
        );
      }

      if (isUnavailable(metaobject)) {
        throw new ClientError(
          `${metaobject.displayName} is currently unavailable.`
        );
      }

      selected[key] = metaobject;
    }
  );

  const shape =
    selected.shapeId;

  const dimension =
    selected.dimensionId;

  const material =
    selected.materialId;

  const baseDesign =
    selected.baseDesignId;

  const baseMaterial =
    selected.baseMaterialId;

  const materialFinish =
    selected.materialFinishId;

  const edge =
    selected.edgeProfileId;

  const thickness =
    selected.thicknessId;

  const surface =
    selected.surfaceTreatmentId;

  const baseFinish =
    selected.baseFinishId;

  requireReference(
    dimension,
    'shape',
    shape.id,
    'Dimension'
  );

  requireReference(
    materialFinish,
    'material',
    material.id,
    'Top finish'
  );

  requireReference(
    baseFinish,
    'base_material',
    baseMaterial.id,
    'Base finish'
  );

  requireTextCompatibility(
    baseMaterial,
    'compatible_designs',
    field(baseDesign, 'base_handle'),
    'Base material'
  );

  const materialCategory =
    field(
      material,
      'material_category'
    );

  requireTextCompatibility(
    edge,
    'compatible_materials',
    materialCategory,
    'Edge profile'
  );

  requireTextCompatibility(
    surface,
    'compatible_materials',
    materialCategory,
    'Surface treatment'
  );

  const requiresApproval =
    String(
      field(
        dimension,
        'requires_approval'
      )
    ).toLowerCase();

  if (requiresApproval === 'true') {
    throw new ClientError(
      'This size requires manual approval and cannot be ordered online yet.'
    );
  }

  const shapeHandle =
    field(
      shape,
      'shape_handle'
    ).toLowerCase();

  const lengthMm =
    numberField(
      dimension,
      'length_cm'
    ) * 10;

  const widthMm =
    numberField(
      dimension,
      'width_cm'
    ) * 10;

  const diameterMm =
    numberField(
      dimension,
      'diameter_cm'
    ) * 10;

  let areaSqm = 0;

  if (
    shapeHandle === 'round' &&
    diameterMm > 0
  ) {
    const radiusM =
      diameterMm / 2 / 1000;

    areaSqm =
      Math.PI *
      radiusM *
      radiusM;
  } else if (
    (
      shapeHandle === 'oval' ||
      shapeHandle === 'racetrack'
    ) &&
    lengthMm > 0 &&
    widthMm > 0
  ) {
    areaSqm =
      Math.PI *
      (lengthMm / 2 / 1000) *
      (widthMm / 2 / 1000);
  } else if (
    lengthMm > 0 &&
    widthMm > 0
  ) {
    areaSqm =
      (lengthMm / 1000) *
      (widthMm / 1000);
  } else {
    throw new ClientError(
      'The selected dimension preset has incomplete measurements.'
    );
  }

  const adjustments = {
    dimension:
      numberField(
        dimension,
        'price_adjustment'
      ),

    baseMaterial:
      numberField(
        baseMaterial,
        'price_adjustment'
      ),

    materialFinish:
      numberField(
        materialFinish,
        'price_adjustment'
      ),

    edge:
      numberField(
        edge,
        'price_adjustment'
      ),

    thickness:
      numberField(
        thickness,
        'price_adjustment'
      ),

    surface:
      numberField(
        surface,
        'price_adjustment'
      ),

    baseFinish:
      numberField(
        baseFinish,
        'price_adjustment'
      ),
  };

  const totalAdjustments =
    Object.values(adjustments)
      .reduce(
        (sum, value) =>
          sum + value,
        0
      );

  const shapeBasePrice =
    numberField(
      shape,
      'base_price'
    );

  const materialBasePrice =
    numberField(
      material,
      'base_price'
    );

  const materialPricePerSqm =
    numberField(
      material,
      'price_per_sqm'
    );

  const verifiedPrice =
    shapeBasePrice +
    materialBasePrice +
    materialPricePerSqm * areaSqm +
    totalAdjustments;

  if (
    !Number.isFinite(verifiedPrice) ||
    verifiedPrice <= 0
  ) {
    throw new Error(
      'The authoritative Shopify pricing data produced an invalid price.'
    );
  }

  const dimensions =
    diameterMm > 0
      ? `Diameter ${diameterMm / 10} cm`
      : `${lengthMm / 10} × ${widthMm / 10} cm`;

  const properties = {
    Shape:
      shape.displayName,

    Dimensions:
      field(dimension, 'label') ||
      dimensions,

    'Suggested Seating':
      field(dimension, 'seating') ||
      '—',

    'Top Material':
      material.displayName,

    'Base Design':
      baseDesign.displayName,

    'Base Material':
      baseMaterial.displayName,

    'Top Finish':
      materialFinish.displayName,

    'Edge Profile':
      edge.displayName,

    Thickness:
      field(thickness, 'label') ||
      `${field(
        thickness,
        'thickness_mm'
      )} mm`,

    'Surface Treatment':
      surface.displayName,

    'Base Finish':
      baseFinish.displayName,

    'Verified Price (ex VAT)':
      `£${verifiedPrice.toFixed(2)}`,

    '_Shape ID':
      shape.id,

    '_Dimension ID':
      dimension.id,

    '_Material ID':
      material.id,

    '_Base Design ID':
      baseDesign.id,

    '_Base Material ID':
      baseMaterial.id,
  };

  return {
    price:
      Math.round(
        verifiedPrice * 100
      ) / 100,

    areaSqm:
      Math.round(
        areaSqm * 1000
      ) / 1000,

    properties,
  };
}

const getDraftOrderQuery = `
  query GetDraftOrder($id: ID!) {
    draftOrder(id: $id) {
      id
      status

      lineItems(first: 50) {
        nodes {
          title
          originalUnitPrice
          quantity

          customAttributes {
            key
            value
          }
        }
      }
    }
  }
`;

const createDraftOrderMutation = `
  mutation DraftOrderCreate(
    $input: DraftOrderInput!
  ) {
    draftOrderCreate(input: $input) {
      draftOrder {
        id
        invoiceUrl
      }

      userErrors {
        field
        message
      }
    }
  }
`;

const updateDraftOrderMutation = `
  mutation DraftOrderUpdate(
    $id: ID!
    $input: DraftOrderInput!
  ) {
    draftOrderUpdate(
      id: $id
      input: $input
    ) {
      draftOrder {
        id
        invoiceUrl
      }

      userErrors {
        field
        message
      }
    }
  }
`;

function mutationPayload(
  payload,
  operationName
) {
  const errors =
    payload?.userErrors || [];

  if (errors.length) {
    throw new ClientError(
      errors
        .map(error => error.message)
        .join(', ')
    );
  }

  if (!payload?.draftOrder) {
    throw new Error(
      `Shopify did not return a draft order from ${operationName}.`
    );
  }

  return payload.draftOrder;
}

function signingSecret() {
  const secret =
    process.env.DRAFT_ORDER_SIGNING_SECRET;

  if (
    !secret ||
    secret.length < 32
  ) {
    throw new Error(
      'DRAFT_ORDER_SIGNING_SECRET must contain at least 32 characters.'
    );
  }

  return secret;
}

function signDraftOrderId(draftOrderId) {
  const signature = crypto
    .createHmac(
      'sha256',
      signingSecret()
    )
    .update(draftOrderId)
    .digest('base64url');

  const encodedId =
    Buffer
      .from(draftOrderId)
      .toString('base64url');

  return `${encodedId}.${signature}`;
}

function verifyDraftOrderToken(token) {
  if (!token) {
    return null;
  }

  if (
    typeof token !== 'string' ||
    token.length > 500 ||
    !token.includes('.')
  ) {
    throw new ClientError(
      'Invalid draft order token.'
    );
  }

  const [
    encodedId,
    suppliedSignature,
  ] = token.split('.');

  const draftOrderId =
    Buffer
      .from(
        encodedId,
        'base64url'
      )
      .toString('utf8');

  const draftOrderPattern =
    /^gid:\/\/shopify\/DraftOrder\/\d+$/;

  if (
    !draftOrderPattern.test(
      draftOrderId
    )
  ) {
    throw new ClientError(
      'Invalid draft order token.'
    );
  }

  const expectedSignature =
    crypto
      .createHmac(
        'sha256',
        signingSecret()
      )
      .update(draftOrderId)
      .digest('base64url');

  const supplied =
    Buffer.from(
      suppliedSignature || ''
    );

  const expected =
    Buffer.from(
      expectedSignature
    );

  if (
    supplied.length !== expected.length ||
    !crypto.timingSafeEqual(
      supplied,
      expected
    )
  ) {
    throw new ClientError(
      'Invalid draft order token.'
    );
  }

  return draftOrderId;
}

app.get('/', (req, res) => {
  return res.json({
    service:
      'KAVSTN Secure Pricing API',

    version:
      '3.0.0',

    status:
      'running',
  });
});

app.get(
  '/auth/status',
  async (req, res) => {
    try {
      await getShopifyAdminToken();

      return res.json({
        authenticated: true,
        method: 'client_credentials',

        token_cached:
          Boolean(cachedAdminToken),

        expires_at:
          new Date(
            adminTokenExpiresAt
          ).toISOString(),
      });
    } catch (error) {
      return res
        .status(500)
        .json({
          authenticated: false,
          error: error.message,
        });
    }
  }
);

app.post(
  '/price',
  async (req, res) => {
    try {
      const verified =
        await verifyAndPrice(
          req.body.selections
        );

      return res.json({
        success: true,
        price: verified.price,
        area_sqm: verified.areaSqm,
      });
    } catch (error) {
      console.error(
        '[KAVSTN] /price error:',
        error.message
      );

      return res
        .status(error.status || 500)
        .json({
          success: false,
          error: error.message,
        });
    }
  }
);

app.post(
  '/set-price',
  (req, res) => {
    return res.status(410).json({
      error:
        'This endpoint is disabled. Use /add-to-order.',
    });
  }
);

app.post(
  '/add-to-order',
  async (req, res) => {
    try {
      signingSecret();

      const verified =
        await verifyAndPrice(
          req.body.selections
        );

      const requestedDraftOrderId =
        verifyDraftOrderToken(
          req.body.draftOrderToken
        );

      const newLineItem = {
        title:
          'KAVSTN Bespoke Dining Table',

        originalUnitPrice:
          verified.price.toFixed(2),

        quantity: 1,

        customAttributes:
          Object.entries(
            verified.properties
          ).map(
            ([key, value]) => ({
              key,
              value: String(value),
            })
          ),
      };

      let draftOrderId = null;

      let lineItems = [
        newLineItem,
      ];

      if (requestedDraftOrderId) {
        const existingData =
          await shopifyGraphQL(
            getDraftOrderQuery,
            {
              id: requestedDraftOrderId,
            }
          );

        const existing =
          existingData.draftOrder;

        if (
          existing?.status === 'OPEN'
        ) {
          draftOrderId =
            existing.id;

          const existingItems =
            (
              existing
                .lineItems
                ?.nodes || []
            ).map(node => ({
              title:
                node.title,

              originalUnitPrice:
                node.originalUnitPrice,

              quantity:
                node.quantity,

              customAttributes:
                node.customAttributes,
            }));

          lineItems = [
            ...existingItems,
            newLineItem,
          ];
        }
      }

      let draftOrder;

      if (draftOrderId) {
        const data =
          await shopifyGraphQL(
            updateDraftOrderMutation,
            {
              id: draftOrderId,

              input: {
                lineItems,
              },
            }
          );

        draftOrder =
          mutationPayload(
            data.draftOrderUpdate,
            'draftOrderUpdate'
          );
      } else {
        const data =
          await shopifyGraphQL(
            createDraftOrderMutation,
            {
              input: {
                lineItems,
              },
            }
          );

        draftOrder =
          mutationPayload(
            data.draftOrderCreate,
            'draftOrderCreate'
          );
      }

      return res.json({
        success: true,

        draftOrderId:
          draftOrder.id,

        draftOrderToken:
          signDraftOrderId(
            draftOrder.id
          ),

        invoiceUrl:
          draftOrder.invoiceUrl,

        verifiedPrice:
          verified.price,
      });
    } catch (error) {
      console.error(
        '[KAVSTN] /add-to-order error:',
        error.message
      );

      return res
        .status(error.status || 500)
        .json({
          success: false,
          error: error.message,
        });
    }
  }
);

app.use(
  (error, req, res, next) => {
    if (
      error.message ===
      'Origin is not allowed.'
    ) {
      return res
        .status(403)
        .json({
          success: false,
          error: error.message,
        });
    }

    return next(error);
  }
);

app.listen(PORT, () => {
  console.log(
    `KAVSTN Secure Pricing API running on port ${PORT}`
  );
});