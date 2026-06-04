import { motion } from 'motion/react';
import { Radar, ShieldCheck, FileText, CheckSquare, Sparkles } from 'lucide-react';
import { loginWithGoogle, loginWithGoogleRedirect } from '../firebase';

interface AuthScreenProps {
  onLoginSuccess: (user: any) => void;
  loading: boolean;
  setLoading: (loading: boolean) => void;
}

export default function AuthScreen({ onLoginSuccess, loading, setLoading }: AuthScreenProps) {
  const handleLogin = async () => {
    setLoading(true);
    try {
      const user = await loginWithGoogle();
      if (user) {
        onLoginSuccess(user);
      }
    } catch (err: any) {
      console.error('Login popup failed', err);
      // Automatically transition to redirect if a popup block is identified
      if (err?.code === 'auth/popup-blocked') {
        console.log('Popup blocked. Initiating redirect auth fallback...');
        handleRedirectLogin();
      }
    } finally {
      setLoading(false);
    }
  };

  const handleRedirectLogin = async () => {
    setLoading(true);
    try {
      await loginWithGoogleRedirect();
    } catch (err) {
      console.error('Login redirect initialization failed:', err);
      setLoading(false);
    }
  };

  return (
    <div id="auth_container" className="min-h-screen bg-slate-50 flex flex-col justify-between py-12 px-4 sm:px-6 lg:px-8 font-sans">
      {/* Header */}
      <div className="max-w-7xl mx-auto w-full flex justify-between items-center">
        <div className="flex items-center space-x-2">
          <div className="p-2 bg-emerald-600 text-white rounded-lg shadow-sm">
            <Radar className="h-6 w-6 animate-pulse" />
          </div>
          <span className="text-xl font-bold text-slate-800 tracking-tight">CareerRadar AI</span>
        </div>
        <div className="text-xs text-slate-400 font-mono">v1.1 (Firebase Sync Edition)</div>
      </div>

      {/* Main Hero Card */}
      <div className="max-w-md mx-auto w-full bg-white rounded-2xl shadow-xl shadow-slate-100 border border-slate-100 p-8 sm:p-10 my-8">
        <motion.div
          initial={{ opacity: 0, y: 15 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="text-center"
        >
          <div className="inline-flex items-center space-x-1.5 px-3 py-1 rounded-full text-xs font-medium bg-emerald-50 text-emerald-700 mb-6">
            <Sparkles className="h-3.5 w-3.5" />
            <span>AI-Driven Resume Matcher</span>
          </div>

          <h2 className="text-3xl font-extrabold text-slate-900 tracking-tight mb-3">
            Match Your True Talents
          </h2>
          <p className="text-sm text-slate-500 mb-8 max-w-sm mx-auto">
            Securely map opportunities, parse complex job technical DNA, and tailor your CV suggestions with full academic & project grounding.
          </p>

          {/* Core Feature List */}
          <div className="space-y-4 text-left mb-8 max-w-xs mx-auto">
            <div className="flex items-start space-x-3 text-slate-600">
              <ShieldCheck className="h-5 w-5 text-emerald-600 shrink-0 mt-0.5" />
              <div className="text-sm font-medium">CV Evidence Fact-Bank</div>
            </div>
            <div className="flex items-start space-x-3 text-slate-600">
              <Radar className="h-5 w-5 text-emerald-600 shrink-0 mt-0.5" />
              <div className="text-sm font-medium">Auto Job DNA Extraction</div>
            </div>
            <div className="flex items-start space-x-3 text-slate-600">
              <FileText className="h-5 w-5 text-emerald-600 shrink-0 mt-0.5" />
              <div className="text-sm font-medium">Resume summary & outreach packs</div>
            </div>
            <div className="flex items-start space-x-3 text-slate-600">
              <CheckSquare className="h-5 w-5 text-emerald-600 shrink-0 mt-0.5" />
              <div className="text-sm font-medium">Actionable tailoring checklist</div>
            </div>
          </div>

          {/* Social Auth Trigger */}
          <div className="space-y-3">
            <button
              id="google_signin_button"
              onClick={handleLogin}
              disabled={loading}
              className="w-full flex justify-center items-center py-3 px-4 border border-slate-200 rounded-xl bg-white hover:bg-slate-50 text-sm font-semibold text-slate-700 shadow-sm transition-colors duration-200 cursor-pointer disabled:opacity-50"
            >
              {loading ? (
                <div className="h-5 w-5 border-2 border-slate-300 border-t-slate-700 rounded-full animate-spin"></div>
              ) : (
                <div className="flex items-center space-x-2">
                  <svg className="h-5 w-5 text-slate-600" viewBox="0 0 24 24">
                    <path
                      fill="currentColor"
                      d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                    />
                    <path
                      fill="currentColor"
                      d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                    />
                    <path
                      fill="currentColor"
                      d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l3.66-2.85z"
                    />
                    <path
                      fill="currentColor"
                      d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.85c.87-2.6 3.3-4.53 6.16-4.53z"
                    />
                  </svg>
                  <span>Sign in with Google (Popup)</span>
                </div>
              )}
            </button>

            <button
              id="google_signin_redirect_button"
              onClick={handleRedirectLogin}
              disabled={loading}
              className="w-full flex justify-center items-center py-3 px-4 border border-transparent rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-semibold shadow-md shadow-emerald-600/10 transition-colors duration-200 cursor-pointer disabled:opacity-50"
            >
              {loading ? (
                <div className="h-5 w-5 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
              ) : (
                <div className="flex items-center space-x-2">
                  <svg className="h-5 w-5 text-white" viewBox="0 0 24 24">
                    <path
                      fill="currentColor"
                      d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                    />
                    <path
                      fill="currentColor"
                      d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                    />
                    <path
                      fill="currentColor"
                      d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l3.66-2.85z"
                    />
                    <path
                      fill="currentColor"
                      d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.85c.87-2.6 3.3-4.53 6.16-4.53z"
                    />
                  </svg>
                  <span>Sign in with Google (Redirect Mode) 🔥</span>
                </div>
              )}
            </button>
            <p className="text-[10px] text-slate-400 mt-2 leading-relaxed text-center">
              *Pilih <strong>Redirect Mode (Tombol Hijau)</strong> jika tombol popup putih terblokir atau langsung menutup secara otomatis di laptop/HP Anda.
            </p>
          </div>
        </motion.div>
      </div>

      {/* Footer */}
      <div className="text-center text-xs text-slate-400">
        <p>Your workspace is secured on Firestore. Safe & private cloud isolation.</p>
      </div>
    </div>
  );
}
