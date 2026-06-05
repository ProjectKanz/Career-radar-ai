import { useState } from 'react';
import { KeyRound, ExternalLink, ShieldCheck, Trash2, CheckCircle2 } from 'lucide-react';
import { clearStoredGeminiApiKey, getStoredGeminiApiKey, saveStoredGeminiApiKey } from '../utils/aiSettings';

export default function AISettingsPanel() {
  const [apiKey, setApiKey] = useState(() => getStoredGeminiApiKey());
  const [saved, setSaved] = useState(false);

  const maskedKey = apiKey
    ? `${apiKey.slice(0, 7)}...${apiKey.slice(-4)}`
    : 'No API key saved in this browser';

  const handleSave = () => {
    saveStoredGeminiApiKey(apiKey);
    setApiKey(getStoredGeminiApiKey());
    setSaved(true);
    window.setTimeout(() => setSaved(false), 2500);
  };

  const handleClear = () => {
    clearStoredGeminiApiKey();
    setApiKey('');
    setSaved(false);
  };

  return (
    <div id="ai_settings_panel" className="max-w-4xl mx-auto py-6 font-sans">
      <div className="md:flex md:items-center md:justify-between mb-8">
        <div className="flex-1 min-w-0">
          <h2 className="text-2xl font-bold text-slate-900 sm:text-3xl tracking-tight flex items-center space-x-2">
            <KeyRound className="h-7 w-7 text-emerald-600" />
            <span>AI Settings</span>
          </h2>
          <p className="mt-1 text-sm text-slate-500">
            Use Dry Run for free previews, or add your own Gemini API key when you want AI-generated matching and CV drafts.
          </p>
        </div>
      </div>

      <div className="space-y-6">
        <section className="rounded-2xl border border-slate-100 bg-white p-6 shadow-sm">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 className="text-lg font-bold text-slate-900">Gemini API Key</h3>
              <p className="mt-1 text-sm leading-relaxed text-slate-500">
                This key stays in your browser local storage and is sent only when you run an AI request. Do not use someone else's key.
              </p>
              <div className="mt-3 inline-flex items-center gap-2 rounded-lg bg-slate-50 px-3 py-1.5 text-xs font-semibold text-slate-600">
                <ShieldCheck className="h-4 w-4 text-emerald-600" />
                <span>{maskedKey}</span>
              </div>
            </div>
          </div>

          <div className="mt-5">
            <label className="block text-xs font-semibold uppercase tracking-wider text-slate-600 mb-1">
              Paste your Gemini API key
            </label>
            <input
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder="AIza..."
              className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm outline-none transition-all focus:bg-white focus:ring-1 focus:ring-emerald-500/50"
            />
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={handleSave}
              className="inline-flex items-center gap-2 rounded-xl bg-slate-900 px-4 py-2 text-xs font-bold text-white shadow-sm hover:bg-slate-700"
            >
              <CheckCircle2 className="h-4 w-4" />
              <span>Save key on this browser</span>
            </button>
            <button
              type="button"
              onClick={handleClear}
              className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2 text-xs font-bold text-slate-600 hover:bg-slate-50"
            >
              <Trash2 className="h-4 w-4" />
              <span>Remove key</span>
            </button>
            {saved && (
              <span className="text-xs font-semibold text-emerald-600">Saved. AI requests can now use your key.</span>
            )}
          </div>
        </section>

        <section className="rounded-2xl border border-emerald-100 bg-emerald-50/40 p-6">
          <h3 className="text-base font-bold text-slate-900">How to get a free Gemini API key</h3>
          <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm leading-relaxed text-slate-600">
            <li>Open Google AI Studio and sign in with your Google account.</li>
            <li>Go to the API keys page, accept the terms if asked, then choose create/get API key.</li>
            <li>Copy the key that starts with <span className="font-mono font-semibold">AIza</span>.</li>
            <li>Paste it here, save, then run Career Radar with Dry Run turned off.</li>
          </ol>
          <div className="mt-4 flex flex-wrap gap-3">
            <a
              href="https://aistudio.google.com/app/apikey"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 text-xs font-bold text-white hover:bg-emerald-700"
            >
              <ExternalLink className="h-4 w-4" />
              <span>Open Google AI Studio API Keys</span>
            </a>
            <a
              href="https://ai.google.dev/gemini-api/docs/api-key"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 rounded-xl border border-emerald-200 bg-white px-4 py-2 text-xs font-bold text-emerald-700 hover:bg-emerald-50"
            >
              <ExternalLink className="h-4 w-4" />
              <span>Official API key guide</span>
            </a>
          </div>
          <p className="mt-4 text-xs leading-relaxed text-slate-500">
            Google offers a Gemini API free tier for testing with limited quota. If you enable billing, usage may become paid depending on model and quota settings.
          </p>
        </section>

        <section className="rounded-2xl border border-amber-100 bg-amber-50/50 p-6">
          <h3 className="text-base font-bold text-amber-900">Public demo safety</h3>
          <p className="mt-2 text-sm leading-relaxed text-amber-800">
            Visitors can still use Dry Run and cached views without AI cost. Real AI generation requires their own Gemini API key.
          </p>
        </section>
      </div>
    </div>
  );
}
