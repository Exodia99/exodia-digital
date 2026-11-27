(function () {
  "use strict";
  var modal = document.getElementById("wkmodal");
  if (!modal || typeof modal.showModal !== "function") return;
  var view = modal.querySelector(".wk-view");
  var addr = modal.querySelector(".wk-addr");
  var link = modal.querySelector(".wk-new");
  var lastFocus = null;

  function open(card) {
    var title = card.getAttribute("data-title") || "";
    var img = card.getAttribute("data-img") || "";
    var url = card.getAttribute("data-url") || "";
    view.textContent = "";
    if (url) {
      var frame = document.createElement("iframe");
      frame.src = url;
      frame.title = title + " website preview";
      frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation");
      frame.setAttribute("referrerpolicy", "no-referrer");
      view.appendChild(frame);
    } else {
      var pic = document.createElement("img");
      pic.src = img;
      pic.alt = title + " website homepage";
      view.appendChild(pic);
    }
    addr.textContent = title + (url ? "" : " \u00b7 website preview");
    link.href = url || img;
    view.scrollTop = 0;
    lastFocus = document.activeElement;
    document.body.classList.add("wk-lock");
    modal.showModal();
    modal.querySelector(".wk-x").focus();
  }

  function close() { modal.close(); }

  modal.addEventListener("close", function () {
    document.body.classList.remove("wk-lock");
    view.textContent = "";
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  });
  modal.querySelector(".wk-x").addEventListener("click", close);
  modal.addEventListener("click", function (e) { if (e.target === modal) close(); });

  Array.prototype.forEach.call(document.querySelectorAll("#work .wk"), function (card) {
    card.addEventListener("click", function () { open(card); });
  });
})();
