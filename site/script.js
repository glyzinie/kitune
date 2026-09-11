const status = document.getElementById("copy-status");

for (const button of document.querySelectorAll("[data-copy]")) {
  const source = document.getElementById(button.dataset.copy);
  if (!source || !navigator.clipboard?.writeText) continue;

  button.hidden = false;
  const originalLabel = button.textContent;
  let resetTimer;
  let copying = false;
  button.addEventListener("click", async () => {
    if (copying) return;
    copying = true;
    clearTimeout(resetTimer);
    button.setAttribute("aria-disabled", "true");
    button.setAttribute("aria-busy", "true");
    if (status) status.textContent = "";

    try {
      await navigator.clipboard.writeText(source.textContent.trim());
      button.textContent = "コピー済み ✓";
      if (status) status.textContent = "コマンドをコピーしました。";
    } catch {
      button.textContent = "コピー失敗";
      source.closest("pre")?.focus();
      const selection = window.getSelection();
      if (selection) {
        const range = document.createRange();
        range.selectNodeContents(source);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      if (status) status.textContent = selection
        ? "自動コピーできませんでした。選択したコードを手動でコピーしてください。"
        : "コピーできませんでした。コードを選択してコピーしてください。";
    } finally {
      copying = false;
      button.removeAttribute("aria-disabled");
      button.removeAttribute("aria-busy");
      resetTimer = setTimeout(() => { button.textContent = originalLabel; }, 3000);
    }
  });
}
