export const DEFAULT_MEMORY_MODEL = "gpt-5.4-mini";

export function memoryLlmConfig(env = process.env) {
  const provider = String(env.WAKEFIELD_MEMORY_LLM || env.WAKEFIELD_LLM || "openai").trim().toLowerCase();
  const apiKey = env.WAKEFIELD_OPENAI_API_KEY || env.OPENAI_API_KEY || "";
  const model = env.WAKEFIELD_MEMORY_MODEL || DEFAULT_MEMORY_MODEL;
  const baseUrl = (env.WAKEFIELD_OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/g, "");
  return {
    provider,
    enabled: provider === "openai" && Boolean(apiKey),
    model,
    apiKey,
    baseUrl
  };
}

export async function createStructuredMemoryResponse({
  messages,
  schema,
  model = DEFAULT_MEMORY_MODEL,
  apiKey,
  baseUrl = "https://api.openai.com/v1",
  fetchImpl = fetch
}) {
  if (!apiKey) throw new Error("OPENAI_API_KEY is required for Wakefield memory capture.");
  const response = await fetchImpl(`${baseUrl.replace(/\/+$/g, "")}/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      input: messages,
      reasoning: {
        effort: "low"
      },
      text: {
        format: {
          type: "json_schema",
          name: "wakefield_memory_capture",
          strict: true,
          schema
        }
      }
    })
  });

  const body = await response.json().catch(async () => ({
    error: {
      message: await response.text().catch(() => "")
    }
  }));
  if (!response.ok) {
    const message = body?.error?.message || `OpenAI request failed with HTTP ${response.status}`;
    throw new Error(message);
  }

  const text = responseText(body);
  if (!text) throw new Error("OpenAI response did not include text output.");
  return JSON.parse(text);
}

function responseText(body) {
  if (typeof body?.output_text === "string") return body.output_text;
  const chunks = [];
  for (const item of body?.output || []) {
    for (const content of item?.content || []) {
      if (typeof content?.text === "string") chunks.push(content.text);
    }
  }
  return chunks.join("").trim();
}
