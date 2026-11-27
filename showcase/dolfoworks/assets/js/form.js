/*
 * Appointment / inquiry form.
 * - If the form has a data-endpoint (e.g. a Formspree or Web3Forms URL), submissions are POSTed there.
 * - Otherwise the request is turned into a ready-made message the customer sends by SMS or Messenger.
 */
(function () {
  "use strict";
  var form = document.getElementById("book-form");
  if (!form) return;
  var done = document.getElementById("book-done");
  var status = document.getElementById("form-status");
  var SHOP_SMS = "+639994290654";

  var date = form.elements.preferred_date;
  var msg = form.elements.message;

  // Earliest selectable date is today (local time).
  var t = new Date();
  date.min = t.getFullYear() + "-" + String(t.getMonth() + 1).padStart(2, "0") + "-" + String(t.getDate()).padStart(2, "0");

  function isAppt() { return form.elements.request_type.value === "Appointment"; }

  // Appointment shows date/time; inquiry makes the message required instead.
  function syncType() {
    var appt = isAppt();
    form.classList.toggle("is-inquiry", !appt);
    date.required = appt;
    msg.required = !appt;
    form.querySelector(".msg-req").hidden = appt;
    form.querySelector(".msg-label").textContent = appt ? "Details (optional)" : "Your concern";
    var btn = form.querySelector('button[type="submit"]');
    (btn.querySelector(".btn-label") || btn).textContent = appt ? "Request Appointment" : "Send Inquiry";
  }
  Array.prototype.forEach.call(form.elements.request_type, function (r) { r.addEventListener("change", syncType); });
  syncType();

  function setError(el, text) {
    var f = el.closest(".field"), e = f && f.querySelector(".error");
    if (e) e.textContent = text || "";
    el.setAttribute("aria-invalid", text ? "true" : "false");
  }

  function validate() {
    var first = null;
    function check(el, ok, text) {
      setError(el, ok ? "" : text);
      if (!ok && !first) first = el;
    }
    var phone = form.elements.phone.value.replace(/[\s()-]/g, "");
    check(form.elements.name, form.elements.name.value.trim().length >= 2, "Please enter your name.");
    check(form.elements.phone, /^(\+?63|0)9\d{9}$/.test(phone), "Please enter a valid mobile number, e.g. 0917 123 4567.");
    check(form.elements.vehicle_type, !!form.elements.vehicle_type.value, "Please choose car or motorcycle.");
    check(form.elements.service, !!form.elements.service.value, "Please choose a service.");
    if (isAppt()) check(date, !!date.value && date.value >= date.min, "Please choose a date from today onward.");
    else setError(date, "");
    if (!isAppt()) check(msg, msg.value.trim().length >= 5, "Please describe your concern.");
    else setError(msg, "");
    if (first) first.focus();
    return !first;
  }

  // Clear a field's error as soon as it is fixed.
  form.addEventListener("input", function (e) { if (e.target.getAttribute("aria-invalid") === "true") setError(e.target, ""); });
  form.addEventListener("change", function (e) { if (e.target.getAttribute("aria-invalid") === "true") setError(e.target, ""); });

  function fmtDate(v) {
    if (!v) return "";
    var p = v.split("-"), d = new Date(+p[0], +p[1] - 1, +p[2]);
    return d.toLocaleDateString("en-PH", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
  }
  function fmtTime(v) {
    if (!v) return "";
    var p = v.split(":"), h = +p[0];
    return ((h % 12) || 12) + ":" + p[1] + (h < 12 ? " AM" : " PM");
  }

  function buildMessage() {
    var e = form.elements, lines = [];
    lines.push("DolfoWorks " + (isAppt() ? "appointment request" : "inquiry"));
    lines.push("Name: " + e.name.value.trim());
    lines.push("Mobile: " + e.phone.value.trim());
    lines.push("Vehicle: " + e.vehicle_type.value + (e.vehicle.value.trim() ? " - " + e.vehicle.value.trim() : ""));
    lines.push("Service: " + e.service.value);
    if (isAppt()) {
      lines.push("Preferred date: " + fmtDate(date.value) + (e.preferred_time.value ? ", " + fmtTime(e.preferred_time.value) : ""));
    }
    if (msg.value.trim()) lines.push((isAppt() ? "Details: " : "Concern: ") + msg.value.trim());
    return lines.join("\n");
  }

  function showDone(text) {
    document.getElementById("book-preview").textContent = text;
    // iOS uses "&body=", Android accepts "?body="; "?&body=" works on both.
    document.getElementById("send-sms").href = "sms:" + SHOP_SMS + "?&body=" + encodeURIComponent(text);
    form.hidden = true;
    done.hidden = false;
    done.focus();
  }

  document.getElementById("book-edit").addEventListener("click", function () {
    done.hidden = true;
    form.hidden = false;
    document.getElementById("copy-status").textContent = "";
    form.elements.name.focus();
  });

  document.getElementById("send-fb").addEventListener("click", function () {
    var text = document.getElementById("book-preview").textContent;
    var s = document.getElementById("copy-status");
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        s.textContent = "Message copied. Paste it in the Messenger chat with DolfoWorks.";
      }, function () { s.textContent = "Copy the message above, then paste it in Messenger."; });
    } else {
      s.textContent = "Copy the message above, then paste it in Messenger.";
    }
  });

  form.addEventListener("submit", function (ev) {
    ev.preventDefault();
    status.textContent = "";
    if (form.elements.company.value) return;           // spam trap filled: ignore silently
    if (!validate()) return;

    var text = buildMessage();
    var endpoint = form.dataset.endpoint;
    if (!endpoint) { showDone(text); return; }

    var btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    status.textContent = "Sending…";
    var data = new FormData(form);
    data.append("summary", text);
    fetch(endpoint, { method: "POST", body: data, headers: { Accept: "application/json" } })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        form.reset(); syncType();
        status.textContent = "Thank you! Your request was sent. DolfoWorks will contact you to confirm.";
      })
      .catch(function () {
        // Fall back to SMS / Messenger so the request is never lost.
        showDone(text);
      })
      .then(function () { btn.disabled = false; });
  });
})();
