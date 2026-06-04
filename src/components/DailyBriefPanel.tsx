import { useState, useEffect } from 'react';
import { Calendar, Edit2, Trash2, Save, Clock, HelpCircle, CheckCircle2, XSquare } from 'lucide-react';
import { collection, getDocsFromCache, getDocsFromServer, doc, updateDoc, deleteDoc } from 'firebase/firestore';
import { db, formatFirestoreServerError, handleFirestoreError, OperationType } from '../firebase';
import { DailyApplyBrief, BriefStatus } from '../types';

interface DailyBriefPanelProps {
  userId: string;
  refreshToken?: number;
}

const PIPELINE_STATUSES: BriefStatus[] = [
  'Not Applied',
  'Applied',
  'Rejected',
  'Withdrawn',
  'Closed',
  'Expired',
  'Cancelled'
];

const briefsCache = new Map<string, DailyApplyBrief[]>();

function sortBriefs(items: DailyApplyBrief[]) {
  return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export default function DailyBriefPanel({ userId, refreshToken = 0 }: DailyBriefPanelProps) {
  const [briefs, setBriefs] = useState<DailyApplyBrief[]>(() => briefsCache.get(userId) ?? []);
  const [loading, setLoading] = useState(() => !briefsCache.has(userId));
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editNotes, setEditNotes] = useState('');
  const [editStatus, setEditStatus] = useState<BriefStatus>('Not Applied');
  const [serverReadError, setServerReadError] = useState<string | null>(null);

  const briefsPath = `profiles/${userId}/daily_apply_briefs`;

  const fetchData = async (forceRefresh = false) => {
    if (forceRefresh) {
      briefsCache.delete(userId);
    }

    const cached = forceRefresh ? undefined : briefsCache.get(userId);
    if (cached) {
      setBriefs(cached);
      setLoading(false);
    } else {
      setBriefs([]);
      setLoading(true);
    }

    const briefsCollection = collection(db, briefsPath);
    try {
      setServerReadError(null);
      if (!cached) {
        try {
          const cachedSnap = await getDocsFromCache(briefsCollection);
          const cachedItems: DailyApplyBrief[] = [];
          cachedSnap.forEach((doc) => {
            cachedItems.push({ id: doc.id, ...doc.data() } as DailyApplyBrief);
          });
          if (cachedItems.length > 0) {
            const sortedCached = sortBriefs(cachedItems);
            briefsCache.set(userId, sortedCached);
            setBriefs(sortedCached);
            setLoading(false);
          }
        } catch (_) {
          // Cache miss is expected on first load.
        }
      }

      const qSnap = await getDocsFromServer(briefsCollection);
      const items: DailyApplyBrief[] = [];
      qSnap.forEach((doc) => {
        items.push({ id: doc.id, ...doc.data() } as DailyApplyBrief);
      });
      const sortedItems = sortBriefs(items);
      briefsCache.set(userId, sortedItems);
      setBriefs(sortedItems);
    } catch (err) {
      console.error('Error fetching apply briefs:', err);
      setServerReadError(formatFirestoreServerError(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData(refreshToken > 0);
  }, [userId, refreshToken]);

  const handleUpdate = async (id: string) => {
    const itemPath = `${briefsPath}/${id}`;
    try {
      await updateDoc(doc(db, briefsPath, id), {
        status: editStatus,
        userNotes: editNotes.trim(),
        updatedAt: new Date().toISOString()
      });
      const nextBriefs = briefs.map(b => b.id === id ? { ...b, status: editStatus, userNotes: editNotes.trim() } : b);
      briefsCache.set(userId, nextBriefs);
      setBriefs(nextBriefs);
      setEditingId(null);
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, itemPath);
    }
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm('Do you want to delete this track log?')) return;
    try {
      await deleteDoc(doc(db, briefsPath, id));
      const nextBriefs = briefs.filter(b => b.id !== id);
      briefsCache.set(userId, nextBriefs);
      setBriefs(nextBriefs);
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `${briefsPath}/${id}`);
    }
  };

  const getStatusBadgeClass = (status: BriefStatus) => {
    switch (status) {
      case 'Applied': return 'bg-emerald-50 text-emerald-700 border-emerald-100';
      case 'Not Applied': return 'bg-slate-100 text-slate-600 border-slate-200';
      case 'Rejected': return 'bg-rose-50 text-rose-700 border-rose-100';
      case 'Closed': case 'Expired': return 'bg-amber-50 text-amber-700 border-amber-100';
      default: return 'bg-slate-50 text-slate-400 border-slate-200';
    }
  };

  // Pipeline math summary counts
  const countByStatus = (status: BriefStatus) => briefs.filter(b => b.status === status).length;
  const appliedCount = countByStatus('Applied');
  const rejectedCount = countByStatus('Rejected');
  const pendingCount = countByStatus('Not Applied');
  const closedCount = countByStatus('Closed') + countByStatus('Expired');

  return (
    <div id="daily_brief_panel" className="py-6 font-sans">
      <div className="md:flex md:items-center md:justify-between mb-8">
        <div className="flex-1 min-w-0">
          <h2 className="text-2xl font-bold text-slate-900 sm:text-3xl tracking-tight flex items-center space-x-2">
            <Calendar className="h-7 w-7 text-emerald-600" />
            <span>Deployment & Sync Pipeline</span>
          </h2>
          <p className="mt-1 text-sm text-slate-500">
            Monitor submission pipelines, transitions, and log custom interaction notes (interviews, callbacks, links).
          </p>
        </div>
      </div>

      {loading && (
        <div className="mb-6 inline-flex items-center gap-2 text-xs font-semibold text-slate-400">
          <span className="h-3.5 w-3.5 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin"></span>
          <span>Loading latest pipeline tracker logs...</span>
        </div>
      )}

      {serverReadError && (
        <div className="mb-6 rounded-2xl border border-rose-100 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          <div className="font-bold text-rose-900">Firestore server read failed</div>
          <div className="mt-1">{serverReadError}</div>
        </div>
      )}

      {/* Visual Funnel Cards standard dashboard */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        <div className="bg-white border border-slate-100 rounded-2xl p-4 shadow-sm flex items-center space-x-3.5">
          <div className="p-3 bg-slate-50 rounded-xl text-slate-500"><Clock className="h-6 w-6" /></div>
          <div>
            <div className="text-2xl font-black text-slate-800 tracking-tight">{pendingCount}</div>
            <div className="text-[10px] uppercase font-bold text-slate-400">Not Applied</div>
          </div>
        </div>

        <div className="bg-white border border-slate-100 rounded-2xl p-4 shadow-sm flex items-center space-x-3.5">
          <div className="p-3 bg-emerald-50 rounded-xl text-emerald-600"><CheckCircle2 className="h-6 w-6" /></div>
          <div>
            <div className="text-2xl font-black text-slate-800 tracking-tight">{appliedCount}</div>
            <div className="text-[10px] uppercase font-bold text-slate-400 font-medium">Applied Successfully</div>
          </div>
        </div>

        <div className="bg-white border border-slate-100 rounded-2xl p-4 shadow-sm flex items-center space-x-3.5">
          <div className="p-3 bg-rose-50 rounded-xl text-rose-500"><XSquare className="h-6 w-6" /></div>
          <div>
            <div className="text-2xl font-black text-slate-800 tracking-tight">{rejectedCount}</div>
            <div className="text-[10px] uppercase font-bold text-slate-400">Rejected</div>
          </div>
        </div>

        <div className="bg-white border border-slate-100 rounded-2xl p-4 shadow-sm flex items-center space-x-3.5">
          <div className="p-3 bg-amber-50 rounded-xl text-amber-500"><HelpCircle className="h-6 w-6" /></div>
          <div>
            <div className="text-2xl font-black text-slate-800 tracking-tight">{closedCount}</div>
            <div className="text-[10px] uppercase font-bold text-slate-400">Closed/Expired</div>
          </div>
        </div>
      </div>

      {!loading && briefs.length === 0 ? (
        <div className="text-center py-16 bg-white border border-slate-100 rounded-2xl">
          <Calendar className="h-12 w-12 text-slate-300 mx-auto mb-3" />
          <p className="text-sm text-slate-500">Pipeline logs are currently empty.</p>
          <p className="text-xs text-slate-400 mt-1">Matched jobs saved using <strong>AI Career Radar</strong> will automatically append to this pipeline.</p>
        </div>
      ) : (
        <div className="bg-white border border-slate-100 rounded-2xl overflow-hidden shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-100 text-xs font-bold uppercase tracking-wider text-slate-400">
                  <th className="py-4 px-6">Company & Role</th>
                  <th className="py-4 px-6">Fit Score</th>
                  <th className="py-4 px-6">Stage Status</th>
                  <th className="py-4 px-6">Interaction Logs / Personal Notes</th>
                  <th className="py-4 px-6 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {briefs.map((opp) => {
                  const isEditing = editingId === opp.id;

                  return (
                    <tr key={opp.id} className="hover:bg-slate-50/50 transition-colors text-sm font-normal text-slate-600">
                      <td className="py-4 px-6">
                        <div className="font-bold text-slate-800">{opp.role}</div>
                        <div className="text-xs text-slate-400 font-medium">{opp.company}</div>
                      </td>
                      <td className="py-4 px-6">
                        <span className={`inline-block font-mono font-bold px-2 py-0.5 rounded text-xs ${
                          opp.fitScore >= 85 ? 'text-emerald-700 bg-emerald-50' :
                          opp.fitScore >= 65 ? 'text-amber-700 bg-amber-50' : 'text-rose-700 bg-rose-50'
                        }`}>
                          {opp.fitScore}%
                        </span>
                      </td>
                      <td className="py-4 px-6">
                        {isEditing ? (
                          <select
                            value={editStatus}
                            onChange={(e) => setEditStatus(e.target.value as BriefStatus)}
                            className="text-xs border border-slate-200 bg-white rounded-lg px-2.5 py-1 focus:ring-1 focus:ring-emerald-500/50 outline-none"
                          >
                            {PIPELINE_STATUSES.map(st => (
                              <option key={st} value={st}>{st}</option>
                            ))}
                          </select>
                        ) : (
                          <span className={`inline-block border text-xs font-bold px-2.5 py-0.5 rounded-full ${getStatusBadgeClass(opp.status)}`}>
                            {opp.status}
                          </span>
                        )}
                      </td>
                      <td className="py-4 px-6 max-w-sm">
                        {isEditing ? (
                          <input
                            type="text"
                            placeholder="Add interview dates, key callback contacts..."
                            value={editNotes}
                            onChange={(e) => setEditNotes(e.target.value)}
                            className="w-full text-xs border border-slate-200 bg-white rounded-lg px-3 py-1.5 focus:ring-1 focus:ring-emerald-500 shadow-sm outline-none"
                          />
                        ) : (
                          <div className="text-xs italic text-slate-500 leading-normal line-clamp-2">
                            {opp.userNotes || 'No custom interaction logs recorded.'}
                          </div>
                        )}
                      </td>
                      <td className="py-4 px-6 text-right">
                        <div className="flex justify-end gap-2">
                          {isEditing ? (
                            <button
                              onClick={() => handleUpdate(opp.id || '')}
                              className="p-1 px-2.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-bold inline-flex items-center gap-1 cursor-pointer"
                            >
                              <Save className="h-3 w-3" />
                              <span>Save</span>
                            </button>
                          ) : (
                            <button
                              onClick={() => {
                                setEditingId(opp.id || null);
                                setEditNotes(opp.userNotes || '');
                                setEditStatus(opp.status);
                              }}
                              className="p-1.5 text-slate-400 hover:text-emerald-600 hover:bg-slate-100 rounded-lg transition-colors cursor-pointer"
                              title="Edit tracking log"
                            >
                              <Edit2 className="h-4 w-4" />
                            </button>
                          )}
                          <button
                            onClick={() => handleDelete(opp.id || '')}
                            className="p-1.5 text-slate-400 hover:text-rose-500 hover:bg-slate-100 rounded-lg transition-colors cursor-pointer"
                            title="Delete track item"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
