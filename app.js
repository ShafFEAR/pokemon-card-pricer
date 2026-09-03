(() => {
  "use strict";

  const el = (id) => document.getElementById(id);

  const dropzone = el("dropzone");
  const fileInput = el("fileInput");
  const previewWrap = el("previewWrap");
  const previewImg = el("previewImg");
  const identifyBtn = el("identifyBtn");
  const clearBtn = el("clearBtn");

  const uploadSection = el("uploadSection");
  const candidatesSection = el("candidatesSection");
  const resultsSection = el("resultsSection");

  const aiNotesEl = el("aiNotes");
  const candidatesGrid = el("candidatesGrid");
  const toggleManualSearch = el("toggleManualSearch");
  const manualSearchForm = el("manualSearchForm");
  const manualQuery = el("manualQuery");
  const manualNumber = el("manualNumber");
  const manualSearchBtn = el("manualSearchBtn");

  const backBtn = el("backBtn");
  const resultImg = el("resultImg");
  const resultName = el("resultName");
  const resultSet = el("resultSet");
  const looseBig = el("looseBig");
  const looseTable = el("looseTable");
  const looseSourceNote = el("looseSourceNote");
  const gradedTable = el("gradedTable");
  const gradedSourceNote = el("gradedSourceNote");

  const statusBar = el("statusBar");

  let selectedFile = null; // { base64, mediaType }
  let statusTimer = null;

  // ---- Config sanity check -------------------------------------------------
  if (!window.WORKER_URL || WORKER_URL.includes("YOUR-SUBDOMAIN")) {
    showStatus(
      "Heads up: config.js still has the placeholder WORKER_URL. Deploy the worker and update config.js.",
      true,
      8000
    );
  }

  // ---- Upload / dropzone -----------------------------------------------------

  dropzone.addEventListener("click", () => fileInput.click());
  dropzone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropzone.classList.add("dragover");
  });
  dropzone.addEventListener("dragleave", () => dropzone.classList.remove("dragover"));
  dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropzone.classList.remove("dragover");
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) handleFile(file);
  });
  fileInput.addEventListener("change", () => {
    if (fileInput.files[0]) handleFile(fileInput.files[0]);
  });
  // Paste a screenshot directly (Ctrl/Cmd+V)
  window.addEventListener("paste", (e) => {
    const item = Array.from(e.clipboardData.items || []).find((i) => i.type.startsWith("image/"));
    if (item) handleFile(item.getAsFile());
  });

  clearBtn.addEventListener("click", resetToUpload);

  async function handleFile(file) {
    if (!file.type.startsWith("image/")) {
      showStatus("That doesn't look like an image file.", true);
      return;
    }
    const base64 = await fileToBase64(file);
    selectedFile = { image: base64, mediaType: file.type || "image/png" };
    previewImg.src = `data:${selectedFile.mediaType};base64,${base64}`;
    previewWrap.classList.remove("hidden");
    dropzone.classList.add("hidden");
  }

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result; // data:<type>;base64,<data>
        resolve(result.split(",")[1]);
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  // ---- Identify ---------------------------------------------------------

  identifyBtn.addEventListener("click", async () => {
    if (!selectedFile) return;
    setBusy(identifyBtn, true, "Identifying…");
    showStatus("Asking Claude to read the card…");
    try {
      const res = await apiFetch("/api/identify", {
        method: "POST",
        body: JSON.stringify(selectedFile),
      });
      renderCandidates(res);
      showSection(candidatesSection);
      clearStatus();
    } catch (err) {
      showStatus("Couldn't identify the card: " + err.message, true);
    } finally {
      setBusy(identifyBtn, false, "Identify Card");
    }
  });

  function renderCandidates(data) {
    candidatesGrid.innerHTML = "";
    if (data.aiNotes) {
      aiNotesEl.textContent = data.aiNotes;
      aiNotesEl.classList.remove("hidden");
    } else {
      aiNotesEl.classList.add("hidden");
    }

    const candidates = data.candidates || [];
    if (candidates.length === 0) {
      const p = document.createElement("p");
      p.className = "hint";
      p.textContent = "No exact matches found automatically — try the manual search below.";
      candidatesGrid.appendChild(p);
      manualSearchForm.classList.remove("hidden");
      return;
    }
    candidates.forEach((c) => candidatesGrid.appendChild(buildCandidateCard(c)));
  }

  function buildCandidateCard(c) {
    const div = document.createElement("div");
    div.className = "candidate-card";
    const img = document.createElement("img");
    img.src = (c.images && (c.images.small || c.images.large)) || "";
    img.alt = c.name;
    img.loading = "lazy";
    const name = document.createElement("div");
    name.className = "candidate-name";
    name.textContent = c.name;
    const sub = document.createElement("div");
    sub.className = "candidate-sub";
    sub.textContent = [c.set && c.set.name, c.number].filter(Boolean).join(" · ");
    div.append(img, name, sub);
    div.addEventListener("click", () => selectCard(c));
    return div;
  }

  // ---- Manual search ------------------------------------------------------

  toggleManualSearch.addEventListener("click", () => {
    manualSearchForm.classList.toggle("hidden");
  });

  manualSearchBtn.addEventListener("click", runManualSearch);
  manualQuery.addEventListener("keydown", (e) => {
    if (e.key === "Enter") runManualSearch();
  });

  async function runManualSearch() {
    const q = manualQuery.value.trim();
    if (!q) {
      showStatus("Type a card name to search for.", true);
      return;
    }
    setBusy(manualSearchBtn, true, "Searching…");
    try {
      const params = new URLSearchParams({ q });
      if (manualNumber.value.trim()) params.set("number", manualNumber.value.trim());
      const res = await apiFetch(`/api/search?${params.toString()}`);
      renderCandidates({ candidates: res.candidates });
      clearStatus();
    } catch (err) {
      showStatus("Search failed: " + err.message, true);
    } finally {
      setBusy(manualSearchBtn, false, "Search");
    }
  }

  // ---- Card selection -> price lookup -------------------------------------

  async function selectCard(card) {
    showStatus("Looking up prices…");
    showSection(resultsSection);
    resultImg.src = (card.images && (card.images.large || card.images.small)) || "";
    resultName.textContent = card.name;
    resultSet.textContent = [card.set && card.set.name, card.number].filter(Boolean).join(" · ");
    looseBig.textContent = "…";
    looseTable.innerHTML = "";
    gradedTable.innerHTML = "";
    looseSourceNote.textContent = "";
    gradedSourceNote.textContent = "";

    try {
      const data = await apiFetch(`/api/price?cardId=${encodeURIComponent(card.id)}`);
      renderPriceResults(data);
      clearStatus();
    } catch (err) {
      showStatus("Couldn't load prices: " + err.message, true);
    }
  }

  function renderPriceResults(data) {
    const { loose, graded } = data;

    // Loose / ungraded
    looseBig.textContent = loose.averageMarketUSD != null ? fmtUSD(loose.averageMarketUSD) : "No price found";
    looseTable.innerHTML = "";
    const variantEntries = Object.entries(loose.variants || {});
    if (variantEntries.length) {
      const header = document.createElement("tr");
      header.innerHTML = "<th>Printing</th><th class='num'>Market</th><th class='num'>Low</th><th class='num'>High</th>";
      looseTable.appendChild(header);
      for (const [variant, p] of variantEntries) {
        const row = document.createElement("tr");
        row.innerHTML = `<td>${escapeHtml(prettyVariant(variant))}</td>
          <td class="num">${p.market != null ? fmtUSD(p.market) : "—"}</td>
          <td class="num">${p.low != null ? fmtUSD(p.low) : "—"}</td>
          <td class="num">${p.high != null ? fmtUSD(p.high) : "—"}</td>`;
        looseTable.appendChild(row);
      }
    }
    if (loose.cardmarketEUR && loose.cardmarketEUR.trendPrice != null) {
      const row = document.createElement("tr");
      row.innerHTML = `<td>Cardmarket trend (EUR)</td><td class="num" colspan="3">€${loose.cardmarketEUR.trendPrice.toFixed(2)}</td>`;
      looseTable.appendChild(row);
    }
    looseSourceNote.textContent = loose.source && loose.source.length
      ? `Source: ${loose.source.join(", ")}`
      : "No pricing data available from the Pokémon TCG API for this card.";

    // Graded
    gradedTable.innerHTML = "";
    const grades = ["psa8", "psa9", "psa10"];
    const labels = { psa8: "PSA 8", psa9: "PSA 9", psa10: "PSA 10" };
    const anyGraded = grades.some((g) => graded.prices && graded.prices[g] != null);
    if (anyGraded) {
      for (const g of grades) {
        const val = graded.prices[g];
        const row = document.createElement("tr");
        row.innerHTML = `<td>${labels[g]}</td><td class="num">${val != null ? fmtUSD(val) : "—"}</td>`;
        gradedTable.appendChild(row);
      }
      gradedSourceNote.textContent = `Source: ${graded.source || "pokemonpricetracker.com"}`;
    } else {
      const row = document.createElement("tr");
      row.innerHTML = `<td colspan="2">${escapeHtml(graded.error || "No graded price data found for this card.")}</td>`;
      gradedTable.appendChild(row);
    }
  }

  // ---- Navigation ---------------------------------------------------------

  backBtn.addEventListener("click", resetToUpload);

  function resetToUpload() {
    selectedFile = null;
    fileInput.value = "";
    previewWrap.classList.add("hidden");
    dropzone.classList.remove("hidden");
    manualSearchForm.classList.add("hidden");
    manualQuery.value = "";
    manualNumber.value = "";
    showSection(uploadSection);
    clearStatus();
  }

  function showSection(section) {
    [uploadSection, candidatesSection, resultsSection].forEach((s) => s.classList.add("hidden"));
    section.classList.remove("hidden");
  }

  // ---- Small helpers --------------------------------------------------------

  async function apiFetch(path, options = {}) {
    if (!window.WORKER_URL) throw new Error("WORKER_URL is not set in config.js");
    const res = await fetch(WORKER_URL.replace(/\/$/, "") + path, {
      headers: { "content-type": "application/json" },
      ...options,
    });
    let body;
    try {
      body = await res.json();
    } catch {
      throw new Error(`Bad response (${res.status})`);
    }
    if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
    return body;
  }

  function setBusy(button, busy, label) {
    button.disabled = busy;
    button.textContent = label;
  }

  function showStatus(msg, isError = false, autoHideMs = 4000) {
    statusBar.textContent = msg;
    statusBar.classList.remove("hidden");
    statusBar.classList.toggle("error", isError);
    if (statusTimer) clearTimeout(statusTimer);
    if (autoHideMs) statusTimer = setTimeout(clearStatus, autoHideMs);
  }
  function clearStatus() {
    statusBar.classList.add("hidden");
  }

  function fmtUSD(n) {
    return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
  }

  function prettyVariant(v) {
    return v.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());
  }

  function escapeHtml(s) {
    const d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
  }
})();
