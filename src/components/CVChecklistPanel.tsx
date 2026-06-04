import { useState, useEffect } from 'react';
import { CheckSquare, Square, Clipboard, Check, Building, Trash2 } from 'lucide-react';
import { collection, getDocsFromCache, getDocsFromServer, doc, updateDoc, deleteDoc } from 'firebase/firestore';
import { db, formatFirestoreServerError, handleFirestoreError, OperationType } from '../firebase';
import { CVEditChecklist } from '../types';

interface CVChecklistPanelProps {
  userId: string;
  refreshToken?: number;
}

const checklistCache = new Map<string, CVEditChecklist[]>();

function sortChecklists(items: CVEditChecklist[]) {
  return items.sort((a, b) => {
    if (a.isDone !== b.isDone) return a.isDone ? 1 : -1;
    const prioMap: { [key: string]: number } = { High: 3, Medium: 2, Low: 1 };
    return (prioMap[b.priority || 'Medium'] || 2) - (prioMap[a.priority || 'Medium'] || 2);
  });
}

export default function CVChecklistPanel({ userId, refreshToken = 0 }: CVChecklistPanelProps) {
  const [checklists, setChecklists] = useState<CVEditChecklist[]>(() => checklistCache.get(userId) ?? []);
  const [loading, setLoading] = useState(() => !checklistCache.has(userId));
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [serverReadError, setServerReadError] = useState<string | null>(null);

  const checklistPath = `profiles/${userId}/cv_checklists`;

  const fetchData = async (forceRefresh = false) => {
    if (forceRefresh) {
      checklistCache.delete(userId);
    }

    const cached = forceRefresh ? undefined : checklistCache.get(userId);
    if (cached) {
      setChecklists(cached);
      setLoading(false);
    } else {
      setChecklists([]);
      setLoading(true);
    }

    const checklistCollection = collection(db, checklistPath);
    try {
      setServerReadError(null);
      if (!cached) {
        try {
          const cachedSnap = await getDocsFromCache(checklistCollection);
          const cachedItems: CVEditChecklist[] = [];
          cachedSnap.forEach((doc) => {
            cachedItems.push({ id: doc.id, ...doc.data() } as CVEditChecklist);
          });
          if (cachedItems.length > 0) {
            const sortedCached = sortChecklists(cachedItems);
            checklistCache.set(userId, sortedCached);
            setChecklists(sortedCached);
            setLoading(false);
          }
        } catch (_) {
          // Cache miss is expected on first load.
        }
      }

      const qSnap = await getDocsFromServer(checklistCollection);
      const items: CVEditChecklist[] = [];
      qSnap.forEach((doc) => {
        items.push({ id: doc.id, ...doc.data() } as CVEditChecklist);
      });
      const sortedItems = sortChecklists(items);
      checklistCache.set(userId, sortedItems);
      setChecklists(sortedItems);
    } catch (err) {
      console.error('Error fetching CV checklists:', err);
      setServerReadError(formatFirestoreServerError(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData(refreshToken > 0);
  }, [userId, refreshToken]);

  const toggleDone = async (item: CVEditChecklist) => {
    if (!item.id) return;
    const itemRef = doc(db, checklistPath, item.id);
    const newStatus = !item.isDone;

    try {
      await updateDoc(itemRef, { isDone: newStatus, updatedAt: new Date().toISOString() });
      const nextChecklists = sortChecklists(checklists.map((c) => (c.id === item.id ? { ...c, isDone: newStatus } : c)));
      checklistCache.set(userId, nextChecklists);
      setChecklists(nextChecklists);
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `${checklistPath}/${item.id}`);
    }
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm('Do you want to delete this checklist recommendation?')) return;
    try {
      await deleteDoc(doc(db, checklistPath, id));
      const nextChecklists = checklists.filter((c) => c.id !== id);
      checklistCache.set(userId, nextChecklists);
      setChecklists(nextChecklists);
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `${checklistPath}/${id}`);
    }
  };

  const copyText = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const pendingCount = checklists.filter(c => !c.isDone).length;

  return (
    <div id="cv_checklist_panel" className="py-6 font-sans">
      <div className="md:flex md:items-center md:justify-between mb-8">
        <div className="flex-1 min-w-0">
          <h2 className="text-2xl font-bold text-slate-900 sm:text-3xl tracking-tight flex items-center space-x-2">
            <CheckSquare className="h-7 w-7 text-emerald-600" />
            <span>CV Tailoring Checklist</span>
          </h2>
          <p className="mt-1 text-sm text-slate-500">
            A precise workflow tracking exactly how to update your CV sections before applying, ensuring high grounding sync on ATS screens.
          </p>
        </div>
        <div className="mt-4 md:mt-0 flex items-center space-x-1.5 bg-emerald-50 border border-emerald-100 text-emerald-800 px-3.5 py-1.5 rounded-xl text-xs font-bold shadow-sm">
          <span>{pendingCount} adjustments remaining</span>
        </div>
      </div>

      {loading && (
        <div className="mb-6 inline-flex items-center gap-2 text-xs font-semibold text-slate-400">
          <span className="h-3.5 w-3.5 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin"></span>
          <span>Loading latest resume tailoring items...</span>
        </div>
      )}

      {serverReadError && (
        <div className="mb-6 rounded-2xl border border-rose-100 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          <div className="font-bold text-rose-900">Firestore server read failed</div>
          <div className="mt-1">{serverReadError}</div>
        </div>
      )}

      {!loading && checklists.length === 0 ? (
        <div className="text-center py-16 bg-white border border-slate-100 rounded-2xl">
          <CheckSquare className="h-12 w-12 text-slate-300 mx-auto mb-3" />
          <p className="text-sm text-slate-500">No customizations populated yet.</p>
          <p className="text-xs text-slate-400 mt-1">Run any job comparison matching inside <strong>AI Career Radar</strong> to auto-populate tactical edit checklists.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {checklists.map((item) => (
            <div
              key={item.id}
              className={`bg-white border rounded-2xl p-5 shadow-sm transition-all flex flex-col md:flex-row gap-5 items-start justify-between ${
                item.isDone ? 'opacity-60 border-slate-100 bg-slate-50/30' : 'border-slate-100 hover:border-slate-200'
              }`}
            >
              <div className="flex items-start space-x-4 w-full md:max-w-3xl">
                {/* Custom Tick Checkbox */}
                <button
                  onClick={() => toggleDone(item)}
                  className="mt-1 p-1 hover:bg-slate-50 rounded-lg transition-colors cursor-pointer text-slate-400 hover:text-emerald-600 shrink-0"
                >
                  {item.isDone ? (
                    <CheckSquare className="h-6 w-6 text-emerald-600 fill-emerald-50" />
                  ) : (
                    <Square className="h-6 w-6 hover:border-emerald-600" />
                  )}
                </button>

                <div className="space-y-1 w-full">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[10px] font-extrabold uppercase tracking-widest text-slate-400 bg-slate-50 px-2.5 py-0.5 rounded">
                      {item.cvSection}
                    </span>
                    <span className={`text-[9px] font-bold px-2 py-0.5 rounded uppercase tracking-wide ${
                      item.priority === 'High' ? 'bg-rose-50 text-rose-600' :
                      item.priority === 'Medium' ? 'bg-amber-50 text-amber-600' : 'bg-slate-100 text-slate-400'
                    }`}>
                      {item.priority} priority
                    </span>
                    {item.company && (
                      <span className="text-xs font-semibold text-slate-500 inline-flex items-center">
                        <Building className="h-3 w-3 mr-1 text-slate-300" />
                        <span>For {item.company}</span>
                      </span>
                    )}
                    {item.evidenceId && (
                      <span className="text-[10px] font-mono font-bold bg-emerald-50 text-emerald-700 px-2 py-0.5 rounded">
                        Grounding fact: {item.evidenceId}
                      </span>
                    )}
                  </div>

                  <h4 className={`text-base font-bold tracking-tight ${item.isDone ? 'line-through text-slate-400' : 'text-slate-800'}`}>
                    {item.editType}
                  </h4>

                  <p className="text-xs text-slate-400 leading-normal font-medium max-w-2xl">
                    Why: <span className="text-slate-500">{item.whyTheChangeMatters}</span>
                  </p>

                  {/* Ground reference details if visible */}
                  {item.sourceEvidence && (
                    <p className="text-[11px] text-slate-400 font-normal italic leading-relaxed my-2 bg-slate-50/50 p-2.5 rounded-lg border border-slate-100">
                      Ground info: {item.sourceEvidence}
                    </p>
                  )}

                  {/* Action Copy Segment */}
                  <div className="relative mt-4 bg-slate-800 text-slate-100 text-xs font-mono p-3 rounded-xl flex items-center justify-between overflow-x-auto">
                    <span className="leading-relaxed select-all pr-4">{item.finalSuggestedText}</span>
                    <button
                      onClick={() => copyText(item.finalSuggestedText, item.id || '')}
                      className="p-1.5 bg-slate-705 bg-slate-700 hover:bg-slate-600 rounded-lg text-white transition-colors shrink-0"
                      title="Copy suggested replacement"
                    >
                      {copiedId === item.id ? (
                        <Check className="h-3.5 w-3.5 text-emerald-400" />
                      ) : (
                        <Clipboard className="h-3.5 w-3.5" />
                      )}
                    </button>
                  </div>
                </div>
              </div>

              <div className="md:self-center shrink-0">
                <button
                  onClick={() => handleDelete(item.id || '')}
                  className="p-1.5 text-slate-400 hover:text-rose-500 hover:bg-slate-50 border border-slate-100 rounded-lg transition-colors cursor-pointer"
                  title="Remove Checklist recommendation"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
