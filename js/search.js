/*
 * search.js — search box (combobox dropdown), live gallery filter, category chips.
 *
 * How the search works (no library):
 *   1. normalize(): lowercase, strip diacritics/punctuation.
 *   2. Drop stopwords ("cure", "for", "mudra"…), map everyday words to the book's
 *      categories via SYNONYMS ("insomnia" -> Sleep).
 *   3. canon(): fold common transliteration variants (sh->s, w->v, jn->gy, aspirates,
 *      doubled letters, final "a") so "shunya"/"sunya", "jnana"/"gyan" compare equal.
 *   4. Score each mudra per query word, summing the best match in each field group:
 *        name/altName  100 exact · 80 prefix · 60 small typo (edit distance)
 *        category      50  (also chakras, and synonym hits)
 *        function/benefits/english  30 exact · 20 prefix
 *        other text (description, technique, …)  10 exact · 6 prefix
 *      Every query word must match something (AND); if nothing does, fall back to OR.
 *
 * Depends on window.App (app.js), window.MUDRAS / window.CATEGORIES (data/mudras.js).
 */
(function () {
  "use strict";

  if (!window.App) return;
  const CATEGORIES = Array.isArray(window.CATEGORIES) ? window.CATEGORIES : [];

  const input = document.getElementById("search");
  const listbox = document.getElementById("search-results");
  const chipRow = document.getElementById("category-chips");
  const MAX_RESULTS = 8;

  /* ------------------------------------------------------------ text helpers */

  function normalize(s) {
    return String(s || "")
      .normalize("NFD").replace(/[̀-ͯ]/g, "") // diacritics
      .toLowerCase()
      .replace(/['’`]/g, "")                            // can't -> cant
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  const words = (s) => normalize(s).split(" ").filter(Boolean);

  // Fold transliteration variants so different spellings meet in the middle.
  function canon(w) {
    if (w.length < 3 || /^[ivx]+$/.test(w)) return w; // keep short words and roman numerals (I, II, III)
    return w
      .replace(/w/g, "v")                 // vayu / wayu
      .replace(/jn/g, "gy")               // jnana -> gyana
      .replace(/([bcdgkpst])h/g, "$1")    // aspirates: sh->s, th->t, dh->d, bh->b …
      .replace(/ee/g, "i").replace(/oo/g, "u")
      .replace(/(.)\1+/g, "$1")           // doubled letters
      .replace(/^(.{3,})a$/, "$1");       // optional final "a": gyana / gyan
  }

  // Classic Levenshtein distance (only used on short name words).
  function editDistance(a, b) {
    if (Math.abs(a.length - b.length) > 2) return 99;
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      for (let j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return prev[b.length];
  }

  // How many typos we forgive in a name word of this length.
  const typoBudget = (q) => (q.length >= 7 ? 2 : q.length >= 4 ? 1 : 0);

  /* ------------------------------------------------------- query vocabulary */

  const STOPWORDS = new Set((
    "a an the and or of for to in on at by with my me i im ive is are be can cant cannot not no " +
    "t s get getting got how what which that this help helps helping cure cures curing heal " +
    "relieve relief treat treatment reduce fix stop remedy against good best mudra mudras hasta gesture pose"
  ).split(" "));

  // Everyday word -> category name prefix (resolved against window.CATEGORIES below).
  const SYNONYMS = {
    insomnia: ["Sleep"], sleepless: ["Sleep"], sleeping: ["Sleep"],
    stomach: ["Digestion"], digest: ["Digestion"], indigestion: ["Digestion"], gut: ["Digestion"],
    bloating: ["Digestion"], acidity: ["Digestion"], gas: ["Digestion"], constipated: ["Constipation"],
    migraine: ["Headache"], head: ["Headache"],
    nervous: ["Anxiety"], worry: ["Anxiety"], worried: ["Anxiety"], panic: ["Anxiety", "Fear"], anxious: ["Anxiety"],
    stress: ["Stress Reduction", "Anxiety"], stressed: ["Stress Reduction", "Anxiety"], tension: ["Stress Reduction"],
    relax: ["Stress Reduction"], calm: ["Stress Reduction", "Emotional Balance"],
    sad: ["Depression"], sadness: ["Depression"], depressed: ["Depression"], grief: ["Depression"],
    afraid: ["Fear"], scared: ["Fear"], phobia: ["Fear"], fearless: ["Fear", "Courage"],
    focus: ["Concentration"], attention: ["Concentration"], study: ["Concentration", "Memory"],
    forget: ["Memory"], forgetful: ["Memory"],
    breathing: ["Respiratory"], breath: ["Respiratory"], asthma: ["Respiratory"], lung: ["Respiratory"],
    lungs: ["Respiratory"], sinus: ["Respiratory"], nose: ["Respiratory"], cough: ["Respiratory", "Common Cold"],
    flu: ["Common Cold"], cold: ["Common Cold"],
    tired: ["Fatigue"], energy: ["Fatigue"], exhausted: ["Fatigue"], exhaustion: ["Fatigue"], weak: ["Fatigue"],
    period: ["Women"], periods: ["Women"], menstrual: ["Women"], menstruation: ["Women"], pms: ["Women"],
    menopause: ["Women"], pregnancy: ["Women"], fertility: ["Women", "Sexual"], women: ["Women"], men: ["Men"],
    heart: ["Heart"], blood: ["Heart"], hypertension: ["Heart"], bp: ["Heart"],
    god: ["Devotion"], gods: ["Devotion"], deity: ["Devotion"], prayer: ["Devotion"], worship: ["Devotion"],
    meditate: ["Meditation"], meditating: ["Meditation"],
    dance: ["Dance"], dancing: ["Dance"], bharatanatyam: ["Dance"], kathak: ["Dance"], natya: ["Dance"],
    anger: ["Emotional Balance"], angry: ["Emotional Balance"], mood: ["Emotional Balance"], emotions: ["Emotional Balance"],
    immunity: ["Immune"], weight: ["Weight Loss"], obesity: ["Weight Loss"], fat: ["Weight Loss"],
    back: ["Spine"], backache: ["Spine"], posture: ["Spine"],
    eye: ["Eyes"], vision: ["Eyes"], sight: ["Eyes"], ear: ["Ears"], earache: ["Ears"], hearing: ["Ears"],
    throat: ["Voice"], stutter: ["Voice"], stuttering: ["Voice"], speech: ["Voice"],
    joints: ["Arthritis"], joint: ["Arthritis"], fracture: ["Bones"], bone: ["Bones"],
    acne: ["Skin"], confidence: ["Courage", "Willpower"], brave: ["Courage"], bravery: ["Courage"],
    smoking: ["Addiction"], quit: ["Addiction"], thyroid: ["Endocrine"], hormones: ["Endocrine"], hormone: ["Endocrine"],
    jetlag: ["Travel"], motion: ["Travel", "Ears"], cleanse: ["Detox"], toxins: ["Detox"],
    enlightenment: ["Spiritual"], kundalini: ["Spiritual", "Chakras"], awakening: ["Spiritual"],
    temperature: ["Fever"], shaking: ["Tremors"], tremor: ["Tremors"], libido: ["Sexual"], sex: ["Sexual"],
    grounded: ["Grounding"], centered: ["Grounding"], intuitive: ["Intuition"], discipline: ["Willpower"]
  };

  // Resolve prefixes like "Women" to the exact category name ("Women’s Health").
  function resolveCategory(prefix) {
    const p = normalize(prefix);
    const c = CATEGORIES.find((cat) => normalize(cat.name).startsWith(p));
    return c ? c.name : null;
  }
  function synonymCategories(word) {
    let list = SYNONYMS[word] || SYNONYMS[word.replace(/s$/, "")];
    if (!list && word.length >= 4) {              // half-typed: "insom" -> insomnia
      const key = Object.keys(SYNONYMS).find((k) => k.startsWith(word));
      list = key ? SYNONYMS[key] : null;
    }
    list = list || [];
    return list.map(resolveCategory).filter(Boolean);
  }

  /* ------------------------------------------------------------------ index */

  const canonSet = (text) => [...new Set(words(text).map(canon))];
  const rawSet = (text) => [...new Set(words(text))];

  const index = App.all.map((m) => {
    const nameText = [m.name, ...(m.altNames || [])].join(" ");
    return {
      m,
      // name words without the word "mudra": as typed (raw) and spelling-folded (canon)
      nameRaw: rawSet(nameText).filter((w) => w !== "mudra"),
      nameCanon: canonSet(nameText).filter((w) => w !== "mudra"),
      // the bare name, e.g. "abhaya hrdaya", for whole-phrase matching
      base: words(m.name).filter((w) => w !== "mudra" && !/^[ivx]+$/.test(w)).join(" "),
      groups: [...(m.categories || []), ...(m.chakras || [])].map((g) => ({ label: g, raw: rawSet(g), canon: canonSet(g) })),
      main: new Set([...rawSet([m.function, m.benefits, m.english].join(" ")), ...canonSet([m.function, m.benefits, m.english].join(" "))]),
      other: new Set(words([m.description, m.technique, m.application, m.note, m.caution, m.tidbit].join(" ")))
    };
  });

  const startsAny = (list, q) => list.some((w) => w.startsWith(q));

  // Score one query word against one mudra. Tiers are far apart so that, while
  // typing, mudras whose NAME fits what you typed always come before text matches.
  function scoreWord(entry, term) {
    const q = term.raw, qc = term.canon;
    let score = 0, via = null;

    // 1. Name / alternative names
    if (entry.nameRaw.includes(q)) score += 120;                              // exact word
    // (an everyday word like "sad" counts only as a whole name word, not as the start of "Sadashiva")
    else if (term.cats.length) { /* skip partial name matching for everyday words */ }
    else if (startsAny(entry.nameRaw, q)) score += 100;                       // name starts with what you typed
    else if (qc.length >= 2 && entry.nameCanon.includes(qc)) score += 95;     // spelling variant: sunya ~ shunya
    else if (qc.length >= 2 && startsAny(entry.nameCanon, qc)) score += 85;   // variant prefix: gyan ~ jnana
    else if (q.length >= 3 && entry.nameRaw.some((w) => w.includes(q))) score += 70; // inside a name: padma -> Alapadma
    else if (typoBudget(q) && [...entry.nameRaw, ...entry.nameCanon].some((w) =>
      // compare with the same-length start of the name, so half-typed typos match ("pratk" ~ "pataka")
      editDistance(w.slice(0, q.length), q) <= typoBudget(q) ||
      editDistance(w.slice(0, q.length - 1), q) <= typoBudget(q) ||   // one extra letter typed: "pratk"
      editDistance(w, q) <= typoBudget(q))) score += 60;

    // 2. Category / chakra: via the synonym map, or the category's own words
    const group = entry.groups.find((g) => term.cats.includes(g.label)) ||
      (q.length >= 3 && entry.groups.find((g) => startsAny(g.raw, q) || startsAny(g.canon, qc)));
    if (group) { score += 50; via = group.label; }

    // 3. Function, benefits, English meaning: whole words, or prefixes of 4+ letters
    if (entry.main.has(q) || entry.main.has(qc)) score += 30;
    else if (q.length >= 3 && [...entry.main].some((w) => w.startsWith(q))) score += 15; // "mon" -> monkey

    // 4. Description, technique etc.: whole words only (keeps the dropdown focused)
    if (q.length >= 4 && entry.other.has(q)) score += 8;

    return { score, via };
  }

  function parseQuery(text) {
    const all = words(text);
    let kept = all.filter((w) => !STOPWORDS.has(w));
    if (!kept.length) kept = all.filter((w) => w !== "mudra"); // a lone "a" or "i" still searches names
    return kept.map((w) => ({ raw: w, canon: canon(w), cats: synonymCategories(w) }));
  }

  // Returns [{ m, score, via }] sorted best-first. Empty query -> [].
  function search(text) {
    const terms = parseQuery(text);
    if (!terms.length) return [];
    const phrase = terms.map((t) => t.raw).join(" ");

    const scored = index.map((entry) => {
      let score = 0, hits = 0, via = null;
      terms.forEach((t) => {
        const r = scoreWord(entry, t);
        if (r.score > 0) { hits++; score += r.score; via = via || r.via; }
      });
      if (entry.base === phrase) score += 40;             // "abhaya" -> Abhaya I/II before Abhaya Hrdaya
      else if (entry.base.startsWith(phrase)) score += 25; // "abhaya hr" -> Abhaya Hrdaya
      return { m: entry.m, score, hits, via };
    }).filter((r) => r.hits > 0);

    const all = scored.filter((r) => r.hits === terms.length);
    const pool = all.length ? all : scored; // AND first, OR as a fallback
    // ties: shorter (closer) names first, then A–Z
    return pool.sort((a, b) => b.score - a.score || a.m.name.length - b.m.name.length || a.m.name.localeCompare(b.m.name));
  }

  /* ------------------------------------------------------------- highlight */

  // Append `text` to `parent`, wrapping words that match the query in <mark>.
  function appendHighlighted(parent, text, terms) {
    const parts = String(text || "").split(/([A-Za-zÀ-ɏḀ-ỿ]+)/);
    parts.forEach((part, i) => {
      if (i % 2 === 1 && isHit(part, terms)) {
        const mk = document.createElement("mark");
        mk.textContent = part;
        parent.append(mk);
      } else if (part) {
        parent.append(document.createTextNode(part));
      }
    });
  }
  function isHit(word, terms) {
    const w = canon(normalize(word));
    if (w === "mudra") return false;
    return terms.some((t) =>
      (t.canon.length >= 2 && w.startsWith(t.canon)) ||
      (typoBudget(t.canon) && editDistance(w, t.canon) <= typoBudget(t.canon)));
  }

  /* -------------------------------------------------------------- dropdown */

  let results = [];   // current dropdown results
  let active = -1;    // index of the highlighted option

  function renderDropdown(query) {
    const terms = parseQuery(query);
    results = search(query).slice(0, MAX_RESULTS);
    active = -1;
    listbox.replaceChildren();

    if (!query.trim()) return closeDropdown();

    if (!results.length) {
      const p = document.createElement("div");
      p.className = "search-empty";
      p.textContent = `No mudras found for “${query.trim()}”.`;
      listbox.append(p);
    }

    results.forEach((r, i) => {
      const opt = document.createElement("div");
      opt.className = "search-result";
      opt.id = `search-opt-${i}`;
      opt.setAttribute("role", "option");
      opt.setAttribute("aria-selected", "false");
      opt.dataset.id = r.m.id;

      const name = document.createElement("span");
      name.className = "result-name";
      appendHighlighted(name, r.m.name, terms);

      const eng = document.createElement("span");
      eng.className = "result-english";
      appendHighlighted(eng, r.m.english, terms);

      const fn = document.createElement("span");
      fn.className = "result-function";
      if (r.via) {
        // Show which category the match came through, e.g. "Headache"
        const tag = document.createElement("span");
        tag.className = "result-via";
        tag.textContent = r.via;
        fn.append(tag, " ");
      }
      appendHighlighted(fn, r.m.function || "", terms);

      opt.append(name, eng, fn);
      listbox.append(opt);
    });

    listbox.hidden = false;
    input.setAttribute("aria-expanded", "true");
    input.removeAttribute("aria-activedescendant");
  }

  function closeDropdown() {
    listbox.hidden = true;
    active = -1;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  }

  function setActive(i) {
    const opts = listbox.querySelectorAll(".search-result");
    if (!opts.length) return;
    active = (i + opts.length) % opts.length; // wrap around
    opts.forEach((o, j) => {
      const on = j === active;
      o.classList.toggle("is-active", on);
      o.setAttribute("aria-selected", on ? "true" : "false");
    });
    input.setAttribute("aria-activedescendant", opts[active].id);
    opts[active].scrollIntoView({ block: "nearest" });
  }

  // Pick a result: close the dropdown and send the hands to that mudra.
  function choose(id) {
    closeDropdown();
    input.blur(); // hides the mobile keyboard
    App.select(id);
  }

  /* --------------------------------------------------- gallery + categories */

  let activeCategory = null; // category name, or null for "All"
  let filterTimer = 0;

  function applyFilters() {
    const query = input.value;
    let list = query.trim() ? search(query).map((r) => r.m) : App.all;
    if (activeCategory) {
      const cat = CATEGORIES.find((c) => c.name === activeCategory);
      const ids = new Set(cat ? cat.ids : []);
      list = list.filter((m) => ids.has(m.id));
    }
    App.render(list);
    // Keep the "currently on stage" marker on the gallery card.
    if (Stage.current) {
      const c = document.querySelector(`.mudra-card[data-id="${CSS.escape(Stage.current.id)}"]`);
      if (c) c.setAttribute("aria-current", "true");
    }
  }

  function chip(label, count, category) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip";
    b.dataset.category = category || "";
    b.setAttribute("aria-pressed", "false");
    b.append(label + " ");
    const n = document.createElement("span");
    n.className = "chip-count";
    n.textContent = count;
    b.append(n);
    return b;
  }

  function renderChips() {
    chipRow.replaceChildren(chip("All", App.all.length, ""));
    CATEGORIES.forEach((c) => chipRow.append(chip(c.name, c.ids.length, c.name)));
    chipRow.classList.add("is-collapsed");

    // "Show all categories" toggle, placed just after the chip row.
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "chip-toggle";
    toggle.setAttribute("aria-expanded", "false");
    toggle.textContent = `Show all ${CATEGORIES.length} categories`;
    toggle.addEventListener("click", () => {
      const open = chipRow.classList.toggle("is-collapsed") === false;
      toggle.setAttribute("aria-expanded", String(open));
      toggle.textContent = open ? "Show fewer categories" : `Show all ${CATEGORIES.length} categories`;
    });
    chipRow.after(toggle);
    updateChips();
  }

  function updateChips() {
    chipRow.querySelectorAll(".chip").forEach((b) => {
      const on = (b.dataset.category || null) === activeCategory;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-pressed", String(on));
    });
  }

  function setCategory(name) {
    activeCategory = name || null;
    updateChips();
    // If the chosen chip is hidden in the collapsed row, expand it.
    const btn = chipRow.querySelector(`.chip.is-active`);
    if (btn && chipRow.classList.contains("is-collapsed") && btn.offsetTop > chipRow.clientHeight) {
      chipRow.nextElementSibling.click();
    }
    applyFilters();
  }

  /* ---------------------------------------------------------------- events */

  input.addEventListener("input", () => {
    renderDropdown(input.value);
    clearTimeout(filterTimer);
    filterTimer = setTimeout(applyFilters, 160); // debounce the gallery re-render
  });

  input.addEventListener("focus", () => { if (input.value.trim()) renderDropdown(input.value); });

  input.addEventListener("keydown", (e) => {
    const open = !listbox.hidden;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) renderDropdown(input.value);
      setActive(active + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (open) setActive(active - 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const r = results[active >= 0 ? active : 0]; // no highlighted item -> top result
      if (r) choose(r.m.id);
    } else if (e.key === "Escape") {
      if (open) { e.preventDefault(); closeDropdown(); }
    }
  });

  // mousedown (not click) so the input doesn't blur and close the list first.
  listbox.addEventListener("mousedown", (e) => {
    const opt = e.target.closest(".search-result");
    if (!opt) return;
    e.preventDefault();
    choose(opt.dataset.id);
  });
  listbox.addEventListener("mousemove", (e) => {
    const opt = e.target.closest(".search-result");
    if (opt) {
      const i = [...listbox.querySelectorAll(".search-result")].indexOf(opt);
      if (i !== active) setActive(i);
    }
  });

  input.addEventListener("blur", () => setTimeout(closeDropdown, 100));

  chipRow.addEventListener("click", (e) => {
    const b = e.target.closest(".chip");
    if (b) setCategory(b.dataset.category);
  });

  // Category chips on the info card: show every mudra in that category.
  document.getElementById("info-chips").addEventListener("click", (e) => {
    const b = e.target.closest("button.chip[data-category]");
    if (!b) return;
    input.value = "";
    closeDropdown();
    setCategory(b.dataset.category);
    document.querySelector(".collection").scrollIntoView({ behavior: "smooth", block: "start" });
  });

  renderChips();

  // Exposed for debugging / tests: Search.query("fear") -> ranked results.
  window.Search = { query: search, setCategory };
})();
