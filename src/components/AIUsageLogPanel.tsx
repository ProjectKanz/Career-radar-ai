import { useEffect, useState } from 'react';
import { Activity, AlertTriangle, CheckCircle2, RefreshCw } from 'lucide-react';

interface AiUsageLogEntry {
  id: string;
  timestamp: string;
  featureName: string;
  company?: string;
  role?: string;
  opportunityId?: string;
  endpointName: string;
  model: string;
  inputCharacterCount: number;
  outputCharacterCount: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedTotalTokens: number;
  tokenCountSource: 'sdk' | 'estimated';
  durationMs: number;
  cacheStatus?: 'miss' | 'hit' | 'dry_run' | 'blocked';
  status: 'success' | 'error';
  errorMessage?: string;
}

export default function AIUsageLogPanel() {
  const [entries, setEntries] = useState<AiUsageLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchEntries = async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await fetch('/api/ai-usage-log');
      if (!response.ok) {
        throw new Error('Failed to load AI usage log.');
      }

      const data = await response.json();
      setEntries(Array.isArray(data.entries) ? data.entries : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchEntries();
    const interval = window.setInterval(fetchEntries, 15000);
    return () => window.clearInterval(interval);
  }, []);

  // Calculate savings
  const sessionBypasses = entries.filter(
    (e) => e.endpointName === '/api/generate-cv-template' && e.status === 'success' && e.cacheStatus !== 'dry_run'
  ).length;
  const sessionSavings = sessionBypasses * 1200;

  // Read lifetime savings from localStorage
  const lifetimeBypasses = Number(localStorage.getItem('careerRadarLocalCvBypasses') || 0);
  const lifetimeSavings = lifetimeBypasses * 1200;

  return (
    <div id="ai_usage_log_panel" className="py-6 font-sans">
      <div className="md:flex md:items-center md:justify-between mb-8">
        <div className="flex-1 min-w-0">
          <h2 className="text-2xl font-bold text-slate-900 sm:text-3xl tracking-tight flex items-center space-x-2">
            <Activity className="h-7 w-7 text-emerald-600" />
            <span>AI Usage Log</span>
          </h2>
          <p className="mt-1 text-sm text-slate-500">
            Track Gemini calls and local CV placeholder mapping runs for matching, application packs, and checklist workflows.
          </p>
        </div>

        <button
          type="button"
          onClick={fetchEntries}
          disabled={loading}
          className="mt-4 md:mt-0 inline-flex items-center gap-2 px-3 py-2 bg-white border border-slate-200 hover:bg-slate-50 disabled:bg-slate-100 rounded-xl text-xs font-bold text-slate-600"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          <span>Refresh</span>
        </button>
      </div>

      {/* Cost Savings Cards */}
      <div className="mb-6 grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="p-5 bg-emerald-50 border border-emerald-100 rounded-2xl flex items-center gap-4">
          <div className="p-3 bg-emerald-600 text-white rounded-xl shadow-sm">
            <Activity className="h-6 w-6" />
          </div>
          <div>
            <div className="text-xs font-bold text-emerald-800 uppercase tracking-wide">Current Session Savings</div>
            <div className="text-lg font-extrabold text-slate-900 mt-1">
              Estimated Rp {sessionSavings.toLocaleString('id-ID')} avoided by local mapping
            </div>
            <div className="text-[10px] text-emerald-600 font-semibold mt-0.5">
              ({sessionBypasses} local CV template runs in this session)
            </div>
          </div>
        </div>

        <div className="p-5 bg-blue-50 border border-blue-100 rounded-2xl flex items-center gap-4">
          <div className="p-3 bg-blue-600 text-white rounded-xl shadow-sm">
            <CheckCircle2 className="h-6 w-6" />
          </div>
          <div>
            <div className="text-xs font-bold text-blue-800 uppercase tracking-wide">Lifetime Cost Savings</div>
            <div className="text-lg font-extrabold text-slate-900 mt-1">
              Estimated Rp {lifetimeSavings.toLocaleString('id-ID')} avoided in total
            </div>
            <div className="text-[10px] text-blue-600 font-semibold mt-0.5">
              ({lifetimeBypasses} total CV templates tailormade)
            </div>
          </div>
        </div>
      </div>

      {error && (
        <div className="mb-4 rounded-xl border border-rose-100 bg-rose-50 px-4 py-3 text-xs font-semibold text-rose-700">
          {error}
        </div>
      )}

      <div className="bg-white border border-slate-100 rounded-2xl shadow-sm overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
          <div>
            <h3 className="text-sm font-bold text-slate-800">AI and Local Mapping Usage</h3>
            <p className="text-xs text-slate-400 mt-0.5">Showing the latest {entries.length} recorded calls.</p>
          </div>
        </div>

        {loading && entries.length === 0 ? (
          <div className="p-8 text-sm text-slate-400 flex items-center gap-2">
            <RefreshCw className="h-4 w-4 animate-spin text-emerald-600" />
            <span>Loading AI usage log...</span>
          </div>
        ) : entries.length === 0 ? (
          <div className="p-8 text-sm text-slate-400">
            No usage events recorded in this server session yet.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-100 text-left">
              <thead className="bg-slate-50">
                <tr>
                  <th className="px-4 py-3 text-[10px] font-bold uppercase tracking-widest text-slate-400">Time</th>
                  <th className="px-4 py-3 text-[10px] font-bold uppercase tracking-widest text-slate-400">Feature</th>
                  <th className="px-4 py-3 text-[10px] font-bold uppercase tracking-widest text-slate-400">Company / Role</th>
                  <th className="px-4 py-3 text-[10px] font-bold uppercase tracking-widest text-slate-400">Endpoint</th>
                  <th className="px-4 py-3 text-[10px] font-bold uppercase tracking-widest text-slate-400">Chars / Tokens</th>
                  <th className="px-4 py-3 text-[10px] font-bold uppercase tracking-widest text-slate-400">Cache</th>
                  <th className="px-4 py-3 text-[10px] font-bold uppercase tracking-widest text-slate-400">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {entries.map((entry) => (
                  <tr key={entry.id} className="align-top">
                    <td className="px-4 py-3 text-xs text-slate-500 whitespace-nowrap">
                      {new Date(entry.timestamp).toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-xs font-bold text-slate-700">
                      {entry.featureName}
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-500 min-w-56">
                      <div className="font-semibold text-slate-700">{entry.company || '-'}</div>
                      <div>{entry.role || '-'}</div>
                    </td>
                    <td className="px-4 py-3 text-xs font-mono text-slate-500">
                      <div>{entry.endpointName}</div>
                      <div className="mt-1 text-[10px] text-slate-400">{entry.model || '-'}</div>
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-500 whitespace-nowrap">
                      <div>In: {entry.inputCharacterCount.toLocaleString()} chars</div>
                      <div>Out: {(entry.outputCharacterCount || 0).toLocaleString()} chars</div>
                      <div className="mt-1 font-mono text-[11px]">
                        ~{(entry.estimatedTotalTokens || 0).toLocaleString()} tokens ({entry.tokenCountSource || 'estimated'})
                      </div>
                      <div className="text-[10px] text-slate-400">{entry.durationMs || 0} ms</div>
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-500 whitespace-nowrap">
                      <span className="rounded-full bg-slate-100 px-2 py-1 font-bold text-slate-600">
                        {entry.cacheStatus || 'miss'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs min-w-48">
                      <div className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-full font-bold ${
                        entry.status === 'success'
                          ? 'bg-emerald-50 text-emerald-700'
                          : 'bg-rose-50 text-rose-700'
                      }`}>
                        {entry.status === 'success' ? (
                          <CheckCircle2 className="h-3.5 w-3.5" />
                        ) : (
                          <AlertTriangle className="h-3.5 w-3.5" />
                        )}
                        <span>{entry.status}</span>
                      </div>
                      {entry.errorMessage && (
                        <p className="mt-2 text-rose-600 leading-relaxed">{entry.errorMessage}</p>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
