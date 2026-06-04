import React, { useState, useEffect } from 'react';
import { User, GraduationCap, Sparkles, Briefcase, Check } from 'lucide-react';
import { doc, getDocFromCache, getDocFromServer, setDoc } from 'firebase/firestore';
import { db, formatFirestoreServerError, handleFirestoreError, OperationType } from '../firebase';
import { Profile } from '../types';

interface ProfilePanelProps {
  userId: string;
}

const profileCache = new Map<string, Profile>();

function createEmptyProfile(): Profile {
  return {
    fullName: '',
    education: '',
    graduationDate: '',
    gpa: undefined,
    workExperienceCount: undefined,
    experienceBrief: '',
    targetRoles: '',
    preferredLocations: '',
    salaryTargetMin: undefined,
    salaryTargetMax: undefined,
    portfolioWording: '',
    updatedAt: new Date().toISOString()
  };
}

export default function ProfilePanel({ userId }: ProfilePanelProps) {
  const [profile, setProfile] = useState<Profile>(() => profileCache.get(userId) ?? createEmptyProfile());

  const [loading, setLoading] = useState(() => !profileCache.has(userId));
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [serverReadError, setServerReadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function fetchProfile() {
      const profileRef = doc(db, 'profiles', userId);
      const cachedProfile = profileCache.get(userId);

      if (cachedProfile) {
        setProfile(cachedProfile);
        setLoading(false);
      } else {
        setProfile(createEmptyProfile());
        setLoading(true);
      }

      try {
        setServerReadError(null);
        if (!cachedProfile) {
          try {
            const cachedSnap = await getDocFromCache(profileRef);
            if (!cancelled && cachedSnap.exists()) {
              const cachedData = cachedSnap.data() as Profile;
              profileCache.set(userId, cachedData);
              setProfile(cachedData);
              setLoading(false);
            }
          } catch (_) {
            // Cache miss is expected on first load.
          }
        }

        const docSnap = await getDocFromServer(profileRef);
        if (cancelled) return;

        if (docSnap.exists()) {
          const serverProfile = docSnap.data() as Profile;
          profileCache.set(userId, serverProfile);
          setProfile(serverProfile);
        }
      } catch (err) {
        console.error('Error fetching profile:', err);
        setServerReadError(formatFirestoreServerError(err));
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }
    fetchProfile();

    return () => {
      cancelled = true;
    };
  }, [userId]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setSaveSuccess(false);
    const profileRef = doc(db, 'profiles', userId);
    const updatedProfile: Profile = {
      ...profile,
      fullName: profile.fullName || 'Anonymous User',
      updatedAt: new Date().toISOString()
    };

    try {
      await setDoc(profileRef, updatedProfile);
      profileCache.set(userId, updatedProfile);
      setProfile(updatedProfile);
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3000);
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `profiles/${userId}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div id="profile_panel" className="max-w-4xl mx-auto py-6 font-sans">
      <div className="md:flex md:items-center md:justify-between mb-8">
        <div className="flex-1 min-w-0">
          <h2 className="text-2xl font-bold text-slate-900 sm:text-3xl tracking-tight flex items-center space-x-2">
            <User className="h-7 w-7 text-emerald-600" />
            <span>Candidate Profile Context</span>
          </h2>
          <p className="mt-1 text-sm text-slate-500">
            Define your academic credentials, career parameters, and portfolio summaries to anchor the matching algorithm.
          </p>
        </div>
      </div>

      <form onSubmit={handleSave} className="space-y-6">
        {serverReadError && (
          <div className="rounded-2xl border border-rose-100 bg-rose-50 px-4 py-3 text-sm text-rose-700">
            <div className="font-bold text-rose-900">Firestore server read failed</div>
            <div className="mt-1">{serverReadError}</div>
          </div>
        )}

        <div className="bg-white shadow-sm border border-slate-100 rounded-2xl overflow-hidden">
          {/* Section 1: Basic Information */}
          <div className="p-6 border-b border-slate-100">
            <h3 className="text-lg font-semibold text-slate-800 flex items-center space-x-2 mb-4">
              <span className="p-1.5 bg-emerald-50 text-emerald-700 rounded-lg"><User className="h-4 w-4" /></span>
              <span>1. Basic Profile & Identity</span>
            </h3>
            <div className="grid grid-cols-1 gap-y-4 sm:grid-cols-6 sm:gap-x-6">
              <div className="sm:col-span-3">
                <label className="block text-xs font-semibold text-slate-600 uppercase tracking-wider mb-1">Full Name</label>
                <input
                  type="text"
                  required
                  value={profile.fullName}
                  onChange={(e) => setProfile({ ...profile, fullName: e.target.value })}
                  placeholder="e.g. Adhi Nugroho"
                  className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 bg-slate-50 focus:bg-white focus:ring-1 focus:ring-emerald-500/50 outline-none transition-all"
                />
              </div>

              <div className="sm:col-span-3">
                <label className="block text-xs font-semibold text-slate-600 uppercase tracking-wider mb-1">Total Years Experience</label>
                <input
                  type="number"
                  min="0"
                  step="1"
                  value={profile.workExperienceCount || ''}
                  onChange={(e) => setProfile({ ...profile, workExperienceCount: e.target.value ? parseInt(e.target.value) : undefined })}
                  placeholder="e.g. 3"
                  className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 bg-slate-50 focus:bg-white focus:ring-1 focus:ring-emerald-500/50 outline-none transition-all"
                />
              </div>
            </div>
          </div>

          {/* Section 2: Education Background */}
          <div className="p-6 border-b border-slate-100">
            <h3 className="text-lg font-semibold text-slate-800 flex items-center space-x-2 mb-4">
              <span className="p-1.5 bg-emerald-50 text-emerald-700 rounded-lg"><GraduationCap className="h-4 w-4" /></span>
              <span>2. Academic Background</span>
            </h3>
            <div className="grid grid-cols-1 gap-y-4 sm:grid-cols-6 sm:gap-x-6">
              <div className="sm:col-span-3">
                <label className="block text-xs font-semibold text-slate-600 uppercase tracking-wider mb-1">Degree & Major</label>
                <input
                  type="text"
                  value={profile.education}
                  onChange={(e) => setProfile({ ...profile, education: e.target.value })}
                  placeholder="e.g. B.S. Computer Science, ITB"
                  className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 bg-slate-50 focus:bg-white focus:ring-1 focus:ring-emerald-500/50 outline-none transition-all"
                />
              </div>

              <div className="sm:col-span-2">
                <label className="block text-xs font-semibold text-slate-600 uppercase tracking-wider mb-1">Cumulative GPA</label>
                <input
                  type="number"
                  min="0"
                  max="4"
                  step="0.01"
                  value={profile.gpa || ''}
                  onChange={(e) => setProfile({ ...profile, gpa: e.target.value ? parseFloat(e.target.value) : undefined })}
                  placeholder="e.g. 3.82"
                  className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 bg-slate-50 focus:bg-white focus:ring-1 focus:ring-emerald-500/50 outline-none transition-all"
                />
              </div>

              <div className="sm:col-span-1">
                <label className="block text-xs font-semibold text-slate-600 uppercase tracking-wider mb-1">Grad Year</label>
                <input
                  type="text"
                  value={profile.graduationDate || ''}
                  onChange={(e) => setProfile({ ...profile, graduationDate: e.target.value })}
                  placeholder="e.g. 2024"
                  className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 bg-slate-50 focus:bg-white focus:ring-1 focus:ring-emerald-500/50 outline-none transition-all"
                />
              </div>
            </div>
          </div>

          {/* Section 3: Professional Anchors */}
          <div className="p-6 border-b border-slate-100 bg-slate-50/10">
            <h3 className="text-lg font-semibold text-slate-800 flex items-center space-x-2 mb-4">
              <span className="p-1.5 bg-emerald-50 text-emerald-700 rounded-lg"><Briefcase className="h-4 w-4" /></span>
              <span>3. Target Roles & Parameters</span>
            </h3>
            <div className="grid grid-cols-1 gap-y-4 sm:grid-cols-6 sm:gap-x-6">
              <div className="sm:col-span-3">
                <label className="block text-xs font-semibold text-slate-600 uppercase tracking-wider mb-1">Target Job Roles</label>
                <input
                  type="text"
                  value={profile.targetRoles}
                  onChange={(e) => setProfile({ ...profile, targetRoles: e.target.value })}
                  placeholder="e.g. Senior Frontend Engineer, React Architect"
                  className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 bg-slate-50 focus:bg-white focus:ring-1 focus:ring-emerald-500/50 outline-none transition-all"
                />
              </div>

              <div className="sm:col-span-3">
                <label className="block text-xs font-semibold text-slate-600 uppercase tracking-wider mb-1">Preferred Office Locations</label>
                <input
                  type="text"
                  value={profile.preferredLocations || ''}
                  onChange={(e) => setProfile({ ...profile, preferredLocations: e.target.value })}
                  placeholder="e.g. Jakarta (Hybrid), Singapore, Remote"
                  className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 bg-slate-50 focus:bg-white focus:ring-1 focus:ring-emerald-500/50 outline-none transition-all"
                />
              </div>

              <div className="sm:col-span-3">
                <label className="block text-xs font-semibold text-slate-600 uppercase tracking-wider mb-1">Desired Salary Range Min (IDR/Month)</label>
                <input
                  type="number"
                  value={profile.salaryTargetMin || ''}
                  onChange={(e) => setProfile({ ...profile, salaryTargetMin: e.target.value ? parseInt(e.target.value) : undefined })}
                  placeholder="e.g. 15000000"
                  className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 bg-slate-50 focus:bg-white focus:ring-1 focus:ring-emerald-500/50 outline-none transition-all"
                />
              </div>

              <div className="sm:col-span-3">
                <label className="block text-xs font-semibold text-slate-600 uppercase tracking-wider mb-1">Desired Salary Range Max (IDR/Month)</label>
                <input
                  type="number"
                  value={profile.salaryTargetMax || ''}
                  onChange={(e) => setProfile({ ...profile, salaryTargetMax: e.target.value ? parseInt(e.target.value) : undefined })}
                  placeholder="e.g. 25000000"
                  className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 bg-slate-50 focus:bg-white focus:ring-1 focus:ring-emerald-500/50 outline-none transition-all"
                />
              </div>
            </div>
          </div>

          {/* Section 4: Experience Narrative brief */}
          <div className="p-6">
            <h3 className="text-lg font-semibold text-slate-800 flex items-center space-x-2 mb-4">
              <span className="p-1.5 bg-emerald-50 text-emerald-700 rounded-lg"><Sparkles className="h-4 w-4" /></span>
              <span>4. Tactical Experience Brief & Portfolio Narrative</span>
            </h3>
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-600 uppercase tracking-wider mb-1">Experience Brief (Background details)</label>
                <textarea
                  rows={4}
                  value={profile.experienceBrief}
                  onChange={(e) => setProfile({ ...profile, experienceBrief: e.target.value })}
                  placeholder="e.g. Over 3 years specializing in designing and deploying responsive web frontends with React, Tailwind and NextJS. Spearheaded migration of obsolete dashboards reducing render times by 40%."
                  className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 bg-slate-50 focus:bg-white focus:ring-1 focus:ring-emerald-500/50 outline-none transition-all resize-none"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-600 uppercase tracking-wider mb-1">Portfolio Highlights, Github or LinkedIn links</label>
                <input
                  type="text"
                  value={profile.portfolioWording || ''}
                  onChange={(e) => setProfile({ ...profile, portfolioWording: e.target.value })}
                  placeholder="e.g. Github: github.com/adhinugroho, Portfolio: adhi.codes"
                  className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 bg-slate-50 focus:bg-white focus:ring-1 focus:ring-emerald-500/50 outline-none transition-all"
                />
              </div>
            </div>
          </div>
        </div>

        <div className="flex justify-end items-center space-x-4">
          {loading && (
            <span className="text-xs font-semibold text-slate-400 flex items-center space-x-2">
              <span className="h-3.5 w-3.5 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin"></span>
              <span>Loading latest profile...</span>
            </span>
          )}
          {saveSuccess && (
            <span className="text-xs font-semibold text-emerald-600 flex items-center space-x-1 animate-fade-in">
              <Check className="h-4 w-4" />
              <span>Profile context synced with Firestore!</span>
            </span>
          )}
          <button
            type="submit"
            disabled={saving || loading}
            className="px-6 py-2.5 bg-slate-800 hover:bg-slate-700 disabled:bg-slate-400 text-white rounded-xl text-sm font-semibold shadow-md transition-colors cursor-pointer"
          >
            {saving ? 'Syncing...' : 'Save Profile Context'}
          </button>
        </div>
      </form>
    </div>
  );
}
