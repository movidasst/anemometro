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

  function installAuthUiFixes() {
    if (document.getElementById('authRuntimeFixes')) return;
    const style = document.createElement('style');
    style.id = 'authRuntimeFixes';
    style.textContent = `
      body.auth-locked{overflow-y:auto!important;overflow-x:hidden!important}
      body.auth-locked .login-gate{min-height:100dvh;overflow:visible}
      body.auth-locked .login-card{position:relative;z-index:2}
      body.auth-locked .login-card input,
      body.auth-locked .login-card button{pointer-events:auto!important;touch-action:manipulation}
      @media(max-width:780px){
        body.auth-locked{padding-bottom:0!important}
        body.auth-locked .login-shell{min-height:100dvh;height:auto!important;overflow:visible!important}
        body.auth-locked .login-story{min-height:300px}
        body.auth-locked .login-card{align-self:stretch;padding-bottom:max(34px,env(safe-area-inset-bottom))}
      }
    `;
    document.head.appendChild(style);
  }

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
    accessTimer = setTimeout(() => closeSession(true), Math.max(0, expiresAt - Date.now()));
  }

  function openSimulator(member, persist = true) {
    const memberName = $('memberName');
    const loginGate = $('loginGate');
    const appShell = $('appShell');
    if (!memberName || !loginGate || !appShell) return;

    const name = [member?.nombres, member?.apellidos].filter(Boolean).join(' ').trim() || member?.nombre || member?.name || 'integrante';
    const expiresAt = member?.expiresAt || Date.now() + ACCESS_DURATION;
    if (persist) writeStoredJson(sessionStorage, ACCESS_SESSION_KEY, { name, expiresAt });

    memberName.textContent = name;
    loginGate.hidden = true;
    appShell.hidden = false;
    appShell.setAttribute('aria-hidden', 'false');
    document.body.classList.remove('auth-locked');
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
    scheduleExpiry(expiresAt);
  }

  function closeSession(expired = false) {
    clearTimeout(accessTimer);
    sessionStorage.removeItem(ACCESS_SESSION_KEY);
    if (expired) sessionStorage.setItem('movida-sst-anemometro-expired', '1');
    window.location.reload();
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
      if (!response.ok) {
        let details = '';
        try { details = await response.text(); } catch {}
        throw new Error(`Access service returned ${response.status}${details ? `: ${details.slice(0, 160)}` : ''}`);
      }
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

    const buttonText = submit.querySelector('span');
    submit.disabled = true;
    if (buttonText) buttonText.textContent = 'Verificando acceso…';
    setMessage('Conectando con el registro de integrantes…', 'success');

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
      $('memberLogin')?.reset();
      setMessage('Acceso correcto. Abriendo simulador…', 'success');
      openSimulator(member);
    } catch (error) {
      console.error('No fue posible validar el acceso', error);
      if (error?.name === 'AbortError') {
        setMessage('La validación tardó demasiado. Revisa tu conexión e intenta nuevamente.');
      } else {
        setMessage('No fue posible conectar con el servicio de acceso. Intenta nuevamente.');
      }
    } finally {
      submit.disabled = false;
      if (buttonText) buttonText.textContent = 'Abrir simulador';
    }
  }

  function init() {
    installAuthUiFixes();

    const form = $('memberLogin');
    const toggle = $('togglePassword');
    const logout = $('logoutBtn');
    const memberId = $('memberId');
    if (!form || !toggle || !logout || !memberId) {
      console.error('No se encontraron todos los controles de acceso del simulador.');
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
    logout.addEventListener('click', () => closeSession(false));

    const session = readStoredJson(sessionStorage, ACCESS_SESSION_KEY, null);
    if (session?.expiresAt > Date.now()) {
      openSimulator(session, false);
      return;
    }

    sessionStorage.removeItem(ACCESS_SESSION_KEY);
    const attempts = getAttemptState();
    const expired = sessionStorage.getItem('movida-sst-anemometro-expired') === '1';
    sessionStorage.removeItem('movida-sst-anemometro-expired');
    if (expired) setMessage('Tu sesión de 20 minutos finalizó. Ingresa nuevamente para continuar.');
    else if (attempts.blockedUntil > Date.now()) setMessage(blockedMessage(attempts.blockedUntil));

    window.setTimeout(() => memberId.focus({ preventScroll: true }), 50);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
