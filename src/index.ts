/*
════════════════════════════════════════════════════════════════════
  WG v2.0 — Wayground Game Helper
  https://github.com/Danz-Pro/WG

  Built from deep analysis of wayground.com (Quizizz rebrand):
  ┌─────────────────────────────────────────────────────────────┐
  │ Quiz API: /_api/main/quiz/{quizId}                         │
  │   → Always returns correct answers, NO AUTH required        │
  │   → MCQ:  structure.answer = number (0-based option index) │
  │   → BLANK: structure.answer = [{targetId, optionId[]}]     │
  │                                                             │
  │ DOM: data-cy="option-N" uses ORIGINAL API index            │
  │   → Not affected by jumbleAnswers shuffle!                 │
  │   → answer=2 → click [data-cy="option-2"] = ALWAYS CORRECT│
  │                                                             │
  │ BLANK input: [data-cy="fib-text-input"]                    │
  │ Pinia: gameQuestions.currentId for question tracking        │
  └─────────────────────────────────────────────────────────────┘
════════════════════════════════════════════════════════════════════
*/

// ═══════════════════════════════════════════
//  TYPES
// ═══════════════════════════════════════════

interface ApiOption {
  id?: string;
  text: string;
  type?: string;
  media?: { type: string; url: string }[];
  matcher?: string;
}

interface BlankAnswer {
  targetId: string;
  optionId: string[];
}

interface ApiQuestion {
  _id: string;
  type: string;
  structure: {
    answer: number | number[] | BlankAnswer[];
    options?: ApiOption[];
    query?: { text: string };
  };
}

interface ParsedAnswer {
  type: string;
  /** MCQ/MSQ: 0-based correct option index */
  indices: number[];
  /** For display in panel */
  displayTexts: string[];
  /** BLANK: accepted text answers */
  blankTexts: string[];
  /** Image URLs of correct options */
  imageUrls: string[];
}

// ═══════════════════════════════════════════
//  THEME — Black & Navy VVIP
// ═══════════════════════════════════════════

const T = {
  bg:          "rgba(8, 10, 28, 0.96)",
  bgGradient:  "linear-gradient(160deg, rgba(13,17,55,0.98), rgba(5,5,20,0.98))",
  navy:        "#0d1137",
  navyLight:   "#1a237e",
  navyGlow:    "#3949ab",
  accent:      "#7c4dff",    // Purple accent for VVIP feel
  accentDim:   "rgba(124,77,255,0.15)",
  gold:        "#ffd54f",    // Gold for correct answer
  goldDim:     "rgba(255,213,79,0.12)",
  goldGlow:    "rgba(255,213,79,0.4)",
  red:         "#ff5252",
  redDim:      "rgba(255,82,82,0.15)",
  text:        "#e8eaf6",
  textMuted:   "#9fa8da",
  textDim:     "#5c6bc0",
  border:      "rgba(26,35,126,0.5)",
  borderAccent:"rgba(124,77,255,0.4)",
  shadow:      "0 8px 40px rgba(0,0,0,0.7), 0 0 30px rgba(13,17,55,0.3)",
  dimOpacity:  "18%",
  radius:      "12px",
};

// ═══════════════════════════════════════════
//  STATE
// ═══════════════════════════════════════════

const STATE = {
  answers: new Map<string, ParsedAnswer>(),
  currentQId: "" as string,
  pollTimer: null as ReturnType<typeof setInterval> | null,
  panel: null as HTMLElement | null,
  style: null as HTMLElement | null,
  loaded: false,
  totalQ: 0,
  answeredQ: 0,
  correctQ: 0,
  autoAnswer: false,
  dimWrong: true,
  debug: false,
  showPanel: true,
  minimized: false,
  dragging: false,
  dragOffset: { x: 0, y: 0 },
  lastHighlightQId: "",
  retryCount: 0,
  maxRetries: 10,
};

// ═══════════════════════════════════════════
//  LOG
// ═══════════════════════════════════════════

const LOG = {
  info: (m: string) => STATE.debug && console.log(`%c[WG]%c ${m}`, "color:#7c4dff;font-weight:bold", "color:inherit"),
  warn: (m: string) => console.warn(`%c[WG]%c ${m}`, "color:#ffd54f;font-weight:bold", "color:inherit"),
  error: (m: string) => console.error(`%c[WG]%c ${m}`, "color:#ff5252;font-weight:bold", "color:inherit"),
  success: (m: string) => console.log(`%c[WG]%c ${m}`, "color:#00e676;font-weight:bold", "color:inherit"),
  always: (m: string) => console.log(`%c[WG]%c ${m}`, "color:#7c4dff;font-weight:bold", "color:inherit"),
};

// ═══════════════════════════════════════════
//  PINIA ACCESS
// ═══════════════════════════════════════════

const Pinia = {
  get(): any {
    const root = document.querySelector("#root") || document.querySelector("#app");
    if (!root) return null;
    const app = (root as any).__vue_app__;
    if (!app) return null;
    return app.config.globalProperties?.$pinia || null;
  },

  store(name: string): any {
    const p = this.get();
    return p?._s.get(name) || null;
  },

  state(name: string): any {
    return this.store(name)?.$state || null;
  },

  get quizId(): string | null {
    return this.state("gameData")?.quizId || null;
  },

  get roomHash(): string | null {
    return this.state("gameData")?.roomHash || null;
  },

  get currentQId(): string | null {
    const gq = this.state("gameQuestions");
    return gq?.currentId || gq?.currentQuestionId || null;
  },

  get inGame(): boolean {
    const gd = this.state("gameData");
    return !!(gd?.roomHash && gd?.gameState);
  },

  get questionList(): Record<string, any> {
    return this.state("gameQuestions")?.list || {};
  },
};

// ═══════════════════════════════════════════
//  HTML / TEXT UTILITIES
// ═══════════════════════════════════════════

const stripHtml = (html: string): string => {
  if (!html) return "";
  const d = document.createElement("div");
  d.innerHTML = html;
  return (d.textContent || d.innerText || "").trim();
};

// ═══════════════════════════════════════════
//  API — FETCH QUIZ DATA
// ═══════════════════════════════════════════

const API = {
  async fetchQuiz(quizId: string): Promise<ApiQuestion[]> {
    LOG.info(`Fetching Quiz API: ${quizId}`);
    const r = await fetch(`/_api/main/quiz/${quizId}`);
    if (!r.ok) throw new Error(`Quiz API: HTTP ${r.status}`);
    const d = await r.json();
    const qs = d?.data?.quiz?.info?.questions;
    if (!Array.isArray(qs)) throw new Error("Quiz API: no questions");
    return qs;
  },

  async fetchGame(roomHash: string): Promise<ApiQuestion[]> {
    LOG.info(`Fetching Game API: ${roomHash}`);
    const r = await fetch(`/_api/main/game/${roomHash}`);
    if (!r.ok) throw new Error(`Game API: HTTP ${r.status}`);
    const d = await r.json();
    const qs = d?.data?.questions;
    if (!Array.isArray(qs)) throw new Error("Game API: no questions");
    return qs;
  },

  async loadAnswers(): Promise<boolean> {
    let questions: ApiQuestion[] = [];
    const { quizId, roomHash } = { quizId: Pinia.quizId, roomHash: Pinia.roomHash };

    // Primary: Quiz API
    if (quizId) {
      try {
        questions = await this.fetchQuiz(quizId);
        LOG.success(`Quiz API: ${questions.length} questions loaded`);
      } catch (e: any) {
        LOG.warn(`Quiz API failed: ${e.message}`);
      }
    }

    // Fallback: Game API
    if (questions.length === 0 && roomHash) {
      try {
        questions = await this.fetchGame(roomHash);
        LOG.success(`Game API: ${questions.length} questions loaded`);
      } catch (e: any) {
        LOG.warn(`Game API failed: ${e.message}`);
      }
    }

    if (questions.length === 0) {
      LOG.error("All API sources failed!");
      return false;
    }

    // Parse all answers
    STATE.answers.clear();
    questions.forEach((q) => {
      STATE.answers.set(q._id, Parse.answer(q));
    });

    STATE.totalQ = questions.length;
    STATE.loaded = true;

    // Verify answer quality
    let valid = 0;
    STATE.answers.forEach((a) => {
      if (a.indices.length > 0 || a.blankTexts.length > 0 || a.imageUrls.length > 0) valid++;
    });
    LOG.success(`Answer quality: ${valid}/${STATE.totalQ} questions have valid answers`);

    return true;
  },
};

// ═══════════════════════════════════════════
//  ANSWER PARSER
// ═══════════════════════════════════════════

const Parse = {
  answer(q: ApiQuestion): ParsedAnswer {
    const result: ParsedAnswer = {
      type: q.type,
      indices: [],
      displayTexts: [],
      blankTexts: [],
      imageUrls: [],
    };

    const answer = q.structure.answer;
    const options = q.structure.options || [];

    // BLANK / OPEN
    if (q.type === "BLANK" || q.type === "OPEN") {
      if (Array.isArray(answer) && answer.length > 0 && typeof answer[0] === "object") {
        // Map optionId → option text
        const optMap = new Map<string, string>();
        options.forEach((o) => { if (o.id) optMap.set(o.id, stripHtml(o.text)); });

        (answer as BlankAnswer[]).forEach((a) => {
          a.optionId?.forEach((oid) => {
            const txt = optMap.get(oid);
            if (txt && txt.length > 0) {
              result.blankTexts.push(txt);
              result.displayTexts.push(txt);
            }
          });
        });
      }

      // Fallback: all options are answers
      if (result.blankTexts.length === 0) {
        options.forEach((o) => {
          const txt = stripHtml(o.text);
          if (txt) {
            result.blankTexts.push(txt);
            result.displayTexts.push(txt);
          }
        });
      }
      return result;
    }

    // MCQ / MSQ — collect correct indices
    if (typeof answer === "number" && answer >= 0) {
      result.indices.push(answer);
    } else if (Array.isArray(answer)) {
      answer.forEach((idx) => {
        if (typeof idx === "number" && idx >= 0) result.indices.push(idx);
      });
    }

    // Build display texts and image URLs
    result.indices.forEach((idx) => {
      if (idx < options.length) {
        const opt = options[idx];
        const rawText = stripHtml(opt.text);
        if (rawText) result.displayTexts.push(rawText);
        if (opt.media?.[0]?.url) result.imageUrls.push(opt.media[0].url.split("?")[0]);
      }
    });

    return result;
  },
};

// ═══════════════════════════════════════════
//  DOM — OPTION SELECTION & HIGHLIGHTING
// ═══════════════════════════════════════════

const DOM = {
  /** Get all option elements on current question */
  getOptions(): HTMLElement[] {
    return Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'));
  },

  /** Get option by API index — BULLETPROOF because data-cy is NOT shuffled */
  getOptionByIndex(idx: number): HTMLElement | null {
    return document.querySelector<HTMLElement>(`[data-cy="option-${idx}"]`);
  },

  /** Get BLANK input element */
  getBlankInput(): HTMLInputElement | null {
    return document.querySelector<HTMLInputElement>('[data-cy="fib-text-input"]') ||
           document.querySelector<HTMLInputElement>('input.fib-text-input');
  },

  /** Get Submit button for BLANK questions */
  getSubmitButton(): HTMLElement | null {
    return document.querySelector<HTMLElement>('[data-cy="submit-button"]') ||
           document.querySelector<HTMLElement>('button[type="submit"]');
  },

  /** Clear all previous highlights */
  clearHighlights(): void {
    document.querySelectorAll<HTMLElement>("[data-wg-correct], [data-wg-wrong]").forEach((el) => {
      el.style.outline = "";
      el.style.outlineOffset = "";
      el.style.opacity = "";
      el.style.transition = "";
      el.style.boxShadow = "";
      el.style.transform = "";
      el.style.background = "";
      el.removeAttribute("data-wg-correct");
      el.removeAttribute("data-wg-wrong");
    });
  },

  /** Highlight a correct option element with gold VVIP style */
  highlightCorrect(el: HTMLElement): void {
    el.style.outline = `2px solid ${T.gold}`;
    el.style.outlineOffset = "1px";
    el.style.boxShadow = `0 0 20px ${T.goldGlow}, inset 0 0 12px ${T.goldDim}`;
    el.style.transition = "all 0.35s cubic-bezier(0.4, 0, 0.2, 1)";
    el.style.transform = "scale(1.04)";
    el.style.background = `linear-gradient(135deg, ${T.goldDim}, transparent)`;
    el.setAttribute("data-wg-correct", "1");
  },

  /** Dim a wrong option element */
  dimWrong(el: HTMLElement): void {
    el.style.opacity = T.dimOpacity;
    el.style.transition = "opacity 0.4s ease";
    el.setAttribute("data-wg-wrong", "1");
  },

  /** Extract background-image URL from element */
  extractImageUrl(el: HTMLElement): string | null {
    const els = [el, ...Array.from(el.querySelectorAll<HTMLElement>("div"))];
    for (const e of els) {
      const bg = e.style.backgroundImage || getComputedStyle(e).backgroundImage;
      if (bg && bg.includes("url(")) {
        const m = bg.match(/url\(["']?([^"')]+)["']?\)/);
        if (m) return m[1].split("?")[0];
      }
    }
    return null;
  },

  /** Fill BLANK input with correct answer text */
  fillBlank(text: string): boolean {
    const input = this.getBlankInput();
    if (!input) {
      LOG.warn("BLANK input not found in DOM");
      return false;
    }

    // Use native setter to trigger Vue reactivity
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (setter) {
      setter.call(input, text);
    } else {
      input.value = text;
    }

    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    LOG.success(`Filled blank: "${text}"`);
    return true;
  },
};

// ═══════════════════════════════════════════
//  ENGINE — CORE LOGIC
// ═══════════════════════════════════════════

const Engine = {
  /** Process current question — highlight correct answer */
  processQuestion(qId: string): boolean {
    if (!STATE.loaded) return false;

    const answer = STATE.answers.get(qId);
    if (!answer) {
      LOG.warn(`Question ${qId} not in answer map`);
      return false;
    }

    DOM.clearHighlights();
    // BUG FIX #1: Don't set lastHighlightQId here — set it AFTER successful highlight
    // This was blocking retries when handleMCQ failed

    // Get question text from store
    const qList = Pinia.questionList;
    const qObj = qList?.[qId];
    const qText = qObj?.text ? stripHtml(qObj.text) : "";

    // BUG FIX #4: Show image option index if no text
    let answerDisplay = "—";
    if (answer.displayTexts.length > 0) {
      answerDisplay = answer.displayTexts.join(" / ");
    } else if (answer.imageUrls.length > 0) {
      answerDisplay = `Opsi gambar ${answer.indices.map(i => `#${i + 1}`).join(", ")}`;
    } else if (answer.blankTexts.length > 0) {
      answerDisplay = answer.blankTexts.join(" / ");
    }

    // Update panel
    Panel.updateQuestion(qText, answer.type);
    Panel.updateAnswer(answerDisplay);

    // Handle by type
    let success = false;
    if (answer.type === "BLANK" || answer.type === "OPEN") {
      success = this.handleBlank(answer);
    } else {
      success = this.handleMCQ(answer, qId);
    }

    // BUG FIX #1: Only mark as processed AFTER success
    if (success) {
      STATE.lastHighlightQId = qId;
    }
    return success;
  },

  /** Handle MCQ/MSQ question highlighting */
  handleMCQ(answer: ParsedAnswer, qId: string): boolean {
    const allOptions = DOM.getOptions();
    if (allOptions.length === 0) {
      LOG.warn("No option elements found in DOM yet");
      return false;
    }

    // METHOD 1: data-cy="option-N" — BULLETPROOF, not affected by shuffle
    const correctEls: HTMLElement[] = [];
    for (const idx of answer.indices) {
      const el = DOM.getOptionByIndex(idx);
      if (el) correctEls.push(el);
    }

    // METHOD 2: Text fallback (if data-cy didn't work)
    if (correctEls.length === 0 && answer.displayTexts.length > 0) {
      allOptions.forEach((el) => {
        const elText = stripHtml(el.textContent || "").toLowerCase();
        for (const ct of answer.displayTexts) {
          const ctLower = ct.toLowerCase();
          if (elText === ctLower || elText.includes(ctLower) || ctLower.includes(elText)) {
            correctEls.push(el);
            break;
          }
        }
      });
    }

    // METHOD 3: Image URL fallback
    if (correctEls.length === 0 && answer.imageUrls.length > 0) {
      allOptions.forEach((el) => {
        const url = DOM.extractImageUrl(el);
        if (url) {
          for (const cu of answer.imageUrls) {
            if (url === cu || url.includes(cu) || cu.includes(url)) {
              correctEls.push(el);
              break;
            }
          }
        }
      });
    }

    // METHOD 4: Numeric comparison
    if (correctEls.length === 0 && answer.displayTexts.length > 0) {
      allOptions.forEach((el) => {
        const elNum = parseFloat(stripHtml(el.textContent || "").replace(/[^\d.\-]/g, ""));
        for (const ct of answer.displayTexts) {
          const ctNum = parseFloat(ct.replace(/[^\d.\-]/g, ""));
          if (!isNaN(elNum) && !isNaN(ctNum) && Math.abs(elNum - ctNum) < 0.01) {
            correctEls.push(el);
            break;
          }
        }
      });
    }

    // Apply highlights
    if (correctEls.length > 0) {
      const correctSet = new Set(correctEls);
      allOptions.forEach((el) => {
        if (correctSet.has(el)) {
          DOM.highlightCorrect(el);
        } else if (STATE.dimWrong) {
          DOM.dimWrong(el);
        }
      });

      STATE.correctQ++;
      LOG.success(`Highlighted ${correctEls.length} correct / ${allOptions.length} total`);

      // BUG FIX #2: Re-apply highlights after auto-answer click
      // because the DOM re-renders and removes our styles
      if (STATE.autoAnswer && correctEls[0] && answer.indices.length <= 1) {
        const correctRef = correctEls[0];
        const allOptsRef = allOptions;
        const correctSetRef = correctSet;
        setTimeout(() => {
          correctRef.click();
          LOG.success("Auto-clicked answer");
          // Re-apply highlights after click (DOM may re-render)
          setTimeout(() => {
            this.reapplyHighlights(allOptsRef, correctSetRef);
          }, 500);
        }, 150 + Math.random() * 500);
      }

      return true;
    }

    LOG.warn("Could not match any correct option in DOM");
    return false;
  },

  /** Re-apply highlights to existing option elements (after DOM re-render) */
  reapplyHighlights(allOptions: HTMLElement[], correctSet: Set<HTMLElement>): void {
    allOptions.forEach((el) => {
      // Check if element is still in DOM
      if (!el.parentNode) return;
      // Check if our attributes were removed (DOM re-rendered)
      if (!el.hasAttribute("data-wg-correct") && !el.hasAttribute("data-wg-wrong")) {
        if (correctSet.has(el)) {
          DOM.highlightCorrect(el);
        } else if (STATE.dimWrong) {
          DOM.dimWrong(el);
        }
      }
    });
  },

  /** Handle BLANK/OPEN question */
  handleBlank(answer: ParsedAnswer): boolean {
    if (answer.blankTexts.length === 0) {
      LOG.warn("No BLANK answer texts available");
      return true; // Don't retry, just show panel
    }

    // Try to fill input
    if (STATE.autoAnswer) {
      const filled = DOM.fillBlank(answer.blankTexts[0]);
      if (filled) {
        // Auto-submit after short delay
        setTimeout(() => {
          const btn = DOM.getSubmitButton();
          if (btn) {
            btn.click();
            LOG.success("Auto-submitted blank answer");
          }
        }, 300 + Math.random() * 400);
      }
    }

    return true;
  },

  /** Check for question change and process */
  tick(): void {
    if (!STATE.loaded) return;

    const qId = Pinia.currentQId;
    if (!qId || qId === STATE.currentQId) return;

    STATE.currentQId = qId;
    // BUG FIX #3: Count from Pinia state instead of incrementing
    const gq = Pinia.state("gameQuestions");
    STATE.answeredQ = gq?.doneOrder?.length || 0;

    LOG.info(`New question: ${qId}`);
    STATE.retryCount = 0;

    // Try processing, with retry if DOM not ready
    const tryProcess = () => {
      if (STATE.retryCount >= STATE.maxRetries) {
        LOG.warn(`Gave up after ${STATE.maxRetries} retries`);
        return;
      }

      const success = this.processQuestion(qId);
      if (!success) {
        STATE.retryCount++;
        LOG.info(`Retry ${STATE.retryCount}/${STATE.maxRetries} in 400ms`);
        setTimeout(tryProcess, 400);
      } else {
        STATE.retryCount = 0;
      }
    };

    tryProcess();
    Panel.updateStats();
  },

  /** Start the polling loop */
  startPolling(): void {
    if (STATE.pollTimer) clearInterval(STATE.pollTimer);
    STATE.pollTimer = setInterval(() => this.tick(), 200);
    LOG.info("Polling started (200ms)");

    // BUG FIX #2: Watch DOM mutations to re-apply highlights when quiz re-renders
    this.setupDOMWatcher();
  },

  /** Watch for DOM mutations that remove our highlights (after auto-click or reveal) */
  setupDOMWatcher(): void {
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let reapplyCount = 0;
    const MAX_REAPPLY = 3; // Max re-apply attempts per question

    const observer = new MutationObserver((mutations) => {
      // Skip if: no question highlighted, not in game, or BLANK type (no visual highlights)
      if (!STATE.lastHighlightQId) return;
      if (!Pinia.inGame) return;

      // Check if current question is BLANK/OPEN — skip reapply for these
      const answer = STATE.answers.get(STATE.lastHighlightQId);
      if (answer && (answer.type === "BLANK" || answer.type === "OPEN")) return;

      const relevant = mutations.some((m) => {
        if (m.type === "attributes") {
          const target = m.target as HTMLElement;
          if (m.attributeName === "data-wg-correct" || m.attributeName === "data-wg-wrong" || m.attributeName === "style") return false;
          // React to class changes on option elements
          if (target.hasAttribute?.("role") && target.getAttribute("role") === "option") return true;
          return false;
        }
        return m.type === "childList";
      });

      if (!relevant) return;

      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        // Check if highlights are still present
        const hasHighlights = document.querySelector("[data-wg-correct]");
        if (!hasHighlights && reapplyCount < MAX_REAPPLY) {
          reapplyCount++;
          LOG.info(`Highlights lost, re-applying (${reapplyCount}/${MAX_REAPPLY})...`);
          STATE.lastHighlightQId = ""; // Reset so processQuestion runs again
          const currentQId = Pinia.currentQId;
          if (currentQId) {
            this.processQuestion(currentQId);
          }
        }
      }, 300);
    });

    // Reset reapply counter when question changes
    const originalTick = this.tick.bind(this);
    this.tick = () => {
      reapplyCount = 0;
      originalTick();
    };

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class"],
    });
  },

  /** Stop everything */
  stop(): void {
    if (STATE.pollTimer) { clearInterval(STATE.pollTimer); STATE.pollTimer = null; }
    DOM.clearHighlights();
    STATE.loaded = false;
    STATE.answers.clear();
    STATE.currentQId = "";
    STATE.lastHighlightQId = "";
    STATE.totalQ = 0;
    STATE.answeredQ = 0;
    STATE.correctQ = 0;
    LOG.always("Stopped");
  },
};

// ═══════════════════════════════════════════
//  PANEL — VVIP FLOATING UI
// ═══════════════════════════════════════════

const Panel = {
  create(): void {
    if (STATE.panel) return;

    const el = document.createElement("div");
    el.id = "wg-panel";
    el.classList.add("ghost"); // Mulai dalam ghost mode
    el.innerHTML = `
      <div id="wg-header">
        <div id="wg-logo">
          <span id="wg-logo-sub">ELITE</span>
        </div>
        <div id="wg-header-actions">
          <button id="wg-btn-reload" title="Muat ulang jawaban">&#x21bb;</button>
          <button id="wg-btn-minimize" title="Perkecil">&#x2500;</button>
        </div>
      </div>
      <div id="wg-body">
        <div id="wg-status">
          <span id="wg-status-dot"></span>
          <span id="wg-status-text">Memulai...</span>
        </div>
        <div id="wg-question"></div>
        <div id="wg-answer"></div>
        <div id="wg-divider"></div>
        <div id="wg-controls">
          <label class="wg-toggle">
            <input type="checkbox" id="wg-auto" />
            <span class="wg-slider"></span>
            <span class="wg-label">Jawab Otomatis</span>
          </label>
          <label class="wg-toggle">
            <input type="checkbox" id="wg-dim" checked />
            <span class="wg-slider"></span>
            <span class="wg-label">Redupkan Salah</span>
          </label>
          <label class="wg-toggle">
            <input type="checkbox" id="wg-debug" />
            <span class="wg-slider"></span>
            <span class="wg-label">Debug</span>
          </label>
        </div>
        <div id="wg-stats"></div>
      </div>
    `;

    const style = document.createElement("style");
    style.id = "wg-css";
    style.textContent = `
      @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');

      #wg-panel {
        position: fixed; top: 12px; right: 12px; z-index: 999999;
        font-family: 'Inter', -apple-system, system-ui, sans-serif;
        font-size: 13px; color: ${T.text};
        background: ${T.bgGradient};
        border: 1px solid ${T.border};
        border-radius: ${T.radius}; width: 280px;
        box-shadow: ${T.shadow};
        backdrop-filter: blur(20px); user-select: none;
        overflow: hidden;
        transition: opacity 0.4s ease, box-shadow 0.4s ease, border-color 0.4s ease;
        animation: wgSlideIn 0.4s cubic-bezier(0.4, 0, 0.2, 1);
      }

      /* ═══ GHOST MODE ═══ */
      #wg-panel.ghost {
        width: auto;
        border-radius: 8px;
        background: none !important;
        backdrop-filter: none !important;
        box-shadow: none !important;
        border: none !important;
      }
      #wg-panel.ghost #wg-body { display: none; }
      #wg-panel.ghost #wg-logo { display: none; }
      #wg-panel.ghost #wg-btn-reload { display: none; }
      #wg-panel.ghost #wg-header {
        padding: 0;
        background: none !important;
        border-bottom: none !important;
        border-radius: 8px;
        margin: 0;
      }
      #wg-panel.ghost #wg-header-actions {
        gap: 0;
        background: none !important;
      }
      #wg-panel.ghost #wg-btn-minimize {
        opacity: 0.4;
        border: none !important;
        font-size: 14px;
        padding: 4px 10px;
        background: none !important;
        color: rgba(100,100,100,0.9);
        border-radius: 8px;
        pointer-events: auto;
        cursor: pointer;
        outline: none;
      }
      #wg-panel.ghost #wg-btn-minimize:hover {
        opacity: 1;
        color: rgba(60,60,60,1);
      }
      #wg-panel:not(.ghost) {
        width: 280px;
        pointer-events: auto;
      }

      @keyframes wgSlideIn {
        from { opacity: 0; transform: translateY(-20px) scale(0.95); }
        to { opacity: 1; transform: translateY(0) scale(1); }
      }

      #wg-header {
        display: flex; align-items: center; justify-content: space-between;
        padding: 10px 14px;
        background: linear-gradient(135deg, ${T.navyLight}44, ${T.navy}22);
        border-bottom: 1px solid ${T.border};
      }

      #wg-logo { display: flex; align-items: baseline; gap: 5px; }
      #wg-logo-sub {
        font-weight: 800; font-size: 16px; color: ${T.gold};
        letter-spacing: 5px; opacity: 1;
        text-shadow: 0 0 12px ${T.gold}80;
      }

      #wg-header-actions { display: flex; gap: 4px; }
      #wg-header-actions button {
        background: none; border: 1px solid ${T.border}; color: ${T.textDim};
        cursor: pointer; font-size: 12px; padding: 2px 8px;
        border-radius: 6px; transition: all 0.2s; line-height: 1.2;
      }
      #wg-header-actions button:hover {
        color: ${T.accent}; border-color: ${T.borderAccent};
        background: ${T.accentDim};
      }

      #wg-body { padding: 12px 14px; }

      #wg-status { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
      #wg-status-dot {
        width: 7px; height: 7px; border-radius: 50%; background: #555;
        flex-shrink: 0; transition: background 0.3s;
      }
      #wg-status.ok #wg-status-dot { background: #00e676; box-shadow: 0 0 8px #00e67666; }
      #wg-status.err #wg-status-dot { background: ${T.red}; box-shadow: 0 0 8px ${T.red}66; }
      #wg-status.loading #wg-status-dot { background: ${T.gold}; animation: wgPulse 1s infinite; }
      @keyframes wgPulse { 0%,100% { opacity:1; } 50% { opacity:0.3; } }
      #wg-status-text { font-size: 11px; color: ${T.textDim}; }

      #wg-question {
        font-size: 11px; color: ${T.textMuted}; margin-bottom: 6px;
        max-height: 40px; overflow: hidden; line-height: 1.4;
      }

      #wg-answer {
        font-size: 14px; font-weight: 700; color: ${T.gold};
        margin: 8px 0; padding: 10px 12px;
        background: ${T.goldDim};
        border-radius: 8px; border-left: 3px solid ${T.gold};
        max-height: 80px; overflow-y: auto; word-break: break-word;
        line-height: 1.3;
      }

      #wg-divider {
        height: 1px; background: ${T.border}; margin: 10px 0;
      }

      #wg-controls { display: flex; flex-direction: column; gap: 6px; }

      .wg-toggle {
        display: flex; align-items: center; gap: 8px;
        cursor: pointer; font-size: 11px; color: ${T.textDim};
      }
      .wg-toggle input { display: none; }
      .wg-slider {
        position: relative; width: 32px; height: 16px;
        background: ${T.navyLight}; border-radius: 8px;
        transition: all 0.3s; flex-shrink: 0;
        border: 1px solid ${T.border};
      }
      .wg-slider::after {
        content: ''; position: absolute; top: 2px; left: 2px;
        width: 10px; height: 10px; border-radius: 50%;
        background: ${T.textDim}; transition: all 0.3s;
      }
      .wg-toggle input:checked + .wg-slider {
        background: ${T.accent}; border-color: ${T.accent};
      }
      .wg-toggle input:checked + .wg-slider::after {
        transform: translateX(16px); background: white;
      }
      .wg-label { transition: color 0.2s; }
      .wg-toggle:hover .wg-label { color: ${T.textMuted}; }

      #wg-stats {
        font-size: 10px; color: ${T.textDim}; margin-top: 8px;
        display: flex; justify-content: space-between;
      }

      /* Custom scrollbar */
      #wg-answer::-webkit-scrollbar { width: 4px; }
      #wg-answer::-webkit-scrollbar-track { background: transparent; }
      #wg-answer::-webkit-scrollbar-thumb { background: ${T.navyGlow}; border-radius: 2px; }
    `;

    document.head.appendChild(style);
    document.body.appendChild(el);
    STATE.panel = el;
    STATE.style = style;

    // Make draggable
    this.setupDrag(el);

    // Wire up controls — tombol - toggle ghost mode
    el.querySelector("#wg-btn-minimize")!.addEventListener("click", () => {
      el.classList.toggle("ghost");
    });

    el.querySelector("#wg-btn-reload")!.addEventListener("click", async () => {
      this.updateStatus("Memuat ulang...", "loading");
      await API.loadAnswers();
      this.updateStatus(`${STATE.totalQ} pertanyaan dimuat`, "ok");
    });

    el.querySelector("#wg-auto")!.addEventListener("change", (e) => {
      STATE.autoAnswer = (e.target as HTMLInputElement).checked;
      LOG.info(`Auto-Answer: ${STATE.autoAnswer ? "ON" : "OFF"}`);
    });

    el.querySelector("#wg-dim")!.addEventListener("change", (e) => {
      STATE.dimWrong = (e.target as HTMLInputElement).checked;
      LOG.info(`Dim Wrong: ${STATE.dimWrong ? "ON" : "OFF"}`);
    });

    el.querySelector("#wg-debug")!.addEventListener("change", (e) => {
      STATE.debug = (e.target as HTMLInputElement).checked;
      LOG.info(`Debug: ${STATE.debug ? "ON" : "OFF"}`);
    });
  },

  setupDrag(el: HTMLElement): void {
    const header = el.querySelector("#wg-header") as HTMLElement;
    if (!header) return;

    let sx = 0, sy = 0, ix = 0, iy = 0;

    header.addEventListener("mousedown", (e) => {
      const target = e.target as HTMLElement;
      if (target.tagName === "BUTTON" || target.tagName === "INPUT") return;
      STATE.dragging = true;
      sx = e.clientX; sy = e.clientY;
      const r = el.getBoundingClientRect();
      ix = r.left; iy = r.top;
      e.preventDefault();
    });

    document.addEventListener("mousemove", (e) => {
      if (!STATE.dragging) return;
      el.style.left = `${ix + e.clientX - sx}px`;
      el.style.top = `${iy + e.clientY - sy}px`;
      el.style.right = "auto";
    });

    document.addEventListener("mouseup", () => { STATE.dragging = false; });
  },

  updateStatus(text: string, type: "ok" | "err" | "loading" | "") {
    const el = STATE.panel?.querySelector("#wg-status");
    if (el) {
      el.className = type;
      const textEl = el.querySelector("#wg-status-text");
      if (textEl) textEl.textContent = text;
    }
  },

  updateQuestion(text: string, type: string) {
    const el = STATE.panel?.querySelector("#wg-question");
    if (el) el.textContent = `${text.substring(0, 80)}${text.length > 80 ? "..." : ""} [${type}]`;
  },

  updateAnswer(text: string) {
    const el = STATE.panel?.querySelector("#wg-answer");
    if (el) el.textContent = text;
  },

  updateStats() {
    const el = STATE.panel?.querySelector("#wg-stats");
    if (el) {
      // BUG FIX #3: Sync stats with actual Pinia state
      const gq = Pinia.state("gameQuestions");
      const doneCount = gq?.doneOrder?.length || STATE.answeredQ;
      el.innerHTML = `<span>${doneCount}/${STATE.totalQ} dijawab</span>`;
    }
  },

  destroy(): void {
    if (STATE.panel) { STATE.panel.remove(); STATE.panel = null; }
    if (STATE.style) { STATE.style.remove(); STATE.style = null; }
  },
};

// ═══════════════════════════════════════════
//  BOOT — MAIN ENTRY POINT
// ═══════════════════════════════════════════

const Boot = {
  async start(): Promise<void> {
    LOG.always("Starting WG v2.0...");

    Panel.create();
    Panel.updateStatus("Menunggu permainan...", "loading");

    // Wait for game to start (up to 40s)
    for (let i = 0; i < 40; i++) {
      if (Pinia.inGame) break;
      await new Promise((r) => setTimeout(r, 1000));
      Panel.updateStatus(`Menunggu permainan... (${i + 1}d)`, "loading");
    }

    if (!Pinia.inGame) {
      Panel.updateStatus("Permainan tidak ditemukan — masuk ke permainan dulu!", "err");
      return;
    }

    Panel.updateStatus("Memuat jawaban...", "loading");

    const ok = await API.loadAnswers();
    if (!ok) {
      Panel.updateStatus("Gagal memuat jawaban!", "err");
      return;
    }

    Panel.updateStatus(`${STATE.totalQ} pertanyaan dimuat`, "ok");
    Panel.updateStats();

    // Start polling
    Engine.startPolling();

    // Process current question immediately
    const qId = Pinia.currentQId;
    if (qId) {
      STATE.currentQId = qId;
      Engine.processQuestion(qId);
    }

    LOG.success("WG v2.0 ready!");
  },

  stop(): void {
    Engine.stop();
    Panel.destroy();
  },
};

// ═══════════════════════════════════════════
//  GLOBAL API + AUTO-START
// ═══════════════════════════════════════════

(window as any).WG = {
  start: () => Boot.start(),
  stop: () => Boot.stop(),
  config: {
    get autoAnswer() { return STATE.autoAnswer; },
    set autoAnswer(v) { STATE.autoAnswer = v; },
    get dimWrong() { return STATE.dimWrong; },
    set dimWrong(v) { STATE.dimWrong = v; },
    get debug() { return STATE.debug; },
    set debug(v) { STATE.debug = v; },
  },
  reload: () => API.loadAnswers(),
  answers: () => STATE.answers,
};

Boot.start();
