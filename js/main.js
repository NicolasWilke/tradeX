import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, createUserWithEmailAndPassword,
  signInWithEmailAndPassword, signOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, collection, doc, getDoc, setDoc, updateDoc,
  addDoc, deleteDoc, onSnapshot, query, orderBy, limit, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

var firebaseConfig = {
  apiKey: "AIzaSyB_szOcGNYfkQVopi2envbgVHEnSAjGNK0",
  authDomain: "tradex-corp-cd4a3.firebaseapp.com",
  projectId: "tradex-corp-cd4a3",
  storageBucket: "tradex-corp-cd4a3.firebasestorage.app",
  messagingSenderId: "231453438372",
  appId: "1:231453438372:web:7c0205a4ec688e3a5b9131"
};
var fbApp = initializeApp(firebaseConfig);
var auth = getAuth(fbApp);
var db = getFirestore(fbApp);

(function(){
  "use strict";

  /* ---------- analítica y monitoreo de errores ----------
     trackEvent()/trackPageView() mandan a Google Analytics (GA4) si el
     snippet de gtag.js está cargado en el <head> (ver index.html) — si no
     está configurado, gtag no existe y estas llamadas no hacen nada.
     logClientError() manda un registro mínimo a Firestore (colección
     "clientErrors"), que solo se puede escribir, nunca leer desde el
     cliente — se revisa desde Firebase Console. No depende de ninguna
     cuenta ni servicio nuevo, y no tiene costo con el volumen de una app
     recién arrancando. */
  function trackEvent(name, params){
    try{
      if(typeof window.gtag === "function") window.gtag('event', name, params || {});
    }catch(e){ /* la analítica nunca debe romper la app */ }
  }
  function trackPageView(path, title){
    try{
      if(typeof window.gtag === "function") window.gtag('event', 'page_view', {page_path: path, page_title: title});
    }catch(e){}
  }
  function logClientError(message, extra){
    try{
      var payload = {
        message: String(message == null ? "Error sin mensaje" : message).slice(0, 480),
        url: location.href,
        userId: (typeof currentUser !== "undefined" && currentUser) ? currentUser.id : null,
        userAgent: navigator.userAgent,
        createdAt: serverTimestamp()
      };
      if(extra){ for(var k in extra){ if(Object.prototype.hasOwnProperty.call(extra,k)) payload[k] = extra[k]; } }
      addDoc(collection(db, "clientErrors"), payload).catch(function(){ /* si falla el log, no insistimos */ });
    }catch(e){ /* nunca dejar que el logging de errores tire otro error */ }
  }
  window.addEventListener("error", function(ev){
    logClientError(ev.message, {
      source: ev.filename || null, line: ev.lineno || null, col: ev.colno || null,
      stack: (ev.error && ev.error.stack) ? String(ev.error.stack).slice(0,1000) : null
    });
  });
  window.addEventListener("unhandledrejection", function(ev){
    var reason = ev.reason;
    logClientError(reason && reason.message ? reason.message : String(reason), {
      kind: "unhandledrejection",
      stack: (reason && reason.stack) ? String(reason.stack).slice(0,1000) : null
    });
  });

  var AVATAR_COLORS = ["var(--accent)","var(--accent-3)","#F7CBB4"];

  var companies = [];
  var companyById = {};
  var directoryLoaded = false;

  var userPosts = [];
  var postsLoaded = false;

  var postLikes = [];
  var likesLoaded = false;
  var postComments = [];
  var commentsLoaded = false;
  var openCommentsFor = {};
  var commentDrafts = {};
  var composerImageDataUrl = null; // resized/compressed data URL ready to store, or null

  // Los RFQs se guardan en Firestore (colección "rfqs") y se cargan acá
  // mediante attachRfqsListener() — ver más abajo. Antes eran datos de
  // ejemplo en memoria (con ubicaciones y montos en pesos mexicanos, que
  // ni siquiera correspondían a esta red argentina) y se perdían al
  // recargar la página.
  var rfqs = [];
  var rfqsLoaded = false;

  function esc(s){ var d=document.createElement("div"); d.textContent=s; return d.innerHTML; }
  function uniq(a){ return a.filter(function(v,i){ return a.indexOf(v)===i; }); }

  function evidenceBadge(level){
    var bg = level === "Alta" ? "color-mix(in srgb, var(--accent-2) 45%, white)" : level === "Media-Alta" ? "color-mix(in srgb, var(--accent) 32%, white)" : "var(--surface-2)";
    var dot = level === "Alta" ? "var(--accent-2-strong)" : level === "Media-Alta" ? "var(--accent-strong)" : "var(--ink-faint)";
    return '<span class="tag" style="display:inline-flex;align-items:center;gap:6px;background:'+bg+';color:var(--ink);">'+
      '<span style="width:6px;height:6px;border-radius:50%;background:'+dot+';display:inline-block;flex:0 0 auto;"></span>Evidencia '+esc(level)+'</span>';
  }

  function selfTag(c){
    if(!c.selfRegistered) return '';
    return '<span class="tag" style="color:var(--accent-3-strong);">Autodeclarado por la empresa</span>';
  }

  // El badge "Verificada" solo lo activa el equipo de TradeX a mano desde
  // Firebase Console (campo "verificada", congelado contra el cliente en
  // firestore.rules) — no hay ninguna acción del lado del cliente que lo
  // prenda. Ver el proceso manual en la documentación del proyecto.
  function verifiedBadge(c){
    if(!c || !c.verificada) return '';
    return '<span class="tag" style="display:inline-flex;align-items:center;gap:6px;background:color-mix(in srgb, var(--accent-2) 45%, white);color:var(--ink);font-weight:800;">'+
      '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M20 6 9 17l-5-5"></path></svg>Verificada por TradeX</span>';
  }

  function locationLine(c){
    var pin = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s7-6.5 7-12a7 7 0 1 0-14 0c0 5.5 7 12 7 12Z"></path><circle cx="12" cy="10" r="2.4"></circle></svg>';
    return pin + '<span>' + esc(c.ubicacion || "Ubicación no especificada") + '</span>';
  }

  function fuenteLink(url, label){
    return '<a href="'+esc(url)+'" target="_blank" rel="noopener noreferrer" style="display:inline-flex;align-items:center;gap:6px;color:var(--accent-strong);font-size:.8rem;font-weight:700;text-decoration:none;">'+
      esc(label || 'Ver fuente pública')+
      '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M7 17 17 7M9 7h8v8"></path></svg></a>';
  }

  function vinculoGroup(c){
    return c.vinculo || "Proveedores";
  }

  /* ---------- contact info (plan-gated) ---------- */
  var PLAN_LABELS = {
    gratis: "Gratis", pro: "Pro", enterprise: "Enterprise",
    destacado: "Destacado", porcotizacion: "Por cotización"
  };
  function domainFor(c){
    if(!c.fuente) return null;
    try{ return new URL(c.fuente).hostname.replace(/^www\./,""); }
    catch(e){ return null; }
  }
  function hasContactAccess(){
    return !!(currentUser && currentUser.plan && currentUser.plan !== "gratis");
  }
  // Además del plan pago, el dueño de una ficha siempre puede ver su propio
  // contacto (coincide con lo que permiten las reglas de seguridad).
  function canViewContact(c){
    return hasContactAccess() || !!(currentUser && c && currentUser.id === c.id);
  }

  /* ---------- account / auth ---------- */
  var currentUser = null;
  var authUid = null;
  // Nombre/email/teléfono de contacto de la empresa logueada. Vive en un
  // documento separado (companies/{uid}/private/contact) protegido por
  // las reglas de seguridad, no en el documento público de "companies" —
  // así el contacto de cada empresa no queda legible por cualquiera.
  // Se carga con loadCurrentUserContact() cada vez que cambia el usuario.
  var currentUserContact = null;
  var currentUserContactUid = null;
  function loadCurrentUserContact(uid){
    if(currentUserContactUid === uid) return;
    currentUserContactUid = uid;
    getDoc(doc(db, "companies", uid, "private", "contact")).then(function(snap){
      if(currentUserContactUid !== uid) return; // el usuario cambió mientras tanto
      currentUserContact = snap.exists() ? snap.data() : null;
    }).catch(function(err){
      console.error("No se pudo leer el contacto de la cuenta:", err);
    });
  }

  function firebaseErrorToSpanish(err){
    var code = err && err.code;
    var map = {
      "auth/email-already-in-use": "Ese email ya tiene una cuenta registrada. Iniciá sesión en vez de registrarte.",
      "auth/invalid-email": "El email ingresado no es válido.",
      "auth/weak-password": "La contraseña debe tener al menos 6 caracteres.",
      "auth/wrong-password": "Contraseña incorrecta.",
      "auth/user-not-found": "No encontramos una cuenta con ese email.",
      "auth/invalid-credential": "Email o contraseña incorrectos.",
      "auth/missing-password": "Ingresá una contraseña.",
      "auth/too-many-requests": "Demasiados intentos. Probá de nuevo en unos minutos."
    };
    return map[code] || ("Ocurrió un error: " + (err && err.message ? err.message : "intentá de nuevo."));
  }

  function setCurrentUserFromUid(uid){
    loadCurrentUserContact(uid);
    if(companyById[uid]){
      currentUser = companyById[uid];
      refreshAuthUI();
      renderPlanButtons();
      return;
    }
    getDoc(doc(db, "companies", uid)).then(function(snap){
      if(authUid !== uid) return; // the signed-in user changed again meanwhile
      if(snap.exists()){
        var data = snap.data();
        data.id = uid;
        companyById[uid] = data;
        currentUser = data;
        refreshAuthUI();
        renderPlanButtons();
      } else {
        // Auth account exists but has no company profile doc (e.g. a leftover
        // account from a failed registration). Don't leave the UI stuck.
        console.error("Esta cuenta no tiene un perfil de empresa asociado en Firestore (uid: "+uid+").");
        currentUser = null;
        refreshAuthUI();
        signOut(auth).catch(function(){});
        alert("Esta cuenta no tiene un perfil de empresa asociado. Probá registrarte de nuevo con ese email.");
      }
    }).catch(function(err){
      console.error("No se pudo leer el perfil de la cuenta:", err);
      currentUser = null;
      refreshAuthUI();
    });
  }

  function attachCompanyListener(){
    var qy = query(collection(db, "companies"), orderBy("name"));
    onSnapshot(qy, function(snap){
      companies = snap.docs.map(function(d){
        var data = d.data();
        data.id = d.id;
        return data;
      });
      companyById = {};
      companies.forEach(function(c){ companyById[c.id] = c; });
      directoryLoaded = true;
      renderCategoryFilters();
      renderDirectory();
      renderSuggestions();
      renderNetworkMap();
      if(authUid && companyById[authUid]){
        currentUser = companyById[authUid];
        loadCurrentUserContact(authUid);
        refreshAuthUI();
        renderPlanButtons();
      }
      refreshOpenContactPane();
    }, function(err){
      console.error("No se pudo leer el directorio:", err);
    });
  }

  function formatPostTime(ts){
    if(!ts || typeof ts.toDate !== "function") return "ahora";
    return ts.toDate().toLocaleString("es-AR", {day:"2-digit", month:"2-digit", hour:"2-digit", minute:"2-digit"});
  }

  function attachPostsListener(){
    var qy = query(collection(db, "posts"), orderBy("createdAt", "desc"), limit(50));
    onSnapshot(qy, function(snap){
      userPosts = snap.docs.map(function(d){
        var data = d.data();
        data.id = d.id;
        data.__user = true;
        return data;
      });
      postsLoaded = true;
      renderFeed();
    }, function(err){
      console.error("No se pudo leer el feed:", err);
    });
  }

  function attachRfqsListener(){
    var qy = query(collection(db, "rfqs"), orderBy("createdAt", "desc"), limit(50));
    onSnapshot(qy, function(snap){
      rfqs = snap.docs.map(function(d){
        var data = d.data();
        data.id = d.id;
        return data;
      });
      rfqsLoaded = true;
      renderRfq();
    }, function(err){
      console.error("No se pudieron leer los RFQs:", err);
    });
  }

  function attachLikesListener(){
    onSnapshot(collection(db, "postLikes"), function(snap){
      postLikes = snap.docs.map(function(d){
        var data = d.data();
        data.id = d.id;
        return data;
      });
      likesLoaded = true;
      renderFeed();
    }, function(err){
      console.error("No se pudieron leer los Me gusta:", err);
    });
  }

  function attachCommentsListener(){
    var qy = query(collection(db, "postComments"), orderBy("createdAt", "asc"));
    onSnapshot(qy, function(snap){
      postComments = snap.docs.map(function(d){
        var data = d.data();
        data.id = d.id;
        return data;
      });
      commentsLoaded = true;
      renderFeed();
    }, function(err){
      console.error("No se pudieron leer los comentarios:", err);
    });
  }

  function likesForPost(postId){
    return postLikes.filter(function(l){ return l.postId === postId; });
  }
  function commentsForPost(postId){
    return postComments.filter(function(c){ return c.postId === postId; });
  }
  function hasLiked(postId){
    if(!currentUser) return false;
    return postLikes.some(function(l){ return l.postId === postId && l.uid === currentUser.id; });
  }

  function initialsOf(name){
    var words = name.trim().split(/\s+/).filter(Boolean);
    if(!words.length) return "EM";
    if(words.length === 1) return words[0].slice(0,2).toUpperCase();
    return (words[0][0] + words[1][0]).toUpperCase();
  }

  // Returns the inner HTML for an avatar container: the uploaded photo when
  // there is one, otherwise the plain initials text.
  function avatarContent(c){
    if(c && c.photoDataUrl) return '<img src="'+c.photoDataUrl+'" alt="" />';
    return esc((c && c.initials) || "");
  }

  function renderAccount(){
    if(!currentUser) return;
    var initials = currentUser.initials, name = currentUser.name;
    document.getElementById("myAvatarBtn").innerHTML = avatarContent(currentUser);
    document.getElementById("myAvatarBtn").title = name + " — tu cuenta";
    document.getElementById("accountAvatar").innerHTML = avatarContent(currentUser);
    document.getElementById("composerAvatar").innerHTML = avatarContent(currentUser);
    document.getElementById("accountName").textContent = name;
    document.getElementById("accountRole").textContent = currentUser.vinculo + " · " + currentUser.sector;

    var planLabel = PLAN_LABELS[currentUser.plan] || "Gratis";
    var planEl = document.getElementById("accountPlan");
    if(planEl){
      planEl.innerHTML = '<span class="tag" style="'+(hasContactAccess() ? 'color:var(--success);border-color:var(--success);' : '')+'">Plan '+esc(planLabel)+'</span>'+
        '<button type="button" class="link-btn" data-goto-planes style="margin-left:8px;font-size:.76rem;font-weight:700;color:var(--accent-strong);background:none;border:0;cursor:pointer;padding:0;">Cambiar plan</button>';
      planEl.querySelectorAll('[data-goto-planes]').forEach(function(b){
        b.addEventListener('click', function(){ switchView('planes'); closeAuthDropdown(); });
      });
    }

    // Stats are about the network as a whole, not about any one company —
    // nobody gets a privileged "my network" view anymore.
    var alta = companies.filter(function(c){ return c.evidencia === "Alta"; }).length;
    var cats = uniq(companies.map(vinculoGroup)).length;
    document.getElementById("accountStats").innerHTML =
      '<div class="mini-stat"><b>'+companies.length+'</b><span>Empresas en la red</span></div>'+
      '<div class="mini-stat"><b>'+alta+'</b><span>Evidencia alta</span></div>'+
      '<div class="mini-stat"><b class="mono" style="color:var(--accent-strong)">'+cats+'</b><span>Categorías</span></div>';
  }

  // No more full-page gate: the map and directory are public. Login/register
  // live in a small dropdown off the nav, and only actions that need an
  // identity (posting, publishing an RFQ) actually ask for one.
  function refreshAuthUI(){
    var loggedIn = !!currentUser;
    document.getElementById("authToggleBtn").hidden = loggedIn;
    document.getElementById("registerToggleBtn").hidden = loggedIn;
    document.getElementById("myAvatarBtn").hidden = !loggedIn;
    document.getElementById("notifBtn").hidden = !loggedIn;
    document.getElementById("composerHint").textContent = loggedIn ? "Visible para toda tu red B2B" : "Iniciá sesión para publicar";
    if(loggedIn) renderAccount();
  }

  function openAuthDropdown(tab){
    switchAuthTab(tab || "login");
    document.getElementById("authDropdown").hidden = false;
  }
  function closeAuthDropdown(){
    document.getElementById("authDropdown").hidden = true;
  }

  function bootApp(){
    refreshAuthUI();
    renderFeed();
    renderCategoryFilters();
    renderDirectory();
    renderRfq();
    renderSuggestions();
    renderNetworkMap();
    switchView("feed");
    attachCompanyListener();
    attachPostsListener();
    attachRfqsListener();
    attachLikesListener();
    attachCommentsListener();
    onAuthStateChanged(auth, function(user){
      if(user){
        authUid = user.uid;
        setCurrentUserFromUid(user.uid);
      } else {
        authUid = null;
        currentUser = null;
        refreshAuthUI();
      }
    });
  }

  function switchAuthTab(tab){
    document.querySelectorAll(".auth-pane").forEach(function(p){
      p.hidden = p.getAttribute("data-auth-pane") !== tab;
    });
  }
  document.querySelectorAll("[data-auth-tab]").forEach(function(b){
    b.addEventListener("click", function(){ switchAuthTab(b.getAttribute("data-auth-tab")); });
  });

  /* ---------- register: empresa / proveedor category split ---------- */
  var REG_CATEGORIES = {
    empresa: ["Operadores / productoras", "Contratistas / EPC", "Servicios profesionales", "Otro"],
    proveedor: ["Proveedores", "Proveedores tecnológicos", "Contratistas / EPC", "Servicios profesionales", "Otro"]
  };
  var REG_SUBTEXT = {
    empresa: "Registrá tu empresa para pedir cotizaciones a proveedores verificados de la red.",
    proveedor: "Registrate como proveedor para que las empresas de la red te encuentren y te envíen solicitudes de cotización."
  };

  function renderRegCategories(kind){
    var sel = document.getElementById("regVinculo");
    var opts = REG_CATEGORIES[kind] || REG_CATEGORIES.empresa;
    sel.innerHTML = opts.map(function(o){ return '<option value="'+esc(o)+'">'+esc(o)+'</option>'; }).join("");
  }

  function switchRegTab(kind){
    document.querySelectorAll("#regAudienceTabs [data-reg-tab]").forEach(function(b){
      b.setAttribute("aria-selected", b.getAttribute("data-reg-tab") === kind ? "true" : "false");
    });
    document.getElementById("regSubtext").textContent = REG_SUBTEXT[kind] || REG_SUBTEXT.empresa;
    renderRegCategories(kind);
    document.getElementById("registerForm").setAttribute("data-account-type", kind);
  }
  document.querySelectorAll("#regAudienceTabs [data-reg-tab]").forEach(function(b){
    b.addEventListener("click", function(){ switchRegTab(b.getAttribute("data-reg-tab")); });
  });
  switchRegTab("empresa");

  function switchPlanTab(tab){
    document.querySelectorAll("#planAudienceTabs [data-plan-tab]").forEach(function(b){
      b.setAttribute("aria-selected", b.getAttribute("data-plan-tab") === tab ? "true" : "false");
    });
    document.querySelectorAll(".pricing-grid[data-plan-pane]").forEach(function(p){
      p.hidden = p.getAttribute("data-plan-pane") !== tab;
    });
  }
  document.querySelectorAll("[data-plan-tab]").forEach(function(b){
    b.addEventListener("click", function(){ switchPlanTab(b.getAttribute("data-plan-tab")); });
  });

  function currentAuthPane(){
    var visible = document.querySelector(".auth-pane:not([hidden])");
    return visible ? visible.getAttribute("data-auth-pane") : null;
  }

  document.getElementById("authToggleBtn").addEventListener("click", function(){
    closeMobileNav();
    var dd = document.getElementById("authDropdown");
    if(dd.hidden || currentAuthPane() !== "login") openAuthDropdown("login"); else closeAuthDropdown();
  });

  document.getElementById("registerToggleBtn").addEventListener("click", function(){
    closeMobileNav();
    var dd = document.getElementById("authDropdown");
    if(dd.hidden || currentAuthPane() !== "register") openAuthDropdown("register"); else closeAuthDropdown();
  });

  // ---------- mobile hamburger nav ----------
  function closeMobileNav(){
    var nav = document.getElementById("topNav");
    nav.setAttribute("data-open", "false");
    document.getElementById("navToggleBtn").setAttribute("aria-expanded", "false");
  }
  document.getElementById("navToggleBtn").addEventListener("click", function(){
    closeAuthDropdown();
    var nav = document.getElementById("topNav");
    var open = nav.getAttribute("data-open") === "true";
    nav.setAttribute("data-open", open ? "false" : "true");
    this.setAttribute("aria-expanded", open ? "false" : "true");
  });

  document.addEventListener("click", function(ev){
    var dd = document.getElementById("authDropdown");
    var opensAuth = ev.target.closest("#authToggleBtn, #registerToggleBtn, #composerText, #publishPost, #toggleRfqForm");
    if(!dd.hidden && !dd.contains(ev.target) && !opensAuth){
      closeAuthDropdown();
    }
    var nav = document.getElementById("topNav");
    if(nav.getAttribute("data-open") === "true" && !nav.contains(ev.target) && !ev.target.closest("#navToggleBtn")){
      closeMobileNav();
    }
    var menu = document.getElementById("accountMenu");
    if(!menu.hidden && !menu.contains(ev.target) && !ev.target.closest("#myAvatarBtn")){
      closeAccountMenu();
    }
    var editDd = document.getElementById("editProfileDropdown");
    if(!editDd.hidden && !editDd.contains(ev.target) && !ev.target.closest("#myAvatarBtn, #accountMenuEdit, #detailEditProfileBtn")){
      closeEditProfile();
    }
  });

  document.getElementById("loginForm").addEventListener("submit", function(ev){
    ev.preventDefault();
    var formEl = this;
    var email = document.getElementById("loginEmail").value.trim();
    var password = document.getElementById("loginPassword").value;
    var errEl = document.getElementById("loginError");
    errEl.hidden = true;
    var submitBtn = formEl.querySelector('button[type=submit]');
    submitBtn.disabled = true;
    submitBtn.textContent = "Ingresando…";
    signInWithEmailAndPassword(auth, email, password).then(function(){
      closeAuthDropdown();
      formEl.reset();
    }).catch(function(err){
      errEl.textContent = firebaseErrorToSpanish(err);
      errEl.hidden = false;
    }).finally(function(){
      submitBtn.disabled = false;
      submitBtn.textContent = "Ingresar";
    });
  });

  document.getElementById("registerForm").addEventListener("submit", function(ev){
    ev.preventDefault();
    var formEl = this;
    var empresa = document.getElementById("regEmpresa").value.trim();
    var contactoNombre = document.getElementById("regContactoNombre").value.trim();
    var email = document.getElementById("regEmail").value.trim();
    var telefono = document.getElementById("regTelefono").value.trim();
    var vinculo = document.getElementById("regVinculo").value;
    var sector = document.getElementById("regSector").value.trim();
    var ubicacion = document.getElementById("regUbicacion").value.trim();
    var fuente = document.getElementById("regFuente").value.trim();
    var password = document.getElementById("regPassword").value;
    var errEl = document.getElementById("regError");
    var accountTypeBtn = document.querySelector("#regAudienceTabs [data-reg-tab][aria-selected='true']");
    var accountType = accountTypeBtn ? accountTypeBtn.getAttribute("data-reg-tab") : "empresa";

    if(!empresa || !contactoNombre || !email || !telefono || !vinculo || !sector || !ubicacion || !password){
      errEl.textContent = "Completá todos los campos para crear el perfil.";
      errEl.hidden = false;
      return;
    }
    if(password.length < 6){
      errEl.textContent = "La contraseña debe tener al menos 6 caracteres.";
      errEl.hidden = false;
      return;
    }
    errEl.hidden = true;
    var submitBtn = formEl.querySelector('button[type=submit]');
    submitBtn.disabled = true;
    submitBtn.textContent = "Creando perfil…";

    createUserWithEmailAndPassword(auth, email, password).then(function(cred){
      var uid = cred.user.uid;
      // El contacto (nombre/email/teléfono) NO va en el documento público
      // de "companies": vive aparte, en companies/{uid}/private/contact,
      // protegido por reglas de seguridad — así no queda legible por
      // cualquiera que consulte la colección pública.
      var record = {
        name: empresa, vinculo: vinculo, sector: sector, ubicacion: ubicacion,
        descripcion: "", evidencia: fuente ? "Media-Alta" : "Media",
        periodo: "", fuente: fuente, initials: initialsOf(empresa),
        color: companies.length % 3, selfRegistered: true, accountType: accountType, plan: "gratis",
        // "verificada" arranca en false y queda congelado contra el cliente
        // (ver firestore.rules): solo se pone en true a mano desde Firebase
        // Console, después de un chequeo manual de la empresa.
        verificada: false,
        createdAt: serverTimestamp()
      };
      var contactRecord = { nombre: contactoNombre, email: email, telefono: telefono };
      return setDoc(doc(db, "companies", uid), record).then(function(){
        return setDoc(doc(db, "companies", uid, "private", "contact"), contactRecord);
      }).then(function(){
        record.id = uid;
        companyById[uid] = record;
        companies.unshift(record);
        currentUser = record;
        currentUserContact = contactRecord;
        currentUserContactUid = uid;
        refreshAuthUI();
        renderPlanButtons();
        renderCategoryFilters();
        renderDirectory();
        renderSuggestions();
        closeAuthDropdown();
        formEl.reset();
        switchRegTab("empresa");
        openCompany(uid);
        trackEvent('sign_up', {method:'email', account_type: accountType});
      });
    }).catch(function(err){
      errEl.textContent = firebaseErrorToSpanish(err);
      errEl.hidden = false;
    }).finally(function(){
      submitBtn.disabled = false;
      submitBtn.textContent = "Crear perfil";
    });
  });

  /* ---------- plan selection (simulated — no real payments) ---------- */
  function renderPlanButtons(){
    document.querySelectorAll("[data-plan-card]").forEach(function(card){
      var key = card.getAttribute("data-plan-card");
      var planKey = key.split(":")[1];
      var btn = card.querySelector("[data-select-plan]");
      if(!btn) return;
      var isCurrent = !!(currentUser && currentUser.plan === planKey);
      card.classList.toggle("is-current-plan", isCurrent);
      if(isCurrent){
        btn.textContent = "Tu plan actual";
        btn.disabled = true;
        btn.classList.add("btn-outline");
        btn.classList.remove("btn-accent");
      } else {
        btn.disabled = false;
        btn.textContent = btn.getAttribute("data-default-label") || btn.textContent;
      }
      if(!btn.getAttribute("data-default-label")){
        btn.setAttribute("data-default-label", isCurrent ? "" : btn.textContent);
      }
    });
  }
  document.querySelectorAll("[data-select-plan]").forEach(function(btn){
    btn.setAttribute("data-default-label", btn.textContent);
    btn.addEventListener("click", function(){
      if(!currentUser){
        var kind = btn.getAttribute("data-select-plan").split(":")[0];
        openAuthDropdown("register");
        switchRegTab(kind === "proveedor" ? "proveedor" : "empresa");
        return;
      }
      var planKey = btn.getAttribute("data-select-plan").split(":")[1];
      if(planKey !== "gratis"){
        // Los planes pagos todavía no tienen un cobro real detrás (no hay
        // integración de pagos ni Cloud Function que valide nada), y las
        // reglas de seguridad ahora impiden que el cliente se autoasigne
        // un plan pago escribiendo el campo "plan" directamente. Hasta que
        // exista un medio de pago, se activa a mano desde el equipo.
        // Este evento queda registrado en Analytics: es la señal más barata
        // que existe de "cuánta gente quiere pagar" antes de construir el
        // cobro real — conviene mirarlo antes de meterse con Mercado Pago.
        trackEvent('plan_interest_blocked', {plan: planKey});
        alert("Este plan todavía no se puede activar solo — estamos integrando el cobro. Escribinos y lo activamos nosotros mientras tanto.");
        return;
      }
      btn.disabled = true;
      updateDoc(doc(db, "companies", currentUser.id), {plan: planKey}).catch(function(err){
        alert("No se pudo actualizar el plan: " + err.message);
      }).finally(function(){
        btn.disabled = false;
      });
    });
  });
  renderPlanButtons();

  /* ---------- account menu (avatar click) ---------- */
  function closeAccountMenu(){
    document.getElementById("accountMenu").hidden = true;
  }
  function toggleAccountMenu(){
    var menu = document.getElementById("accountMenu");
    menu.hidden = !menu.hidden;
  }
  document.getElementById("myAvatarBtn").addEventListener("click", function(ev){
    ev.stopPropagation();
    closeAuthDropdown();
    closeEditProfile();
    toggleAccountMenu();
  });
  document.getElementById("accountMenuProfile").addEventListener("click", function(){
    closeAccountMenu();
    if(currentUser) openCompany(currentUser.id);
  });
  document.getElementById("accountMenuEdit").addEventListener("click", function(){
    openEditProfile();
  });
  document.getElementById("accountMenuLogout").addEventListener("click", function(){
    closeAccountMenu();
    signOut(auth);
  });

  /* ---------- edit profile ---------- */
  var pendingPhotoDataUrl; // undefined = no change · null = remove photo · string = new photo (data URL)

  function populateSelectOptions(selectEl, options, selected){
    var opts = options.slice();
    if(selected && opts.indexOf(selected) === -1) opts.unshift(selected);
    selectEl.innerHTML = opts.map(function(o){ return '<option value="'+esc(o)+'">'+esc(o)+'</option>'; }).join("");
    selectEl.value = selected || opts[0];
  }

  function resizeImageFile(file, maxDim){
    return new Promise(function(resolve, reject){
      var reader = new FileReader();
      reader.onerror = function(){ reject(new Error("No se pudo leer el archivo.")); };
      reader.onload = function(){
        var img = new Image();
        img.onerror = function(){ reject(new Error("El archivo elegido no es una imagen válida.")); };
        img.onload = function(){
          var scale = Math.min(1, maxDim / Math.max(img.width, img.height));
          var w = Math.max(1, Math.round(img.width * scale));
          var h = Math.max(1, Math.round(img.height * scale));
          var canvas = document.createElement("canvas");
          canvas.width = w; canvas.height = h;
          canvas.getContext("2d").drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL("image/jpeg", 0.82));
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  function setEditPhotoPreview(dataUrl, initials){
    document.getElementById("editPhotoPreview").innerHTML = dataUrl ? '<img src="'+dataUrl+'" alt="" />' : esc(initials || "");
  }

  function openEditProfile(){
    if(!currentUser) return;
    closeAccountMenu();
    closeAuthDropdown();
    pendingPhotoDataUrl = undefined;
    document.getElementById("editEmpresa").value = currentUser.name || "";
    document.getElementById("editContactoNombre").value = (currentUserContact && currentUserContact.nombre) || "";
    document.getElementById("editContactoEmail").value = (currentUserContact && currentUserContact.email) || "";
    document.getElementById("editTelefono").value = (currentUserContact && currentUserContact.telefono) || "";
    var accountType = currentUser.accountType || "empresa";
    populateSelectOptions(document.getElementById("editVinculo"), REG_CATEGORIES[accountType] || REG_CATEGORIES.empresa, currentUser.vinculo);
    document.getElementById("editSector").value = currentUser.sector || "";
    document.getElementById("editUbicacion").value = currentUser.ubicacion || "";
    document.getElementById("editDescripcion").value = currentUser.descripcion || "";
    document.getElementById("editFuente").value = currentUser.fuente || "";
    setEditPhotoPreview(currentUser.photoDataUrl, currentUser.initials);
    document.getElementById("editProfileError").hidden = true;
    document.getElementById("editProfileDropdown").hidden = false;
  }
  function closeEditProfile(){
    document.getElementById("editProfileDropdown").hidden = true;
  }

  document.getElementById("editPhotoPickBtn").addEventListener("click", function(){
    document.getElementById("editPhotoInput").click();
  });
  document.getElementById("editPhotoInput").addEventListener("change", function(){
    var file = this.files && this.files[0];
    this.value = "";
    if(!file) return;
    if(!/^image\//.test(file.type)){
      var errEl0 = document.getElementById("editProfileError");
      errEl0.textContent = "Elegí un archivo de imagen.";
      errEl0.hidden = false;
      return;
    }
    resizeImageFile(file, 240).then(function(dataUrl){
      pendingPhotoDataUrl = dataUrl;
      setEditPhotoPreview(dataUrl, null);
    }).catch(function(err){
      var errEl1 = document.getElementById("editProfileError");
      errEl1.textContent = err.message || "No se pudo procesar la imagen.";
      errEl1.hidden = false;
    });
  });
  document.getElementById("editPhotoRemoveBtn").addEventListener("click", function(){
    pendingPhotoDataUrl = null;
    var nameNow = document.getElementById("editEmpresa").value.trim();
    setEditPhotoPreview(null, nameNow ? initialsOf(nameNow) : (currentUser && currentUser.initials));
  });
  document.getElementById("editProfileCancel").addEventListener("click", function(){
    closeEditProfile();
  });

  document.getElementById("editProfileForm").addEventListener("submit", function(ev){
    ev.preventDefault();
    if(!currentUser) return;
    var formEl = this;
    var empresa = document.getElementById("editEmpresa").value.trim();
    var contactoNombre = document.getElementById("editContactoNombre").value.trim();
    var contactoEmail = document.getElementById("editContactoEmail").value.trim();
    var telefono = document.getElementById("editTelefono").value.trim();
    var vinculo = document.getElementById("editVinculo").value;
    var sector = document.getElementById("editSector").value.trim();
    var ubicacion = document.getElementById("editUbicacion").value.trim();
    var descripcion = document.getElementById("editDescripcion").value.trim();
    var fuente = document.getElementById("editFuente").value.trim();
    var errEl = document.getElementById("editProfileError");

    if(!empresa || !contactoNombre || !contactoEmail || !telefono || !vinculo || !sector || !ubicacion){
      errEl.textContent = "Completá todos los campos obligatorios.";
      errEl.hidden = false;
      return;
    }
    errEl.hidden = true;
    var submitBtn = formEl.querySelector('button[type=submit]');
    submitBtn.disabled = true;
    submitBtn.textContent = "Guardando…";

    // El contacto se guarda aparte (companies/{id}/private/contact), no en
    // el documento público de la empresa — ver el comentario en el registro.
    var update = {
      name: empresa, initials: initialsOf(empresa),
      vinculo: vinculo, sector: sector, ubicacion: ubicacion, descripcion: descripcion, fuente: fuente
    };
    if(pendingPhotoDataUrl !== undefined){
      update.photoDataUrl = pendingPhotoDataUrl;
    }
    var contactUpdate = { nombre: contactoNombre, email: contactoEmail, telefono: telefono };

    Promise.all([
      updateDoc(doc(db, "companies", currentUser.id), update),
      setDoc(doc(db, "companies", currentUser.id, "private", "contact"), contactUpdate)
    ]).then(function(){
      var merged = {};
      for(var k in currentUser){ if(Object.prototype.hasOwnProperty.call(currentUser,k)) merged[k] = currentUser[k]; }
      for(var k2 in update){ if(Object.prototype.hasOwnProperty.call(update,k2)) merged[k2] = update[k2]; }
      currentUser = merged;
      currentUserContact = contactUpdate;
      companyById[currentUser.id] = merged;
      for(var i=0;i<companies.length;i++){
        if(companies[i].id === currentUser.id){ companies[i] = merged; break; }
      }
      refreshAuthUI();
      renderDirectory();
      renderSuggestions();
      renderCategoryFilters();
      renderNetworkMap();
      if(lastOpenCompanyId === currentUser.id) openCompany(currentUser.id, true);
      closeEditProfile();
    }).catch(function(err){
      errEl.textContent = "No se pudieron guardar los cambios: " + err.message;
      errEl.hidden = false;
    }).finally(function(){
      submitBtn.disabled = false;
      submitBtn.textContent = "Guardar cambios";
    });
  });

  /* ---------- publicidad (espacios patrocinados) ---------- */
  var ADS = [
    { sponsor:"SACDE", title:"Sumate al panel de proveedores homologados", text:"Certificate como proveedor para proyectos de montaje industrial en la Patagonia.", cta:"Conocer más", link:"#" },
    { sponsor:"TradeX Seguros", title:"Seguro de caución para PyMEs industriales", text:"Cotizá en minutos la garantía que tu empresa necesita para participar de licitaciones del sector energético.", cta:"Cotizar ahora", link:"#" },
    { sponsor:"Capacitación IPE", title:"Curso: Normas de seguridad en Oil & Gas", text:"Formación certificada para equipos técnicos que operan en Vaca Muerta. Próxima cohorte con cupos limitados.", cta:"Ver programa", link:"#" }
  ];

  function adCardHtml(ad){
    return '<article class="card card-pad post-ad">'+
      '<div class="post-head">'+
        '<div class="avatar-lg" style="width:42px;height:42px;border-radius:11px;border:0;font-size:.7rem;background:var(--surface-2);color:var(--ink-faint);">AD</div>'+
        '<div><div class="post-name">'+esc(ad.sponsor)+'</div><div class="post-meta">Publicidad</div></div>'+
      '</div>'+
      '<p class="post-text" style="font-weight:800;">'+esc(ad.title)+'</p>'+
      '<p class="post-text" style="margin-top:4px;color:var(--ink-soft);">'+esc(ad.text)+'</p>'+
      '<a class="btn btn-outline btn-sm" style="margin-top:12px;" href="'+esc(ad.link)+'" target="_blank" rel="noopener noreferrer sponsored">'+esc(ad.cta)+'</a>'+
    '</article>';
  }

  /* ---------- render: feed (solo actividad — sin directorio) ---------- */
  function renderFeed(){
    var el = document.getElementById("feedList");
    if(!postsLoaded){
      el.innerHTML = '<div class="card card-pad" style="text-align:center;padding:36px 20px;">'+
        '<p style="font-size:.88rem;color:var(--ink-soft);">Cargando publicaciones…</p>'+
      '</div>';
      return;
    }
    if(!userPosts.length){
      el.innerHTML = '<div class="card card-pad" style="text-align:center;padding:36px 20px;">'+
        '<p style="font-size:.88rem;color:var(--ink-soft);">Todavía no hay publicaciones en tu red.</p>'+
        '<p style="font-size:.8rem;color:var(--ink-faint);margin-top:4px;">Sé el primero en compartir una novedad, disponibilidad o logro de tu empresa.</p>'+
      '</div>';
      return;
    }
    // Comment drafts live inside feedList, which we're about to rebuild from
    // scratch — grab whatever the user was typing so we can put it back.
    document.querySelectorAll('[data-comment-input]').forEach(function(inp){
      commentDrafts[inp.getAttribute('data-comment-input')] = inp.value;
    });

    var pieces = [];
    var adIdx = 0;
    userPosts.forEach(function(it, i){
      var likes = likesForPost(it.id);
      var liked = hasLiked(it.id);
      var comments = commentsForPost(it.id);
      var commentsOpen = !!openCommentsFor[it.id];

      var mediaHtml = it.imageDataUrl ? '<img class="post-media" src="'+it.imageDataUrl+'" alt="" loading="lazy" />' : "";

      var commentsHtml = comments.map(function(c){
        return '<div class="comment-item">'+
          '<div class="avatar-sm">'+avatarContent(c)+'</div>'+
          '<div class="comment-body"><b>'+esc(c.name)+'</b>'+esc(c.text)+'</div>'+
        '</div>';
      }).join('');

      pieces.push('<article class="card card-pad" data-post-id="'+it.id+'">'+
        '<div class="post-head">'+
          '<div class="avatar-lg" style="width:42px;height:42px;border-radius:11px;border:0;font-size:.78rem;color:var(--ink);background:var(--accent-2)">'+avatarContent(it)+'</div>'+
          '<div><div class="post-name">'+esc(it.name)+'</div><div class="post-meta">'+esc(it.sector)+' · '+esc(formatPostTime(it.createdAt))+'</div></div>'+
        '</div>'+
        (it.text ? '<p class="post-text">'+esc(it.text)+'</p>' : '')+
        mediaHtml+
        '<div class="post-actions">'+
          '<button type="button" class="post-action-btn'+(liked ? ' is-active' : '')+'" data-like-post="'+it.id+'">'+
            '<svg viewBox="0 0 24 24" width="16" height="16" fill="'+(liked ? 'currentColor' : 'none')+'" stroke="currentColor" stroke-width="2"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8Z"></path></svg>'+
            (likes.length ? likes.length+' ' : '')+'Me gusta'+
          '</button>'+
          '<button type="button" class="post-action-btn" data-toggle-comments="'+it.id+'">'+
            '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 11.5a8.4 8.4 0 0 1-8.9 8.4 9 9 0 0 1-3.6-.7L3 21l1.8-5.1A8.4 8.4 0 1 1 21 11.5Z"></path></svg>'+
            (comments.length ? comments.length+' ' : '')+'Comentarios'+
          '</button>'+
        '</div>'+
        (commentsOpen ? (
          '<div class="post-comments">'+
            (comments.length ? '<div class="comment-list">'+commentsHtml+'</div>' : '<p class="comment-empty">Sé el primero en comentar.</p>')+
            (currentUser ? (
              '<div class="comment-composer">'+
                '<input type="text" placeholder="Escribí un comentario…" data-comment-input="'+it.id+'" maxlength="500" />'+
                '<button type="button" class="btn btn-accent btn-sm" data-comment-submit="'+it.id+'">Comentar</button>'+
              '</div>'
            ) : (
              '<p class="comment-empty"><button type="button" data-open-login-comments style="background:none;border:0;color:var(--accent-strong);font-weight:700;cursor:pointer;padding:0;font-size:inherit;">Iniciá sesión</button> para comentar.</p>'
            ))+
          '</div>'
        ) : '')+
      '</article>');
      if((i+1) % 3 === 0){
        pieces.push(adCardHtml(ADS[adIdx % ADS.length]));
        adIdx++;
      }
    });
    el.innerHTML = pieces.join('');

    document.querySelectorAll('[data-comment-input]').forEach(function(inp){
      var pid = inp.getAttribute('data-comment-input');
      if(commentDrafts[pid]) inp.value = commentDrafts[pid];
    });
  }

  /* ---------- render: directory ---------- */
  var activeCategory = "Todos";

  function renderCategoryFilters(){
    var categories = ["Todos"].concat(uniq(companies.map(vinculoGroup)));
    if(categories.indexOf(activeCategory) === -1) activeCategory = "Todos";
    var el = document.getElementById("categoryFilters");
    el.innerHTML = categories.map(function(cat){
      return '<button class="chip" data-cat="'+esc(cat)+'" aria-pressed="'+(cat===activeCategory)+'">'+esc(cat)+'</button>';
    }).join('');
    el.querySelectorAll('[data-cat]').forEach(function(b){
      b.addEventListener('click', function(){ activeCategory = b.getAttribute('data-cat'); renderCategoryFilters(); renderDirectory(); });
    });
  }

  function renderDirectory(){
    var q = (document.getElementById("globalSearch").value || "").toLowerCase().trim();
    var list = companies.filter(function(c){
      var matchesCat = activeCategory === "Todos" || vinculoGroup(c) === activeCategory;
      var matchesQ = !q || (c.name+" "+c.sector+" "+c.vinculo+" "+(c.ubicacion||"")).toLowerCase().indexOf(q) !== -1;
      return matchesCat && matchesQ;
    });
    var el = document.getElementById("companyGrid");
    if(!directoryLoaded){
      document.getElementById("dirCount").textContent = "Cargando directorio…";
      el.innerHTML = '<p style="color:var(--ink-faint);font-size:.88rem;padding:20px 0;">Cargando directorio…</p>';
      return;
    }
    document.getElementById("dirCount").textContent = list.length + (list.length===1? " empresa encontrada" : " empresas encontradas") + " — perfiles verificados con fuentes públicas.";
    if(!list.length){ el.innerHTML = '<p style="color:var(--ink-faint);font-size:.88rem;padding:20px 0;">No encontramos empresas que coincidan con tu búsqueda.</p>'; return; }
    el.innerHTML = list.map(function(c){
      return '<button class="card card-pad company-card" data-goto="'+c.id+'">'+
        '<div class="top">'+
          '<div class="avatar-lg" style="width:44px;height:44px;border-radius:12px;border:0;font-size:.8rem;color:var(--ink);background:'+AVATAR_COLORS[c.color]+'">'+avatarContent(c)+'</div>'+
          '<div style="min-width:0;">'+
            '<div style="font-weight:800;font-size:.92rem;">'+esc(c.name)+'</div>'+
            '<div class="cat">'+esc(c.vinculo)+' · '+esc(c.sector)+'</div>'+
            '<div class="loc">'+locationLine(c)+'</div>'+
          '</div>'+
        '</div>'+
        '<div class="certs">'+verifiedBadge(c)+evidenceBadge(c.evidencia)+selfTag(c)+'</div>'+
        '<div class="footline"><span style="font-size:.72rem;color:var(--ink-faint);">'+(c.fuente? 'Fuente pública citada' : 'Sin fuente pública')+'</span><span style="font-size:.72rem;color:var(--accent-strong);font-weight:700;">Ver ficha →</span></div>'+
      '</button>';
    }).join('');
    el.querySelectorAll('[data-goto]').forEach(function(b){ b.addEventListener('click', function(){ openCompany(b.getAttribute('data-goto')); }); });
  }

  /* ---------- render: mapa de red ---------- */
  var MAP_CATEGORY_COLORS = ["var(--accent-strong)","var(--accent-2-strong)","var(--accent-3-strong)","#D98C4A","#8A7FE0","#4FA3A0"];

  function renderNetworkMap(){
    var svg = document.getElementById("networkMap");
    if(!svg) return;
    if(!directoryLoaded){
      svg.innerHTML = '<text x="450" y="380" text-anchor="middle" font-family="Manrope, sans-serif" font-size="14" fill="var(--ink-faint)">Cargando mapa…</text>';
      return;
    }
    if(!companies.length){
      svg.innerHTML = '<text x="450" y="380" text-anchor="middle" font-family="Manrope, sans-serif" font-size="14" fill="var(--ink-faint)">Todavía no hay empresas en la red.</text>';
      return;
    }

    var cats = uniq(companies.map(vinculoGroup));
    var byCat = {};
    cats.forEach(function(cat){ byCat[cat] = []; });
    companies.forEach(function(c){ var g = vinculoGroup(c); if(!byCat[g]) byCat[g] = []; byCat[g].push(c); });

    var cx = 450, cy = 380, catR = 160, ring1 = 240, ring2 = 300;
    var n = cats.length || 1;
    var slice = (2*Math.PI) / n;
    var parts = [];
    var catPos = {};

    cats.forEach(function(cat, i){
      var angle = i*slice - Math.PI/2;
      catPos[cat] = { x: cx + catR*Math.cos(angle), y: cy + catR*Math.sin(angle), angle: angle };
    });

    // líneas hub -> categoría
    cats.forEach(function(cat){
      var p = catPos[cat];
      parts.push('<line x1="'+cx+'" y1="'+cy+'" x2="'+p.x.toFixed(1)+'" y2="'+p.y.toFixed(1)+'" stroke="var(--border-strong)" stroke-width="2"></line>');
    });

    // líneas categoría -> empresa + nodos de empresa
    cats.forEach(function(cat){
      var p = catPos[cat];
      var list = byCat[cat];
      var m = list.length;
      list.forEach(function(c, j){
        var t = m <= 1 ? 0.5 : j/(m-1);
        var a = p.angle - slice*0.4 + t*(slice*0.8);
        var ring = (j % 2 === 0) ? ring1 : ring2;
        var x = cx + ring*Math.cos(a), y = cy + ring*Math.sin(a);
        parts.push('<line x1="'+p.x.toFixed(1)+'" y1="'+p.y.toFixed(1)+'" x2="'+x.toFixed(1)+'" y2="'+y.toFixed(1)+'" stroke="var(--border)" stroke-width="1"></line>');
        parts.push('<g class="map-node" data-goto="'+c.id+'">'+
          '<circle cx="'+x.toFixed(1)+'" cy="'+y.toFixed(1)+'" r="8" fill="'+AVATAR_COLORS[c.color]+'" stroke="var(--surface)" stroke-width="1.5"></circle>'+
          '<title>'+esc(c.name)+' — '+esc(c.sector)+'</title>'+
        '</g>');
      });
    });

    // nodos de categoría (encima de las líneas)
    cats.forEach(function(cat, i){
      var p = catPos[cat];
      var color = MAP_CATEGORY_COLORS[i % MAP_CATEGORY_COLORS.length];
      var lx = cx + (catR+34)*Math.cos(p.angle), ly = cy + (catR+34)*Math.sin(p.angle);
      parts.push('<circle cx="'+p.x.toFixed(1)+'" cy="'+p.y.toFixed(1)+'" r="22" fill="'+color+'" stroke="var(--surface)" stroke-width="2"><title>'+esc(cat)+'</title></circle>');
      parts.push('<text x="'+lx.toFixed(1)+'" y="'+ly.toFixed(1)+'" text-anchor="middle" font-family="var(--font-mono)" font-size="10" font-weight="700" fill="var(--ink-soft)">'+esc(cat)+'</text>');
    });

    // hub central
    parts.push('<circle cx="'+cx+'" cy="'+cy+'" r="36" fill="var(--ink)"></circle>');
    parts.push('<text x="'+cx+'" y="'+cy+'" dy="0.35em" text-anchor="middle" font-family="var(--font-display)" font-size="14" font-weight="800" fill="var(--bg)">TradeX</text>');

    svg.innerHTML = parts.join('');
    svg.querySelectorAll('[data-goto]').forEach(function(el){
      el.addEventListener('click', function(){ openCompany(el.getAttribute('data-goto')); });
    });
  }

  /* ---------- render: rfq ---------- */
  function renderRfq(){
    var el = document.getElementById("rfqList");
    if(!rfqsLoaded){
      el.innerHTML = '<p style="font-size:.85rem;color:var(--ink-faint);">Cargando oportunidades…</p>';
      return;
    }
    if(!rfqs.length){
      el.innerHTML = '<div class="card card-pad" style="box-shadow:none;"><p style="font-size:.85rem;color:var(--ink-faint);">Todavía no hay requerimientos publicados. Sé el primero en publicar uno.</p></div>';
      return;
    }
    el.innerHTML = rfqs.map(function(r){
      return '<article class="card card-pad rfq-card">'+
        '<div class="top">'+
          '<div><h3>'+esc(r.title)+'</h3><div class="buyer">'+esc(r.buyerName || "Empresa de la red")+' · '+esc(r.location || "—")+'</div></div>'+
        '</div>'+
        '<div class="rfq-meta">'+
          '<div><span>Categoría</span><b style="font-family:var(--font-body);font-weight:700;">'+esc(r.category)+'</b></div>'+
          '<div><span>Presupuesto</span><b>'+esc(r.budget)+'</b></div>'+
          '<div><span>Entrega</span><b>'+esc(r.deadline)+'</b></div>'+
          '<div><span>Cotizaciones</span><b>'+(r.quotes||0)+'</b></div>'+
        '</div>'+
        '<div class="rfq-foot"><span style="font-size:.76rem;color:var(--ink-faint);">'+esc(formatPostTime(r.createdAt))+'</span><button class="btn btn-accent btn-sm" disabled title="Próximamente">Cotizar ahora</button></div>'+
      '</article>';
    }).join('');
  }

  /* ---------- company detail ---------- */
  var lastView = "feed";
  var lastOpenCompanyId = null;
  var lastOpenTab = "about";
  function refreshOpenContactPane(){
    var detailView = document.getElementById("view-detail");
    if(!detailView || detailView.hidden || !lastOpenCompanyId) return;
    var c = companyById[lastOpenCompanyId];
    if(!c) return;
    var pane = document.querySelector('[data-pane="contacto"]');
    if(!pane) return;
    pane.innerHTML = contactPaneHtml(c);
    bindContactPaneButtons(pane);
    renderContactPaneDetails(pane, c);
  }
  // contactPaneHtml() es SINCRÓNICA y solo decide si el usuario tiene
  // acceso o no (la "puerta"): el dato de contacto en sí ya no vive en el
  // objeto de la empresa (quedó protegido en companies/{id}/private/contact,
  // ver las reglas de seguridad), así que cuando hay acceso se pide con
  // getDoc() en renderContactPaneDetails() y se completa la ficha cuando
  // llega la respuesta.
  function contactPaneHtml(c){
    if(canViewContact(c)){
      return '<div class="card card-pad" style="box-shadow:none;max-width:60ch;">'+
        '<p style="font-size:.85rem;color:var(--ink-faint);">Cargando contacto…</p>'+
      '</div>';
    }
    var loggedIn = !!currentUser;
    return '<div class="card card-pad" style="box-shadow:none;max-width:60ch;text-align:center;padding:28px 20px;">'+
      '<div style="width:40px;height:40px;border-radius:50%;background:var(--surface-2);display:flex;align-items:center;justify-content:center;margin:0 auto 12px;">'+
        '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--ink-faint)" stroke-width="2"><rect x="4" y="10" width="16" height="10" rx="2"></rect><path d="M8 10V7a4 4 0 0 1 8 0v3"></path></svg>'+
      '</div>'+
      (loggedIn
        ? '<p style="font-size:.88rem;color:var(--ink);margin-bottom:4px;font-weight:700;">Los datos de contacto son para cuentas pagas</p>'+
          '<p style="font-size:.82rem;color:var(--ink-soft);margin-bottom:16px;">Disponibles desde el plan Pro (empresas) o Destacado (proveedores).</p>'+
          '<button type="button" class="btn btn-accent btn-sm" data-open-planes>Ver planes</button>'
        : '<p style="font-size:.88rem;color:var(--ink);margin-bottom:4px;font-weight:700;">Iniciá sesión para ver el contacto</p>'+
          '<p style="font-size:.82rem;color:var(--ink-soft);margin-bottom:16px;">Los datos de contacto están disponibles para cuentas con un plan pago.</p>'+
          '<button type="button" class="btn btn-accent btn-sm" data-open-login>Iniciar sesión</button>'
      )+
    '</div>';
  }
  function contactVerifiedCardHtml(info){
    return '<div class="card card-pad" style="box-shadow:none;max-width:60ch;">'+
      '<div style="font-size:.72rem;text-transform:uppercase;letter-spacing:.05em;color:var(--ink-faint);font-weight:800;margin-bottom:8px;">Contacto</div>'+
      (info.nombre ? '<p style="font-size:.9rem;color:var(--ink);margin-bottom:6px;"><b>Nombre:</b> '+esc(info.nombre)+'</p>' : '')+
      (info.email ? '<p style="font-size:.9rem;color:var(--ink);margin-bottom:6px;"><b>Email:</b> '+esc(info.email)+'</p>' : '')+
      (info.telefono ? '<p style="font-size:.9rem;color:var(--ink);margin-bottom:6px;"><b>Teléfono:</b> '+esc(info.telefono)+'</p>' : '')+
      '<p style="font-size:.76rem;color:var(--ink-faint);margin-bottom:14px;">Dato cargado por la empresa al registrarse en TradeX.</p>'+
      '<div style="display:flex;gap:8px;flex-wrap:wrap;">'+
        (info.email ? '<a class="btn btn-outline btn-sm" href="mailto:'+esc(info.email)+'">Escribir por email</a>' : '')+
        (info.telefono ? '<a class="btn btn-outline btn-sm" href="tel:'+esc(info.telefono.replace(/[^+\d]/g,''))+'">Llamar</a>' : '')+
      '</div>'+
    '</div>';
  }
  function contactInferredCardHtml(email){
    return '<div class="card card-pad" style="box-shadow:none;max-width:60ch;">'+
      '<div style="font-size:.72rem;text-transform:uppercase;letter-spacing:.05em;color:var(--ink-faint);font-weight:800;margin-bottom:8px;">Contacto</div>'+
      '<p style="font-size:.9rem;color:var(--ink);margin-bottom:6px;"><b>Email:</b> '+esc(email)+'</p>'+
      '<p style="font-size:.76rem;color:var(--ink-faint);margin-bottom:14px;">Inferido del dominio público de la empresa. Dato ilustrativo del prototipo, no verificado.</p>'+
      '<a class="btn btn-outline btn-sm" href="mailto:'+esc(email)+'">Escribir por email</a>'+
    '</div>';
  }
  function contactEmptyCardHtml(){
    return '<div class="card card-pad" style="box-shadow:none;max-width:60ch;">'+
      '<p style="font-size:.85rem;color:var(--ink-faint);">Esta ficha todavía no tiene un dominio público del que inferir un contacto.</p>'+
    '</div>';
  }
  function bindContactPaneButtons(pane){
    pane.querySelectorAll('[data-open-planes]').forEach(function(b){
      b.addEventListener('click', function(){ switchView('planes'); });
    });
    pane.querySelectorAll('[data-open-login]').forEach(function(b){
      b.addEventListener('click', function(){ openAuthDropdown('login'); });
    });
  }
  function renderContactPaneDetails(pane, c){
    if(!canViewContact(c)) return; // ya se renderizó la puerta (gate) de forma sincrónica
    getDoc(doc(db, "companies", c.id, "private", "contact")).then(function(snap){
      if(lastOpenCompanyId !== c.id) return; // el usuario navegó a otra ficha mientras tanto
      if(snap.exists()){
        pane.innerHTML = contactVerifiedCardHtml(snap.data());
      } else {
        var domain = domainFor(c);
        pane.innerHTML = domain ? contactInferredCardHtml("contacto@"+domain) : contactEmptyCardHtml();
      }
    }).catch(function(err){
      console.error("No se pudo leer el contacto:", err);
      if(lastOpenCompanyId !== c.id) return;
      pane.innerHTML = '<div class="card card-pad" style="box-shadow:none;max-width:60ch;"><p style="font-size:.85rem;color:var(--ink-faint);">No se pudo cargar el contacto.</p></div>';
    });
  }
  function openCompany(id, preserveTab){
    var c = companyById[id];
    if(!c) return;
    lastOpenCompanyId = id;

    var card = document.getElementById("detailCard");
    var tabs = [
      {key:"about", label:"Acerca de"},
      {key:"contacto", label:"Contacto"},
      {key:"fuente", label:"Fuente"}
    ];
    var activeTab = preserveTab && lastOpenTab ? lastOpenTab : "about";

    var panes = {
      about: '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px;">'+
          '<span class="tag">'+esc(c.vinculo)+'</span>'+
          '<span class="tag">'+esc(c.sector)+'</span>'+
          '<span class="tag" style="display:inline-flex;align-items:center;gap:6px;">'+locationLine(c)+'</span>'+
          verifiedBadge(c)+evidenceBadge(c.evidencia)+selfTag(c)+
        '</div>'+
        (c.descripcion ? '<p style="font-size:.95rem;line-height:1.6;color:var(--ink);max-width:70ch;">'+esc(c.descripcion)+'</p>' : ''),
      contacto: contactPaneHtml(c),
      fuente: c.fuente ? (
        '<div class="card card-pad" style="box-shadow:none;max-width:60ch;">'+
          '<div style="font-size:.72rem;text-transform:uppercase;letter-spacing:.05em;color:var(--ink-faint);font-weight:800;margin-bottom:8px;">Fuente pública citada</div>'+
          '<p style="font-size:.85rem;color:var(--ink-soft);word-break:break-all;margin-bottom:14px;">'+esc(c.fuente)+'</p>'+
          fuenteLink(c.fuente, 'Abrir fuente')+
        '</div>'
      ) : (
        '<div class="card card-pad" style="box-shadow:none;max-width:60ch;">'+
          '<p style="font-size:.85rem;color:var(--ink-faint);">Esta empresa todavía no cargó una fuente pública que respalde el vínculo.</p>'+
        '</div>'
      )
    };

    var isOwnProfile = !!(currentUser && currentUser.id === id);

    card.innerHTML =
      '<div class="detail-cover"></div>'+
      '<div class="detail-head">'+
        '<div class="avatar-xl" style="background:'+AVATAR_COLORS[c.color]+'">'+avatarContent(c)+'</div>'+
        '<div class="detail-info"><h2>'+esc(c.name)+'</h2><p style="color:var(--ink-soft);font-size:.88rem;margin-top:2px;">'+esc(c.sector)+' · '+esc(c.vinculo)+' · '+esc(c.ubicacion || "Ubicación no especificada")+'</p></div>'+
        (isOwnProfile ? '<button type="button" class="btn btn-outline btn-sm" id="detailEditProfileBtn">Editar perfil</button>' : '')+
        verifiedBadge(c)+evidenceBadge(c.evidencia)+
      '</div>'+
      '<div class="detail-tabs" id="detailTabs">'+tabs.map(function(t){ return '<button data-tab="'+t.key+'" aria-selected="'+(t.key===activeTab)+'">'+t.label+'</button>'; }).join('')+'</div>'+
      tabs.map(function(t){ return '<div class="detail-pane" data-pane="'+t.key+'" '+(t.key===activeTab?'':'hidden')+'>'+panes[t.key]+'</div>'; }).join('');

    if(isOwnProfile){
      var editBtn = document.getElementById("detailEditProfileBtn");
      if(editBtn) editBtn.addEventListener("click", openEditProfile);
    }

    var contactoPane = card.querySelector('[data-pane="contacto"]');
    if(contactoPane) renderContactPaneDetails(contactoPane, c);

    card.querySelectorAll('[data-tab]').forEach(function(btn){
      btn.addEventListener('click', function(){
        card.querySelectorAll('[data-tab]').forEach(function(b){ b.setAttribute('aria-selected','false'); });
        btn.setAttribute('aria-selected','true');
        var key = btn.getAttribute('data-tab');
        lastOpenTab = key;
        card.querySelectorAll('[data-pane]').forEach(function(p){ p.hidden = p.getAttribute('data-pane') !== key; });
      });
    });
    card.querySelectorAll('[data-open-planes]').forEach(function(b){
      b.addEventListener('click', function(){ switchView('planes'); });
    });
    card.querySelectorAll('[data-open-login]').forEach(function(b){
      b.addEventListener('click', function(){ openAuthDropdown('login'); });
    });

    switchView("detail");
  }

  /* ---------- suggestions ---------- */
  function renderSuggestions(){
    var el = document.getElementById("suggestList");
    var suggestions = companies.slice(0,4);
    el.innerHTML = suggestions.map(function(c){
      return '<div class="suggest-item">'+
        '<div class="avatar-sm" style="background:'+AVATAR_COLORS[c.color]+'">'+avatarContent(c)+'</div>'+
        '<div class="info"><b>'+esc(c.name)+'</b><span>'+esc(c.sector)+'</span></div>'+
        '<button class="btn btn-outline btn-sm" data-goto="'+c.id+'" style="padding:5px 12px;">Ver</button>'+
      '</div>';
    }).join('');
    el.querySelectorAll('[data-goto]').forEach(function(b){ b.addEventListener('click', function(){ openCompany(b.getAttribute('data-goto')); }); });
  }

  /* ---------- view switching ---------- */
  function switchView(name){
    if(name !== "detail") lastView = name;
    var isPlanes = name === "planes";
    document.querySelector("main.layout").hidden = isPlanes;
    document.getElementById("view-planes").hidden = !isPlanes;
    ["feed","directorio","rfq","detail","mapa"].forEach(function(v){
      document.getElementById("view-"+v).hidden = (isPlanes || v !== name);
    });
    document.querySelectorAll('#topNav button').forEach(function(b){
      b.setAttribute('aria-current', b.getAttribute('data-nav') === name ? "true" : "false");
    });
    window.scrollTo({top:0, behavior:"auto"});
    // TradeX es una sola página real (no hay recarga entre secciones), así
    // que GA4 no ve "pageviews" solo. Se avisan a mano acá para poder medir
    // en qué sección se cae la gente (por ejemplo, cuántos llegan a "planes"
    // pero nunca vuelven a "rfq").
    trackPageView("/" + name, document.title + " · " + name);
  }

  document.querySelectorAll('[data-nav]').forEach(function(el){
    el.addEventListener('click', function(ev){
      ev.preventDefault();
      closeMobileNav();
      switchView(el.getAttribute('data-nav'));
    });
  });

  document.getElementById("backBtn").addEventListener('click', function(){ switchView(lastView); });

  document.getElementById("globalSearch").addEventListener('input', function(){
    switchView("directorio");
    renderDirectory();
  });

  document.getElementById("toggleRfqForm").addEventListener('click', function(){
    if(!currentUser){ openAuthDropdown("login"); return; }
    var f = document.getElementById("rfqForm");
    f.hidden = !f.hidden;
  });

  document.getElementById("submitRfq").addEventListener('click', function(){
    if(!currentUser){ openAuthDropdown("login"); return; }
    var titulo = document.getElementById("fTitulo").value.trim();
    var categoria = document.getElementById("fCategoria").value.trim();
    var ubicacion = document.getElementById("fUbicacion").value.trim();
    var entrega = document.getElementById("fEntrega").value.trim();
    var presupuesto = document.getElementById("fPresupuesto").value.trim();
    if(!titulo || !categoria){ document.getElementById("fTitulo").focus(); return; }
    var btn = this;
    btn.disabled = true;
    addDoc(collection(db, "rfqs"), {
      title: titulo, category: categoria || "General",
      location: ubicacion || "—", budget: presupuesto || "A definir", deadline: entrega || "A definir",
      buyerId: currentUser.id, buyerName: currentUser.name || "Empresa de la red",
      quotes: 0, createdAt: serverTimestamp()
    }).then(function(){
      trackEvent('generate_lead', {event_category:'rfq', rfq_category: categoria});
      ["fTitulo","fCategoria","fUbicacion","fEntrega","fPresupuesto"].forEach(function(id){ document.getElementById(id).value=""; });
      document.getElementById("rfqForm").hidden = true;
    }).catch(function(err){
      alert("No se pudo publicar el requerimiento: " + err.message);
    }).finally(function(){
      btn.disabled = false;
    });
  });

  document.getElementById("composerText").addEventListener('focus', function(){
    if(!currentUser){ this.blur(); openAuthDropdown("login"); }
  });

  /* ---------- composer: adjuntar foto ----------
     Igual que la foto de perfil: se redimensiona/comprime en el navegador y
     se guarda como texto (data URL) directo en el documento del posteo — no
     depende de Firebase Storage ni de que el proyecto esté en plan Blaze. */
  function clearComposerMediaPreview(){
    composerImageDataUrl = null;
    var wrap = document.getElementById("composerPreview");
    wrap.innerHTML = "";
    wrap.hidden = true;
  }
  document.getElementById("composerImageBtn").addEventListener("click", function(){
    if(!currentUser){ openAuthDropdown("login"); return; }
    document.getElementById("composerImageInput").click();
  });
  document.getElementById("composerImageInput").addEventListener("change", function(){
    var file = this.files && this.files[0];
    this.value = "";
    if(!file) return;
    if(!/^image\//.test(file.type)){ alert("Elegí un archivo de imagen."); return; }
    resizeImageFile(file, 960).then(function(dataUrl){
      composerImageDataUrl = dataUrl;
      var wrap = document.getElementById("composerPreview");
      wrap.innerHTML = '<img src="'+dataUrl+'" alt="" />'+
        '<button type="button" class="composer-preview-remove" id="composerPreviewRemove" aria-label="Quitar foto">✕</button>';
      wrap.hidden = false;
    }).catch(function(err){
      alert(err.message || "No se pudo procesar la imagen.");
    });
  });
  document.getElementById("composerPreview").addEventListener("click", function(ev){
    if(ev.target.closest("#composerPreviewRemove")) clearComposerMediaPreview();
  });

  document.getElementById("publishPost").addEventListener('click', function(){
    if(!currentUser){ openAuthDropdown("login"); return; }
    var textEl = document.getElementById("composerText");
    var t = textEl.value.trim();
    if(!t && !composerImageDataUrl) return;
    var btn = this;
    btn.disabled = true;
    addDoc(collection(db, "posts"), {
      authorId: currentUser.id,
      name: currentUser.name,
      initials: currentUser.initials,
      photoDataUrl: currentUser.photoDataUrl || null,
      sector: "Publicación propia",
      text: t,
      imageDataUrl: composerImageDataUrl || null,
      createdAt: serverTimestamp()
    }).then(function(){
      textEl.value = "";
      clearComposerMediaPreview();
    }).catch(function(err){
      alert("No se pudo publicar: " + err.message);
    }).finally(function(){
      btn.disabled = false;
    });
  });

  /* ---------- feed: me gusta y comentarios (delegado, los posteos se re-renderizan seguido) ---------- */
  function toggleLike(postId, btnEl){
    if(!currentUser) return;
    var likeId = postId + "__" + currentUser.id;
    var already = hasLiked(postId);
    if(btnEl) btnEl.disabled = true;
    var task = already
      ? deleteDoc(doc(db, "postLikes", likeId))
      : setDoc(doc(db, "postLikes", likeId), { postId: postId, uid: currentUser.id, createdAt: serverTimestamp() });
    task.catch(function(err){
      alert("No se pudo actualizar el Me gusta: " + err.message);
    }).finally(function(){
      if(btnEl) btnEl.disabled = false;
    });
  }

  function submitComment(postId, btnEl){
    if(!currentUser) return;
    var input = document.querySelector('[data-comment-input="'+postId+'"]');
    if(!input) return;
    var text = input.value.trim();
    if(!text) return;
    if(btnEl) btnEl.disabled = true;
    addDoc(collection(db, "postComments"), {
      postId: postId,
      authorId: currentUser.id,
      name: currentUser.name,
      initials: currentUser.initials,
      photoDataUrl: currentUser.photoDataUrl || null,
      text: text,
      createdAt: serverTimestamp()
    }).then(function(){
      delete commentDrafts[postId];
      if(input) input.value = "";
    }).catch(function(err){
      alert("No se pudo publicar el comentario: " + err.message);
    }).finally(function(){
      if(btnEl) btnEl.disabled = false;
    });
  }

  document.getElementById("feedList").addEventListener("click", function(ev){
    var likeBtn = ev.target.closest("[data-like-post]");
    if(likeBtn){
      if(!currentUser){ openAuthDropdown("login"); return; }
      toggleLike(likeBtn.getAttribute("data-like-post"), likeBtn);
      return;
    }
    var toggleBtn = ev.target.closest("[data-toggle-comments]");
    if(toggleBtn){
      var pid = toggleBtn.getAttribute("data-toggle-comments");
      openCommentsFor[pid] = !openCommentsFor[pid];
      renderFeed();
      return;
    }
    var submitBtn = ev.target.closest("[data-comment-submit]");
    if(submitBtn){
      if(!currentUser){ openAuthDropdown("login"); return; }
      submitComment(submitBtn.getAttribute("data-comment-submit"), submitBtn);
      return;
    }
    if(ev.target.closest("[data-open-login-comments]")){
      openAuthDropdown("login");
    }
  });
  document.getElementById("feedList").addEventListener("keydown", function(ev){
    if(ev.key === "Enter" && ev.target.matches && ev.target.matches('[data-comment-input]')){
      ev.preventDefault();
      var pid = ev.target.getAttribute('data-comment-input');
      var btn = document.querySelector('[data-comment-submit="'+pid+'"]');
      submitComment(pid, btn);
    }
  });

  bootApp();
})();
