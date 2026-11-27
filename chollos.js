// Chollos de esquí a la web de PiriSnow (pirineo/web_chollos.py genera la pàgina i la configuració #ps-chollos).
// - Lectura pública per l'API REST de Firestore (sense clau), com a l'app.
// - Compte amb Firebase Authentication (Google o correu verificat), carregat de gstatic només en aquesta pàgina.
// - Escriptures per REST amb el token del compte: les mateixes que l'app (data/Chollos.kt i data/Perfil.kt), de
//   manera que les regles (firebase/firestore.rules) les validen igual: àlies del perfil, un vot per compte,
//   1 chollo cada 10 minuts i 1 comentari cada 30 segons.
(() => {
  const C = JSON.parse(document.getElementById('ps-chollos').textContent);
  const T = (k, ...a) => String(C.textos[k] ?? k).replace(/\{(\d)\}/g, (_, i) => a[i - 1] ?? '');
  const API = 'https://firestore.googleapis.com/v1';
  const DOCS = `projects/${C.projecte}/databases/(default)/documents`;
  const LOCALE = { es: 'es-ES', ca: 'ca-ES', fr: 'fr-FR', en: 'en-GB' }[C.idioma] || 'es-ES';
  const MAX_ALIAS = 24, MIN_ALIAS = 3, MIN_TITOL = 8, MIN_CONTRASENYA = 6, DENUNCIES = 3;
  const EMOJI = Object.fromEntries(C.categories);
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const desa = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* sense memòria: res */ } },
  };
  const estat = { chollos: C.chollos || [], cat: 'tots', ordre: 'populars', usuari: null, alias: '', clau: '', pendent: null, obert: null };

  // ── Valors de Firestore ──────────────────────────────────────────────────
  const str = (v) => ({ stringValue: v }), int = (v) => ({ integerValue: String(v) }), dbl = (v) => ({ doubleValue: v }),
    bool = (v) => ({ booleanValue: v }), hora = (camp) => ({ fieldPath: camp, setToServerValue: 'REQUEST_TIME' }),
    suma = (camp, n) => ({ fieldPath: camp, increment: int(n) });
  const valor = (v) => v == null ? null : 'stringValue' in v ? v.stringValue : 'integerValue' in v ? Number(v.integerValue)
    : 'doubleValue' in v ? v.doubleValue : 'booleanValue' in v ? v.booleanValue : 'timestampValue' in v ? v.timestampValue : null;
  const camps = (doc) => Object.fromEntries(Object.entries(doc.fields || {}).map(([k, v]) => [k, valor(v)]));
  const idDe = (doc) => doc.name.split('/').pop();

  function chollo(doc) {
    const f = camps(doc);
    if (!f.creat || !f.titol || !f.url) return null;
    return { id: idDe(doc), uid: f.uid || '', alias: f.alias || '', titol: f.titol, url: f.url, preu: Number(f.preu) || 0,
      preuAnterior: Number(f.preuAnterior) || 0, codi: f.codi || '', categoria: EMOJI[f.categoria] ? f.categoria : 'altres',
      estacio: f.estacio || '', descripcio: f.descripcio || '', caduca: f.caduca || '', creat: f.creat, graus: f.graus || 0,
      comentaris: f.comentaris || 0, denuncies: f.denuncies || 0, ocult: !!f.ocult, caducat: !!f.caducat, revisat: !!f.revisat,
      imatge: f.imatge || '' };
  }

  async function peticio(cami, { metode = 'GET', cos = null, compte = false } = {}) {
    const h = { 'Content-Type': 'application/json' };
    if (compte) h.Authorization = 'Bearer ' + await estat.usuari.getIdToken();
    const r = await fetch(`${API}/${cami}`, { method: metode, headers: h, body: cos ? JSON.stringify(cos) : undefined });
    const text = await r.text();
    if (!r.ok) { const e = new Error(text); e.codi = r.status; throw e; }
    return text ? JSON.parse(text) : {};
  }
  const commit = (writes) => peticio(`${DOCS}:commit`, { metode: 'POST', cos: { writes }, compte: true });
  const consulta = (pare, col, ordre, limit) => peticio(`${pare}:runQuery`, { metode: 'POST', cos: { structuredQuery: {
    from: [{ collectionId: col }], orderBy: [{ field: { fieldPath: 'creat' }, direction: ordre }], limit } } });

  // ── Filtre de text (el mateix que l'app: Comentaris.textPermes) ──────────
  const ENLLAC = /(https?:\/\/|www\.)/i, DOMINI = /\b[a-z0-9-]+\.(com|es|cat|fr|net|org|ad|eu|info)\b/,
    CORREU = /[\w.+-]+@[\w-]+\.[\w.]+/, TELEFON = /(\+?\d[\d .-]{7,}\d)/;
  const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', '@': 'a', $: 's' };
  const senseAccents = (s) => s.toLowerCase().normalize('NFD').replace(/\p{Mn}+/gu, '');
  function variants(text) {
    const base = senseAccents(text).replace(/(?<=[a-z])[013457@$]|[013457@$](?=[a-z])/g, (c) => LEET[c]);
    const separada = base.replace(/[^a-z]+/g, ' ').trim();
    const junta = base.replace(/(?<=[a-z])[^a-z\s]+(?=[a-z])/g, '').replace(/[^a-z]+/g, ' ').trim();
    return [separada, junta, separada.replace(/\b[a-z](?: [a-z]\b){2,}/g, (m) => m.replace(/ /g, ''))];
  }
  const patro = (p) => new RegExp('(?<![a-z])' + senseAccents(p).replace(/[^a-z]+/g, ' ').trim().split(' ')
    .map((w) => [...w].map((c) => c + '+').join('')).join(' ?') + '(?:e?s)?(?![a-z])');
  const PATRONS = (C.vetades || []).filter((x) => x && x.trim()).map(patro);
  function permes(text) {
    if (!text) return true;
    if (ENLLAC.test(text) || DOMINI.test(text) || CORREU.test(text) || TELEFON.test(text)) return false;
    const vs = variants(text);
    return !PATRONS.some((p) => vs.some((v) => p.test(v)));
  }

  // ── Format ───────────────────────────────────────────────────────────────
  const host = (url) => { try { return new URL(url).hostname.toLowerCase(); } catch (e) { return ''; } };
  const botiga = (url) => host(url).replace(/^www\./, '');
  const conegut = (url) => { const h = host(url); return !!h && C.dominis.some((d) => h === d || h.endsWith('.' + d)); };
  const preu = (v) => v > 0 ? new Intl.NumberFormat(LOCALE, { style: 'currency', currency: 'EUR',
    minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 }).format(v) : '';
  const descompte = (c) => c.preuAnterior > c.preu && c.preuAnterior > 0 ? Math.round((1 - c.preu / c.preuAnterior) * 100) : null;
  function fa(iso) {
    const m = Math.max(1, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));
    return m < 60 ? T('web_fa_min', m) : m < 48 * 60 ? T('web_fa_h', Math.floor(m / 60)) : T('web_fa_d', Math.floor(m / 1440));
  }
  const dia = (iso) => new Date(iso + 'T12:00:00').toLocaleDateString(LOCALE, { day: 'numeric', month: 'long' });
  const avui = () => new Date().toISOString().slice(0, 10);
  const meu = (c) => !!estat.usuari && c.uid === estat.usuari.uid;
  const amagats = () => new Set(desa.get('ps-amagats', []));
  const vots = () => estat.usuari ? desa.get('ps-vots-' + estat.usuari.uid, {}) : {};
  function visible(c) {
    return !c.ocult && c.denuncies < DENUNCIES && !amagats().has(c.id) && (c.revisat || conegut(c.url) || meu(c))
      && !c.caducat && !(c.caduca && c.caduca < avui());
  }

  // ── Targetes (la mateixa estructura que web_chollos.targeta) ─────────────
  function targeta(c) {
    const dte = descompte(c), cat = c.categoria, v = vots()[c.id] || 0;
    const temp = c.graus >= 20 ? 'calent' : c.graus < 0 ? 'fred' : '';
    const preus = (c.preu > 0 ? `<strong>${preu(c.preu)}</strong>` : '') + (dte ? `<s>${preu(c.preuAnterior)}</s>` : '');
    const estacio = C.estacions[c.estacio] ? ` · 📍 ${esc(C.estacions[c.estacio])}` : '';
    const revisio = !c.revisat && !conegut(c.url) ? ` · <em>${esc(T('chollos_en_revisio'))}</em>` : '';
    const foto = c.imatge.startsWith('https://') ? `<img src="${esc(c.imatge)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : '';
    return `<li class="chollo" id="c-${esc(c.id)}" data-id="${esc(c.id)}" data-cat="${cat}">`
      + `<a class="chollo-foto cat-${cat}" href="#c-${esc(c.id)}" data-obre tabindex="-1" aria-hidden="true"><span class="chollo-emoji">${EMOJI[cat]}</span>${foto}`
      + (dte ? `<span class="chollo-dte">${esc(T('web_descompte', dte))}</span>` : '') + '</a>'
      + `<div class="chollo-cos"><p class="chollo-meta">${EMOJI[cat]} ${esc(T('chollos_cat_' + cat))} · ${esc(botiga(c.url))}${estacio}${revisio}</p>`
      + `<h3><a href="#c-${esc(c.id)}" data-obre>${esc(c.titol)}</a></h3>`
      + (preus ? `<p class="chollo-preus">${preus}</p>` : '')
      + `<div class="chollo-peu"><span class="temp ${temp}" data-temp>`
      + `<button type="button" class="vot${v === -1 ? ' votat' : ''}" data-vot="-1" aria-label="${esc(T('chollos_vota_fred'))}">−</button>`
      + `<b>${c.graus}°</b>`
      + `<button type="button" class="vot${v === 1 ? ' votat' : ''}" data-vot="1" aria-label="${esc(T('chollos_vota_calent'))}">+</button></span>`
      + `<a class="chollo-com" href="#c-${esc(c.id)}" data-obre aria-label="${esc(T('chollos_comentaris'))}">💬 ${c.comentaris}</a>`
      + `<span class="chollo-qui">${esc(T('web_per', c.alias))} · ${esc(fa(c.creat))}</span>`
      + `<a class="chollo-anar" href="${esc(c.url)}" rel="nofollow noopener sponsored" target="_blank">${esc(T('chollos_anar'))} ↗</a></div></div></li>`;
  }

  function pinta() {
    const llista = $('#chollos');
    if (!llista) return;
    let cs = estat.chollos.filter((c) => visible(c) && (estat.cat === 'tots' || c.categoria === estat.cat));
    cs = estat.ordre === 'populars' ? cs.sort((a, b) => b.graus - a.graus || b.creat.localeCompare(a.creat))
      : cs.sort((a, b) => b.creat.localeCompare(a.creat));
    llista.innerHTML = cs.map(targeta).join('');
    const buit = $('#chollos-buit');
    if (buit) { buit.hidden = cs.length > 0; buit.textContent = estat.chollos.length ? T('web_cap_filtre') : T('chollos_cap'); }
    document.querySelectorAll('[data-cat-filtre]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.catFiltre === estat.cat)));
    document.querySelectorAll('[data-ordre]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.ordre === estat.ordre)));
  }

  async function carrega() {
    try {
      const r = await consulta(DOCS, 'chollos', 'DESCENDING', 60);
      estat.chollos = r.map((x) => x.document && chollo(x.document)).filter(Boolean);
      pinta();
      if (estat.obert) pintaDetall();
    } catch (e) { if (!estat.chollos.length) avisa(T('chollos_error_carrega')); }
  }

  // ── Avisos curts ─────────────────────────────────────────────────────────
  let rellotge;
  function avisa(text) {
    const t = $('#ps-toast');
    t.textContent = text; t.hidden = false; t.classList.add('vist');
    clearTimeout(rellotge);
    rellotge = setTimeout(() => { t.classList.remove('vist'); setTimeout(() => { t.hidden = true; }, 300); }, 3800);
  }

  function obreDialeg(d) { if (!d.open) d.showModal(); }
  document.querySelectorAll('dialog.dlg').forEach((d) => {
    d.addEventListener('click', (e) => { if (e.target === d) d.close(); });
    d.addEventListener('close', () => { if (d.id === 'dlg-chollo') { estat.obert = null; if (location.hash.startsWith('#c-')) history.replaceState(null, '', location.pathname); } });
  });

  // ── Compte (Firebase Authentication) ─────────────────────────────────────
  let A = null;
  const registrat = (u) => !!u && !u.isAnonymous && u.emailVerified;
  async function auth() {
    if (A || !C.clau) return A;
    const base = `https://www.gstatic.com/firebasejs/${C.firebase}/`;
    const [app, au] = await Promise.all([import(base + 'firebase-app.js'), import(base + 'firebase-auth.js')]);
    const a = au.getAuth(app.initializeApp({ apiKey: C.clau, authDomain: C.authDomain, projectId: C.projecte }));
    a.languageCode = C.idioma;
    A = { a, ...au };
    await new Promise((fet) => {
      let primer = true;
      au.onAuthStateChanged(a, async (u) => {
        estat.usuari = u;
        if (registrat(u)) await carregaPerfil(); else { estat.alias = ''; estat.clau = ''; }
        pintaCap(); pinta();
        if ($('#dlg-compte').open) pintaCompte();
        if (primer) { primer = false; fet(); }
      });
    });
    return A;
  }

  async function carregaPerfil() {
    try {
      const f = camps(await peticio(`${DOCS}/perfils/${estat.usuari.uid}`));
      estat.alias = f.alias || ''; estat.clau = f.clau || '';
    } catch (e) { estat.alias = ''; estat.clau = ''; }
  }

  function pintaCap() {
    desa.set('ps-alias', estat.usuari && estat.alias ? estat.alias : null);
    document.querySelectorAll('.cap-compte span').forEach((s) => { s.textContent = estat.usuari && estat.alias ? estat.alias : T('web_entrar'); });
  }

  // Per publicar, votar, comentar o denunciar: compte verificat i àlies
  async function requereix(accio) {
    if (!C.clau) { pintaCompte(); obreDialeg($('#dlg-compte')); return; }
    await auth();
    if (!registrat(estat.usuari)) { estat.pendent = accio; obreCompte(T('compte_per_publicar')); return; }
    if (!estat.alias) { estat.pendent = accio; obreAlias(); return; }
    accio();
  }
  function continua() {
    const p = estat.pendent;
    estat.pendent = null;
    if (p && registrat(estat.usuari) && estat.alias) p();
  }

  let mode = 'entra', missatge = '';
  function errorCompte(e) {
    const c = (e && e.code) || '';
    if (c === 'auth/email-already-in-use') return T('compte_error_existeix');
    if (c === 'auth/invalid-email' || c === 'auth/missing-email') return T('compte_error_correu');
    if (c === 'auth/weak-password' || c === 'auth/missing-password') return T('compte_error_feble', MIN_CONTRASENYA);
    if (/invalid-credential|wrong-password|user-not-found|invalid-login-credentials/.test(c)) return T('compte_error_credencials');
    if (c === 'auth/too-many-requests') return T('compte_error_intents');
    if (c === 'auth/popup-blocked') return T('web_popup');
    return T('compte_error_xarxa');
  }

  function obreCompte(text) {
    missatge = text || '';
    pintaCompte();
    obreDialeg($('#dlg-compte'));
    if (C.clau && !A) auth().then(pintaCompte);
  }

  function pintaCompte() {
    const cos = $('#compte-cos'), u = estat.usuari;
    if (!C.clau) {
      cos.innerHTML = `<h2>${esc(T('compte_inicia'))}</h2><p>${esc(T('web_sense_clau'))}</p>`
        + `<div class="dlg-botons"><button type="button" class="boto-pri" data-tanca>${esc(T('tanca'))}</button></div>`;
      return;
    }
    if (u && !registrat(u)) {
      cos.innerHTML = `<h2>${esc(T('compte_verifica_titol'))}</h2><p>${esc(T('compte_verifica_text', u.email || ''))}</p>`
        + `<p class="dlg-error" id="compte-error" role="alert">${esc(missatge)}</p>`
        + `<div class="dlg-botons"><button type="button" class="boto-pri" data-accio="verificat">${esc(T('compte_verificat'))}</button>`
        + `<button type="button" class="boto-lleu" data-accio="reenvia">${esc(T('compte_reenvia'))}</button>`
        + `<button type="button" class="boto-lleu" data-accio="surt">${esc(T('compte_surt'))}</button></div>`;
      return;
    }
    if (u) {
      cos.innerHTML = `<h2>${esc(T('compte_sessio'))}</h2>`
        + `<div class="compte-fitxa"><span class="avatar">${esc((estat.alias || u.email || '?').slice(0, 1).toUpperCase())}</span>`
        + `<div><strong>${esc(estat.alias || '—')}</strong><small>${esc(u.email || '')}</small></div></div>`
        + `<p class="nota">${esc(T('compte_privacitat'))}</p>`
        + `<div class="dlg-botons"><button type="button" class="boto-pri" data-accio="alias">${esc(T(estat.alias ? 'alias_canvia' : 'alias_tria'))}</button>`
        + `<button type="button" class="boto-lleu" data-accio="surt">${esc(T('compte_surt'))}</button></div>`;
      return;
    }
    const crea = mode === 'crea';
    cos.innerHTML = `<h2>${esc(T('compte_inicia'))}</h2><p class="dlg-sub">${esc(missatge || T('compte_sub'))}</p>`
      + `<button type="button" class="boto-google" data-accio="google"><svg viewBox="0 0 48 48" width="20" height="20" aria-hidden="true">`
      + '<path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/>'
      + '<path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/>'
      + '<path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/>'
      + '<path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>'
      + `${esc(T('compte_google'))}</button><p class="separador"><span>${esc(T('compte_o_correu'))}</span></p>`
      + `<form id="form-compte" class="formulari" novalidate><label>${esc(T('compte_correu'))}<input type="email" name="correu" autocomplete="email" required></label>`
      + `<label>${esc(T('compte_contrasenya'))}<input type="password" name="contrasenya" autocomplete="${crea ? 'new-password' : 'current-password'}" minlength="${MIN_CONTRASENYA}" required></label>`
      + `<p class="dlg-error" id="compte-error" role="alert"></p>`
      + `<button class="boto-pri boto-ample" type="submit">${esc(T(crea ? 'compte_crea' : 'compte_entra'))}</button></form>`
      + `<p class="dlg-enllacos"><button type="button" class="enllac" data-accio="mode">${esc(T(crea ? 'compte_ja_tinc' : 'compte_vull_crear'))}</button>`
      + (crea ? '' : ` · <button type="button" class="enllac" data-accio="oblidada">${esc(T('compte_oblidada'))}</button>`) + '</p>'
      + `<p class="nota">${esc(T('compte_privacitat'))}</p>`;
  }

  async function accioCompte(accio) {
    const err = (t) => { const p = $('#compte-error'); if (p) p.textContent = t; };
    if (!A) await auth();
    if (!A) return;
    try {
      if (accio === 'google') {
        await A.signInWithPopup(A.a, new A.GoogleAuthProvider());
        await A.a.currentUser.getIdToken(true);
        estat.usuari = A.a.currentUser;
        await carregaPerfil(); pintaCap();
        $('#dlg-compte').close();
        if (!estat.alias) obreAlias(); else continua();
      } else if (accio === 'mode') { mode = mode === 'crea' ? 'entra' : 'crea'; missatge = ''; pintaCompte(); }
      else if (accio === 'oblidada') {
        const correu = $('#form-compte [name=correu]').value.trim();
        if (!correu) { err(T('compte_error_correu')); return; }
        try { await A.sendPasswordResetEmail(A.a, correu); } catch (e) { if (e.code === 'auth/invalid-email') { err(T('compte_error_correu')); return; } }
        err(T('compte_recorda_enviat'));
      } else if (accio === 'reenvia') { await A.sendEmailVerification(estat.usuari); missatge = T('compte_reenviat'); pintaCompte(); }
      else if (accio === 'verificat') {
        await estat.usuari.reload();
        if (!estat.usuari.emailVerified) { missatge = T('compte_no_verificat'); pintaCompte(); return; }
        await estat.usuari.getIdToken(true);
        estat.usuari = A.a.currentUser;
        await carregaPerfil(); pintaCap(); pinta();
        $('#dlg-compte').close();
        if (!estat.alias) obreAlias(); else continua();
      } else if (accio === 'alias') { $('#dlg-compte').close(); obreAlias(); }
      else if (accio === 'surt') { await A.signOut(A.a); estat.alias = ''; missatge = ''; pintaCap(); pinta(); pintaCompte(); }
    } catch (e) {
      if (e && (e.code === 'auth/popup-closed-by-user' || e.code === 'auth/cancelled-popup-request')) return;
      err(errorCompte(e));
    }
  }

  async function enviaCompte(form) {
    const correu = form.correu.value.trim(), contrasenya = form.contrasenya.value;
    const err = (t) => { $('#compte-error').textContent = t; };
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(correu)) { err(T('compte_error_correu')); return; }
    if (contrasenya.length < MIN_CONTRASENYA) { err(T('compte_error_feble', MIN_CONTRASENYA)); return; }
    const boto = form.querySelector('[type=submit]');
    boto.disabled = true;
    try {
      if (mode === 'crea') {
        const r = await A.createUserWithEmailAndPassword(A.a, correu, contrasenya);
        await A.sendEmailVerification(r.user);
        estat.usuari = r.user; missatge = ''; pintaCompte();
      } else {
        const r = await A.signInWithEmailAndPassword(A.a, correu, contrasenya);
        estat.usuari = r.user;
        if (!registrat(r.user)) { missatge = ''; pintaCompte(); return; }
        await carregaPerfil(); pintaCap(); pinta();
        $('#dlg-compte').close();
        if (!estat.alias) obreAlias(); else continua();
      }
    } catch (e) { err(errorCompte(e)); } finally { boto.disabled = false; }
  }

  // ── Àlies (data/Perfil.kt) ───────────────────────────────────────────────
  const netAlias = (a) => a.trim().replace(/\s+/g, ' ');
  const clauAlias = (a) => netAlias(a).normalize('NFD').replace(/\p{Mn}+/gu, '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const aliasValid = (a) => { const n = netAlias(a), c = clauAlias(n);
    return n.length >= MIN_ALIAS && n.length <= MAX_ALIAS && /^[\p{L}\p{N} ._-]+$/u.test(n) && c.length >= MIN_ALIAS && c.length <= MAX_ALIAS; };

  function obreAlias() {
    const d = $('#dlg-alias');
    $('#alias-titol').textContent = T(estat.alias ? 'alias_titol_canvia' : 'alias_titol');
    $('#form-alias [name=alias]').value = estat.alias;
    $('#alias-error').textContent = '';
    obreDialeg(d);
  }

  async function desaAlias(form) {
    const nou = netAlias(form.alias.value), err = (t) => { $('#alias-error').textContent = t; };
    if (!aliasValid(nou)) { err(T('alias_invalid', MAX_ALIAS)); return; }
    if (!permes(nou)) { err(T('alias_vetat')); return; }
    const clauNova = clauAlias(nou), clauVella = estat.clau, uid = estat.usuari.uid;
    const boto = form.querySelector('[type=submit]');
    boto.disabled = true;
    try {
      let propietari = null;
      try { propietari = camps(await peticio(`${DOCS}/alias/${clauNova}`)).uid || null; } catch (e) { /* lliure */ }
      if (propietari && propietari !== uid) { err(T('alias_ocupat')); return; }
      const reserva = { update: { name: `${DOCS}/alias/${clauNova}`, fields: { uid: str(uid), alias: str(nou) } } };
      if (!propietari) reserva.currentDocument = { exists: false };
      const writes = [reserva, { update: { name: `${DOCS}/perfils/${uid}`, fields: { alias: str(nou), clau: str(clauNova) } },
        updateTransforms: [hora('actualitzat')] }];
      if (clauVella && clauVella !== clauNova) writes.push({ delete: `${DOCS}/alias/${clauVella}` });
      await commit(writes);
      estat.alias = nou; estat.clau = clauNova;
      pintaCap(); pinta();
      $('#dlg-alias').close();
      avisa(T('alias_publiques_com', nou));
      continua();
    } catch (e) {
      err(e.codi === 409 || /ALREADY_EXISTS|FAILED_PRECONDITION/.test(e.message) ? T('alias_ocupat') : T('compte_error_xarxa'));
    } finally { boto.disabled = false; }
  }

  // ── Accions sobre els chollos ────────────────────────────────────────────
  const marca = (camp) => ({ update: { name: `${DOCS}/xollaires/${estat.usuari.uid}`, fields: {} }, updateMask: { fieldPaths: [] },
    updateTransforms: [hora(camp)] });
  const troba = (id) => estat.chollos.find((c) => c.id === id);

  async function vota(id, valor) {
    const c = troba(id), uid = estat.usuari.uid, mem = vots(), abans = mem[id] || 0;
    if (!c || abans === valor) return;
    const canvi = valor - abans;
    const vot = { update: { name: `${DOCS}/chollos/${id}/vots/${uid}`, fields: { valor: int(valor) } } };
    if (abans === 0) { vot.currentDocument = { exists: false }; vot.updateTransforms = [hora('creat')]; }
    else { vot.currentDocument = { exists: true }; vot.updateMask = { fieldPaths: ['valor'] }; }
    try {
      await commit([vot, { transform: { document: `${DOCS}/chollos/${id}`, fieldTransforms: [suma('graus', canvi)] } }]);
      mem[id] = valor; desa.set('ps-vots-' + uid, mem);
      c.graus += canvi;
      pinta(); if (estat.obert === id) pintaDetall();
    } catch (e) {
      if (abans === 0 && (e.codi === 409 || /ALREADY_EXISTS|FAILED_PRECONDITION/.test(e.message))) avisa(T('web_ja_votat'));
      else avisa(T('compte_error_xarxa'));
    }
  }

  function obreNou() {
    const f = $('#form-nou');
    f.reset();
    f.alias.value = estat.alias;
    $('#nou-error').textContent = '';
    $('#nou-com').textContent = T('alias_publiques_com', estat.alias);
    $('#nou-imatge-prev').hidden = true;
    obreDialeg($('#dlg-nou'));
  }

  // La imatge: buida (la posa el bot, la de la pàgina de l'oferta) o un enllaç https, com a les regles
  const imatgeValida = (u) => u === '' || (u.length <= 500 && /^https:\/\/[^\s]+$/.test(u));
  // Vista prèvia de l'enllaç de la imatge (si no es pot carregar, no surt)
  function previsualitza(input, img) {
    const u = input.value.trim();
    if (!imatgeValida(u) || !u) { img.hidden = true; img.removeAttribute('src'); return; }
    img.onload = () => { img.hidden = false; };
    img.onerror = () => { img.hidden = true; };
    img.src = u;
  }
  document.addEventListener('input', (e) => {
    if (e.target.name !== 'imatge') return;
    const img = e.target.closest('form')?.querySelector('img');
    if (img) previsualitza(e.target, img);
  });

  const nombre = (s) => { const n = parseFloat(String(s || '').replace(',', '.')); return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : 0; };
  async function publica(form) {
    const err = (t) => { $('#nou-error').textContent = t; };
    const titol = form.titol.value.trim().slice(0, 120), url = form.url.value.trim(), codi = form.codi.value.trim().slice(0, 30);
    const descripcio = form.descripcio.value.trim().slice(0, 600);
    if (titol.length < MIN_TITOL) { err(T('chollos_error_titol')); return; }
    if (!(url.length <= 500 && /^https:\/\/[^\s]+$/.test(url) && host(url).includes('.'))) { err(T('chollos_error_enllac')); return; }
    if (![titol, descripcio, codi].every(permes)) { err(T('chollos_error_text')); return; }
    const imatge = form.imatge.value.trim();
    if (!imatgeValida(imatge)) { err(T('web_error_imatge')); return; }
    const p = nombre(form.preu.value), pa = nombre(form.preuAnterior.value);
    const id = crypto.randomUUID().replace(/-/g, '').slice(0, 20), uid = estat.usuari.uid;
    const fields = { uid: str(uid), alias: str(estat.alias), titol: str(titol), url: str(url), preu: dbl(p), preuAnterior: dbl(pa),
      codi: str(codi), categoria: str(form.categoria.value), estacio: str(form.estacio.value), descripcio: str(descripcio),
      caduca: str(form.caduca.value || ''), graus: int(0), comentaris: int(0), denuncies: int(0), ocult: bool(false),
      caducat: bool(false), revisat: bool(false), imatge: str(imatge) };
    const boto = form.querySelector('[type=submit]');
    boto.disabled = true;
    try {
      await commit([{ update: { name: `${DOCS}/chollos/${id}`, fields }, currentDocument: { exists: false }, updateTransforms: [hora('creat')] },
        marca('darrer')]);
      $('#dlg-nou').close();
      avisa(T(conegut(url) ? 'chollos_gracies' : 'chollos_gracies_revisio'));
      estat.ordre = 'nous'; estat.cat = 'tots';
      await carrega();
    } catch (e) { err(e.codi === 403 ? T('chollos_error_espera') : T('compte_error_xarxa')); } finally { boto.disabled = false; }
  }

  // ── Fitxa d'un chollo i comentaris ───────────────────────────────────────
  let comentaris = [];
  async function obre(id) {
    if (!troba(id)) return;
    estat.obert = id; comentaris = null;
    if (location.hash !== '#c-' + id) history.replaceState(null, '', '#c-' + id);
    pintaDetall();
    obreDialeg($('#dlg-chollo'));
    try {
      const r = await consulta(`${DOCS}/chollos/${id}`, 'comentaris', 'ASCENDING', 100);
      const fora = amagats();
      comentaris = r.map((x) => x.document && { id: idDe(x.document), ...camps(x.document) })
        .filter((x) => x && !x.ocult && (x.denuncies || 0) < DENUNCIES && !fora.has(x.id));
    } catch (e) { comentaris = []; }
    if (estat.obert === id) pintaDetall();
  }

  function pintaDetall() {
    const c = troba(estat.obert);
    if (!c) return;
    const dte = descompte(c), v = vots()[c.id] || 0;
    const preus = (c.preu > 0 ? `<strong>${preu(c.preu)}</strong>` : '') + (dte ? `<s>${preu(c.preuAnterior)}</s>` : '');
    const foto = c.imatge.startsWith('https://') ? `<img src="${esc(c.imatge)}" alt="" referrerpolicy="no-referrer" onerror="this.remove()">` : '';
    const est = C.estacions[c.estacio] ? `<a class="xip-est" href="${esc(C.urlEstacio.replace('{id}', c.estacio))}">📍 ${esc(C.estacions[c.estacio])}</a>` : '';
    const llista = comentaris == null ? `<p class="nota">${esc(T('web_carregant'))}</p>`
      : comentaris.length ? '<ul class="comentaris">' + comentaris.map((m) => `<li data-cid="${esc(m.id)}"><p class="com-cap"><strong>${esc(m.alias)}</strong> · ${esc(fa(m.creat))}`
        + (estat.usuari && m.uid === estat.usuari.uid ? ` · <button type="button" class="enllac" data-accio="esborra-com">${esc(T('comentaris_esborra'))}</button>`
          : ` · <button type="button" class="enllac" data-accio="denuncia-com">${esc(T('comentaris_denuncia'))}</button>`)
        + `</p><p>${esc(m.text)}</p></li>`).join('') + '</ul>'
        : `<p class="nota">${esc(T('chollos_cap_comentari'))}</p>`;
    const propi = meu(c);
    $('#chollo-cos').innerHTML = `<div class="det-foto cat-${c.categoria}"><span class="chollo-emoji">${EMOJI[c.categoria]}</span>${foto}`
      + (dte ? `<span class="chollo-dte">${esc(T('web_descompte', dte))}</span>` : '') + '</div>'
      + `<div class="det-cos"><p class="chollo-meta">${EMOJI[c.categoria]} ${esc(T('chollos_cat_' + c.categoria))} · ${esc(botiga(c.url))}</p>`
      + `<h2>${esc(c.titol)}</h2>` + (preus ? `<p class="chollo-preus gran">${preus}</p>` : '')
      + `<div class="det-accions"><a class="boto-pri" href="${esc(c.url)}" rel="nofollow noopener sponsored" target="_blank">${esc(T('chollos_anar'))} ↗</a>`
      + `<span class="temp ${c.graus >= 20 ? 'calent' : c.graus < 0 ? 'fred' : ''}" data-temp>`
      + `<button type="button" class="vot${v === -1 ? ' votat' : ''}" data-vot="-1" aria-label="${esc(T('chollos_vota_fred'))}">−</button><b>${c.graus}°</b>`
      + `<button type="button" class="vot${v === 1 ? ' votat' : ''}" data-vot="1" aria-label="${esc(T('chollos_vota_calent'))}">+</button></span>`
      + `<button type="button" class="boto-lleu" data-accio="comparteix">${esc(T('web_comparteix'))}</button></div>`
      + (c.codi ? `<div class="det-codi"><span>${esc(T('chollos_codi'))}</span><code>${esc(c.codi)}</code><button type="button" class="boto-lleu" data-accio="copia">${esc(T('chollos_copia'))}</button></div>` : '')
      + (c.descripcio ? `<p class="det-text">${esc(c.descripcio)}</p>` : '')
      + `<p class="det-dades">${est}${c.caduca ? `<span>⏳ ${esc(T('chollos_caduca', dia(c.caduca)))}</span>` : ''}`
      + `<span>${esc(T('web_publicat_per', fa(c.creat)))} · ${esc(T('web_per', c.alias))}</span></p>`
      + `<p class="nota">${esc(T('chollos_avis'))}</p>`
      + '<p class="det-propi">' + (propi
        ? `<button type="button" class="enllac" data-accio="imatge">${esc(T('web_canvia_imatge'))}</button> · `
          + `<button type="button" class="enllac" data-accio="caducat">${esc(T('chollos_marca_caducat'))}</button> · <button type="button" class="enllac perill" data-accio="esborra">${esc(T('comentaris_esborra'))}</button>`
        : `<button type="button" class="enllac" data-accio="denuncia">${esc(T('comentaris_denuncia'))}</button>`) + '</p>'
      + (propi ? `<form id="form-imatge" class="formulari form-imatge" novalidate hidden><div class="nou-imatge"><label>${esc(T('web_imatge'))}`
        + `<input name="imatge" type="url" inputmode="url" placeholder="https://" value="${esc(c.imatge)}"></label>`
        + `<img alt="" referrerpolicy="no-referrer"${foto ? ` src="${esc(c.imatge)}"` : ' hidden'}></div>`
        + `<p class="nota">${esc(T('web_imatge_hint'))}</p><button class="boto-pri" type="submit">${esc(T('web_desa'))}</button></form>` : '')
      + `<h3>${esc(T('chollos_comentaris'))} (${c.comentaris})</h3>${llista}`
      + '<form id="form-com" class="form-com"><textarea name="text" maxlength="400" rows="2" placeholder="'
      + `${esc(T('chollos_comentari_hint'))}" required></textarea><button class="boto-pri" type="submit">${esc(T('chollos_envia'))}</button></form></div>`;
  }

  async function comenta(form) {
    const c = troba(estat.obert), text = form.text.value.trim().slice(0, 400);
    if (!c || !text) return;
    if (!permes(text)) { avisa(T('chollos_error_text')); return; }
    const cid = crypto.randomUUID().replace(/-/g, '').slice(0, 20);
    try {
      await commit([{ update: { name: `${DOCS}/chollos/${c.id}/comentaris/${cid}`, fields: { uid: str(estat.usuari.uid), alias: str(estat.alias),
        text: str(text), denuncies: int(0), ocult: bool(false) } }, currentDocument: { exists: false }, updateTransforms: [hora('creat')] },
      { transform: { document: `${DOCS}/chollos/${c.id}`, fieldTransforms: [suma('comentaris', 1)] } }, marca('darrerComentari')]);
      c.comentaris += 1;
      pinta();
      obre(c.id);
    } catch (e) { avisa(e.codi === 403 ? T('chollos_error_espera_comentari') : T('compte_error_xarxa')); }
  }

  async function canviaImatge(form) {
    const c = troba(estat.obert), imatge = form.imatge.value.trim();
    if (!c) return;
    if (!imatgeValida(imatge)) { avisa(T('web_error_imatge')); return; }
    try {
      await peticio(`${DOCS}/chollos/${c.id}?updateMask.fieldPaths=imatge`, { metode: 'PATCH', cos: { fields: { imatge: str(imatge) } }, compte: true });
      c.imatge = imatge; pinta(); pintaDetall(); avisa(T('web_fet'));
    } catch (e) { avisa(T('compte_error_xarxa')); }
  }

  async function denuncia(id, cid) {
    const cami = `${DOCS}/chollos/${id}` + (cid ? `/comentaris/${cid}` : '');
    try {
      await commit([{ update: { name: `${cami}/denuncies/${estat.usuari.uid}`, fields: {} }, currentDocument: { exists: false }, updateTransforms: [hora('creat')] },
        { transform: { document: cami, fieldTransforms: [suma('denuncies', 1)] } }]);
    } catch (e) { /* ja l'havia denunciat: igualment s'amaga */ }
    desa.set('ps-amagats', [...amagats(), cid || id].slice(-300));
    avisa(T('comentaris_denunciat'));
    if (cid) { comentaris = comentaris.filter((m) => m.id !== cid); pintaDetall(); } else { $('#dlg-chollo').close(); pinta(); }
  }

  async function accioDetall(accio, el) {
    const c = troba(estat.obert);
    if (!c) return;
    if (accio === 'copia') { try { await navigator.clipboard.writeText(c.codi); avisa(T('chollos_copiat')); } catch (e) { /* sense porta-retalls */ } return; }
    if (accio === 'comparteix') {
      const url = location.origin + location.pathname + '#c-' + c.id;
      if (navigator.share) { navigator.share({ title: c.titol, url }).catch(() => {}); return; }
      try { await navigator.clipboard.writeText(url); avisa(T('web_enllac_copiat')); } catch (e) { /* res */ }
      return;
    }
    const cid = el.closest('[data-cid]')?.dataset.cid;
    if (accio === 'denuncia' || accio === 'denuncia-com') { requereix(() => denuncia(c.id, accio === 'denuncia-com' ? cid : null)); return; }
    if (accio === 'esborra-com') {
      if (!confirm(T('chollos_esborra_comentari'))) return;
      try { await peticio(`${DOCS}/chollos/${c.id}/comentaris/${cid}`, { metode: 'DELETE', compte: true }); comentaris = comentaris.filter((m) => m.id !== cid); pintaDetall(); avisa(T('web_esborrat')); }
      catch (e) { avisa(T('compte_error_xarxa')); }
      return;
    }
    if (accio === 'esborra') {
      if (!confirm(T('chollos_esborra_confirma'))) return;
      try { await peticio(`${DOCS}/chollos/${c.id}`, { metode: 'DELETE', compte: true }); estat.chollos = estat.chollos.filter((x) => x.id !== c.id); $('#dlg-chollo').close(); pinta(); avisa(T('web_esborrat')); }
      catch (e) { avisa(T('compte_error_xarxa')); }
      return;
    }
    if (accio === 'imatge') { const f = $('#form-imatge'); f.hidden = !f.hidden; if (!f.hidden) f.imatge.focus(); return; }
    if (accio === 'caducat') {
      try {
        await peticio(`${DOCS}/chollos/${c.id}?updateMask.fieldPaths=caducat`, { metode: 'PATCH', cos: { fields: { caducat: bool(true) } }, compte: true });
        c.caducat = true; $('#dlg-chollo').close(); pinta(); avisa(T('web_fet'));
      } catch (e) { avisa(T('compte_error_xarxa')); }
    }
  }

  // ── Esdeveniments ────────────────────────────────────────────────────────
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-obre],[data-vot],[data-cat-filtre],[data-ordre],[data-accio],[data-compte],[data-publica],[data-tanca]');
    if (!el) return;
    if (el.matches('[data-tanca]')) { el.closest('dialog')?.close(); return; }
    if (el.matches('[data-compte]')) { e.preventDefault(); obreCompte(); return; }
    if (el.matches('[data-publica]')) { e.preventDefault(); requereix(obreNou); return; }
    if (el.matches('[data-cat-filtre]')) { estat.cat = el.dataset.catFiltre; pinta(); return; }
    if (el.matches('[data-ordre]')) { estat.ordre = el.dataset.ordre; pinta(); return; }
    if (el.matches('[data-vot]')) {
      const id = el.closest('[data-id]')?.dataset.id || estat.obert;
      requereix(() => vota(id, Number(el.dataset.vot)));
      return;
    }
    if (el.matches('[data-obre]')) { e.preventDefault(); obre(el.closest('[data-id]').dataset.id); return; }
    if (el.matches('[data-accio]')) {
      if (el.closest('#dlg-compte')) accioCompte(el.dataset.accio); else accioDetall(el.dataset.accio, el);
    }
  });
  document.addEventListener('submit', (e) => {
    const f = e.target;
    if (!['form-compte', 'form-alias', 'form-nou', 'form-com', 'form-imatge'].includes(f.id)) return;
    e.preventDefault();
    if (f.id === 'form-compte') enviaCompte(f);
    else if (f.id === 'form-alias') desaAlias(f);
    else if (f.id === 'form-nou') publica(f);
    else if (f.id === 'form-imatge') requereix(() => canviaImatge(f));
    else requereix(() => comenta(f));
  });

  // ── Inici ────────────────────────────────────────────────────────────────
  document.documentElement.classList.add('chollos-js');
  pinta();
  carrega().then(() => {
    if (location.hash.startsWith('#c-')) obre(location.hash.slice(3));
  });
  if (location.hash === '#compte') obreCompte();
  if (C.clau) auth().catch(() => {});
})();
