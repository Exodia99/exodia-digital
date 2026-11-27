(function () {
  "use strict";
  var IMAGES = window.IMAGES || {};
  var WORK = window.WORK || [];
  var LABELS = { detailing: "Detailing", paint: "Paint & Body", accessories: "Accessories",
                 carbon: "Carbon Fiber", maintenance: "Maintenance", motorcycle: "Motorcycle" };

  function srcset(id) {
    return (IMAGES[id] || []).map(function (s) { return s.file + " " + s.w + "w"; }).join(", ");
  }
  function smallest(id) { var s = IMAGES[id] || []; return s[0] || { file: "", w: 600, h: 800 }; }
  function largest(id) { var s = IMAGES[id] || []; return s[s.length - 1] || smallest(id); }

  /* ---------- Header: solid background once scrolled ---------- */
  var header = document.querySelector(".site-header");
  function onScroll() { header.classList.toggle("is-scrolled", window.scrollY > 8); }
  onScroll();
  window.addEventListener("scroll", onScroll, { passive: true });

  /* ---------- Mobile menu ---------- */
  var menuBtn = document.querySelector(".menu-btn");
  var nav = document.getElementById("nav");
  function setMenu(open) {
    document.body.classList.toggle("menu-open", open);
    menuBtn.setAttribute("aria-expanded", String(open));
    menuBtn.setAttribute("aria-label", open ? "Close menu" : "Open menu");
  }
  menuBtn.addEventListener("click", function () { setMenu(!document.body.classList.contains("menu-open")); });
  nav.addEventListener("click", function (e) { if (e.target.closest("a")) setMenu(false); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") setMenu(false); });

  /* ---------- Active nav link while scrolling ---------- */
  var links = Array.prototype.slice.call(nav.querySelectorAll("a"));
  if ("IntersectionObserver" in window) {
    var spy = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        links.forEach(function (a) { a.classList.toggle("is-active", a.getAttribute("href") === "#" + en.target.id); });
      });
    }, { rootMargin: "-45% 0px -50% 0px" });
    ["services", "work", "shop", "book", "visit"].forEach(function (id) {
      var el = document.getElementById(id); if (el) spy.observe(el);
    });
  }

  /* ---------- Project gallery ---------- */
  var grid = document.getElementById("work-grid");
  WORK.forEach(function (job, i) {
    var cover = job.photos[0], s = smallest(cover);
    var li = document.createElement("li");
    li.className = "work-card";
    li.dataset.cats = job.cats.join(" ");
    li.innerHTML =
      '<button type="button" class="work-btn" data-job="' + i + '">' +
        '<span class="work-media"><img loading="lazy" decoding="async" src="' + s.file + '" srcset="' + srcset(cover) +
        '" sizes="(min-width: 1100px) 25vw, (min-width: 700px) 33vw, 50vw" width="' + s.w + '" height="' + s.h + '" alt=""></span>' +
        '<span class="work-text"><span class="work-tags"></span><span class="work-title"></span><span class="work-vehicle"></span>' +
        '<span class="work-cta">View project <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></svg></span></span>' +
        (job.photos.length > 1 ? '<span class="work-count"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 8h3l2-3h6l2 3h3v11H4zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z"/></svg>' + job.photos.length + '</span>' : "") +
      "</button>";
    li.querySelector("img").alt = job.vehicle + ": " + job.title;
    li.querySelector(".work-tags").textContent = job.cats.map(function (c) { return LABELS[c]; }).join(" · ");
    li.querySelector(".work-title").textContent = job.title;
    li.querySelector(".work-vehicle").textContent = job.vehicle;
    grid.appendChild(li);
  });

  var chips = Array.prototype.slice.call(document.querySelectorAll(".chip"));
  // Project count on each filter chip.
  chips.forEach(function (chip) {
    var f = chip.dataset.filter;
    var n = f === "all" ? WORK.length : WORK.filter(function (j) { return j.cats.indexOf(f) !== -1; }).length;
    var b = document.createElement("span"); b.className = "chip-count"; b.textContent = n; chip.appendChild(b);
  });
  // Totals strip, counted from the real project list.
  var stats = document.getElementById("work-stats");
  if (stats) {
    var photos = WORK.reduce(function (t, j) { return t + j.photos.length; }, 0);
    var motos = WORK.filter(function (j) { return j.cats.indexOf("motorcycle") !== -1; }).length;
    [[WORK.length, "Projects"], [photos, "Project photos"], [WORK.length - motos, "Car jobs"], [motos, "Motorcycle jobs"]].forEach(function (s) {
      var d = document.createElement("div"); d.className = "work-stat";
      d.innerHTML = "<strong></strong><span></span>";
      d.querySelector("strong").textContent = s[0]; d.querySelector("span").textContent = s[1];
      stats.appendChild(d);
    });
  }
  chips.forEach(function (chip) {
    chip.addEventListener("click", function () {
      var f = chip.dataset.filter;
      chips.forEach(function (c) {
        var on = c === chip; c.classList.toggle("is-active", on); c.setAttribute("aria-pressed", String(on));
      });
      grid.querySelectorAll(".work-card").forEach(function (card) {
        card.hidden = !(f === "all" || card.dataset.cats.split(" ").indexOf(f) !== -1);
      });
    });
  });

  /* ---------- Project viewer (dialog) ---------- */
  var viewer = document.getElementById("viewer");
  var vImg = document.getElementById("viewer-img");
  var vCount = document.getElementById("viewer-count");
  var current = null, idx = 0;

  function showPhoto() {
    var id = current.photos[idx], big = largest(id);
    vImg.src = big.file;
    vImg.srcset = srcset(id);
    vImg.sizes = "(min-width: 900px) 60vw, 100vw";
    vImg.width = big.w; vImg.height = big.h;
    vImg.alt = current.vehicle + ": " + current.title + " (photo " + (idx + 1) + " of " + current.photos.length + ")";
    vCount.textContent = current.photos.length > 1 ? (idx + 1) + " / " + current.photos.length : "";
    viewer.classList.toggle("single", current.photos.length < 2);
  }
  function openJob(i) {
    current = WORK[i]; idx = 0;
    document.getElementById("viewer-title").textContent = current.vehicle + " · " + current.title;
    document.getElementById("viewer-tags").textContent = current.cats.map(function (c) { return LABELS[c]; }).join(" · ");
    var list = document.getElementById("viewer-list");
    list.innerHTML = "";
    current.items.forEach(function (t) { var li = document.createElement("li"); li.textContent = t; list.appendChild(li); });
    showPhoto();
    if (typeof viewer.showModal === "function") viewer.showModal(); else viewer.setAttribute("open", "");
    document.body.classList.add("no-scroll");
  }
  function step(d) { if (!current) return; idx = (idx + d + current.photos.length) % current.photos.length; showPhoto(); }
  function closeViewer() { if (viewer.open) viewer.close(); }

  grid.addEventListener("click", function (e) {
    var b = e.target.closest(".work-btn"); if (b) openJob(+b.dataset.job);
  });
  viewer.querySelector(".prev").addEventListener("click", function () { step(-1); });
  viewer.querySelector(".next").addEventListener("click", function () { step(1); });
  viewer.querySelector(".viewer-close").addEventListener("click", closeViewer);
  viewer.addEventListener("click", function (e) { if (e.target === viewer) closeViewer(); });
  viewer.addEventListener("close", function () { document.body.classList.remove("no-scroll"); current = null; });
  viewer.addEventListener("keydown", function (e) {
    if (e.key === "ArrowLeft") step(-1);
    if (e.key === "ArrowRight") step(1);
  });
  var touchX = null;
  vImg.addEventListener("touchstart", function (e) { touchX = e.touches[0].clientX; }, { passive: true });
  vImg.addEventListener("touchend", function (e) {
    if (touchX === null) return;
    var dx = e.changedTouches[0].clientX - touchX; touchX = null;
    if (Math.abs(dx) > 40) step(dx < 0 ? 1 : -1);
  });

  /* ---------- Map: load Google Maps only when asked (keeps the page fast) ---------- */
  var mapBtn = document.querySelector(".map-load");
  if (mapBtn) mapBtn.addEventListener("click", function () {
    var f = document.createElement("iframe");
    f.src = mapBtn.dataset.mapSrc;
    f.title = "Map showing the DolfoWorks location";
    f.loading = "lazy";
    f.referrerPolicy = "no-referrer-when-downgrade";
    mapBtn.replaceWith(f);
  });

  var y = document.getElementById("year"); if (y) y.textContent = new Date().getFullYear();
})();
