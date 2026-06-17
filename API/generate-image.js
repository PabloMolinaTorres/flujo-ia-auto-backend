const MODEL_NAME = process.env.GEMINI_MODEL || "gemini-3-pro-image";

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function buildPayload({ finalPrompt, inputMimeType, inputBase64 }, mode) {
  const base = {
    contents: [
      {
        parts: [
          { text: finalPrompt },
          {
            inlineData: {
              mimeType: inputMimeType,
              data: inputBase64
            }
          }
        ]
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

async function callGemini({ finalPrompt, inputMimeType, inputBase64 }) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME}:generateContent?key=${process.env.GEMINI_API_KEY}`;

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
      body: JSON.stringify(buildPayload({ finalPrompt, inputMimeType, inputBase64 }, mode))
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

function buildEnhancedPrompt({ prompt, sku, finalOption }) {
  const sceneDirection = finalOption === 1
    ? `
SCENE VARIANT 1:
Create a clean premium lifestyle composition. Use a modern, elegant, neutral setting with soft natural light. Keep the scene simple, polished, and commercial, similar to a high-end ecommerce hero image.`
    : `
SCENE VARIANT 2:
Create a warmer contextual lifestyle composition. Use a realistic home environment related to the product use, with tasteful props and depth, but without distracting from the product.`;

  return `
You are creating a professional ecommerce lifestyle image for a retail product.

SOURCE PRODUCT:
Use the attached product image as the strict visual reference. The product identity must remain the same.

PRODUCT BRIEF FROM THE TEAM:
${prompt}

CORE REQUIREMENTS:
- Preserve the product exactly from the reference image.
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

export default async function handler(req, res) {
  cors(res);

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Método no permitido." });
  }

  try {
    const {
      user,
      adminPin,
      sku,
      prompt,
      pos1Url,
      optionNumber
    } = req.body || {};

    if (user !== "Pablo") {
      return res.status(403).json({ error: "Solo Pablo puede usar la generación IA." });
    }

    if (!process.env.ADMIN_IA_PIN) {
      return res.status(500).json({ error: "Falta configurar ADMIN_IA_PIN en Vercel." });
    }

    if (adminPin !== process.env.ADMIN_IA_PIN) {
      return res.status(403).json({ error: "Clave IA incorrecta." });
    }

    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ error: "Falta configurar GEMINI_API_KEY en Vercel." });
    }

    if (!sku || !prompt || !pos1Url) {
      return res.status(400).json({ error: "Faltan datos obligatorios: sku, prompt o pos1Url." });
    }

    const cleanOption = Number(optionNumber || 1);
    const finalOption = cleanOption === 2 ? 2 : 1;

    const pos1Response = await fetch(pos1Url, {
      headers: {
        "User-Agent": "Mozilla/5.0 FlujoIA/1.0"
      }
    });

    if (!pos1Response.ok) {
      return res.status(400).json({
        error: `No se pudo descargar la referencia POS1. Estado: ${pos1Response.status}`
      });
    }

    const inputMimeType = pos1Response.headers.get("content-type") || "image/jpeg";
    const inputBuffer = Buffer.from(await pos1Response.arrayBuffer());
    const inputBase64 = inputBuffer.toString("base64");

    const finalPrompt = buildEnhancedPrompt({
      prompt,
      sku,
      finalOption
    });

    const { data: geminiData, mode } = await callGemini({
      finalPrompt,
      inputMimeType,
      inputBase64
    });

    const parts = geminiData?.candidates?.[0]?.content?.parts || [];
    const imagePart = parts.find(part => part?.inlineData?.data);

    if (!imagePart) {
      return res.status(500).json({
        error: "Gemini no devolvió ninguna imagen."
      });
    }

    const outputMimeType = imagePart.inlineData.mimeType || "image/png";
    const ext = outputMimeType.includes("jpeg") || outputMimeType.includes("jpg") ? "jpg" : "png";
    const imageBase64 = imagePart.inlineData.data;

    const fileName = `${sku}_${finalOption === 1 ? "005" : "006"}.${ext}`;

    return res.status(200).json({
      ok: true,
      fileName,
      mimeType: outputMimeType,
      base64: imageBase64,
      configMode: mode
    });
  } catch (error) {
    console.error("generate-image error:", error);

    return res.status(error.status || 500).json({
      error: error.message || "Error interno del servidor.",
      mode: error.mode || undefined
    });
  }
}
