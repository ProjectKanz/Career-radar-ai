import React, { useState, useEffect } from 'react';
import { Award, Plus, Trash2, Edit2, ShieldCheck, X } from 'lucide-react';
import { collection, query, getDocsFromCache, getDocsFromServer, doc, setDoc, deleteDoc } from 'firebase/firestore';
import { db, formatFirestoreServerError, handleFirestoreError, OperationType } from '../firebase';
import { CVEvidence } from '../types';

interface EvidenceBankPanelProps {
  userId: string;
}

const CATEGORIES = [
  'Work Achievement',
  'Academic Honor',
  'Side Project / Portfolio',
  'Certification',
  'Hard Skill / Technical Fact',
  'Other Highlight'
];

const evidencesCache = new Map<string, CVEvidence[]>();

function sortEvidences(items: CVEvidence[]) {
  return items.sort((a, b) => a.evidenceId.localeCompare(b.evidenceId, undefined, { numeric: true, sensitivity: 'base' }));
}

export default function EvidenceBankPanel({ userId }: EvidenceBankPanelProps) {
  const [evidences, setEvidences] = useState<CVEvidence[]>(() => evidencesCache.get(userId) ?? []);
  const [loading, setLoading] = useState(() => !evidencesCache.has(userId));
  const [isAdding, setIsAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [serverReadError, setServerReadError] = useState<string | null>(null);

  // Form states
  const [evidenceId, setEvidenceId] = useState('');
  const [category, setCategory] = useState(CATEGORIES[0]);
  const [title, setTitle] = useState('');
  const [organization, setOrganization] = useState('');
  const [description, setDescription] = useState('');
  const [isVerified, setIsVerified] = useState(true);

  const [activeFilter, setActiveFilter] = useState('All');

  const cvEvidencesPath = `profiles/${userId}/cv_evidences`;

  const fetchEvidences = async () => {
    const cached = evidencesCache.get(userId);
    if (cached) {
      setEvidences(cached);
      setLoading(false);
    } else {
      setEvidences([]);
      setLoading(true);
    }

    const q = query(collection(db, cvEvidencesPath));
    try {
      setServerReadError(null);
      if (!cached) {
        try {
          const cachedSnapshot = await getDocsFromCache(q);
          const cachedItems: CVEvidence[] = [];
          cachedSnapshot.forEach((doc) => {
            cachedItems.push({ id: doc.id, ...doc.data() } as CVEvidence);
          });
          if (cachedItems.length > 0) {
            const sortedCached = sortEvidences(cachedItems);
            evidencesCache.set(userId, sortedCached);
            setEvidences(sortedCached);
            setLoading(false);
          }
        } catch (_) {
          // Cache miss is expected on first load.
        }
      }

      const querySnapshot = await getDocsFromServer(q);
      const items: CVEvidence[] = [];
      querySnapshot.forEach((doc) => {
        items.push({ id: doc.id, ...doc.data() } as CVEvidence);
      });
      const sortedItems = sortEvidences(items);
      evidencesCache.set(userId, sortedItems);
      setEvidences(sortedItems);
    } catch (err) {
      console.error('Error fetching CV evidences:', err);
      setServerReadError(formatFirestoreServerError(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchEvidences();
  }, [userId]);

  const resetForm = () => {
    // Generate a default ID based on category and existing items
    const prefix = category.startsWith('Work') ? 'WRK' : category.startsWith('Academic') ? 'ACAD' : category.startsWith('Side') ? 'PRJ' : 'CERT';
    const count = evidences.filter(e => e.evidenceId.startsWith(prefix)).length + 1;
    setEvidenceId(`${prefix}-${String(count).padStart(2, '0')}`);
    
    setTitle('');
    setOrganization('');
    setDescription('');
    setIsVerified(true);
    setCategory(CATEGORIES[0]);
    setIsAdding(false);
    setEditingId(null);
  };

  const handleCreateOrUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!evidenceId || !title || !description) return;

    const docId = editingId || doc(collection(db, cvEvidencesPath)).id;
    const itemPath = `${cvEvidencesPath}/${docId}`;

    const payload: CVEvidence = {
      evidenceId: evidenceId.toUpperCase().trim(),
      category,
      title: title.trim(),
      organization: organization.trim(),
      description: description.trim(),
      isVerified,
      createdAt: editingId ? (evidences.find(e => e.id === editingId)?.createdAt || new Date().toISOString()) : new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    try {
      await setDoc(doc(db, cvEvidencesPath, docId), payload);
      await fetchEvidences();
      resetForm();
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, itemPath);
    }
  };

  const handleEdit = (item: CVEvidence) => {
    setEditingId(item.id || null);
    setEvidenceId(item.evidenceId);
    setCategory(item.category);
    setTitle(item.title);
    setOrganization(item.organization || '');
    setDescription(item.description);
    setIsVerified(item.isVerified);
    setIsAdding(true);
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm('Are you sure you want to delete this evidence record?')) return;
    const itemPath = `${cvEvidencesPath}/${id}`;
    try {
      await deleteDoc(doc(db, cvEvidencesPath, id));
      await fetchEvidences();
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, itemPath);
    }
  };

  const filteredEvidences = activeFilter === 'All' 
    ? evidences 
    : evidences.filter(e => e.category === activeFilter);

  const showEmptyState = !loading && filteredEvidences.length === 0;

  return (
    <div id="evidence_panel" className="py-6 font-sans">
      <div className="md:flex md:items-center md:justify-between mb-8">
        <div className="flex-1 min-w-0">
          <h2 className="text-2xl font-bold text-slate-900 sm:text-3xl tracking-tight flex items-center space-x-2">
            <Award className="h-7 w-7 text-emerald-600 animate-pulse" />
            <span>CV Evidence Fact-Bank</span>
          </h2>
          <p className="mt-1 text-sm text-slate-500">
            A secure repository of immutable, verifiable highlights, project metrics, and certs. The AI uses this list of grounding parameters to back up personalized resume drafts.
          </p>
        </div>
        <div className="mt-4 md:mt-0">
          <button
            onClick={() => { resetForm(); setIsAdding(true); }}
            className="inline-flex items-center px-4 py-2 bg-emerald-600 text-white rounded-xl text-sm font-semibold hover:bg-emerald-700 shadow transition-all cursor-pointer"
          >
            <Plus className="h-4 w-4 mr-1.5" />
            <span>Add Ground Evidence</span>
          </button>
        </div>
      </div>

      {loading && (
        <div className="mb-6 inline-flex items-center gap-2 text-xs font-semibold text-slate-400">
          <span className="h-3.5 w-3.5 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin"></span>
          <span>Loading latest evidence records...</span>
        </div>
      )}

      {serverReadError && (
        <div className="mb-6 rounded-2xl border border-rose-100 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          <div className="font-bold text-rose-900">Firestore server read failed</div>
          <div className="mt-1">{serverReadError}</div>
        </div>
      )}

      {/* Adding / Editing Modal or inline form */}
      {isAdding && (
        <div className="bg-white border border-emerald-100 shadow-xl shadow-emerald-50/20 rounded-2xl p-6 mb-8 relative animate-fade-in">
          <button 
            type="button" 
            onClick={resetForm}
            className="absolute top-4 right-4 text-slate-400 hover:text-slate-600 cursor-pointer"
          >
            <X className="h-5 w-5" />
          </button>

          <h3 className="text-lg font-bold text-slate-800 mb-4 flex items-center space-x-2">
            <ShieldCheck className="h-5 w-5 text-emerald-600" />
            <span>{editingId ? 'Edit Evidence Record' : 'Record New Verifiable Highlight'}</span>
          </h3>

          <form onSubmit={handleCreateOrUpdate} className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-xs font-semibold text-slate-600 uppercase mb-1">Evidence ID Code</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. CSA-01, PRJ-04"
                  value={evidenceId}
                  onChange={(e) => setEvidenceId(e.target.value)}
                  className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 bg-slate-50 outline-none focus:bg-white focus:ring-1 focus:ring-emerald-500/50"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-600 uppercase mb-1">Category Group</label>
                <select
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 bg-slate-50 outline-none focus:bg-white focus:ring-1 focus:ring-emerald-500/50"
                >
                  {CATEGORIES.map(cat => (
                    <option key={cat} value={cat}>{cat}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-600 uppercase mb-1">Institution/Organization</label>
                <input
                  type="text"
                  placeholder="e.g. Google, ITB, Gojek"
                  value={organization}
                  onChange={(e) => setOrganization(e.target.value)}
                  className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 bg-slate-50 outline-none focus:bg-white focus:ring-1 focus:ring-emerald-500/50"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-600 uppercase mb-1">Title / Title of Accomplishment</label>
              <input
                type="text"
                required
                placeholder="e.g. Cloud Security Associate certificate, Lead Android Migration Developer"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 bg-slate-50 outline-none focus:bg-white focus:ring-1 focus:ring-emerald-500/50"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-600 uppercase mb-2">Description & Verifiable Achievements (Write exact metrics, %, hours, tech stack)</label>
              <textarea
                required
                rows={4}
                placeholder="e.g., Led architectural security review for 4 cloud services. Enforced IAM principle of least privilege, reducing service-account attack vectors by 24%. Built real-time log monitoring with GCP Pub/Sub."
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 bg-slate-50 outline-none focus:bg-white focus:ring-1 focus:ring-emerald-500/50 resize-none"
              />
            </div>

            <div className="flex items-center space-x-2">
              <input
                type="checkbox"
                id="is_verified"
                checked={isVerified}
                onChange={(e) => setIsVerified(e.target.checked)}
                className="rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
              />
              <label htmlFor="is_verified" className="text-xs font-medium text-slate-600">Mark as fully verified & ready for automatic matching</label>
            </div>

            <div className="flex justify-end space-x-3 pt-2">
              <button
                type="button"
                onClick={resetForm}
                className="px-4 py-2 border border-slate-200 rounded-xl text-xs font-semibold text-slate-500 hover:bg-slate-50 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-5 py-2 bg-emerald-600 text-white rounded-xl text-xs font-semibold hover:bg-emerald-700 shadow cursor-pointer"
              >
                {editingId ? 'Save Edits' : 'Deploy Fact'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2 mb-6">
        <button
          onClick={() => setActiveFilter('All')}
          className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors cursor-pointer ${activeFilter === 'All' ? 'bg-slate-800 text-white border-slate-800' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'}`}
        >
          All Highlights ({evidences.length})
        </button>
        {CATEGORIES.map(category => {
          const count = evidences.filter(e => e.category === category).length;
          return (
            <button
              key={category}
              onClick={() => setActiveFilter(category)}
              className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors cursor-pointer ${activeFilter === category ? 'bg-slate-800 text-white border-slate-800' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'}`}
            >
              {category} ({count})
            </button>
          );
        })}
      </div>

      {showEmptyState ? (
        <div className="text-center py-16 bg-white border border-slate-100 rounded-2xl">
          <Award className="h-12 w-12 text-slate-300 mx-auto mb-3" />
          <p className="text-sm text-slate-500">No verifiable grounding facts recorded in this category.</p>
          <button
            onClick={() => { resetForm(); setIsAdding(true); }}
            className="mt-3 text-xs text-emerald-600 font-semibold hover:underline cursor-pointer"
          >
            Create your first evidence block →
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {filteredEvidences.map((item) => (
            <div
              key={item.id}
              className="bg-white border border-slate-100 rounded-2xl p-5 shadow-sm hover:shadow-md transition-shadow flex flex-col justify-between"
            >
              <div>
                <div className="flex justify-between items-start mb-3">
                  <div className="flex items-center space-x-2">
                    <span className="px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 text-xs font-mono font-bold tracking-wider">
                      {item.evidenceId}
                    </span>
                    <span className="text-[10px] uppercase font-semibold tracking-wider text-slate-400 bg-slate-50 px-2 py-0.5 rounded-full">
                      {item.category}
                    </span>
                  </div>
                  <div className="flex space-x-1.5">
                    <button
                      onClick={() => handleEdit(item)}
                      className="p-1 text-slate-400 hover:text-emerald-600 hover:bg-slate-50 rounded transition-colors cursor-pointer"
                      title="Edit fact"
                    >
                      <Edit2 className="h-4 w-4" />
                    </button>
                    <button
                      onClick={() => handleDelete(item.id || '')}
                      className="p-1 text-slate-400 hover:text-red-500 hover:bg-slate-50 rounded transition-colors cursor-pointer"
                      title="Delete fact"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>

                <h4 className="text-base font-bold text-slate-800 tracking-tight leading-snug">
                  {item.title}
                </h4>
                {item.organization && (
                  <p className="text-xs text-slate-400 font-medium mb-3">
                    at {item.organization}
                  </p>
                )}

                <p className="text-sm font-normal text-slate-500 mb-4 whitespace-pre-line leading-relaxed">
                  {item.description}
                </p>
              </div>

              <div className="pt-3 border-t border-slate-50 flex items-center justify-between">
                <span className="text-[10px] text-slate-400 font-mono">
                  Synced: {new Date(item.updatedAt).toLocaleDateString()}
                </span>
                {item.isVerified ? (
                  <span className="inline-flex items-center space-x-1 text-xs text-emerald-600 font-semibold bg-emerald-50/50 px-2.5 py-1 rounded-lg">
                    <ShieldCheck className="h-3.5 w-3.5" />
                    <span>Audit Ready Grounding</span>
                  </span>
                ) : (
                  <span className="inline-flex items-center space-x-1 text-xs text-slate-400 bg-slate-100 px-2.5 py-1 rounded-lg">
                    <span>Draft</span>
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
