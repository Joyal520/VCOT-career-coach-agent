# VCOT Career Guidance Agent — AI Interview Studio

A structured, real-time AI interview practice simulator built for **Vivekananda College of Technology (VCOT)** students.

## Key Features

- **10 Consistent Pre-Planned Questions:** Every student practices the same core 10 beginner-friendly interview questions covering introduction, education, job interest, strengths, weaknesses, experience, problem solving, teamwork, future goals, and closing pitch.
- **Natural Gemini AI Voice (`gemini-3.8-flash-tts`):** Warm, encouraging spoken delivery with varied transitions after every answer.
- **Hands-Free Real-Time Turn-Taking:** After clicking **I Am Ready**, the interview flows automatically from Question 1 to Question 10 using live Web Audio Voice Activity Detection, live speech captions, and Gemini multimodal audio transcription fallback—no clicking or typing needed between turns.
- **Post-Interview Gemini Evaluation & Rubric (`gemini-3.1-flash-lite`):** Evaluates all 10 responses after completion across Relevance (`/2`), Clarity (`/2`), Grammar (`/2`), Vocabulary (`/1`), Completeness (`/2`), and text Confidence indicators (`/1`), generating category scores, strengths, areas to improve, best answer spotlight, answer upgrade comparison, and a 5-step improvement plan.
- **Token-Optimized Architecture:** Uses separated `systemInstruction` for implicit context caching, native `responseSchema` without echoing input text, `thinkingBudget: 0` for scoring/transcription, evaluation deduplication caching, opening-script audio stitching, and persistent disk TTS caching.

## Quick Start

1. Copy `.env.example` to `.env` and set your Gemini API key:
   ```bash
   cp .env.example .env
   ```
2. Start the server (Node.js 18+ required, zero external npm dependencies):
   ```bash
   npm start
   ```
3. Open `http://localhost:3000` in Chrome or Edge and allow microphone access when starting the interview.
