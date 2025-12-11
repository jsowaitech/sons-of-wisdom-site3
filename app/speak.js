// speak.js
// Son of Wisdom — "Speak" button for chat mode
// - Uses Web Speech API (SpeechRecognition / webkitSpeechRecognition)
// - Shows interim text in the status line while you speak
// - On final transcript: fills the chat input and auto-submits the chat form
// - If chat form not found, just shows the text in the status line

(() => {
  const btnSpeak = document.getElementById("btn-speak");
  if (!btnSpeak) {
    console.warn("[SOW] speak.js: #btn-speak not found in DOM.");
    return;
  }

  // Try to find a status line to show "Listening…" etc.
  const statusEl =
    document.getElementById("status-line") ||
    document.querySelector(".status-line");

  // Try to find chat form + input (works with the IDs we’ve used elsewhere)
  const chatForm =
    document.getElementById("chat-form") ||
    document.querySelector("form[data-role='chat-form']");
  const chatInput =
    document.getElementById("chat-input") ||
    document.querySelector("input[data-role='chat-input'], textarea[data-role='chat-input']");

  const ASR =
    window.SpeechRecognition || window.webkitSpeechRecognition || null;

  if (!ASR) {
    console.warn("[SOW] Web Speech API not available in this browser.");
    if (statusEl) {
      statusEl.textContent =
        "Speak is not supported on this browser. Please type instead.";
    }
    // Disable button to avoid “nothing happens” confusion
    btnSpeak.disabled = true;
    return;
  }

  let recognizer = null;
  let isRecording = false;
  let finalText = "";

  function setStatus(msg) {
    if (statusEl) {
      statusEl.textContent = msg || "";
    }
  }

  function setRecordingUI(on) {
    isRecording = on;
    if (on) {
      btnSpeak.classList.add("recording"); // matches your CSS #btn-speak.recording
      btnSpeak.textContent = "Listening…";
      btnSpeak.setAttribute("aria-pressed", "true");
    } else {
      btnSpeak.classList.remove("recording");
      btnSpeak.textContent = "Speak";
      btnSpeak.setAttribute("aria-pressed", "false");
    }
  }

  function ensureRecognizer() {
    if (recognizer) return recognizer;

    const r = new ASR();
    r.lang = "en-US";
    r.continuous = false;
    r.interimResults = true;
    r.maxAlternatives = 1;

    r.onstart = () => {
      finalText = "";
      setStatus("Listening…");
      setRecordingUI(true);
    };

    r.onresult = (event) => {
      let interim = "";
      finalText = "";

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i];
        const txt = (res[0]?.transcript || "").trim();
        if (!txt) continue;

        if (res.isFinal) {
          finalText += (finalText ? " " : "") + txt;
        } else {
          interim += (interim ? " " : "") + txt;
        }
      }

      // Show interim in status line as live caption
      if (interim) {
        setStatus(`Listening: ${interim}`);
      }

      // If we got any final text, update status with the last final
      if (finalText) {
        setStatus(finalText);
      }
    };

    r.onerror = (event) => {
      console.warn("[SOW] SpeechRecognition error:", event);
      setRecordingUI(false);

      if (event.error === "no-speech") {
        setStatus("I didn’t catch that. Tap Speak and try again.");
      } else if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        setStatus("Mic permissions are blocked. Check your browser settings.");
        // Permanently disable to avoid confusing loops
        btnSpeak.disabled = true;
      } else {
        setStatus("Something went wrong with speech recognition.");
      }
    };

    r.onend = () => {
      // Called after stop() or when the user stops talking
      setRecordingUI(false);

      if (!finalText) {
        // No speech or nothing final recognized
        if (!statusEl?.textContent) {
          setStatus("I didn’t catch that. Tap Speak and try again.");
        }
        return;
      }

      // We have a final transcript — inject into chat input and submit
      if (chatInput && chatForm) {
        chatInput.value = finalText;
        setStatus(""); // let main chat show its own status
        try {
          // Trigger submit (as if user pressed Send)
          const evt = new Event("submit", { bubbles: true, cancelable: true });
          if (!chatForm.dispatchEvent(evt)) {
            // If something prevented default, try direct submit
            chatForm.requestSubmit?.();
          }
        } catch (e) {
          console.warn("[SOW] speak.js: error dispatching chat submit:", e);
        }
      } else {
        // No chat form found — just show the text so user can copy/paste
        setStatus(finalText);
      }

      finalText = "";
    };

    recognizer = r;
    return r;
  }

  function startRecording() {
    try {
      const r = ensureRecognizer();
      r.start(); // Must be called in direct response to a user gesture
    } catch (e) {
      console.warn("[SOW] SpeechRecognition start() failed:", e);
      setStatus("Could not start mic. Check permissions and try again.");
      setRecordingUI(false);
    }
  }

  function stopRecording() {
    if (!recognizer) return;
    try {
      recognizer.stop();
    } catch (e) {
      console.warn("[SOW] SpeechRecognition stop() failed:", e);
    }
  }

  btnSpeak.addEventListener("click", (event) => {
    event.preventDefault();

    if (isRecording) {
      // Toggle off
      stopRecording();
      return;
    }

    // Toggle on
    setStatus("Listening…");
    startRecording();
  });

  console.log("[SOW] speak.js ready – Speak button wired.");
})();
