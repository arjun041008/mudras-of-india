/*
 * app.js — gallery rendering, random button, deep links.
 *
 * Public API (window.App), for the search/filter code:
 *   App.render(list)  re-render #gallery with an array of mudra objects (e.g. filtered results)
 *   App.select(id)    put a mudra on the stage by id and scroll to it -> Promise<boolean>
 *   App.all           the full window.MUDRAS array
 *   App.byId          Map of id -> mudra
 *   App.visible       the list currently rendered in the gallery
 */
(function () {
  "use strict";

  const all = Array.isArray(window.MUDRAS) ? window.MUDRAS : [];
  const byId = new Map(all.map((m) => [m.id, m]));
  const gallery = document.getElementById("gallery");
  const countEl = document.getElementById("gallery-count");
  let visible = all;

  const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function card(m) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "mudra-card";
    btn.dataset.id = m.id;

    const thumb = document.createElement("span");
    thumb.className = "thumb";
    const img = document.createElement("img");
    img.alt = ""; // decorative: the card's text names the mudra
    img.loading = "lazy";
    img.decoding = "async";
    // Missing image -> stylized placeholder (CSS draws the ring; we add the initial).
    img.addEventListener("error", () => {
      thumb.classList.add("is-missing");
      thumb.dataset.initial = (m.name || "?").charAt(0);
      img.remove();
    }, { once: true });
    if (m.image) img.src = m.image;
    else { thumb.classList.add("is-missing"); thumb.dataset.initial = (m.name || "?").charAt(0); }
    thumb.append(img);

    const body = document.createElement("span");
    body.className = "card-body";

    const name = document.createElement("span");
    name.className = "card-name";
    name.textContent = m.name;

    const fn = document.createElement("span");
    fn.className = "card-function";
    fn.textContent = m.function || m.english || "";

    const meta = document.createElement("span");
    meta.className = "card-meta";
    (m.traditions || []).forEach((t) => {
      const tag = document.createElement("span");
      tag.className = `card-tradition t-${t}`;
      tag.innerHTML = window.Stage ? Stage.traditionIcon(t) : "";
      tag.append(t === "dance" ? "Dance" : "Yoga");
      meta.append(tag);
    });
    if (m.bookPage) {
      const p = document.createElement("span");
      p.className = "card-page";
      p.textContent = `p. ${m.bookPage}`;
      meta.append(p);
    }

    body.append(name, fn, meta);
    btn.append(thumb, body);
    return btn;
  }

  function render(list) {
    visible = Array.isArray(list) ? list : all;
    const frag = document.createDocumentFragment();
    visible.forEach((m) => frag.append(card(m)));
    gallery.replaceChildren(frag);

    if (!visible.length) {
      const empty = document.createElement("p");
      empty.className = "gallery-empty";
      empty.textContent = "No mudras match. Try another word or clear the filters.";
      gallery.append(empty);
    }
    countEl.textContent = visible.length === all.length
      ? `${all.length} mudras`
      : `Showing ${visible.length} of ${all.length} mudras`;
  }

  function select(id, opts) {
    const m = byId.get(id);
    if (!m) return Promise.resolve(false);
    if (!opts || opts.scroll !== false) {
      document.getElementById("stage").scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "start" });
    }
    if (location.hash !== "#" + id) history.replaceState(null, "", "#" + id);
    // Mark the selected card
    gallery.querySelectorAll(".mudra-card[aria-current]").forEach((c) => c.removeAttribute("aria-current"));
    const c = gallery.querySelector(`.mudra-card[data-id="${CSS.escape(id)}"]`);
    if (c) c.setAttribute("aria-current", "true");
    return Stage.goTo(m);
  }

  function selectRandom() {
    const pool = visible.length ? visible : all;
    if (!pool.length) return;
    let m = pool[Math.floor(Math.random() * pool.length)];
    if (pool.length > 1 && Stage.current && m.id === Stage.current.id) {
      m = pool[(pool.indexOf(m) + 1) % pool.length]; // avoid repeating the same one
    }
    select(m.id);
  }

  /* ------------------------------------------------------------ events */

  gallery.addEventListener("click", (e) => {
    const c = e.target.closest(".mudra-card");
    if (c) select(c.dataset.id);
  });

  document.getElementById("random-btn").addEventListener("click", selectRandom);

  // "Return to hands" (handled by Stage.reset) also clears the deep link and selection.
  document.getElementById("info-back").addEventListener("click", () => {
    history.replaceState(null, "", location.pathname + location.search);
    gallery.querySelectorAll(".mudra-card[aria-current]").forEach((c) => c.removeAttribute("aria-current"));
  });

  // Clearing the hash (or navigating to an id) keeps the stage in sync.
  window.addEventListener("hashchange", () => {
    const id = decodeURIComponent(location.hash.slice(1));
    if (byId.has(id)) select(id, { scroll: false });
  });

  /* -------------------------------------------------------------- boot */

  render(all);
  const initial = decodeURIComponent(location.hash.slice(1));
  if (byId.has(initial)) select(initial);

  window.App = {
    render,
    select,
    all,
    byId,
    get visible() { return visible; }
  };
})();
