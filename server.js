const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT_DIR = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const TTS_CACHE_DIR = path.join(ROOT_DIR, ".cache", "tts");

try {
  fs.mkdirSync(TTS_CACHE_DIR, { recursive: true });
} catch (e) {
  // Ignore if directory creation fails; in-memory cache still operates
}

const evalCache = new Map();
const MAX_EVAL_CACHE = 60;

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function loadEnvFile() {
  const envPath = path.join(ROOT_DIR, ".env");
  if (!fs.existsSync(envPath)) return;

  const raw = fs.readFileSync(envPath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

loadEnvFile();

const PORT = Number(process.env.PORT) || 3000;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readJsonBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("Request payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text ? JSON.parse(text) : {});
      } catch (err) {
        reject(new Error("Invalid JSON request body"));
      }
    });
    req.on("error", reject);
  });
}

function clamp(num, min, max) {
  return Math.max(min, Math.min(max, num));
}

function roundToOneDecimal(num) {
  return Math.round(num * 10) / 10;
}

const CONFIDENCE_DISCLAIMER =
  "Confidence is assessed from written content, clarity, and positive phrasing only. Vocal tone, eye contact, and body language are not evaluated from text transcripts.";

// Invariant system instruction separated to maximize Gemini implicit context caching
const EVAL_SYSTEM_INSTRUCTION =
  "Supportive VCOT Career Guidance interview assessor. Score all 10 student answers using this per-question rubric (max 10): " +
  "r=relevance(0-2), c=clarity(0-2), g=grammar(0-2), v=vocabulary(0-1), p=completeness(0-2), f=confidence-in-text(0-1). " +
  "Evaluate confidence strictly from written clarity and assertive phrasing (never vocal tone or body language). " +
  "cats fields are overall 0-10 integer scores across all 10 answers. Keep feedback concise, encouraging, and specific to the answers and target role.";

// Native responseSchema eliminates redundant JSON format examples from the prompt and echoes zero static input text
const EVAL_RESPONSE_SCHEMA = {
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
    best: {
      type: "OBJECT",
      properties: {
        qId: { type: "INTEGER" },
        reason: { type: "STRING" },
      },
      required: ["qId", "reason"],
    },
    improve: {
      type: "OBJECT",
      properties: {
        qId: { type: "INTEGER" },
        better: { type: "STRING" },
        reason: { type: "STRING" },
      },
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

function sanitizeAnswerForPrompt(ans) {
  return String(ans || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 600);
}

function buildCompactEvalPrompt(candidate, responses) {
  const lines = responses.map((item, idx) => {
    const id = Number(item.id) || idx + 1;
    const ans = sanitizeAnswerForPrompt(item.answer) || "[None]";
    return `Q${id} [${item.topic}]: ${item.question}\nA: ${ans}`;
  });
  return `Candidate: ${candidate.name} | Role: ${candidate.jobRole} | Level: ${candidate.difficulty || "Beginner"}\n\n${lines.join("\n\n")}`;
}

function hydrateCompactGeminiReport(compact, candidate, responses, modelUsed, tokenUsage) {
  const safeResponses = responses.map((r, i) => ({
    id: Number(r.id) || i + 1,
    topic: r.topic || `Question ${i + 1}`,
    question: r.question || "",
    answer: sanitizeAnswerForPrompt(r.answer),
  }));

  const rawItems = Array.isArray(compact.items) ? compact.items : [];
  const questionEvaluations = safeResponses.map((resp, idx) => {
    const found = rawItems.find((x) => Number(x.id) === resp.id) || rawItems[idx] || {};
    const criteria = {
      relevance: clamp(Number(found.r) || 0, 0, 2),
      clarity: clamp(Number(found.c) || 0, 0, 2),
      grammar: clamp(Number(found.g) || 0, 0, 2),
      vocabulary: clamp(Number(found.v) || 0, 0, 1),
      completeness: clamp(Number(found.p) || 0, 0, 2),
      confidence: clamp(Number(found.f) || 0, 0, 1),
    };
    const score = clamp(
      roundToOneDecimal(
        criteria.relevance +
          criteria.clarity +
          criteria.grammar +
          criteria.vocabulary +
          criteria.completeness +
          criteria.confidence
      ),
      0,
      10
    );
    return {
      id: resp.id,
      topic: resp.topic,
      question: resp.question,
      studentAnswer: resp.answer || "[No answer provided]",
      score,
      criteria,
      feedback:
        typeof found.fb === "string" && found.fb.trim()
          ? found.fb.trim()
          : "Good effort! Adding one brief example will make this answer stronger.",
      sampleImprovedAnswer: typeof found.alt === "string" ? found.alt.trim() : "",
    };
  });

  const overallScore =
    questionEvaluations.length > 0
      ? roundToOneDecimal(
          questionEvaluations.reduce((acc, q) => acc + q.score, 0) / questionEvaluations.length
        )
      : 0;

  const catsRaw = compact.cats || {};
  const categories = {
    communication: clamp(Math.round(Number(catsRaw.communication) || overallScore), 0, 10),
    confidence: clamp(Math.round(Number(catsRaw.confidence) || overallScore), 0, 10),
    answerQuality: clamp(Math.round(Number(catsRaw.answerQuality) || overallScore), 0, 10),
    vocabulary: clamp(Math.round(Number(catsRaw.vocabulary) || overallScore), 0, 10),
    grammar: clamp(Math.round(Number(catsRaw.grammar) || overallScore), 0, 10),
    relevance: clamp(Math.round(Number(catsRaw.relevance) || overallScore), 0, 10),
  };

  const sortedHigh = [...questionEvaluations].sort((a, b) => b.score - a.score);
  const sortedLow = [...questionEvaluations].sort((a, b) => a.score - b.score);
  const bestQ =
    questionEvaluations.find((q) => q.id === Number(compact?.best?.qId)) || sortedHigh[0];
  const weakQ =
    questionEvaluations.find((q) => q.id === Number(compact?.improve?.qId)) || sortedLow[0];

  return {
    candidate: {
      name: candidate.name,
      jobRole: candidate.jobRole,
      language: candidate.language || "English",
      difficulty: candidate.difficulty || "Beginner",
    },
    evaluationEngine: "gemini",
    modelUsed,
    fallbackReason: null,
    tokenUsage: tokenUsage || null,
    overallScore,
    overallScoreRounded: Math.round(overallScore),
    categories,
    confidenceDisclaimer: CONFIDENCE_DISCLAIMER,
    strengths:
      Array.isArray(compact.strengths) && compact.strengths.length > 0
        ? compact.strengths.slice(0, 5)
        : ["You completed all 10 interview questions clearly."],
    areasToImprove:
      Array.isArray(compact.areasToImprove) && compact.areasToImprove.length > 0
        ? compact.areasToImprove.slice(0, 5)
        : ["Add specific real examples to strengthen your answers."],
    bestAnswer: {
      questionNumber: bestQ.id,
      topic: bestQ.topic,
      question: bestQ.question,
      studentAnswer: bestQ.studentAnswer,
      whyItWasGood:
        compact?.best?.reason ||
        `Your response to Question ${bestQ.id} (${bestQ.topic}) was clear and relevant to ${candidate.jobRole}.`,
    },
    answerImprovement: {
      questionNumber: weakQ.id,
      topic: weakQ.topic,
      question: weakQ.question,
      originalAnswer: weakQ.studentAnswer,
      improvedAnswer:
        compact?.improve?.better ||
        weakQ.sampleImprovedAnswer ||
        buildRoleSampleAnswer(weakQ.id, candidate),
      whyItIsBetter:
        compact?.improve?.reason ||
        `Uses complete sentences and directly highlights your readiness for ${candidate.jobRole}.`,
    },
    nextSteps:
      Array.isArray(compact.nextSteps) && compact.nextSteps.length > 0
        ? compact.nextSteps.slice(0, 5)
        : [
            "Practise introducing yourself clearly for one minute.",
            `Learn five common interview vocabulary words for ${candidate.jobRole}.`,
            "Answer questions using 2 to 4 complete sentences.",
            "Prepare one real example each for teamwork and problem solving.",
            "Repeat this 10-question practice interview.",
          ],
    questionEvaluations,
  };
}

function normalizeReport(raw, candidate, responses, engine, modelUsed, fallbackReason) {
  const safeResponses = responses.map((r, i) => ({
    id: Number(r.id) || i + 1,
    topic: r.topic || `Question ${i + 1}`,
    question: r.question || "",
    answer: (r.answer || "").trim(),
  }));

  const rawEvals = Array.isArray(raw.questionEvaluations) ? raw.questionEvaluations : [];
  const questionEvaluations = safeResponses.map((resp, idx) => {
    const found = rawEvals.find((item) => Number(item.id) === resp.id) || rawEvals[idx] || {};
    const c = found.criteria || {};
    const criteria = {
      relevance: clamp(Number(c.relevance) || 0, 0, 2),
      clarity: clamp(Number(c.clarity) || 0, 0, 2),
      grammar: clamp(Number(c.grammar) || 0, 0, 2),
      vocabulary: clamp(Number(c.vocabulary) || 0, 0, 1),
      completeness: clamp(Number(c.completeness) || 0, 0, 2),
      confidence: clamp(Number(c.confidence) || 0, 0, 1),
    };
    const criteriaSum = roundToOneDecimal(
      criteria.relevance +
        criteria.clarity +
        criteria.grammar +
        criteria.vocabulary +
        criteria.completeness +
        criteria.confidence
    );
    const score = clamp(
      Number.isFinite(Number(found.score)) ? roundToOneDecimal(Number(found.score)) : criteriaSum,
      0,
      10
    );

    return {
      id: resp.id,
      topic: resp.topic,
      question: resp.question,
      studentAnswer: resp.answer || "[No answer provided]",
      score,
      criteria,
      feedback:
        typeof found.feedback === "string" && found.feedback.trim()
          ? found.feedback.trim()
          : "Thank you for answering this question. Try adding a short concrete example to strengthen your response.",
      sampleImprovedAnswer:
        typeof found.sampleImprovedAnswer === "string" && found.sampleImprovedAnswer.trim()
          ? found.sampleImprovedAnswer.trim()
          : "",
    };
  });

  const computedOverall =
    questionEvaluations.length > 0
      ? roundToOneDecimal(
          questionEvaluations.reduce((acc, q) => acc + q.score, 0) / questionEvaluations.length
        )
      : 0;

  const overallScore = Number.isFinite(Number(raw.overallScore))
    ? clamp(roundToOneDecimal(Number(raw.overallScore)), 0, 10)
    : computedOverall;

  const cats = raw.categories || {};
  const categories = {
    communication: clamp(Math.round(Number(cats.communication) || overallScore), 0, 10),
    confidence: clamp(Math.round(Number(cats.confidence) || overallScore), 0, 10),
    answerQuality: clamp(Math.round(Number(cats.answerQuality) || overallScore), 0, 10),
    vocabulary: clamp(Math.round(Number(cats.vocabulary) || overallScore), 0, 10),
    grammar: clamp(Math.round(Number(cats.grammar) || overallScore), 0, 10),
    relevance: clamp(Math.round(Number(cats.relevance) || overallScore), 0, 10),
  };

  const bestSorted = [...questionEvaluations].sort((a, b) => b.score - a.score);
  const weakSorted = [...questionEvaluations].sort((a, b) => a.score - b.score);
  const topQ = bestSorted[0] || questionEvaluations[0];
  const lowQ = weakSorted[0] || questionEvaluations[0];

  const bestRaw = raw.bestAnswer || {};
  const bestAnswer = {
    questionNumber: Number(bestRaw.questionNumber) || topQ.id,
    topic: bestRaw.topic || topQ.topic,
    question: bestRaw.question || topQ.question,
    studentAnswer: bestRaw.studentAnswer || topQ.studentAnswer,
    whyItWasGood:
      bestRaw.whyItWasGood ||
      `Your response to Question ${topQ.id} (${topQ.topic}) was clear, relevant to the ${candidate.jobRole} role, and well structured.`,
  };

  const impRaw = raw.answerImprovement || {};
  const answerImprovement = {
    questionNumber: Number(impRaw.questionNumber) || lowQ.id,
    topic: impRaw.topic || lowQ.topic,
    question: impRaw.question || lowQ.question,
    originalAnswer: impRaw.originalAnswer || lowQ.studentAnswer,
    improvedAnswer:
      impRaw.improvedAnswer ||
      lowQ.sampleImprovedAnswer ||
      `I am excited about the ${candidate.jobRole} opportunity because I enjoy applying my skills, helping others learn, and growing continuously in a supportive team.`,
    whyItIsBetter:
      impRaw.whyItIsBetter ||
      "The improved version uses complete sentences, highlights genuine motivation, and connects your skills directly to what the employer needs.",
  };

  return {
    candidate: {
      name: candidate.name,
      jobRole: candidate.jobRole,
      language: candidate.language || "English",
      difficulty: candidate.difficulty || "Beginner",
    },
    evaluationEngine: engine,
    modelUsed: modelUsed || null,
    fallbackReason: fallbackReason || null,
    overallScore,
    overallScoreRounded: clamp(
      Number.isFinite(Number(raw.overallScoreRounded))
        ? Math.round(Number(raw.overallScoreRounded))
        : Math.round(overallScore),
      0,
      10
    ),
    categories,
    confidenceDisclaimer:
      raw.confidenceDisclaimer ||
      "Confidence is assessed from written content, clarity, and positive phrasing only. Vocal tone, eye contact, and body language are not evaluated from text transcripts.",
    strengths:
      Array.isArray(raw.strengths) && raw.strengths.length > 0
        ? raw.strengths.slice(0, 6)
        : [
            "You completed all 10 interview questions from start to finish.",
            "Your answers stayed focused on the questions asked.",
          ],
    areasToImprove:
      Array.isArray(raw.areasToImprove) && raw.areasToImprove.length > 0
        ? raw.areasToImprove.slice(0, 6)
        : [
            "Try expanding short answers with 2 to 3 complete sentences.",
            "Include specific examples from your studies, projects, or daily work.",
          ],
    bestAnswer,
    answerImprovement,
    nextSteps:
      Array.isArray(raw.nextSteps) && raw.nextSteps.length > 0
        ? raw.nextSteps.slice(0, 6)
        : [
            "Practise introducing yourself clearly for one minute.",
            "Learn five common interview vocabulary words related to your field.",
            "Practise answering questions using complete sentences.",
            "Prepare two short examples from your study or teamwork experience.",
            "Repeat this 10-question interview after practising.",
          ],
    questionEvaluations,
  };
}

async function evaluateWithGemini(candidate, responses) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not configured in .env");
  }

  // Pre-validation fast path: avoid spending tokens on completely blank interviews
  const hasMeaningfulInput = responses.some((r) => sanitizeAnswerForPrompt(r.answer).length >= 2);
  if (!hasMeaningfulInput) {
    return evaluateLocally(candidate, responses, "empty-submission-fast-path");
  }

  // Deterministic evaluation cache (0 tokens on duplicate submissions)
  const cacheSignature = sha256(
    JSON.stringify({
      role: candidate.jobRole.toLowerCase(),
      diff: (candidate.difficulty || "Beginner").toLowerCase(),
      answers: responses.map((r) => ({ id: r.id, a: sanitizeAnswerForPrompt(r.answer) })),
    })
  );
  if (evalCache.has(cacheSignature)) {
    const cachedReport = evalCache.get(cacheSignature);
    return {
      ...cachedReport,
      candidate: {
        ...cachedReport.candidate,
        name: candidate.name,
      },
      cacheHit: true,
    };
  }

  const candidateAttempts = [
    { model: "gemini-3.1-flash-lite", thinkingConfig: { thinkingBudget: 0 }, delayMs: 0 },
    { model: "gemini-3.1-flash-lite", thinkingConfig: { thinkingBudget: 0 }, delayMs: 400 },
    { model: "gemini-3-flash-preview", thinkingConfig: { thinkingLevel: "MINIMAL" }, delayMs: 0 },
    { model: "gemini-2.5-flash-lite", thinkingConfig: { thinkingBudget: 0 }, delayMs: 0 },
  ];

  const prompt = buildCompactEvalPrompt(candidate, responses);
  let lastError = null;

  for (const { model, thinkingConfig, delayMs } of candidateAttempts) {
    if (delayMs > 0) {
      await new Promise((r) => setTimeout(r, delayMs));
    }

    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      model
    )}:generateContent?key=${encodeURIComponent(apiKey)}`;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20000);

      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: EVAL_SYSTEM_INSTRUCTION }],
          },
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.25,
            responseMimeType: "application/json",
            responseSchema: EVAL_RESPONSE_SCHEMA,
            thinkingConfig,
            maxOutputTokens: 1800,
          },
        }),
      });
      clearTimeout(timer);

      if (!response.ok) {
        const errBody = await response.text();
        lastError = new Error(`Gemini (${model}) HTTP ${response.status}: ${errBody.slice(0, 200)}`);
        continue;
      }

      const data = await response.json();
      const parts = data?.candidates?.[0]?.content?.parts || [];
      const textPart =
        parts.find((p) => !p.thought && typeof p.text === "string") ||
        parts.find((p) => typeof p.text === "string");
      const rawText = textPart?.text;
      if (!rawText) {
        lastError = new Error(`Gemini (${model}) returned an empty candidate response`);
        continue;
      }

      const cleaned = rawText
        .replace(/^```json\s*/i, "")
        .replace(/```$/i, "")
        .trim();
      const parsed = JSON.parse(cleaned);
      const usage = data.usageMetadata || {};
      const tokenUsage = {
        promptTokens: usage.promptTokenCount || 0,
        outputTokens: usage.candidatesTokenCount || 0,
        cachedTokens: usage.cachedContentTokenCount || 0,
        thoughtsTokens: usage.thoughtsTokenCount || 0,
        totalTokens: usage.totalTokenCount || 0,
      };

      const hydrated = hydrateCompactGeminiReport(parsed, candidate, responses, model, tokenUsage);
      if (evalCache.size >= MAX_EVAL_CACHE) {
        evalCache.delete(evalCache.keys().next().value);
      }
      evalCache.set(cacheSignature, hydrated);
      return hydrated;
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error("All Gemini model calls failed");
}

const TOPIC_KEYWORDS = {
  1: ["name", "student", "study", "studied", "teach", "teacher", "work", "passion", "interest", "background", "skill"],
  2: ["study", "studied", "degree", "diploma", "course", "college", "learn", "learned", "skill", "training", "project"],
  3: ["want", "enjoy", "like", "passion", "contribute", "grow", "institution", "school", "company", "role", "help"],
  4: ["strength", "patient", "organized", "communication", "team", "fast", "learner", "creative", "reliable", "problem"],
  5: ["improve", "practice", "practise", "working", "learn", "confidence", "time", "speaking", "skill", "better"],
  6: ["experience", "worked", "taught", "internship", "project", "volunteer", "helped", "class", "lab", "training"],
  7: ["problem", "challenge", "issue", "faced", "solved", "solution", "step", "fixed", "helped", "result"],
  8: ["team", "group", "colleagues", "classmates", "together", "helped", "shared", "communication", "example", "project"],
  9: ["five", "years", "future", "grow", "develop", "senior", "lead", "contribute", "goal", "career", "master"],
  10: ["hire", "bring", "dedication", "hardworking", "skills", "ready", "contribute", "students", "team", "value"],
};

function buildRoleSampleAnswer(questionId, candidate) {
  const name = candidate.name || "Candidate";
  const role = candidate.jobRole || "this role";
  const samples = {
    1: `My name is ${name}. I have studied and developed strong skills relevant to becoming a ${role}. I enjoy learning, communicating clearly with others, and helping people achieve their goals.`,
    2: `I studied core subjects and practical skills that prepared me to work effectively as a ${role}. During my studies, I improved my communication, technical knowledge, and problem-solving abilities.`,
    3: `I want this ${role} position because I enjoy sharing knowledge, solving real problems, and supporting others. I believe I can contribute positively to the team while continuing to grow professionally.`,
    4: `My main strengths are patience, clear communication, and strong organization. I stay calm under pressure and always prepare carefully so that I do reliable work as a ${role}.`,
    5: `One skill I want to improve is speaking with even greater confidence in front of large groups. I am actively practising my presentations and preparing notes before meetings to get better every week.`,
    6: `Yes, I have practical experience through my college coursework, group projects, and helping classmates and community members with tasks related to ${role}.`,
    7: `Once, a group project fell behind schedule because our tasks were unclear. I suggested creating a simple checklist, divided the work fairly among members, and we finished on time with strong results.`,
    8: `Yes, I work well in a team. For example, during a recent group activity, I listened carefully to everyone's ideas, shared my part early, and helped another teammate complete their section before the deadline.`,
    9: `In five years, I see myself as an experienced and trusted ${role} who mentors newer colleagues, takes on greater responsibility, and continues learning modern methods in my field.`,
    10: `You should hire me because I bring dedication, relevant foundational skills, and a positive attitude. I am eager to support the organization from day one and grow as a dependable ${role}.`,
  };
  return samples[questionId] || samples[3];
}

function evaluateSingleAnswerLocally(resp, candidate) {
  const answer = (resp.answer || "").trim();
  const id = Number(resp.id) || 1;
  const words = answer ? answer.split(/\s+/).filter(Boolean) : [];
  const wordCount = words.length;
  const lower = answer.toLowerCase();
  const roleTokens = (candidate.jobRole || "")
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2);

  if (!answer || wordCount === 0) {
    return {
      id,
      topic: resp.topic,
      question: resp.question,
      studentAnswer: "[No answer provided]",
      score: 1.0,
      criteria: {
        relevance: 0,
        clarity: 0.5,
        grammar: 0.5,
        vocabulary: 0,
        completeness: 0,
        confidence: 0,
      },
      feedback: "No response was recorded for this question. Try giving at least 2 to 3 complete sentences.",
      sampleImprovedAnswer: buildRoleSampleAnswer(id, candidate),
    };
  }

  // Relevance (0 - 2)
  const topicWords = TOPIC_KEYWORDS[id] || [];
  const topicHits = topicWords.filter((kw) => lower.includes(kw)).length;
  const roleHits = roleTokens.filter((rt) => lower.includes(rt)).length;
  let relevance = 0.5;
  if (topicHits >= 2 || roleHits >= 1) relevance = 1.5;
  if (topicHits >= 3 || (topicHits >= 2 && roleHits >= 1) || wordCount >= 24) relevance = 2;
  if (wordCount < 4 && topicHits === 0) relevance = 0.5;

  // Completeness (0 - 2)
  let completeness = 0.5;
  if (wordCount >= 10) completeness = 1;
  if (wordCount >= 18) completeness = 1.5;
  if (wordCount >= 28) completeness = 2;

  // Clarity (0 - 2)
  const sentences = answer.split(/[.!?]+/).filter((s) => s.trim().length > 2);
  let clarity = 1;
  if (wordCount >= 12 && sentences.length >= 1) clarity = 1.5;
  if (wordCount >= 18 && sentences.length >= 2) clarity = 2;
  if (wordCount < 6) clarity = 0.5;

  // Grammar (0 - 2)
  const startsUpper = /^[A-Z]/.test(answer);
  const endsPunct = /[.!?]$/.test(answer);
  const hasRepeats = /\b(\w+)\s+\1\b/i.test(lower);
  const lowerCaseI = /\bi\b/.test(answer) && !/\bI\b/.test(answer);
  let grammar = 1.5;
  if (startsUpper && endsPunct && !hasRepeats && !lowerCaseI) grammar = 2;
  if (wordCount < 5 || (hasRepeats && !endsPunct)) grammar = 1;

  // Vocabulary (0 - 1)
  const cleanTokens = lower.replace(/[^a-z\s]/g, "").split(/\s+/).filter(Boolean);
  const uniqueRatio = cleanTokens.length > 0 ? new Set(cleanTokens).size / cleanTokens.length : 0;
  let vocabulary = 0.5;
  if (wordCount >= 14 && uniqueRatio >= 0.65) vocabulary = 1;
  if (wordCount < 7) vocabulary = 0.5;

  // Confidence indicators in text (0 - 1)
  const positiveMarkers = [
    "i am",
    "i can",
    "i believe",
    "i enjoy",
    "i achieved",
    "i solved",
    "i helped",
    "for example",
    "confident",
    "excited",
    "passionate",
    "ready",
    "my strength",
  ];
  const hesitantMarkers = ["maybe", "don't know", "not sure", "i guess", "need work", "only"];
  const posCount = positiveMarkers.filter((m) => lower.includes(m)).length;
  const hesCount = hesitantMarkers.filter((m) => lower.includes(m)).length;
  let confidence = 0.5;
  if (posCount >= 1 && hesCount === 0 && wordCount >= 12) confidence = 1;
  if (wordCount < 6 || hesCount >= 2) confidence = 0;

  const score = roundToOneDecimal(
    relevance + completeness + clarity + grammar + vocabulary + confidence
  );

  let feedback = "";
  if (score >= 8) {
    feedback = `Strong, clear answer for ${resp.topic}. You used complete sentences and connected well to the ${candidate.jobRole} role.`;
  } else if (score >= 6) {
    feedback = `Good start on ${resp.topic}. Adding one concrete example or specific detail would make this answer even stronger.`;
  } else {
    feedback = `This answer is quite short. Practise expanding your thoughts into 2 to 3 complete sentences with an example.`;
  }

  return {
    id,
    topic: resp.topic,
    question: resp.question,
    studentAnswer: answer,
    score,
    criteria: {
      relevance,
      clarity,
      grammar,
      vocabulary,
      completeness,
      confidence,
    },
    feedback,
    sampleImprovedAnswer: buildRoleSampleAnswer(id, candidate),
  };
}

function evaluateLocally(candidate, responses, fallbackReason) {
  const questionEvaluations = responses.map((r) => evaluateSingleAnswerLocally(r, candidate));
  const avgScore =
    questionEvaluations.reduce((sum, q) => sum + q.score, 0) /
    Math.max(1, questionEvaluations.length);

  const avgCriterion = (key, maxVal) => {
    const sum = questionEvaluations.reduce((acc, q) => acc + q.criteria[key], 0);
    return clamp(Math.round((sum / (questionEvaluations.length * maxVal)) * 10), 1, 10);
  };

  const relevanceCat = avgCriterion("relevance", 2);
  const clarityCat = avgCriterion("clarity", 2);
  const completenessCat = avgCriterion("completeness", 2);
  const grammarCat = avgCriterion("grammar", 2);
  const vocabularyCat = avgCriterion("vocabulary", 1);
  const confidenceCat = avgCriterion("confidence", 1);

  const communicationCat = clamp(Math.round((clarityCat + completenessCat) / 2), 1, 10);
  const answerQualityCat = clamp(Math.round((relevanceCat + completenessCat) / 2), 1, 10);

  const sortedByScore = [...questionEvaluations].sort((a, b) => b.score - a.score);
  const bestQ = sortedByScore[0];
  const weakQ = sortedByScore[sortedByScore.length - 1];

  const avgWords =
    responses.reduce((acc, r) => acc + (r.answer || "").trim().split(/\s+/).filter(Boolean).length, 0) /
    Math.max(1, responses.length);

  const strengths = [];
  if (responses.filter((r) => (r.answer || "").trim().length > 0).length === responses.length) {
    strengths.push("You answered all 10 interview questions without skipping any.");
  }
  if (relevanceCat >= 7) {
    strengths.push(`Your responses stayed relevant to the ${candidate.jobRole} role.`);
  }
  if (clarityCat >= 7) {
    strengths.push("You used clear, understandable English that is easy for an interviewer to follow.");
  }
  if (bestQ.score >= 7) {
    strengths.push(`Your strongest response was on "${bestQ.topic}" (Question ${bestQ.id}).`);
  }
  if (strengths.length < 3) {
    strengths.push("You showed willingness to practise and communicate your ideas honestly.");
    strengths.push("You maintained a polite and professional tone throughout the session.");
  }

  const areasToImprove = [];
  if (avgWords < 18) {
    areasToImprove.push("Try to give slightly longer answers (around 2 to 4 complete sentences per question).");
  }
  if (completenessCat < 8) {
    areasToImprove.push("Include specific examples when discussing teamwork, problem solving, and past experience.");
  }
  if (grammarCat < 8) {
    areasToImprove.push("Check sentence capitalization, punctuation, and complete sentence structure.");
  }
  if (vocabularyCat < 8) {
    areasToImprove.push(`Use a wider variety of action words and vocabulary related to ${candidate.jobRole}.`);
  }
  if (confidenceCat < 8) {
    areasToImprove.push("Use more confident phrasing such as 'I can contribute...' or 'I successfully helped...'.");
  }
  if (areasToImprove.length < 3) {
    areasToImprove.push("Avoid repeating the same phrases across different answers.");
  }

  const rawReport = {
    overallScore: roundToOneDecimal(avgScore),
    overallScoreRounded: Math.round(avgScore),
    categories: {
      communication: communicationCat,
      confidence: confidenceCat,
      answerQuality: answerQualityCat,
      vocabulary: vocabularyCat,
      grammar: grammarCat,
      relevance: relevanceCat,
    },
    confidenceDisclaimer:
      "Confidence is assessed from written content, structure, and assertive phrasing only. Vocal tone, eye contact, and body language cannot be measured from text transcripts.",
    strengths,
    areasToImprove,
    bestAnswer: {
      questionNumber: bestQ.id,
      topic: bestQ.topic,
      question: bestQ.question,
      studentAnswer: bestQ.studentAnswer,
      whyItWasGood: `This answer directly addressed "${bestQ.topic}" with clear wording and relevant details for a ${candidate.jobRole} candidate.`,
    },
    answerImprovement: {
      questionNumber: weakQ.id,
      topic: weakQ.topic,
      question: weakQ.question,
      originalAnswer: weakQ.studentAnswer,
      improvedAnswer: buildRoleSampleAnswer(weakQ.id, candidate),
      whyItIsBetter: `The improved answer uses complete sentences, positive professional language, and directly connects your strengths to the ${candidate.jobRole} role.`,
    },
    nextSteps: [
      "Practise introducing yourself clearly and calmly for one full minute.",
      `Learn five common interview vocabulary words related to ${candidate.jobRole}.`,
      "Practise answering every interview question using 2 to 4 complete sentences.",
      "Prepare one real example for teamwork and one real example for problem solving.",
      "Repeat this 10-question interview practice session to measure your progress.",
    ],
    questionEvaluations,
  };

  return normalizeReport(rawReport, candidate, responses, "local-fallback", null, fallbackReason);
}

const ttsCache = new Map();
const ttsInFlight = new Map();

function pcmToWavBuffer(pcmBuffer, sampleRate = 24000, numChannels = 1, bitsPerSample = 16) {
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const header = Buffer.alloc(44);

  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcmBuffer.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcmBuffer.length, 40);

  return Buffer.concat([header, pcmBuffer]);
}

function extractPcmFromWav(wavBuffer) {
  if (!wavBuffer || wavBuffer.length < 44) return null;
  if (wavBuffer.subarray(0, 4).toString("ascii") !== "RIFF") return null;
  if (wavBuffer.subarray(8, 12).toString("ascii") !== "WAVE") return null;

  let offset = 12;
  let sampleRate = 24000;
  let numChannels = 1;
  let bitsPerSample = 16;
  let pcm = null;

  while (offset + 8 <= wavBuffer.length) {
    const chunkId = wavBuffer.subarray(offset, offset + 4).toString("ascii");
    const chunkSize = wavBuffer.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    const dataEnd = Math.min(wavBuffer.length, dataStart + chunkSize);

    if (chunkId === "fmt " && chunkSize >= 16) {
      numChannels = wavBuffer.readUInt16LE(dataStart + 2);
      sampleRate = wavBuffer.readUInt32LE(dataStart + 4);
      bitsPerSample = wavBuffer.readUInt16LE(dataStart + 14);
    } else if (chunkId === "data") {
      pcm = wavBuffer.subarray(dataStart, dataEnd);
      break;
    }

    offset = dataStart + chunkSize + (chunkSize % 2);
  }

  return pcm ? { sampleRate, numChannels, bitsPerSample, pcm } : null;
}

function stitchWavBuffers(wavBuffers, gapMs = 160) {
  const parsed = wavBuffers.map(extractPcmFromWav);
  if (parsed.some((p) => !p)) return null;

  const base = parsed[0];
  const compatible = parsed.every(
    (p) =>
      p.sampleRate === base.sampleRate &&
      p.numChannels === base.numChannels &&
      p.bitsPerSample === base.bitsPerSample
  );
  if (!compatible) return null;

  const blockAlign = (base.numChannels * base.bitsPerSample) / 8;
  const rawGapBytes = Math.round((base.sampleRate * blockAlign * gapMs) / 1000);
  const gapBytes = rawGapBytes - (rawGapBytes % blockAlign);
  const silence = Buffer.alloc(Math.max(0, gapBytes));

  const segments = [];
  parsed.forEach((p, idx) => {
    if (idx > 0 && silence.length > 0) segments.push(silence);
    segments.push(p.pcm);
  });

  return pcmToWavBuffer(Buffer.concat(segments), base.sampleRate, base.numChannels, base.bitsPerSample);
}

function getDiskCachePath(cacheKey) {
  return path.join(TTS_CACHE_DIR, `${sha256(cacheKey)}.wav`);
}

async function synthesizeGeminiSpeechSingle(cleanText, voiceName = "Aoede") {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not configured in .env");
  }

  const cacheKey = `${voiceName}::${cleanText}`;
  if (ttsCache.has(cacheKey)) {
    return ttsCache.get(cacheKey);
  }

  const diskPath = getDiskCachePath(cacheKey);
  try {
    if (fs.existsSync(diskPath)) {
      const diskWav = fs.readFileSync(diskPath);
      if (diskWav.length >= 44) {
        if (ttsCache.size >= 100) ttsCache.delete(ttsCache.keys().next().value);
        ttsCache.set(cacheKey, diskWav);
        return diskWav;
      }
    }
  } catch (e) {
    // Ignore disk read error and proceed to synthesize
  }

  if (ttsInFlight.has(cacheKey)) {
    return ttsInFlight.get(cacheKey);
  }

  const task = (async () => {
    const attempts = [
      { model: "gemini-3.8-flash-tts", delayMs: 0 },
      { model: "gemini-3.8-flash-lite-tts", delayMs: 0 },
      { model: "gemini-3.1-flash-tts-preview", delayMs: 150 },
      { model: "gemini-2.5-flash-preview-tts", delayMs: 250 },
    ];
    let lastError = null;

    for (const { model, delayMs } of attempts) {
      if (delayMs > 0) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
        model
      )}:generateContent?key=${encodeURIComponent(apiKey)}`;

      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 22000);

        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            contents: [{ parts: [{ text: cleanText }] }],
            generationConfig: {
              responseModalities: ["AUDIO"],
              speechConfig: {
                voiceConfig: {
                  prebuiltVoiceConfig: {
                    voiceName,
                  },
                },
              },
            },
          }),
        });
        clearTimeout(timer);

        if (!response.ok) {
          const errText = await response.text();
          lastError = new Error(`Gemini TTS (${model}) HTTP ${response.status}: ${errText.slice(0, 200)}`);
          continue;
        }

        const data = await response.json();
        const parts = data?.candidates?.[0]?.content?.parts || [];
        const audioPart = parts.find((p) => p?.inlineData?.data);
        if (!audioPart?.inlineData?.data) {
          lastError = new Error(`Gemini TTS (${model}) returned no audio inlineData`);
          continue;
        }

        const mimeType = audioPart.inlineData.mimeType || "audio/L16;codec=pcm;rate=24000";
        const rateMatch = mimeType.match(/rate=(\d+)/i);
        const sampleRate = rateMatch ? Number(rateMatch[1]) : 24000;
        const pcmBuf = Buffer.from(audioPart.inlineData.data, "base64");
        const hasRiffHeader = pcmBuf.length >= 12 && pcmBuf.subarray(0, 4).toString("ascii") === "RIFF";
        const wavBuf = hasRiffHeader ? pcmBuf : pcmToWavBuffer(pcmBuf, sampleRate);

        if (ttsCache.size >= 100) {
          ttsCache.delete(ttsCache.keys().next().value);
        }
        ttsCache.set(cacheKey, wavBuf);

        try {
          fs.writeFileSync(diskPath, wavBuf);
        } catch (e) {
          // Ignore non-fatal disk cache write errors
        }

        return wavBuf;
      } catch (err) {
        lastError = err;
      }
    }

    throw lastError || new Error("Gemini TTS synthesis failed");
  })();

  ttsInFlight.set(cacheKey, task);
  try {
    return await task;
  } finally {
    ttsInFlight.delete(cacheKey);
  }
}

async function synthesizeGeminiSpeech(text, voiceName = "Aoede") {
  const cleanText = String(text || "").trim();
  if (!cleanText) {
    throw new Error("Text for TTS cannot be empty");
  }

  // Token optimization: split personalized "Hello, <Name>!" from the static multi-sentence welcome body
  // so the 7-sentence static body is synthesized once and reused across every student via disk cache.
  const introMatch = cleanText.match(
    /^(Hello,\s+[^!.?]+[!.]?)\s+(Welcome to your interview practice session\.[\s\S]+)$/i
  );
  if (introMatch) {
    const [, greetingText, staticWelcomeBody] = introMatch;
    const [greetingWav, staticWav] = await Promise.all([
      synthesizeGeminiSpeechSingle(greetingText, voiceName),
      synthesizeGeminiSpeechSingle(staticWelcomeBody, voiceName),
    ]);
    const combined = stitchWavBuffers([greetingWav, staticWav], 160);
    if (combined) return combined;
  }

  return synthesizeGeminiSpeechSingle(cleanText, voiceName);
}

async function transcribeAudioWithGemini(audioBase64, mimeType = "audio/webm") {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not configured in .env");
  }

  const attempts = [
    { model: "gemini-3.1-flash-lite", thinkingConfig: { thinkingBudget: 0 } },
    { model: "gemini-3-flash-preview", thinkingConfig: { thinkingLevel: "MINIMAL" } },
  ];
  let lastError = null;

  for (const { model, thinkingConfig } of attempts) {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      model
    )}:generateContent?key=${encodeURIComponent(apiKey)}`;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);

      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          systemInstruction: {
            parts: [
              {
                text: "Verbatim English speech transcriber. Return only the spoken words without quotes or commentary; return empty string if silent.",
              },
            ],
          },
          contents: [
            {
              role: "user",
              parts: [
                {
                  inlineData: {
                    mimeType,
                    data: audioBase64,
                  },
                },
                { text: "Transcribe:" },
              ],
            },
          ],
          generationConfig: {
            temperature: 0.1,
            thinkingConfig,
            maxOutputTokens: 250,
          },
        }),
      });
      clearTimeout(timer);

      if (!response.ok) {
        const errText = await response.text();
        lastError = new Error(`Gemini STT (${model}) HTTP ${response.status}: ${errText.slice(0, 200)}`);
        continue;
      }

      const data = await response.json();
      const parts = data?.candidates?.[0]?.content?.parts || [];
      const textPart = parts.find((p) => !p.thought && typeof p.text === "string") || parts.find((p) => typeof p.text === "string");
      return (textPart?.text || "").trim();
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error("Gemini audio transcription failed");
}

const server = http.createServer(async (req, res) => {
  const urlPath = (req.url || "/").split("?")[0];

  if (req.method === "GET" && urlPath === "/api/health") {
    return sendJson(res, 200, {
      ok: true,
      service: "VCOT Career Guidance Agent",
      geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
    });
  }

  if (req.method === "POST" && urlPath === "/api/tts") {
    try {
      const body = await readJsonBody(req);
      const text = String(body?.text || "").trim();
      const voice = String(body?.voice || "Aoede").trim() || "Aoede";
      if (!text) {
        return sendJson(res, 400, { error: "text is required" });
      }
      const wavBuffer = await synthesizeGeminiSpeech(text, voice);
      res.writeHead(200, {
        "Content-Type": "audio/wav",
        "Content-Length": wavBuffer.length,
        "Cache-Control": "no-store",
      });
      res.end(wavBuffer);
      return;
    } catch (err) {
      return sendJson(res, 502, { error: err.message || "TTS generation failed" });
    }
  }

  if (req.method === "POST" && urlPath === "/api/transcribe") {
    try {
      const body = await readJsonBody(req, 12 * 1024 * 1024);
      const audioBase64 = String(body?.audioBase64 || "").trim();
      const mimeType = String(body?.mimeType || "audio/webm").trim();
      if (!audioBase64) {
        return sendJson(res, 400, { error: "audioBase64 is required" });
      }
      const transcript = await transcribeAudioWithGemini(audioBase64, mimeType);
      return sendJson(res, 200, { transcript });
    } catch (err) {
      return sendJson(res, 502, { error: err.message || "Audio transcription failed" });
    }
  }

  if (req.method === "POST" && urlPath === "/api/evaluate") {
    try {
      const body = await readJsonBody(req);
      const candidate = {
        name: String(body?.candidate?.name || "Student").trim() || "Student",
        jobRole: String(body?.candidate?.jobRole || "General Position").trim() || "General Position",
        language: String(body?.candidate?.language || "English"),
        difficulty: String(body?.candidate?.difficulty || "Beginner"),
      };
      const responses = Array.isArray(body?.responses) ? body.responses : [];
      if (responses.length === 0) {
        return sendJson(res, 400, { error: "Interview responses array is required." });
      }

      try {
        const geminiReport = await evaluateWithGemini(candidate, responses);
        return sendJson(res, 200, geminiReport);
      } catch (geminiErr) {
        const fallbackReport = evaluateLocally(candidate, responses, geminiErr.message);
        return sendJson(res, 200, fallbackReport);
      }
    } catch (err) {
      return sendJson(res, 400, { error: err.message || "Bad request" });
    }
  }

  if (req.method === "GET" || req.method === "HEAD") {
    const safeRelPath = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
    const resolvedPath = path.resolve(PUBLIC_DIR, safeRelPath);

    if (!resolvedPath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      return res.end("Forbidden");
    }

    fs.readFile(resolvedPath, (err, content) => {
      if (err) {
        if (err.code === "ENOENT") {
          res.writeHead(404, { "Content-Type": "text/plain" });
          return res.end("Not Found");
        }
        res.writeHead(500, { "Content-Type": "text/plain" });
        return res.end("Internal Server Error");
      }

      const ext = path.extname(resolvedPath).toLowerCase();
      res.writeHead(200, {
        "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
      });
      if (req.method === "HEAD") return res.end();
      res.end(content);
    });
    return;
  }

  res.writeHead(405, { "Content-Type": "text/plain" });
  res.end("Method Not Allowed");
});

server.listen(PORT, () => {
  console.log(`VCOT Career Guidance AI Interview server running at http://localhost:${PORT}`);
});
