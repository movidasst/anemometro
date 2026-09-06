(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const SUPABASE_URL = 'https://lfdmbkzghnwvsapxypvt.supabase.co';
  const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_bRnkA6PA8-v073nrw9zxiQ_8rVGiOn1';
  const ACCESS_SESSION_KEY = 'movida-sst-anemometro-session';
  const ACCESS_ATTEMPTS_KEY = 'movida-sst-anemometro-attempts';
  const ACCESS_DURATION = 20 * 60 * 1000;
  const BLOCK_DURATION = 15 * 60 * 1000;
  const MAX_ATTEMPTS = 5;
  const REQUEST_TIMEOUT = 15000;
  let accessTimer = null;

  function readStoredJson(storage, key, fallback) {
    try { return JSON.parse(storage.getItem(key) || 'null') || fallback; }
    catch { return fallback; }
  }

  function writeStoredJson(storage, key, value) {
    try { storage.setItem(key, JSON.stringify(value)); } catch {}
  }

  function setMessage(message, type = 'error') {
    const box = $('loginMessage');
    if (!box) return;
    box.textContent = message;
    box.classList.toggle('success', type === 'success');
  }

  function getAttemptState() {
    const stored = readStoredJson(localStorage, ACCESS_ATTEMPTS_KEY, { count: 0, blockedUntil: 0 });
    if (stored.blockedUntil && stored.blockedUntil <= Date.now()) {
      localStorage.removeItem(ACCESS_ATTEMPTS_KEY);
      return { count: 0, blockedUntil: 0 };
    }
    return stored;
  }

  function blockedMessage(blockedUntil) {
    const min = Math.max(1, Math.ceil((blockedUntil - Date.now()) / 60000));
    return `Demasiados intentos. Espera ${min} ${min === 1 ? 'minuto' : 'minutos'} antes de volver a intentar.`;
  }

  function recordFailure() {
    const current = getAttemptState();
    const count = (current.count || 0) + 1;
    if (count >= MAX_ATTEMPTS) {
      const blockedUntil = Date.now() + BLOCK_DURATION;
      writeStoredJson(localStorage, ACCESS_ATTEMPTS_KEY, { count: 0, blockedUntil });
      return blockedMessage(blockedUntil);
    }
    writeStoredJson(localStorage, ACCESS_ATTEMPTS_KEY, { count, blockedUntil: 0 });
    const remaining = MAX_ATTEMPTS - count;
    return `No pudimos validar esos datos. Revisa la cédula y la clave. Te ${remaining === 1 ? 'queda 1 intento' : `quedan ${remaining} intentos`}.`;
  }

  function scheduleExpiry(expiresAt) {
    clearTimeout(accessTimer);
    accessTimer = setTimeout(() => showLogin('Tu sesión de 20 minutos finalizó. Ingresa nuevamente para continuar.'), Math.max(0, expiresAt - Date.now()));
  }

  function showLogin(message = '') {
    clearTimeout(accessTimer);
    sessionStorage.removeItem(ACCESS_SESSION_KEY);

    const gate = $('loginGate');
    const app = $('appShell');
    if (!gate || !app) return;

    app.hidden = true;
    app.setAttribute('aria-hidden', 'true');
    gate.hidden = false;
    gate.setAttribute('aria-hidden', 'false');
    document.body.classList.add('auth-locked');
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;

    const form = $('memberLogin');
    if (form) form.reset();
    const password = $('memberPassword');
    const toggle = $('togglePassword');
    if (password) password.type = 'password';
    if (toggle) {
      toggle.textContent = 'Mostrar';
      toggle.setAttribute('aria-pressed', 'false');
    }
    setMessage(message, message && message.includes('correct') ? 'success' : 'error');
    window.setTimeout(() => $('memberId')?.focus({ preventScroll: true }), 80);
  }

  function openSimulator(member, persist = true) {
    const gate = $('loginGate');
    const app = $('appShell');
    const memberName = $('memberName');
    if (!gate || !app || !memberName) return;

    const name = [member?.nombres, member?.apellidos].filter(Boolean).join(' ').trim() || member?.nombre || member?.name || 'integrante';
    const expiresAt = member?.expiresAt || Date.now() + ACCESS_DURATION;
    if (persist) writeStoredJson(sessionStorage, ACCESS_SESSION_KEY, { name, expiresAt });

    memberName.textContent = name;
    gate.hidden = true;
    gate.setAttribute('aria-hidden', 'true');
    app.hidden = false;
    app.setAttribute('aria-hidden', 'false');
    document.body.classList.remove('auth-locked');
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
    scheduleExpiry(expiresAt);
  }

  async function requestMember(cedula, codigo) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
    try {
      const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/acceso_integrante`, {
        method: 'POST',
        mode: 'cors',
        credentials: 'omit',
        cache: 'no-store',
        signal: controller.signal,
        headers: {
          apikey: SUPABASE_PUBLISHABLE_KEY,
          Authorization: `Bearer ${SUPABASE_PUBLISHABLE_KEY}`,
          Accept: 'application/json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ p_cedula: cedula, p_codigo: codigo })
      });
      if (!response.ok) throw new Error(`Access service returned ${response.status}`);
      const payload = await response.json();
      return Array.isArray(payload) ? (payload[0] || null) : (payload || null);
    } finally {
      clearTimeout(timeout);
    }
  }

  async function submitLogin(event) {
    event.preventDefault();
    const cedulaInput = $('memberId');
    const passwordInput = $('memberPassword');
    const submit = $('loginSubmit');
    if (!cedulaInput || !passwordInput || !submit) return;

    const cedula = cedulaInput.value.replace(/\D/g, '');
    const codigo = passwordInput.value.trim();
    cedulaInput.setAttribute('aria-invalid', String(!cedula));
    passwordInput.setAttribute('aria-invalid', String(!codigo));

    const attempts = getAttemptState();
    if (attempts.blockedUntil > Date.now()) {
      setMessage(blockedMessage(attempts.blockedUntil));
      return;
    }
    if (!cedula || !codigo) {
      setMessage('Escribe tu cédula y tu clave para continuar.');
      (!cedula ? cedulaInput : passwordInput).focus();
      return;
    }

    const label = submit.querySelector('span');
    submit.disabled = true;
    if (label) label.textContent = 'Verificando acceso…';
    setMessage('Validando con el registro de integrantes…', 'success');

    try {
      const member = await requestMember(cedula, codigo);
      if (!member) {
        passwordInput.value = '';
        passwordInput.focus();
        setMessage(recordFailure());
        return;
      }

      localStorage.removeItem(ACCESS_ATTEMPTS_KEY);
      cedulaInput.removeAttribute('aria-invalid');
      passwordInput.removeAttribute('aria-invalid');
      setMessage('Acceso correcto. Abriendo simulador…', 'success');
      window.setTimeout(() => openSimulator(member), 180);
    } catch (error) {
      console.error('No fue posible validar el acceso', error);
      if (error?.name === 'AbortError') setMessage('La validación tardó demasiado. Revisa tu conexión e intenta nuevamente.');
      else setMessage('No fue posible conectar con el servicio de acceso. Intenta nuevamente.');
    } finally {
      submit.disabled = false;
      if (label) label.textContent = 'Abrir simulador';
    }
  }

  function init() {
    const form = $('memberLogin');
    const toggle = $('togglePassword');
    const logout = $('logoutBtn');
    if (!form || !toggle || !logout) {
      console.error('No se encontraron todos los controles de acceso.');
      return;
    }

    form.addEventListener('submit', submitLogin);
    toggle.addEventListener('click', () => {
      const field = $('memberPassword');
      if (!field) return;
      const show = field.type === 'password';
      field.type = show ? 'text' : 'password';
      toggle.textContent = show ? 'Ocultar' : 'Mostrar';
      toggle.setAttribute('aria-pressed', String(show));
    });
    logout.addEventListener('click', () => showLogin('Sesión cerrada correctamente.'));

    const session = readStoredJson(sessionStorage, ACCESS_SESSION_KEY, null);
    if (session?.expiresAt > Date.now()) {
      openSimulator(session, false);
      return;
    }

    showLogin();
    const attempts = getAttemptState();
    if (attempts.blockedUntil > Date.now()) setMessage(blockedMessage(attempts.blockedUntil));
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
