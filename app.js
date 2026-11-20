(function () {
  const {
    PREPLANNED_QUESTIONS,
    CAREER_ROLES,
    getOpeningScriptLines,
    getOpeningScript,
    getTransitionPhrase,
    getQuestionSpokenText,
    getClosingSpokenText,
  } = window.VCOT_INTERVIEW_DATA;

  const STEP_ORDER = ["home", "register", "intro", "interview", "report"];
  const STORAGE_KEY_NAME = "vcot_gemini_api_key";

  const state = {
    currentView: "home",
    sessionToken: 0,
    backendAvailable: true,
    browserApiKey: localStorage.getItem(STORAGE_KEY_NAME) || "",
    candidate: {
      name: "",
      jobRole: "",
      language: "English",
      difficulty: "Beginner",
    },
    answers: [],
    voiceMuted: false,
    isSpeaking: false,
    currentAudio: null,
    micStream: null,
    audioContext: null,
    activeCleanupListening: null,
  };

  // Client-side cache of Gemini TTS WAV blob URLs and in-flight promises
  const clientTtsCache = new Map();
  const clientTtsInFlight = new Map();

  // DOM Elements
  const views = {
    home: document.getElementById("view-home"),
    register: document.getElementById("view-register"),
    intro: document.getElementById("view-intro"),
    interview: document.getElementById("view-interview"),
    report: document.getElementById("view-report"),
  };

  const headerBrandBtn = document.getElementById("headerBrandBtn");
  const navStepEls = Array.from(document.querySelectorAll("#headerStepper .nav-step"));
  const connectKeyBtn = document.getElementById("connectKeyBtn");
  const connectKeyLabel = document.getElementById("connectKeyLabel");
  const globalMuteBtn = document.getElementById("globalMuteBtn");
  const globalMuteIcon = document.getElementById("globalMuteIcon");
  const globalMuteLabel = document.getElementById("globalMuteLabel");

  // Gemini Key Modal (for static hosting like GitHub Pages)
  const geminiKeyModal = document.getElementById("geminiKeyModal");
  const closeKeyModalBtn = document.getElementById("closeKeyModalBtn");
  const browserGeminiKeyInput = document.getElementById("browserGeminiKeyInput");
  const clearBrowserKeyBtn = document.getElementById("clearBrowserKeyBtn");
  const saveBrowserKeyBtn = document.getElementById("saveBrowserKeyBtn");

  // Home
  const startPracticeBtn = document.getElementById("startPracticeBtn");

  // Registration
  const registrationForm = document.getElementById("registrationForm");
  const candidateNameInput = document.getElementById("candidateName");
  const candidateJobRoleInput = document.getElementById("candidateJobRole");
  const interviewLanguageSelect = document.getElementById("interviewLanguage");
  const interviewDifficultySelect = document.getElementById("interviewDifficulty");
  const roleChipsContainer = document.getElementById("roleChipsContainer");
  const regErrorMsg = document.getElementById("regErrorMsg");
  const backToHomeBtn = document.getElementById("backToHomeBtn");

  // Intro
  const introCandidateBadge = document.getElementById("introCandidateBadge");
  const introAiOrb = document.getElementById("introAiOrb");
  const introSpeakingStatus = document.getElementById("introSpeakingStatus");
  const introAudioUnlockBox = document.getElementById("introAudioUnlockBox");
  const introPlayAudioBtn = document.getElementById("introPlayAudioBtn");
  const openingScriptLinesEl = document.getElementById("openingScriptLines");
  const replayIntroBtn = document.getElementById("replayIntroBtn");
  const backToRegisterBtn = document.getElementById("backToRegisterBtn");
  const beginQuestionsBtn = document.getElementById("beginQuestionsBtn");

  // Live Interview Studio
  const interviewCandidatePill = document.getElementById("interviewCandidatePill");
  const liveTurnBadge = document.getElementById("liveTurnBadge");
  const interviewAiOrb = document.getElementById("interviewAiOrb");
  const interviewSpeakingStatus = document.getElementById("interviewSpeakingStatus");
  const questionCounterBadge = document.getElementById("questionCounterBadge");
  const questionTopicBadge = document.getElementById("questionTopicBadge");
  const progressPctLabel = document.getElementById("progressPctLabel");
  const progressSegments = document.getElementById("progressSegments");
  const transitionPhraseText = document.getElementById("transitionPhraseText");
  const currentQuestionText = document.getElementById("currentQuestionText");
  const studioAudioUnlockBox = document.getElementById("studioAudioUnlockBox");
  const studioPlayAudioBtn = document.getElementById("studioPlayAudioBtn");

  const micLiveIndicator = document.getElementById("micLiveIndicator");
  const micStageTitle = document.getElementById("micStageTitle");
  const studentVoiceMeter = document.getElementById("studentVoiceMeter");
  const meterBars = Array.from(studentVoiceMeter.querySelectorAll("span"));
  const liveTranscriptText = document.getElementById("liveTranscriptText");
  const liveInterimText = document.getElementById("liveInterimText");
  const wordCountBadge = document.getElementById("wordCountBadge");
  const silenceCountdownWrapper = document.getElementById("silenceCountdownWrapper");
  const silenceCountdownLabel = document.getElementById("silenceCountdownLabel");
  const silenceProgressFill = document.getElementById("silenceProgressFill");
  const micPermissionAlert = document.getElementById("micPermissionAlert");

  // Report
  const evaluatingStateCard = document.getElementById("evaluatingStateCard");
  const reportContentContainer = document.getElementById("reportContentContainer");
  const evaluationEngineBadge = document.getElementById("evaluationEngineBadge");
  const reportCandidateName = document.getElementById("reportCandidateName");
  const reportJobRole = document.getElementById("reportJobRole");
  const overallScoreValue = document.getElementById("overallScoreValue");
  const overallScoreCaption = document.getElementById("overallScoreCaption");
  const scoreRingCircle = document.getElementById("scoreRingCircle");
  const categoryBreakdownGrid = document.getElementById("categoryBreakdownGrid");
  const confidenceDisclaimerBox = document.getElementById("confidenceDisclaimerBox");
  const strengthsList = document.getElementById("strengthsList");
  const areasToImproveList = document.getElementById("areasToImproveList");
  const bestAnswerMeta = document.getElementById("bestAnswerMeta");
  const bestAnswerQuote = document.getElementById("bestAnswerQuote");
  const bestAnswerReason = document.getElementById("bestAnswerReason");
  const improveAnswerMeta = document.getElementById("improveAnswerMeta");
  const improveOriginalText = document.getElementById("improveOriginalText");
  const improveBetterText = document.getElementById("improveBetterText");
  const improveReasonText = document.getElementById("improveReasonText");
  const toggleAllRubricsBtn = document.getElementById("toggleAllRubricsBtn");
  const questionRubricList = document.getElementById("questionRubricList");
  const nextStepsList = document.getElementById("nextStepsList");
  const printReportBtn = document.getElementById("printReportBtn");
  const tryAnotherBtn = document.getElementById("tryAnotherBtn");

  // =========================================================================
  // Initialization & Navigation
  // =========================================================================
  let backendCheckPromise = null;

  function init() {
    renderCareerRoleChips();
    bindEvents();
    updateMuteUI();
    syncNavStepper("home");
    backendCheckPromise = detectBackendAvailability();
  }

  async function detectBackendAvailability() {
    try {
      const res = await fetch("./api/health", { cache: "no-store" });
      const contentType = res.headers.get("content-type") || "";
      if (res.ok && contentType.includes("application/json")) {
        const data = await res.json();
        if (data && data.ok) {
          state.backendAvailable = true;
          connectKeyBtn.classList.add("hidden");
          return;
        }
      }
    } catch (e) {
      // No Node backend reachable (e.g., static GitHub Pages)
    }
    state.backendAvailable = false;
    updateConnectKeyUI();
  }

  function updateConnectKeyUI() {
    if (state.backendAvailable) {
      connectKeyBtn.classList.add("hidden");
      return;
    }
    connectKeyBtn.classList.remove("hidden");
    connectKeyLabel.textContent = state.browserApiKey ? "Gemini Connected" : "Connect Gemini Key";
  }

  function renderCareerRoleChips() {
    roleChipsContainer.innerHTML = "";
    CAREER_ROLES.forEach((role) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "role-chip";
      chip.textContent = role;
      chip.addEventListener("click", () => {
        candidateJobRoleInput.value = role;
        syncSelectedRoleChip();
      });
      roleChipsContainer.appendChild(chip);
    });
  }

  function syncSelectedRoleChip() {
    const val = candidateJobRoleInput.value.trim().toLowerCase();
    const chips = roleChipsContainer.querySelectorAll(".role-chip");
    chips.forEach((chip) => {
      chip.classList.toggle("selected", chip.textContent.toLowerCase() === val);
    });
  }

  function syncNavStepper(viewKey) {
    const currentIdx = STEP_ORDER.indexOf(viewKey);
    navStepEls.forEach((el) => {
      const stepIdx = STEP_ORDER.indexOf(el.dataset.step);
      el.classList.toggle("active", el.dataset.step === viewKey);
      el.classList.toggle("done", stepIdx !== -1 && stepIdx < currentIdx);
    });
  }

  function stopAllActiveMedia() {
    state.sessionToken += 1;
    stopSpeaking();
    if (typeof state.activeCleanupListening === "function") {
      state.activeCleanupListening();
      state.activeCleanupListening = null;
    }
    releaseMicrophone();
  }

  function showView(viewKey) {
    stopAllActiveMedia();

    Object.entries(views).forEach(([key, el]) => {
      el.classList.toggle("active", key === viewKey);
    });
    state.currentView = viewKey;
    syncNavStepper(viewKey);

    const showMuteButton = viewKey === "intro" || viewKey === "interview";
    globalMuteBtn.classList.toggle("hidden", !showMuteButton);
    introAudioUnlockBox.classList.add("hidden");
    studioAudioUnlockBox.classList.add("hidden");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  // =========================================================================
  // Gemini Natural Voice TTS Engine (Zero Robotic Fallback)
  // =========================================================================
  function waitMs(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function updateOrbState(mode, statusText) {
    const apply = (orbEl) => {
      if (!orbEl) return;
      orbEl.classList.remove("orb-speaking", "orb-listening");
      if (mode === "speaking") orbEl.classList.add("orb-speaking");
      if (mode === "listening") orbEl.classList.add("orb-listening");
    };

    if (state.currentView === "intro") {
      apply(introAiOrb);
      if (statusText) introSpeakingStatus.textContent = statusText;
    } else if (state.currentView === "interview") {
      apply(interviewAiOrb);
      if (statusText) interviewSpeakingStatus.textContent = statusText;
    }
  }

  function base64ToWavBlob(b64, mimeType) {
    const binStr = atob(b64);
    const bytes = new Uint8Array(binStr.length);
    for (let i = 0; i < binStr.length; i += 1) {
      bytes[i] = binStr.charCodeAt(i);
    }
    const isRiff =
      bytes.length >= 12 &&
      bytes[0] === 82 &&
      bytes[1] === 73 &&
      bytes[2] === 70 &&
      bytes[3] === 70;
    if (isRiff) {
      return new Blob([bytes], { type: "audio/wav" });
    }
    const rateMatch = String(mimeType || "").match(/rate=(\d+)/i);
    const sampleRate = rateMatch ? Number(rateMatch[1]) : 24000;
    const wavHeader = new ArrayBuffer(44);
    const view = new DataView(wavHeader);
    const writeStr = (off, str) => {
      for (let i = 0; i < str.length; i += 1) view.setUint8(off + i, str.charCodeAt(i));
    };
    writeStr(0, "RIFF");
    view.setUint32(4, 36 + bytes.length, true);
    writeStr(8, "WAVE");
    writeStr(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, "data");
    view.setUint32(40, bytes.length, true);
    return new Blob([wavHeader, bytes], { type: "audio/wav" });
  }

  async function fetchDirectGeminiTtsBlob(cleanText, apiKey) {
    for (const model of ["gemini-3.8-flash-tts", "gemini-3.8-flash-lite-tts"]) {
      try {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(
            apiKey
          )}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ parts: [{ text: cleanText }] }],
              generationConfig: {
                responseModalities: ["AUDIO"],
                speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } } },
              },
            }),
          }
        );
        if (!res.ok) continue;
        const data = await res.json();
        const part = (data?.candidates?.[0]?.content?.parts || []).find((p) => p?.inlineData?.data);
        if (part?.inlineData?.data) {
          return base64ToWavBlob(part.inlineData.data, part.inlineData.mimeType);
        }
      } catch (e) {
        // Try next TTS model
      }
    }
    return null;
  }

  function prefetchTtsAudio(text) {
    const clean = (text || "").trim();
    if (!clean) return Promise.resolve(null);
    if (clientTtsCache.has(clean)) {
      return Promise.resolve(clientTtsCache.get(clean));
    }
    if (clientTtsInFlight.has(clean)) {
      return clientTtsInFlight.get(clean);
    }

    const promise = (async () => {
      if (backendCheckPromise) await backendCheckPromise;
      if (!state.backendAvailable) {
        if (!state.browserApiKey) return null;
        const blob = await fetchDirectGeminiTtsBlob(clean, state.browserApiKey);
        if (!blob) return null;
        const blobUrl = URL.createObjectURL(blob);
        clientTtsCache.set(clean, blobUrl);
        return blobUrl;
      }

      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (attempt > 0) await waitMs(350 * attempt);
        try {
          const res = await fetch("./api/tts", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: clean, voice: "Aoede" }),
          });
          if (!res.ok) continue;
          const blob = await res.blob();
          if (!blob || blob.size < 100) continue;
          const blobUrl = URL.createObjectURL(blob);
          clientTtsCache.set(clean, blobUrl);
          return blobUrl;
        } catch (err) {
          // Retry transient fetch error
        }
      }
      return null;
    })().finally(() => {
      clientTtsInFlight.delete(clean);
    });

    clientTtsInFlight.set(clean, promise);
    return promise;
  }

  function stopSpeaking() {
    state.isSpeaking = false;
    if (state.currentAudio) {
      try {
        state.currentAudio.pause();
        state.currentAudio.onended = null;
        state.currentAudio.onerror = null;
        state.currentAudio.src = "";
      } catch (e) {
        // Ignore cleanup errors
      }
      state.currentAudio = null;
    }
    updateOrbState("idle");
  }

  async function speakWithGemini(text, statusLabel, sessionToken) {
    stopSpeaking();

    if (state.voiceMuted) {
      updateOrbState("idle", "Gemini voice muted — read question on screen");
      await waitMs(1200);
      return;
    }

    state.isSpeaking = true;
    updateOrbState("speaking", "Loading Gemini natural voice...");
    const blobUrl = await prefetchTtsAudio(text);

    if (state.sessionToken !== sessionToken) {
      state.isSpeaking = false;
      updateOrbState("idle");
      return;
    }

    if (!blobUrl) {
      state.isSpeaking = false;
      updateOrbState(
        "idle",
        !state.backendAvailable && !state.browserApiKey
          ? "Tap 'Connect Gemini Key' in header for voice — read question"
          : "Voice unavailable right now — read question above"
      );
      await waitMs(2200);
      return;
    }

    const unlockBox = state.currentView === "intro" ? introAudioUnlockBox : studioAudioUnlockBox;
    const unlockBtn = state.currentView === "intro" ? introPlayAudioBtn : studioPlayAudioBtn;

    await new Promise((resolve) => {
      const audio = new Audio(blobUrl);
      audio.playbackRate = 1.0;
      state.currentAudio = audio;

      const finish = () => {
        unlockBox.classList.add("hidden");
        state.currentAudio = null;
        state.isSpeaking = false;
        updateOrbState("idle", "Ready");
        resolve();
      };

      audio.onplay = () => {
        if (state.sessionToken === sessionToken) {
          unlockBox.classList.add("hidden");
          updateOrbState("speaking", statusLabel || "Gemini AI Interviewer is speaking...");
        }
      };

      audio.onended = finish;
      audio.onerror = finish;

      audio.play().catch(() => {
        if (state.sessionToken !== sessionToken) {
          finish();
          return;
        }
        // Wait for user's one-tap unlock to play the natural Gemini audio (never robotic speechSynthesis)
        updateOrbState("idle", "Tap 'Play / Resume AI Voice' above to listen");
        unlockBox.classList.remove("hidden");
        unlockBtn.onclick = () => {
          unlockBox.classList.add("hidden");
          audio.play().catch(finish);
        };
      });
    });
  }

  function updateMuteUI() {
    globalMuteIcon.textContent = state.voiceMuted ? "🔇" : "🔊";
    globalMuteLabel.textContent = state.voiceMuted ? "Voice Muted" : "Gemini Voice On";
  }

  // =========================================================================
  // Microphone Stream & Hands-Free Real-Time Turn Detection
  // =========================================================================
  async function ensureMicrophoneAccess() {
    micPermissionAlert.classList.add("hidden");

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error("Your browser does not support microphone recording.");
    }

    if (!state.micStream || state.micStream.getAudioTracks().every((t) => t.readyState === "ended")) {
      state.micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    }

    if (!state.audioContext || state.audioContext.state === "closed") {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      state.audioContext = new AudioCtx();
    }
    if (state.audioContext.state === "suspended") {
      await state.audioContext.resume();
    }

    return state.micStream;
  }

  function releaseMicrophone() {
    if (state.micStream) {
      state.micStream.getTracks().forEach((track) => track.stop());
      state.micStream = null;
    }
    if (state.audioContext && state.audioContext.state !== "closed") {
      state.audioContext.close().catch(() => {});
      state.audioContext = null;
    }
    resetVoiceMeter();
  }

  function resetVoiceMeter() {
    studentVoiceMeter.classList.remove("active");
    meterBars.forEach((bar) => {
      bar.style.height = "7px";
    });
  }

  function updateVoiceMeterBars(rms) {
    studentVoiceMeter.classList.add("active");
    const level = Math.min(1, rms * 16);
    const center = (meterBars.length - 1) / 2;
    meterBars.forEach((bar, idx) => {
      const distFactor = 1 - Math.abs(idx - center) / (center + 2);
      const wave = 0.55 + 0.45 * Math.sin(Date.now() / 85 + idx * 0.7);
      const px = Math.round(6 + level * 26 * distFactor * wave);
      bar.style.height = `${Math.max(6, Math.min(30, px))}px`;
    });
  }

  function setTurnUI(mode, badgeText, micLabel) {
    liveTurnBadge.className = `turn-badge ${mode}`;
    liveTurnBadge.textContent = badgeText;
    micStageTitle.textContent = micLabel;
    micLiveIndicator.classList.toggle("listening", mode === "turn-student");
    if (mode === "turn-student") {
      updateOrbState("listening", "Listening attentively to your answer...");
    }
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const result = String(reader.result || "");
        const commaIdx = result.indexOf(",");
        resolve(commaIdx !== -1 ? result.slice(commaIdx + 1) : result);
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  async function transcribeViaGemini(audioChunks, mimeType) {
    if (!audioChunks || audioChunks.length === 0) return "";
    const blob = new Blob(audioChunks, { type: mimeType || "audio/webm" });
    if (blob.size < 1000) return "";
    const audioBase64 = await blobToBase64(blob);

    if (!state.backendAvailable) {
      if (!state.browserApiKey) return "";
      try {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${encodeURIComponent(
            state.browserApiKey
          )}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              systemInstruction: {
                parts: [{ text: "Verbatim English speech transcriber. Return plain words only; empty if silent." }],
              },
              contents: [
                {
                  role: "user",
                  parts: [
                    { inlineData: { mimeType: blob.type || "audio/webm", data: audioBase64 } },
                    { text: "Transcribe:" },
                  ],
                },
              ],
              generationConfig: { temperature: 0.1, thinkingConfig: { thinkingBudget: 0 }, maxOutputTokens: 250 },
            }),
          }
        );
        if (!res.ok) return "";
        const data = await res.json();
        const textPart = (data?.candidates?.[0]?.content?.parts || []).find((p) => typeof p.text === "string");
        return (textPart?.text || "").trim();
      } catch (e) {
        return "";
      }
    }

    const res = await fetch("./api/transcribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ audioBase64, mimeType: blob.type || "audio/webm" }),
    });
    if (!res.ok) return "";
    const data = await res.json();
    return (data.transcript || "").trim();
  }

  function listenForStudentAnswer(questionIndex, sessionToken) {
    return new Promise(async (resolve) => {
      let stream;
      try {
        stream = await ensureMicrophoneAccess();
      } catch (err) {
        micPermissionAlert.textContent =
          "Microphone access is needed for the real-time interview. Please allow microphone access and reload.";
        micPermissionAlert.classList.remove("hidden");
        resolve("");
        return;
      }

      if (state.sessionToken !== sessionToken) {
        resolve("");
        return;
      }

      setTurnUI(
        "turn-student",
        "🎙️ Your Turn — Listening... Speak naturally",
        "Listening live — speak your answer freely"
      );
      liveTranscriptText.textContent = "Listening... start speaking whenever you're ready.";
      liveInterimText.textContent = "";
      liveInterimText.classList.add("hidden");
      wordCountBadge.textContent = "0 words";
      silenceCountdownWrapper.classList.add("hidden");
      silenceProgressFill.style.width = "0%";

      const source = state.audioContext.createMediaStreamSource(stream);
      const analyser = state.audioContext.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      const dataArray = new Float32Array(analyser.fftSize);

      let mediaRecorder = null;
      const recordedChunks = [];
      let recorderMimeType = "audio/webm";
      if (typeof MediaRecorder !== "undefined") {
        try {
          const preferred = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
            ? "audio/webm;codecs=opus"
            : "audio/webm";
          recorderMimeType = preferred;
          mediaRecorder = new MediaRecorder(stream, {
            mimeType: preferred,
            audioBitsPerSecond: 24000,
          });
          mediaRecorder.ondataavailable = (e) => {
            if (e.data && e.data.size > 0) recordedChunks.push(e.data);
          };
          mediaRecorder.start(250);
        } catch (e) {
          mediaRecorder = null;
        }
      }

      const SpeechRecCtor = window.SpeechRecognition || window.webkitSpeechRecognition || null;
      let recognition = null;
      let accumulatedFinal = "";
      let latestInterim = "";
      let active = true;

      let hasSpoken = false;
      let voicedMs = 0;
      const ambientSamples = [];
      let noiseFloor = 0.012;
      let lastVoiceTime = performance.now();
      const startTime = performance.now();
      const SILENCE_SHOW_MS = 700;
      const SILENCE_DONE_MS = 2700;

      function getFullRecognizedText() {
        return [accumulatedFinal.trim(), latestInterim.trim()].filter(Boolean).join(" ").trim();
      }

      function refreshCaptions() {
        const finalClean = accumulatedFinal.trim();
        const interimClean = latestInterim.trim();
        liveTranscriptText.textContent =
          finalClean || (interimClean ? "" : "Listening... start speaking whenever you're ready.");
        if (interimClean) {
          liveInterimText.textContent = interimClean;
          liveInterimText.classList.remove("hidden");
        } else {
          liveInterimText.classList.add("hidden");
        }
        const words = getFullRecognizedText().split(/\s+/).filter(Boolean);
        wordCountBadge.textContent = `${words.length} ${words.length === 1 ? "word" : "words"}`;
      }

      function startRecognitionInstance() {
        if (!SpeechRecCtor || !active) return;
        const rec = new SpeechRecCtor();
        rec.lang = "en-US";
        rec.continuous = true;
        rec.interimResults = true;

        let instanceFinal = "";

        rec.onresult = (event) => {
          if (!active) return;
          let interim = "";
          let finished = "";
          for (let i = 0; i < event.results.length; i += 1) {
            const txt = event.results[i][0].transcript;
            if (event.results[i].isFinal) {
              finished += txt + " ";
            } else {
              interim += txt;
            }
          }

          if (finished.trim() && finished.trim() !== instanceFinal) {
            const added = finished.trim().slice(instanceFinal.length).trim();
            if (added) {
              accumulatedFinal = [accumulatedFinal.trim(), added].filter(Boolean).join(" ");
            }
            instanceFinal = finished.trim();
          }

          latestInterim = interim;
          const totalWords = getFullRecognizedText().split(/\s+/).filter(Boolean).length;
          if (totalWords >= 1) {
            hasSpoken = true;
            lastVoiceTime = performance.now();
            silenceCountdownWrapper.classList.add("hidden");
          }
          refreshCaptions();
        };

        rec.onerror = () => {
          // VAD & MediaRecorder backup stay active
        };

        rec.onend = () => {
          if (latestInterim.trim()) {
            accumulatedFinal = [accumulatedFinal.trim(), latestInterim.trim()].filter(Boolean).join(" ");
            latestInterim = "";
          }
          if (active && state.sessionToken === sessionToken) {
            setTimeout(() => {
              if (active && state.sessionToken === sessionToken) {
                startRecognitionInstance();
              }
            }, 120);
          }
        };

        recognition = rec;
        try {
          rec.start();
        } catch (e) {
          // Ignore duplicate start race
        }
      }

      startRecognitionInstance();

      const stopTurnResources = () => {
        active = false;
        clearInterval(vadIntervalId);
        if (recognition) {
          const rec = recognition;
          recognition = null;
          try {
            rec.onend = null;
            rec.stop();
          } catch (e) {
            // Ignore
          }
        }
        try {
          source.disconnect();
        } catch (e) {
          // Ignore
        }
        resetVoiceMeter();
      };

      state.activeCleanupListening = () => {
        stopTurnResources();
        if (mediaRecorder && mediaRecorder.state !== "inactive") {
          try {
            mediaRecorder.stop();
          } catch (e) {
            // Ignore
          }
        }
        resolve("");
      };

      async function completeTurn() {
        stopTurnResources();
        state.activeCleanupListening = null;

        setTurnUI(
          "turn-transition",
          "✨ Answer Captured — Preparing next question...",
          "Processing your spoken answer..."
        );
        updateOrbState("idle", "Nice! Preparing the next turn...");
        silenceCountdownLabel.textContent = "✓ Moving forward...";
        silenceProgressFill.style.width = "100%";

        let finalAnswer = getFullRecognizedText();

        if (mediaRecorder && mediaRecorder.state !== "inactive") {
          await new Promise((done) => {
            mediaRecorder.onstop = done;
            try {
              mediaRecorder.stop();
            } catch (e) {
              done();
            }
          });
        }

        if (!finalAnswer && recordedChunks.length > 0) {
          liveTranscriptText.textContent = "Transcribing your voice with Gemini AI...";
          try {
            finalAnswer = await transcribeViaGemini(recordedChunks, recorderMimeType);
          } catch (e) {
            finalAnswer = "";
          }
        }

        if (!finalAnswer) {
          finalAnswer = "[Spoken response captured]";
        }

        liveTranscriptText.textContent = finalAnswer;
        liveInterimText.classList.add("hidden");
        const words = finalAnswer.split(/\s+/).filter(Boolean);
        wordCountBadge.textContent = `${words.length} ${words.length === 1 ? "word" : "words"}`;

        await waitMs(400);
        silenceCountdownWrapper.classList.add("hidden");
        resolve(finalAnswer);
      }

      const vadIntervalId = setInterval(() => {
        if (!active || state.sessionToken !== sessionToken) {
          clearInterval(vadIntervalId);
          return;
        }

        analyser.getFloatTimeDomainData(dataArray);
        let sumSq = 0;
        for (let i = 0; i < dataArray.length; i += 1) {
          sumSq += dataArray[i] * dataArray[i];
        }
        const rms = Math.sqrt(sumSq / dataArray.length);
        updateVoiceMeterBars(rms);

        const now = performance.now();
        const elapsed = now - startTime;

        if (elapsed < 350) {
          ambientSamples.push(rms);
          const avgNoise = ambientSamples.reduce((a, b) => a + b, 0) / ambientSamples.length;
          noiseFloor = Math.max(0.01, Math.min(0.04, avgNoise));
          return;
        }

        const speechThreshold = Math.max(0.02, noiseFloor * 2.2);
        if (rms > speechThreshold) {
          voicedMs += 100;
          lastVoiceTime = now;
          if (voicedMs >= 700) {
            hasSpoken = true;
          }
          silenceCountdownWrapper.classList.add("hidden");
          return;
        }

        if (!hasSpoken) {
          return;
        }

        const silenceMs = now - lastVoiceTime;
        if (silenceMs >= SILENCE_SHOW_MS) {
          silenceCountdownWrapper.classList.remove("hidden");
          const isFinalQuestion = questionIndex === PREPLANNED_QUESTIONS.length - 1;
          silenceCountdownLabel.textContent = isFinalQuestion
            ? "✨ Answer captured — finishing your interview..."
            : `✨ Answer captured — moving to Question ${questionIndex + 2}...`;
          const pct = Math.min(
            100,
            Math.round(((silenceMs - SILENCE_SHOW_MS) / (SILENCE_DONE_MS - SILENCE_SHOW_MS)) * 100)
          );
          silenceProgressFill.style.width = `${pct}%`;
        }

        if (silenceMs >= SILENCE_DONE_MS) {
          completeTurn();
        }
      }, 100);
    });
  }

  // =========================================================================
  // Real-Time Interview Orchestration
  // =========================================================================
  function startIntroductionStage() {
    const { name, jobRole, difficulty } = state.candidate;
    introCandidateBadge.textContent = `${name} • ${jobRole} (${difficulty})`;

    const lines = getOpeningScriptLines(name);
    openingScriptLinesEl.innerHTML = "";
    lines.forEach((line) => {
      const p = document.createElement("p");
      p.textContent = line;
      openingScriptLinesEl.appendChild(p);
    });

    showView("intro");
    const token = state.sessionToken;

    // Token optimization: prefetch only Question 1 ahead while welcome plays (skip if muted)
    if (!state.voiceMuted) {
      prefetchTtsAudio(getQuestionSpokenText(0, name, jobRole, PREPLANNED_QUESTIONS[0]));
    }

    speakWithGemini(
      getOpeningScript(name),
      "Gemini AI Interviewer is welcoming you...",
      token
    );
  }

  function renderProgressSegments(currentIndex) {
    progressSegments.innerHTML = "";
    for (let i = 0; i < PREPLANNED_QUESTIONS.length; i += 1) {
      const seg = document.createElement("div");
      seg.className = "seg-item";
      if (i < currentIndex) seg.classList.add("done");
      else if (i === currentIndex) seg.classList.add("active");
      progressSegments.appendChild(seg);
    }
  }

  function renderQuestionDisplay(idx) {
    const q = PREPLANNED_QUESTIONS[idx];
    const { name, jobRole } = state.candidate;

    interviewCandidatePill.textContent = `${name} • ${jobRole}`;
    questionCounterBadge.textContent = `Question ${idx + 1} of ${PREPLANNED_QUESTIONS.length}`;
    questionTopicBadge.textContent = q.topic;

    const percent = Math.round(((idx + 1) / PREPLANNED_QUESTIONS.length) * 100);
    progressPctLabel.textContent = `${percent}% Complete`;
    renderProgressSegments(idx);

    transitionPhraseText.textContent = `✨ ${getTransitionPhrase(idx, name, jobRole)}`;
    currentQuestionText.textContent = q.question;
  }

  async function beginRealtimeInterview() {
    beginQuestionsBtn.disabled = true;
    try {
      await ensureMicrophoneAccess();
    } catch (err) {
      beginQuestionsBtn.disabled = false;
      window.alert(
        "Microphone permission is required for the hands-free real-time interview. Please allow microphone access when prompted."
      );
      return;
    }
    beginQuestionsBtn.disabled = false;

    state.answers = [];
    showView("interview");
    const sessionToken = state.sessionToken;
    runRealtimeQuestionLoop(sessionToken);
  }

  async function runRealtimeQuestionLoop(sessionToken) {
    const { name, jobRole } = state.candidate;

    for (let idx = 0; idx < PREPLANNED_QUESTIONS.length; idx += 1) {
      if (state.sessionToken !== sessionToken) return;

      const q = PREPLANNED_QUESTIONS[idx];
      renderQuestionDisplay(idx);

      // Token optimization: prefetch only the immediate next prompt (skip if muted)
      if (!state.voiceMuted) {
        if (idx + 1 < PREPLANNED_QUESTIONS.length) {
          prefetchTtsAudio(getQuestionSpokenText(idx + 1, name, jobRole, PREPLANNED_QUESTIONS[idx + 1]));
        } else {
          prefetchTtsAudio(getClosingSpokenText(name));
        }
      }

      // AI Turn
      setTurnUI(
        "turn-ai",
        "🔊 Gemini AI is speaking...",
        "Listening pauses while interviewer speaks"
      );
      liveTranscriptText.textContent = "Listen carefully to the interviewer...";
      liveInterimText.classList.add("hidden");
      silenceCountdownWrapper.classList.add("hidden");
      wordCountBadge.textContent = "0 words";

      const spokenPrompt = getQuestionSpokenText(idx, name, jobRole, q);
      await speakWithGemini(spokenPrompt, `Asking Question ${idx + 1} of 10...`, sessionToken);
      if (state.sessionToken !== sessionToken) return;

      await waitMs(260);
      if (state.sessionToken !== sessionToken) return;

      // Student Turn (Hands-free auto-listen + auto-advance)
      const studentAnswer = await listenForStudentAnswer(idx, sessionToken);
      if (state.sessionToken !== sessionToken) return;

      state.answers.push({
        id: q.id,
        topic: q.topic,
        question: q.question,
        answer: studentAnswer,
        answerMethod: "voice",
      });
    }

    if (state.sessionToken !== sessionToken) return;
    setTurnUI(
      "turn-transition",
      "🎉 Interview Complete! Preparing your report...",
      "All 10 questions completed"
    );
    releaseMicrophone();

    await speakWithGemini(
      getClosingSpokenText(name),
      "Wrapping up your interview...",
      sessionToken
    );

    if (state.sessionToken !== sessionToken) return;
    await submitFullInterviewForEvaluation();
  }

  function buildClientFallbackReport(candidate, responses) {
    const evals = responses.map((r) => {
      const ans = (r.answer || "").trim();
      const words = ans.split(/\s+/).filter(Boolean);
      const wc = words.length;
      const rScore = wc >= 10 ? 2 : wc >= 4 ? 1.5 : 0.5;
      const cScore = wc >= 12 ? 2 : wc >= 5 ? 1.5 : 0.5;
      const gScore = /^[A-Z]/.test(ans) && wc >= 5 ? 2 : 1;
      const vScore = wc >= 12 ? 1 : 0.5;
      const pScore = wc >= 18 ? 2 : wc >= 8 ? 1 : 0.5;
      const fScore = /\b(i can|i am|i enjoy|i believe|for example)\b/i.test(ans) ? 1 : 0.5;
      const total = Math.round((rScore + cScore + gScore + vScore + pScore + fScore) * 10) / 10;
      return {
        id: r.id,
        topic: r.topic,
        question: r.question,
        studentAnswer: ans || "[No answer provided]",
        score: total,
        criteria: {
          relevance: rScore,
          clarity: cScore,
          grammar: gScore,
          vocabulary: vScore,
          completeness: pScore,
          confidence: fScore,
        },
        feedback:
          wc >= 14
            ? `Clear answer for ${r.topic}. Keep pairing your strengths with short real examples.`
            : `Good start on ${r.topic}. Try expanding into 2 to 3 complete sentences.`,
        sampleImprovedAnswer: `I am excited to bring my skills and dedication to the ${candidate.jobRole} role, and I always look for ways to learn and help others succeed.`,
      };
    });

    const overallScore =
      Math.round((evals.reduce((s, q) => s + q.score, 0) / Math.max(1, evals.length)) * 10) / 10;
    const sorted = [...evals].sort((a, b) => b.score - a.score);
    const best = sorted[0];
    const weak = sorted[sorted.length - 1];
    const baseCat = Math.max(1, Math.min(10, Math.round(overallScore)));

    return {
      candidate,
      evaluationEngine: "local-fallback",
      modelUsed: null,
      overallScore,
      overallScoreRounded: Math.round(overallScore),
      categories: {
        communication: baseCat,
        confidence: Math.max(1, baseCat - 1),
        answerQuality: baseCat,
        vocabulary: baseCat,
        grammar: baseCat,
        relevance: baseCat,
      },
      confidenceDisclaimer:
        "Confidence is assessed from written content, clarity, and positive phrasing only. Vocal tone, eye contact, and body language are not evaluated from text transcripts.",
      strengths: [
        "You completed all 10 interview questions from start to finish.",
        `Your responses stayed focused on your ${candidate.jobRole} goal.`,
        "You communicated your ideas in understandable English.",
      ],
      areasToImprove: [
        "Aim for 2 to 4 complete sentences per answer.",
        "Include a short real example for teamwork and problem solving.",
        "Use positive phrasing such as 'I can contribute...' or 'I helped...'.",
      ],
      bestAnswer: {
        questionNumber: best.id,
        topic: best.topic,
        question: best.question,
        studentAnswer: best.studentAnswer,
        whyItWasGood: `Your response on ${best.topic} was clear, direct, and relevant to ${candidate.jobRole}.`,
      },
      answerImprovement: {
        questionNumber: weak.id,
        topic: weak.topic,
        question: weak.question,
        originalAnswer: weak.studentAnswer,
        improvedAnswer: weak.sampleImprovedAnswer,
        whyItIsBetter: `Uses complete sentences and connects your skills directly to the ${candidate.jobRole} role.`,
      },
      nextSteps: [
        "Practise introducing yourself clearly for one minute.",
        `Learn five common interview vocabulary words for ${candidate.jobRole}.`,
        "Practise answering questions using complete sentences.",
        "Prepare one short teamwork example and one problem-solving example.",
        "Repeat this 10-question interview session after practising.",
      ],
      questionEvaluations: evals,
    };
  }

  async function evaluateDirectlyWithBrowserGemini(candidate, responses, apiKey) {
    const schema = {
      type: "OBJECT",
      properties: {
        cats: {
          type: "OBJECT",
          properties: {
            communication: { type: "INTEGER" },
            confidence: { type: "INTEGER" },
            answerQuality: { type: "INTEGER" },
            vocabulary: { type: "INTEGER" },
            grammar: { type: "INTEGER" },
            relevance: { type: "INTEGER" },
          },
          required: ["communication", "confidence", "answerQuality", "vocabulary", "grammar", "relevance"],
        },
        strengths: { type: "ARRAY", items: { type: "STRING" } },
        areasToImprove: { type: "ARRAY", items: { type: "STRING" } },
        best: { type: "OBJECT", properties: { qId: { type: "INTEGER" }, reason: { type: "STRING" } }, required: ["qId", "reason"] },
        improve: {
          type: "OBJECT",
          properties: { qId: { type: "INTEGER" }, better: { type: "STRING" }, reason: { type: "STRING" } },
          required: ["qId", "better", "reason"],
        },
        nextSteps: { type: "ARRAY", items: { type: "STRING" } },
        items: {
          type: "ARRAY",
          items: {
            type: "OBJECT",
            properties: {
              id: { type: "INTEGER" },
              r: { type: "NUMBER" },
              c: { type: "NUMBER" },
              g: { type: "NUMBER" },
              v: { type: "NUMBER" },
              p: { type: "NUMBER" },
              f: { type: "NUMBER" },
              fb: { type: "STRING" },
              alt: { type: "STRING" },
            },
            required: ["id", "r", "c", "g", "v", "p", "f", "fb", "alt"],
          },
        },
      },
      required: ["cats", "strengths", "areasToImprove", "best", "improve", "nextSteps", "items"],
    };

    const lines = responses
      .map((item) => `Q${item.id} [${item.topic}]: ${item.question}\nA: ${(item.answer || "").trim() || "[None]"}`)
      .join("\n\n");

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${encodeURIComponent(
        apiKey
      )}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: {
            parts: [
              {
                text: "Supportive VCOT Career Guidance assessor. Score 10 answers: r=relevance(0-2), c=clarity(0-2), g=grammar(0-2), v=vocabulary(0-1), p=completeness(0-2), f=confidence-in-text(0-1). cats are overall 0-10 scores.",
              },
            ],
          },
          contents: [
            {
              role: "user",
              parts: [{ text: `Candidate: ${candidate.name} | Role: ${candidate.jobRole} | Level: ${candidate.difficulty}\n\n${lines}` }],
            },
          ],
          generationConfig: {
            temperature: 0.25,
            responseMimeType: "application/json",
            responseSchema: schema,
            thinkingConfig: { thinkingBudget: 0 },
            maxOutputTokens: 1800,
          },
        }),
      }
    );
    if (!res.ok) throw new Error(`Gemini HTTP ${res.status}`);
    const data = await res.json();
    const textPart = (data?.candidates?.[0]?.content?.parts || []).find((p) => typeof p.text === "string");
    const compact = JSON.parse(textPart.text);

    const questionEvaluations = responses.map((resp, idx) => {
      const found = (compact.items || []).find((x) => Number(x.id) === resp.id) || compact.items[idx] || {};
      const criteria = {
        relevance: Number(found.r) || 0,
        clarity: Number(found.c) || 0,
        grammar: Number(found.g) || 0,
        vocabulary: Number(found.v) || 0,
        completeness: Number(found.p) || 0,
        confidence: Number(found.f) || 0,
      };
      const score =
        Math.round(
          (criteria.relevance +
            criteria.clarity +
            criteria.grammar +
            criteria.vocabulary +
            criteria.completeness +
            criteria.confidence) *
            10
        ) / 10;
      return {
        id: resp.id,
        topic: resp.topic,
        question: resp.question,
        studentAnswer: resp.answer || "[No answer provided]",
        score,
        criteria,
        feedback: found.fb || "",
        sampleImprovedAnswer: found.alt || "",
      };
    });

    const overallScore =
      Math.round(
        (questionEvaluations.reduce((s, q) => s + q.score, 0) / Math.max(1, questionEvaluations.length)) * 10
      ) / 10;
    const bestQ = questionEvaluations.find((q) => q.id === Number(compact?.best?.qId)) || questionEvaluations[0];
    const weakQ = questionEvaluations.find((q) => q.id === Number(compact?.improve?.qId)) || questionEvaluations[0];

    return {
      candidate,
      evaluationEngine: "gemini",
      modelUsed: "gemini-3.1-flash-lite",
      overallScore,
      overallScoreRounded: Math.round(overallScore),
      categories: compact.cats,
      confidenceDisclaimer:
        "Confidence is assessed from written content, clarity, and positive phrasing only. Vocal tone, eye contact, and body language are not evaluated from text transcripts.",
      strengths: compact.strengths,
      areasToImprove: compact.areasToImprove,
      bestAnswer: {
        questionNumber: bestQ.id,
        topic: bestQ.topic,
        question: bestQ.question,
        studentAnswer: bestQ.studentAnswer,
        whyItWasGood: compact.best.reason,
      },
      answerImprovement: {
        questionNumber: weakQ.id,
        topic: weakQ.topic,
        question: weakQ.question,
        originalAnswer: weakQ.studentAnswer,
        improvedAnswer: compact.improve.better,
        whyItIsBetter: compact.improve.reason,
      },
      nextSteps: compact.nextSteps,
      questionEvaluations,
    };
  }

  async function submitFullInterviewForEvaluation() {
    showView("report");
    evaluatingStateCard.classList.remove("hidden");
    reportContentContainer.classList.add("hidden");

    try {
      if (!state.backendAvailable) {
        if (state.browserApiKey) {
          try {
            const directReport = await evaluateDirectlyWithBrowserGemini(
              state.candidate,
              state.answers,
              state.browserApiKey
            );
            renderFeedbackReport(directReport);
            return;
          } catch (directErr) {
            // Fall through to local rubric report
          }
        }
        renderFeedbackReport(buildClientFallbackReport(state.candidate, state.answers));
        return;
      }

      const response = await fetch("./api/evaluate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          candidate: state.candidate,
          responses: state.answers,
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Failed to evaluate interview");
      }

      renderFeedbackReport(data);
    } catch (err) {
      evaluatingStateCard.innerHTML = `
        <h2>Could not complete evaluation</h2>
        <p class="muted-text">${err.message || "Unexpected error"}</p>
        <div style="margin-top:20px;">
          <button type="button" onclick="location.reload()" class="btn btn-primary">Restart Session</button>
        </div>
      `;
    }
  }

  // =========================================================================
  // Feedback Report Rendering
  // =========================================================================
  function getScoreCaption(score) {
    if (score >= 8.5) return "Outstanding Performance!";
    if (score >= 7.0) return "Well Done — Strong Interview!";
    if (score >= 5.5) return "Good Effort — Keep Practising!";
    return "Great Start — Let's Build Confidence Together!";
  }

  function renderFeedbackReport(report) {
    evaluatingStateCard.classList.add("hidden");
    reportContentContainer.classList.remove("hidden");

    reportCandidateName.textContent = report.candidate.name;
    reportJobRole.textContent = report.candidate.jobRole;

    const overallNum = Number(report.overallScore || 0);
    overallScoreValue.textContent = overallNum.toFixed(1);
    overallScoreCaption.textContent = getScoreCaption(overallNum);

    // Animate Circular SVG Gauge
    const circumference = 2 * Math.PI * 58;
    scoreRingCircle.style.strokeDasharray = String(circumference);
    scoreRingCircle.style.strokeDashoffset = String(circumference);
    requestAnimationFrame(() => {
      const offset = circumference * (1 - Math.max(0, Math.min(10, overallNum)) / 10);
      scoreRingCircle.style.strokeDashoffset = String(offset);
    });

    evaluationEngineBadge.textContent =
      report.evaluationEngine === "gemini"
        ? `Gemini AI Analysis (${report.modelUsed || "Gemini"})`
        : "VCOT Smart Rubric Analysis";

    const categoryEntries = [
      { key: "communication", label: "Communication" },
      { key: "confidence", label: "Confidence" },
      { key: "answerQuality", label: "Answer Quality" },
      { key: "vocabulary", label: "Vocabulary" },
      { key: "grammar", label: "Grammar" },
      { key: "relevance", label: "Relevance" },
    ];
    categoryBreakdownGrid.innerHTML = "";
    categoryEntries.forEach(({ key, label }) => {
      const val = Number(report.categories?.[key] ?? 0);
      const item = document.createElement("div");
      item.className = "breakdown-item";

      const top = document.createElement("div");
      top.className = "breakdown-top";
      const nameSpan = document.createElement("span");
      nameSpan.textContent = label;
      const scoreSpan = document.createElement("span");
      scoreSpan.textContent = `${val} / 10`;
      top.appendChild(nameSpan);
      top.appendChild(scoreSpan);

      const track = document.createElement("div");
      track.className = "mini-bar-track";
      const fill = document.createElement("div");
      fill.className = "mini-bar-fill";
      if (val >= 8) fill.classList.add("fill-high");
      else if (val < 6) fill.classList.add("fill-low");
      fill.style.width = `${Math.max(5, Math.min(100, val * 10))}%`;
      track.appendChild(fill);

      item.appendChild(top);
      item.appendChild(track);
      categoryBreakdownGrid.appendChild(item);
    });

    confidenceDisclaimerBox.textContent = `Note on Confidence Scoring: ${report.confidenceDisclaimer}`;

    renderBulletList(strengthsList, report.strengths);
    renderBulletList(areasToImproveList, report.areasToImprove);

    const best = report.bestAnswer;
    bestAnswerMeta.textContent = `Question ${best.questionNumber} — ${best.topic}: "${best.question}"`;
    bestAnswerQuote.textContent = `"${best.studentAnswer}"`;
    bestAnswerReason.textContent = best.whyItWasGood;

    const imp = report.answerImprovement;
    improveAnswerMeta.textContent = `Question ${imp.questionNumber} — ${imp.topic}: "${imp.question}"`;
    improveOriginalText.textContent = imp.originalAnswer;
    improveBetterText.textContent = imp.improvedAnswer;
    improveReasonText.textContent = imp.whyItIsBetter;

    questionRubricList.innerHTML = "";
    (report.questionEvaluations || []).forEach((q) => {
      const details = document.createElement("details");
      details.className = "rubric-item";

      const summary = document.createElement("summary");
      summary.className = "rubric-summary";
      const qTitle = document.createElement("span");
      qTitle.textContent = `Q${q.id} (${q.topic}): ${q.question}`;
      const qScore = document.createElement("span");
      qScore.className = "rubric-score-pill";
      qScore.textContent = `${Number(q.score).toFixed(1)} / 10`;
      summary.appendChild(qTitle);
      summary.appendChild(qScore);

      const body = document.createElement("div");
      body.className = "rubric-body";

      const ansP = document.createElement("p");
      const ansStrong = document.createElement("strong");
      ansStrong.textContent = "Your Answer: ";
      ansP.appendChild(ansStrong);
      ansP.appendChild(document.createTextNode(q.studentAnswer));

      const criteriaDiv = document.createElement("div");
      criteriaDiv.className = "criteria-badges";
      const c = q.criteria || {};
      const chips = [
        `Relevance: ${c.relevance ?? 0}/2`,
        `Clarity: ${c.clarity ?? 0}/2`,
        `Grammar: ${c.grammar ?? 0}/2`,
        `Vocabulary: ${c.vocabulary ?? 0}/1`,
        `Completeness: ${c.completeness ?? 0}/2`,
        `Confidence: ${c.confidence ?? 0}/1`,
      ];
      chips.forEach((txt) => {
        const chip = document.createElement("span");
        chip.className = "criteria-chip";
        chip.textContent = txt;
        criteriaDiv.appendChild(chip);
      });

      const fbP = document.createElement("p");
      const fbStrong = document.createElement("strong");
      fbStrong.textContent = "Feedback: ";
      fbP.appendChild(fbStrong);
      fbP.appendChild(document.createTextNode(q.feedback));

      body.appendChild(ansP);
      body.appendChild(criteriaDiv);
      body.appendChild(fbP);

      if (q.sampleImprovedAnswer) {
        const sampleP = document.createElement("p");
        const sampleStrong = document.createElement("strong");
        sampleStrong.textContent = "Model Example: ";
        sampleP.appendChild(sampleStrong);
        sampleP.appendChild(document.createTextNode(q.sampleImprovedAnswer));
        body.appendChild(sampleP);
      }

      details.appendChild(summary);
      details.appendChild(body);
      questionRubricList.appendChild(details);
    });

    renderBulletList(nextStepsList, report.nextSteps);
  }

  function renderBulletList(listEl, items) {
    listEl.innerHTML = "";
    (items || []).forEach((item) => {
      const li = document.createElement("li");
      li.textContent = item;
      listEl.appendChild(li);
    });
  }

  // =========================================================================
  // Event Bindings
  // =========================================================================
  function bindEvents() {
    headerBrandBtn.addEventListener("click", () => {
      if (state.currentView === "interview" && state.answers.length > 0) {
        const confirmed = window.confirm(
          "Return to the VCOT Home Screen? Your current interview session will stop."
        );
        if (!confirmed) return;
      }
      showView("home");
    });

    startPracticeBtn.addEventListener("click", () => {
      showView("register");
      candidateNameInput.focus();
    });

    backToHomeBtn.addEventListener("click", () => showView("home"));

    candidateJobRoleInput.addEventListener("input", syncSelectedRoleChip);

    registrationForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const name = candidateNameInput.value.trim();
      const jobRole = candidateJobRoleInput.value.trim();

      if (!name || !jobRole) {
        regErrorMsg.textContent = "Please enter both your name and target job role to begin.";
        regErrorMsg.classList.remove("hidden");
        return;
      }

      regErrorMsg.classList.add("hidden");
      state.candidate = {
        name,
        jobRole,
        language: interviewLanguageSelect.value || "English",
        difficulty: interviewDifficultySelect.value || "Beginner",
      };

      startIntroductionStage();
    });

    replayIntroBtn.addEventListener("click", () => {
      speakWithGemini(
        getOpeningScript(state.candidate.name),
        "Gemini AI Interviewer is replaying the welcome...",
        state.sessionToken
      );
    });

    backToRegisterBtn.addEventListener("click", () => showView("register"));

    beginQuestionsBtn.addEventListener("click", beginRealtimeInterview);

    globalMuteBtn.addEventListener("click", () => {
      state.voiceMuted = !state.voiceMuted;
      if (state.voiceMuted) {
        stopSpeaking();
      }
      updateMuteUI();
    });

    toggleAllRubricsBtn.addEventListener("click", () => {
      const items = questionRubricList.querySelectorAll("details");
      const anyClosed = Array.from(items).some((d) => !d.open);
      items.forEach((d) => {
        d.open = anyClosed;
      });
      toggleAllRubricsBtn.textContent = anyClosed ? "Collapse All" : "Expand All";
    });

    printReportBtn.addEventListener("click", () => window.print());

    tryAnotherBtn.addEventListener("click", () => {
      state.answers = [];
      showView("register");
    });

    connectKeyBtn.addEventListener("click", () => {
      browserGeminiKeyInput.value = state.browserApiKey;
      geminiKeyModal.classList.remove("hidden");
      browserGeminiKeyInput.focus();
    });

    closeKeyModalBtn.addEventListener("click", () => {
      geminiKeyModal.classList.add("hidden");
    });

    saveBrowserKeyBtn.addEventListener("click", () => {
      const val = browserGeminiKeyInput.value.trim();
      state.browserApiKey = val;
      if (val) {
        localStorage.setItem(STORAGE_KEY_NAME, val);
      } else {
        localStorage.removeItem(STORAGE_KEY_NAME);
      }
      clientTtsCache.clear();
      updateConnectKeyUI();
      geminiKeyModal.classList.add("hidden");
    });

    clearBrowserKeyBtn.addEventListener("click", () => {
      browserGeminiKeyInput.value = "";
      state.browserApiKey = "";
      localStorage.removeItem(STORAGE_KEY_NAME);
      clientTtsCache.clear();
      updateConnectKeyUI();
      geminiKeyModal.classList.add("hidden");
    });
  }

  init();
})();
