/* EXODIA DIGITAL chat assistant (self-contained; touches nothing outside its own elements).
   - Chat answers come from /api/chat (Cloudflare Workers AI, free allocation only).
   - "Request a free consultation" sends a form to /api/lead. A preferred date/time is a REQUEST only.
   - If the API is unavailable, the widget says so and offers a pre-filled email instead.
   - Chat history lives only in this page's memory and is not saved in the browser. */
(function () {
  "use strict";

  var EMAIL = "info@exodiadigitals.com";
  var MAX_CHARS = 500;
  var MAX_PAIRS = 5;
  var TURNSTILE_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
  var SERVICES = ["New website", "Portfolio website", "Improve my existing website", "Automation or growth", "Not sure yet"];
  var QUICK = ["What services do you offer?", "How much does a website cost?", "Paano ang proseso ng project?"];
  var OFFLINE_TEXT = "Our assistant is resting for now. You can still send us your details with the \"Request a free consultation\" button, and we'll reply soon.";

  var state = { config: null, configPromise: null, pairs: [], session: null, busy: false, ai: true, turnstile: null, lastFocus: null };

  // ---------- tiny DOM helper ----------
  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === null || v === undefined || v === false) return;
        if (k === "text") node.textContent = v;
        else if (k === "className") node.className = v;
        else if (k.slice(0, 2) === "on") node.addEventListener(k.slice(2), v);
        else node.setAttribute(k, v === true ? "" : v);
      });
    }
    (children || []).forEach(function (c) {
      if (c) node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return node;
  }

  function svg(path) {
    var ns = "http://www.w3.org/2000/svg";
    var s = document.createElementNS(ns, "svg");
    s.setAttribute("viewBox", "0 0 24 24");
    s.setAttribute("aria-hidden", "true");
    var p = document.createElementNS(ns, "path");
    p.setAttribute("d", path);
    s.appendChild(p);
    return s;
  }

  function manilaDate(offsetDays) {
    try {
      return new Date(Date.now() + offsetDays * 86400000).toLocaleDateString("en-CA", { timeZone: "Asia/Manila" });
    } catch (e) {
      return new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);
    }
  }

  // ---------- build the widget ----------
  var launcher = el("button", { type: "button", className: "xd-chat-launcher", "aria-expanded": "false", "aria-controls": "xd-chat-panel", "aria-label": "Open chat with the EXODIA DIGITAL assistant" }, [
    svg("M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.9A8 8 0 1 1 21 12z"),
    el("span", { text: "Chat with us" }),
  ]);

  var closeBtn = el("button", { type: "button", className: "xd-chat-close", "aria-label": "Close chat" }, [svg("M6 6l12 12M18 6L6 18")]);
  var head = el("div", { className: "xd-chat-head" }, [
    el("img", { src: "/assets/images/exodia-digitals-emblem.webp", alt: "", width: "36", height: "36" }),
    el("div", { className: "xd-chat-titles" }, [
      el("strong", { id: "xd-chat-title", text: "EXODIA DIGITAL Assistant" }),
      el("small", { text: "AI assistant · English, Filipino, Taglish" }),
    ]),
    closeBtn,
  ]);

  var log = el("div", { className: "xd-chat-log", role: "log", "aria-live": "polite", "aria-label": "Chat messages" });
  var quick = el("div", { className: "xd-chat-quick" });
  var cta = el("button", { type: "button", className: "xd-chat-cta" }, ["Request a free consultation"]);
  var tsBox = el("div", { className: "xd-chat-ts" });
  var input = el("textarea", { rows: "1", maxlength: String(MAX_CHARS), placeholder: "Type your question…", "aria-label": "Your message" });
  var count = el("span", { className: "xd-chat-count", "aria-hidden": "true", text: "0/" + MAX_CHARS });
  var sendBtn = el("button", { type: "submit", className: "xd-chat-send", "aria-label": "Send message" }, [svg("M4 12l16-8-6 16-2.5-6.5z")]);
  var chatForm = el("form", { className: "xd-chat-input", novalidate: true }, [input, count, sendBtn]);
  var note = el("p", { className: "xd-chat-note" }, [
    "AI answers can be imperfect. Please don't share sensitive information in the chat. ",
    el("a", { href: "privacy.html", target: "_blank", rel: "noopener" }, ["Privacy notice"]),
  ]);
  var chatView = el("div", { className: "xd-chat-view" }, [log, quick, cta, tsBox, chatForm, note]);

  // Consultation request form
  function field(labelText, control, hint) {
    return el("label", { className: "xd-chat-field" }, [el("span", { text: labelText }), control, hint ? el("small", { text: hint }) : null]);
  }
  var f = {
    name: el("input", { name: "name", required: true, maxlength: "100", autocomplete: "name" }),
    email: el("input", { name: "email", type: "email", required: true, maxlength: "254", autocomplete: "email" }),
    businessType: el("input", { name: "businessType", required: true, maxlength: "100", placeholder: "e.g. restaurant, clinic, freelancer" }),
    service: el("select", { name: "service" }, SERVICES.map(function (s) { return el("option", { text: s }); })),
    details: el("textarea", { name: "details", required: true, minlength: "10", maxlength: "2000", rows: "3", placeholder: "What do you want your website to do?" }),
    preferredDate: el("input", { name: "preferredDate", type: "date" }),
    preferredTime: el("select", { name: "preferredTime" }, [
      el("option", { value: "", text: "No preference" }),
      el("option", { value: "morning", text: "Morning" }),
      el("option", { value: "afternoon", text: "Afternoon" }),
      el("option", { value: "evening", text: "Evening" }),
    ]),
    website: el("input", { name: "website", tabindex: "-1", autocomplete: "off" }),
    consent: el("input", { name: "consent", type: "checkbox", required: true }),
  };
  var leadStatus = el("p", { className: "xd-chat-status", role: "status" });
  var leadTs = el("div", { className: "xd-chat-ts" });
  var leadSubmit = el("button", { type: "submit", className: "btn xd-chat-submit" }, ["Send request"]);
  var backBtn = el("button", { type: "button", className: "xd-chat-back" }, ["‹ Back to chat"]);
  var leadForm = el("form", { className: "xd-chat-lead", novalidate: true }, [
    backBtn,
    el("h3", { text: "Request a free consultation" }),
    el("p", { className: "xd-chat-request-note", text: "This is a request, not a booking. We'll contact you to confirm a date and time." }),
    field("Name", f.name),
    field("Email", f.email),
    field("Business type", f.businessType),
    field("What do you need?", f.service),
    field("Project details", f.details),
    el("div", { className: "xd-chat-pair" }, [
      field("Preferred date (request only)", f.preferredDate, "Optional"),
      field("Preferred time of day (PH time)", f.preferredTime, "Optional"),
    ]),
    el("label", { className: "xd-chat-hp", "aria-hidden": "true" }, ["Leave this empty", f.website]),
    el("label", { className: "xd-chat-consent" }, [
      f.consent,
      el("span", {}, [
        "I agree that EXODIA DIGITAL may use these details to reply to my request, as described in the ",
        el("a", { href: "privacy.html", target: "_blank", rel: "noopener" }, ["Privacy notice"]),
        ".",
      ]),
    ]),
    leadTs,
    leadSubmit,
    leadStatus,
  ]);
  var leadView = el("div", { className: "xd-chat-view", hidden: true }, [leadForm]);

  var panel = el("div", { id: "xd-chat-panel", className: "xd-chat-panel", role: "dialog", "aria-labelledby": "xd-chat-title", hidden: true }, [head, chatView, leadView]);
  var root = el("div", { className: "xd-chat" }, [panel, launcher]);

  // ---------- chat rendering ----------
  function bubble(who, text) {
    var b = el("div", { className: "xd-chat-msg xd-chat-" + who }, [text]);
    log.appendChild(b);
    log.scrollTop = log.scrollHeight;
    return b;
  }

  function setAi(on) {
    state.ai = on;
    input.disabled = !on;
    sendBtn.disabled = !on;
    quick.hidden = !on || state.pairs.length > 0;
    input.placeholder = on ? "Type your question…" : "Chat is unavailable right now";
  }

  function renderQuick() {
    quick.textContent = "";
    QUICK.forEach(function (q) {
      quick.appendChild(el("button", { type: "button", onclick: function () { send(q); } }, [q]));
    });
  }

  // ---------- config + Turnstile ----------
  function loadConfig() {
    if (state.configPromise) return state.configPromise;
    state.configPromise = fetch("/api/config", { headers: { Accept: "application/json" } })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(); })
      .catch(function () { return { siteKey: "", ai: false, leads: false }; })
      .then(function (c) { state.config = c; return c; });
    return state.configPromise;
  }

  function loadTurnstile() {
    if (window.turnstile) return Promise.resolve(window.turnstile);
    if (state.turnstile) return state.turnstile;
    state.turnstile = new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = TURNSTILE_SRC;
      s.async = true;
      s.onload = function () { window.turnstile ? resolve(window.turnstile) : reject(new Error("turnstile")); };
      s.onerror = function () { state.turnstile = null; reject(new Error("turnstile")); };
      document.head.appendChild(s);
    });
    return state.turnstile;
  }

  // Runs Turnstile and resolves with a one-time token. The widget stays invisible unless
  // Cloudflare needs the visitor to click; then `onInteractive` lets the caller say so.
  // Rejects with Error("turnstile:<code>") so the visitor (and the owner) can see why.
  function humanCheck(action, box, onInteractive) {
    return loadTurnstile().then(function (ts) {
      return new Promise(function (resolve, reject) {
        box.textContent = "";
        var id = null;
        var finished = false;
        var timer = setTimeout(function () { fail("timeout"); }, 120000);
        function cleanup() {
          finished = true;
          clearTimeout(timer);
          setTimeout(function () { try { if (id !== null) ts.remove(id); } catch (e) {} }, 0);
        }
        function fail(code) {
          if (finished) return;
          cleanup();
          reject(new Error("turnstile:" + code));
        }
        try {
          id = ts.render(box, {
            sitekey: state.config.siteKey,
            action: action,
            appearance: "interaction-only",
            callback: function (token) {
              if (finished) return;
              cleanup();
              resolve(token);
            },
            "before-interactive-callback": function () { if (onInteractive) onInteractive(); },
            "error-callback": function (code) { fail(code || "error"); },
            "expired-callback": function () { fail("expired"); },
            "timeout-callback": function () { fail("interaction-timeout"); },
          });
        } catch (e) {
          fail("render-failed");
        }
      });
    });
  }

  function codeOf(err) {
    var m = err && /^turnstile:(.+)$/.exec(err.message || "");
    return m ? m[1] : "";
  }

  // ---------- sending a chat message ----------
  function send(text) {
    text = (text || "").trim();
    if (!text || state.busy || !state.ai) return;
    if (text.length > MAX_CHARS) { bubble("bot", "Please keep your message under " + MAX_CHARS + " characters."); return; }
    state.busy = true;
    quick.hidden = true;
    bubble("user", text);
    input.value = "";
    updateCount();
    var typing = bubble("bot xd-chat-typing", "Typing…");

    var messages = [];
    state.pairs.slice(-MAX_PAIRS).forEach(function (p) {
      messages.push({ role: "user", content: p[0] }, { role: "assistant", content: p[1] });
    });
    messages.push({ role: "user", content: text });

    var tokenStep = state.session
      ? Promise.resolve(null)
      : humanCheck("chat", tsBox, function () { typing.textContent = "Please complete the quick security check below."; });
    tokenStep
      .then(function (token) {
        return fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: messages, session: state.session, turnstile: token }),
        }).then(function (r) { return r.json(); });
      })
      .then(function (data) {
        typing.remove();
        if (data && data.session) state.session = data.session;
        var reply = data && typeof data.reply === "string" ? data.reply : OFFLINE_TEXT;
        if (data && data.status === "verify") {
          state.session = null;
          bubble("bot", reply + (data.reason ? " (code: " + data.reason + ")" : ""));
          return;
        }
        bubble("bot", reply);
        if (data && data.status === "ok") state.pairs.push([text, reply]);
        else if (data && data.status === "offline") setAi(false);
      })
      .catch(function (err) {
        typing.remove();
        var code = codeOf(err);
        bubble("bot", code
          ? "The security check couldn't be completed (code: " + code + "). Please try again, or use \"Request a free consultation\"."
          : "Sorry, the connection didn't work. Please try again, or use \"Request a free consultation\".");
      })
      .then(function () {
        state.busy = false;
        if (state.ai) input.focus();
      });
  }

  function updateCount() {
    count.textContent = input.value.length + "/" + MAX_CHARS;
  }

  // ---------- consultation request ----------
  function mailtoFallback(data) {
    var body = "Name: " + data.name + "\nEmail: " + data.email + "\nBusiness type: " + data.businessType + "\nNeeds: " + data.service +
      (data.preferredDate ? "\nPreferred date (request only): " + data.preferredDate + (data.preferredTime ? ", " + data.preferredTime : "") : "") +
      "\n\n" + data.details;
    return "mailto:" + EMAIL + "?subject=" + encodeURIComponent("Consultation request from " + data.name) + "&body=" + encodeURIComponent(body);
  }

  function showLeadError(message, data) {
    leadStatus.textContent = "";
    leadStatus.appendChild(document.createTextNode(message + " "));
    if (data) leadStatus.appendChild(el("a", { href: mailtoFallback(data) }, ["Send by email instead"]));
    leadStatus.className = "xd-chat-status xd-chat-error";
  }

  function showLeadSuccess(ref, isRequest) {
    leadForm.hidden = true;
    var box = el("div", { className: "xd-chat-done", tabindex: "-1" }, [
      el("h3", { text: isRequest ? "Request received" : "Message received" }),
      el("p", {}, ["Your reference: ", el("strong", { text: ref })]),
      isRequest
        ? el("p", { className: "xd-chat-request-note", text: "This is not yet a confirmed appointment. We'll email you to confirm or suggest another time." })
        : el("p", { text: "We'll reply by email with next steps." }),
      el("p", { className: "xd-chat-next", text: "What happens next:" }),
      el("ol", {}, [
        el("li", { text: "We review your details." }),
        el("li", { text: "We email you to arrange a free call." }),
        el("li", { text: "You get a written scope, timeline and fixed price before any work starts." }),
      ]),
      el("button", { type: "button", className: "xd-chat-back", onclick: function () { box.remove(); leadForm.reset(); leadForm.hidden = false; showChat(); } }, ["‹ Back to chat"]),
    ]);
    leadView.appendChild(box);
    box.focus();
  }

  leadForm.addEventListener("submit", function (e) {
    e.preventDefault();
    if (leadSubmit.disabled) return;
    var data = {
      name: f.name.value.trim(),
      email: f.email.value.trim(),
      businessType: f.businessType.value.trim(),
      service: f.service.value,
      details: f.details.value.trim(),
      preferredDate: f.preferredDate.value,
      preferredTime: f.preferredDate.value ? f.preferredTime.value : "",
      website: f.website.value,
      consent: f.consent.checked,
    };
    if (!leadForm.checkValidity() || data.details.length < 10) {
      leadForm.reportValidity();
      showLeadError("Please fill in all fields (project details: at least 10 characters) and tick the consent box.");
      return;
    }
    if (data.preferredDate && (data.preferredDate < f.preferredDate.min || data.preferredDate > f.preferredDate.max)) {
      showLeadError("Please choose a preferred date between tomorrow and 60 days from now.");
      return;
    }

    leadSubmit.disabled = true;
    leadStatus.className = "xd-chat-status";
    leadStatus.textContent = "Sending…";

    loadConfig()
      .then(function (c) {
        if (!c.leads) throw new Error("offline");
        return humanCheck("lead", leadTs, function () { leadStatus.textContent = "Please complete the security check above the button."; });
      })
      .then(function (token) {
        data.turnstile = token;
        return fetch("/api/lead", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) }).then(function (r) { return r.json(); });
      })
      .then(function (res) {
        if (res && res.status === "ok") { leadStatus.textContent = ""; showLeadSuccess(res.ref, Boolean(res.request)); }
        else if (res && res.status === "verify") showLeadError((res.message || "The security check didn't go through. Please try again.") + (res.reason ? " (code: " + res.reason + ")" : ""), data);
        else if (res && (res.status === "invalid" || res.status === "limited")) showLeadError(res.message || "Please check the form and try again.");
        else showLeadError("We couldn't send your request right now.", data);
      })
      .catch(function (err) {
        var code = codeOf(err);
        showLeadError(code
          ? "The security check couldn't be completed (code: " + code + "). Please try again."
          : "We couldn't send your request right now.", data);
      })
      .then(function () { leadSubmit.disabled = false; });
  });

  // ---------- open / close / switch views ----------
  function showChat() {
    leadView.hidden = true;
    chatView.hidden = false;
    if (state.ai) input.focus(); else cta.focus();
  }

  function showLead() {
    chatView.hidden = true;
    leadView.hidden = false;
    f.preferredDate.min = manilaDate(1);
    f.preferredDate.max = manilaDate(60);
    leadStatus.textContent = "";
    f.name.focus();
  }

  function open() {
    state.lastFocus = document.activeElement;
    panel.hidden = false;
    launcher.setAttribute("aria-expanded", "true");
    root.classList.add("xd-chat-open");
    if (!log.childNodes.length) {
      bubble("bot", "Hi! I'm the EXODIA DIGITAL AI assistant. Ask me about our services, packages or how a project works. English, Filipino or Taglish is fine.");
      renderQuick();
    }
    loadConfig().then(function (c) {
      if (!c.ai && state.ai) {
        setAi(false);
        bubble("bot", OFFLINE_TEXT);
      } else if (c.ai) {
        quick.hidden = state.pairs.length > 0;
      }
    });
    showChat();
  }

  function close() {
    panel.hidden = true;
    launcher.setAttribute("aria-expanded", "false");
    root.classList.remove("xd-chat-open");
    (state.lastFocus && state.lastFocus.focus ? state.lastFocus : launcher).focus();
  }

  launcher.addEventListener("click", function () { panel.hidden ? open() : close(); });
  closeBtn.addEventListener("click", close);
  cta.addEventListener("click", showLead);
  backBtn.addEventListener("click", showChat);
  panel.addEventListener("keydown", function (e) { if (e.key === "Escape") close(); });
  chatForm.addEventListener("submit", function (e) { e.preventDefault(); send(input.value); });
  input.addEventListener("input", updateCount);
  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(input.value); }
  });

  function mount() { document.body.appendChild(root); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
  else mount();
})();
