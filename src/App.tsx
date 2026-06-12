import { useState, useEffect } from 'react';
import { onAuthStateChanged, getRedirectResult, User as FirebaseUser } from 'firebase/auth';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Radar, User, Award, CheckSquare, Briefcase, Calendar, 
  LogOut, Database, Activity, KeyRound, FileText
} from 'lucide-react';

import { auth, getFirestoreDiagnostics, logout, testConnection } from './firebase';
import AuthScreen from './components/AuthScreen';
import ProfilePanel from './components/ProfilePanel';
import EvidenceBankPanel from './components/EvidenceBankPanel';
import CareerRadarPanel from './components/CareerRadarPanel';
import OpportunitiesPanel from './components/OpportunitiesPanel';
import CVChecklistPanel from './components/CVChecklistPanel';
import CVTemplateSetupPanel from './components/CVTemplateSetupPanel';
import DailyBriefPanel from './components/DailyBriefPanel';
import LegacyImportPanel from './components/LegacyImportPanel';
import AIUsageLogPanel from './components/AIUsageLogPanel';
import AISettingsPanel from './components/AISettingsPanel';
import FirestoreDiagnosticsPanel from './components/FirestoreDiagnosticsPanel';

type ActiveTab = 'radar' | 'profile' | 'evidence' | 'opportunities' | 'checklist' | 'cv-template' | 'pipeline' | 'legacy-import' | 'ai-usage' | 'ai-settings';

let authenticatedConnectionTestScheduled = false;
let redirectResultChecked = false;

export default function App() {
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<ActiveTab>('radar');
  const [menuOpen, setMenuOpen] = useState(false);
  const [dataRefreshToken, setDataRefreshToken] = useState(0);
  const [firestoreStartupWarning, setFirestoreStartupWarning] = useState<string | null>(null);

  // Initialize and run initial Firebase safety checks on bootup
  useEffect(() => {
    // Securely listen and handle redirect login results (fail-safe for restrictive local or iframe rules)
    if (!redirectResultChecked) {
      redirectResultChecked = true;
      getRedirectResult(auth)
        .then((result) => {
          if (result?.user) {
            setUser(result.user);
          }
        })
        .catch((err) => {
          console.error('Redirect sign-in resolution failure:', err);
        });
    }

    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      console.info('Firebase auth state diagnostics:', {
        ...getFirestoreDiagnostics(),
        currentUserUid: currentUser?.uid || null
      });
      setUser(currentUser);
      setAuthLoading(false);
      if (currentUser && !authenticatedConnectionTestScheduled) {
        authenticatedConnectionTestScheduled = true;
        testConnection(currentUser.uid).then((result) => {
          if (!result.ok) {
            setFirestoreStartupWarning(result.error || 'Firestore server read failed.');
          }
        });
      }
    });

    return () => unsubscribe();
  }, []);

  const handleLogout = async () => {
    try {
      await logout();
      setUser(null);
    } catch (err) {
      console.error('Logout failed:', err);
    }
  };

  if (authLoading) {
    return (
      <div id="loader_container" className="min-h-screen bg-slate-50 flex flex-col items-center justify-center font-sans">
        <Radar className="h-10 w-10 text-emerald-600 animate-spin" />
        <span className="text-sm font-semibold text-slate-700 mt-4">Initializing Career Radar Workspaces...</span>
        <span className="text-xs text-slate-400 mt-1">Establishing secure Firestore connection</span>
      </div>
    );
  }

  // If user is not authenticated, render the Google Authentic Sign Screen
  if (!user) {
    return (
      <AuthScreen 
        onLoginSuccess={(u) => setUser(u)} 
        loading={authLoading} 
        setLoading={setAuthLoading} 
      />
    );
  }

  // Render the fully responsive dashboard workspace
  return (
    <div id="dashboard_container" className="min-h-screen bg-slate-50/50 flex flex-col md:flex-row font-sans">
      
      {/* Sidebar Navigation */}
      <aside className="w-full md:w-64 bg-white border-b md:border-b-0 md:border-r border-slate-100 flex flex-col shrink-0">
        
        {/* Sidebar Brand header */}
        <div className="p-6 border-b border-slate-50 flex items-center justify-between">
          <div className="flex items-center space-x-2.5">
            <div className="p-1.5 bg-emerald-600 text-white rounded-lg shadow-sm">
              <Radar className="h-5 w-5 animate-pulse" />
            </div>
            <span className="text-lg font-bold text-slate-800 tracking-tight">CareerRadar AI</span>
          </div>
          <button 
            onClick={() => setMenuOpen(!menuOpen)}
            className="md:hidden p-1.5 hover:bg-slate-50 rounded-lg text-slate-500"
          >
            <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              {menuOpen ? (
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
              ) : (
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 6h16M4 12h16M4 18h16" />
              )}
            </svg>
          </button>
        </div>

        {/* User Mini Profile Badge */}
        <div className="p-5 border-b border-slate-50 bg-slate-50/20 flex items-center space-x-3">
          <img 
            src={user.photoURL || 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=80&fit=crop'} 
            alt={user.displayName || 'Candidate'}
            referrerPolicy="no-referrer"
            className="h-10 w-10 rounded-full bg-slate-200 border-2 border-emerald-50"
          />
          <div className="min-w-0 flex-1">
            <h4 className="text-xs font-bold text-slate-800 tracking-tight truncate">
              {user.displayName || 'Candidate'}
            </h4>
            <p className="text-[10px] font-mono text-slate-400 truncate">
              {user.email}
            </p>
          </div>
        </div>

        {/* Navigation Tabs (Fully responsive swap) */}
        <nav className={`p-4 space-y-1 flex-1 ${menuOpen ? 'block' : 'hidden md:block'}`}>
          <button
            onClick={() => { setActiveTab('radar'); setMenuOpen(false); }}
            className={`w-full flex items-center space-x-3 px-3 py-2.5 rounded-xl text-xs font-bold transition-all cursor-pointer ${
              activeTab === 'radar' 
                ? 'bg-emerald-600 text-white shadow-md shadow-emerald-600/10' 
                : 'text-slate-500 hover:text-slate-800 hover:bg-slate-50'
            }`}
          >
            <Radar className="h-4 w-4 shrink-0" />
            <span>AI Match Radar</span>
          </button>

          <button
            onClick={() => { setActiveTab('profile'); setMenuOpen(false); }}
            className={`w-full flex items-center space-x-3 px-3 py-2.5 rounded-xl text-xs font-bold transition-all cursor-pointer ${
              activeTab === 'profile' 
                ? 'bg-emerald-600 text-white shadow-md shadow-emerald-600/10' 
                : 'text-slate-500 hover:text-slate-800 hover:bg-slate-50'
            }`}
          >
            <User className="h-4 w-4 shrink-0" />
            <span>Candidate Profile Context</span>
          </button>

          <button
            onClick={() => { setActiveTab('evidence'); setMenuOpen(false); }}
            className={`w-full flex items-center space-x-3 px-3 py-2.5 rounded-xl text-xs font-bold transition-all cursor-pointer ${
              activeTab === 'evidence' 
                ? 'bg-emerald-600 text-white shadow-md shadow-emerald-600/10' 
                : 'text-slate-500 hover:text-slate-800 hover:bg-slate-50'
            }`}
          >
            <Award className="h-4 w-4 shrink-0" />
            <span>CV Evidence Bank</span>
          </button>

          <div className="py-2 border-t border-slate-50 my-2"></div>

          <button
            onClick={() => { setActiveTab('opportunities'); setMenuOpen(false); }}
            className={`w-full flex items-center space-x-3 px-3 py-2.5 rounded-xl text-xs font-bold transition-all cursor-pointer ${
              activeTab === 'opportunities' 
                ? 'bg-emerald-600 text-white shadow-md shadow-emerald-600/10' 
                : 'text-slate-500 hover:text-slate-800 hover:bg-slate-50'
            }`}
          >
            <Briefcase className="h-4 w-4 shrink-0" />
            <span>Target Opportunities</span>
          </button>

          <button
            onClick={() => { setActiveTab('checklist'); setMenuOpen(false); }}
            className={`w-full flex items-center space-x-3 px-3 py-2.5 rounded-xl text-xs font-bold transition-all cursor-pointer ${
              activeTab === 'checklist' 
                ? 'bg-emerald-600 text-white shadow-md shadow-emerald-600/10' 
                : 'text-slate-500 hover:text-slate-800 hover:bg-slate-50'
            }`}
          >
            <CheckSquare className="h-4 w-4 shrink-0" />
            <span>CV Tailoring Checklist</span>
          </button>

          <button
            onClick={() => { setActiveTab('cv-template'); setMenuOpen(false); }}
            className={`w-full flex items-center space-x-3 px-3 py-2.5 rounded-xl text-xs font-bold transition-all cursor-pointer ${
              activeTab === 'cv-template' 
                ? 'bg-emerald-600 text-white shadow-md shadow-emerald-600/10' 
                : 'text-slate-500 hover:text-slate-800 hover:bg-slate-50'
            }`}
          >
            <FileText className="h-4 w-4 shrink-0" />
            <span>CV Template Setup</span>
          </button>

          <button
            onClick={() => { setActiveTab('pipeline'); setMenuOpen(false); }}
            className={`w-full flex items-center space-x-3 px-3 py-2.5 rounded-xl text-xs font-bold transition-all cursor-pointer ${
              activeTab === 'pipeline' 
                ? 'bg-emerald-600 text-white shadow-md shadow-emerald-600/10' 
                : 'text-slate-500 hover:text-slate-800 hover:bg-slate-50'
            }`}
          >
            <Calendar className="h-4 w-4 shrink-0" />
            <span>Submission Pipeline</span>
          </button>

          <div className="py-2 border-t border-slate-50 my-2"></div>

          <button
            onClick={() => { setActiveTab('legacy-import'); setMenuOpen(false); }}
            className={`w-full flex items-center space-x-3 px-3 py-2.5 rounded-xl text-xs font-bold transition-all cursor-pointer ${
              activeTab === 'legacy-import' 
                ? 'bg-emerald-600 text-white shadow-md shadow-emerald-600/10' 
                : 'text-slate-500 hover:text-slate-800 hover:bg-slate-50'
            }`}
          >
            <Database className="h-4 w-4 shrink-0" />
            <span>Legacy Import</span>
          </button>

          <button
            onClick={() => { setActiveTab('ai-usage'); setMenuOpen(false); }}
            className={`w-full flex items-center space-x-3 px-3 py-2.5 rounded-xl text-xs font-bold transition-all cursor-pointer ${
              activeTab === 'ai-usage' 
                ? 'bg-emerald-600 text-white shadow-md shadow-emerald-600/10' 
                : 'text-slate-500 hover:text-slate-800 hover:bg-slate-50'
            }`}
          >
            <Activity className="h-4 w-4 shrink-0" />
            <span>AI Usage Log</span>
          </button>

          <button
            onClick={() => { setActiveTab('ai-settings'); setMenuOpen(false); }}
            className={`w-full flex items-center space-x-3 px-3 py-2.5 rounded-xl text-xs font-bold transition-all cursor-pointer ${
              activeTab === 'ai-settings' 
                ? 'bg-emerald-600 text-white shadow-md shadow-emerald-600/10' 
                : 'text-slate-500 hover:text-slate-800 hover:bg-slate-50'
            }`}
          >
            <KeyRound className="h-4 w-4 shrink-0" />
            <span>AI Settings</span>
          </button>
        </nav>

        {/* Sidebar Log Out Action */}
        <div className="p-4 border-t border-slate-50 mt-auto">
          <button
            onClick={handleLogout}
            className="w-full flex items-center space-x-3 px-3 py-2 rounded-xl text-xs font-semibold text-slate-400 hover:text-rose-600 hover:bg-rose-50/50 transition-all cursor-pointer"
          >
            <LogOut className="h-4 w-4 shrink-0" />
            <span>Sign Out Workspace</span>
          </button>
        </div>
      </aside>

      {/* Main Content Pane */}
      <main className="flex-1 bg-slate-50/30 min-w-0 p-6 sm:p-8 lg:p-10 overflow-y-auto">
        {firestoreStartupWarning && (
          <div className="mb-4 rounded-2xl border border-rose-100 bg-rose-50 px-4 py-3 text-sm text-rose-700">
            <div className="font-bold text-rose-900">Firestore server read failed</div>
            <div className="mt-1">{firestoreStartupWarning}</div>
            <div className="mt-1 text-xs text-rose-600">
              projectId: {getFirestoreDiagnostics().projectId} · authDomain: {getFirestoreDiagnostics().authDomain} · firestoreDatabaseId: {getFirestoreDiagnostics().firestoreDatabaseId}
            </div>
          </div>
        )}
        <FirestoreDiagnosticsPanel userId={user.uid} />
        <AnimatePresence mode="wait">
          <motion.div
            key={activeTab}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.2 }}
          >
            {activeTab === 'radar' && (
              <CareerRadarPanel
                userId={user.uid}
                onOpportunitySaved={() => {
                  setDataRefreshToken((current) => current + 1);
                  setActiveTab('opportunities');
                }}
              />
            )}
            {activeTab === 'profile' && <ProfilePanel userId={user.uid} />}
            {activeTab === 'evidence' && <EvidenceBankPanel userId={user.uid} />}
            {activeTab === 'opportunities' && <OpportunitiesPanel userId={user.uid} refreshToken={dataRefreshToken} />}
            {activeTab === 'checklist' && <CVChecklistPanel userId={user.uid} refreshToken={dataRefreshToken} />}
            {activeTab === 'cv-template' && <CVTemplateSetupPanel userId={user.uid} />}
            {activeTab === 'pipeline' && <DailyBriefPanel userId={user.uid} refreshToken={dataRefreshToken} />}
            {activeTab === 'legacy-import' && <LegacyImportPanel userId={user.uid} />}
            {activeTab === 'ai-usage' && <AIUsageLogPanel />}
            {activeTab === 'ai-settings' && <AISettingsPanel />}
          </motion.div>
        </AnimatePresence>
      </main>

    </div>
  );
}
