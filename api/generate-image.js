const MODEL_NAME = process.env.GEMINI_MODEL || "gemini-3-pro-image";
const DEFAULT_ADMIN_PIN = "3400";
const MAX_REFERENCE_IMAGES = 3;
const MAX_REMOTE_IMAGE_BYTES = 12 * 1024 * 1024;

const DEFAULT_ALLOWED_ADMINS = ["Pablo", "Mica", "Valentina"];

function cors(res) {
  const allowedOrigin = process.env.ALLOWED_ORIGIN || "*";

  res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function parseBody(req) {
  if (!req.body) return {};

  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }

  return req.body;
}

function getAllowedAdmins() {
  const raw = process.env.ALLOWED_ADMINS || "";

  if (!raw.trim()) return DEFAULT_ALLOWED_ADMINS;

  return raw
    .split(",")
    .map(item => item.trim())
    .filter(Boolean);
}

function getExpectedPin() {
  return process.env.ADMIN_IA_PIN || process.env.IA_ADMIN_PIN || DEFAULT_ADMIN_PIN;
}

function normalizeMimeType(mimeType) {
  const clean = String(mimeType || "").split(";")[0].trim().toLowerCase();

  if (clean === "image/jpg") return "image/jpeg";
  if (clean === "image/jpeg") return "image/jpeg";
  if (clean === "image/png") return "image/png";
  if (clean === "image/webp") return "image/webp";
  if (clean === "image/avif") return "image/avif";

  return "image/jpeg";
}

function safeFileExt(mimeType) {
  const clean = normalizeMimeType(mimeType);

  if (clean.includes("jpeg")) return "jpg";
  if (clean.includes("webp")) return "webp";
  if (clean.includes("avif")) return "avif";

  return "png";
}

function sanitizeUrlList(urls) {
  if (!Array.isArray(urls)) return [];

  const seen = new Set();

  return urls
    .map(url => String(url || "").trim())
    .filter(Boolean)
    .filter(url => {
      if (seen.has(url)) return false;
      seen.add(url);
      return true;
    })
    .filter(url => /^https?:\/\//i.test(url))
    .slice(0, MAX_REFERENCE_IMAGES);
}

async function fetchImageAsInlineData(url, label = "imagen") {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 FlujoIA/1.0"
    }
  });

  if (!response.ok) {
    throw new Error(`No se pudo descargar ${label}. Estado: ${response.status}`);
  }

  const contentLength = Number(response.headers.get("content-length") || 0);

  if (contentLength && contentLength > MAX_REMOTE_IMAGE_BYTES) {
    throw new Error(`${label} supera el peso máximo permitido.`);
  }

  const mimeType = normalizeMimeType(response.headers.get("content-type") || "image/jpeg");
  const buffer = Buffer.from(await response.arrayBuffer());

  if (!buffer.length) {
    throw new Error(`${label} no tiene contenido válido.`);
  }

  if (buffer.length > MAX_REMOTE_IMAGE_BYTES) {
    throw new Error(`${label} supera el peso máximo permitido.`);
  }

  return {
    label,
    mimeType,
    data: buffer.toString("base64")
  };
}

function buildPayload({ finalPrompt, imageInputs }, mode) {
  const parts = [
    { text: finalPrompt },
    ...imageInputs.map(image => ({
      inlineData: {
        mimeType: image.mimeType,
        data: image.data
      }
    }))
  ];

  const base = {
    contents: [
      {
        parts
      }
    ],
    generationConfig: {
      responseModalities: ["TEXT", "IMAGE"]
    }
  };

  if (mode === "enum-response-format") {
    base.generationConfig.responseFormat = {
      image: {
        aspectRatio: "ASPECT_RATIO_1_1",
        imageSize: "IMAGE_SIZE_2K"
      }
    };
  }

  if (mode === "image-config") {
    base.generationConfig.imageConfig = {
      aspectRatio: "1:1",
      imageSize: "2K"
    };
  }

  if (mode === "minimal") {
    // Sin aspectRatio/imageSize. El prompt conserva la instrucción 1:1 / 2K.
  }

  return base;
}

function shouldRetryWithoutImageConfig(status, message) {
  if (status !== 400) return false;

  const lower = String(message || "").toLowerCase();

  return (
    lower.includes("generation_config") ||
    lower.includes("response_format") ||
    lower.includes("image_config") ||
    lower.includes("aspect_ratio") ||
    lower.includes("image_size") ||
    lower.includes("invalid value")
  );
}

async function callGemini({ finalPrompt, imageInputs }) {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    const error = new Error("Falta configurar GEMINI_API_KEY en Vercel.");
    error.status = 500;
    throw error;
  }

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME}:generateContent?key=${apiKey}`;

  const attempts = [
    "enum-response-format",
    "image-config",
    "minimal"
  ];

  let lastError = null;

  for (const mode of attempts) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(buildPayload({ finalPrompt, imageInputs }, mode))
    });

    const data = await response.json().catch(() => ({}));

    if (response.ok) {
      return {
        data,
        mode
      };
    }

    const message = data?.error?.message || `Error Gemini ${response.status}`;

    lastError = {
      status: response.status,
      message,
      data,
      mode
    };

    if ([401, 403, 429].includes(response.status)) {
      break;
    }

    if (!shouldRetryWithoutImageConfig(response.status, message)) {
      break;
    }
  }

  const error = new Error(lastError?.message || "Error al generar imagen con Gemini.");
  error.status = lastError?.status || 500;
  error.details = lastError?.data || null;
  error.mode = lastError?.mode || "";
  throw error;
}

function buildEnhancedPrompt({ prompt, sku, finalOption, referenceCount }) {
  const sceneDirection = finalOption === 1
    ? `
SCENE VARIANT 1:
Create a clean premium lifestyle composition. Use a modern, elegant, neutral setting with soft natural light. Keep the scene simple, polished, and commercial, similar to a high-end ecommerce hero image.`
    : `
SCENE VARIANT 2:
Create a warmer contextual lifestyle composition. Use a realistic home environment related to the product use, with tasteful props and depth, but without distracting from the product.`;

  const referencesInstruction = referenceCount > 0
    ? `
VISUAL STYLE REFERENCES:
Additional brand/style reference images are attached after the product image.
Use them only as aesthetic guidance for environment, mood, lighting, palette, materials, composition, and styling.
Do not copy products, logos, text, labels, packaging, or objects from the style reference images.
The first attached image is always the real product reference and has priority over all other references.`
    : `
VISUAL STYLE REFERENCES:
No additional brand/style reference images were provided.
Use only the attached product image and the written brand/style instructions from the product brief.`;

  return `
You are creating a professional ecommerce lifestyle image for a retail product.

SOURCE PRODUCT:
Use the first attached product image as the strict visual reference. The product identity must remain the same.

PRODUCT SKU:
${sku}

PRODUCT BRIEF FROM THE TEAM:
${prompt}

${referencesInstruction}

CORE REQUIREMENTS:
- Preserve the product exactly from the first reference image.
- Do not change the product shape, proportions, size relationship, color palette, material, texture, label, logo, typography, printed graphics, pattern, decorations, or visible details.
- Do not invent new logos, new text, new labels, new packaging, new colors, or new product variants.
- Do not deform, melt, stretch, blur, crop, hide, duplicate unnecessarily, or replace the product.
- The product must remain the main hero object and must be clearly visible.
- The image must look like a real professional product photo, not a render, not a collage, not an illustration.
- Use realistic lighting, realistic shadows, natural reflections, and coherent perspective.
- The environment must help explain the use or mood of the product while keeping a clean ecommerce aesthetic.
- Avoid clutter, busy backgrounds, distracting props, hands, people, faces, price tags, promotions, watermarks, extra text, UI elements, or brand logos not present on the product.
- If the product has readable label/text, keep it as close as possible to the reference. Never generate random readable text.
- If the exact text cannot be preserved, make it visually consistent and avoid adding new words.
- Do not use the style reference images to replace the product.

COMPOSITION:
- Square 1:1 final image.
- Target high quality 2K output.
- Product should be positioned naturally, with enough margin around it for ecommerce use.
- Do not cut off important parts of the product.
- Create a finished image ready for internal ecommerce review.

${sceneDirection}

FINAL OUTPUT:
Generate only one finished image. No explanations, no captions, no before/after, no text outside the image.
`.trim();
}

function extractImagePart(geminiData) {
  const parts = geminiData?.candidates?.[0]?.content?.parts || [];
  return parts.find(part => part?.inlineData?.data);
}

function buildOutputFileName(sku, finalOption, outputMimeType) {
  const ext = safeFileExt(outputMimeType);
  const view = finalOption === 1 ? "005" : "006";
  return `${sku}_${view}.${ext}`;
}

export default async function handler(req, res) {
  cors(res);

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Método no permitido." });
  }

  try {
    const body = parseBody(req);

    const {
      user,
      adminPin,
      sku,
      prompt,
      pos1Url,
      optionNumber,
      styleReferenceUrls
    } = body || {};

    const cleanUser = String(user || "").trim();
    const allowedAdmins = getAllowedAdmins();

    if (!allowedAdmins.includes(cleanUser)) {
      return res.status(403).json({
        error: "Este usuario no está autorizado para usar generación IA."
      });
    }

    const expectedPin = getExpectedPin();

    if (String(adminPin || "").trim() !== expectedPin) {
      return res.status(403).json({
        error: "Clave IA incorrecta."
      });
    }

    if (!sku || !prompt || !pos1Url) {
      return res.status(400).json({
        error: "Faltan datos obligatorios: sku, prompt o pos1Url."
      });
    }

    const cleanSku = String(sku).trim();
    const cleanPrompt = String(prompt).trim();
    const cleanPos1Url = String(pos1Url).trim();

    if (!/^https?:\/\//i.test(cleanPos1Url)) {
      return res.status(400).json({
        error: "pos1Url no es una URL válida."
      });
    }

    const cleanOption = Number(optionNumber || 1);
    const finalOption = cleanOption === 2 ? 2 : 1;

    const referenceUrls = sanitizeUrlList(styleReferenceUrls);

    const productImage = await fetchImageAsInlineData(cleanPos1Url, "POS1 del producto");

    const styleImages = [];

    for (let i = 0; i < referenceUrls.length; i++) {
      try {
        const image = await fetchImageAsInlineData(
          referenceUrls[i],
          `referencia visual ${i + 1}`
        );

        styleImages.push(image);
      } catch (error) {
        console.warn(`No se pudo usar referencia visual ${i + 1}:`, error.message);
      }
    }

    const imageInputs = [
      productImage,
      ...styleImages
    ];

    const finalPrompt = buildEnhancedPrompt({
      prompt: cleanPrompt,
      sku: cleanSku,
      finalOption,
      referenceCount: styleImages.length
    });

    const { data: geminiData, mode } = await callGemini({
      finalPrompt,
      imageInputs
    });

    const imagePart = extractImagePart(geminiData);

    if (!imagePart) {
      return res.status(500).json({
        error: "Gemini no devolvió ninguna imagen."
      });
    }

    const outputMimeType = normalizeMimeType(imagePart.inlineData.mimeType || "image/png");
    const imageBase64 = imagePart.inlineData.data;
    const fileName = buildOutputFileName(cleanSku, finalOption, outputMimeType);

    return res.status(200).json({
      ok: true,
      fileName,
      mimeType: outputMimeType,
      base64: imageBase64,
      configMode: mode,
      usedReferences: styleImages.length,
      model: MODEL_NAME
    });
  } catch (error) {
    console.error("generate-image error:", error);

    return res.status(error.status || 500).json({
      error: error.message || "Error interno del servidor.",
      mode: error.mode || undefined
    });
  }
}
