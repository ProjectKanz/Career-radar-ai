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

export function extractApiErrorMessage(value: unknown): string {
  if (!value) return 'Request failed.';
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return extractApiErrorMessage(parsed);
    } catch (_) {
      return value;
    }
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (record.error) return extractApiErrorMessage(record.error);
    if (record.message) return String(record.message);
  }
  return String(value);
}

export function userFacingAiError(value: unknown): string {
  const message = extractApiErrorMessage(value);
  const lower = message.toLowerCase();

  // Case 1: Job description empty / missing
  if (lower.includes('job description text is required') || lower.includes('job description is required') || lower.includes('job description empty') || lower.includes('job description is empty') || lower.includes('deskripsi lowongan kosong')) {
    return 'Deskripsi lowongan kosong. Silakan tempel teks deskripsi lowongan kerja terlebih dahulu sebelum memulai analisis.';
  }

  // Case 2: Gemini API key missing/unconfigured
  if (lower.includes('gemini api key required') || lower.includes('api key gemini belum disiapkan') || (lower.includes('api key') && (lower.includes('missing') || lower.includes('unconfigured') || lower.includes('required') || lower.includes('not set') || lower.includes('belum disiapkan')))) {
    return 'API Key Gemini belum disiapkan. Silakan buka tab \'AI Settings\' untuk memasukkan API Key Gemini Anda secara aman.';
  }

  // Case 3: Screenshot mimeType / format mismatch
  if (lower.includes('upload a png, jpg, jpeg, or webp') || lower.includes('format gambar tidak didukung') || lower.includes('screenshot format mismatch') || lower.includes('mimetype / format mismatch') || (lower.includes('screenshot') && lower.includes('format') && lower.includes('mismatch')) || (lower.includes('mimetype') && lower.includes('screenshot'))) {
    return 'Format gambar tidak didukung. Silakan unggah screenshot dalam format PNG, JPG, JPEG, atau WEBP.';
  }

  // Case 4: Screenshot size exceeds limits
  if (lower.includes('screenshot is too large') || lower.includes('screenshot too large') || lower.includes('screenshot size exceeds') || (lower.includes('screenshot') && lower.includes('too large')) || (lower.includes('screenshot') && lower.includes('size') && lower.includes('exceed'))) {
    return 'Ukuran screenshot terlalu besar. Harap perkecil resolusi gambar atau kompres file di bawah 3MB sebelum mengunggah.';
  }

  // Case 5: Screenshot empty/unreadable
  if (lower.includes('screenshot image payload is empty') || lower.includes('screenshot empty') || lower.includes('unreadable screenshot') || lower.includes('screenshot empty/unreadable') || (lower.includes('screenshot') && lower.includes('unreadable')) || (lower.includes('screenshot') && lower.includes('empty'))) {
    return 'Gambar screenshot kosong atau tidak dapat dibaca. Pastikan teks lowongan terlihat jelas dan tajam pada gambar.';
  }

  // Case 6: CV text too short
  if (lower.includes('cv text is too short') || lower.includes('cv text too short') || lower.includes('teks cv terlalu pendek')) {
    return 'Teks CV terlalu pendek untuk dianalisis. Pastikan CV Anda berisi data diri, pengalaman kerja, atau riwayat pendidikan yang valid.';
  }

  // Case 7: Google Drive access missing
  if (lower.includes('google drive access and template fields') || lower.includes('google drive access missing') || lower.includes('akses google drive atau field template tidak lengkap') || (lower.includes('google drive') && lower.includes('access') && lower.includes('missing')) || (lower.includes('drive') && lower.includes('template') && lower.includes('required'))) {
    return 'Akses Google Drive atau field template tidak lengkap. Hubungkan kembali akun Google Anda atau periksa template CV Anda.';
  }

  // Case 8: Google Docs source requires drive/docs access
  if (lower.includes('google docs source requires drive/docs') || lower.includes('google docs source requires') || lower.includes('drive/docs access and a document link') || lower.includes('google drive/docs and link') || (lower.includes('google docs') && lower.includes('requires') && lower.includes('access'))) {
    return 'Akses Google Drive/Docs dan link dokumen diperlukan. Pastikan link Google Docs valid dan akun Google Anda terhubung.';
  }

  if (lower.includes('api key') || lower.includes('ai settings')) {
    return message;
  }

  // Handle network issues / offline state
  if (lower.includes('failed to fetch') || lower.includes('network error') || lower.includes('offline')) {
    return 'Koneksi jaringan terputus atau gagal terhubung ke server. Harap periksa koneksi internet Anda dan coba lagi.';
  }

  // Handle rate limiting (express-rate-limit status 429)
  if (lower.includes('batas kuota terlampaui') || lower.includes('too many requests') || lower.includes('429')) {
    return 'Batas kuota pengiriman terlampaui. Anda hanya dapat mengirim request maksimal 3 kali per menit untuk mengamankan kuota gratis Anda. Silakan coba lagi nanti, aktifkan mode Dry Run untuk simulasi, atau masukkan API Key Gemini kustom Anda di tab AI Settings.';
  }

  if (message.includes('503') || lower.includes('high demand') || lower.includes('unavailable')) {
    return 'Gemini sedang padat. Coba lagi beberapa menit lagi, aktifkan Dry Run untuk preview gratis, atau coba lagi dengan API key/model yang kuotanya masih tersedia.';
  }

  if (lower.includes('quota') || lower.includes('rate limit') || lower.includes('resource exhausted')) {
    return 'Kuota atau batas gratis Gemini sedang tercapai. Coba lagi nanti, aktifkan Dry Run, atau gunakan API key Gemini lain.';
  }

  if (lower.includes('permission') || lower.includes('forbidden') || lower.includes('unauthorized')) {
    return 'API key Gemini belum bisa dipakai untuk request ini. Cek kembali key di AI Settings atau buat API key baru dari Google AI Studio.';
  }

  if (lower.includes('exceeds max_input_chars_per_call') || lower.includes('budget limit') || lower.includes('too large')) {
    return 'Ukuran request terlalu besar. Kurangi jumlah evidence di CV Evidence Bank atau perpendek deskripsi lowongan untuk menghemat budget token.';
  }

  return message;
}

export function userFacingCvError(value: unknown): string {
  const message = extractApiErrorMessage(value);
  const lower = message.toLowerCase();

  if (
    lower.includes('invalid credentials') ||
    lower.includes('401') ||
    lower.includes('auth') ||
    lower.includes('unauthorized')
  ) {
    return 'Akses Google Drive kedaluwarsa atau tidak valid. Silakan logout lalu login kembali untuk memperbarui izin akses Google Anda.';
  }

  if (
    lower.includes('permission') ||
    lower.includes('forbidden') ||
    lower.includes('403')
  ) {
    return 'Izin akses Google Drive ditolak. Pastikan Anda mencentang izin akses Google Drive saat login dan akun Anda memiliki hak akses ke template CV.';
  }

  if (
    lower.includes('not found') ||
    lower.includes('404')
  ) {
    return 'Template Google Docs tidak ditemukan. Silakan periksa kembali ID Template di tab CV Template Setup.';
  }

  if (
    lower.includes('google') ||
    lower.includes('drive') ||
    lower.includes('doc') ||
    lower.includes('gdrive')
  ) {
    return `Gagal mengoperasikan Google Drive: ${message}. Periksa koneksi atau ID template Anda.`;
  }

  return userFacingAiError(value);
}
