function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function decodeHtml(value = "") {
  return String(value)
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\\u002F/g, "/")
    .replace(/\\u003C/g, "<")
    .replace(/\\u003E/g, ">")
    .replace(/\\u0026/g, "&")
    .replace(/\\u0022/g, '"')
    .replace(/\\u0027/g, "'");
}

function normalizeText(value = "") {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function cleanValue(value) {
  if (Array.isArray(value)) {
    value = value
      .map(item => {
        if (typeof item === "string" || typeof item === "number") return String(item);
        if (item?.name) return item.name;
        if (item?.value) return item.value;
        if (item?.label) return item.label;
        return "";
      })
      .filter(Boolean)
      .join(", ");
  }

  if (value && typeof value === "object") {
    if (value.name) value = value.name;
    else if (value.value) value = value.value;
    else if (value.label) value = value.label;
    else value = "";
  }

  const text = decodeHtml(String(value || ""))
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const normalized = normalizeText(text);

  if (!text) return "";
  if (normalized === "no indicado") return "";
  if (normalized === "sin dato") return "";
  if (normalized.startsWith("sin ")) return "";
  if (normalized.includes("sin informacion")) return "";
  if (normalized.includes("no disponible")) return "";

  return text;
}

function cleanSku(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, "")
    .replace(/_(?:\d{1,3}|SEC|EFI)$/i, "");
}

async function fetchHtml(url) {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      "User-Agent": USER_AGENT,
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "es-CL,es;q=0.9,en;q=0.7"
    }
  });

  const text = await response.text().catch(() => "");

  if (!response.ok) {
    const error = new Error(`Falabella respondió ${response.status}`);
    error.status = response.status;
    error.html = text;
    throw error;
  }

  return text;
}

function absoluteFalabellaUrl(url) {
  if (!url) return "";
  let clean = decodeHtml(String(url)).trim();

  clean = clean
    .replace(/^https?:\\\/\\\//, "https://")
    .replace(/\\\//g, "/")
    .split("#")[0];

  if (clean.startsWith("//")) clean = `https:${clean}`;
  if (clean.startsWith("/")) clean = `https://www.falabella.com${clean}`;

  clean = clean.replace(/[),.;]+$/g, "");

  return clean;
}

function findProductUrlFromHtml(html, sku) {
  const decoded = decodeHtml(html);
  const candidates = new Set();

  const patterns = [
    /https?:\/\/www\.falabella\.com\/falabella-cl\/product\/[^"'<>\s)]+/gi,
    /\/falabella-cl\/product\/[^"'<>\s)]+/gi
  ];

  for (const pattern of patterns) {
    let match;

    while ((match = pattern.exec(decoded)) !== null) {
      const url = absoluteFalabellaUrl(match[0]);

      if (!url.includes("/falabella-cl/product/")) continue;
      if (url.includes("/search")) continue;

      candidates.add(url);

      if (url.includes(sku)) {
        return url;
      }
    }
  }

  const list = [...candidates];
  return list[0] || "";
}

function parseJsonSafely(text) {
  try {
    return JSON.parse(text);
  } catch {
    try {
      return JSON.parse(decodeHtml(text));
    } catch {
      return null;
    }
  }
}

function findJsonLdProduct(html) {
  const scripts = [...html.matchAll(
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  )];

  const products = [];

  function walk(node) {
    if (!node) return;

    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }

    if (typeof node !== "object") return;

    const type = node["@type"];

    if (
      type === "Product" ||
      (Array.isArray(type) && type.includes("Product")) ||
      node.sku ||
      node.offers
    ) {
      products.push(node);
    }

    Object.values(node).forEach(walk);
  }

  for (const script of scripts) {
    const json = parseJsonSafely(script[1]);
    walk(json);
  }

  return products[0] || null;
}

function extractNextData(html) {
  const match = html.match(
    /<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i
  );

  if (!match) return null;

  return parseJsonSafely(match[1]);
}

function valueFromObject(obj, keys) {
  if (!obj || typeof obj !== "object") return "";

  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null) {
      const value = cleanValue(obj[key]);
      if (value) return value;
    }
  }

  return "";
}

function mapSpecLabel(label) {
  const key = normalizeText(label);

  if (!key) return "";

  if (key.includes("material")) return "material";
  if (key === "color" || key.includes("color principal")) return "color";
  if (key.includes("modelo") || key.includes("model")) return "modelo";
  if (key.includes("marca") || key.includes("brand")) return "marca";
  if (key.includes("vendedor") || key.includes("seller") || key.includes("proveedor")) return "vendedor";
  if (key.includes("alto")) return "alto";
  if (key.includes("ancho")) return "ancho";
  if (key.includes("profundidad") || key.includes("fondo")) return "profundidad";
  if (key.includes("largo")) return "largo";
  if (key.includes("dimension") || key.includes("medida") || key.includes("tamano") || key.includes("tamaño")) return "medidas";

  return "";
}

function valueFromSpecObject(obj) {
  return cleanValue(
    obj.value ??
    obj.values ??
    obj.displayValue ??
    obj.valueName ??
    obj.description ??
    obj.text ??
    obj.nameValue ??
    ""
  );
}

function labelFromSpecObject(obj) {
  return cleanValue(
    obj.name ??
    obj.label ??
    obj.key ??
    obj.title ??
    obj.id ??
    obj.attributeName ??
    ""
  );
}

function extractSpecsFromJson(root) {
  const result = {};
  const stack = [root];
  const seen = new Set();
  let safety = 0;

  while (stack.length && safety < 25000) {
    safety++;
    const node = stack.pop();

    if (!node || typeof node !== "object") continue;
    if (seen.has(node)) continue;
    seen.add(node);

    if (Array.isArray(node)) {
      for (const item of node) stack.push(item);
      continue;
    }

    const label = labelFromSpecObject(node);
    const value = valueFromSpecObject(node);
    const field = mapSpecLabel(label);

    if (field && value && !result[field]) {
      result[field] = value;
    }

    for (const value of Object.values(node)) {
      if (value && typeof value === "object") {
        stack.push(value);
      }
    }
  }

  return result;
}

function extractLikelyFieldsFromJson(root) {
  const result = {};
  const stack = [root];
  const seen = new Set();
  let safety = 0;

  const keyGroups = {
    nombre: [
      "productName",
      "displayName",
      "productDisplayName",
      "title"
    ],
    marca: [
      "brandName",
      "brand"
    ],
    descripcion: [
      "description",
      "longDescription",
      "shortDescription",
      "productDescription"
    ],
    vendedor: [
      "sellerName",
      "merchantName",
      "seller",
      "merchant"
    ],
    categoria: [
      "categoryName",
      "departmentName",
      "subDepartmentName"
    ]
  };

  while (stack.length && safety < 25000) {
    safety++;
    const node = stack.pop();

    if (!node || typeof node !== "object") continue;
    if (seen.has(node)) continue;
    seen.add(node);

    if (Array.isArray(node)) {
      for (const item of node) stack.push(item);
      continue;
    }

    for (const [field, keys] of Object.entries(keyGroups)) {
      if (result[field]) continue;

      const value = valueFromObject(node, keys);
      if (value) result[field] = value;
    }

    for (const value of Object.values(node)) {
      if (value && typeof value === "object") {
        stack.push(value);
      }
    }
  }

  return result;
}

function extractColorFromName(name) {
  const normalized = normalizeText(name);

  const colors = [
    ["terracota", "Terracota"],
    ["beige", "Beige"],
    ["blanco", "Blanco"],
    ["negro", "Negro"],
    ["gris", "Gris"],
    ["cafe", "Café"],
    ["marron", "Marrón"],
    ["azul", "Azul"],
    ["verde", "Verde"],
    ["rojo", "Rojo"],
    ["rosado", "Rosado"],
    ["rosa", "Rosa"],
    ["amarillo", "Amarillo"],
    ["naranjo", "Naranjo"],
    ["dorado", "Dorado"],
    ["plateado", "Plateado"],
    ["transparente", "Transparente"],
    ["natural", "Natural"]
  ];

  const found = colors.find(([key]) => normalized.includes(key));
  return found ? found[1] : "";
}

function extractMaterialFromName(name) {
  const normalized = normalizeText(name);

  const materials = [
    ["ceramica", "Cerámica"],
    ["arcilla", "Arcilla"],
    ["madera", "Madera"],
    ["metal", "Metal"],
    ["vidrio", "Vidrio"],
    ["plastico", "Plástico"],
    ["algodon", "Algodón"],
    ["poliester", "Poliéster"],
    ["cuero", "Cuero"],
    ["acero", "Acero"],
    ["ratán", "Ratán"],
    ["ratan", "Ratán"]
  ];

  const found = materials.find(([key]) => normalized.includes(key));
  return found ? found[1] : "";
}

function buildMedidas(specs) {
  if (specs.medidas) return specs.medidas;

  const parts = [];

  if (specs.alto) parts.push(`Alto ${specs.alto}`);
  if (specs.ancho) parts.push(`Ancho ${specs.ancho}`);
  if (specs.profundidad) parts.push(`Profundidad ${specs.profundidad}`);
  if (specs.largo) parts.push(`Largo ${specs.largo}`);

  return parts.join(" / ");
}

function extractProductInfoFromHtml(html, sku, productUrl) {
  const jsonLd = findJsonLdProduct(html);
  const nextData = extractNextData(html);

  const jsonFields = nextData ? extractLikelyFieldsFromJson(nextData) : {};
  const specs = nextData ? extractSpecsFromJson(nextData) : {};

  const jsonLdBrand = typeof jsonLd?.brand === "object"
    ? jsonLd.brand?.name
    : jsonLd?.brand;

  const jsonLdSeller = typeof jsonLd?.offers?.seller === "object"
    ? jsonLd.offers.seller?.name
    : jsonLd?.offers?.seller;

  const nombre =
    cleanValue(jsonLd?.name) ||
    cleanValue(jsonFields.nombre);

  const marca =
    cleanValue(jsonLdBrand) ||
    cleanValue(specs.marca) ||
    cleanValue(jsonFields.marca);

  const descripcion =
    cleanValue(jsonLd?.description) ||
    cleanValue(jsonFields.descripcion);

  const material =
    cleanValue(specs.material) ||
    extractMaterialFromName(nombre);

  const color =
    cleanValue(specs.color) ||
    extractColorFromName(nombre);

  const medidas =
    cleanValue(buildMedidas(specs));

  const vendedor =
    cleanValue(jsonLdSeller) ||
    cleanValue(jsonFields.vendedor) ||
    cleanValue(specs.vendedor);

  const categoria =
    cleanValue(jsonFields.categoria);

  const modelo =
    cleanValue(specs.modelo);

  const found = Boolean(nombre || marca || descripcion || material || color || medidas || vendedor || categoria || modelo);

  return {
    found,
    sku,
    source: "Falabella CL",
    productUrl: productUrl || "",
    fetchedAt: new Date().toISOString(),

    nombre: nombre || "",
    marca: marca || "",
    descripcion: descripcion || "",
    material: material || "",
    color: color || "",
    medidas: medidas || "",
    comentarios: "",

    categoria: categoria || "",
    modelo: modelo || "",
    vendedor: vendedor || "",

    error: ""
  };
}

async function findProductPageBySearch(sku) {
  const searchUrls = [
    `https://www.falabella.com/falabella-cl/search?Ntt=${encodeURIComponent(sku)}`,
    `https://www.falabella.com/falabella-cl/search?Ntt=${encodeURIComponent(sku)}&store=FALABELLA`
  ];

  for (const searchUrl of searchUrls) {
    try {
      const html = await fetchHtml(searchUrl);
      const productUrl = findProductUrlFromHtml(html, sku);

      if (productUrl) {
        return productUrl;
      }
    } catch {
      // Sigue intentando con la siguiente estrategia.
    }
  }

  return "";
}

export default async function handler(req, res) {
  cors(res);

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "GET") {
    return res.status(405).json({
      found: false,
      error: "Método no permitido. Usa GET con ?sku=."
    });
  }

  try {
    const sku = cleanSku(req.query?.sku);

    if (!sku) {
      return res.status(400).json({
        found: false,
        error: "Falta parámetro sku."
      });
    }

    let productUrl = await findProductPageBySearch(sku);

    if (!productUrl) {
      productUrl = `https://www.falabella.com/falabella-cl/product/${encodeURIComponent(sku)}`;
    }

    let html = "";

    try {
      html = await fetchHtml(productUrl);
    } catch (error) {
      return res.status(200).json({
        found: false,
        sku,
        source: "Falabella CL",
        productUrl,
        fetchedAt: new Date().toISOString(),
        nombre: "",
        marca: "",
        descripcion: "",
        material: "",
        color: "",
        medidas: "",
        comentarios: "",
        categoria: "",
        modelo: "",
        vendedor: "",
        error: error.message || "No se pudo abrir la ficha pública."
      });
    }

    const data = extractProductInfoFromHtml(html, sku, productUrl);

    return res.status(200).json(data);
  } catch (error) {
    console.error("falabella-cl-product-info error:", error);

    return res.status(500).json({
      found: false,
      error: error.message || "Error interno al consultar Falabella CL."
    });
  }
}
