import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function projectId() {
  const value = process.env.GOOGLE_CLOUD_PROJECT;
  if (!value || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(value)) {
    throw new Error('尚未設定 Google Cloud 專案。');
  }
  return value;
}

async function accessToken() {
  const localAppData = process.env.LOCALAPPDATA;
  const gcloudPath = localAppData
    ? `${localAppData}\\Google\\Cloud SDK\\google-cloud-sdk\\bin\\gcloud.cmd`
    : 'gcloud.cmd';
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      // Invoke the Windows .cmd launcher through PowerShell without enabling
      // Node's shell option, which concatenates arguments unsafely.
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `& '${gcloudPath.replace(/'/g, "''")}' auth application-default print-access-token`,
      ],
      {
        windowsHide: true,
        timeout: 15_000,
        maxBuffer: 16_384,
      },
    );
    const token = stdout.trim();
    if (!token) throw new Error('Google Cloud 沒有回傳登入憑證。');
    return token;
  } catch {
    throw new Error(
      '尚未完成 Google Cloud 本機驗證。請重新執行 gcloud auth application-default login。',
    );
  }
}

export async function generateFlightAssistantJson<T>(
  prompt: string,
  schema: Record<string, unknown>,
): Promise<T> {
  const project = projectId();
  const location = process.env.GOOGLE_CLOUD_LOCATION || 'global';
  const model = process.env.GOOGLE_VERTEX_MODEL || 'gemini-2.5-flash';
  const version = process.env.GOOGLE_VERTEX_API_VERSION || 'v1';
  const token = await accessToken();
  const endpoint = `https://aiplatform.googleapis.com/${version}/projects/${project}/locations/${location}/publishers/google/models/${model}:generateContent`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: schema,
        maxOutputTokens: 256,
        temperature: 0.1,
        thinkingConfig: { thinkingBudget: 0 },
      },
    }),
    signal: AbortSignal.timeout(45_000),
    cache: 'no-store',
  });
  const data = (await response.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
    error?: { message?: string };
  };
  if (!response.ok) {
    console.error(
      '[flight-assistant] Vertex AI request failed:',
      response.status,
    );
    throw new Error(
      response.status === 401 || response.status === 403
        ? 'Google Cloud 尚未授權此模型，請確認 Vertex AI API、專案權限與帳單設定。'
        : 'AI 助理暫時無法回覆，請稍後再試。',
    );
  }
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('AI 助理沒有產生可用的查詢條件。');
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error('AI 助理回傳格式無法辨識，請換個方式描述日期與目的地。');
  }
}
