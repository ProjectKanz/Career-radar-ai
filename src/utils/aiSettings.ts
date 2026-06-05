const GEMINI_API_KEY_STORAGE_KEY = 'careerRadarGeminiApiKey';

export function getStoredGeminiApiKey() {
  return localStorage.getItem(GEMINI_API_KEY_STORAGE_KEY) || '';
}

export function saveStoredGeminiApiKey(value: string) {
  const cleaned = value.trim();
  if (cleaned) {
    localStorage.setItem(GEMINI_API_KEY_STORAGE_KEY, cleaned);
  } else {
    localStorage.removeItem(GEMINI_API_KEY_STORAGE_KEY);
  }
}

export function clearStoredGeminiApiKey() {
  localStorage.removeItem(GEMINI_API_KEY_STORAGE_KEY);
}

export function hasStoredGeminiApiKey() {
  return Boolean(getStoredGeminiApiKey());
}

export function aiRequestHeaders(): HeadersInit {
  const apiKey = getStoredGeminiApiKey();
  return {
    'Content-Type': 'application/json',
    ...(apiKey ? { 'X-Gemini-API-Key': apiKey } : {})
  };
}
