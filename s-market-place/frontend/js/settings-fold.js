"use strict";
/* ============================================================================
   settings-fold.js — every section on the Settings screen gets an
   "Enlarge" / "Fold back" toggle. Sections start folded so the screen is tidy.
   Nothing is renamed: this only adds a button to each section's heading and
   toggles the class "is-folded". Works whenever renderSettings() redraws.
   ============================================================================ */
(function () {
  const root = document.getElementById("settings-content");
  if (!root) return;

  function setFolded(section, button, folded) {
    section.classList.toggle("is-folded", folded);
    button.setAttribute("aria-expanded", String(!folded));
    button.querySelector("[data-fold-label]").textContent = folded ? "Enlarge" : "Fold back";
    button.querySelector("[data-fold-arrow]").textContent = folded ? "▾" : "▴";
  }

  function enhance() {
    root.querySelectorAll(":scope > section, :scope > form").forEach(section => {
      if (section.dataset.foldReady) return;
      const heading = section.querySelector("h2, h3");
      if (!heading) return;
      let head = heading;                       // the direct child of the section that holds the heading
      while (head.parentElement && head.parentElement !== section) head = head.parentElement;
      section.dataset.foldReady = "1";
      head.classList.add("fold-head");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "fold-toggle";
      button.innerHTML = '<span data-fold-label></span> <span data-fold-arrow aria-hidden="true"></span>';
      head.appendChild(button);
      setFolded(section, button, true);
      button.addEventListener("click", () => setFolded(section, button, !section.classList.contains("is-folded")));
    });
  }

  new MutationObserver(enhance).observe(root, { childList: true });
  enhance();
})();
