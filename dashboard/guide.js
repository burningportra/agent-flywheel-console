// Copy to clipboard helper
function copyText(text, btn) {
  const original = btn.textContent;
  navigator.clipboard.writeText(text).then(() => {
    btn.textContent = "Copied!";
    btn.classList.add("copied");
    setTimeout(() => {
      btn.textContent = original;
      btn.classList.remove("copied");
    }, 2000);
  }).catch(() => {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); btn.textContent = "Copied!"; btn.classList.add("copied"); setTimeout(() => { btn.textContent = original; btn.classList.remove("copied"); }, 2000); } catch {}
    document.body.removeChild(ta);
  });
}

// Wire up all copy buttons
document.querySelectorAll("[data-copy]").forEach(btn => {
  btn.addEventListener("click", () => copyText(btn.dataset.copy, btn));
});

// Wire up prompt card toggles
document.querySelectorAll(".guide-prompt-card-header").forEach(header => {
  header.addEventListener("click", () => {
    const card = header.closest(".guide-prompt-card");
    card.classList.toggle("open");
  });
});

// Smooth scroll to phase when clicking phase chips
document.querySelectorAll(".guide-phase-chip[href^='#']").forEach(link => {
  link.addEventListener("click", e => {
    e.preventDefault();
    const target = document.querySelector(link.getAttribute("href"));
    if (target) {
      target.scrollIntoView({ behavior: "smooth", block: "start" });
      // Open the details if closed
      const details = target.querySelector("details");
      if (details && !details.open) details.open = true;
    }
  });
});
